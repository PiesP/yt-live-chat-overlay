import { describe, expect, it, vi } from 'vitest';
import {
  ChatResponseTooLargeError,
  readBoundedChatResponseText,
} from '@chat/youtube/response-text';

describe('readBoundedChatResponseText', () => {
  it('preserves the chat-specific error name and message contract', async () => {
    const response = new Response(null, { headers: { 'content-length': '11' } });

    const error = await readBoundedChatResponseText(response, 10).catch(
      (reason: unknown) => reason
    );

    expect(error).toBeInstanceOf(ChatResponseTooLargeError);
    expect(error).toMatchObject({
      name: 'ChatResponseTooLargeError',
      message: 'Chat response exceeded 10 bytes.',
    });
  });

  it('rejects an oversized declared length and cancels the body', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const response = new Response(body, { headers: { 'content-length': '11' } });

    await expect(readBoundedChatResponseText(response, 10)).rejects.toBeInstanceOf(
      ChatResponseTooLargeError
    );
    expect(cancel).toHaveBeenCalledOnce();
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

    await expect(
      readBoundedChatResponseText(new Response(body), 10)
    ).rejects.toBeInstanceOf(ChatResponseTooLargeError);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('accepts a response exactly at the byte limit', async () => {
    const text = '12345678';
    await expect(
      readBoundedChatResponseText(new Response(text), 8)
    ).resolves.toBe(text);
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
