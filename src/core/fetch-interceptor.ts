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

import type { ChatMessage } from '@app-types';
import { extractChatEvents } from '@core/chat-message-parser';
import { createLogger } from '@core/logging';
import { getLiveChatPayload } from '@core/youtubei-chat';

const log = createLogger('FetchInterceptor');

/**
 * Matches YouTube Innertube live-chat fetch URLs.
 * Covers both live and replay endpoints.
 */
const CHAT_ENDPOINT_RE = /youtubei\/v1\/live_chat\/(get_live_chat|get_live_chat_replay)/;

type InterceptorCallback = (messages: ChatMessage[]) => void;

export type InterceptorUnsubscribe = () => void;

let activeInterceptor: {
  originalFetch: typeof window.fetch;
  restore: InterceptorUnsubscribe;
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
  getSettings: () => Readonly<import('@app-types').OverlaySettings>,
  onMessages: InterceptorCallback
): InterceptorUnsubscribe {
  // Remove any previously installed interceptor first.
  if (activeInterceptor) {
    activeInterceptor.restore();
    activeInterceptor = null;
  }

  const originalFetch = window.fetch;

  function interceptedFetch(
    this: typeof window,
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : '';

    const isChatRequest = CHAT_ENDPOINT_RE.test(url);

    if (!isChatRequest) {
      return originalFetch.call(this, input, init);
    }

    // Let the original request proceed normally — we only eavesdrop.
    const response = originalFetch.call(this, input, init);

    // Clone the response so the original consumer (YouTube's UI) is unaffected.
    // Read the clone asynchronously; errors here must not propagate.
    response.then((res) => {
      const cloned = res.clone();
      cloned
        .json()
        .then((data: unknown) => {
          const payload = getLiveChatPayload(data);
          if (!payload || payload.actions.length === 0) return;

          const events = extractChatEvents(payload.actions, getSettings);
          if (events.length === 0) return;

          const messages = events.map((e) => e.message);
          log.debug(`Intercepted ${messages.length} chat message(s) from YouTube client`);
          onMessages(messages);
        })
        .catch(() => {
          // Silently ignore parse failures — the fallback poll loop handles this.
        });
    });

    return response;
  }

  window.fetch = interceptedFetch as typeof window.fetch;

  const restore = (): void => {
    if (window.fetch === interceptedFetch) {
      window.fetch = originalFetch;
    }
    if (activeInterceptor?.restore === restore) {
      activeInterceptor = null;
    }
    log.info('Fetch interceptor removed');
  };

  activeInterceptor = { originalFetch, restore };

  log.info('Fetch interceptor installed for YouTube live chat');
  return restore;
}
