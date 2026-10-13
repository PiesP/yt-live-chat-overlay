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
 * Validate required APIs once because the shared declaration also describes
 * page contexts where extension APIs are unavailable.
 *
 * Firefox compatibility note: The manifest.firefox.json declares the
 * `menus` permission (Firefox's equivalent of `contextMenus`). Firefox MV3
 * provides a `chrome` namespace compatibility layer, so `chrome.contextMenus`
 * works in both Chrome and Firefox extension service workers.
 */

// Fail startup if the extension context lacks a required API.
const contextMenus = chrome?.contextMenus;
const runtime = chrome?.runtime;
const tabs = chrome?.tabs;
if (!contextMenus || !runtime || !tabs) throw new Error('Required extension APIs are unavailable');

// ── Menu commands ──────────────────────────────────────────────────────────

const MENU_COMMANDS = [
  { id: 'reset-settings', title: 'Reset overlay settings' },
  { id: 'reload-overlay', title: 'Reload overlay' },
] as const;

// ── Installation ───────────────────────────────────────────────────────────

runtime.onInstalled.addListener((details) => {
  // Always rebuild menus on install/update.
  if (details.reason === 'install' || details.reason === 'update') {
    contextMenus.removeAll(() => {
      for (const cmd of MENU_COMMANDS) {
        contextMenus.create({
          id: cmd.id,
          title: cmd.title,
          contexts: ['action'],
        });
      }
    });
  }
});

// ── Context menu click handler ─────────────────────────────────────────────

contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;

  const command = MENU_COMMANDS.find((c) => c.id === info.menuItemId);
  if (!command) return;

  // Forward to content script
  tabs
    .sendMessage(tab.id, {
      type: 'menu-command',
      command: command.id,
    })
    .catch(() => {
      // Content script may not be loaded (not a YouTube page)
    });
});

export {};
