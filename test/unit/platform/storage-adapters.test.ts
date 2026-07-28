// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const globals = globalThis as Record<string, unknown>;
const originalDescriptors = {
  chrome: Object.getOwnPropertyDescriptor(globalThis, 'chrome'),
  GM_getValue: Object.getOwnPropertyDescriptor(globalThis, 'GM_getValue'),
  GM_setValue: Object.getOwnPropertyDescriptor(globalThis, 'GM_setValue'),
  localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
  extensionBridge: Object.getOwnPropertyDescriptor(window, '__ytExtensionBridge'),
};
const storageValues = new Map<string, string>();
const memoryStorage: Storage = {
  get length() {
    return storageValues.size;
  },
  clear: () => storageValues.clear(),
  getItem: (key) => storageValues.get(key) ?? null,
  key: (index) => [...storageValues.keys()][index] ?? null,
  removeItem: (key) => storageValues.delete(key),
  setItem: (key, value) => storageValues.set(key, value),
};

async function loadAdapter() {
  return (await import('@platform/storage-adapters')).getStorageAdapter();
}

function restoreProperty(
  target: object,
  property: PropertyKey,
  descriptor: PropertyDescriptor | undefined
): void {
  if (descriptor) {
    Object.defineProperty(target, property, descriptor);
    return;
  }
  Reflect.deleteProperty(target, property);
}

describe('platform storage adapters', () => {
  beforeEach(() => {
    vi.resetModules();
    delete globals.chrome;
    delete globals.GM_getValue;
    delete globals.GM_setValue;
    delete window.__ytExtensionBridge;
    storageValues.clear();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: memoryStorage,
    });
  });

  afterEach(() => {
    restoreProperty(globalThis, 'chrome', originalDescriptors.chrome);
    restoreProperty(globalThis, 'GM_getValue', originalDescriptors.GM_getValue);
    restoreProperty(globalThis, 'GM_setValue', originalDescriptors.GM_setValue);
    restoreProperty(globalThis, 'localStorage', originalDescriptors.localStorage);
    restoreProperty(window, '__ytExtensionBridge', originalDescriptors.extensionBridge);
    vi.restoreAllMocks();
  });

  it('reads and writes chrome.storage.local values', async () => {
    const get = vi.fn(async () => ({ plain: 'value', object: { enabled: true } }));
    const set = vi.fn(async () => undefined);
    globals.chrome = { storage: { local: { get, set } } };

    const adapter = await loadAdapter();

    await expect(adapter.getItem('plain')).resolves.toBe('value');
    await expect(adapter.getItem('object')).resolves.toBe('{"enabled":true}');
    await adapter.setItem('plain', 'next');
    expect(get).toHaveBeenCalledWith('plain');
    expect(set).toHaveBeenCalledWith({ plain: 'next' });
  });

  it('normalizes userscript values and delegates writes', async () => {
    const getValue = vi.fn((key: string) =>
      key === 'object' ? { opacity: 0.5 } : key === 'missing' ? null : 42
    );
    const setValue = vi.fn();
    globals.GM_getValue = getValue;
    globals.GM_setValue = setValue;

    const adapter = await loadAdapter();

    await expect(adapter.getItem('object')).resolves.toBe('{"opacity":0.5}');
    await expect(adapter.getItem('number')).resolves.toBe('42');
    await expect(adapter.getItem('missing')).resolves.toBeNull();
    await adapter.setItem('key', 'value');
    expect(setValue).toHaveBeenCalledWith('key', 'value');
  });

  it('falls back to localStorage when platform APIs are absent', async () => {
    localStorage.setItem('existing', 'stored');
    const adapter = await loadAdapter();

    await expect(adapter.getItem('existing')).resolves.toBe('stored');
    await adapter.setItem('new', 'value');
    expect(localStorage.getItem('new')).toBe('value');
  });

  it('uses the authenticated extension relay in the MAIN world', async () => {
    window.__ytExtensionBridge = {
      workerSupported: true,
      workerUrl: 'chrome-extension://test/workers/renderer.js',
      storageType: 'chrome.storage.local',
      nonce: 'relay-nonce',
    };
    const postMessage = vi.spyOn(window, 'postMessage').mockImplementation((message) => {
      const request = message as {
        requestId: number;
        method: 'get' | 'set';
        nonce: string;
      };
      queueMicrotask(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            source: window,
            origin: window.location.origin,
            data: {
              source: 'yt-storage-relay-response',
              nonce: request.nonce,
              requestId: request.requestId,
              value: request.method === 'get' ? 'relayed' : null,
            },
          })
        );
      });
    });

    const adapter = await loadAdapter();

    await expect(adapter.getItem('key')).resolves.toBe('relayed');
    await expect(adapter.setItem('key', 'value')).resolves.toBeUndefined();
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        source: 'yt-storage-relay',
        nonce: 'relay-nonce',
        method: 'get',
        key: 'key',
      }),
      window.location.origin
    );
  });
});
