/// <reference path="../src/platform/chrome-types.d.ts" />

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Extension Background Service Worker (MV3).
 *
 * Responsibilities:
 * - Register context menu commands (equivalent to GM_registerMenuCommand)
 * - Forward menu clicks to the active tab's content script
 *
 * `chrome` global is always available in extension service worker context.
 * We cache it as `browserApi` because the type declaration marks it as
 * possibly undefined (for content-script compat) but all APIs are present
 * in SW context.
 */

// Cache the chrome namespace: in SW context it is always defined,
// but the type declaration marks it as possibly undefined for compat
// with content-script contexts where it may not be available.
const browserApi = chrome!;

// ── Menu commands ──────────────────────────────────────────────────────────

const MENU_COMMANDS = [
  { id: 'reset-settings', title: 'Reset overlay settings' },
  { id: 'reload-overlay', title: 'Reload overlay' },
] as const;

// ── Context menu helpers ───────────────────────────────────────────────────

/** Idempotent menu registration: creates only missing items. */
function ensureMenuCommands(): void {
  browserApi.contextMenus.getAll((existing) => {
    const existingIds = new Set(existing.map((item) => item.id));
    for (const cmd of MENU_COMMANDS) {
      if (existingIds.has(cmd.id)) continue;
      browserApi.contextMenus.create(
        {
          id: cmd.id,
          title: cmd.title,
          contexts: ['action'],
        },
        () => {
          if (browserApi.runtime.lastError) {
            // Menu may have been created by a concurrent call — safe to ignore.
          }
        }
      );
    }
  });
}

// ── Installation ───────────────────────────────────────────────────────────

browserApi.runtime.onInstalled.addListener((details) => {
  // Always rebuild menus on install/update.
  if (details.reason === 'install' || details.reason === 'update') {
    browserApi.contextMenus.removeAll(() => {
      for (const cmd of MENU_COMMANDS) {
        browserApi.contextMenus.create({
          id: cmd.id,
          title: cmd.title,
          contexts: ['action'],
        });
      }
    });
  }
});

// ── Context menu click handler ─────────────────────────────────────────────

browserApi.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;

  const command = MENU_COMMANDS.find((c) => c.id === info.menuItemId);
  if (!command) return;

  // Forward to content script
  browserApi.tabs.sendMessage(tab.id, {
    type: 'menu-command',
    command: command.id,
  }).catch(() => {
    // Content script may not be loaded (not a YouTube page)
  });
});
