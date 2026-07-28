// SPDX-License-Identifier: MIT
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('extension storage bridge authentication', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.querySelectorAll('script[src^="chrome-extension://"]').forEach((script) => script.remove());
    vi.resetModules();
  });

  it('rejects storage relay requests without the per-injection nonce', async () => {
    const storageSet = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'test-extension',
        getURL: (path: string) => `chrome-extension://test-extension/${path}`,
        onMessage: { addListener: vi.fn() },
      },
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({}),
          set: storageSet,
        },
        onChanged: { addListener: vi.fn() },
      },
    });

    await import('../../extension/content-script');

    const injectedScript = document.querySelector<HTMLScriptElement>(
      'script[src$="/page-script.js"]'
    );
    const nonce = injectedScript?.dataset.ytExtensionBridgeNonce;
    expect(nonce).toEqual(expect.any(String));

    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: {
          source: 'yt-storage-relay',
          requestId: 1,
          method: 'set',
          key: 'yt-live-chat-overlay-settings',
          value: '{}',
        },
      })
    );
    await Promise.resolve();
    expect(storageSet).not.toHaveBeenCalled();

    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: {
          source: 'yt-storage-relay',
          nonce,
          requestId: 2,
          method: 'set',
          key: 'yt-live-chat-overlay-settings',
          value: '{}',
        },
      })
    );
    await vi.waitFor(() => expect(storageSet).toHaveBeenCalledWith({
      'yt-live-chat-overlay-settings': '{}',
    }));
  });
});
