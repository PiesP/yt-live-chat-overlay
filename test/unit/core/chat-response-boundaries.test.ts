// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { MAX_WATCH_HTML_BYTES } from '@chat/youtube/api';
import {
  MAX_CHAT_RESPONSE_BYTES,
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
])('$name production byte boundaries', ({ limit, read }) => {
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
          await expect(read(response)).rejects.toBeInstanceOf(ResponseTooLargeError);
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

  it('preserves split multibyte sequences and ignores empty stream chunks', async () => {
    const bytes = new TextEncoder().encode(text);
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, 1));
          controller.enqueue(new Uint8Array());
          controller.enqueue(bytes.slice(1, 5));
          controller.enqueue(bytes.slice(5));
          controller.close();
        },
      })
    );
    await expect(readBoundedChatResponseText(response, 7)).resolves.toBe(text);
    await expect(readBoundedChatResponseText(new Response(text), 6)).rejects.toMatchObject({
      observedBytes: 7,
      maxBytes: 6,
    });
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
