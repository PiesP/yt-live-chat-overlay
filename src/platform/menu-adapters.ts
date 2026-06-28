// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Platform menu command adapter implementations.
 *
 * Each platform registers menu commands differently:
 * - Userscript: GM_registerMenuCommand
 * - Chrome extension: chrome.contextMenus (requires background script — see Phase 7)
 * - Firefox extension: browser.menus (requires background script — see Phase 8)
 * - No-op: For environments without menu support
 */

import type { MenuAdapter, MenuCommand } from '@platform/types';

// ── GmMenuAdapter ──────────────────────────────────────────────────────────

export class GmMenuAdapter implements MenuAdapter {
  isSupported(): boolean {
    return typeof GM_registerMenuCommand !== 'undefined';
  }

  register(commands: MenuCommand[]): void {
    if (!this.isSupported()) return;
    for (const cmd of commands) {
      GM_registerMenuCommand(cmd.name, cmd.action);
    }
  }
}

// ── NoopMenuAdapter ────────────────────────────────────────────────────────

/** No-op adapter for environments without menu support. */
export class NoopMenuAdapter implements MenuAdapter {
  isSupported(): boolean {
    return false;
  }

  register(_commands: MenuCommand[]): void {
    // No-op
  }
}

// ── Factory ────────────────────────────────────────────────────────────────

let cachedAdapter: MenuAdapter | null = null;

/**
 * Returns the best available menu adapter for the current environment.
 * Priority: GM_registerMenuCommand > no-op.
 * chrome.contextMenus adapter will be wired when the extension background script exists (Phase 7).
 */
export function getMenuAdapter(): MenuAdapter {
  if (cachedAdapter) return cachedAdapter;

  if (typeof GM_registerMenuCommand !== 'undefined') {
    cachedAdapter = new GmMenuAdapter();
    return cachedAdapter;
  }

  cachedAdapter = new NoopMenuAdapter();
  return cachedAdapter;
}
