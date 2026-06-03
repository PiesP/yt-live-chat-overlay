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
 * Non-null assertions (!) are used because the ChromeNamespace uses optional
 * properties (for content-script compat) but all APIs are present in SW context.
 */

// ── Menu commands ──────────────────────────────────────────────────────────

const MENU_COMMANDS = [
  { id: 'reset-settings', title: 'Reset overlay settings' },
  { id: 'reload-overlay', title: 'Reload overlay' },
] as const;

// ── Installation ───────────────────────────────────────────────────────────

chrome.runtime!.onInstalled.addListener(() => {
  // Remove all existing menu items before re-creating (idempotent)
  chrome.contextMenus!.removeAll(() => {
    for (const cmd of MENU_COMMANDS) {
      chrome.contextMenus!.create({
        id: cmd.id,
        title: cmd.title,
        contexts: ['action'],
      });
    }
  });
});

// ── Context menu click handler ─────────────────────────────────────────────

chrome.contextMenus!.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;

  const command = MENU_COMMANDS.find((c) => c.id === info.menuItemId);
  if (!command) return;

  // Forward to content script
  chrome.tabs!.sendMessage(tab.id, {
    type: 'menu-command',
    command: command.id,
  }).catch(() => {
    // Content script may not be loaded (not a YouTube page)
  });
});
