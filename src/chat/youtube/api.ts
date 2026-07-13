// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import {
  extractInitialChatContinuation,
  type InnertubeContinuationData,
} from '@chat/youtube/continuation';
import {
  findFirstNestedRecordByKey,
  findFirstNestedStringByKey,
  getNestedRecord,
  getNumber,
  getString,
  isRecord,
  type JsonObject,
} from '@chat/youtube/request';
import { isYouTubeLive, isYouTubeWatch } from '@chat/youtube/url-pattern';
import { isAbortError, sleep } from '@util/dom';
import { createLogger } from '@util/logging';

const log = createLogger('Youtubei');

export interface ChatBootstrapData {
  readonly videoId: string;
  readonly isReplay: boolean;
  readonly apiKey?: string;
  readonly clientContext: JsonObject;
  readonly clientNameHeader: string;
  readonly clientVersionHeader?: string;
  readonly ytcfg: JsonObject;
  readonly initialContinuation: InnertubeContinuationData;
}

export type ChatBootstrapResult =
  | {
      status: 'ready';
      data: ChatBootstrapData;
    }
  | {
      status: 'retryable' | 'unavailable' | 'waiting';
      reason: string;
    };

export interface LiveChatPayload {
  readonly actions: readonly unknown[];
  readonly continuations: readonly unknown[];
}

export class YoutubeInnertubeRequestError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'YoutubeInnertubeRequestError';
  }
}

// ── Retry configuration for transient network errors ─────────────────

const ENDPOINT_RETRY_MAX_ATTEMPTS = 4; // 1 initial + 3 retries
const ENDPOINT_RETRY_BASE_DELAY_MS = 1000; // 1s → 2s → 4s

/** Retryable: TypeError (network down), 503-504 (server), 429 (rate limit) */
const isRetryableError = (error: unknown): boolean => {
  if (error instanceof DOMException && error.name === 'AbortError') return false;
  if (error instanceof YoutubeInnertubeRequestError) {
    const s = error.status;
    return s === 429 || s === 503 || s === 504;
  }
  return error instanceof TypeError;
};

export function getVideoIdFromUrl(href: string): string | null {
  try {
    const url = new URL(href, location.origin);

    if (isYouTubeWatch(url.href)) {
      const videoId = url.searchParams.get('v');
      return videoId && videoId.trim().length > 0 ? videoId : null;
    }

    if (isYouTubeLive(url.href)) {
      const [, videoId] = url.pathname.split('/').filter((s): s is string => s !== '');
      return videoId && videoId.trim().length > 0 ? videoId : null;
    }
  } catch {
    return null;
  }

  return null;
}

export const buildWatchUrl = (videoId: string): string =>
  `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;

const readYtcfg = (): JsonObject | null => {
  const ytcfg = window.ytcfg;
  if (!isRecord(ytcfg)) {
    return null;
  }

  const data = isRecord(ytcfg.data_) ? ytcfg.data_ : ytcfg;
  return isRecord(data) ? data : null;
};

/**
 * Attempt to extract ytInitialData from the current page without fetching
 * the watch page HTML. Reads `window.ytInitialData` global variable.
 */
const tryGetInitialDataFromWindow = (): JsonObject | null => {
  if (isRecord(window.ytInitialData)) {
    return window.ytInitialData;
  }

  return null;
};

const fetchWatchHtml = async (videoId: string, signal?: AbortSignal): Promise<string> => {
  const response = await fetch(buildWatchUrl(videoId), {
    credentials: 'include',
    cache: 'no-store',
    mode: 'same-origin',
    referrerPolicy: 'origin-when-cross-origin',
    headers: {
      accept: 'text/html,application/json',
    },
    signal: signal ?? null,
  });

  if (!response.ok) {
    throw new YoutubeInnertubeRequestError(
      `Failed to load watch page HTML (${response.status} ${response.statusText})`,
      response.status
    );
  }

  return response.text();
};

const extractJsonObjectFromHtml = (html: string, markers: readonly string[]): JsonObject | null => {
  for (const marker of markers) {
    const markerIndex = html.indexOf(marker);
    if (markerIndex === -1) {
      continue;
    }

    const searchStart = markerIndex + marker.length - 1;
    const objectStart = html.indexOf('{', searchStart);
    if (objectStart === -1) {
      continue;
    }

    let braceDepth = 0;
    let inString = false;
    let stringDelimiter = '';
    let escapeNext = false;

    for (let index = objectStart; index < html.length; index++) {
      const current = html[index];
      if (!current) {
        continue;
      }

      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      if (current === '\\') {
        escapeNext = true;
        continue;
      }

      if (current === '"' || current === "'") {
        if (!inString) {
          inString = true;
          stringDelimiter = current;
        } else if (current === stringDelimiter) {
          inString = false;
          stringDelimiter = '';
        }
        continue;
      }

      if (inString) {
        continue;
      }

      if (current === '{') {
        braceDepth += 1;
        continue;
      }

      if (current !== '}') {
        continue;
      }

      braceDepth -= 1;
      if (braceDepth !== 0) {
        continue;
      }

      const candidate = html.slice(objectStart, index + 1);
      try {
        const parsed = JSON.parse(candidate);
        return isRecord(parsed) ? parsed : null;
      } catch {
        break;
      }
    }
  }

  return null;
};

const extractInitialDataFromHtml = (html: string): JsonObject | null =>
  extractJsonObjectFromHtml(html, [
    'var ytInitialData = ',
    'window["ytInitialData"] = ',
    'window.ytInitialData = ',
  ]);

const extractYtcfgFromHtml = (html: string): JsonObject | null =>
  extractJsonObjectFromHtml(html, ['ytcfg.set({', 'window.ytcfg.set({']);

/**
 * Extract videoId from ytInitialData structure.
 * YouTube stores the current video's ID in currentVideoEndpoint.watchEndpoint.videoId.
 */
const extractVideoIdFromInitialData = (initialData: JsonObject): string | null | undefined => {
  const watchEndpoint = getNestedRecord(initialData, ['currentVideoEndpoint', 'watchEndpoint']);
  if (!watchEndpoint) return null;
  return getString(watchEndpoint.videoId);
};

export function findLiveChatRenderer(initialData: JsonObject): JsonObject | null {
  const directRenderer = getNestedRecord(initialData, [
    'contents',
    'twoColumnWatchNextResults',
    'conversationBar',
    'liveChatRenderer',
  ]);

  if (directRenderer) {
    return directRenderer;
  }

  // Recursive search: find liveChatRenderer with continuations (legacy layout)
  // or actions array (newer YouTube layout experiments). A single DFS pass
  // with a relaxed predicate covers both cases without redundant traversal.
  const recursive = findFirstNestedRecordByKey(
    initialData,
    'liveChatRenderer',
    (value) =>
      isRecord(value) && (Array.isArray(value.continuations) || Array.isArray(value.actions))
  );
  if (recursive) return recursive;

  // Diagnostic: log page structure to help identify YouTube layout changes
  log.debug('Chat renderer not found — page structure:', {
    hasTwoColumn: !!getNestedRecord(initialData, ['contents', 'twoColumnWatchNextResults']),
    hasConversationBar: !!getNestedRecord(initialData, [
      'contents',
      'twoColumnWatchNextResults',
      'conversationBar',
    ]),
    topLevelKeys: Object.keys(initialData).slice(0, 8),
  });

  return null;
}

const resolveApiKey = (ytcfg: JsonObject): string | undefined =>
  getString(ytcfg.INNERTUBE_API_KEY) ?? findFirstNestedStringByKey(ytcfg, 'innertubeApiKey');

const resolveClientContext = (ytcfg: JsonObject): JsonObject | null => {
  const clientContext = getNestedRecord(ytcfg, ['INNERTUBE_CONTEXT', 'client']) ?? {};
  const client = { ...clientContext };

  if (!getString(client.clientName)) {
    client.clientName = 'WEB';
  }

  if (!getString(client.clientVersion)) {
    const version = getString(ytcfg.INNERTUBE_CONTEXT_CLIENT_VERSION);
    if (version) {
      client.clientVersion = version;
    }
  }

  if (!getString(client.hl)) {
    client.hl = document.documentElement.lang || navigator.language || 'en';
  }

  if (!getString(client.timeZone)) {
    client.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  if (getNumber(client.utcOffsetMinutes) === undefined) {
    client.utcOffsetMinutes = -new Date().getTimezoneOffset();
  }

  return client;
};

/**
 * Bootstraps a YouTube live chat session by resolving page configuration and
 * sending an initial request to the Innertube API.
 * @param signal - Optional AbortSignal to cancel the bootstrap process.
 * @returns A promise resolving to the bootstrap result (ready, retryable, or unavailable).
 */
export async function bootstrapChatSession(signal?: AbortSignal): Promise<ChatBootstrapResult> {
  const videoId = getVideoIdFromUrl(location.href);
  if (!videoId) {
    return {
      status: 'unavailable',
      reason: 'Current URL is not a supported YouTube watch page',
    };
  }

  let cachedHtml: string | null = null;

  const getHtml = async (): Promise<string> => {
    if (cachedHtml === null) {
      cachedHtml = await fetchWatchHtml(videoId, signal);
    }
    return cachedHtml;
  };

  try {
    let ytcfg = readYtcfg();
    if (!ytcfg) {
      ytcfg = extractYtcfgFromHtml(await getHtml());
    }

    if (!ytcfg) {
      return {
        status: 'retryable',
        reason: 'Could not resolve YouTube page configuration',
      };
    }

    let initialData = tryGetInitialDataFromWindow();
    // SPA navigation guard: window.ytInitialData may contain stale data
    // from a previous page (homepage, feed, or wrong video).  Discard it
    // when the embedded videoId is missing or doesn't match the current
    // URL — fall through to HTML extraction for the correct data.
    if (initialData) {
      const windowVideoId = extractVideoIdFromInitialData(initialData);
      if (!windowVideoId || windowVideoId !== videoId) {
        initialData = null;
      }
    }
    if (!initialData) {
      initialData = extractInitialDataFromHtml(await getHtml());
    }
    if (!initialData) {
      return {
        status: 'retryable',
        reason: 'Could not extract ytInitialData from watch page',
      };
    }

    // Belt-and-suspenders: verify HTML-extracted data matches the URL.
    const dataVideoId = extractVideoIdFromInitialData(initialData);
    if (dataVideoId && dataVideoId !== videoId) {
      return {
        status: 'retryable',
        reason: `initialData videoId (${dataVideoId}) does not match current URL videoId (${videoId})`,
      };
    }

    const liveChatRenderer = findLiveChatRenderer(initialData);
    if (!liveChatRenderer) {
      // Check if this is a scheduled/premiere stream that hasn't started yet.
      // YouTube sets playabilityStatus.status to 'LIVE_STREAM_OFFLINE' for
      // upcoming streams where the live chat panel is not yet available.
      const playabilityStatus = getNestedRecord(initialData, ['playabilityStatus']);
      const playbackStatus = playabilityStatus ? getString(playabilityStatus.status) : undefined;
      if (playbackStatus === 'LIVE_STREAM_OFFLINE') {
        return {
          status: 'waiting',
          reason: 'Stream not yet started — live chat renderer unavailable',
        };
      }

      return {
        status: 'unavailable',
        reason: 'Watch page does not expose a live chat renderer for this video',
      };
    }

    const initialContinuation = extractInitialChatContinuation(liveChatRenderer);
    if (!initialContinuation) {
      return {
        status: 'unavailable',
        reason: 'Live chat renderer does not expose an initial continuation token',
      };
    }

    const clientContext = resolveClientContext(ytcfg);
    if (!clientContext) {
      return {
        status: 'retryable',
        reason: 'Could not build Innertube client context',
      };
    }

    const apiKey = resolveApiKey(ytcfg);
    const clientVersionHeader =
      getString(ytcfg.INNERTUBE_CONTEXT_CLIENT_VERSION) ?? getString(clientContext.clientVersion);

    const data: ChatBootstrapData = {
      videoId,
      isReplay: liveChatRenderer.isReplay === true,
      ...(apiKey ? { apiKey } : {}),
      clientContext,
      clientNameHeader: getString(ytcfg.INNERTUBE_CONTEXT_CLIENT_NAME) ?? '1',
      ...(clientVersionHeader ? { clientVersionHeader } : {}),
      ytcfg,
      initialContinuation,
    };

    log.debug('Bootstrap ready', { videoId, isReplay: data.isReplay });
    return {
      status: 'ready',
      data,
    };
  } catch (error: unknown) {
    if (isAbortError(error)) {
      throw error;
    }

    return {
      status: 'retryable',
      reason: error instanceof Error ? error.message : 'Failed to bootstrap chat session',
    };
  }
}

const createInnertubeHeaders = (data: ChatBootstrapData): Record<string, string> => {
  const headers: Record<string, string> = {
    accept: '*/*',
    'accept-language': document.documentElement.lang || navigator.language || 'en',
    'cache-control': 'no-store',
    'content-type': 'application/json',
    pragma: 'no-cache',
    'x-youtube-client-name': data.clientNameHeader,
  };

  if (data.clientVersionHeader) {
    headers['x-youtube-client-version'] = data.clientVersionHeader;
  }

  const visitorData =
    getString(data.ytcfg.VISITOR_DATA) ??
    getString(data.clientContext.visitorData) ??
    findFirstNestedStringByKey(data.ytcfg, 'visitorData');
  if (visitorData) {
    headers['x-goog-visitor-id'] = visitorData;
  }

  return headers;
};

const buildEndpointUrl = (
  endpoint: 'get_live_chat' | 'get_live_chat_replay',
  apiKey?: string
): string => {
  const url = new URL(`/youtubei/v1/live_chat/${endpoint}`, location.origin);
  url.searchParams.set('prettyPrint', 'false');

  if (apiKey) {
    url.searchParams.set('key', apiKey);
  }

  return url.toString();
};

const buildInnertubeBody = (
  data: ChatBootstrapData,
  continuation: InnertubeContinuationData,
  currentPlayerState?: { playerOffsetMs: string }
): Record<string, unknown> => {
  const body: Record<string, unknown> = {
    context: {
      client: data.clientContext,
    },
    continuation: continuation.continuation,
  };

  if (continuation.clickTrackingParams) {
    body.clickTracking = {
      clickTrackingParams: continuation.clickTrackingParams,
    };
  }

  if (currentPlayerState) {
    body.currentPlayerState = currentPlayerState;
  }

  return body;
};

const fetchChatEndpoint = async (
  endpoint: 'get_live_chat' | 'get_live_chat_replay',
  data: ChatBootstrapData,
  continuation: InnertubeContinuationData,
  signal?: AbortSignal,
  playerOffsetMs?: number
): Promise<unknown> => {
  let lastError: unknown;

  for (let attempt = 0; attempt < ENDPOINT_RETRY_MAX_ATTEMPTS; attempt++) {
    // Check abort signal before each attempt
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    try {
      const response = await fetch(buildEndpointUrl(endpoint, data.apiKey), {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        mode: 'same-origin',
        referrerPolicy: 'origin-when-cross-origin',
        headers: createInnertubeHeaders(data),
        body: JSON.stringify(
          buildInnertubeBody(
            data,
            continuation,
            playerOffsetMs === undefined ? undefined : { playerOffsetMs: String(playerOffsetMs) }
          )
        ),
        signal: signal ?? null,
      });

      if (!response.ok) {
        throw new YoutubeInnertubeRequestError(
          `Innertube ${endpoint} request failed (${response.status} ${response.statusText})`,
          response.status
        );
      }

      return response.json();
    } catch (error: unknown) {
      // Don't retry abort errors — propagate immediately
      if (isAbortError(error)) throw error;

      lastError = error;

      const isLastAttempt = attempt === ENDPOINT_RETRY_MAX_ATTEMPTS - 1;
      if (isLastAttempt || !isRetryableError(error)) {
        log.warn(
          `Innertube ${endpoint} request failed (attempt ${attempt + 1}/${ENDPOINT_RETRY_MAX_ATTEMPTS}):`,
          error
        );
        throw error;
      }

      // Exponential backoff: 1s → 2s → 4s
      const delayMs = ENDPOINT_RETRY_BASE_DELAY_MS * 2 ** attempt;
      log.info(
        `Innertube ${endpoint} request failed (attempt ${attempt + 1}/${ENDPOINT_RETRY_MAX_ATTEMPTS}), ` +
          `retrying in ${delayMs}ms:`,
        lastError
      );

      try {
        await sleep(delayMs, signal);
      } catch {
        // sleep threw (AbortError during wait) — propagate
        throw new DOMException('Aborted', 'AbortError');
      }
    }
  }

  // Should be unreachable, but satisfy TypeScript's return type
  throw lastError;
};

export const fetchLiveChat = async (
  data: ChatBootstrapData,
  continuation: InnertubeContinuationData,
  signal?: AbortSignal
): Promise<unknown> => fetchChatEndpoint('get_live_chat', data, continuation, signal);

export const fetchReplayChat = async (
  data: ChatBootstrapData,
  continuation: InnertubeContinuationData,
  playerOffsetMs?: number,
  signal?: AbortSignal
): Promise<unknown> =>
  fetchChatEndpoint('get_live_chat_replay', data, continuation, signal, playerOffsetMs);

export function getLiveChatPayload(response: unknown): LiveChatPayload | null {
  const liveChatContinuation = getNestedRecord(response, [
    'continuationContents',
    'liveChatContinuation',
  ]);

  if (!liveChatContinuation) {
    return null;
  }

  return {
    actions: Array.isArray(liveChatContinuation.actions) ? liveChatContinuation.actions : [],
    continuations: Array.isArray(liveChatContinuation.continuations)
      ? liveChatContinuation.continuations
      : [],
  };
}
