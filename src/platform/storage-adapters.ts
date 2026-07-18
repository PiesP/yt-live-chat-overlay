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

// ── Storage relay for MV3 MAIN world ────────────────────────────────────────

/**
 * Set up a postMessage-based relay to chrome.storage.local for MV3 extensions
 * where the MAIN-world page script cannot access chrome.* APIs directly.
 *
 * The ISOLATED content script listens for 'yt-storage-relay' messages and
 * forwards them to chrome.storage.local. Returns null if the relay cannot
 * be established (e.g. not in an extension context).
 */
function setupStorageRelay(): StorageAdapter | null {
  // Only attempt relay setup if the bridge indicates extension context.
  if (!window.__ytExtensionBridge?.storageType) return null;

  let requestId = 0;
  const pending = new Map<
    number,
    {
      resolve: (value: string | null) => void;
      reject: (error: Error) => void;
    }
  >();

  // Listen for relay responses from the ISOLATED content script.
  const relayListener = (event: MessageEvent): void => {
    // Verify the message comes from our own window and origin
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;

    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.source !== 'yt-storage-relay-response') return;
    const entry = pending.get(data.requestId as number);
    if (!entry) return;
    pending.delete(data.requestId as number);
    if (data.error) {
      entry.reject(new Error(data.error as string));
    } else {
      entry.resolve(data.value as string | null);
    }
  };

  window.addEventListener('message', relayListener);

  return {
    async getItem(key: string): Promise<string | null> {
      return new Promise<string | null>((resolve, reject) => {
        const id = ++requestId;
        pending.set(id, { resolve, reject });
        const timeout = setTimeout(() => {
          pending.delete(id);
          resolve(null); // Timeout → null (safe fallback)
        }, 2000);
        // Wrap resolve to clear timeout.
        const wrappedResolve = (value: string | null) => {
          clearTimeout(timeout);
          resolve(value);
        };
        pending.set(id, { resolve: wrappedResolve, reject });
        window.postMessage(
          { source: 'yt-storage-relay', requestId: id, method: 'get', key },
          window.location.origin
        );
      });
    },

    async setItem(key: string, value: string): Promise<void> {
      return new Promise<void>((resolve) => {
        const id = ++requestId;
        const timeout = setTimeout(() => {
          pending.delete(id);
          resolve(); // Timeout → silent (best-effort write)
        }, 2000);
        const wrappedResolve = () => {
          clearTimeout(timeout);
          resolve();
        };
        pending.set(id, {
          resolve: wrappedResolve as (v: string | null) => void,
          reject: () => {},
        });
        window.postMessage(
          { source: 'yt-storage-relay', requestId: id, method: 'set', key, value },
          window.location.origin
        );
      });
    },
  };
}

// ── Factory ────────────────────────────────────────────────────────────────

let cachedAdapter: StorageAdapter | null = null;

/** Returns the best available storage adapter for the current environment. */
export function getStorageAdapter(): StorageAdapter {
  if (cachedAdapter) return cachedAdapter;

  // Extension bridge: the ISOLATED content script sets storageType before
  // the MAIN-world page script loads. Check this first so extension users
  // always get chrome.storage.local persistence, even though chrome.* APIs
  // are not directly available in MAIN world.
  const bridgeStorageType = window.__ytExtensionBridge?.storageType;
  if (bridgeStorageType === 'chrome.storage.local') {
    // In extension context, chrome.storage.local is accessible from the
    // background service worker via message relay. For reads/writes in
    // MAIN world, we use postMessage to the content script, which forwards
    // to chrome.storage.local. Fall back to localStorage if the relay
    // is unavailable (e.g. during early initialization before the content
    // script listener is registered).
    const relay = setupStorageRelay();
    if (relay) {
      cachedAdapter = relay;
      return cachedAdapter;
    }
    // Fall through to localStorage as a safe default.
  }

  // chrome.storage.local (extension — ISOLATED world or non-MV3)
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
        } catch (_error: unknown) {
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
        } catch (_error: unknown) {
          return null;
        }
      },
      async setItem(key: string, value: string): Promise<void> {
        if (typeof GM_setValue === 'undefined') return;
        try {
          GM_setValue(key, value);
        } catch (error: unknown) {
          log.warn('platform.storage.set-failed', { error: String(error) });
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
      } catch (_error: unknown) {
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
