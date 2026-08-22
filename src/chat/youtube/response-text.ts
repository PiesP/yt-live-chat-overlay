// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/** Hard cap for a single YouTube live-chat response body. */
export const MAX_CHAT_RESPONSE_BYTES = 8 * 1024 * 1024;

export class ChatResponseTooLargeError extends Error {
  constructor(
    readonly observedBytes: number,
    readonly maxBytes: number
  ) {
    super(`Chat response exceeded ${maxBytes} bytes.`);
    this.name = 'ChatResponseTooLargeError';
  }
}

function parseDeclaredLength(response: Response): number | null {
  const value = response.headers.get('content-length');
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function cancelBody(response: Response, error: ChatResponseTooLargeError): Promise<void> {
  try {
    await response.body?.cancel(error);
  } catch {
    // Cancellation is best-effort when a platform stream is already closed.
  }
}

/** Read a response as UTF-8 while enforcing a byte limit before materialization. */
export async function readBoundedChatResponseText(
  response: Response,
  maxBytes = MAX_CHAT_RESPONSE_BYTES
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError('maxBytes must be a positive safe integer.');
  }

  const declaredLength = parseDeclaredLength(response);
  if (declaredLength !== null && declaredLength > maxBytes) {
    const error = new ChatResponseTooLargeError(declaredLength, maxBytes);
    await cancelBody(response, error);
    throw error;
  }

  if (!response.body) {
    const text = await response.text();
    const observedBytes = new TextEncoder().encode(text).byteLength;
    if (observedBytes > maxBytes) {
      throw new ChatResponseTooLargeError(observedBytes, maxBytes);
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      const nextTotal = totalBytes + value.byteLength;
      if (!Number.isSafeInteger(nextTotal) || nextTotal > maxBytes) {
        const error = new ChatResponseTooLargeError(nextTotal, maxBytes);
        try {
          await reader.cancel(error);
        } catch {
          // Cancellation is best-effort when a platform stream already failed.
        }
        throw error;
      }
      chunks.push(value);
      totalBytes = nextTotal;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
