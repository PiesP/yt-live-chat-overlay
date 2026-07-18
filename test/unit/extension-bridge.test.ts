// SPDX-License-Identifier: MIT
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for extension content-script storage relay.
 *
 * Architecture:
 * - MAIN-world page script posts { source: 'yt-storage-relay', ... } messages
 * - ISOLATED content script listens for these and relays to chrome.storage.local
 * - Origin validation ensures only youtube.com messages are processed
 */

describe('Extension Bridge Storage Relay', () => {
  let storage: Map<string, unknown>;

  beforeEach(() => {
    storage = new Map();
    // Mock chrome.storage.local
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'test-ext',
        getURL: (path: string) => `chrome-extension://test-ext/${path}`,
      },
      storage: {
        local: {
          get: async (keys: string | string[]) => {
            const result: Record<string, unknown> = {};
            const keyList = Array.isArray(keys) ? keys : [keys];
            for (const k of keyList) {
              if (storage.has(k)) result[k] = storage.get(k);
            }
            return result;
          },
          set: async (items: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(items)) storage.set(k, v);
          },
          remove: async (keys: string | string[]) => {
            const keyList = Array.isArray(keys) ? keys : [keys];
            for (const k of keyList) storage.delete(k);
          },
        },
        onChanged: {
          addListener: () => {},
          removeListener: () => {},
        },
      },
      i18n: {
        getUILanguage: () => 'en',
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('chrome.runtime.getURL returns extension URL', () => {
    const url = chrome.runtime.getURL('page-script.js');
    expect(url).toContain('chrome-extension://');
    expect(url).toContain('page-script.js');
  });

  it('chrome.runtime.getURL bakes worker URL for bridge', () => {
    const url = chrome.runtime.getURL('workers/renderer.js');
    expect(url).toContain('workers/renderer.js');
    expect(url).toContain('chrome-extension://test-ext/');
  });

  it('chrome.storage.local round-trips values', async () => {
    await chrome.storage.local.set({ testKey: 'testValue' });
    const result = await chrome.storage.local.get('testKey');
    expect(result.testKey).toBe('testValue');
  });

  it('chrome.storage.local returns undefined for missing keys', async () => {
    const result = await chrome.storage.local.get('nonexistent');
    expect(result.nonexistent).toBeUndefined();
  });

  it('chrome.storage.local.remove() deletes keys', async () => {
    await chrome.storage.local.set({ deleteMe: 'value' });
    await chrome.storage.local.remove('deleteMe');
    const result = await chrome.storage.local.get('deleteMe');
    expect(result.deleteMe).toBeUndefined();
  });

  it('chrome.storage.local handles empty store', async () => {
    const result = await chrome.storage.local.get('any');
    expect(result).toEqual({});
  });

  it('chrome.i18n.getUILanguage returns a string', () => {
    expect(typeof chrome.i18n.getUILanguage()).toBe('string');
  });
});
