// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Initialize the MAIN-world extension bridge without inline JavaScript.
 *
 * The ISOLATED content script cannot assign to the MAIN world's `window`, and
 * MAIN-world code cannot access `chrome.*` APIs. It therefore places the
 * already-resolved worker URL on the external page-script element. This
 * module runs before `src/main.ts` and converts that attribute into the small
 * runtime bridge consumed by the platform adapters.
 */

const currentScript = document.currentScript;
const pageScript =
  currentScript instanceof HTMLScriptElement
    ? currentScript
    : document.querySelector<HTMLScriptElement>('script[data-yt-extension-worker-url]');
const workerUrl = pageScript?.dataset.ytExtensionWorkerUrl;

if (workerUrl) {
  window.__ytExtensionBridge = {
    workerSupported: true,
    workerUrl,
    storageType: 'chrome.storage.local',
  };
}

export {};
