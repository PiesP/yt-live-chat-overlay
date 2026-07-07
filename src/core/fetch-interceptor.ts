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
import { extractChatEvents } from '@core/chat-message-parser';
import { getLiveChatPayload } from '@core/youtubei-chat';
import { createLogger } from '@util/logging';

const log = createLogger('FetchInterceptor');

/** Maximum time to wait for JSON parsing in the fetch interceptor. */
const INTERCEPTOR_PARSE_TIMEOUT_MS = 5000;

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

/** How often to verify that window.fetch still points to our interceptor (ms). */
const VALIDATION_INTERVAL_MS = 5000;

let validationTimerId: ReturnType<typeof setInterval> | null = null;

/**
 * Start a periodic validation that checks whether `window.fetch` has been
 * replaced by a third party (e.g., YouTube's own SPA re-initialization)
 * and re-installs the interceptor if it has been silently removed.
 */
function startValidation(
  getSettings: () => Readonly<OverlaySettings>,
  onMessages: InterceptorCallback
): void {
  stopValidation();

  validationTimerId = setInterval(() => {
    if (!activeInterceptor) {
      stopValidation();
      return;
    }

    // Check if our interceptor is still on the fetch chain.
    // If window.fetch has been replaced (e.g., YouTube re-patched it after
    // SPA navigation), our function is gone and the interceptor silently
    // stops capturing messages. Re-install in-place to restore it.
    if (window.fetch !== activeInterceptor.interceptedFn) {
      log.info('Fetch interceptor displaced — re-installing');
      // Avoid recursion: the restore function guards against
      // window.fetch !== interceptedFetch, making it a no-op here.
      // We re-install fresh by calling installFetchInterceptor again.
      installFetchInterceptor(getSettings, onMessages);
    }
  }, VALIDATION_INTERVAL_MS);
}

/**
 * Stop the periodic fetch chain validation.
 */
function stopValidation(): void {
  if (validationTimerId !== null) {
    clearInterval(validationTimerId);
    validationTimerId = null;
  }
}

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
        const cloned = res.clone();

        // C-3: Timeout the JSON parse to prevent indefinite hang on slow networks.
        // If the parse takes >5s, the interceptor silently aborts — the poll loop
        // will catch these messages on its next cycle.
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error('Fetch interceptor JSON parse timed out'));
          }, INTERCEPTOR_PARSE_TIMEOUT_MS);
        });

        const data: unknown = await Promise.race([cloned.json(), timeoutPromise]);
        clearTimeout(timeoutId);

        const payload = getLiveChatPayload(data);
        if (payload && payload.actions.length > 0) {
          const events = extractChatEvents(payload.actions, getSettings);
          if (events.length > 0) {
            const messages = events.map((e) => e.message);
            log.debug(`Intercepted ${messages.length} chat message(s) from YouTube client`);
            onMessages(messages);
          }
        }
      } catch (error: unknown) {
        log.debug('Fetch interceptor parse failed:', error);
        // Silently ignore parse failures — the fallback poll loop handles this.
      }
    })();

    return response;
  }

  window.fetch = interceptedFetch as typeof window.fetch;

  const restore = (): void => {
    stopValidation();
    if (window.fetch === interceptedFetch) {
      window.fetch = originalFetch;
    }
    if (activeInterceptor?.restore === restore) {
      activeInterceptor = null;
    }
    stopValidation();
    log.info('Fetch interceptor removed');
  };

  activeInterceptor = { restore, interceptedFn: interceptedFetch as typeof window.fetch };

  startValidation(getSettings, onMessages);

  log.info('Fetch interceptor installed for YouTube live chat');
  return restore;
}
