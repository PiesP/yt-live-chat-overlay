// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';

export interface LiveDiagnosticEntry {
  level?: string;
  type?: string;
  text: string;
  url?: string;
}

/** Select an in-range move that differs materially from current playback. */
export function selectPublicSeekTarget(
  { currentTime, start, end }: { currentTime: number; start: number; end: number },
  { preferBackward = false }: { preferBackward?: boolean } = {}
) {
  if (![currentTime, start, end].every(Number.isFinite) || end - start < 5) return null;
  const backward = Math.max(start + 1, currentTime - 3);
  if (preferBackward && backward <= end - 1 && currentTime - backward >= 1) return backward;
  const forward = Math.min(end - 1, Math.max(start + 1, currentTime + 3));
  if (Math.abs(forward - currentTime) >= 1) return forward;
  return backward <= end - 1 && Math.abs(backward - currentTime) >= 1 ? backward : null;
}

/** Browser-only public page probe; keep this function free of module captures. */
export function readPublicPageBrowserState() {
  const initialData = window.ytInitialData as Record<string, unknown> | undefined;
  const nestedRenderer = (
    initialData?.contents as
      | {
          twoColumnWatchNextResults?: {
            conversationBar?: {
              liveChatRenderer?: { isReplay?: boolean; continuations?: unknown };
            };
          };
        }
      | undefined
  )?.twoColumnWatchNextResults?.conversationBar?.liveChatRenderer;
  let renderer = nestedRenderer;
  if (!renderer && initialData && typeof initialData === 'object') {
    const pending: Record<string, unknown>[] = [initialData];
    const seen = new Set<Record<string, unknown>>();
    for (let visited = 0; pending.length && visited < 1000; visited++) {
      const value = pending.pop();
      if (!value || typeof value !== 'object' || seen.has(value)) continue;
      seen.add(value);
      const found = value.liveChatRenderer as
        | { isReplay?: boolean; continuations?: unknown }
        | undefined;
      if (found?.continuations) {
        renderer = found;
        break;
      }
      for (const child of Object.values(value)) {
        if (child && typeof child === 'object') pending.push(child as Record<string, unknown>);
      }
    }
  }
  const hostname = new URL(location.href).hostname;
  return {
    chatMode: renderer ? (renderer.isReplay === true ? 'replay' : 'live') : 'unknown',
    chatRendererFound: Boolean(renderer),
    playabilityStatus:
      (
        window as Window & {
          ytInitialPlayerResponse?: { playabilityStatus?: { status?: string } };
        }
      ).ytInitialPlayerResponse?.playabilityStatus?.status ?? null,
    loginRedirect: hostname === 'accounts.google.com',
    consentRedirect: hostname === 'consent.youtube.com' || hostname === 'consent.google.com',
  };
}

/** Accept the product's policy fallback only when the public page records it. */
export function isTrustedTypesWorkerBlock(entry: LiveDiagnosticEntry): boolean {
  return (
    (entry.level ?? entry.type) === 'error' &&
    (/^This document requires ['"]TrustedScriptURL['"] assignment\. The action has been blocked\./.test(
      entry.text
    ) ||
      /^Content-Security-Policy: The page.s settings blocked assigning to an injection sink because it violates the following directive: .require-trusted-types-for/.test(
        entry.text
      ))
  );
}

export function countUnexpectedLiveErrors(
  entries: LiveDiagnosticEntry[],
  workerPolicyFallback: boolean
): number {
  return entries.filter(
    (entry) =>
      (entry.level ?? entry.type) === 'error' &&
      !(workerPolicyFallback && isTrustedTypesWorkerBlock(entry)) &&
      !isYouTubeHostError(entry)
  ).length;
}

/** These native YouTube media, ad, and site-module requests are outside the overlay. */
export function isYouTubeHostError(entry: LiveDiagnosticEntry): boolean {
  if ((entry.level ?? entry.type) !== 'error') return false;
  const text = entry.text;
  if (
    /^Failed to load .https:\/\/www\.youtube\.com\/s\/_\/ytmainappweb\/_\/js\//.test(text) &&
    text.endsWith('A ServiceWorker intercepted the request and encountered an unexpected error.')
  )
    return true;
  const resourceFailure = text.startsWith('Failed to load resource:');
  const corsFailure =
    text.startsWith(
      'Cross-Origin Request Blocked: The Same Origin Policy disallows reading the remote resource at '
    ) ||
    text.startsWith("Access to fetch at '") ||
    text.startsWith("Access to XMLHttpRequest at '");
  if (!resourceFailure && !corsFailure) return false;
  const target = resourceFailure ? entry.url : text.match(/https:\/\/[^\s‘’'"<>]+/)?.[0];
  if (!target) return false;
  try {
    const url = new URL(target);
    return (
      (url.hostname.endsWith('.googlevideo.com') && url.pathname === '/videoplayback') ||
      (['googleads.g.doubleclick.net', 'www.youtube.com'].includes(url.hostname) &&
        url.pathname.startsWith('/pagead/viewthroughconversion/')) ||
      (url.hostname === 'ad.doubleclick.net' && url.pathname.startsWith('/ddm/trackimp/')) ||
      (url.hostname === 'accounts.google.com' && url.pathname === '/ServiceLogin') ||
      (url.hostname === 'www.youtube.com' && url.pathname.startsWith('/s/_/ytmainappweb/_/js/'))
    );
  } catch {
    return false;
  }
}

export function redactDiagnosticText(text: string): string {
  return text
    .replace(/https?:\/\/[^\s‘’'"<>]+/g, (value) => {
      try {
        const url = new URL(value);
        url.search = '';
        url.hash = '';
        url.pathname = url.pathname.split(';')[0] ?? '';
        return url.href;
      } catch {
        return value;
      }
    })
    .slice(0, 1000);
}

export function validateLiveRenderer(
  renderer: string,
  installation: 'extension' | 'userscript',
  diagnostics: LiveDiagnosticEntry[],
  bridgeReady = false
): { renderer: string; workerPolicyFallback: boolean } {
  if (installation === 'extension')
    assert(bridgeReady, 'The installed extension bridge is missing');
  const appWorkerFailure = diagnostics.some(({ text }) =>
    text.startsWith('[RenderWorkerManager] renderer.worker.creation-failed')
  );
  const workerBlock = diagnostics.some((entry) => {
    if (!isTrustedTypesWorkerBlock(entry)) return false;
    if (appWorkerFailure) return true;
    try {
      const url = new URL(entry.url ?? '');
      return (
        ['chrome-extension:', 'moz-extension:'].includes(url.protocol) &&
        url.pathname === '/page-script.js'
      );
    } catch {
      return false;
    }
  });
  const workerPolicyFallback = installation === 'extension' && renderer === 'main' && workerBlock;
  assert(
    (installation === 'userscript' && renderer === 'main') ||
      (installation === 'extension' && renderer === 'worker') ||
      workerPolicyFallback,
    'The installed application did not prove its expected renderer or page-policy fallback'
  );
  return { renderer, workerPolicyFallback };
}
