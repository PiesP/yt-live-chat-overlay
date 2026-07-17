// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Extension Page Script — runs in the MAIN world, injected as a <script> tag
 * by the ISOLATED-world content script.
 *
 * Has full access to the page's window (for app bootstrap) but NO access to
 * chrome.runtime. Menu commands are forwarded from the ISOLATED content script
 * via window.postMessage with strict origin validation.
 */

// Side-effect import: triggers application bootstrap in main.ts.
// Vite bundles this as a self-executing IIFE with no module syntax.
import '../src/main';

// ── Forwarded command listener ─────────────────────────────────────────

interface ContentScriptYtChatOverlayHandle {
  resetSettings(): void;
  restartRuntime(): Promise<void>;
}

const COMMAND_ORIGIN = window.location.origin;

window.addEventListener('message', (event: MessageEvent) => {
  // Strict origin check: reject messages from any other origin.
  if (event.origin !== COMMAND_ORIGIN) return;

  const data = event.data;
  if (
    !data ||
    typeof data !== 'object' ||
    (data as Record<string, unknown>).source !== 'yt-chat-overlay-extension'
  ) {
    return;
  }

  const command = (data as Record<string, unknown>).command as string | undefined;
  if (command !== 'reset-settings' && command !== 'reload-overlay') return;

  const app = (window as { __ytChatOverlay?: ContentScriptYtChatOverlayHandle })
    .__ytChatOverlay;
  if (!app) return;

  switch (command) {
    case 'reset-settings':
      app.resetSettings();
      break;
    case 'reload-overlay':
      void app.restartRuntime();
      break;
  }
});
