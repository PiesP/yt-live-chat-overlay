// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Extension bridge — set by the ISOLATED-world content script before
 * injecting the MAIN-world page script.
 *
 * In MV3 extensions, the MAIN world has no access to chrome.runtime or
 * chrome.storage. The ISOLATED content script resolves these values at
 * injection time and bakes them into an inline <script> that runs in the
 * MAIN world. Core platform adapters check this bridge first, falling
 * back to GM_* / localStorage if absent.
 */
interface ExtensionBridge {
  /** Whether chrome.runtime.getURL is available (always true when bridge exists). */
  workerSupported: true;
  /** Absolute URL to the renderer worker bundle. */
  workerUrl: string;
  /** Storage backend type — signals that chrome.storage.local is preferred. */
  storageType: 'chrome.storage.local';
}

declare global {
  interface Window {
    __ytExtensionBridge?: ExtensionBridge;
  }
}

export type { ExtensionBridge };
