import { isAbortError } from '@core/dom';

export type JsonObject = Record<string, unknown>;

export const isRecord = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null;

export const asRecord = (value: unknown): JsonObject | null => (isRecord(value) ? value : null);

export const getString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

export const getNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
};

export interface InnertubeContinuationData {
  readonly continuation: string;
  readonly clickTrackingParams?: string;
  readonly timeoutMs?: number;
}

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
      status: 'retryable' | 'unavailable';
      reason: string;
    };

export interface LiveChatPayload {
  readonly actions: readonly unknown[];
  readonly continuations: readonly unknown[];
}

export class YoutubeInnertubeRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'YoutubeInnertubeRequestError';
  }
}

const getNestedRecord = (root: unknown, path: readonly string[]): JsonObject | null => {
  let current: unknown = root;

  for (const key of path) {
    if (!isRecord(current)) {
      return null;
    }

    current = current[key];
  }

  return isRecord(current) ? current : null;
};

const findFirstNestedRecordByKey = (
  root: unknown,
  key: string,
  predicate?: (value: JsonObject) => boolean
): JsonObject | null => {
  const stack: unknown[] = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!isRecord(current)) {
      continue;
    }

    const candidate = current[key];
    if (isRecord(candidate) && (!predicate || predicate(candidate))) {
      return candidate;
    }

    for (const value of Object.values(current)) {
      if (Array.isArray(value)) {
        stack.push(...value);
        continue;
      }

      stack.push(value);
    }
  }

  return null;
};

const findFirstNestedStringByKey = (root: unknown, key: string): string | undefined => {
  const stack: unknown[] = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!isRecord(current)) {
      continue;
    }

    const candidate = getString(current[key]);
    if (candidate) {
      return candidate;
    }

    for (const value of Object.values(current)) {
      if (Array.isArray(value)) {
        stack.push(...value);
        continue;
      }

      stack.push(value);
    }
  }

  return undefined;
};

export const getVideoIdFromUrl = (href = location.href): string | null => {
  try {
    const url = new URL(href, location.origin);

    if (url.pathname === '/watch') {
      const videoId = url.searchParams.get('v');
      return videoId && videoId.trim().length > 0 ? videoId : null;
    }

    if (url.pathname.startsWith('/live/')) {
      const [, videoId] = url.pathname.split('/').filter(Boolean);
      return videoId && videoId.trim().length > 0 ? videoId : null;
    }
  } catch {
    return null;
  }

  return null;
};

const buildWatchUrl = (videoId: string): string =>
  `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;

const readYtcfg = (): JsonObject | null => {
  const root = window as unknown as JsonObject;
  const ytcfg = isRecord(root.ytcfg) ? root.ytcfg : null;
  if (!ytcfg) {
    return null;
  }

  const data = isRecord(ytcfg.data_) ? ytcfg.data_ : ytcfg;
  return isRecord(data) ? data : null;
};

const fetchWatchHtml = async (videoId: string, signal?: AbortSignal): Promise<string> => {
  const response = await fetch(buildWatchUrl(videoId), {
    credentials: 'include',
    cache: 'no-store',
    mode: 'same-origin',
    referrerPolicy: 'origin-when-cross-origin',
    ...(signal ? { signal } : {}),
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

      if (current === '"' || current === "'" || current === '`') {
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

const findLiveChatRenderer = (initialData: JsonObject): JsonObject | null => {
  const directRenderer = getNestedRecord(initialData, [
    'contents',
    'twoColumnWatchNextResults',
    'conversationBar',
    'liveChatRenderer',
  ]);

  if (directRenderer) {
    return directRenderer;
  }

  return findFirstNestedRecordByKey(initialData, 'liveChatRenderer', (value) =>
    Array.isArray(value.continuations)
  );
};

const toContinuationData = (value: unknown): InnertubeContinuationData | null => {
  if (!isRecord(value)) {
    return null;
  }

  const continuation = getString(value.continuation);
  if (!continuation) {
    return null;
  }

  const result: {
    continuation: string;
    clickTrackingParams?: string;
    timeoutMs?: number;
  } = { continuation };

  const clickTrackingParams = getString(value.clickTrackingParams);
  if (clickTrackingParams) {
    result.clickTrackingParams = clickTrackingParams;
  }

  const timeoutMs = getNumber(value.timeoutMs);
  if (timeoutMs !== undefined) {
    result.timeoutMs = timeoutMs;
  }

  return result;
};

const pickContinuation = (
  continuations: unknown,
  keys: readonly string[]
): InnertubeContinuationData | null => {
  if (!Array.isArray(continuations)) {
    return null;
  }

  for (const item of continuations) {
    if (!isRecord(item)) {
      continue;
    }

    for (const key of keys) {
      const continuation = toContinuationData(item[key]);
      if (continuation) {
        return continuation;
      }
    }
  }

  return null;
};

export const extractInitialChatContinuation = (
  renderer: JsonObject
): InnertubeContinuationData | null =>
  pickContinuation(renderer.continuations, [
    'reloadContinuationData',
    'invalidationContinuationData',
    'timedContinuationData',
    'liveChatReplayContinuationData',
    'playerSeekContinuationData',
  ]);

export const extractNextLiveContinuation = (
  continuations: unknown
): InnertubeContinuationData | null =>
  pickContinuation(continuations, [
    'invalidationContinuationData',
    'timedContinuationData',
    'reloadContinuationData',
  ]);

export const extractReplayContinuation = (
  continuations: unknown
): InnertubeContinuationData | null =>
  pickContinuation(continuations, ['liveChatReplayContinuationData']);

export const extractPlayerSeekContinuation = (
  continuations: unknown
): InnertubeContinuationData | null =>
  pickContinuation(continuations, ['playerSeekContinuationData']);

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

  return isRecord(client) ? client : null;
};

export const bootstrapChatSession = async (signal?: AbortSignal): Promise<ChatBootstrapResult> => {
  const videoId = getVideoIdFromUrl();
  if (!videoId) {
    return {
      status: 'unavailable',
      reason: 'Current URL is not a supported YouTube watch page',
    };
  }

  let html: string | null = null;
  const ensureHtml = async (): Promise<string> => {
    if (html === null) {
      html = await fetchWatchHtml(videoId, signal);
    }
    return html;
  };

  try {
    let ytcfg = readYtcfg();
    if (!ytcfg) {
      ytcfg = extractYtcfgFromHtml(await ensureHtml());
    }

    if (!ytcfg) {
      return {
        status: 'retryable',
        reason: 'Could not resolve YouTube page configuration',
      };
    }

    const initialData = extractInitialDataFromHtml(await ensureHtml());
    if (!initialData) {
      return {
        status: 'retryable',
        reason: 'Could not extract ytInitialData from watch page',
      };
    }

    const liveChatRenderer = findLiveChatRenderer(initialData);
    if (!liveChatRenderer) {
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
      isReplay: Boolean(liveChatRenderer.isReplay),
      ...(apiKey ? { apiKey } : {}),
      clientContext,
      clientNameHeader: getString(ytcfg.INNERTUBE_CONTEXT_CLIENT_NAME) ?? '1',
      ...(clientVersionHeader ? { clientVersionHeader } : {}),
      ytcfg,
      initialContinuation,
    };

    return {
      status: 'ready',
      data,
    };
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }

    return {
      status: 'retryable',
      reason: error instanceof Error ? error.message : 'Failed to bootstrap chat session',
    };
  }
};

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
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    throw new YoutubeInnertubeRequestError(
      `Innertube ${endpoint} request failed (${response.status} ${response.statusText})`,
      response.status
    );
  }

  return response.json();
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

export const getLiveChatPayload = (response: unknown): LiveChatPayload | null => {
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
};
