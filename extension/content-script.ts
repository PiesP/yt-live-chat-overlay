// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Extension Content Script — runs in the ISOLATED world.
 *
 * Responsibilities:
 * 1. Request native Chrome MAIN-world injection, or inject Firefox's external script.
 * 2. Relay menu commands from the background service worker to the
 *    page script via window.postMessage (strict origin validation).
 * 3. Relay chrome.storage.local requests from the MAIN-world page script
 *    (which cannot access chrome.* APIs directly in MV3).
 *
 * ISOLATED world has full access to chrome.runtime APIs, unlike MAIN world
 * where chrome.runtime is undefined. A previous MAIN-world content script
 * used optional chaining (chrome?.runtime?.onMessage?.addListener?.()) which
 * silently failed — menu commands were never delivered.
 *
 * Validate the required isolated-world APIs at startup so missing APIs fail
 * explicitly instead of silently dropping a required relay operation.
 */

import { createLogger } from '@util/logging';

import { loadPackagedWorkerSource } from './worker-source-loader';

declare const __CHROME_NATIVE_BOOTSTRAP__: boolean;

const cr = chrome?.runtime;
const storage = chrome?.storage;
const localStorage = storage?.local;
const storageChanged = storage?.onChanged;
const onMessage = cr?.onMessage;
if (!cr || !localStorage || !storageChanged || !onMessage) {
  throw new Error('Required extension relay APIs are unavailable');
}

const bridgeNonce = crypto.randomUUID();
// ── Bootstrap page script ───────────────────────────────────────────────

if (typeof __CHROME_NATIVE_BOOTSTRAP__ !== 'undefined' && __CHROME_NATIVE_BOOTSTRAP__) {
  // Chrome performs both MAIN-world steps through the scripting API in the
  // exact originating document. The nonce never enters a page DOM attribute.
  void cr
    .sendMessage({ type: 'native-page-bootstrap', nonce: bridgeNonce })
    .then((response) => {
      if ((response as { ok?: boolean } | undefined)?.ok !== true) {
        throw new Error('Native page bootstrap failed');
      }
    })
    .catch((error: unknown) => {
      createLogger('ExtensionContent').error('Native page bootstrap failed', error);
    });
} else {
  // Firefox uses an external script element. Read only fixed packaged worker
  // source in ISOLATED world; the page script creates its page-origin Blob.
  const workerPreparationController = new AbortController();
  let documentPermanentlyHidden = false;
  const handlePageHideBeforeInjection = (event: PageTransitionEvent): void => {
    if (event.persisted) return;
    documentPermanentlyHidden = true;
    workerPreparationController.abort();
    window.removeEventListener('pagehide', handlePageHideBeforeInjection);
  };
  window.addEventListener('pagehide', handlePageHideBeforeInjection);

  async function injectPageScript(): Promise<void> {
    let workerSource: string | undefined;
    try {
      workerSource = await loadPackagedWorkerSource(cr.getURL('workers/renderer.js'), {
        signal: workerPreparationController.signal,
      });
    } catch {
      // The storage/menu bridge remains available; the renderer uses main-thread fallback.
    }

    if (documentPermanentlyHidden) return;
    window.removeEventListener('pagehide', handlePageHideBeforeInjection);

    const pageScript = document.createElement('script');
    pageScript.src = cr.getURL('page-script.js');
    pageScript.type = 'text/javascript';
    if (workerSource !== undefined) pageScript.dataset.ytExtensionWorkerSource = workerSource;
    pageScript.dataset.ytExtensionBridgeNonce = bridgeNonce;
    (document.head || document.documentElement).appendChild(pageScript);
  }

  void injectPageScript();
}

// ── Storage relay (MAIN world → ISOLATED → chrome.storage.local) ─────
// MAIN-world page script posts { source: 'yt-storage-relay', ... } when
// the bridge indicates extension context. We forward to chrome.storage.local
// and post the response back via window.postMessage.
//
// Only explicitly allowed keys are accepted — same-origin scripts on the
// YouTube page (ads, other extensions' content scripts) could otherwise
// read or overwrite arbitrary chrome.storage.local keys.

const ALLOWED_STORAGE_KEYS = new Set(['yt-live-chat-overlay-settings']);

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return;

  const data = event.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  if (data.source !== 'yt-storage-relay') return;
  if (event.origin !== window.location.origin) return;
  if (data.nonce !== bridgeNonce) return;

  const { requestId, method, key } = data;
  if (!Number.isSafeInteger(requestId) || requestId < 0) return;
  if (method !== 'get' && method !== 'set') return;
  if (typeof key !== 'string') return;
  if (method === 'set' && typeof data.value !== 'string') return;

  // Reject keys outside the allowlist — same-origin scripts could
  // otherwise read/write arbitrary extension storage via postMessage.
  if (!ALLOWED_STORAGE_KEYS.has(key)) {
    window.postMessage(
      {
        source: 'yt-storage-relay-response',
        nonce: bridgeNonce,
        requestId,
        error: `Key "${key}" is not in the storage relay allowlist`,
      },
      window.location.origin
    );
    return;
  }

  if (method === 'get') {
    localStorage
      .get(key)
      .then((result) => {
        const value = result?.[key];
        window.postMessage(
          {
            source: 'yt-storage-relay-response',
            nonce: bridgeNonce,
            requestId,
            value:
              value === undefined || value === null
                ? null
                : typeof value === 'string'
                  ? value
                  : JSON.stringify(value),
          },
          window.location.origin
        );
      })
      .catch((error: Error) => {
        window.postMessage(
          {
            source: 'yt-storage-relay-response',
            nonce: bridgeNonce,
            requestId,
            error: error.message,
          },
          window.location.origin
        );
      });
  } else if (method === 'set') {
    const value = data.value;
    localStorage
      .set({ [key]: value })
      .then(() => {
        window.postMessage(
          { source: 'yt-storage-relay-response', nonce: bridgeNonce, requestId, value: null },
          window.location.origin
        );
      })
      .catch((error: Error) => {
        window.postMessage(
          {
            source: 'yt-storage-relay-response',
            nonce: bridgeNonce,
            requestId,
            error: error.message,
          },
          window.location.origin
        );
      });
  }
});

// ── Storage-change relay (ISOLATED → MAIN world) ────────────────────
// In MV3 extensions, chrome.storage.onChanged fires only in ISOLATED world.
// MAIN-world scripts (page-script.ts) cannot listen for it directly.
// We relay change events to MAIN world via window.postMessage so that
// cross-tab settings sync works in extension context.
storageChanged.addListener((changes: Record<string, unknown>, areaName: string) => {
  if (areaName !== 'local') return;
  for (const key of Object.keys(changes)) {
    if (!ALLOWED_STORAGE_KEYS.has(key)) continue;
    const change = changes[key] as { newValue?: unknown } | undefined;
    if (!change) continue;
    window.postMessage(
      {
        source: 'yt-storage-changed',
        nonce: bridgeNonce,
        key,
        newValue: change.newValue,
      },
      window.location.origin
    );
  }
});

// ── Background message relay ───────────────────────────────────────────

interface ChromeMessageSender {
  id?: string;
  url?: string;
  tab?: { id?: number };
}

const extRuntime = cr;

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
      nonce: bridgeNonce,
      command: msg.command,
    },
    window.location.origin
  );
});
