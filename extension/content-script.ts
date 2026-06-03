// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Extension Content Script entry point.
 *
 * This script runs in the MAIN world (manifest "world": "MAIN") on YouTube pages.
 * It loads the same core application logic as the userscript, but with
 * Chrome extension platform adapters for storage, worker URLs, and menu commands.
 *
 * The side-effect import of ../src/main triggers the application bootstrap
 * (main() + registerMenuCommands() at the bottom of main.ts). No ES module
 * export syntax is used, so the bundled output works as a classic script.
 *
 * Chrome MV3 content scripts with "world": "MAIN" cannot use module type,
 * so we avoid import/export in the bundled output.
 */

// Side-effect import: triggers application bootstrap in main.ts.
// Vite bundles this as a single self-executing script with no module syntax.
import '../src/main';

// ── Background script message listener ─────────────────────────────────────

/**
 * Listen for menu commands forwarded from the background service worker.
 * Equivalent to GM_registerMenuCommand in the userscript.
 */
chrome.runtime?.onMessage?.addListener?.(
  (message: unknown) => {
    const msg = message as { type?: string; command?: string };
    if (msg.type !== 'menu-command') return;

    const app = (window as { __ytChatOverlay?: { resetSettings: () => void; restartRuntime: () => Promise<void> } }).__ytChatOverlay;
    if (!app) return;

    switch (msg.command) {
      case 'reset-settings':
        app.resetSettings();
        break;
      case 'reload-overlay':
        void app.restartRuntime();
        break;
    }
  }
);
