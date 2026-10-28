// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

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

let adapterInstance = 0;
async function loadAdapter() {
  const moduleUrl = `/src/platform/storage-adapters.ts?browser-test=${++adapterInstance}`;
  return (
    (await import(/* @vite-ignore */ moduleUrl)) as typeof import('@platform/storage-adapters')
  ).getStorageAdapter();
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
    vi.useRealTimers();
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

  it('prefers sandboxed GM storage over a page-provided chrome lookalike', async () => {
    const chromeGet = vi.fn(async () => ({ key: 'forged' }));
    const chromeSet = vi.fn(async () => undefined);
    globals.chrome = { storage: { local: { get: chromeGet, set: chromeSet } } };
    const getValue = vi.fn(() => 'trusted');
    const setValue = vi.fn();
    globals.GM_getValue = getValue;
    globals.GM_setValue = setValue;

    const adapter = await loadAdapter();

    await expect(adapter.getItem('key')).resolves.toBe('trusted');
    await adapter.setItem('key', 'next');
    expect(getValue).toHaveBeenCalledWith('key');
    expect(setValue).toHaveBeenCalledWith('key', 'next');
    expect(chromeGet).not.toHaveBeenCalled();
    expect(chromeSet).not.toHaveBeenCalled();
  });

  it('falls back to localStorage when platform APIs are absent', async () => {
    localStorage.setItem('existing', 'stored');
    const adapter = await loadAdapter();

    await expect(adapter.getItem('existing')).resolves.toBe('stored');
    await adapter.setItem('new', 'value');
    expect(localStorage.getItem('new')).toBe('value');
  });

  it('reports denied writes from GM, direct Chrome, and localStorage without switching stores', async () => {
    const denied = new Error('write denied');
    globals.GM_getValue = vi.fn(() => null);
    globals.GM_setValue = vi.fn(() => {
      throw denied;
    });
    const gm = await loadAdapter();
    await expect(gm.setItem('key', 'new')).rejects.toBe(denied);

    vi.resetModules();
    globals.GM_setValue = vi.fn(async () => {
      throw denied;
    });
    const asyncGm = await loadAdapter();
    await expect(asyncGm.setItem('key', 'new')).rejects.toBe(denied);

    vi.resetModules();
    delete globals.GM_getValue;
    delete globals.GM_setValue;
    globals.chrome = {
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => {
            throw denied;
          }),
        },
      },
    };
    const direct = await loadAdapter();
    await expect(direct.setItem('key', 'new')).rejects.toBe(denied);

    vi.resetModules();
    delete globals.chrome;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        ...memoryStorage,
        setItem: () => {
          throw denied;
        },
      },
    });
    const local = await loadAdapter();
    await expect(local.setItem('key', 'new')).rejects.toBe(denied);
    expect(storageValues.has('key')).toBe(false);
  });

  it('rejects denied reads while preserving a verified missing key', async () => {
    const denied = new Error('read denied');
    globals.GM_getValue = vi.fn((key: string) => {
      if (key === 'missing') return null;
      throw denied;
    });
    globals.GM_setValue = vi.fn();
    const gm = await loadAdapter();
    await expect(gm.getItem('missing')).resolves.toBeNull();
    await expect(gm.getItem('settings')).rejects.toBe(denied);

    delete globals.GM_getValue;
    delete globals.GM_setValue;
    globals.chrome = {
      storage: {
        local: {
          get: vi.fn(async (key: string) => {
            if (key === 'missing') return {};
            throw denied;
          }),
          set: vi.fn(),
        },
      },
    };
    const direct = await loadAdapter();
    await expect(direct.getItem('missing')).resolves.toBeNull();
    await expect(direct.getItem('settings')).rejects.toBe(denied);

    globals.chrome = {
      storage: { local: { get: vi.fn(async () => undefined), set: vi.fn() } },
    };
    const invalidResponse = await loadAdapter();
    await expect(invalidResponse.getItem('settings')).rejects.toThrow(
      'Chrome storage read returned no result'
    );

    delete globals.chrome;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        ...memoryStorage,
        getItem: (key: string) => {
          if (key === 'missing') return null;
          throw denied;
        },
      },
    });
    const local = await loadAdapter();
    await expect(local.getItem('missing')).resolves.toBeNull();
    await expect(local.getItem('settings')).rejects.toBe(denied);
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

  it('rejects relay reads and writes when the content-script relay times out', async () => {
    vi.useFakeTimers();
    window.__ytExtensionBridge = {
      workerSupported: true,
      workerUrl: 'chrome-extension://test/workers/renderer.js',
      storageType: 'chrome.storage.local',
      nonce: 'timeout-nonce',
    };
    vi.spyOn(window, 'postMessage').mockImplementation(() => {});
    const adapter = await loadAdapter();

    const readExpectation = expect(adapter.getItem('key')).rejects.toThrow(
      'Storage relay get request timed out'
    );
    await vi.advanceTimersByTimeAsync(2000);
    await readExpectation;

    const writeExpectation = expect(adapter.setItem('key', 'value')).rejects.toThrow(
      'Storage relay set request timed out'
    );
    await vi.advanceTimersByTimeAsync(2000);
    await writeExpectation;
  });

  it('cleans up relay timeouts when posting fails synchronously', async () => {
    vi.useFakeTimers();
    window.__ytExtensionBridge = {
      workerSupported: true,
      workerUrl: 'chrome-extension://test/workers/renderer.js',
      storageType: 'chrome.storage.local',
      nonce: 'failure-nonce',
    };
    vi.spyOn(window, 'postMessage').mockImplementation(() => {
      throw new Error('post failed');
    });
    const adapter = await loadAdapter();

    await expect(adapter.getItem('read-key')).rejects.toThrow('post failed');
    await expect(adapter.setItem('write-key', 'value')).rejects.toThrow('post failed');
    expect(vi.getTimerCount()).toBe(0);
  });
});
