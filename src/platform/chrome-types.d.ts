// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Minimal type declarations for Chrome extension APIs used by platform adapters
 * and extension background/service worker scripts.
 *
 * Purpose: Allow extension code to reference chrome.* APIs without pulling in
 * the full @types/chrome dependency. Runtime availability is guarded by
 * `typeof chrome !== 'undefined'` checks.
 */

// ── Storage ────────────────────────────────────────────────────────────────

interface ChromeStorageArea {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

interface ChromeStorageChangedEvent {
  addListener(callback: (changes: Record<string, unknown>, areaName: string) => void): void;
  removeListener(callback: (changes: Record<string, unknown>, areaName: string) => void): void;
}

interface ChromeStorageNamespace {
  local: ChromeStorageArea;
  onChanged: ChromeStorageChangedEvent;
}

// ── Runtime ────────────────────────────────────────────────────────────────

interface ChromeRuntimeOnInstalledEvent {
  addListener(callback: (details: { reason: string }) => void): void;
}

interface ChromeMessageSender {
  id?: string;
  tab?: ChromeTab;
  url?: string;
}

interface ChromeRuntimeOnMessageEvent {
  addListener(
    callback: (
      message: unknown,
      sender: ChromeMessageSender,
      sendResponse: (response: unknown) => void
    ) => void | boolean
  ): void;
}

interface ChromeRuntimeNamespace {
  id?: string;
  getURL(path: string): string;
  onInstalled: ChromeRuntimeOnInstalledEvent;
  onMessage?: ChromeRuntimeOnMessageEvent;
  lastError?: { message?: string };
}

// ── Context Menus ──────────────────────────────────────────────────────────

interface ChromeContextMenuCreateProperties {
  id: string;
  title: string;
  contexts: string[];
}

interface ChromeContextMenuInfo {
  menuItemId: string | number;
}

interface ChromeContextMenusClickedEvent {
  addListener(callback: (info: ChromeContextMenuInfo, tab?: ChromeTab) => void): void;
}

interface ChromeContextMenusNamespace {
  create(properties: ChromeContextMenuCreateProperties, callback?: () => void): void;
  removeAll(callback?: () => void): void;
  getAll(callback: (items: ChromeContextMenuItem[]) => void): void;
  onClicked: ChromeContextMenusClickedEvent;
}

interface ChromeContextMenuItem {
  id?: string;
}

// ── Tabs ───────────────────────────────────────────────────────────────────

interface ChromeTab {
  id?: number;
}

interface ChromeTabsNamespace {
  sendMessage(tabId: number, message: unknown): Promise<unknown>;
}

interface ChromeI18nNamespace {
  getUILanguage(): string;
}

// ── Top-level namespace ────────────────────────────────────────────────────

interface ChromeNamespace {
  storage: ChromeStorageNamespace;
  runtime: ChromeRuntimeNamespace;
  contextMenus: ChromeContextMenusNamespace;
  tabs: ChromeTabsNamespace;
  i18n: ChromeI18nNamespace;
}

declare const chrome: ChromeNamespace;

/**
 * Firefox MV3 exposes browser.* as the canonical API namespace.
 * It mirrors chrome.* closely; we declare it with the same type so the
 * factory can fall back to it when chrome is absent.
 */
declare const browser: ChromeNamespace;
