// SPDX-License-Identifier: MIT
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import { claimNativePageBootstrap } from '../../extension/native-bootstrap';

const nonce = '12345678-1234-1234-1234-123456789abc';
const documentId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

type MessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void
) => boolean | void;

const validSender = {
  id: 'test-extension',
  origin: 'https://www.youtube.com',
  url: 'https://www.youtube.com/watch?v=test',
  frameId: 0,
  tab: { id: 42 },
  documentId,
};

describe('Chrome native page bootstrap', () => {
  let listener: MessageListener;
  const executeScript = vi.fn();
  const send = (
    sender: unknown = validSender,
    message: unknown = { type: 'native-page-bootstrap', nonce }
  ) =>
    new Promise<unknown>((resolve) => {
      listener(message, sender, resolve);
    });

  beforeEach(async () => {
    vi.resetModules();
    vi.stubGlobal('__CHROME_NATIVE_BOOTSTRAP__', true);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('self.onmessage = () => {};')));
    executeScript.mockReset();
    vi.stubGlobal('chrome', {
      contextMenus: {
        removeAll: vi.fn(),
        create: vi.fn(),
        onClicked: { addListener: vi.fn() },
      },
      runtime: {
        id: 'test-extension',
        getURL: (path: string) => `chrome-extension://test-extension/${path}`,
        onInstalled: { addListener: vi.fn() },
        onMessage: {
          addListener: (callback: MessageListener) => {
            listener = callback;
          },
        },
      },
      tabs: { sendMessage: vi.fn() },
      scripting: { executeScript },
    });
    await import('../../extension/background');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete window.__ytExtensionBootstrapClaim;
    delete window.__ytExtensionBridge;
  });

  it('claims and injects only the authenticated top-level document', async () => {
    executeScript
      .mockResolvedValueOnce([{ documentId, frameId: 0, result: 'claimed' }])
      .mockResolvedValueOnce([{ documentId, frameId: 0 }]);

    expect(await send()).toEqual({ ok: true });
    expect(executeScript).toHaveBeenCalledTimes(2);
    expect(executeScript.mock.calls[0]?.[0]).toMatchObject({
      target: { tabId: 42, documentIds: [documentId] },
      world: 'MAIN',
      args: [nonce, 'self.onmessage = () => {};'],
    });
    expect(executeScript.mock.calls[1]?.[0]).toEqual({
      target: { tabId: 42, documentIds: [documentId] },
      world: 'MAIN',
      files: ['page-script.js'],
    });
  });

  it.each([
    { ...validSender, id: 'other-extension' },
    { ...validSender, origin: 'https://evil.example' },
    { ...validSender, url: 'https://evil.example/watch' },
    { ...validSender, frameId: 1 },
    { ...validSender, documentId: undefined },
    { ...validSender, tab: {} },
  ])('rejects unauthenticated documents before native injection', async (sender) => {
    expect(await send(sender)).toEqual({ ok: false, reason: 'unauthorized-document' });
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('does not execute the page bundle for an already claimed document', async () => {
    executeScript.mockResolvedValueOnce([{ documentId, frameId: 0, result: 'already' }]);
    expect(await send()).toEqual({ ok: false, reason: 'already-claimed' });
    expect(executeScript).toHaveBeenCalledTimes(1);
  });

  it('rejects a mismatched result before injecting the page bundle', async () => {
    executeScript.mockResolvedValueOnce([
      { documentId: crypto.randomUUID(), frameId: 0, result: 'claimed' },
    ]);
    expect(await send()).toEqual({
      ok: false,
      reason: 'Native page bootstrap targeted a different document',
    });
    expect(executeScript).toHaveBeenCalledTimes(1);
  });

  it('still injects the bridge and bundle when the worker cannot be fetched', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('fetch failed'));
    executeScript
      .mockResolvedValueOnce([{ documentId, frameId: 0, result: 'claimed' }])
      .mockResolvedValueOnce([{ documentId, frameId: 0 }]);
    expect(await send()).toEqual({ ok: true });
    const args = executeScript.mock.calls[0]?.[0].args;
    expect(args).toEqual([nonce, null]);
    expect(JSON.parse(JSON.stringify(args))).toEqual(args);
  });
});

describe('MAIN-world one-shot claim and worker lifetime', () => {
  afterEach(() => {
    delete window.__ytExtensionBootstrapClaim;
    delete window.__ytExtensionBridge;
    vi.restoreAllMocks();
  });

  it('keeps the worker through BFCache and prevents duplicate app injection', () => {
    const createObjectURL = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:https://www.youtube.com/worker');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    expect(claimNativePageBootstrap(nonce, 'worker source')).toBe('claimed');
    expect(window.__ytExtensionBridge).toMatchObject({
      nonce,
      workerSupported: true,
      workerUrl: 'blob:https://www.youtube.com/worker',
    });
    expect(claimNativePageBootstrap(crypto.randomUUID(), null)).toBe('already');
    expect(createObjectURL).toHaveBeenCalledOnce();
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    expect(revokeObjectURL).not.toHaveBeenCalled();
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:https://www.youtube.com/worker');
  });

  it('keeps main-thread rendering when the worker source is absent', () => {
    expect(claimNativePageBootstrap(nonce, null)).toBe('claimed');
    expect(window.__ytExtensionBridge).toEqual({
      nonce,
      workerSupported: false,
      storageType: 'chrome.storage.local',
    });
  });
});

describe('Chrome isolated-world entry', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('requests native bootstrap without exposing its nonce in a DOM script element', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('__CHROME_NATIVE_BOOTSTRAP__', true);
    vi.stubGlobal('chrome', {
      runtime: {
        getURL: (path: string) => `chrome-extension://test-extension/${path}`,
        onMessage: { addListener: vi.fn() },
        sendMessage,
      },
      storage: {
        local: { get: vi.fn(), set: vi.fn() },
        onChanged: { addListener: vi.fn() },
      },
    });

    await import('../../extension/content-script');
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith({
      type: 'native-page-bootstrap',
      nonce: expect.any(String),
    });
    expect(document.querySelector('script[data-yt-extension-bridge-nonce]')).toBeNull();
  });
});
