/// <reference path="../src/platform/chrome-types.d.ts" />

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Extension Background Service Worker (MV3).
 *
 * Responsibilities:
 * - Register context menu commands (equivalent to GM_registerMenuCommand)
 * - Forward menu clicks to the active tab's content script
 * - Bootstrap Chrome's page bundle in the sender's exact document
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

import { claimNativePageBootstrap } from './native-bootstrap';
import { loadPackagedWorkerSource } from './worker-source-loader';

declare const __CHROME_NATIVE_BOOTSTRAP__: boolean;

// Fail startup if the extension context lacks a required API.
const contextMenus = chrome?.contextMenus;
const runtime = chrome?.runtime;
const tabs = chrome?.tabs;
if (!contextMenus || !runtime || !tabs) throw new Error('Required extension APIs are unavailable');

interface NativeBootstrapRequest {
  type: 'native-page-bootstrap';
  nonce: string;
}

function isNativeBootstrapRequest(value: unknown): value is NativeBootstrapRequest {
  const nonce =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>).nonce
      : undefined;
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).type === 'native-page-bootstrap' &&
    typeof nonce === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nonce)
  );
}

function authenticatedDocument(
  sender: ChromeMessageSender
): { tabId: number; documentId: string } | undefined {
  if (!runtime.id || sender.id !== runtime.id || sender.frameId !== 0) return;
  if (sender.origin !== 'https://www.youtube.com' || !sender.url) return;
  try {
    const url = new URL(sender.url);
    if (url.protocol !== 'https:' || url.hostname !== 'www.youtube.com' || url.port) return;
  } catch {
    return;
  }
  const tabId = sender.tab?.id;
  const documentId = sender.documentId;
  if (!Number.isSafeInteger(tabId) || !tabId || tabId < 0) return;
  // Chromium serializes its document token as 32 hexadecimal characters.
  if (!documentId || !/^[0-9a-f]{32}$/i.test(documentId)) return;
  return { tabId, documentId };
}

if (typeof __CHROME_NATIVE_BOOTSTRAP__ !== 'undefined' && __CHROME_NATIVE_BOOTSTRAP__) {
  const scripting = chrome.scripting;
  const onMessage = runtime.onMessage;
  if (!scripting || !onMessage) throw new Error('Required Chrome scripting APIs are unavailable');

  onMessage.addListener((message, sender, sendResponse) => {
    if (!isNativeBootstrapRequest(message)) return;
    const targetDocument = authenticatedDocument(sender);
    if (!targetDocument) {
      sendResponse({ ok: false, reason: 'unauthorized-document' });
      return;
    }

    const { tabId, documentId } = targetDocument;
    const target = { tabId, documentIds: [documentId] };
    void (async () => {
      let workerSource: string | null = null;
      try {
        workerSource = await loadPackagedWorkerSource(runtime.getURL('workers/renderer.js'));
      } catch {
        // The bridge and app still start with main-thread renderer fallback.
      }

      const [claim] = await scripting.executeScript({
        target,
        world: 'MAIN',
        func: claimNativePageBootstrap,
        args: [message.nonce, workerSource],
      });
      if (claim?.documentId !== documentId || claim.frameId !== 0) {
        throw new Error('Native page bootstrap targeted a different document');
      }
      if (claim.result !== 'claimed') {
        sendResponse({ ok: false, reason: 'already-claimed' });
        return;
      }

      const [injection] = await scripting.executeScript({
        target,
        world: 'MAIN',
        files: ['page-script.js'],
      });
      if (injection?.documentId !== documentId || injection.frameId !== 0) {
        throw new Error('Native page bundle targeted a different document');
      }
      sendResponse({ ok: true });
    })().catch((error: unknown) => {
      sendResponse({
        ok: false,
        reason: error instanceof Error ? error.message : 'bootstrap-failed',
      });
    });
    return true;
  });
}

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
