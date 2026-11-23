// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/** Hard cap for a single YouTube live-chat response body. */
export const MAX_CHAT_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface ResponseSizeError extends Error {
  readonly category: 'response-too-large';
  readonly observedBytes: number;
  readonly maxBytes: number;
  readonly responseLabel: string;
}

function responseSizeMessage(
  details: Readonly<Pick<ResponseSizeError, 'maxBytes' | 'responseLabel'>>
): string {
  return `${details.responseLabel} exceeded ${details.maxBytes} bytes.`;
}

/** Shared checked category for chat and other bounded response failures. */
export function isResponseSizeError(error: unknown): error is ResponseSizeError {
  return (
    error instanceof Error &&
    'category' in error &&
    error.category === 'response-too-large' &&
    'observedBytes' in error &&
    typeof error.observedBytes === 'number' &&
    'maxBytes' in error &&
    typeof error.maxBytes === 'number' &&
    'responseLabel' in error &&
    typeof error.responseLabel === 'string'
  );
}

export class ResponseTooLargeError extends Error implements ResponseSizeError {
  readonly category = 'response-too-large';

  constructor(
    readonly observedBytes: number,
    readonly maxBytes: number,
    readonly responseLabel = 'Response'
  ) {
    super(responseSizeMessage({ maxBytes, responseLabel }));
    this.name = 'ResponseTooLargeError';
  }
}

/** Stable chat identity; broad response-size checks use isResponseSizeError. */
export class ChatResponseTooLargeError extends Error implements ResponseSizeError {
  readonly category = 'response-too-large';
  readonly responseLabel = 'Chat response';

  constructor(
    readonly observedBytes: number,
    readonly maxBytes: number
  ) {
    super(responseSizeMessage({ maxBytes, responseLabel: 'Chat response' }));
    this.name = 'ChatResponseTooLargeError';
  }
}

function parseDeclaredLength(response: Response): number | null {
  const value = response.headers.get('content-length');
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function cancelBody(response: Response, error: ResponseSizeError): void {
  try {
    // A cloned response body is a tee branch whose cancellation can stay
    // pending until the original branch completes. Start cleanup without
    // delaying the size-limit rejection.
    void response.body?.cancel(error).catch(() => {
      // Cancellation is best-effort when a platform stream is already closed.
    });
  } catch {
    // Cancellation is best-effort when a platform stream is already closed.
  }
}

const DECODED_PARTS_PER_BATCH = 256;

class StreamingResponseText {
  readonly #decoder = new TextDecoder();
  readonly #parts: string[] = [];
  readonly #batches: string[] = [];

  #append(part: string): void {
    if (part.length === 0) return;
    this.#parts.push(part);
    // Bound fragment bookkeeping even for one-byte chunks. Each nonempty part
    // accounts for at least one admitted byte.
    if (this.#parts.length === DECODED_PARTS_PER_BATCH) {
      this.#batches.push(this.#parts.join(''));
      this.#parts.length = 0;
    }
  }

  push(chunk: Uint8Array): void {
    this.#append(this.#decoder.decode(chunk, { stream: true }));
  }

  finish(): string {
    this.#append(this.#decoder.decode());
    const tail = this.#parts.join('');
    if (this.#batches.length === 0) return tail;
    if (tail.length > 0) this.#batches.push(tail);
    return this.#batches.join('');
  }
}

/**
 * Read UTF-8 and check each streamed chunk against the byte limit before
 * decoding. A bodyless response must materialize text before this check.
 */
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
  createTooLargeError: (observedBytes: number) => ResponseSizeError
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError('maxBytes must be a positive safe integer.');
  }

  const declaredLength = parseDeclaredLength(response);
  if (declaredLength !== null && declaredLength > maxBytes) {
    const error = createTooLargeError(declaredLength);
    cancelBody(response, error);
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
  let firstChunk: Uint8Array | undefined;
  let streamed: StreamingResponseText | undefined;
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
          // See cancelBody(): awaiting cancellation of a tee branch can block
          // until the original response consumer finishes.
          void reader.cancel(error).catch(() => {
            // Cancellation is best-effort when a platform stream already failed.
          });
        } catch {
          // Cancellation is best-effort when a platform stream already failed.
        }
        throw error;
      }
      totalBytes = nextTotal;
      if (streamed) {
        streamed.push(value);
      } else if (firstChunk) {
        streamed = new StreamingResponseText();
        streamed.push(firstChunk);
        firstChunk = undefined;
        streamed.push(value);
      } else {
        // Pass through a one-chunk response without copying its view.
        firstChunk = value;
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (streamed) return streamed.finish();
  return firstChunk ? new TextDecoder().decode(firstChunk) : '';
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
