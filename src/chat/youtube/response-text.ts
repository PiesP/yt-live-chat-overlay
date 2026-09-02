// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/** Hard cap for a single YouTube live-chat response body. */
export const MAX_CHAT_RESPONSE_BYTES = 8 * 1024 * 1024;

export class ResponseTooLargeError extends Error {
  constructor(
    readonly observedBytes: number,
    readonly maxBytes: number,
    readonly responseLabel = 'Response'
  ) {
    super(`${responseLabel} exceeded ${maxBytes} bytes.`);
    this.name = 'ResponseTooLargeError';
  }
}

/** Stable live-chat-specific error contract retained for existing callers. */
export class ChatResponseTooLargeError extends ResponseTooLargeError {
  constructor(observedBytes: number, maxBytes: number) {
    super(observedBytes, maxBytes, 'Chat response');
    this.name = 'ChatResponseTooLargeError';
  }
}

function parseDeclaredLength(response: Response): number | null {
  const value = response.headers.get('content-length');
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function cancelBody(response: Response, error: ResponseTooLargeError): Promise<void> {
  try {
    await response.body?.cancel(error);
  } catch {
    // Cancellation is best-effort when a platform stream is already closed.
  }
}

/** Read a response as UTF-8 while enforcing a byte limit before materialization. */
export async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
  responseLabel = 'Response'
): Promise<string> {
  return readBoundedResponseTextWithError(
    response,
    maxBytes,
    (observedBytes) => new ResponseTooLargeError(observedBytes, maxBytes, responseLabel)
  );
}

async function readBoundedResponseTextWithError(
  response: Response,
  maxBytes: number,
  createTooLargeError: (observedBytes: number) => ResponseTooLargeError
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError('maxBytes must be a positive safe integer.');
  }

  const declaredLength = parseDeclaredLength(response);
  if (declaredLength !== null && declaredLength > maxBytes) {
    const error = createTooLargeError(declaredLength);
    await cancelBody(response, error);
    throw error;
  }

  if (!response.body) {
    const text = await response.text();
    const observedBytes = new TextEncoder().encode(text).byteLength;
    if (observedBytes > maxBytes) {
      throw createTooLargeError(observedBytes);
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
        const error = createTooLargeError(nextTotal);
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

/** Read one live-chat response with the product's default chat-body limit. */
export function readBoundedChatResponseText(
  response: Response,
  maxBytes = MAX_CHAT_RESPONSE_BYTES
): Promise<string> {
  return readBoundedResponseTextWithError(
    response,
    maxBytes,
    (observedBytes) => new ChatResponseTooLargeError(observedBytes, maxBytes)
  );
}
