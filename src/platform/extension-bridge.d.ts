// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Extension bridge — set by the ISOLATED-world content script before
 * injecting the MAIN-world page script.
 *
 * In MV3 extensions, the MAIN world has no access to chrome.runtime or
 * chrome.storage. The ISOLATED content script resolves the worker URL and
 * places it on the external page-script element. The page bundle initializes
 * this object before the application starts. Core platform adapters check
 * this bridge first, falling back to GM_* / localStorage if absent.
 */
interface ExtensionBridge {
  /** Whether a page-origin worker Blob was prepared from the packaged bundle. */
  workerSupported: boolean;
  /** Page-origin Blob URL to the renderer worker bundle, when preparation succeeded. */
  workerUrl?: string;
  /** Storage backend type — signals that chrome.storage.local is preferred. */
  storageType: 'chrome.storage.local';
  /** Per-injection capability required by messages crossing the isolated-world boundary. */
  nonce: string;
}

declare global {
  interface Window {
    __ytExtensionBridge?: ExtensionBridge;
  }
}

export type { ExtensionBridge };
