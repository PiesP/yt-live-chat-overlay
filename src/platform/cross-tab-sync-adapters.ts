// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Platform cross-tab sync adapters — inline implementations.
 *
 * Priority: chrome.storage.onChanged / extension relay > GM_addValueChangeListener >
 * window 'storage' event.
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

  const directChangeEvent = getChromeSyncChangeEvent();
  let directListenerRegistered = false;

  // In MAIN-world page scripts (MV3 extension), chrome.storage.onChanged
  // is not directly available. The ISOLATED content script relays changes
  // via window.postMessage with source='yt-storage-changed'.
  let messageListener: ((event: MessageEvent) => void) | null = null;
  if (!directChangeEvent) {
    messageListener = (event: MessageEvent) => {
      if (event.source !== window) return;
      if (event.origin !== window.location.origin) return;
      const data = event.data;
      if (data?.source !== 'yt-storage-changed') return;
      if (data.key !== storageKey) return;
      if (currentCallback) currentCallback(storageKey, data.newValue);
    };
  }

  return {
    addListener(callback: (key: string, newValue: unknown) => void): void {
      if (directChangeEvent) {
        if (directListenerRegistered) {
          directChangeEvent.removeListener(listener);
        }
        currentCallback = callback;
        directChangeEvent.addListener(listener);
        directListenerRegistered = true;
        return;
      }

      currentCallback = callback;
      if (messageListener) {
        window.addEventListener('message', messageListener);
      }
    },
    removeListener(): void {
      currentCallback = null;
      if (directChangeEvent) {
        if (directListenerRegistered) {
          directChangeEvent.removeListener(listener);
          directListenerRegistered = false;
        }
        return;
      }

      if (messageListener) {
        window.removeEventListener('message', messageListener);
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
  return getChromeSyncChangeEvent() !== null;
}

function getChromeSyncChangeEvent(): ChromeStorageChangedEvent | null {
  try {
    if (typeof chrome === 'undefined') return null;
    const changeEvent = chrome?.storage?.onChanged;
    if (!changeEvent) return null;
    if (typeof changeEvent.addListener !== 'function') return null;
    if (typeof changeEvent.removeListener !== 'function') return null;
    return changeEvent;
  } catch (_error: unknown) {
    return null;
  }
}

// ── GM value-change sync ──────────────────────────────────────────────────

function createGmSyncAdapter(storageKey: string): CrossTabSyncAdapter {
  let listenerId: number | null = null;
  let currentCallback: ((key: string, newValue: unknown) => void) | null = null;
  const addValueChangeListener = GM_addValueChangeListener;
  const removeValueChangeListener = GM_removeValueChangeListener;

  return {
    addListener(callback: (key: string, newValue: unknown) => void): void {
      if (listenerId !== null) {
        removeValueChangeListener(listenerId);
        listenerId = null;
      }
      currentCallback = callback;
      listenerId = addValueChangeListener(
        storageKey,
        (_key: string, _oldValue: unknown, newValue: unknown, _remote: boolean) => {
          if (currentCallback) {
            currentCallback(storageKey, newValue);
          }
        }
      );
    },
    removeListener(): void {
      if (listenerId !== null) {
        removeValueChangeListener(listenerId);
        listenerId = null;
      }
      currentCallback = null;
    },
  };
}

function isGmSyncAvailable(): boolean {
  return (
    typeof GM_addValueChangeListener === 'function' &&
    typeof GM_removeValueChangeListener === 'function'
  );
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
 * Priority: chrome.storage.onChanged / extension relay > GM_addValueChangeListener >
 * window 'storage' event.
 *
 * @param storageKey The storage key to listen for changes on.
 */
export function getCrossTabSyncAdapter(storageKey: string): CrossTabSyncAdapter {
  if (cachedAdapter && cachedKey === storageKey) return cachedAdapter;

  // Clean up the previous adapter's listener before replacing it.
  if (cachedAdapter) {
    cachedAdapter.removeListener();
  }

  if (
    isChromeSyncAvailableDirect() ||
    window.__ytExtensionBridge?.storageType === 'chrome.storage.local'
  ) {
    cachedAdapter = createChromeSyncAdapter(storageKey);
  } else if (isGmSyncAvailable()) {
    cachedAdapter = createGmSyncAdapter(storageKey);
  } else {
    cachedAdapter = createLocalStorageSyncAdapter(storageKey);
  }
  cachedKey = storageKey;
  return cachedAdapter;
}
