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

  return {
    addListener(callback: (key: string, newValue: unknown) => void): void {
      currentCallback = callback;
      chrome?.storage?.onChanged?.addListener(listener);
    },
    removeListener(): void {
      currentCallback = null;
      chrome?.storage?.onChanged?.removeListener(listener);
    },
  };
}

function isChromeSyncAvailable(): boolean {
  try {
    return (
      typeof chrome !== 'undefined' &&
      chrome.storage !== undefined &&
      chrome.storage.onChanged !== undefined
    );
  } catch (error: unknown) {
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

/** Reset cached adapter singleton and key for test isolation. */
export function resetCrossTabSyncAdapter(): void {
  cachedAdapter = null;
  cachedKey = null;
}
