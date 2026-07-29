// SPDX-License-Identifier: MIT
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkerUrl } from '@platform/worker-factory';

afterEach(() => {
  delete window.__ytExtensionBridge;
  vi.unstubAllGlobals();
});

describe('createWorkerUrl', () => {
  it('uses the authenticated extension bridge URL when available', () => {
    window.__ytExtensionBridge = {
      workerSupported: true,
      workerUrl: 'chrome-extension://trusted/workers/renderer.js',
      storageType: 'chrome.storage.local',
      nonce: 'test-nonce',
    };

    expect(createWorkerUrl()).toBe('chrome-extension://trusted/workers/renderer.js');
  });

  it('uses the fixed extension worker output path', () => {
    const getURL = vi.fn((path: string) => `chrome-extension://trusted/${path}`);
    vi.stubGlobal('chrome', { runtime: { getURL } });
    vi.stubGlobal('browser', undefined);

    expect(createWorkerUrl()).toBe('chrome-extension://trusted/workers/renderer.js');
    expect(getURL).toHaveBeenCalledWith('workers/renderer.js');
  });

  it('resolves the bundled fallback from the actual worker source directory', () => {
    vi.stubGlobal('chrome', undefined);
    vi.stubGlobal('browser', undefined);

    expect(String(createWorkerUrl())).toMatch(/\/src\/renderer\/worker\/renderer\.ts$/);
  });
});
