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
import { createLogger } from '@core/logging';
import { getLiveChatPayload } from '@core/youtubei-chat';

const log = createLogger('FetchInterceptor');

/**
 * Captured once at module load time — the true browser fetch.
 * Storing this at scope level ensures we always wrap the real fetch,
 * not a patch applied by another extension before this module loads.
 */
const ORIGINAL_FETCH = window.fetch;

/**
 * Matches YouTube Innertube live-chat fetch URLs.
 * Covers both live and replay endpoints.
 */
const CHAT_ENDPOINT_RE = /youtubei\/v1\/live_chat\/(get_live_chat|get_live_chat_replay)/;

type InterceptorCallback = (messages: ChatMessage[]) => void;

export type InterceptorUnsubscribe = () => void;

let activeInterceptor: {
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
  getSettings: () => Readonly<OverlaySettings>,
  onMessages: InterceptorCallback
): InterceptorUnsubscribe {
  // Remove any previously installed interceptor first.
  if (activeInterceptor) {
    activeInterceptor.restore();
    activeInterceptor = null;
  }

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

    const isChatRequest = CHAT_ENDPOINT_RE.test(url);

    if (!isChatRequest) {
      return ORIGINAL_FETCH.call(this, input, init);
    }

    // Let the original request proceed normally — we only eavesdrop.
    const response = ORIGINAL_FETCH.call(this, input, init);

    // Clone the response so the original consumer (YouTube's UI) is unaffected.
    // Read the clone asynchronously; errors here must not propagate.
    void (async () => {
      try {
        const res = await response;
        const cloned = res.clone();
        const data: unknown = await cloned.json();
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
    if (window.fetch === interceptedFetch) {
      window.fetch = ORIGINAL_FETCH;
    }
    if (activeInterceptor?.restore === restore) {
      activeInterceptor = null;
    }
    log.info('Fetch interceptor removed');
  };

  activeInterceptor = { restore };

  log.info('Fetch interceptor installed for YouTube live chat');
  return restore;
}
