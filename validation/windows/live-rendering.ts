// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';

export interface LiveDiagnosticEntry {
  level?: string;
  type?: string;
  text: string;
  url?: string;
}

export type PublicCanvasFrame = {
  width: number;
  height: number;
  active: number;
  dropped: number;
  visiblePixels: number;
};

export type PublicImageDraw = {
  url: string;
  sourceType: 'image' | 'derived-canvas';
  naturalWidth: number;
  naturalHeight: number;
  pixelAlpha: number;
};

export type PublicImageResponse = {
  url: string;
  status: number;
  contentType: string;
};

/** Browser-only public-page probe; the wrapper always calls the native draw first. */
export function installPublicImageDrawProbe(): void {
  const probeWindow = window as Window & { __ytPublicImageDraws?: PublicImageDraw[] };
  const draws: PublicImageDraw[] = [];
  probeWindow.__ytPublicImageDraws = draws;
  const derivedSources = new WeakMap<object, string>();
  const sourceUrl = (image: CanvasImageSource): string | null => {
    if (image instanceof HTMLImageElement) return image.currentSrc || image.src || null;
    return typeof image === 'object' && image !== null ? (derivedSources.get(image) ?? null) : null;
  };

  if (typeof OffscreenCanvasRenderingContext2D !== 'undefined') {
    const offscreen = OffscreenCanvasRenderingContext2D.prototype as unknown as {
      drawImage: (image: CanvasImageSource, ...args: number[]) => void;
    };
    const nativeOffscreenDraw = offscreen.drawImage;
    offscreen.drawImage = function (
      this: OffscreenCanvasRenderingContext2D,
      image: CanvasImageSource,
      ...args: number[]
    ): void {
      nativeOffscreenDraw.call(this, image, ...args);
      const url = sourceUrl(image);
      if (url && image instanceof HTMLImageElement) derivedSources.set(this.canvas, url);
    };
  }

  const canvas = CanvasRenderingContext2D.prototype as unknown as {
    drawImage: (image: CanvasImageSource, ...args: number[]) => void;
  };
  const nativeCanvasDraw = canvas.drawImage;
  canvas.drawImage = function (
    this: CanvasRenderingContext2D,
    image: CanvasImageSource,
    ...args: number[]
  ): void {
    nativeCanvasDraw.call(this, image, ...args);
    if (!this.canvas.closest('#yt-live-chat-overlay') || draws.length >= 16) return;
    const url = sourceUrl(image);
    if (!url || draws.some((draw) => draw.url === url)) return;
    const naturalWidth =
      image instanceof HTMLImageElement
        ? image.naturalWidth
        : 'width' in image && typeof image.width === 'number'
          ? image.width
          : 0;
    const naturalHeight =
      image instanceof HTMLImageElement
        ? image.naturalHeight
        : 'height' in image && typeof image.height === 'number'
          ? image.height
          : 0;
    if (naturalWidth < 1 || naturalHeight < 1) return;
    const destination =
      args.length === 2
        ? [args[0], args[1], naturalWidth, naturalHeight]
        : args.length === 4
          ? args
          : args.length === 8
            ? args.slice(4)
            : null;
    if (!destination || destination.some((value) => !Number.isFinite(value))) return;
    const [x = 0, y = 0, width = 0, height = 0] = destination;
    if (width <= 0 || height <= 0) return;
    const transform = this.getTransform();
    const midX = x + width / 2;
    const midY = y + height / 2;
    const pixelX = Math.floor(transform.a * midX + transform.c * midY + transform.e);
    const pixelY = Math.floor(transform.b * midX + transform.d * midY + transform.f);
    if (pixelX < 0 || pixelY < 0 || pixelX >= this.canvas.width || pixelY >= this.canvas.height)
      return;
    try {
      const pixelAlpha = this.getImageData(pixelX, pixelY, 1, 1).data[3] ?? 0;
      if (pixelAlpha <= 8) return;
      draws.push({
        url,
        sourceType: image instanceof HTMLImageElement ? 'image' : 'derived-canvas',
        naturalWidth,
        naturalHeight,
        pixelAlpha,
      });
    } catch {
      // A tainted or unavailable canvas cannot establish visible image pixels.
    }
  };
}

/** Read actual overlay backing pixels and debug counters without injecting messages. */
export function readPublicCanvasFrame(): PublicCanvasFrame | null {
  const canvas = document.querySelector('#yt-live-chat-overlay canvas');
  const debug = document.querySelector('#yt-chat-overlay-debug')?.textContent ?? '';
  const active = /\bActive:\s*(\d+)\b/u.exec(debug)?.[1];
  const dropped = /\bDrop:\s*(\d+)\b/u.exec(debug)?.[1];
  if (!(canvas instanceof HTMLCanvasElement) || active === undefined || dropped === undefined)
    return null;
  if (canvas.width < 1 || canvas.height < 1 || canvas.width * canvas.height > 4_194_304)
    return null;
  let visiblePixels = 0;
  try {
    const context = canvas.getContext('2d');
    if (!context) return null;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let index = 3; index < pixels.length && visiblePixels < 16; index += 4)
      if ((pixels[index] ?? 0) > 8) visiblePixels++;
  } catch {
    return null;
  }
  return {
    width: canvas.width,
    height: canvas.height,
    active: Number(active),
    dropped: Number(dropped),
    visiblePixels,
  };
}

/** Return a precise failure reason; one paused resize is not a capacity-exhaustion claim. */
export function assessPublicResize(
  before: PublicCanvasFrame | null,
  after: PublicCanvasFrame | null
): string | null {
  if (!before || !after) return 'canvas-or-debug-unavailable';
  if (
    [before, after].some((frame) =>
      Object.values(frame).some((value) => !Number.isSafeInteger(value) || value < 0)
    ) ||
    before.width < 1 ||
    before.height < 1 ||
    after.width < 1 ||
    after.height < 1
  )
    return 'canvas-or-debug-invalid';
  if (before.active < 1 || before.visiblePixels < 1) return 'visible-message-unavailable';
  if (Math.abs(after.width - before.width) < 32 && Math.abs(after.height - before.height) < 32)
    return 'canvas-size-unchanged';
  if (after.active < before.active || after.active < 1) return 'active-message-lost';
  if (after.visiblePixels < 1) return 'visible-canvas-ink-lost';
  return null;
}

export function isPublicImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      ['ggpht.com', 'googleusercontent.com', 'gstatic.com', 'ytimg.com'].some(
        (suffix) => parsed.hostname === suffix || parsed.hostname.endsWith('.' + suffix)
      )
    );
  } catch {
    return false;
  }
}

/** Accept only an actual CDN image response whose source was drawn on the overlay canvas. */
export function assessPublicImage(
  draws: PublicImageDraw[],
  responses: PublicImageResponse[]
):
  | { status: 'passed'; draw: PublicImageDraw; response: PublicImageResponse }
  | { status: 'unverified'; reason: string } {
  const qualifiedDraws = draws.filter(
    (draw) =>
      isPublicImageUrl(draw.url) &&
      Number.isSafeInteger(draw.naturalWidth) &&
      draw.naturalWidth > 0 &&
      Number.isSafeInteger(draw.naturalHeight) &&
      draw.naturalHeight > 0 &&
      Number.isSafeInteger(draw.pixelAlpha) &&
      draw.pixelAlpha > 8 &&
      draw.pixelAlpha <= 255
  );
  for (const draw of qualifiedDraws) {
    const response = responses.find(
      (item) =>
        item.url === draw.url &&
        item.status >= 200 &&
        item.status < 300 &&
        /^image\//iu.test(item.contentType)
    );
    if (response) return { status: 'passed', draw, response };
  }
  return {
    status: 'unverified',
    reason:
      qualifiedDraws.length === 0
        ? 'public-image-draw-unverified'
        : 'public-image-response-unverified',
  };
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
