// SPDX-License-Identifier: MIT

import { getStorageAdapter } from '@platform/storage-adapters';
import { DEFAULT_SETTINGS, SETTINGS_VERSION, STORAGE_KEY } from '@settings/schema';
import { afterEach, expect, it, vi } from 'vite-plus/test';

vi.mock('@platform/storage-adapters', () => ({ getStorageAdapter: vi.fn() }));

let adapterInstance = 0;
async function useRealAdapter(): Promise<void> {
  const moduleUrl = `/src/platform/storage-adapters.ts?browser-test=${++adapterInstance}`;
  const module = (await import(
    /* @vite-ignore */ moduleUrl
  )) as typeof import('@platform/storage-adapters');
  vi.mocked(getStorageAdapter).mockReturnValue(module.getStorageAdapter());
}

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalGet = Object.getOwnPropertyDescriptor(globalThis, 'GM_getValue');
const originalSet = Object.getOwnPropertyDescriptor(globalThis, 'GM_setValue');

afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  if (originalGet) Object.defineProperty(globalThis, 'GM_getValue', originalGet);
  else Reflect.deleteProperty(globalThis, 'GM_getValue');
  if (originalSet) Object.defineProperty(globalThis, 'GM_setValue', originalSet);
  else Reflect.deleteProperty(globalThis, 'GM_setValue');
  vi.resetModules();
});

it('uses the real localStorage adapter and store to report denial, then recover on one retry', async () => {
  const values = new Map<string, string>();
  let denied = true;
  Reflect.deleteProperty(globalThis, 'GM_getValue');
  Reflect.deleteProperty(globalThis, 'GM_setValue');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (denied) throw new DOMException('quota denied', 'QuotaExceededError');
        values.set(key, value);
      },
    },
  });
  await useRealAdapter();
  const { Settings } = await import('@settings/store');
  const settings = new Settings();
  await settings.initialize();
  settings.set({ fontSize: 48 });
  expect(await settings.persistNow()).toBe('unsaved');
  expect(settings.get().fontSize).toBe(48);
  expect(values.size).toBe(0);

  denied = false;
  expect(await settings.retrySave()).toBe('saved');
  const reloaded = new Settings();
  await reloaded.initialize();
  expect(reloaded.get().fontSize).toBe(48);
  await settings.destroy();
  await reloaded.destroy();
});

it('does not replace stored preferences after an initial read denial and a form-sized edit', async () => {
  const key = 'yt-live-chat-overlay-settings';
  const previous = JSON.stringify({ fontSize: 48, speedPxPerSec: 420, opacity: 0.75 });
  const values = new Map([[key, previous]]);
  let denyRead = true;
  const setItem = vi.fn((name: string, value: string) => values.set(name, value));
  Reflect.deleteProperty(globalThis, 'GM_getValue');
  Reflect.deleteProperty(globalThis, 'GM_setValue');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (name: string) => {
        if (name === key && denyRead) throw new Error('Controlled initial read denial');
        return values.get(name) ?? null;
      },
      setItem,
    },
  });
  await useRealAdapter();
  const { Settings } = await import('@settings/store');
  const settings = new Settings();
  await settings.initialize();
  expect(settings.persistenceState()).toBe('unsaved');
  expect(values.get(key)).toBe(previous);

  settings.preview({ opacity: 0.5 });
  settings.set({ opacity: 0.5 });
  expect(await settings.persistNow()).toBe('unsaved');
  expect(setItem).not.toHaveBeenCalled();
  expect(values.get(key)).toBe(previous);

  denyRead = false;
  expect(await settings.retrySave()).toBe('saved');
  expect(JSON.parse(values.get(key) ?? 'null')).toMatchObject({
    fontSize: 48,
    speedPxPerSec: 420,
    opacity: 0.5,
  });
  const fresh = new Settings();
  await fresh.initialize();
  expect(fresh.get()).toMatchObject({ fontSize: 48, speedPxPerSec: 420, opacity: 0.5 });
  await settings.destroy();
  await fresh.destroy();
});

it('preserves the exact GM preferences after one initial read error and an opacity-only edit', async () => {
  const original = JSON.stringify({
    ...DEFAULT_SETTINGS,
    fontSize: 48,
    speedPxPerSec: 420,
    _version: SETTINGS_VERSION,
  });
  const values = new Map([[STORAGE_KEY, original]]);
  let firstRead = true;
  const getValue = vi.fn((key: string) => {
    if (firstRead) {
      firstRead = false;
      throw new Error('first GM read denied');
    }
    return values.get(key);
  });
  const setValue = vi.fn((key: string, value: string) => values.set(key, value));
  Object.defineProperty(globalThis, 'GM_getValue', { configurable: true, value: getValue });
  Object.defineProperty(globalThis, 'GM_setValue', { configurable: true, value: setValue });

  await useRealAdapter();
  const { Settings } = await import('@settings/store');
  const settings = new Settings();
  await settings.initialize();
  expect(settings.persistenceState()).toBe('unsaved');
  expect(values.get(STORAGE_KEY)).toBe(original);
  expect(setValue).not.toHaveBeenCalled();

  settings.set({ opacity: 0.75 });
  expect(await settings.persistNow()).toBe('saved');
  expect(getValue).toHaveBeenCalledTimes(2);
  expect(setValue).toHaveBeenCalledTimes(1);
  expect(JSON.parse(values.get(STORAGE_KEY) ?? 'null')).toEqual({
    ...DEFAULT_SETTINGS,
    fontSize: 48,
    speedPxPerSec: 420,
    opacity: 0.75,
    _version: SETTINGS_VERSION,
  });

  const fresh = new Settings();
  await fresh.initialize();
  expect(fresh.get()).toMatchObject({ fontSize: 48, speedPxPerSec: 420, opacity: 0.75 });
  await settings.destroy();
  await fresh.destroy();
});

it('loads a healthy existing GM record without writing defaults', async () => {
  const original = JSON.stringify({
    ...DEFAULT_SETTINGS,
    fontSize: 48,
    speedPxPerSec: 420,
    opacity: 0.75,
    _version: SETTINGS_VERSION,
  });
  const getValue = vi.fn(() => original);
  const setValue = vi.fn();
  Object.defineProperty(globalThis, 'GM_getValue', { configurable: true, value: getValue });
  Object.defineProperty(globalThis, 'GM_setValue', { configurable: true, value: setValue });

  await useRealAdapter();
  const { Settings } = await import('@settings/store');
  const settings = new Settings();
  await settings.initialize();
  expect(settings.persistenceState()).toBe('saved');
  expect(settings.get()).toMatchObject({ fontSize: 48, speedPxPerSec: 420, opacity: 0.75 });
  expect(getValue).toHaveBeenCalledTimes(1);
  expect(setValue).not.toHaveBeenCalled();
  await settings.destroy();
});

it('treats a verified missing GM key as defaults and permits a later explicit edit', async () => {
  const values = new Map<string, string>();
  const getValue = vi.fn((key: string) => values.get(key));
  const setValue = vi.fn((key: string, value: string) => values.set(key, value));
  Object.defineProperty(globalThis, 'GM_getValue', { configurable: true, value: getValue });
  Object.defineProperty(globalThis, 'GM_setValue', { configurable: true, value: setValue });

  await useRealAdapter();
  const { Settings } = await import('@settings/store');
  const settings = new Settings();
  await settings.initialize();
  expect(settings.persistenceState()).toBe('saved');
  expect(settings.get()).toEqual(DEFAULT_SETTINGS);
  expect(setValue).not.toHaveBeenCalled();

  settings.set({ opacity: 0.75 });
  expect(await settings.persistNow()).toBe('saved');
  expect(setValue).toHaveBeenCalledTimes(1);
  const fresh = new Settings();
  await fresh.initialize();
  expect(fresh.get()).toMatchObject({
    fontSize: DEFAULT_SETTINGS.fontSize,
    speedPxPerSec: DEFAULT_SETTINGS.speedPxPerSec,
    opacity: 0.75,
  });
  await settings.destroy();
  await fresh.destroy();
});
