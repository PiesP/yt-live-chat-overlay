// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * FetchInterceptor — intercepts YouTube's own get_live_chat requests
 * and forwards parsed chat events to the overlay's ChatSource.
 *
 * Instead of polling the Innertube API independently (which doubles
 * API quota usage and adds an extra poll cycle of latency), this module
 * "eavesdrops" on the fetch calls that the YouTube page itself makes.
 * When YouTube's client receives new chat messages, the overlay gets
 * them at the same instant — eliminating one full poll interval of delay.
 *
 * Zero runtime dependencies — patches window.fetch in-place.
 */

import type { ChatMessage, OverlaySettings } from '@app-types';
import { extractChatEvents } from '@chat/message-parser';
import { getLiveChatPayload } from '@chat/youtube/api';
import { createLogger } from '@util/logging';

const log = createLogger('FetchInterceptor');

/** Maximum number of compact response identities retained per installation. */
const MAX_RESPONSE_IDENTITY_CACHE_SIZE = 64;

/**
 * Produce a compact, deterministic identity without retaining the response body.
 * Two independently mixed 32-bit hashes plus the UTF-16 length make accidental
 * collisions vanishingly unlikely for duplicate-suppression purposes.
 */
export function createResponseIdentity(text: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < text.length; index++) {
    const codeUnit = text.charCodeAt(index);
    first = Math.imul(first ^ codeUnit, 0x01000193);
    second = Math.imul(second ^ codeUnit, 0x85ebca6b);
    second = (second << 13) | (second >>> 19);
  }
  return `${text.length}:${(first >>> 0).toString(36)}:${(second >>> 0).toString(36)}`;
}

function rememberResponseIdentity(cache: Set<string>, text: string): boolean {
  const identity = createResponseIdentity(text);
  if (cache.has(identity)) return false;

  if (cache.size >= MAX_RESPONSE_IDENTITY_CACHE_SIZE) {
    const oldest = cache.values().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.add(identity);
  return true;
}

/**
 * Matches YouTube Innertube live-chat fetch URLs.
 * Covers both live and replay endpoints.
 */
const CHAT_ENDPOINT_RE = /youtubei\/v1\/live_chat\/(get_live_chat|get_live_chat_replay)/;

type InterceptorCallback = (messages: ChatMessage[]) => void;

export type InterceptorUnsubscribe = () => void;

let activeInterceptor: {
  restore: InterceptorUnsubscribe;
  interceptedFn: typeof window.fetch;
} | null = null;

/**
 * Install a fetch monkey-patch that intercepts YouTube's own chat requests.
 *
 * Calling this again automatically removes the previous interceptor first.
 *
 * @param getSettings  Callback returning current overlay settings (needed by extractChatEvents).
 * @param onMessages   Called with parsed ChatMessage[] whenever a chat response is intercepted.
 * @returns            Unsubscribe function that restores the original fetch.
 */
export function installFetchInterceptor(
  getSettings: () => Readonly<OverlaySettings>,
  onMessages: InterceptorCallback
): InterceptorUnsubscribe {
  // Remove any previously installed interceptor first.
  if (activeInterceptor) {
    activeInterceptor.restore();
    activeInterceptor = null;
  }

  // Capture the current fetch at install time so we chain properly with other patches.
  const originalFetch = window.fetch;
  const responseIdentityCache = new Set<string>();
  let isActive = true;

  function interceptedFetch(
    this: typeof window,
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input instanceof Request
            ? input.url
            : '';

    // Fast-path URL check: skip regex for non-string/URL/Request inputs.
    // Only chat-related URLs need cloning; all others pass through untouched.
    if (!url || !CHAT_ENDPOINT_RE.test(url)) {
      return originalFetch.call(this, input, init);
    }

    // Let the original request proceed normally — we only eavesdrop.
    const response = originalFetch.call(this, input, init);

    // Clone the response so the original consumer (YouTube's UI) is unaffected.
    // Read the clone asynchronously; errors here must not propagate.
    void (async () => {
      try {
        const res = await response;
        if (!isActive) return;
        const cloned = res.clone();

        // Read once for JSON parsing, but retain only a compact identity after
        // this asynchronous scope completes.
        const text = await cloned.text();
        if (!isActive) return;
        if (!rememberResponseIdentity(responseIdentityCache, text)) {
          log.debug('chat.interceptor.skip-duplicate');
          return;
        }

        const data = JSON.parse(text) as unknown;

        const payload = getLiveChatPayload(data);
        if (payload && payload.actions.length > 0) {
          const events = extractChatEvents(payload.actions, getSettings);
          if (events.length > 0) {
            const messages = events.map((e) => e.message);
            log.debug('chat.interceptor.messages-received', { count: messages.length });
            if (isActive) onMessages(messages);
          }
        }
      } catch (error: unknown) {
        log.debug('chat.interceptor.parse-failed', { error: String(error) });
        // Silently ignore parse failures — the fallback poll loop handles this.
      }
    })();

    return response;
  }

  window.fetch = interceptedFetch as typeof window.fetch;

  const restore = (): void => {
    isActive = false;
    responseIdentityCache.clear();
    if (window.fetch === interceptedFetch) {
      window.fetch = originalFetch;
    }
    if (activeInterceptor?.restore === restore) {
      activeInterceptor = null;
    }
    log.info('chat.interceptor.removed');
  };

  activeInterceptor = { restore, interceptedFn: interceptedFetch as typeof window.fetch };

  log.info('chat.interceptor.installed');
  return restore;
}
