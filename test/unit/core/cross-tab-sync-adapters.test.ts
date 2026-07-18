import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCrossTabSyncAdapter } from '@platform/cross-tab-sync-adapters';

const STORAGE_KEY = 'cross-tab-sync-test-key';

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
    window.__ytExtensionBridge = {
      workerSupported: true,
      workerUrl: 'chrome-extension://test/workers/renderer.js',
      storageType: 'chrome.storage.local',
    };
  });

  afterEach(() => {
    getCrossTabSyncAdapter(STORAGE_KEY).removeListener();
    delete window.__ytExtensionBridge;
  });

  it('selects the storage relay when only the extension bridge is available', () => {
    const callback = vi.fn();
    const adapter = getCrossTabSyncAdapter(STORAGE_KEY);
    adapter.addListener(callback);

    dispatchStorageChanged({
      source: 'yt-storage-changed',
      key: STORAGE_KEY,
      newValue: { enabled: true },
    });

    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(STORAGE_KEY, { enabled: true });
  });

  it('filters relay events by source, origin, and storage key', () => {
    const callback = vi.fn();
    const adapter = getCrossTabSyncAdapter(STORAGE_KEY);
    adapter.addListener(callback);

    dispatchStorageChanged(
      { source: 'yt-storage-changed', key: STORAGE_KEY, newValue: 'wrong-source' },
      null
    );
    dispatchStorageChanged(
      { source: 'yt-storage-changed', key: STORAGE_KEY, newValue: 'wrong-origin' },
      window,
      'https://other.example'
    );
    dispatchStorageChanged({ source: 'other-source', key: STORAGE_KEY, newValue: 'wrong-source' });
    dispatchStorageChanged({ source: 'yt-storage-changed', key: 'other-key', newValue: 'wrong-key' });

    expect(callback).not.toHaveBeenCalled();

    dispatchStorageChanged({
      source: 'yt-storage-changed',
      key: STORAGE_KEY,
      newValue: 'accepted',
    });

    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(STORAGE_KEY, 'accepted');
  });

  it('supports add, remove, and re-add on the cached relay adapter', () => {
    const firstCallback = vi.fn();
    const secondCallback = vi.fn();
    const thirdCallback = vi.fn();
    const adapter = getCrossTabSyncAdapter(STORAGE_KEY);

    adapter.addListener(firstCallback);
    dispatchStorageChanged({ source: 'yt-storage-changed', key: STORAGE_KEY, newValue: 1 });
    adapter.removeListener();
    dispatchStorageChanged({ source: 'yt-storage-changed', key: STORAGE_KEY, newValue: 2 });

    adapter.addListener(secondCallback);
    dispatchStorageChanged({ source: 'yt-storage-changed', key: STORAGE_KEY, newValue: 3 });
    adapter.removeListener();
    adapter.addListener(thirdCallback);
    dispatchStorageChanged({ source: 'yt-storage-changed', key: STORAGE_KEY, newValue: 4 });

    expect(firstCallback).toHaveBeenCalledOnce();
    expect(secondCallback).toHaveBeenCalledOnce();
    expect(thirdCallback).toHaveBeenCalledOnce();
    expect(firstCallback).toHaveBeenCalledWith(STORAGE_KEY, 1);
    expect(secondCallback).toHaveBeenCalledWith(STORAGE_KEY, 3);
    expect(thirdCallback).toHaveBeenCalledWith(STORAGE_KEY, 4);
  });
});
