// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 PiesP

/**
 * @fileoverview Chrome extension + GM_* API mock utilities for YT Live Chat Overlay E2E.
 *
 * yt-live-chat-overlay uses platform adapters (StorageAdapter, MenuAdapter, WorkerFactory)
 * that auto-detect chrome.* vs GM_* availability. We mock both for E2E testing.
 */

/** In-memory storage simulating GM_setValue/GM_getValue and chrome.storage.local */
const SHARED_STORAGE = new Map<string, unknown>();

/** Log of all API calls for assertion */
const API_CALL_LOG: Array<{ api: string; args: unknown[]; timestamp: number }> = [];

/**
 * Install GM_* + chrome.* mock APIs on the page.
 * Call via page.evaluate(installYTMock) before userscript injection.
 */
export function installYTMock(): void {
  // ── GM_* API mocks (userscript path) ──

  window.GM_setValue = (key: string, value: unknown): void => {
    SHARED_STORAGE.set(key, value);
    API_CALL_LOG.push({ api: 'GM_setValue', args: [key, value], timestamp: Date.now() });
  };

  window.GM_getValue = <T = unknown>(key: string, defaultValue?: T): T => {
    API_CALL_LOG.push({ api: 'GM_getValue', args: [key, defaultValue], timestamp: Date.now() });
    return SHARED_STORAGE.has(key) ? (SHARED_STORAGE.get(key) as T) : (defaultValue as T);
  };

  window.GM_deleteValue = (key: string): void => {
    SHARED_STORAGE.delete(key);
    API_CALL_LOG.push({ api: 'GM_deleteValue', args: [key], timestamp: Date.now() });
  };

  window.GM_listValues = (): string[] => {
    API_CALL_LOG.push({ api: 'GM_listValues', args: [], timestamp: Date.now() });
    return Array.from(SHARED_STORAGE.keys());
  };

  window.GM_addValueChangeListener = (key: string, callback: (key: string, oldVal: unknown, newVal: unknown) => void): number => {
    API_CALL_LOG.push({ api: 'GM_addValueChangeListener', args: [key], timestamp: Date.now() });
    // Store listener for simulation (simplified — no auto-trigger)
    return Date.now();
  };

  window.GM_removeValueChangeListener = (_listenerId: number): void => {
    API_CALL_LOG.push({ api: 'GM_removeValueChangeListener', args: [], timestamp: Date.now() });
  };

  window.GM_registerMenuCommand = (_title: string, _onClick: () => void): void => {
    API_CALL_LOG.push({ api: 'GM_registerMenuCommand', args: [_title], timestamp: Date.now() });
  };

  window.GM_openInTab = (url: string): void => {
    API_CALL_LOG.push({ api: 'GM_openInTab', args: [url], timestamp: Date.now() });
    window.open(url, '_blank');
  };

  // ── chrome.* API mocks (extension path) ──

  const chromeMock: Record<string, unknown> = {
    runtime: {
      id: 'test-extension-id',
      getURL: (path: string) => `chrome-extension://test-extension-id/${path}`,
      onMessage: { addListener: () => {}, removeListener: () => {} },
      sendMessage: () => {},
      lastError: undefined,
    },
    storage: {
      local: {
        get: (keys: string | string[]): Promise<Record<string, unknown>> => {
          API_CALL_LOG.push({ api: 'chrome.storage.local.get', args: [keys], timestamp: Date.now() });
          const result: Record<string, unknown> = {};
          const keyList = Array.isArray(keys) ? keys : [keys];
          for (const k of keyList) {
            if (SHARED_STORAGE.has(k)) result[k] = SHARED_STORAGE.get(k);
          }
          return Promise.resolve(result);
        },
        set: (items: Record<string, unknown>): Promise<void> => {
          API_CALL_LOG.push({ api: 'chrome.storage.local.set', args: [items], timestamp: Date.now() });
          for (const [k, v] of Object.entries(items)) {
            SHARED_STORAGE.set(k, v);
          }
          return Promise.resolve();
        },
        remove: (keys: string | string[]): Promise<void> => {
          API_CALL_LOG.push({ api: 'chrome.storage.local.remove', args: [keys], timestamp: Date.now() });
          const keyList = Array.isArray(keys) ? keys : [keys];
          for (const k of keyList) SHARED_STORAGE.delete(k);
          return Promise.resolve();
        },
      },
      onChanged: {
        addListener: () => {},
        removeListener: () => {},
      },
    },
    i18n: {
      getUILanguage: () => 'en',
      getAcceptLanguages: () => Promise.resolve(['en', 'en-US']),
    },
    contextMenus: {
      create: () => {},
      removeAll: () => {},
      onClicked: { addListener: () => {} },
    },
    menus: {
      create: () => {},
      removeAll: () => {},
      onClicked: { addListener: () => {} },
    },
  };

  // Assign chrome global
  (window as unknown as Record<string, unknown>).chrome = chromeMock;

  // Also set GM_cookie for completeness
  window.GM_cookie = {
    list: (): Array<{ name: string; value: string }> => {
      API_CALL_LOG.push({ api: 'GM_cookie.list', args: [], timestamp: Date.now() });
      return document.cookie.split(';').filter(Boolean).map((c) => {
        const [name, ...rest] = c.trim().split('=');
        return { name: name!.trim(), value: rest.join('=').trim() };
      });
    },
    set: (cookie: { name: string; value: string }): void => {
      API_CALL_LOG.push({ api: 'GM_cookie.set', args: [cookie], timestamp: Date.now() });
      document.cookie = `${cookie.name}=${cookie.value}`;
    },
    delete: (name: string): void => {
      API_CALL_LOG.push({ api: 'GM_cookie.delete', args: [name], timestamp: Date.now() });
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
    },
  };
}

/**
 * Simulate a settings change by calling GM_setValue + triggering the change listener.
 * Useful for testing settings → overlay reactivity.
 */
export function simulateSettingsChange(settings: Record<string, unknown>): void {
  window.GM_setValue!('ytoverlay_settings_v2', settings);
  // Note: In real implementation, GM_addValueChangeListener fires automatically.
  // Here we just set the value; tests can verify on next read.
}

/** Type declarations for mock APIs */
declare global {
  interface Window {
    GM_setValue?: (key: string, value: unknown) => void;
    GM_getValue?: <T = unknown>(key: string, defaultValue?: T) => T;
    GM_deleteValue?: (key: string) => void;
    GM_listValues?: () => string[];
    GM_addValueChangeListener?: (key: string, cb: (key: string, oldVal: unknown, newVal: unknown) => void) => number;
    GM_removeValueChangeListener?: (listenerId: number) => void;
    GM_registerMenuCommand?: (title: string, onClick: () => void) => void;
    GM_openInTab?: (url: string) => void;
    GM_cookie?: {
      list: () => Array<{ name: string; value: string }>;
      set: (cookie: { name: string; value: string }) => void;
      delete: (name: string) => void;
    };
  }
}

export { SHARED_STORAGE, API_CALL_LOG };
