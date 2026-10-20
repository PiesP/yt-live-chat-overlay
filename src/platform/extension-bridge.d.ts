// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Extension bridge — set in MAIN world before the application starts.
 *
 * In MV3 extensions, the MAIN world has no access to chrome.runtime or
 * chrome.storage. Chrome's native scripting initializes this object directly;
 * Firefox passes data through the external page-script element. Core adapters check
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
    /** MAIN-world one-shot claim, set before native page bundle injection. */
    __ytExtensionBootstrapClaim?: boolean;
  }
}

export type { ExtensionBridge };
