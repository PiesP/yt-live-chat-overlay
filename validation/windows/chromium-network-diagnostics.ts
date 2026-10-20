// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { createHash } from 'node:crypto';

type Session = {
  on(event: string, listener: (payload: unknown) => void): unknown;
  off(event: string, listener: (payload: unknown) => void): unknown;
  send(method: string): Promise<unknown>;
  detach(): Promise<void>;
};

type Identity = {
  ownedResourcePath: string | null;
  watchDocumentSha256: string | null;
};

type Options = {
  createSession: () => Promise<Session>;
  classifyUrl: (url: string) => Identity;
  classifyWarning: (text: string) => {
    ownedResourcePath: string | null;
    reportedFrameDocumentSha256: string | null;
  };
  extensionId: string;
};

type PolicyName =
  | 'connection-allowlist'
  | 'connection-allowlist-report-only'
  | 'reporting-endpoints';
type HeaderEvidence = {
  presence: 'present' | 'absent' | 'unknown';
  bytes: number | null;
  sha256: string | null;
  source: 'Network.responseReceivedExtraInfo' | null;
  ownedOriginMention: boolean | null;
};
type RequestEvidence = {
  id: string;
  path: string | null;
  watchSha: string | null;
  frameId: string | null;
  loaderId: string | null;
  redirectCount: number;
  responseStatus: number | null;
  responseHasExtraInfo: boolean | null;
  extraStatus: number | null;
  extraInfoCount: number;
  policy: Record<PolicyName, HeaderEvidence> | null;
  finished: boolean;
  failed: boolean;
  blockedReason: string | null;
};
type Commit = { frameId: string; loaderId: string; watchSha: string };
type Warning = {
  path: string;
  reportedWatchSha: string | null;
  requestId: string | null;
};

const SETUP_MS = 3_000;
const CLEANUP_MS = 3_000;
const MAX_REQUESTS = 32;
const MAX_WARNINGS = 16;
const MAX_COMMITS = 4;
const MAX_ID = 128;
const MAX_HEADER_BYTES = 4_096;
const POLICY_NAMES: PolicyName[] = [
  'connection-allowlist',
  'connection-allowlist-report-only',
  'reporting-endpoints',
];

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedId(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ID &&
    /^[\x21-\x7e]+$/u.test(value)
    ? value
    : null;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function boundedStatus(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : null;
}

function unknownHeader(): HeaderEvidence {
  return { presence: 'unknown', bytes: null, sha256: null, source: null, ownedOriginMention: null };
}

/** A deliberately narrow origin-list parser: unfamiliar policy syntax stays unknown. */
function originMention(value: string, extensionId: string): boolean | null {
  const tokens = value.split(/[\s,]+/u).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 32) return null;
  for (const token of tokens) {
    if (!/^[a-z][a-z0-9+.-]*:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?\/?$/iu.test(token)) return null;
  }
  return tokens.some(
    (token) => token.toLowerCase().replace(/\/$/u, '') === `chrome-extension://${extensionId}`
  );
}

function policyHeaders(
  headers: unknown,
  extensionId: string
): Record<PolicyName, HeaderEvidence> | null {
  const values = record(headers);
  if (!values || Object.keys(values).length > 256) return null;
  const result = Object.fromEntries(POLICY_NAMES.map((name) => [name, unknownHeader()])) as Record<
    PolicyName,
    HeaderEvidence
  >;
  for (const name of POLICY_NAMES) {
    const matches = Object.entries(values).filter(([key]) => key.toLowerCase() === name);
    if (matches.length === 0) {
      result[name] = {
        presence: 'absent',
        bytes: null,
        sha256: null,
        source: 'Network.responseReceivedExtraInfo',
        ownedOriginMention: null,
      };
      continue;
    }
    if (matches.length !== 1 || typeof matches[0]?.[1] !== 'string') continue;
    const raw = matches[0][1];
    if (
      Buffer.byteLength(raw) > MAX_HEADER_BYTES ||
      [...raw].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    )
      continue;
    result[name] = {
      presence: 'present',
      bytes: Buffer.byteLength(raw),
      sha256: digest(raw),
      source: 'Network.responseReceivedExtraInfo',
      ownedOriginMention: name === 'reporting-endpoints' ? null : originMention(raw, extensionId),
    };
  }
  return result;
}

function within<T>(
  promise: Promise<T>,
  milliseconds: number
): Promise<{ ok: true; value: T } | { ok: false }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false }), Math.max(0, milliseconds));
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({ ok: true, value });
      },
      () => {
        clearTimeout(timer);
        resolve({ ok: false });
      }
    );
  });
}

export async function beginChromiumNetworkDiagnostics(options: Options): Promise<{
  finish: () => Promise<Record<string, unknown>>;
}> {
  const requests = new Map<string, RequestEvidence>();
  const warnings: Warning[] = [];
  const commits: Commit[] = [];
  let requestOverflow = 0;
  let warningOverflow = 0;
  let active = true;
  let state: 'ready' | 'unavailable' = 'unavailable';
  let session: Session | null = null;
  const listeners: Array<[string, (payload: unknown) => void]> = [];
  const listen = (event: string, listener: (payload: unknown) => void) => {
    session?.on(event, listener);
    listeners.push([event, listener]);
  };
  const onRequest = (payload: unknown) => {
    if (!active) return;
    const event = record(payload);
    const request = record(event?.request);
    const id = boundedId(event?.requestId);
    const url = request?.url;
    if (!id || typeof url !== 'string' || url.length > 2048) return;
    const identity = options.classifyUrl(url);
    const previous = requests.get(id);
    if (!identity.ownedResourcePath && !identity.watchDocumentSha256) {
      if (previous) {
        previous.path = null;
        previous.watchSha = null;
        previous.redirectCount = Math.min(255, previous.redirectCount + 1);
        previous.policy = null;
      }
      return;
    }
    if (!previous && requests.size >= MAX_REQUESTS) {
      requestOverflow = Math.min(65_535, requestOverflow + 1);
      return;
    }
    const redirected = previous !== undefined || event?.redirectResponse !== undefined;
    requests.set(id, {
      id,
      path: identity.ownedResourcePath,
      watchSha: identity.watchDocumentSha256,
      frameId: boundedId(event?.frameId),
      loaderId: boundedId(event?.loaderId),
      redirectCount: redirected ? Math.min(255, (previous?.redirectCount ?? 0) + 1) : 0,
      responseStatus: null,
      responseHasExtraInfo: null,
      extraStatus: null,
      extraInfoCount: 0,
      policy: null,
      finished: false,
      failed: false,
      blockedReason: null,
    });
  };
  const onResponse = (payload: unknown) => {
    if (!active) return;
    const event = record(payload);
    const entry = requests.get(boundedId(event?.requestId) ?? '');
    if (!entry) return;
    const response = record(event?.response);
    entry.responseStatus = boundedStatus(response?.status);
    entry.responseHasExtraInfo =
      typeof event?.hasExtraInfo === 'boolean' ? event.hasExtraInfo : null;
    // A different response loader cannot establish the request's document identity.
    if (boundedId(event?.loaderId) !== entry.loaderId) entry.loaderId = null;
  };
  const onExtraInfo = (payload: unknown) => {
    if (!active) return;
    const event = record(payload);
    const entry = requests.get(boundedId(event?.requestId) ?? '');
    if (!entry || !entry.watchSha) return;
    entry.extraInfoCount = Math.min(255, entry.extraInfoCount + 1);
    entry.extraStatus = boundedStatus(event?.statusCode);
    // CDP extra-info events have no redirect-hop index. Multiple or redirected hops
    // cannot prove which policy headers belong to the committed response.
    entry.policy =
      entry.extraInfoCount === 1 && entry.redirectCount === 0
        ? policyHeaders(event?.headers, options.extensionId)
        : null;
  };
  const onFinished = (payload: unknown) => {
    if (!active) return;
    const event = record(payload);
    const entry = requests.get(boundedId(event?.requestId) ?? '');
    if (entry) entry.finished = true;
  };
  const onFailed = (payload: unknown) => {
    if (!active) return;
    const event = record(payload);
    const entry = requests.get(boundedId(event?.requestId) ?? '');
    if (!entry) return;
    entry.failed = true;
    const reason = event?.blockedReason;
    entry.blockedReason =
      typeof reason === 'string' && /^[a-z0-9-]{1,60}$/u.test(reason) ? reason : null;
  };
  const onFrame = (payload: unknown) => {
    if (!active) return;
    const frame = record(record(payload)?.frame);
    if (!frame || frame.parentId !== undefined) return;
    const frameId = boundedId(frame.id);
    const loaderId = boundedId(frame.loaderId);
    const identity =
      typeof frame.url === 'string' && frame.url.length <= 2048
        ? options.classifyUrl(frame.url)
        : null;
    if (!frameId || !loaderId || !identity?.watchDocumentSha256) return;
    commits.push({ frameId, loaderId, watchSha: identity.watchDocumentSha256 });
    if (commits.length > MAX_COMMITS) commits.shift();
  };
  const onLog = (payload: unknown) => {
    if (!active) return;
    const entry = record(record(payload)?.entry);
    if (typeof entry?.text !== 'string' || entry.text.length > 4096) return;
    const warning = options.classifyWarning(entry.text);
    if (!warning.ownedResourcePath) return;
    if (warnings.length >= MAX_WARNINGS) {
      warningOverflow = Math.min(65_535, warningOverflow + 1);
      return;
    }
    warnings.push({
      path: warning.ownedResourcePath,
      reportedWatchSha: warning.reportedFrameDocumentSha256,
      requestId: boundedId(entry.networkRequestId),
    });
  };
  const started = Date.now();
  let created: Promise<Session>;
  try {
    created = options.createSession();
  } catch {
    created = Promise.reject(new Error('CDP session unavailable'));
  }
  const creation = await within(created, SETUP_MS);
  if (creation.ok) {
    session = creation.value;
    try {
      listen('Log.entryAdded', onLog);
      listen('Network.requestWillBeSent', onRequest);
      listen('Network.responseReceived', onResponse);
      listen('Network.responseReceivedExtraInfo', onExtraInfo);
      listen('Network.loadingFailed', onFailed);
      listen('Network.loadingFinished', onFinished);
      listen('Page.frameNavigated', onFrame);
      const enabled = await within(
        Promise.all([
          session.send('Log.enable'),
          session.send('Network.enable'),
          session.send('Page.enable'),
        ]),
        SETUP_MS - (Date.now() - started)
      );
      state = enabled.ok ? 'ready' : 'unavailable';
    } catch {
      state = 'unavailable';
    }
  } else {
    void created.then(
      (late) => late.detach().catch(() => {}),
      () => {}
    );
  }
  if (state !== 'ready') {
    active = false;
    requests.clear();
    warnings.length = 0;
    commits.length = 0;
  }
  return {
    finish: async () => {
      active = false;
      for (const [event, listener] of listeners) {
        try {
          session?.off(event, listener);
        } catch {
          /* Closed page or CDP session. */
        }
      }
      let detached: Awaited<ReturnType<typeof within<void>>> | null = null;
      if (session) {
        try {
          detached = await within(session.detach(), CLEANUP_MS);
        } catch {
          detached = { ok: false };
        }
      }
      const committedDocuments = commits.map((commit) => {
        const matches = [...requests.values()].filter(
          (item) =>
            item.watchSha === commit.watchSha &&
            item.frameId === commit.frameId &&
            item.loaderId === commit.loaderId
        );
        const exact = matches.length === 1 ? matches[0] : null;
        const complete =
          exact?.policy &&
          exact.extraInfoCount === 1 &&
          exact.redirectCount === 0 &&
          exact.responseStatus !== null &&
          exact.extraStatus === exact.responseStatus &&
          exact.responseHasExtraInfo === true;
        return {
          watchDocumentSha256: commit.watchSha,
          frameIdSha256: digest(commit.frameId),
          loaderIdSha256: digest(commit.loaderId),
          requestIdSha256: exact ? digest(exact.id) : null,
          responseStatus: exact?.responseStatus ?? null,
          headerCompleteness: complete ? 'complete-actual' : 'unknown',
          policy: complete
            ? exact.policy
            : Object.fromEntries(POLICY_NAMES.map((name) => [name, unknownHeader()])),
        };
      });
      return {
        status: state,
        cleanup: detached === null ? 'no-session' : detached.ok ? 'detached' : 'unverified',
        requestOverflow,
        warningOverflow,
        committedDocuments,
        requests: [...requests.values()].map((item) => ({
          requestIdSha256: digest(item.id),
          ownedResourcePath: item.path,
          watchDocumentSha256: item.watchSha,
          frameIdSha256: item.frameId ? digest(item.frameId) : null,
          loaderIdSha256: item.loaderId ? digest(item.loaderId) : null,
          redirectCount: item.redirectCount,
          responseStatus: item.responseStatus,
          responseHasExtraInfo: item.responseHasExtraInfo,
          extraInfoCount: item.extraInfoCount,
          outcome: item.failed ? 'failed' : item.finished ? 'finished' : 'unknown',
          blockedReason: item.blockedReason,
        })),
        warnings: warnings.map((warning) => {
          const linked = warning.requestId ? requests.get(warning.requestId) : null;
          const matching = linked?.path === warning.path ? linked : null;
          const committedMainFrame =
            matching && warning.reportedWatchSha
              ? commits.some(
                  (commit) =>
                    commit.watchSha === warning.reportedWatchSha &&
                    commit.frameId === matching.frameId &&
                    commit.loaderId === matching.loaderId
                )
              : null;
          return {
            ownedResourcePath: warning.path,
            reportedFrameDocumentSha256: warning.reportedWatchSha,
            networkRequestIdPresent: warning.requestId !== null,
            requestIdSha256: warning.requestId ? digest(warning.requestId) : null,
            join: !warning.requestId
              ? 'unknown'
              : !matching
                ? 'unknown'
                : matching.failed
                  ? 'linked-failure'
                  : matching.finished &&
                      matching.responseStatus !== null &&
                      matching.responseStatus >= 200 &&
                      matching.responseStatus < 300
                    ? 'linked-success'
                    : 'linked-incomplete',
            committedMainFrame,
          };
        }),
      };
    },
  };
}
