// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Platform storage adapter implementations.
 *
 * Each adapter conforms to the StorageAdapter interface from @platform/types.
 * The factory function selects the appropriate adapter based on environment.
 */

import type { StorageAdapter } from '@platform/types';

// ── LocalStorageAdapter ────────────────────────────────────────────────────

export class LocalStorageAdapter implements StorageAdapter {
  async getItem(key: string): Promise<string | null> {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  async setItem(key: string, value: string): Promise<void> {
    try {
      localStorage.setItem(key, value);
    } catch {
      // quota exceeded or private browsing — silently ignore
    }
  }
}

// ── GmStorageAdapter ──────────────────────────────────────────────────────

export class GmStorageAdapter implements StorageAdapter {
  async getItem(key: string): Promise<string | null> {
    try {
      if (typeof GM_getValue === 'undefined') return null;
      const value = GM_getValue(key);
      if (value === undefined || value === null) return null;
      // Some userscript managers (Violentmonkey, Greasemonkey 4+) auto-parse
      // JSON on GM_getValue, returning an object instead of the raw string.
      // Re-serialize to string so JSON.parse in the caller works correctly.
      if (typeof value === 'object') {
        return JSON.stringify(value);
      }
      return String(value);
    } catch {
      return null;
    }
  }

  async setItem(key: string, value: string): Promise<void> {
    if (typeof GM_setValue === 'undefined') return;
    try {
      GM_setValue(key, value);
    } catch {
      // silently ignore
    }
  }
}

// ── ChromeStorageAdapter ───────────────────────────────────────────────────

export class ChromeStorageAdapter implements StorageAdapter {
  /**
   * Whether chrome.storage API is available.
   * Content scripts in MAIN world have access to chrome.runtime but not chrome.storage.
   * The adapter detects this and falls back gracefully.
   */
  static isAvailable(): boolean {
    try {
      return typeof chrome !== 'undefined' && chrome.storage?.local !== undefined;
    } catch {
      return false;
    }
  }

  async getItem(key: string): Promise<string | null> {
    try {
      const storage = chrome?.storage?.local;
      if (!storage) return null;
      const result = await storage.get(key);
      const value = result[key];
      if (value === undefined || value === null) return null;
      return typeof value === 'string' ? value : JSON.stringify(value);
    } catch {
      return null;
    }
  }

  async setItem(key: string, value: string): Promise<void> {
    try {
      await chrome?.storage?.local.set({ [key]: value });
    } catch {
      // quota exceeded or extension context invalidated — silently ignore
    }
  }
}

// ── Factory ────────────────────────────────────────────────────────────────

let cachedAdapter: StorageAdapter | null = null;

/**
 * Returns the best available storage adapter for the current environment.
 * Priority: chrome.storage > GM_* > localStorage.
 */
export function getStorageAdapter(): StorageAdapter {
  if (cachedAdapter) return cachedAdapter;

  if (ChromeStorageAdapter.isAvailable()) {
    cachedAdapter = new ChromeStorageAdapter();
    return cachedAdapter;
  }

  if (typeof GM_getValue !== 'undefined' && typeof GM_setValue !== 'undefined') {
    cachedAdapter = new GmStorageAdapter();
    return cachedAdapter;
  }

  cachedAdapter = new LocalStorageAdapter();
  return cachedAdapter;
}

/** Reset cached adapter (for testing). */
export function resetStorageAdapterCache(): void {
  cachedAdapter = null;
}
