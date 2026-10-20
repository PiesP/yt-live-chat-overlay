// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/** Maximum encoded bytes retained for one Worker image before decode. */
export const MAX_WORKER_IMAGE_BYTES = 4 * 1024 * 1024;

export class ImageResponseTooLargeError extends Error {
  constructor() {
    super('Image response exceeded the encoded-byte limit.');
    this.name = 'ImageResponseTooLargeError';
  }
}

/** Read a binary response within the limit before constructing a decoder input. */
export async function readBoundedImageBlob(response: Response, maxBytes: number): Promise<Blob> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError('maxBytes must be a positive safe integer.');
  }

  const length = response.headers.get('content-length');
  if (length !== null && /^\d+$/.test(length.trim())) {
    const declared = Number(length);
    if (Number.isSafeInteger(declared) && declared > maxBytes) {
      void response.body?.cancel().catch(() => {});
      throw new ImageResponseTooLargeError();
    }
  }

  // A blob() fallback would accumulate an unbounded response before admission.
  if (!response.body) throw new Error('Image response stream unavailable.');

  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (value.byteLength > maxBytes - totalBytes) {
        void reader.cancel().catch(() => {});
        throw new ImageResponseTooLargeError();
      }
      chunks.push(new Uint8Array(value));
      totalBytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  return new Blob(chunks, { type: response.headers.get('content-type') ?? '' });
}
