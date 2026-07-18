import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrossTabSyncAdapter } from '@platform/types';
import { getCrossTabSyncAdapter } from '@platform/cross-tab-sync-adapters';

type ChromeChangeListener = (changes: Record<string, unknown>, areaName: string) => void;
type GmChangeListener = (
  key: string,
  oldValue: unknown,
  newValue: unknown,
  remote: boolean
) => void;

let keyCounter = 0;
let activeAdapter: CrossTabSyncAdapter | null = null;

function getTestAdapter(): { adapter: CrossTabSyncAdapter; storageKey: string } {
  const storageKey = `cross-tab-sync-test-key-${++keyCounter}`;
  const adapter = getCrossTabSyncAdapter(storageKey);
  activeAdapter = adapter;
  return { adapter, storageKey };
}

function enableExtensionBridge(): void {
  window.__ytExtensionBridge = {
    workerSupported: true,
    workerUrl: 'chrome-extension://test/workers/renderer.js',
    storageType: 'chrome.storage.local',
  };
}

function installGmMock(): {
  addListener: ReturnType<typeof vi.fn>;
  listeners: Map<number, GmChangeListener>;
  removeListener: ReturnType<typeof vi.fn>;
} {
  let nextListenerId = 0;
  const listeners = new Map<number, GmChangeListener>();
  const addListener = vi.fn((_key: string, callback: GmChangeListener): number => {
    const listenerId = ++nextListenerId;
    listeners.set(listenerId, callback);
    return listenerId;
  });
  const removeListener = vi.fn((listenerId: number): void => {
    listeners.delete(listenerId);
  });

  vi.stubGlobal('GM_addValueChangeListener', addListener);
  vi.stubGlobal('GM_removeValueChangeListener', removeListener);
  return { addListener, listeners, removeListener };
}

function dispatchStorageChanged(
  data: Record<string, unknown>,
  source: MessageEvent['source'] = window,
  origin = window.location.origin
): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      data,
      origin,
      source,
    })
  );
}

describe('cross-tab sync adapters', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>).chrome;
    delete (globalThis as Record<string, unknown>).GM_addValueChangeListener;
    delete (globalThis as Record<string, unknown>).GM_removeValueChangeListener;
    delete window.__ytExtensionBridge;
  });

  afterEach(() => {
    activeAdapter?.removeListener();
    activeAdapter = null;
    delete window.__ytExtensionBridge;
    vi.unstubAllGlobals();
  });

  it('selects the storage relay when only the extension bridge is available', () => {
    enableExtensionBridge();
    const callback = vi.fn();
    const { adapter, storageKey } = getTestAdapter();
    adapter.addListener(callback);

    dispatchStorageChanged({
      source: 'yt-storage-changed',
      key: storageKey,
      newValue: { enabled: true },
    });

    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(storageKey, { enabled: true });
  });

  it('filters relay events by source, origin, and storage key', () => {
    enableExtensionBridge();
    const callback = vi.fn();
    const { adapter, storageKey } = getTestAdapter();
    adapter.addListener(callback);

    dispatchStorageChanged(
      { source: 'yt-storage-changed', key: storageKey, newValue: 'wrong-source' },
      null
    );
    dispatchStorageChanged(
      { source: 'yt-storage-changed', key: storageKey, newValue: 'wrong-origin' },
      window,
      'https://other.example'
    );
    dispatchStorageChanged({ source: 'other-source', key: storageKey, newValue: 'wrong-source' });
    dispatchStorageChanged({ source: 'yt-storage-changed', key: 'other-key', newValue: 'wrong-key' });

    expect(callback).not.toHaveBeenCalled();

    dispatchStorageChanged({
      source: 'yt-storage-changed',
      key: storageKey,
      newValue: 'accepted',
    });

    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(storageKey, 'accepted');
  });

  it('supports add, remove, and re-add on the cached relay adapter', () => {
    enableExtensionBridge();
    const firstCallback = vi.fn();
    const secondCallback = vi.fn();
    const thirdCallback = vi.fn();
    const { adapter, storageKey } = getTestAdapter();

    adapter.addListener(firstCallback);
    dispatchStorageChanged({ source: 'yt-storage-changed', key: storageKey, newValue: 1 });
    adapter.removeListener();
    dispatchStorageChanged({ source: 'yt-storage-changed', key: storageKey, newValue: 2 });

    adapter.addListener(secondCallback);
    dispatchStorageChanged({ source: 'yt-storage-changed', key: storageKey, newValue: 3 });
    adapter.removeListener();
    adapter.addListener(thirdCallback);
    dispatchStorageChanged({ source: 'yt-storage-changed', key: storageKey, newValue: 4 });

    expect(firstCallback).toHaveBeenCalledOnce();
    expect(secondCallback).toHaveBeenCalledOnce();
    expect(thirdCallback).toHaveBeenCalledOnce();
    expect(firstCallback).toHaveBeenCalledWith(storageKey, 1);
    expect(secondCallback).toHaveBeenCalledWith(storageKey, 3);
    expect(thirdCallback).toHaveBeenCalledWith(storageKey, 4);
  });

  it('prioritizes direct Chrome storage over GM sync when both are available', () => {
    const chromeState: { listener: ChromeChangeListener | null } = { listener: null };
    const onChanged = {
      addListener: vi.fn((listener: ChromeChangeListener): void => {
        chromeState.listener = listener;
      }),
      removeListener: vi.fn(),
    };
    const gm = installGmMock();
    vi.stubGlobal('chrome', { storage: { onChanged } });

    const callback = vi.fn();
    const { adapter, storageKey } = getTestAdapter();
    adapter.addListener(callback);

    expect(onChanged.addListener).toHaveBeenCalledOnce();
    expect(gm.addListener).not.toHaveBeenCalled();

    const registeredChromeListener = chromeState.listener;
    if (registeredChromeListener === null) {
      throw new Error('Chrome listener was not registered');
    }
    registeredChromeListener({ [storageKey]: { newValue: 'chrome-value' } }, 'local');

    expect(callback).toHaveBeenCalledWith(storageKey, 'chrome-value');
  });

  it('replaces and removes the direct Chrome listener without leaking registrations', () => {
    const chromeState: {
      listener: ChromeChangeListener | null;
      listeners: Set<ChromeChangeListener>;
    } = { listener: null, listeners: new Set() };
    const onChanged = {
      addListener: vi.fn((listener: ChromeChangeListener): void => {
        chromeState.listener = listener;
        chromeState.listeners.add(listener);
      }),
      removeListener: vi.fn((listener: ChromeChangeListener): void => {
        chromeState.listeners.delete(listener);
      }),
    };
    vi.stubGlobal('chrome', { storage: { onChanged } });

    const firstCallback = vi.fn();
    const secondCallback = vi.fn();
    const { adapter, storageKey } = getTestAdapter();

    adapter.addListener(firstCallback);
    const firstChromeListener = chromeState.listener;
    if (firstChromeListener === null) {
      throw new Error('First Chrome listener was not registered');
    }

    adapter.addListener(secondCallback);
    const secondChromeListener = chromeState.listener;
    if (secondChromeListener === null) {
      throw new Error('Second Chrome listener was not registered');
    }

    expect(onChanged.addListener).toHaveBeenCalledTimes(2);
    expect(onChanged.removeListener).toHaveBeenCalledOnce();
    expect(onChanged.removeListener).toHaveBeenCalledWith(firstChromeListener);
    expect(chromeState.listeners.size).toBe(1);

    secondChromeListener({ [storageKey]: { newValue: 'replacement-value' } }, 'local');
    expect(firstCallback).not.toHaveBeenCalled();
    expect(secondCallback).toHaveBeenCalledOnce();

    adapter.removeListener();
    adapter.removeListener();

    expect(onChanged.removeListener).toHaveBeenCalledTimes(2);
    expect(onChanged.removeListener).toHaveBeenLastCalledWith(secondChromeListener);
    expect(chromeState.listeners.size).toBe(0);
  });

  it('falls back to GM sync when chrome storage is only partially available', () => {
    const gm = installGmMock();
    vi.stubGlobal('chrome', {
      storage: {
        onChanged: { removeListener: vi.fn() },
      },
    });

    const callback = vi.fn();
    const { adapter, storageKey } = getTestAdapter();
    adapter.addListener(callback);

    expect(gm.addListener).toHaveBeenCalledOnce();
    const gmListener = gm.listeners.values().next().value;
    if (!gmListener) throw new Error('GM listener was not registered');
    gmListener(storageKey, undefined, 'gm-value', true);

    expect(callback).toHaveBeenCalledWith(storageKey, 'gm-value');
  });

  it('replaces the previous GM listener when addListener is called again', () => {
    const gm = installGmMock();
    const firstCallback = vi.fn();
    const secondCallback = vi.fn();
    const { adapter, storageKey } = getTestAdapter();

    adapter.addListener(firstCallback);
    adapter.addListener(secondCallback);

    expect(gm.addListener).toHaveBeenCalledTimes(2);
    expect(gm.removeListener).toHaveBeenCalledOnce();
    expect(gm.removeListener).toHaveBeenCalledWith(1);
    expect(gm.listeners.size).toBe(1);

    const gmListener = gm.listeners.values().next().value;
    if (!gmListener) throw new Error('GM listener was not registered');
    gmListener(storageKey, undefined, 'replacement-value', true);

    expect(firstCallback).not.toHaveBeenCalled();
    expect(secondCallback).toHaveBeenCalledOnce();
    expect(secondCallback).toHaveBeenCalledWith(storageKey, 'replacement-value');

    adapter.removeListener();
    expect(gm.removeListener).toHaveBeenCalledTimes(2);
    expect(gm.removeListener).toHaveBeenLastCalledWith(2);
    expect(gm.listeners.size).toBe(0);
  });

  it('falls back to localStorage when the GM removal API is not callable', () => {
    const addListener = vi.fn();
    vi.stubGlobal('GM_addValueChangeListener', addListener);
    vi.stubGlobal('GM_removeValueChangeListener', { remove: vi.fn() });

    const callback = vi.fn();
    const { adapter, storageKey } = getTestAdapter();
    adapter.addListener(callback);

    expect(addListener).not.toHaveBeenCalled();

    window.dispatchEvent(
      new StorageEvent('storage', {
        key: storageKey,
        newValue: 'local-storage-after-malformed-gm',
      })
    );

    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(storageKey, 'local-storage-after-malformed-gm');
  });

  it('falls back to the window storage event when GM sync is unavailable', () => {
    const callback = vi.fn();
    const { adapter, storageKey } = getTestAdapter();
    adapter.addListener(callback);

    window.dispatchEvent(
      new StorageEvent('storage', {
        key: storageKey,
        newValue: 'local-storage-value',
      })
    );

    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(storageKey, 'local-storage-value');
  });
});
