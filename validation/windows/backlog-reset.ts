// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BrowserContext, Page, Route } from '@playwright/test';

import { restoreFixtureSettings } from './fixture-settings.ts';
import {
  installNativePageScriptProbe,
  type NativePageScriptProbe,
} from './native-page-script-probe.ts';
import { buildVisibleWatchHtml } from './visible-watch.ts';

const FIXTURE_URL = 'https://www.youtube.com/watch?v=windows405BacklogReset';
const ENTRY_MARKER = '\n\tmain();\n';
const PREFIX = 'WINDOWS405_BACKLOG_';
const BATCH_SIZE = 51;
// Parser retains all 51; after the first high at 31, the remaining 20 plus
// the second batch still fit in the production controller's pending capacity.
const QUEUE_MAX_SIZE = 100;
const CONGESTION_QUEUE_LENGTH = 30;
const MAX_EVENTS = 128;
// Two 51-action batches fit, with room to record duplicate deliveries before failing.
const MAX_DELIVERIES = 160;
const MAX_REPLAYS = 128;
const MAX_LIFECYCLE = 16;
const MAX_RUN_MS = 150_000;

type PauseEvent = {
  paused: boolean;
  before: boolean;
  atMs: number;
  queueLength: number;
  pending: number;
  phase: string;
  resetPhase: string;
  rendererPaused: boolean;
  callbackMatches: boolean;
};
type PresentationRecord = { id: string; phase: string; accepted: boolean };
type BacklogState = {
  sourceBound: boolean;
  manager: {
    renderer: {
      onBacklogPauseChange: ((paused: boolean) => void) | null;
      backlogPaused: boolean;
      getQueueLength(): number;
      overlay: { getUserPauseState(): boolean };
      settings: {
        queueMaxSize: number;
        backlogPauseThreshold: number;
        fontSize: number;
        opacity: number;
        superChatLayout: string;
      };
    } | null;
    backlogController: {
      paused: boolean;
      isBacklogActive: boolean;
      drainPending(): Array<{ id?: string }>;
    } | null;
  } | null;
  renderer: NonNullable<BacklogState['manager']>['renderer'];
  controller: NonNullable<BacklogState['manager']>['backlogController'];
  callback: ((paused: boolean) => void) | null;
  workerAttempts: Array<{ type: string; error: string }>;
  workerOverflow: number;
  phase: string;
  resetPhase: string;
  events: PauseEvent[];
  eventOverflow: number;
  deliveries: PresentationRecord[];
  deliveryOverflow: number;
  replays: PresentationRecord[];
  replayOverflow: number;
  lifecycle: Array<{
    kind: string;
    atMs: number;
    phase: string;
    reason: string | null;
    managerSame: boolean;
    rendererSame: boolean;
    controllerSame: boolean;
    userPaused: boolean | null;
    queueLength: number | null;
  }>;
  lifecycleOverflow: number;
};

declare global {
  interface Window {
    __ytBacklogReset?: BacklogState;
  }
}

function describeError(error: unknown): { message: string; stack: string | null } {
  return {
    message: String(error).slice(0, 2_000),
    stack: error instanceof Error ? (error.stack?.slice(0, 4_000) ?? null) : null,
  };
}

export async function readBacklogResetSelector(root: string): Promise<boolean> {
  let contents: string;
  try {
    contents = await readFile(join(root, 'validation/windows/inputs/backlog-reset.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  assert.deepEqual(JSON.parse(contents), { scenario: 'backlog-reset' });
  return true;
}

function pagePrelude(): void {
  const state: BacklogState = {
    sourceBound: false,
    manager: null,
    renderer: null,
    controller: null,
    callback: null,
    workerAttempts: [],
    workerOverflow: 0,
    phase: 'bootstrap',
    resetPhase: 'idle',
    events: [],
    eventOverflow: 0,
    deliveries: [],
    deliveryOverflow: 0,
    replays: [],
    replayOverflow: 0,
    lifecycle: [],
    lifecycleOverflow: 0,
  };
  window.__ytBacklogReset = state;
  Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
    configurable: true,
    get: () => false,
  });
  const NativeWorker = window.Worker;
  window.Worker = new Proxy(NativeWorker, {
    construct(target, args) {
      const [url, options] = args;
      const bridgeUrl = window.__ytExtensionBridge?.workerUrl;
      if (
        typeof bridgeUrl === 'string' &&
        String(url) === bridgeUrl &&
        bridgeUrl.startsWith('blob:https://www.youtube.com/') &&
        options?.type === 'module'
      ) {
        if (state.workerAttempts.length < 4)
          state.workerAttempts.push({ type: options.type, error: 'SecurityError' });
        else state.workerOverflow++;
        throw new DOMException('Fixture worker-src restriction', 'SecurityError');
      }
      return Reflect.construct(target, args);
    },
  });
  window.ytcfg = {
    data_: {
      INNERTUBE_API_KEY: 'windows-acceptance-key',
      INNERTUBE_CONTEXT_CLIENT_NAME: '1',
      INNERTUBE_CONTEXT_CLIENT_VERSION: '1.0',
      INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: '1.0' } },
    },
  };
  window.ytInitialData = {
    currentVideoEndpoint: { watchEndpoint: { videoId: 'windows405BacklogReset' } },
    contents: {
      twoColumnWatchNextResults: {
        conversationBar: {
          liveChatRenderer: {
            isReplay: false,
            continuations: [
              { timedContinuationData: { continuation: 'windows405-live', timeoutMs: 30_000 } },
            ],
          },
        },
      },
    },
  };
}

function instrument(source: string): string {
  assert.equal(source.split(ENTRY_MARKER).length, 2, 'Packaged page entry changed');
  for (const name of ['CanvasRenderer', 'BacklogInjectionController', 'RuntimeManager'])
    assert(source.includes(`var ${name} = class ${name}`), `Packaged ${name} changed`);
  for (const method of [
    'updateBacklogPause()',
    'setPaused(paused)',
    'ensureBacklogController(renderer)',
    'replayMessage(message)',
    'performOverlayRefresh(reason)',
    'requestManagedRestart(reason)',
  ])
    assert(source.includes(method), `Packaged ${method} changed`);
  const insertion = `
\tconst backlogState = window.__ytBacklogReset;
\tif (!backlogState) throw new Error('Backlog prelude is unavailable');
\tconst recordLifecycle = (kind, manager, reason) => {
\t\tconst renderer = manager.renderer;
\t\tconst event = {
\t\t\tkind, atMs: performance.now(), phase: backlogState.phase,
\t\t\treason: typeof reason === 'string' ? reason : null,
\t\t\tmanagerSame: manager === backlogState.manager,
\t\t\trendererSame: renderer === backlogState.renderer,
\t\t\tcontrollerSame: manager.backlogController === backlogState.controller,
\t\t\tuserPaused: renderer?.overlay.getUserPauseState() ?? null,
\t\t\tqueueLength: renderer?.getQueueLength() ?? null,
\t\t};
\t\tif (backlogState.lifecycle.length < ${MAX_LIFECYCLE}) backlogState.lifecycle.push(event);
\t\telse backlogState.lifecycleOverflow++;
\t};
\tconst acceptedForMain = (renderer, message) =>
\t\trenderer.pendingQueue.toArray().includes(message) ||
\t\trenderer.activeMessages.some((entry) => entry.message === message);
\tconst nativeEnsureBacklog = RuntimeManager.prototype.ensureBacklogController;
\tRuntimeManager.prototype.ensureBacklogController = function(...args) {
\t\tconst result = Reflect.apply(nativeEnsureBacklog, this, args);
\t\tif (!backlogState.controller && this.backlogController) {
\t\t\tbacklogState.manager = this;
\t\t\tbacklogState.renderer = this.renderer;
\t\t\tbacklogState.controller = this.backlogController;
\t\t\tbacklogState.callback = this.renderer?.onBacklogPauseChange ?? null;
\t\t\trecordLifecycle('controller-created', this, null);
\t\t} else if (this.backlogController !== backlogState.controller ||
\t\t\tthis.renderer !== backlogState.renderer || this !== backlogState.manager) {
\t\t\trecordLifecycle('identity-changed', this, null);
\t\t}
\t\treturn result;
\t};
\tconst nativeUpdateSettings = RuntimeManager.prototype.updateSessionSettings;
\tRuntimeManager.prototype.updateSessionSettings = function(...args) {
\t\tbacklogState.resetPhase = 'updating';
\t\ttry { return Reflect.apply(nativeUpdateSettings, this, args); }
\t\tfinally { backlogState.resetPhase = 'complete'; }
\t};
\tconst nativeOverlayRefresh = RuntimeManager.prototype.performOverlayRefresh;
\tRuntimeManager.prototype.performOverlayRefresh = function(reason, ...args) {
\t\trecordLifecycle('overlay-refresh', this, reason);
\t\treturn Reflect.apply(nativeOverlayRefresh, this, [reason, ...args]);
\t};
\tconst nativeManagedRestart = RuntimeManager.prototype.requestManagedRestart;
\tRuntimeManager.prototype.requestManagedRestart = function(reason, ...args) {
\t\trecordLifecycle('managed-restart', this, reason);
\t\treturn Reflect.apply(nativeManagedRestart, this, [reason, ...args]);
\t};
\tconst nativeSetPaused = BacklogInjectionController.prototype.setPaused;
\tBacklogInjectionController.prototype.setPaused = function(paused, ...args) {
\t\tconst before = this.paused;
\t\tconst result = Reflect.apply(nativeSetPaused, this, [paused, ...args]);
\t\tif (this === backlogState.controller) {
\t\t\tconst renderer = backlogState.renderer;
\t\t\tconst event = {
\t\t\t\tpaused: this.paused, before, atMs: performance.now(),
\t\t\t\tqueueLength: renderer?.getQueueLength() ?? -1,
\t\t\t\tpending: this.drainPending().length,
\t\t\t\tphase: backlogState.phase, resetPhase: backlogState.resetPhase,
\t\t\t\trendererPaused: renderer?.backlogPaused === true,
\t\t\t\tcallbackMatches: renderer?.onBacklogPauseChange === backlogState.callback,
\t\t\t};
\t\t\tif (backlogState.events.length < ${MAX_EVENTS}) backlogState.events.push(event);
\t\t\telse backlogState.eventOverflow++;
\t\t}
\t\treturn result;
\t};
\tconst nativeBacklogDelivery = CanvasRenderer.prototype.addMessage;
\tCanvasRenderer.prototype.addMessage = function(message, ...args) {
\t\tconst relevant = this === backlogState.renderer && message?.isBacklog === true &&
\t\t\tmessage?.id?.startsWith(${JSON.stringify(PREFIX)});
\t\tconst result = Reflect.apply(nativeBacklogDelivery, this, [message, ...args]);
\t\tif (relevant) {
\t\t\tif (backlogState.deliveries.length < ${MAX_DELIVERIES})
\t\t\t\tbacklogState.deliveries.push({
\t\t\t\t\tid: message.id, phase: backlogState.phase, accepted: acceptedForMain(this, message),
\t\t\t\t});
\t\t\telse backlogState.deliveryOverflow++;
\t\t}
\t\treturn result;
\t};
\tconst nativeReplay = CanvasRenderer.prototype.replayMessage;
\tCanvasRenderer.prototype.replayMessage = function(message, ...args) {
\t\tconst relevant = this === backlogState.renderer &&
\t\t\tmessage?.id?.startsWith(${JSON.stringify(PREFIX)});
\t\tconst result = Reflect.apply(nativeReplay, this, [message, ...args]);
\t\tif (relevant) {
\t\t\tif (backlogState.replays.length < ${MAX_REPLAYS})
\t\t\t\tbacklogState.replays.push({
\t\t\t\t\tid: message.id, phase: backlogState.phase, accepted: acceptedForMain(this, message),
\t\t\t\t});
\t\t\telse backlogState.replayOverflow++;
\t\t}
\t\treturn result;
\t};
\tbacklogState.sourceBound = true;`;
  return source.replace(ENTRY_MARKER, `${insertion}${ENTRY_MARKER}`);
}

function batchActions(batch: number): unknown[] {
  return Array.from({ length: BATCH_SIZE }, (_, index) => {
    const id = `${PREFIX}${batch}_${index}`;
    return {
      addChatItemAction: {
        item: {
          liveChatTextMessageRenderer: {
            id,
            authorName: { simpleText: `Fixture viewer ${id}` },
            message: { runs: [{ text: `${id} bounded backlog row` }] },
          },
        },
      },
    };
  });
}

function snapshot(page: Page) {
  return page.evaluate(() => {
    const state = window.__ytBacklogReset;
    if (!state) throw new Error('Backlog state is unavailable');
    const renderer = state.renderer;
    const controller = state.controller;
    return {
      sourceBound: state.sourceBound,
      workerAttempts: state.workerAttempts,
      workerOverflow: state.workerOverflow,
      phase: state.phase,
      events: state.events,
      eventOverflow: state.eventOverflow,
      deliveries: state.deliveries,
      deliveryOverflow: state.deliveryOverflow,
      replays: state.replays,
      replayOverflow: state.replayOverflow,
      lifecycle: state.lifecycle,
      lifecycleOverflow: state.lifecycleOverflow,
      managerRetained: state.manager?.backlogController === controller,
      rendererRetained: state.manager?.renderer === renderer,
      callbackMatches: renderer?.onBacklogPauseChange === state.callback,
      callbackPresent: renderer?.onBacklogPauseChange != null,
      rendererPaused: renderer?.backlogPaused ?? null,
      userPaused: renderer?.overlay.getUserPauseState() ?? null,
      queueLength: renderer?.getQueueLength() ?? null,
      settings: renderer?.settings ?? null,
      controllerPaused: controller?.paused ?? null,
      controllerActive: controller?.isBacklogActive ?? null,
      controllerPending: controller?.drainPending().map((message) => message.id ?? null) ?? [],
    };
  });
}

/** Installed Edge extension and packaged Main fallback with a real routed live backlog. */
export async function runBacklogResetFixture({
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
  assert.match(extensionId, /^[a-p]{32}$/u);
  assert(BATCH_SIZE > 50, 'Live seed must enter the production backlog batch path');
  assert(QUEUE_MAX_SIZE > BATCH_SIZE, 'Parser capacity must retain the full live seed');
  const source = await readFile(join(root, 'dist-extension/page-script.js'), 'utf8');
  const instrumented = instrument(source);
  const preview = await readFile(join(root, 'test/visual/preview.html'), 'utf8');
  const html = buildVisibleWatchHtml(preview, 'Backlog reset fixture video');
  const page = await context.newPage();
  const deliveredBatches = new Set<number>();
  const requests: Array<{ batch: number; atMs: number }> = [];
  const routeHits = { first: 0, second: 0 };
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  let pageErrorOverflow = 0;
  let consoleErrorOverflow = 0;
  let routeInstalled = false;
  let nativePageProbe: NativePageScriptProbe | undefined;
  let provenance: NativePageScriptProbe['provenance'] | null = null;
  let originalSettings:
    | ReturnType<NonNullable<Window['__ytChatOverlay']>['getSettings']>
    | undefined;
  let settingsRestoration:
    | 'not-required'
    | 'pending'
    | 'restored'
    | 'failed'
    | 'skipped-page-closed' = 'not-required';
  let primaryError: unknown;
  let stage = 'setup';
  let deadlineExceeded = false;
  const deadline = setTimeout(() => {
    deadlineExceeded = true;
    void page.close().catch(() => {});
  }, MAX_RUN_MS);
  page.on('pageerror', (error) => {
    if (pageErrors.length < 8) pageErrors.push(error.name);
    else pageErrorOverflow++;
  });
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (consoleErrors.length < 12) consoleErrors.push(message.text().slice(0, 300));
    else consoleErrorOverflow++;
  });
  const routeHandler = (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.protocol === 'chrome-extension:' && url.hostname === extensionId)
      return route.continue();
    if (url.href === FIXTURE_URL && request.resourceType() === 'document')
      return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    if (url.hostname === 'www.youtube.com' && url.pathname === '/favicon.ico')
      return route.fulfill({ status: 204 });
    if (
      url.hostname === 'www.youtube.com' &&
      url.pathname === '/youtubei/v1/live_chat/get_live_chat'
    ) {
      const selected = url.searchParams.get('windows405');
      const batch = selected && /^[12]$/u.test(selected) ? Number(selected) : null;
      if (batch === 1) routeHits.first++;
      if (batch === 2) routeHits.second++;
      const firstDelivery = batch !== null && !deliveredBatches.has(batch);
      if (firstDelivery && batch !== null) {
        deliveredBatches.add(batch);
        requests.push({ batch, atMs: Date.now() });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: {
          continuationContents: {
            liveChatContinuation: {
              actions: firstDelivery && batch !== null ? batchActions(batch) : [],
              continuations: [
                { timedContinuationData: { continuation: 'windows405-next', timeoutMs: 30_000 } },
              ],
            },
          },
        },
      });
    }
    return route.fulfill({
      status: 403,
      contentType: 'text/plain',
      body: 'Blocked by backlog fixture',
    });
  };

  const execute = async () => {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.route('**/*', routeHandler);
    routeInstalled = true;
    await page.addInitScript(pagePrelude);
    nativePageProbe = await installNativePageScriptProbe({
      context,
      root,
      extensionId,
      fixtureUrl: FIXTURE_URL,
      instrumentedSource: instrumented,
    });
    provenance = nativePageProbe.provenance;
    await nativePageProbe.assertReady();
    await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page
      .locator('#yt-live-chat-overlay canvas')
      .waitFor({ state: 'attached', timeout: 15_000 });
    await nativePageProbe.assertInjected();
    await nativePageProbe.restore();
    nativePageProbe = undefined;
    await page.waitForFunction(() => window.__ytBacklogReset?.sourceBound === true, undefined, {
      timeout: 5_000,
    });
    const initial = await snapshot(page);
    assert.deepEqual(initial.workerAttempts, [{ type: 'module', error: 'SecurityError' }]);
    assert.equal(initial.workerOverflow, 0);
    assert.equal(initial.controllerPaused, null);

    stage = 'configure';
    originalSettings = await page.evaluate((queueMaxSize) => {
      const app = window.__ytChatOverlay;
      if (!app) throw new Error('Installed app is unavailable');
      const settings = structuredClone(app.getSettings());
      app.applySettings({
        danmakuMode: 'top',
        topBottomDurationMs: 4_000,
        backlogMode: 'playback',
        backlogMaxRate: 50,
        backlogInjectionMax: 100,
        backlogInjectionRateMin: 50,
        backlogDensityRampMs: 500,
        queueMaxSize,
        backlogPauseThreshold: 0.3,
        backlogResumeThreshold: 0.1,
        backlogToggleCooldownMs: 500,
        maxConcurrentMessages: 30,
        fontSize: 32,
        opacity: 0.7,
        superChatLayout: 'stacked',
      });
      return settings;
    }, QUEUE_MAX_SIZE);
    settingsRestoration = 'pending';
    await page.waitForFunction(
      (queueMaxSize) =>
        window.__ytBacklogReset?.renderer?.settings.queueMaxSize === queueMaxSize &&
        window.__ytBacklogReset.renderer.settings.backlogPauseThreshold === 0.3 &&
        window.__ytBacklogReset.renderer.settings.fontSize === 32 &&
        window.__ytBacklogReset.renderer.settings.opacity === 0.7 &&
        window.__ytBacklogReset.renderer.settings.superChatLayout === 'stacked',
      QUEUE_MAX_SIZE,
      { timeout: 5_000 }
    );
    await page.keyboard.press('Control+Space');
    await page.waitForFunction(() =>
      window.__ytBacklogReset?.renderer?.overlay.getUserPauseState()
    );
    stage = 'initial-congestion';
    await page.evaluate(() => {
      const state = window.__ytBacklogReset;
      if (!state) throw new Error('Backlog state disappeared');
      state.phase = 'initial';
      return fetch('/youtubei/v1/live_chat/get_live_chat?windows405=1').then((response) => {
        if (!response.ok) throw new Error('Initial routed batch failed');
      });
    });
    await page.waitForFunction(
      (threshold) =>
        window.__ytBacklogReset?.events.some(
          (event) => event.paused && event.queueLength > threshold
        ),
      CONGESTION_QUEUE_LENGTH,
      { timeout: 20_000 }
    );
    const initialCongestion = await snapshot(page);
    assert(initialCongestion.controllerPending.length > 0);
    assert(initialCongestion.callbackMatches && initialCongestion.managerRetained);
    assert.equal(initialCongestion.userPaused, true);
    assert.deepEqual(initialCongestion.workerAttempts, [
      { type: 'module', error: 'SecurityError' },
    ]);
    assert.deepEqual(
      initialCongestion.lifecycle.map((event) => [event.kind, event.phase]),
      [['controller-created', 'initial']],
      'Initial congestion must come from the routed >50 live seed before recovery'
    );

    stage = 'retained-backlog';
    await page.evaluate(() =>
      fetch('/youtubei/v1/live_chat/get_live_chat?windows405=2').then((response) => {
        if (!response.ok) throw new Error('Second routed batch failed');
      })
    );
    await page.waitForFunction(
      () => (window.__ytBacklogReset?.controller?.drainPending().length ?? 0) > 20
    );
    const retainedBacklog = await snapshot(page);

    const phases = [
      { name: 'font', settings: { fontSize: 36 } },
      { name: 'opacity', settings: { opacity: 0.8 } },
      { name: 'wide', settings: { superChatLayout: 'wide' } },
      { name: 'stacked', settings: { superChatLayout: 'stacked' } },
    ] as const;
    const phaseResults = [];
    for (const { name, settings } of phases) {
      stage = `reset-${name}`;
      // Allow the previous natural high transition to clear the production cooldown.
      await page.waitForFunction(
        () => {
          const events = window.__ytBacklogReset?.events;
          const high = events?.findLast((event) => event.paused);
          return high && performance.now() - high.atMs > 550;
        },
        undefined,
        { timeout: 5_000 }
      );
      const before = await snapshot(page);
      assert.equal(before.controllerPaused, true, `${name}: natural congestion was not retained`);
      const eventCount = before.events.length;
      await page.evaluate(
        ({ phase, values }) => {
          const state = window.__ytBacklogReset;
          const app = window.__ytChatOverlay;
          if (!state || !app) throw new Error('Backlog session disappeared');
          state.phase = phase;
          app.applySettings(values);
        },
        { phase: name, values: settings }
      );
      await page.waitForFunction(
        (count) =>
          window.__ytBacklogReset?.events
            .slice(count)
            .some((event) => !event.paused && event.resetPhase === 'updating'),
        eventCount,
        { timeout: 5_000 }
      );
      const after = await snapshot(page);
      assert(after.callbackMatches && after.managerRetained && after.rendererRetained);
      assert.equal(after.userPaused, true, `${name}: fixture user pause was lost`);
      assert(
        after.replays.length > before.replays.length,
        `${name}: recent message replay was not observed`
      );
      assert.equal(
        name === 'font'
          ? after.settings?.fontSize
          : name === 'opacity'
            ? after.settings?.opacity
            : after.settings?.superChatLayout,
        name === 'font' ? 36 : name === 'opacity' ? 0.8 : name
      );
      assert(after.controllerPending.length < before.controllerPending.length);
      phaseResults.push({ name, before, after });
      // replayLatestMessages runs after the renderer reset but before
      // updateSessionSettings returns, so a genuine high can still be
      // recorded in the 'updating' phase.
      await page.waitForFunction(
        ({ count, phase, threshold }) => {
          const events = window.__ytBacklogReset?.events.slice(count) ?? [];
          const lowIndex = events.findIndex(
            (event) =>
              event.before &&
              !event.paused &&
              event.phase === phase &&
              event.resetPhase === 'updating' &&
              event.callbackMatches
          );
          return (
            lowIndex >= 0 &&
            events
              .slice(lowIndex + 1)
              .some(
                (event) =>
                  !event.before &&
                  event.paused &&
                  event.phase === phase &&
                  event.rendererPaused &&
                  event.callbackMatches &&
                  event.queueLength > threshold
              )
          );
        },
        { count: eventCount, phase: name, threshold: CONGESTION_QUEUE_LENGTH },
        { timeout: 20_000 }
      );
    }

    stage = 'drain-and-resume';
    await page.keyboard.press('Control+Space');
    await page.waitForFunction(
      () => window.__ytBacklogReset?.renderer?.overlay.getUserPauseState() === false
    );
    await page.waitForFunction(
      () =>
        window.__ytBacklogReset?.events.some(
          (event) => event.before && !event.paused && event.phase === 'stacked'
        ),
      undefined,
      { timeout: 30_000 }
    );
    await page.waitForFunction(
      () => {
        const controller = window.__ytBacklogReset?.controller;
        return Boolean(
          controller && !controller.isBacklogActive && controller.drainPending().length === 0
        );
      },
      undefined,
      { timeout: 25_000 }
    );
    const drained = await snapshot(page);
    assert.deepEqual(drained.workerAttempts, [{ type: 'module', error: 'SecurityError' }]);
    assert(drained.callbackMatches && drained.managerRetained && drained.rendererRetained);
    assert(drained.deliveries.length > initialCongestion.deliveries.length);
    // A visual reset clears the renderer, then replayMessage may legitimately
    // present a previously delivered row again. Only an accepted duplicate
    // within the same reset phase is a duplicate presentation.
    const presentations = [...drained.deliveries, ...drained.replays].filter(
      (record) => record.accepted
    );
    assert(drained.deliveries.every((record) => record.accepted));
    assert.equal(
      new Set(presentations.map((record) => `${record.phase}:${record.id}`)).size,
      presentations.length,
      'Duplicate accepted presentation within one renderer generation'
    );
    const phaseOrder = ['initial', 'font', 'opacity', 'wide', 'stacked'];
    const checkpoints = [
      initialCongestion,
      retainedBacklog,
      ...phaseResults.flatMap(({ before, after }) => [before, after]),
    ];
    for (const checkpoint of checkpoints) {
      const minimumPhase = phaseOrder.indexOf(checkpoint.phase);
      assert(minimumPhase >= 0, `Unknown backlog phase ${checkpoint.phase}`);
      for (const id of checkpoint.controllerPending) {
        assert(id !== null, 'Retained backlog message lacked an ID');
        assert(
          presentations.some(
            (record) => record.id === id && phaseOrder.indexOf(record.phase) >= minimumPhase
          ),
          `Lost retained backlog ${id} after ${checkpoint.phase}`
        );
      }
    }
    assert.equal(drained.eventOverflow, 0);
    assert.equal(drained.deliveryOverflow, 0);
    assert.equal(drained.replayOverflow, 0);
    assert.equal(drained.lifecycleOverflow, 0);
    assert.equal(drained.lifecycle.filter((event) => event.kind === 'identity-changed').length, 0);
    assert.equal(
      drained.lifecycle.filter(
        (event) => event.kind === 'overlay-refresh' || event.kind === 'managed-restart'
      ).length,
      0,
      'Runtime recovery interrupted the retained backlog session'
    );
    assert.equal(pageErrors.length, 0);
    assert.equal(pageErrorOverflow, 0);
    assert.equal(consoleErrors.length, 0);
    assert.equal(consoleErrorOverflow, 0);
    assert.deepEqual(routeHits, { first: 1, second: 1 });
    assert.deepEqual(
      requests.map((entry) => entry.batch),
      [1, 2]
    );
    return {
      status: 'passed' as const,
      scope: 'installed Edge extension, packaged Main fallback, routed live backlog',
      pageScriptProbeProvenance: provenance,
      bounded: {
        batchSize: BATCH_SIZE,
        batches: 2,
        queueMaxSize: QUEUE_MAX_SIZE,
        congestionQueueLength: CONGESTION_QUEUE_LENGTH,
        maxRunMs: MAX_RUN_MS,
        maxEvents: MAX_EVENTS,
        maxDeliveries: MAX_DELIVERIES,
      },
      requests,
      routeHits,
      initialCongestion,
      retainedBacklog,
      phaseResults,
      drained,
      pageErrors,
      pageErrorOverflow,
      consoleErrors,
      consoleErrorOverflow,
      gap: 'Deterministic routed chat and controlled Worker failure do not prove public YouTube or Worker-tier backlog behavior',
    };
  };

  let result: Awaited<ReturnType<typeof execute>> | undefined;
  let postStop: Awaited<ReturnType<typeof snapshot>> | null = null;
  let postStopVerified = false;
  try {
    result = await execute();
  } catch (error) {
    primaryError = error;
    try {
      await writeFile(
        join(output, 'backlog-reset-failure.json'),
        JSON.stringify(
          {
            status: 'failed',
            stage,
            deadlineExceeded,
            error: describeError(error),
            pageScriptProbeProvenance: provenance,
            requests,
            routeHits,
            pageErrors,
            pageErrorOverflow,
            consoleErrors,
            consoleErrorOverflow,
            native: await snapshot(page).catch((cause) => ({ unavailable: describeError(cause) })),
          },
          null,
          2
        )
      );
    } catch (receiptError) {
      primaryError = new AggregateError(
        [error, receiptError],
        'Backlog fixture and receipt failed'
      );
    }
  } finally {
    clearTimeout(deadline);
  }
  const cleanupErrors: unknown[] = [];
  for (const cleanup of [
    async () => nativePageProbe?.restore(),
    async () => {
      if (originalSettings) {
        if (page.isClosed()) {
          settingsRestoration = 'skipped-page-closed';
          throw new Error(
            'Fixture page closed before settings restoration and post-stop verification; outer installed-profile cleanup remains responsible'
          );
        }
        try {
          await restoreFixtureSettings(context, page, extensionId, originalSettings);
          settingsRestoration = 'restored';
        } catch (error) {
          settingsRestoration = 'failed';
          throw error;
        }
        postStop = await snapshot(page);
        assert.equal(
          postStop.callbackPresent,
          false,
          'Destroyed renderer retained backlog callback'
        );
        assert.equal(
          postStop.managerRetained,
          false,
          'Destroyed manager retained backlog controller'
        );
        await page.waitForTimeout(1_000);
        const settled = await snapshot(page);
        assert.equal(
          settled.events.length,
          postStop.events.length,
          'Pause callback ran after stop'
        );
        assert.equal(
          settled.deliveries.length,
          postStop.deliveries.length,
          'Backlog delivery continued after stop'
        );
        postStop = settled;
        postStopVerified = true;
      }
    },
    async () => {
      if (routeInstalled && !page.isClosed()) await page.unroute('**/*', routeHandler);
    },
    async () => {
      if (!page.isClosed()) await page.close();
    },
  ]) {
    try {
      await cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    try {
      await writeFile(
        join(output, 'backlog-reset-cleanup-failure.json'),
        JSON.stringify(
          {
            status: 'failed',
            scenarioError: primaryError ? describeError(primaryError) : null,
            deadlineExceeded,
            settingsRestoration,
            postStopVerified,
            outerProfileCleanup:
              'owned by chrome-install.ts; completion not observed by this fixture',
            cleanupErrors: cleanupErrors.map(describeError),
          },
          null,
          2
        )
      );
    } catch (receiptError) {
      cleanupErrors.push(receiptError);
    }
    throw new AggregateError(
      primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors,
      'Backlog reset fixture cleanup failed'
    );
  }
  if (primaryError) throw primaryError;
  assert(result);
  return { ...result, settingsRestoration, postStopVerified, postStop };
}
