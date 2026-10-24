// SPDX-License-Identifier: MIT
// @vitest-environment jsdom

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
