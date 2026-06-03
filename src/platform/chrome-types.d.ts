// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Minimal type declarations for Chrome extension APIs used by platform adapters.
 *
 * Purpose: Allow `chrome.storage` usage without pulling in @types/chrome.
 * Runtime availability is guarded by `typeof chrome !== 'undefined'` checks.
 */

interface ChromeStorageArea {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

interface ChromeStorageNamespace {
  local: ChromeStorageArea;
}

interface ChromeRuntimeNamespace {
  id?: string;
  getURL(path: string): string;
}

interface ChromeNamespace {
  storage: ChromeStorageNamespace;
  runtime: ChromeRuntimeNamespace;
}

declare const chrome: ChromeNamespace | undefined;
