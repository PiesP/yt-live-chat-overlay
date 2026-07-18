// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Platform cross-tab sync adapters — inline implementations.
 *
 * Priority: chrome.storage.onChanged > GM_addValueChangeListener > window 'storage' event.
 */

import type { CrossTabSyncAdapter } from '@platform/types';

// ── Chrome storage sync ────────────────────────────────────────────────────

function createChromeSyncAdapter(storageKey: string): CrossTabSyncAdapter {
  let currentCallback: ((key: string, newValue: unknown) => void) | null = null;
  const listener = (changes: Record<string, unknown>, areaName: string) => {
    if (areaName !== 'local') return;
    const change = changes[storageKey] as { newValue?: unknown } | undefined;
    if (!change || !currentCallback) return;
    currentCallback(storageKey, change.newValue);
  };

  // In MAIN-world page scripts (MV3 extension), chrome.storage.onChanged
  // is not directly available. The ISOLATED content script relays changes
  // via window.postMessage with source='yt-storage-changed'.
  let messageListener: ((event: MessageEvent) => void) | null = null;
  if (!isChromeSyncAvailableDirect()) {
    messageListener = (event: MessageEvent) => {
      if (event.source !== window) return;
      if (event.origin !== window.location.origin) return;
      const data = event.data;
      if (!data || data.source !== 'yt-storage-changed') return;
      if (data.key !== storageKey) return;
      if (currentCallback) currentCallback(storageKey, data.newValue);
    };
  }

  return {
    addListener(callback: (key: string, newValue: unknown) => void): void {
      currentCallback = callback;
      if (messageListener) {
        window.addEventListener('message', messageListener);
      } else {
        chrome?.storage?.onChanged?.addListener(listener);
      }
    },
    removeListener(): void {
      currentCallback = null;
      if (messageListener) {
        window.removeEventListener('message', messageListener);
        messageListener = null;
      } else {
        chrome?.storage?.onChanged?.removeListener(listener);
      }
    },
  };
}

/**
 * Check whether chrome.storage.onChanged is directly available.
 * In MV3 MAIN-world content scripts (injected as <script> tags),
 * chrome.* APIs are NOT accessible even though `typeof chrome` is defined
 * (as a stub by the browser for fingerprinting protection).
 */
function isChromeSyncAvailableDirect(): boolean {
  try {
    return (
      typeof chrome !== 'undefined' &&
      chrome.storage !== undefined &&
      typeof chrome.storage.onChanged !== 'undefined' &&
      typeof chrome.storage.onChanged.addListener === 'function'
    );
  } catch (_error: unknown) {
    return false;
  }
}

function isChromeSyncAvailable(): boolean {
  try {
    return (
      typeof chrome !== 'undefined' &&
      chrome.storage !== undefined &&
      chrome.storage.onChanged !== undefined
    );
  } catch (_error: unknown) {
    return false;
  }
}

// ── GM value-change sync ──────────────────────────────────────────────────

function createGmSyncAdapter(storageKey: string): CrossTabSyncAdapter {
  let listenerId: number | null = null;
  let currentCallback: ((key: string, newValue: unknown) => void) | null = null;

  return {
    addListener(callback: (key: string, newValue: unknown) => void): void {
      currentCallback = callback;
      listenerId = GM_addValueChangeListener(
        storageKey,
        (_key: string, _oldValue: unknown, newValue: unknown, _remote: boolean) => {
          if (currentCallback) {
            currentCallback(storageKey, newValue);
          }
        }
      );
    },
    removeListener(): void {
      if (listenerId !== null && typeof GM_removeValueChangeListener !== 'undefined') {
        GM_removeValueChangeListener(listenerId);
        listenerId = null;
      }
      currentCallback = null;
    },
  };
}

function isGmSyncAvailable(): boolean {
  return typeof GM_addValueChangeListener !== 'undefined';
}

// ── localStorage sync ─────────────────────────────────────────────────────

function createLocalStorageSyncAdapter(storageKey: string): CrossTabSyncAdapter {
  let currentCallback: ((key: string, newValue: unknown) => void) | null = null;
  const handler = (event: StorageEvent) => {
    if (event.key !== storageKey || event.newValue === null) return;
    if (currentCallback) {
      currentCallback(storageKey, event.newValue);
    }
  };

  return {
    addListener(callback: (key: string, newValue: unknown) => void): void {
      currentCallback = callback;
      window.addEventListener('storage', handler);
    },
    removeListener(): void {
      currentCallback = null;
      window.removeEventListener('storage', handler);
    },
  };
}

// ── Factory ────────────────────────────────────────────────────────────────

let cachedAdapter: CrossTabSyncAdapter | null = null;
let cachedKey: string | null = null;

/**
 * Returns the best available cross-tab sync adapter for the current environment.
 * Priority: chrome.storage.onChanged > GM_addValueChangeListener > window 'storage' event.
 *
 * @param storageKey The storage key to listen for changes on.
 */
export function getCrossTabSyncAdapter(storageKey: string): CrossTabSyncAdapter {
  if (cachedAdapter && cachedKey === storageKey) return cachedAdapter;

  // Clean up the previous adapter's listener before replacing it.
  if (cachedAdapter) {
    cachedAdapter.removeListener();
  }

  if (isChromeSyncAvailable()) {
    cachedAdapter = createChromeSyncAdapter(storageKey);
  } else if (isGmSyncAvailable()) {
    cachedAdapter = createGmSyncAdapter(storageKey);
  } else {
    cachedAdapter = createLocalStorageSyncAdapter(storageKey);
  }
  cachedKey = storageKey;
  return cachedAdapter;
}
