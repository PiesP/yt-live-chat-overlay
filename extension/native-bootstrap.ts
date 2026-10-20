// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Serialized by chrome.scripting into the page's MAIN world. Keep this function
 * self-contained: imports and closure variables are unavailable there.
 */
export function claimNativePageBootstrap(
  nonce: string,
  workerSource: string | null
): 'claimed' | 'already' {
  if (window.__ytExtensionBootstrapClaim) return 'already';
  window.__ytExtensionBootstrapClaim = true;

  let workerUrl: string | undefined;
  if (typeof workerSource === 'string') {
    try {
      workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
      const retainedUrl = workerUrl;
      const release = (event: PageTransitionEvent): void => {
        if (event.persisted) return;
        window.removeEventListener('pagehide', release);
        URL.revokeObjectURL(retainedUrl);
      };
      window.addEventListener('pagehide', release);
    } catch {
      // The authenticated bridge still works; rendering uses the main thread.
    }
  }

  window.__ytExtensionBridge = {
    workerSupported: workerUrl !== undefined,
    ...(workerUrl === undefined ? {} : { workerUrl }),
    storageType: 'chrome.storage.local',
    nonce,
  };
  return 'claimed';
}
