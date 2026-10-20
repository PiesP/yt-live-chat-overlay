// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { ImageResponseTooLargeError, readBoundedImageBlob } from '@media/bounded-image-response';
import { describe, expect, it, vi } from 'vite-plus/test';

function streamedResponse(chunks: number[][], headers?: HeadersInit): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
        controller.close();
      },
    }),
    headers === undefined ? undefined : { headers }
  );
}

describe('bounded Worker image response', () => {
  it('returns intact bytes and MIME type at the exact ceiling', async () => {
    const response = streamedResponse(
      [
        [1, 2],
        [3, 4],
      ],
      {
        'content-length': '4',
        'content-type': 'image/png',
      }
    );

    const blob = await readBoundedImageBlob(response, 4);

    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual([1, 2, 3, 4]);
    expect(blob.type).toBe('image/png');
  });

  it.each([
    ['missing', undefined],
    ['understated', '1'],
    ['invalid', 'not-a-number'],
  ])('rejects stream overflow with %s declared length', async (_label, length) => {
    const response = streamedResponse(
      [
        [1, 2],
        [3, 4],
      ],
      length === undefined ? undefined : { 'content-length': length }
    );

    await expect(readBoundedImageBlob(response, 3)).rejects.toBeInstanceOf(
      ImageResponseTooLargeError
    );
    expect(response.bodyUsed).toBe(true);
  });

  it('rejects a reported oversized body before reading', async () => {
    const response = new Response(new ReadableStream({ start() {} }), {
      headers: { 'content-length': '5' },
    });
    const getReader = vi.spyOn(response.body!, 'getReader');

    await expect(readBoundedImageBlob(response, 4)).rejects.toBeInstanceOf(
      ImageResponseTooLargeError
    );
    expect(getReader).not.toHaveBeenCalled();
  });

  it('rejects unavailable streams without using an unbounded blob fallback', async () => {
    const response = new Response(null);
    const blob = vi.spyOn(response, 'blob');

    await expect(readBoundedImageBlob(response, 4)).rejects.toThrow('stream unavailable');
    expect(blob).not.toHaveBeenCalled();
  });
});
