// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Platform storage adapter — inline implementations.
 *
 * Returns a StorageAdapter object matching the current environment:
 *   chrome.storage.local (extension) > GM_* (userscript) > localStorage (fallback).
 */

import type { StorageAdapter } from '@platform/types';
import { createLogger } from '@util/logging';

const log = createLogger('StorageAdapter');

// ── Quota-exceeded detection ──────────────────────────────────────────────

function isQuotaExceededError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return (
      error.name === 'QuotaExceededError' ||
      error.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      error.code === 22 ||
      error.code === 1014
    );
  }
  if (error instanceof Error) {
    return (
      error.message.toLowerCase().includes('quota') ||
      error.message.toLowerCase().includes('exceeded')
    );
  }
  return false;
}

// ── Factory ────────────────────────────────────────────────────────────────

let cachedAdapter: StorageAdapter | null = null;

/** Returns the best available storage adapter for the current environment. */
export function getStorageAdapter(): StorageAdapter {
  if (cachedAdapter) return cachedAdapter;

  // chrome.storage.local (extension)
  if (typeof chrome !== 'undefined' && chrome.storage?.local !== undefined) {
    const storage = chrome.storage.local;
    cachedAdapter = {
      async getItem(key: string): Promise<string | null> {
        try {
          const result = await storage.get(key);
          if (!result) return null;
          const value = result[key];
          if (value === undefined || value === null) return null;
          return typeof value === 'string' ? value : JSON.stringify(value);
        } catch {
          return null;
        }
      },
      async setItem(key: string, value: string): Promise<void> {
        try {
          await storage.set({ [key]: value });
        } catch (error: unknown) {
          if (isQuotaExceededError(error)) {
            log.warn(
              `Chrome storage quota exceeded for key "${key}". ` +
                'Consider reducing settings data or clearing unused entries.'
            );
          }
        }
      },
    };
    return cachedAdapter;
  }

  // GM_* (userscript)
  if (typeof GM_getValue !== 'undefined' && typeof GM_setValue !== 'undefined') {
    cachedAdapter = {
      async getItem(key: string): Promise<string | null> {
        try {
          const rawValue: unknown = GM_getValue(key);
          if (rawValue === undefined || rawValue === null) return null;
          if (typeof rawValue === 'object') return JSON.stringify(rawValue);
          return String(rawValue);
        } catch {
          return null;
        }
      },
      async setItem(key: string, value: string): Promise<void> {
        if (typeof GM_setValue === 'undefined') return;
        try {
          GM_setValue(key, value);
        } catch {
          // silently ignore
        }
      },
    };
    return cachedAdapter;
  }

  // localStorage (fallback)
  cachedAdapter = {
    async getItem(key: string): Promise<string | null> {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    async setItem(key: string, value: string): Promise<void> {
      try {
        localStorage.setItem(key, value);
      } catch (error: unknown) {
        if (isQuotaExceededError(error as Error)) {
          log.warn(
            `Storage quota exceeded for key "${key}". ` +
              'Consider reducing settings data or clearing unused entries.'
          );
        }
      }
    },
  };
  return cachedAdapter;
}

/** Reset cached adapter singleton for test isolation. */
export function resetStorageAdapter(): void {
  cachedAdapter = null;
}
