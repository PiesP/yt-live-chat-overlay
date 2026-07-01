// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Platform cross-tab sync adapter implementations.
 *
 * Each adapter conforms to the CrossTabSyncAdapter interface from @platform/types.
 * The factory function selects the appropriate adapter based on environment.
 *
 * Priority: chrome.storage.onChanged > GM_addValueChangeListener > window 'storage' event.
 */

import type { CrossTabSyncAdapter } from '@platform/types';

// ── ChromeCrossTabSyncAdapter ──────────────────────────────────────────────

export class ChromeCrossTabSyncAdapter implements CrossTabSyncAdapter {
  private readonly storageKey: string;
  private currentCallback: ((key: string, newValue: unknown) => void) | null = null;
  private readonly boundListener: (changes: Record<string, unknown>, areaName: string) => void;

  constructor(storageKey: string) {
    this.storageKey = storageKey;
    this.boundListener = (changes, areaName) => {
      if (areaName !== 'local') return;
      const change = changes[this.storageKey] as { newValue?: unknown } | undefined;
      if (!change || !this.currentCallback) return;
      this.currentCallback(this.storageKey, change.newValue);
    };
  }

  static isAvailable(): boolean {
    try {
      return (
        typeof chrome !== 'undefined' &&
        chrome.storage !== undefined &&
        chrome.storage.onChanged !== undefined
      );
    } catch {
      return false;
    }
  }

  addListener(callback: (key: string, newValue: unknown) => void): void {
    this.currentCallback = callback;
    const storage = chrome?.storage;
    storage?.onChanged?.addListener(this.boundListener);
  }

  removeListener(): void {
    this.currentCallback = null;
    if (ChromeCrossTabSyncAdapter.isAvailable()) {
      const storage = chrome?.storage;
      storage?.onChanged?.removeListener(this.boundListener);
    }
  }
}

// ── GmCrossTabSyncAdapter ──────────────────────────────────────────────────

export class GmCrossTabSyncAdapter implements CrossTabSyncAdapter {
  private readonly storageKey: string;
  private listenerId: number | null = null;
  private currentCallback: ((key: string, newValue: unknown) => void) | null = null;

  constructor(storageKey: string) {
    this.storageKey = storageKey;
  }

  static isAvailable(): boolean {
    return typeof GM_addValueChangeListener !== 'undefined';
  }

  addListener(callback: (key: string, newValue: unknown) => void): void {
    this.currentCallback = callback;
    this.listenerId = GM_addValueChangeListener(
      this.storageKey,
      (_key: string, _oldValue: unknown, newValue: unknown, _remote: boolean) => {
        if (this.currentCallback) {
          this.currentCallback(this.storageKey, newValue);
        }
      }
    );
  }

  removeListener(): void {
    if (this.listenerId !== null && GmCrossTabSyncAdapter.isAvailable()) {
      GM_removeValueChangeListener(this.listenerId);
      this.listenerId = null;
    }
    this.currentCallback = null;
  }
}

// ── LocalStorageCrossTabSyncAdapter ────────────────────────────────────────

export class LocalStorageCrossTabSyncAdapter implements CrossTabSyncAdapter {
  private readonly storageKey: string;
  private currentCallback: ((key: string, newValue: unknown) => void) | null = null;
  private readonly boundHandler: (event: StorageEvent) => void;

  constructor(storageKey: string) {
    this.storageKey = storageKey;
    this.boundHandler = (event: StorageEvent) => {
      if (event.key !== this.storageKey || event.newValue === null) return;
      if (this.currentCallback) {
        this.currentCallback(this.storageKey, event.newValue);
      }
    };
  }

  addListener(callback: (key: string, newValue: unknown) => void): void {
    this.currentCallback = callback;
    window.addEventListener('storage', this.boundHandler);
  }

  removeListener(): void {
    this.currentCallback = null;
    window.removeEventListener('storage', this.boundHandler);
  }
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
  // Without this, a stale listener (e.g., chrome.storage.onChanged) remains
  // registered when the storage key changes, causing cross-tab sync to fire
  // for the wrong key.
  if (cachedAdapter) {
    cachedAdapter.removeListener();
  }

  if (ChromeCrossTabSyncAdapter.isAvailable()) {
    cachedAdapter = new ChromeCrossTabSyncAdapter(storageKey);
  } else if (GmCrossTabSyncAdapter.isAvailable()) {
    cachedAdapter = new GmCrossTabSyncAdapter(storageKey);
  } else {
    cachedAdapter = new LocalStorageCrossTabSyncAdapter(storageKey);
  }
  cachedKey = storageKey;
  return cachedAdapter;
}
