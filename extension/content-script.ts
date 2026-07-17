// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Extension Content Script — runs in the ISOLATED world.
 *
 * Responsibilities:
 * 1. Inject the MAIN-world page script as a <script> element.
 * 2. Relay menu commands from the background service worker to the
 *    page script via window.postMessage (strict origin validation).
 *
 * ISOLATED world has full access to chrome.runtime APIs, unlike MAIN world
 * where chrome.runtime is undefined. The previous MAIN-world content script
 * used optional chaining (chrome?.runtime?.onMessage?.addListener?.()) which
 * silently failed — menu commands were never delivered.
 *
 * Non-null assertions (!) on chrome.runtime are safe: in ISOLATED world,
 * chrome is always defined. If it weren't, the content script would fail
 * to load entirely.
 */

// ── Inject page script ─────────────────────────────────────────────────

const pageScript = document.createElement('script');
// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
pageScript.src = chrome!.runtime!.getURL('page-script.js');
pageScript.type = 'text/javascript';
(document.head || document.documentElement).appendChild(pageScript);

// ── Background message relay ───────────────────────────────────────────

interface ChromeMessageSender {
  id?: string;
  url?: string;
  tab?: { id?: number };
}

const extRuntime = chrome!.runtime!;
const onMessage = extRuntime.onMessage!;

onMessage.addListener((message: unknown, sender: ChromeMessageSender) => {
  // Defense-in-depth: reject messages not from this extension.
  if (sender.id !== extRuntime.id) return;

  const msg = message as { type?: string; command?: string };
  if (msg.type !== 'menu-command') return;

  // Runtime type guard: only accept known command values.
  if (msg.command !== 'reset-settings' && msg.command !== 'reload-overlay') return;

  window.postMessage(
    {
      source: 'yt-chat-overlay-extension',
      command: msg.command,
    },
    window.location.origin,
  );
});
