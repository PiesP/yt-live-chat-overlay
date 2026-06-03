// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Extension Content Script entry point.
 *
 * This script runs in the MAIN world (manifest "world": "MAIN") on YouTube pages.
 * It loads the same core application logic as the userscript, but with
 * Chrome extension platform adapters for storage, worker URLs, and menu commands.
 *
 * Layout: This thin entry point re-exports the application bootstrap.
 * All core logic lives in src/ — this file only wires the extension-specific
 * parts (menu command listener from background script).
 */

// Re-export the userscript application bootstrap (shared code path).
// In the extension build, Vite resolves platform adapters to Chrome implementations.
export { } from '../src/main';

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
