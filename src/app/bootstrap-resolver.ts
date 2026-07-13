// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { ChatBootstrapData, ChatBootstrapResult } from '@chat/youtube/api';
import { bootstrapChatSession } from '@chat/youtube/api';
import { sleep, throwIfAborted } from '@util/dom';
import { createLogger } from '@util/logging';

const log = createLogger('BootstrapResolver');

const BOOTSTRAP_MAX_ATTEMPTS = 5;
const BOOTSTRAP_RETRY_DELAY_MS = 1000;

/**
 * Resolves bootstrap data by scanning ytInitialData and page source.
 * Retries up to BOOTSTRAP_MAX_ATTEMPTS times if the initial attempt fails.
 * @param signal - Optional AbortSignal to cancel resolution.
 * @returns A resolution object with status, bootstrap data (if ready), and reason.
 */
export async function resolveBootstrap(signal?: AbortSignal): Promise<ChatBootstrapResult> {
  let lastResult: ChatBootstrapResult | null = null;

  for (let attempt = 1; attempt <= BOOTSTRAP_MAX_ATTEMPTS; attempt++) {
    throwIfAborted(signal);

    const result = await bootstrapChatSession(signal);
    if (result.status === 'ready') {
      return {
        status: 'ready',
        data: result.data,
      };
    }

    // Do not retry when the stream hasn't started yet (LIVE_STREAM_OFFLINE).
    // Retrying won't help — the status won't change until the stream begins.
    if (result.status === 'waiting') {
      return {
        status: 'waiting',
        reason: result.reason,
      };
    }

    // Do not retry when the page structurally has no chat renderer.
    // VOD pages, non-watch URLs — retrying won't change the outcome.
    if (result.status === 'unavailable') {
      return {
        status: 'unavailable',
        reason: result.reason,
      };
    }

    lastResult = result;
    if (attempt < BOOTSTRAP_MAX_ATTEMPTS) {
      log.debug('chat.bootstrap.retry', {
        attempt,
        max: 5,
        status: result.status,
        reason: result.reason,
      });
      await sleep(BOOTSTRAP_RETRY_DELAY_MS, signal);
    }
  }

  return {
    status: lastResult?.status ?? 'retryable',
    reason: lastResult?.reason ?? 'Chat bootstrap did not become available',
  };
}

/**
 * Clears cached bootstrap data to force re-resolution on next access.
 * @param signal - Optional AbortSignal to cancel resolution.
 * @returns The bootstrap data if resolution succeeds, or null.
 */
export async function refreshBootstrap(signal?: AbortSignal): Promise<ChatBootstrapData | null> {
  const resolution = await resolveBootstrap(signal);

  if (resolution.status !== 'ready') {
    log.warn('chat.bootstrap.refresh-failed', { reason: resolution.reason });
    return null;
  }

  return resolution.data;
}

/**
 * Logs a bootstrap resolution failure reason.
 * @param resolution - The resolution object containing status and reason.
 */
export function logBootstrapFailure(resolution: ChatBootstrapResult): void {
  if (resolution.status === 'waiting') {
    log.info('chat.bootstrap.waiting', { reason: resolution.reason });
    return;
  }
  if (resolution.status === 'retryable') {
    log.warn('chat.bootstrap.retry-exhausted', { reason: resolution.reason, attempts: 5 });
    return;
  }

  if (resolution.status === 'unavailable') {
    log.info('chat.bootstrap.unavailable', { reason: resolution.reason });
  }
}
