// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Extension Page Script — runs in the MAIN world, injected as an external
 * <script> tag by the ISOLATED-world content script.
 *
 * Has full access to the page's window (for app bootstrap) but NO access to
 * chrome.runtime. Menu commands are forwarded from the ISOLATED content script
 * via window.postMessage with strict origin validation.
 */

// Initialize the extension bridge before importing main.ts. Static imports are
// evaluated in dependency order, so the bridge is available while platform
// adapters are initialized. This is deliberately an external-bundle path;
// injecting inline JavaScript would violate YouTube's CSP.
import './page-bridge';

// Side-effect import: triggers application bootstrap in main.ts.
// Vite bundles this as a self-executing IIFE with no module syntax.
import '../src/main';

// ── Forwarded command listener ─────────────────────────────────────────

interface ContentScriptYtChatOverlayHandle {
  resetSettings(): void;
  restartRuntime(): Promise<void>;
}

const COMMAND_ORIGIN = window.location.origin;
const COMMAND_NONCE = window.__ytExtensionBridge?.nonce;

window.addEventListener('message', (event: MessageEvent) => {
  // Strict origin check: reject messages from any other origin.
  if (event.origin !== COMMAND_ORIGIN) return;

  const data = event.data;
  if (
    !data ||
    typeof data !== 'object' ||
    (data as Record<string, unknown>).source !== 'yt-chat-overlay-extension' ||
    !COMMAND_NONCE ||
    (data as Record<string, unknown>).nonce !== COMMAND_NONCE
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
      void app.restartRuntime().catch((error: unknown) => {
        console.error('[yt-chat-overlay] extension reload failed', error);
      });
      break;
  }
});
