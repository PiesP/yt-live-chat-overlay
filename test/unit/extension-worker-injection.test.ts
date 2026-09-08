// SPDX-License-Identifier: MIT
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

function stubChrome(): void {
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'test-extension',
      getURL: (path: string) => `chrome-extension://test-extension/${path}`,
      onMessage: { addListener: vi.fn() },
    },
    storage: {
      local: { get: vi.fn().mockResolvedValue({}), set: vi.fn().mockResolvedValue(undefined) },
      onChanged: { addListener: vi.fn() },
    },
  });
}

afterEach(() => {
  document
    .querySelectorAll('script[src^="chrome-extension://"]')
    .forEach((script) => script.remove());
  delete window.__ytExtensionBridge;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('extension worker injection lifecycle', () => {
  it('does not inject a late page script after permanent document teardown', async () => {
    stubChrome();
    let resolveFetch!: (response: Response) => void;
    const fetchPromise = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(fetchPromise));

    await import('../../extension/content-script');
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
    resolveFetch(new Response('self.postMessage({ type: "ready" });', { status: 200 }));
    await vi.waitFor(() => {
      expect(document.querySelector('script[src$="/page-script.js"]')).toBeNull();
    });
  });

  it('hands packaged source to MAIN world and retains its Blob through BFCache', async () => {
    const createObjectURL = vi.fn().mockReturnValue('blob:https://www.youtube.com/worker');
    const revokeObjectURL = vi.fn();
    class TestUrl extends URL {}
    Object.defineProperties(TestUrl, {
      createObjectURL: { value: createObjectURL },
      revokeObjectURL: { value: revokeObjectURL },
    });
    vi.stubGlobal('URL', TestUrl);
    const script = document.createElement('script');
    script.dataset.ytExtensionBridgeNonce = 'bridge-nonce';
    script.dataset.ytExtensionWorkerSource = 'self.postMessage({ type: "ready" });';
    document.head.appendChild(script);

    await import('../../extension/page-bridge');

    expect(window.__ytExtensionBridge).toEqual({
      nonce: 'bridge-nonce',
      storageType: 'chrome.storage.local',
      workerSupported: true,
      workerUrl: 'blob:https://www.youtube.com/worker',
    });
    expect(script.dataset.ytExtensionWorkerSource).toBeUndefined();
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    expect(revokeObjectURL).not.toHaveBeenCalled();
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:https://www.youtube.com/worker');
    script.remove();
  });

  it('keeps the authenticated storage bridge when worker preparation fails', async () => {
    stubChrome();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('packaged fetch failed')));
    await import('../../extension/content-script');
    const script = await vi.waitFor(() => {
      const injected = document.querySelector<HTMLScriptElement>('script[src$="/page-script.js"]');
      expect(injected).not.toBeNull();
      return injected;
    });
    if (!script) throw new Error('The page script was not injected');
    expect(script.dataset.ytExtensionWorkerSource).toBeUndefined();
    const nonce = script.dataset.ytExtensionBridgeNonce;

    await import('../../extension/page-bridge');

    expect(window.__ytExtensionBridge).toEqual({
      nonce,
      storageType: 'chrome.storage.local',
      workerSupported: false,
    });
    script.remove();
    delete window.__ytExtensionBridge;
  });
});
