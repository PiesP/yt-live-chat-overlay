// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Platform abstraction interfaces.
 *
 * Each platform (userscript, Chrome extension, Firefox extension) provides
 * its own implementation of these interfaces. Core modules depend only on
 * the interfaces, never on platform-specific APIs (GM_*, chrome.*, browser.*).
 */

// ── Storage ───────────────────────────────────────────────────────────────

/** Key-value persistence adapter. All methods are async to support chrome.storage.local. */
export interface StorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

// ── Cross-Tab Sync ────────────────────────────────────────────────────────

// Cross-tab sync is implemented inline in Settings.ts via
// GM_addValueChangeListener / chrome.storage.onChanged listeners.
// See src/core/settings.ts for the implementation.

// ── Menu ──────────────────────────────────────────────────────────────────

/** A single menu command entry. */
export interface MenuCommand {
  /** Display name (already localized by the caller). */
  name: string;
  /** Action to execute when the command is selected. */
  action: () => void;
}

/** Platform-native menu registration (userscript menu, context menu, etc.). */
export interface MenuAdapter {
  /** Register one or more menu commands. Idempotent — safe to call multiple times. */
  register(commands: MenuCommand[]): void;
  /** Whether menu registration is supported in this environment. */
  isSupported(): boolean;
}

// ── Worker ────────────────────────────────────────────────────────────────

/** Resolves the URL for a render worker bundle. */
export interface WorkerFactory {
  /**
   * Create a worker URL from a relative module path.
   * @param relativePath Module-relative path, e.g. './renderer-worker.ts'.
   * @returns URL that can be passed to `new Worker(url, { type: 'module' })`.
   */
  createWorkerUrl(relativePath: string): string | URL;
}
