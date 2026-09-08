// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Initialize the MAIN-world extension bridge without inline JavaScript.
 *
 * The ISOLATED content script cannot assign to the MAIN world's `window`, and
 * MAIN-world code cannot access `chrome.*` APIs. It therefore places the
 * packaged worker source on the external page-script element. This module
 * runs before `src/main.ts` and creates a page-origin Blob URL so the native
 * Worker can load it from the YouTube document.
 */

import { createPageWorkerBlobUrl, retainWorkerBlobUrlForDocument } from './worker-source-loader';

const currentScript = document.currentScript;
const pageScript =
  currentScript instanceof HTMLScriptElement
    ? currentScript
    : document.querySelector<HTMLScriptElement>('script[data-yt-extension-bridge-nonce]');
const workerSource = pageScript?.dataset.ytExtensionWorkerSource;
const nonce = pageScript?.dataset.ytExtensionBridgeNonce;
let workerUrl: string | undefined;

if (workerSource !== undefined && nonce) {
  try {
    workerUrl = createPageWorkerBlobUrl(workerSource);
    retainWorkerBlobUrlForDocument(workerUrl);
  } catch {
    // Keep the authenticated storage/menu bridge and use main-thread rendering.
  }
}

if (nonce) {
  window.__ytExtensionBridge = {
    workerSupported: workerUrl !== undefined,
    ...(workerUrl === undefined ? {} : { workerUrl }),
    storageType: 'chrome.storage.local',
    nonce,
  };
  pageScript?.removeAttribute('data-yt-extension-worker-source');
  pageScript?.removeAttribute('data-yt-extension-worker-url');
  pageScript?.removeAttribute('data-yt-extension-bridge-nonce');
}
