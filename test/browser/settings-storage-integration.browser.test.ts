// SPDX-License-Identifier: MIT

import { afterEach, expect, it, vi } from 'vite-plus/test';

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalGet = Object.getOwnPropertyDescriptor(globalThis, 'GM_getValue');
const originalSet = Object.getOwnPropertyDescriptor(globalThis, 'GM_setValue');

afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  if (originalGet) Object.defineProperty(globalThis, 'GM_getValue', originalGet);
  if (originalSet) Object.defineProperty(globalThis, 'GM_setValue', originalSet);
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
