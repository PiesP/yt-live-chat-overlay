// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Platform abstraction type aliases.
 *
 * Each platform (userscript, Chrome extension, Firefox extension) provides
 * its own implementation behind these types. Core modules depend only on
 * these types, never on platform-specific APIs (GM_*, chrome.*, browser.*).
 */

// ── Storage ───────────────────────────────────────────────────────────────

/** Key-value persistence adapter. All methods are async to support chrome.storage.local. */
export type StorageAdapter = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

// ── Cross-Tab Sync ────────────────────────────────────────────────────────

/**
 * Listens for settings changes made in other tabs and notifies the caller.
 *
 * Implementations wrap platform-specific cross-tab sync mechanisms:
 * - GM_addValueChangeListener (userscript)
 * - chrome.storage.onChanged (extension)
 * - window 'storage' event (fallback)
 */
export type CrossTabSyncAdapter = {
  /** Start listening for cross-tab changes. The callback fires with the changed key. */
  addListener(callback: (key: string, newValue: unknown) => void): void;
  /** Remove the listener registered via addListener(). */
  removeListener(): void;
};

// ── Menu ──────────────────────────────────────────────────────────────────

/** A single menu command entry. */
export type MenuCommand = {
  /** Display name (already localized by the caller). */
  name: string;
  /** Action to execute when the command is selected. */
  action: () => void;
};

/** Platform-native menu registration (userscript menu, context menu, etc.). */
export type MenuAdapter = {
  /** Register one or more menu commands. Idempotent — safe to call multiple times. */
  register(commands: MenuCommand[]): void;
  /** Whether menu registration is supported in this environment. */
  isSupported(): boolean;
};

// ── Worker ────────────────────────────────────────────────────────────────

/** Resolves the URL for a render worker bundle. */
export type WorkerFactory = {
  /**
   * Create a worker URL from a relative module path.
   * @param relativePath Module-relative path, e.g. './renderer-worker.ts'.
   * @returns URL that can be passed to `new Worker(url, { type: 'module' })`.
   */
  createWorkerUrl(relativePath: string): string | URL;
};

// ── Language ───────────────────────────────────────────────────────────────

/**
 * Provides the browser's UI language hint.
 *
 * Core modules never call chrome.* directly. The platform bootstrap wires
 * the appropriate implementation (Chrome extension vs. userscript vs. fallback).
 */
export type LanguageAdapter = {
  /**
   * Return the browser's UI language code (e.g. "en", "ko", "ja"),
   * or undefined if the platform cannot determine it.
   */
  getUILanguage(): string | undefined;
};
