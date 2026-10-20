// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Initialize the MAIN-world extension bridge without inline JavaScript.
 *
 * Firefox's ISOLATED content script cannot assign to the MAIN world's
 * `window`, so it places the packaged worker source on the external page-script
 * element. Chrome's native scripting path prepares the bridge separately.
 * This module runs before `src/main.ts` on either path.
 */

import { createPageWorkerBlobUrl, retainWorkerBlobUrlForDocument } from './worker-source-loader';

declare const __CHROME_NATIVE_BOOTSTRAP__: boolean;

if (typeof __CHROME_NATIVE_BOOTSTRAP__ !== 'undefined' && __CHROME_NATIVE_BOOTSTRAP__) {
  const bridge = window.__ytExtensionBridge;
  if (
    window.__ytExtensionBootstrapClaim !== true ||
    bridge?.storageType !== 'chrome.storage.local' ||
    typeof bridge.nonce !== 'string' ||
    bridge.nonce.length === 0
  ) {
    throw new Error('Native extension bridge is unavailable');
  }
} else {
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
}
