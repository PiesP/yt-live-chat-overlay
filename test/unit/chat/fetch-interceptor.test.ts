// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { ChatMessage, OverlaySettings } from '@app-types';
import { createResponseIdentity, installFetchInterceptor } from '@chat/fetch-interceptor';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  extractChatEvents: vi.fn(),
  getLiveChatPayload: vi.fn(),
}));

vi.mock('@chat/message-parser', () => ({
  extractChatEvents: mocks.extractChatEvents,
}));

vi.mock('@chat/youtube/api', () => ({
  getLiveChatPayload: mocks.getLiveChatPayload,
}));

const CHAT_URL = 'https://www.youtube.com/youtubei/v1/live_chat/get_live_chat';
const settings = {} as OverlaySettings;
const parsedMessage: ChatMessage = {
  id: 'intercepted',
  text: 'hello',
  content: [{ type: 'text', content: 'hello' }],
  kind: 'text',
  timestamp: 1,
  authorType: 'normal',
};

function responseWithText(text: string): Response {
  return {
    clone: () => ({ text: async () => text }),
  } as unknown as Response;
}

async function flushInterceptor(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('fetch interceptor response identities', () => {
  let originalFetch: typeof window.fetch;

  beforeEach(() => {
    originalFetch = window.fetch;
    mocks.getLiveChatPayload.mockReturnValue({ actions: [{}] });
    mocks.extractChatEvents.mockReturnValue([{ message: parsedMessage }]);
  });

  afterEach(() => {
    window.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it('creates stable compact identities without retaining response text', () => {
    const body = JSON.stringify({ secret: 'x'.repeat(10_000) });
    const identity = createResponseIdentity(body);

    expect(identity).toBe(createResponseIdentity(body));
    expect(identity).not.toContain('secret');
    expect(identity.length).toBeLessThan(64);
    expect(createResponseIdentity(`${body}!`)).not.toBe(identity);
  });

  it('parses identical response bodies only once per installation', async () => {
    const body = JSON.stringify({ continuationContents: {} });
    window.fetch = vi.fn(async () => responseWithText(body));
    const onMessages = vi.fn();
    const restore = installFetchInterceptor(() => settings, onMessages);

    await window.fetch(CHAT_URL);
    await window.fetch(CHAT_URL);
    await flushInterceptor();

    expect(mocks.getLiveChatPayload).toHaveBeenCalledOnce();
    expect(onMessages).toHaveBeenCalledOnce();
    restore();
  });

  it('ignores a late completion from a replaced interceptor without poisoning the new cache', async () => {
    let resolveOld!: (response: Response) => void;
    const oldResponse = new Promise<Response>((resolve) => {
      resolveOld = resolve;
    });
    const original = vi.fn(() => oldResponse);
    window.fetch = original;
    const oldMessages = vi.fn();
    installFetchInterceptor(() => settings, oldMessages);
    const pendingOldFetch = window.fetch(CHAT_URL);

    const body = JSON.stringify({ continuationContents: { liveChatContinuation: {} } });
    original.mockImplementation(async () => responseWithText(body));
    const newMessages = vi.fn();
    const restoreNew = installFetchInterceptor(() => settings, newMessages);

    resolveOld(responseWithText(body));
    await pendingOldFetch;
    await flushInterceptor();
    expect(oldMessages).not.toHaveBeenCalled();

    await window.fetch(CHAT_URL);
    await flushInterceptor();
    expect(newMessages).toHaveBeenCalledOnce();
    restoreNew();
  });

  it('ignores response work that completes after teardown', async () => {
    let resolveResponse!: (response: Response) => void;
    window.fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        })
    );
    const onMessages = vi.fn();
    const restore = installFetchInterceptor(() => settings, onMessages);
    const pendingFetch = window.fetch(CHAT_URL);

    restore();
    resolveResponse(responseWithText(JSON.stringify({ continuationContents: {} })));
    await pendingFetch;
    await flushInterceptor();

    expect(onMessages).not.toHaveBeenCalled();
    expect(mocks.getLiveChatPayload).not.toHaveBeenCalled();
  });
});
