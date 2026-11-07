import {
  ChatResponseTooLargeError,
  isResponseSizeError,
  readBoundedChatResponseText,
  ResponseTooLargeError,
} from '@chat/youtube/response-text';
import { describe, expect, it, vi } from 'vite-plus/test';

const NOT_SETTLED = Symbol('not-settled');

async function settleWithin<T>(promise: Promise<T>): Promise<T | typeof NOT_SETTLED> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof NOT_SETTLED>((resolve) => {
        timeout = setTimeout(() => resolve(NOT_SETTLED), 50);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

describe('readBoundedChatResponseText', () => {
  it('preserves the chat-specific error name and message contract', async () => {
    const response = new Response(null, { headers: { 'content-length': '11' } });

    const error = await readBoundedChatResponseText(response, 10).catch(
      (reason: unknown) => reason
    );

    expect(error).toBeInstanceOf(ChatResponseTooLargeError);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ResponseTooLargeError);
    expect(isResponseSizeError(error)).toBe(true);
    expect(error).toMatchObject({
      name: 'ChatResponseTooLargeError',
      message: 'Chat response exceeded 10 bytes.',
      observedBytes: 11,
      maxBytes: 10,
      responseLabel: 'Chat response',
      category: 'response-too-large',
    });
  });

  it('recognizes both response-size variants without accepting unrelated failures', () => {
    expect(isResponseSizeError(new ResponseTooLargeError(11, 10, 'Watch HTML'))).toBe(true);
    expect(isResponseSizeError(new ChatResponseTooLargeError(11, 10))).toBe(true);
    for (const error of [
      new Error('Response exceeded 10 bytes.'),
      new DOMException('aborted', 'AbortError'),
      Object.assign(new Error('tag only'), { category: 'response-too-large' }),
      {
        category: 'response-too-large',
        observedBytes: 11,
        maxBytes: 10,
        responseLabel: 'Response',
      },
    ]) {
      expect(isResponseSizeError(error)).toBe(false);
    }
  });

  it('rejects an oversized declared length and cancels the body', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const response = new Response(body, { headers: { 'content-length': '11' } });

    const error: unknown = await readBoundedChatResponseText(response, 10).catch(
      (reason: unknown) => reason
    );
    expect(error).toBeInstanceOf(ChatResponseTooLargeError);
    expect(isResponseSizeError(error)).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith(error);
  });

  it('rejects a cloned response with an oversized declared length while the original stays open', async () => {
    const original = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
        },
      }),
      { headers: { 'content-length': '11' } }
    );
    const clone = original.clone();
    const read = readBoundedChatResponseText(clone, 10).catch((reason: unknown) => reason);

    try {
      await expect(settleWithin(read)).resolves.toBeInstanceOf(ChatResponseTooLargeError);
      expect(original.bodyUsed).toBe(false);
      expect(clone.body?.locked).toBe(false);
    } finally {
      await original.body?.cancel();
      await read;
    }
  });

  it('cancels streamed input as soon as accumulated bytes exceed the limit', async () => {
    const cancel = vi.fn();
    let emitted = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted) return;
        emitted = true;
        controller.enqueue(new Uint8Array(6));
        controller.enqueue(new Uint8Array(5));
      },
      cancel,
    });

    const error: unknown = await readBoundedChatResponseText(new Response(body), 10).catch(
      (reason: unknown) => reason
    );
    expect(error).toBeInstanceOf(ChatResponseTooLargeError);
    expect(isResponseSizeError(error)).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith(error);
  });

  it('rejects a cloned streamed response over the limit while the original stays open', async () => {
    const original = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(6));
          controller.enqueue(new Uint8Array(5));
        },
      })
    );
    const clone = original.clone();
    const read = readBoundedChatResponseText(clone, 10).catch((reason: unknown) => reason);

    try {
      await expect(settleWithin(read)).resolves.toBeInstanceOf(ChatResponseTooLargeError);
      expect(original.bodyUsed).toBe(false);
      expect(clone.body?.locked).toBe(false);
    } finally {
      await original.body?.cancel();
      await read;
    }
  });

  it('accepts a response exactly at the byte limit', async () => {
    const text = '12345678';
    await expect(readBoundedChatResponseText(new Response(text), 8)).resolves.toBe(text);
  });

  it('falls back to text() when a response has no readable body', async () => {
    const text = vi.fn(async () => 'fallback');
    const response = {
      body: null,
      headers: new Headers(),
      text,
    } as unknown as Response;

    await expect(readBoundedChatResponseText(response, 8)).resolves.toBe('fallback');
    expect(text).toHaveBeenCalledOnce();
  });
});
