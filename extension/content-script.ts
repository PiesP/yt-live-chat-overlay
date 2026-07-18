// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Extension Content Script — runs in the ISOLATED world.
 *
 * Responsibilities:
 * 1. Inject the MAIN-world page script as an external <script> element.
 * 2. Relay menu commands from the background service worker to the
 *    page script via window.postMessage (strict origin validation).
 * 3. Relay chrome.storage.local requests from the MAIN-world page script
 *    (which cannot access chrome.* APIs directly in MV3).
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

const cr = (chrome as ChromeNamespace).runtime!;

const workerBundleUrl = cr.getURL('workers/renderer.js');
// ── Inject page script ─────────────────────────────────────────────────
//
// Do not use script.textContent here. YouTube's CSP blocks inline script
// execution, even when the element was created by an extension content script.
// The page script reads these non-secret values from its own data attributes
// before the application bundle is initialized.

const pageScript = document.createElement('script');
// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
pageScript.src = cr.getURL('page-script.js');
pageScript.type = 'text/javascript';
pageScript.dataset.ytExtensionWorkerUrl = workerBundleUrl;
(document.head || document.documentElement).appendChild(pageScript);

// ── Storage relay (MAIN world → ISOLATED → chrome.storage.local) ─────
// MAIN-world page script posts { source: 'yt-storage-relay', ... } when
// the bridge indicates extension context. We forward to chrome.storage.local
// and post the response back via window.postMessage.
//
// Only explicitly allowed keys are accepted — same-origin scripts on the
// YouTube page (ads, other extensions' content scripts) could otherwise
// read or overwrite arbitrary chrome.storage.local keys.

const ALLOWED_STORAGE_KEYS = new Set([
  'yt-live-chat-overlay-settings',
]);

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return;

  const data = event.data;
  if (!data || data.source !== 'yt-storage-relay') return;
  if (event.origin !== window.location.origin) return;

  const requestId = data.requestId as number;
  const method = data.method as string;
  const key = data.key as string;

  // Reject keys outside the allowlist — same-origin scripts could
  // otherwise read/write arbitrary extension storage via postMessage.
  if (!ALLOWED_STORAGE_KEYS.has(key)) {
    window.postMessage(
      {
        source: 'yt-storage-relay-response',
        requestId,
        error: `Key "${key}" is not in the storage relay allowlist`,
      },
      window.location.origin,
    );
    return;
  }

  if (method === 'get') {
    chrome!.storage!.local!.get(key)
      .then((result) => {
        const value = result?.[key];
        window.postMessage(
          {
            source: 'yt-storage-relay-response',
            requestId,
            value: value === undefined || value === null
              ? null
              : typeof value === 'string' ? value : JSON.stringify(value),
          },
          window.location.origin,
        );
      })
      .catch((error: Error) => {
        window.postMessage(
          { source: 'yt-storage-relay-response', requestId, error: error.message },
          window.location.origin,
        );
      });
  } else if (method === 'set') {
    const value = data.value as string;
    chrome!.storage!.local!.set({ [key]: value })
      .then(() => {
        window.postMessage(
          { source: 'yt-storage-relay-response', requestId, value: null },
          window.location.origin,
        );
      })
      .catch((error: Error) => {
        window.postMessage(
          { source: 'yt-storage-relay-response', requestId, error: error.message },
          window.location.origin,
        );
      });
  }
});

// ── Storage-change relay (ISOLATED → MAIN world) ────────────────────
// In MV3 extensions, chrome.storage.onChanged fires only in ISOLATED world.
// MAIN-world scripts (page-script.ts) cannot listen for it directly.
// We relay change events to MAIN world via window.postMessage so that
// cross-tab settings sync works in extension context.
chrome!.storage!.onChanged!.addListener(
  (changes: Record<string, unknown>, areaName: string) => {
    if (areaName !== 'local') return;
    for (const key of Object.keys(changes)) {
      if (!ALLOWED_STORAGE_KEYS.has(key)) continue;
      const change = changes[key] as { newValue?: unknown } | undefined;
      if (!change) continue;
      window.postMessage(
        {
          source: 'yt-storage-changed',
          key,
          newValue: change.newValue,
        },
        window.location.origin,
      );
    }
  },
);

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
