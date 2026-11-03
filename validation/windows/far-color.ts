// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BrowserContext, Page } from '@playwright/test';

import { restoreFixtureSettings } from './fixture-settings.ts';
import {
  installNativePageScriptProbe,
  type NativePageScriptProbe,
} from './native-page-script-probe.ts';
import { buildVisibleWatchHtml } from './visible-watch.ts';

const URL = 'https://www.youtube.com/watch?v=windows410FarColor';
const ID = 'WINDOWS410_FAR_A'; // The unchanged production hash assigns 0.52563691069372 -> FAR.
const ENTRY = '\n\tmain();\n';
type Draw = { id: string; color: string; tier: number; fills: string[]; pixels: number[][] };
type Proof = { draws: Draw[]; workerReady: boolean; workerAttempted: boolean; overflow: number };

declare global {
  interface Window {
    __ytFarColor?: Proof;
  }
}

export async function readFarColorSelector(root: string): Promise<boolean> {
  try {
    const value: unknown = JSON.parse(
      await readFile(join(root, 'validation/windows/inputs/far-color.json'), 'utf8')
    );
    assert.deepEqual(value, { scenario: 'far-color' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Validate only positive-alpha pixels matching the independently specified text RGB. */
export function assertFarColorPixels(
  pixels: readonly number[][],
  rgb: readonly number[],
  alphaUpperBound?: number
): { matchedPixels: number; maxAlpha: number; alphaUpperBound: number | null } {
  const matched = pixels.filter(
    (pixel) =>
      (pixel[3] ?? 0) > 0 &&
      rgb.every((channel, index) => Math.abs(channel - (pixel[index] ?? -100)) <= 4)
  );
  assert(matched.length > 0, `Visible pixels disagree with RGB ${rgb.join(',')}`);
  const maxAlpha = Math.max(...matched.map((pixel) => pixel[3] ?? 0));
  if (alphaUpperBound !== undefined) {
    assert(
      maxAlpha <= alphaUpperBound,
      `Matched text pixel alpha ${maxAlpha} exceeds ${alphaUpperBound}; the transparent, outline-free fixture requires an unlayered text draw`
    );
  }
  return { matchedPixels: matched.length, maxAlpha, alphaUpperBound: alphaUpperBound ?? null };
}

/** Source-bound observation: retain successful real text draws and nontransparent row pixels. */
function installColorRuntime(worker: boolean): void {
  type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  const scope = globalThis as typeof globalThis & {
    __ytFarColor: Proof;
    __ytFarRenderer?: {
      activeMessages: { id?: string; message?: { id?: string }; speedTier: number }[];
    };
    __ytFarWrap: (draw: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown;
    postMessage(message: unknown): void;
  };
  const proof: Proof = { draws: [], workerReady: false, workerAttempted: false, overflow: 0 };
  scope.__ytFarColor = proof;
  scope.__ytFarWrap = (draw) =>
    function (this: unknown, ...args) {
      const [rawContext, rawMessage, rawX, rawY, rawConfig] = args;
      const context = rawContext as Context;
      const message = rawMessage as { id?: string };
      const config = rawConfig as { color: string; messageWidth: number; messageHeight: number };
      if (message.id !== 'WINDOWS410_FAR_A') return Reflect.apply(draw, this, args);
      const fills: string[] = [];
      const originalFill = context.fillText;
      context.fillText = function (...fillArgs: Parameters<Context['fillText']>) {
        if (fills.length < 8 && this.globalAlpha > 0) fills.push(String(this.fillStyle));
        return Reflect.apply(originalFill, this, fillArgs);
      };
      let result: unknown;
      try {
        result = Reflect.apply(draw, this, args);
      } finally {
        context.fillText = originalFill;
      }
      const transform = context.getTransform();
      if (
        Number(rawX) < 0 ||
        (Number(rawX) + config.messageWidth) * transform.a > context.canvas.width
      )
        return result;
      const x = Math.max(0, Math.ceil(Number(rawX) * transform.a));
      const y = Math.max(0, Math.ceil(Number(rawY) * transform.d));
      const width = Math.min(
        context.canvas.width - x,
        Math.floor((Number(rawX) + config.messageWidth) * transform.a) - x
      );
      const height = Math.min(
        context.canvas.height - y,
        Math.floor(config.messageHeight * transform.d)
      );
      if (!fills.length || width <= 0 || height <= 0) return result;
      const data = context.getImageData(x, y, width, height).data;
      const pixels: number[][] = [];
      for (let i = 0; i < data.length; i += 4) {
        if ((data[i + 3] ?? 0) < 20) continue;
        pixels.push(Array.from(data.slice(i, i + 4)));
        if (pixels.length === 64) break;
      }
      if (!pixels.length) return result;
      const active = scope.__ytFarRenderer?.activeMessages.find(
        (entry) => (entry.id ?? entry.message?.id) === message.id
      );
      const record: Draw = {
        id: message.id,
        color: config.color,
        tier: active?.speedTier ?? -1,
        fills,
        pixels,
      };
      if (proof.draws.some((entry) => entry.color === record.color && entry.tier === record.tier))
        return result;
      if (proof.draws.length < 16) {
        proof.draws.push(record);
        if (worker) scope.postMessage({ type: 'ytFarColorDraw', record });
      } else proof.overflow++;
      return result;
    };
}

export function observeFarColorPage(source: string): string {
  assert.equal(source.split(ENTRY).length, 2, 'Packaged entry changed');
  assert(source.includes('function renderRegularMessage('));
  return source.replace(
    ENTRY,
    `\n\t renderRegularMessage = window.__ytFarWrap(renderRegularMessage);\n\tconst farRender = CanvasRenderer.prototype.renderFrame;\n\tCanvasRenderer.prototype.renderFrame = function(...args) { window.__ytFarRenderer = this; return Reflect.apply(farRender, this, args); };${ENTRY}`
  );
}

function regularPainter(source: string): string {
  if (source.includes('function renderRegularMessage(')) return 'renderRegularMessage';
  const matches = [
    ...source.matchAll(/function ([A-Za-z_$][\w$]*)\(e,t,n,r,i,a,o,s,c,l,u,d,f,p=`0px`\)\{/gu),
  ].filter((match) => source.slice(match.index, match.index + 1800).includes('t.content.length>0'));
  if (matches.length !== 1) throw new Error('Packaged Worker regular painter changed');
  const name = matches[0]?.[1];
  if (!name) throw new Error('Packaged Worker painter name unavailable');
  return name;
}

/** Instrument only the production Worker Blob; preserve its handler and classifier. */
export function farColorPrelude(forceFallback: boolean): string {
  const runtime = installColorRuntime.toString();
  const painter = regularPainter.toString();
  return (
    `;(${installColorRuntime.toString()})(false);\n` +
    `
    const runtime = ${JSON.stringify(runtime)};
    const painter = ${painter};
    const NativeBlob = Blob;
    globalThis.Blob = new Proxy(NativeBlob, { construct(target, args) {
      const [parts, options] = args;
      if (options?.type === 'text/javascript' && parts?.length === 1 && typeof parts[0] === 'string' && parts[0].includes('OffscreenCanvas')) {
        const source = parts[0];
        const handler = /self\\.onmessage=([A-Za-z_$][\\w$]*)=>\\{([A-Za-z_$][\\w$]*)\\.handleMessage\\(\\1\\)\\};?\\s*$/.exec(source);
        if (!handler) throw new Error('Packaged Worker handler changed');
        const name = painter(source);
        const suffix = '\\n;(' + runtime + ')(true);globalThis.__ytFarRenderer=' + handler[2] + ';' + name + '=globalThis.__ytFarWrap(' + name + ');';
        return Reflect.construct(target, [[source + suffix], options]);
      }
      return Reflect.construct(target, args);
    }});
    const NativeWorker = Worker;
    globalThis.Worker = new Proxy(NativeWorker, { construct(target, args) {
      window.__ytFarColor.workerAttempted = true;
      if (${forceFallback}) throw new DOMException('FAR fixture selected Main fallback', 'SecurityError');
      const worker = Reflect.construct(target, args);
      worker.addEventListener('message', event => {
        if (event.data?.type === 'ready') window.__ytFarColor.workerReady = true;
        if (event.data?.type === 'ytFarColorDraw') {
          const proof = window.__ytFarColor;
          if (proof.draws.length < 16) proof.draws.push(event.data.record); else proof.overflow++;
        }
      });
      return worker;
    }});
    Object.defineProperty(HTMLMediaElement.prototype, 'paused', { configurable: true, get: () => false });
    window.ytcfg = { data_: { INNERTUBE_API_KEY: 'fixture', INNERTUBE_CONTEXT_CLIENT_NAME: '1', INNERTUBE_CONTEXT_CLIENT_VERSION: '1.0', INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: '1.0' } } } };
    window.ytInitialData = { currentVideoEndpoint: { watchEndpoint: { videoId: 'windows410FarColor' } }, contents: { twoColumnWatchNextResults: { conversationBar: { liveChatRenderer: { isReplay: false, continuations: [{ timedContinuationData: { continuation: 'far-color', timeoutMs: 30000 } }] } } } } };
  `
  );
}

/** Native document_end delivery continues asynchronously after DOMContentLoaded. */
export async function waitForFarColorPageReady(
  page: Pick<Page, 'locator' | 'waitForFunction'>,
  probe: Pick<NativePageScriptProbe, 'assertInjected' | 'restore'>
): Promise<void> {
  await page
    .locator('#yt-live-chat-overlay canvas')
    .waitFor({ state: 'attached', timeout: 15_000 });
  await page.waitForFunction(() => Boolean(window.__ytChatOverlay?.getSettings), undefined, {
    timeout: 15_000,
  });
  // Keep the exact native-injection assertion after the production readiness barriers.
  await probe.assertInjected();
  await probe.restore();
}

export async function runFarColorFixture({
  context,
  root,
  output,
  extensionId,
}: {
  context: BrowserContext;
  root: string;
  output: string;
  extensionId: string;
}) {
  const source = await readFile(join(root, 'dist-extension/page-script.js'), 'utf8');
  const html = buildVisibleWatchHtml(
    await readFile(join(root, 'test/visual/preview.html'), 'utf8'),
    'FAR color fixture'
  );
  const observations: Record<string, unknown>[] = [];
  const cleanup: Record<string, unknown>[] = [];
  let failure: unknown;
  try {
    for (const backend of ['worker', 'main'] as const) {
      const page = await context.newPage();
      let probe: Awaited<ReturnType<typeof installNativePageScriptProbe>> | undefined;
      let previous: ReturnType<NonNullable<Window['__ytChatOverlay']>['getSettings']> | undefined;
      const errors: string[] = [];
      const captures: string[] = [];
      const observation: Record<string, unknown> = { backend, errors, captures };
      observations.push(observation);
      page.on('pageerror', (error) => {
        if (errors.length < 16) errors.push(error.message);
      });
      page.on('console', (entry) => {
        if (entry.type() === 'error' && errors.length < 16)
          errors.push(entry.text().slice(0, 2000));
      });
      try {
        await page.setViewportSize({ width: 1000, height: 900 });
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        let delivered = false;
        await page.route('**/*', async (route) => {
          const url = new globalThis.URL(route.request().url());
          if (url.protocol === 'chrome-extension:' && url.hostname === extensionId)
            return route.continue();
          if (url.href === URL && route.request().resourceType() === 'document')
            return route.fulfill({ contentType: 'text/html', body: html });
          if (url.pathname.includes('/live_chat/')) {
            const actions =
              url.searchParams.has('far410') && !delivered
                ? [
                    {
                      addChatItemAction: {
                        item: {
                          liveChatTextMessageRenderer: {
                            id: ID,
                            timestampUsec: String(Date.now() * 1000),
                            authorExternalChannelId: 'far410-author',
                            authorName: { simpleText: 'Fixture' },
                            authorNameTextColor: 4278190335,
                            message: { runs: [{ text: 'FAR COLOR PROOF' }] },
                          },
                        },
                      },
                    },
                  ]
                : [];
            if (actions.length) delivered = true;
            return route.fulfill({
              contentType: 'application/json',
              json: {
                continuationContents: {
                  liveChatContinuation: {
                    actions,
                    continuations: [
                      { timedContinuationData: { continuation: 'far-next', timeoutMs: 30000 } },
                    ],
                  },
                },
              },
            });
          }
          return route.fulfill({ status: 204 });
        });
        await page.addInitScript({
          content: farColorPrelude(backend === 'main'),
        });
        const navigate = async () => {
          observation.navigationStage = 'install-native-probe';
          probe = await installNativePageScriptProbe({
            context,
            root,
            extensionId,
            fixtureUrl: URL,
            instrumentedSource: observeFarColorPage(source),
          });
          observation.probeProvenance = probe.provenance;
          await probe.assertReady();
          observation.navigationStage = 'native-probe-ready';
          await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
          observation.navigationStage = 'document-loaded-awaiting-production-readiness';
          await waitForFarColorPageReady(page, probe);
          observation.navigationStage = 'production-ready-exact-native-injection-verified';
          probe = undefined;
        };
        await navigate();
        previous = await page.evaluate(() => {
          const app = window.__ytChatOverlay;
          if (!app) throw new Error('Fixture app unavailable');
          return app.getSettings();
        });
        const imported = {
          ...previous,
          language: 'en',
          depthLayersEnabled: true,
          preserveUserColor: false,
          danmakuMode: 'scroll',
          fontSize: 48,
          scrollDurationMinMs: 30000,
          scrollDurationMaxMs: 30000,
          safeTop: 0,
          safeBottom: 0,
          opacity: 1,
          depthFarOpacityMul: 1,
          motionBlurEnabled: false,
          translationEnabled: false,
          showAuthor: { ...previous.showAuthor, normal: false },
          outline: { ...previous.outline, enabled: false },
          colors: { ...previous.colors, normal: '#f008' },
          backgroundColors: { ...previous.backgroundColors, normal: '#00000000' },
        };
        await page.locator('#movie_player').hover();
        await page.locator('#yt-chat-overlay-settings-button').click();
        const chooser = page.waitForEvent('filechooser');
        await page.locator('button[data-action="import"]').click();
        await (
          await chooser
        ).setFiles({
          name: 'far-color-settings.json',
          mimeType: 'application/json',
          buffer: Buffer.from(JSON.stringify(imported)),
        });
        await page.waitForFunction(
          () => window.__ytChatOverlay?.getSettings().colors.normal === '#f008'
        );
        await page.locator('button.yt-chat-overlay-settings-close').click();
        await page.evaluate(async () => {
          await window.__ytChatOverlay?.stop();
        });
        await navigate(); // Real durable reload, with the source-bound observer installed again.
        const persisted = await page.evaluate(
          () => window.__ytChatOverlay?.getSettings().colors.normal
        );
        assert.equal(persisted, '#f008');
        delivered = false;
        await page.evaluate(async () => {
          const response = await fetch('/youtubei/v1/live_chat/get_live_chat?far410=1');
          await response.json();
        });
        const waitColor = async (
          color: string,
          rgb: number[],
          capture?: string,
          alphaUpperBound?: number
        ) => {
          await page.waitForFunction(
            (expected) =>
              window.__ytFarColor?.draws.some(
                (draw) =>
                  draw.color === expected &&
                  draw.tier === 0 &&
                  draw.pixels.some((pixel) => (pixel[3] ?? 0) > 0)
              ),
            color,
            { timeout: 20000 }
          );
          const record = await page.evaluate(
            (expected) => window.__ytFarColor?.draws.find((draw) => draw.color === expected),
            color
          );
          assert(record);
          assert(record.fills.length > 0);
          const pixelProof = assertFarColorPixels(record.pixels, rgb, alphaUpperBound);
          if (capture) {
            const name = `far-color-${backend}-${capture}.png`;
            await page.screenshot({ path: join(output, name) });
            captures.push(name);
          }
          return { ...record, pixelProof };
        };
        // #f008 expands to #ff000088: the independent encoded alpha ceiling is 0x88 = 136.
        const alpha = await waitColor(
          'rgba(201,23,23,0.5333333333333333)',
          [201, 23, 23],
          'alpha',
          136
        );
        await page.evaluate(() => {
          const app = window.__ytChatOverlay;
          if (!app) throw new Error('Fixture app unavailable');
          app.applySettings({ colors: { ...app.getSettings().colors, normal: '#ff0000' } });
        });
        const configured = await waitColor('rgb(201,23,23)', [201, 23, 23]);
        await page.evaluate(() =>
          window.__ytChatOverlay?.applySettings({ preserveUserColor: true })
        );
        const preserved = await waitColor('rgb(9,9,187)', [9, 9, 187], 'user');
        const proof = await page.evaluate(() => window.__ytFarColor);
        assert(proof);
        assert.equal(proof.workerReady, backend === 'worker');
        assert.equal(proof.workerAttempted, true);
        assert.equal(proof.overflow, 0);
        assert.deepEqual(errors, []);
        Object.assign(observation, {
          backend,
          persisted,
          alpha,
          configured,
          preserved,
          proof,
          captures,
          nativeSourceSha256: createHash('sha256').update(source).digest('hex'),
        });
      } catch (error) {
        observation.error = String(error);
        try {
          observation.partialProof = await page.evaluate(() => window.__ytFarColor);
        } catch (snapshotError) {
          observation.snapshotError = String(snapshotError);
        }
        throw error;
      } finally {
        const retired: Record<string, unknown> = { backend };
        try {
          if (probe) await probe.restore();
          retired.probeRestored = true;
        } finally {
          try {
            if (previous) await restoreFixtureSettings(context, page, extensionId, previous);
            retired.settingsRestored = Boolean(previous);
          } finally {
            await page.close();
            retired.pageClosed = page.isClosed();
            cleanup.push(retired);
          }
        }
      }
    }
  } catch (error) {
    failure = error;
  }
  const result = {
    status: failure ? 'failed' : 'passed',
    scope:
      'installed Edge production Worker and forced Main fallback, controlled YouTube-shaped fixture',
    id: ID,
    observations,
    cleanup,
    visualReview: 'pending',
    error: failure ? String(failure) : null,
  };
  await writeFile(join(output, 'far-color.json'), JSON.stringify(result, null, 2));
  if (failure) throw failure;
  return result;
}
