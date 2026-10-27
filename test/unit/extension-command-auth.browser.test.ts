// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { OwnedWindowListeners } from '../owned-window-listeners';

vi.mock('../../src/main', () => ({}));

function loadPageScript(): Promise<unknown> {
  return import(/* @vite-ignore */ `/extension/page-script.ts?browser-test=${crypto.randomUUID()}`);
}

describe('extension command bridge authentication', () => {
  const ownedWindowListeners = new OwnedWindowListeners();

  afterEach(() => {
    ownedWindowListeners.dispose();
    delete window.__ytExtensionBridge;
    Reflect.deleteProperty(window, '__ytChatOverlay');
  });

  it('ignores reset commands that do not carry the bridge nonce', async () => {
    const resetSettings = vi.fn();
    window.__ytExtensionBridge = {
      workerSupported: true,
      workerUrl: 'chrome-extension://test/workers/renderer.js',
      storageType: 'chrome.storage.local',
      nonce: 'test-bridge-nonce',
    };
    Object.defineProperty(window, '__ytChatOverlay', {
      configurable: true,
      value: { resetSettings, restartRuntime: vi.fn() },
    });
    await ownedWindowListeners.load(loadPageScript);
    expect(ownedWindowListeners.size).toBe(1);

    const foreignFrame = document.createElement('iframe');
    document.body.appendChild(foreignFrame);
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        source: foreignFrame.contentWindow,
        data: {
          source: 'yt-chat-overlay-extension',
          nonce: 'test-bridge-nonce',
          command: 'reset-settings',
        },
      })
    );
    expect(resetSettings).not.toHaveBeenCalled();

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        source: window,
        data: { source: 'yt-chat-overlay-extension', command: 'reset-settings' },
      })
    );
    expect(resetSettings).not.toHaveBeenCalled();

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        source: window,
        data: {
          source: 'yt-chat-overlay-extension',
          nonce: 'test-bridge-nonce',
          command: 'reset-settings',
        },
      })
    );
    expect(resetSettings).toHaveBeenCalledOnce();
  });
});
