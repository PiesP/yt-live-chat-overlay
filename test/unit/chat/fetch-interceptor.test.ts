// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { ChatMessage, OverlaySettings } from '@app-types';
import { createResponseIdentity, installFetchInterceptor } from '@chat/fetch-interceptor';
import { MAX_CHAT_RESPONSE_BYTES } from '@chat/youtube/response-text';
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
  const clone = {
    body: null,
    headers: new Headers(),
    text: async () => text,
  } as unknown as Response;
  return {
    clone: () => clone,
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

  it('ignores an oversized cloned response without affecting the original fetch', async () => {
    const cancel = vi.fn();
    const clone = {
      body: new ReadableStream<Uint8Array>({ cancel }),
      headers: new Headers({
        'content-length': String(MAX_CHAT_RESPONSE_BYTES + 1),
      }),
      text: vi.fn(),
    } as unknown as Response;
    const originalResponse = { clone: () => clone } as unknown as Response;
    window.fetch = vi.fn(async () => originalResponse);
    const onMessages = vi.fn();
    const restore = installFetchInterceptor(() => settings, onMessages);

    await expect(window.fetch(CHAT_URL)).resolves.toBe(originalResponse);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(mocks.getLiveChatPayload).not.toHaveBeenCalled();
    expect(onMessages).not.toHaveBeenCalled();
    restore();
  });

  it('bounds concurrent clone reads and skips excess matching responses', async () => {
    const bodies = Array.from({ length: 4 }, () => {
      let resolve!: (value: string) => void;
      const promise = new Promise<string>((next) => {
        resolve = next;
      });
      return { promise, resolve };
    });
    let activeReads = 0;
    let maxActiveReads = 0;
    const cloneSpies = bodies.map((body) =>
      vi.fn(() => ({
        body: null,
        headers: new Headers(),
        text: async () => {
          activeReads++;
          maxActiveReads = Math.max(maxActiveReads, activeReads);
          try {
            return await body.promise;
          } finally {
            activeReads--;
          }
        },
      }) as unknown as Response)
    );
    let responseIndex = 0;
    window.fetch = vi.fn(async () => {
      const clone = cloneSpies[responseIndex++];
      return { clone } as unknown as Response;
    });
    const restore = installFetchInterceptor(() => settings, vi.fn());

    await Promise.all([window.fetch(CHAT_URL), window.fetch(CHAT_URL), window.fetch(CHAT_URL)]);
    await flushInterceptor();
    expect(cloneSpies[0]).toHaveBeenCalledOnce();
    expect(cloneSpies[1]).toHaveBeenCalledOnce();
    expect(cloneSpies[2]).not.toHaveBeenCalled();
    expect(activeReads).toBe(2);
    expect(maxActiveReads).toBe(2);

    bodies[0]?.resolve(JSON.stringify({ continuationContents: {} }));
    bodies[1]?.resolve(JSON.stringify({ continuationContents: {} }));
    await vi.waitFor(() => expect(activeReads).toBe(0));

    await window.fetch(CHAT_URL);
    await flushInterceptor();
    expect(cloneSpies[3]).toHaveBeenCalledOnce();
    bodies[3]?.resolve(JSON.stringify({ continuationContents: {} }));
    await vi.waitFor(() => expect(activeReads).toBe(0));
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
