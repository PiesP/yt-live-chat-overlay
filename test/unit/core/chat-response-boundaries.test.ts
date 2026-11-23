// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { MAX_WATCH_HTML_BYTES } from '@chat/youtube/api';
import {
  MAX_CHAT_RESPONSE_BYTES,
  ChatResponseTooLargeError,
  isResponseSizeError,
  readBoundedChatResponseText,
  readBoundedResponseText,
  ResponseTooLargeError,
} from '@chat/youtube/response-text';
import { describe, expect, it, vi } from 'vite-plus/test';

describe.each([
  {
    name: 'chat',
    limit: MAX_CHAT_RESPONSE_BYTES,
    read: (response: Response) => readBoundedChatResponseText(response),
  },
  {
    name: 'watch HTML',
    limit: MAX_WATCH_HTML_BYTES,
    read: (response: Response) => readBoundedResponseText(response, MAX_WATCH_HTML_BYTES),
  },
])('$name production byte boundaries', ({ name, limit, read }) => {
  it.each([-1, 0, 1])(
    'checks actual bytes at limit%+i with misleading or absent length',
    async (delta) => {
      for (const declared of [undefined, '1', 'invalid']) {
        const cancel = vi.fn();
        let part = 0;
        const first = new Uint8Array(limit - 1).fill(65);
        const tail = new Uint8Array(delta + 1).fill(66);
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            const next = [first, new Uint8Array(), tail][part++];
            if (next) controller.enqueue(next);
            else controller.close();
          },
          cancel,
        });
        const response = new Response(body, {
          headers: declared === undefined ? {} : { 'content-length': declared },
        });
        if (delta > 0) {
          const error: unknown = await read(response).catch((reason: unknown) => reason);
          expect(isResponseSizeError(error)).toBe(true);
          expect(error).toBeInstanceOf(
            name === 'chat' ? ChatResponseTooLargeError : ResponseTooLargeError
          );
          expect(error).toMatchObject({ observedBytes: limit + delta, maxBytes: limit });
          expect(cancel).toHaveBeenCalledOnce();
        } else {
          const text = await read(response);
          expect(text.length).toBe(limit + delta);
          expect(text.startsWith('A')).toBe(true);
          expect(cancel).not.toHaveBeenCalled();
        }
        expect(body.locked).toBe(false);
        await expect(read(new Response('healthy'))).resolves.toBe('healthy');
      }
    }
  );
});

describe('UTF-8 accounting and the no-body compatibility path', () => {
  const text = '가😀';

  function streamedResponse(chunks: Uint8Array<ArrayBuffer>[]): Response {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      })
    );
  }

  it('preserves split multibyte sequences and ignores empty stream chunks', async () => {
    const bytes = new TextEncoder().encode(text);
    const response = streamedResponse([
      bytes.subarray(0, 1),
      new Uint8Array(),
      bytes.subarray(1, 5),
      bytes.subarray(5),
    ]);
    await expect(readBoundedChatResponseText(response, 7)).resolves.toBe(text);
    await expect(readBoundedChatResponseText(new Response(text), 6)).rejects.toMatchObject({
      observedBytes: 7,
      maxBytes: 6,
    });
  });

  it('decodes only the exact view of a single nonempty chunk', async () => {
    const bytes = new TextEncoder().encode('x가😀x').subarray(1, -1);
    const decode = vi.spyOn(TextDecoder.prototype, 'decode');
    try {
      const response = streamedResponse([new Uint8Array(), bytes, new Uint8Array()]);
      await expect(readBoundedChatResponseText(response, bytes.byteLength)).resolves.toBe(text);
      expect(decode.mock.calls).toHaveLength(1);
      expect(decode.mock.calls[0]?.[0]).toBe(bytes);
      expect(response.body?.locked).toBe(false);
    } finally {
      decode.mockRestore();
    }
  });

  it('matches one-shot decoding of a split BOM and malformed final UTF-8', async () => {
    const chunks = [
      new Uint8Array([0xef]),
      new Uint8Array([0xbb, 0xbf, 0x41, 0xf0]),
      new Uint8Array([0x9f, 0x98, 0x80, 0xff, 0xe2, 0x82]),
    ];
    await expect(readBoundedChatResponseText(streamedResponse(chunks), 11)).resolves.toBe('A😀��');
    await expect(
      readBoundedChatResponseText(streamedResponse([new Uint8Array()]), 1)
    ).resolves.toBe('');
  });

  it('rejects an overflowing chunk before handing it to the decoder', async () => {
    const chunks = [new Uint8Array([0x41]), new Uint8Array([0x42]), new Uint8Array([0x43])];
    const decode = vi.spyOn(TextDecoder.prototype, 'decode');
    try {
      const response = streamedResponse(chunks);
      await expect(readBoundedChatResponseText(response, 2)).rejects.toMatchObject({
        observedBytes: 3,
        maxBytes: 2,
        responseLabel: 'Chat response',
      });
      expect(decode.mock.calls).toEqual([
        [chunks[0], { stream: true }],
        [chunks[1], { stream: true }],
      ]);
      expect(response.body?.locked).toBe(false);
    } finally {
      decode.mockRestore();
    }
  });

  it('preserves the identity of a stream read failure and unlocks the body', async () => {
    const failure = new Error('body failed');
    let reads = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads++ < 2) {
          controller.enqueue(new Uint8Array([0x41]));
        } else {
          controller.error(failure);
        }
      },
    });
    const response = new Response(stream);
    await expect(readBoundedChatResponseText(response, 2)).rejects.toBe(failure);
    expect(stream.locked).toBe(false);
  });

  it('checks UTF-8 bytes only after text materializes without a body', async () => {
    const materialized = vi.fn(async () => text);
    const response = {
      body: null,
      headers: new Headers(),
      text: materialized,
    } as unknown as Response;

    await expect(readBoundedChatResponseText(response, 6)).rejects.toMatchObject({
      observedBytes: 7,
      maxBytes: 6,
    });
    expect(materialized).toHaveBeenCalledOnce();
    await expect(readBoundedChatResponseText(response, 7)).resolves.toBe(text);
    expect(materialized).toHaveBeenCalledTimes(2);
  });
});
