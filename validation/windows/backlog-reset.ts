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
const MAX_EVENTS = 128;
// Three 51-action batches fit, with room to record a few duplicate deliveries before failing.
const MAX_DELIVERIES = 160;
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
  deliveries: string[];
  deliveryOverflow: number;
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
  ])
    assert(source.includes(method), `Packaged ${method} changed`);
  const insertion = `
\tconst backlogState = window.__ytBacklogReset;
\tif (!backlogState) throw new Error('Backlog prelude is unavailable');
\tconst nativeEnsureBacklog = RuntimeManager.prototype.ensureBacklogController;
\tRuntimeManager.prototype.ensureBacklogController = function(...args) {
\t\tconst result = Reflect.apply(nativeEnsureBacklog, this, args);
\t\tbacklogState.manager = this;
\t\tbacklogState.renderer = this.renderer;
\t\tbacklogState.controller = this.backlogController;
\t\tbacklogState.callback ??= this.renderer?.onBacklogPauseChange ?? null;
\t\treturn result;
\t};
\tconst nativeUpdateSettings = RuntimeManager.prototype.updateSessionSettings;
\tRuntimeManager.prototype.updateSessionSettings = function(...args) {
\t\tbacklogState.manager = this;
\t\tbacklogState.renderer = this.renderer;
\t\tbacklogState.resetPhase = 'updating';
\t\ttry { return Reflect.apply(nativeUpdateSettings, this, args); }
\t\tfinally { backlogState.resetPhase = 'complete'; }
\t};
\tconst nativeBacklogPause = CanvasRenderer.prototype.updateBacklogPause;
\tCanvasRenderer.prototype.updateBacklogPause = function(...args) {
\t\tconst result = Reflect.apply(nativeBacklogPause, this, args);
\t\tif (this === backlogState.renderer) backlogState.renderer = this;
\t\treturn result;
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
\t\tif (this === backlogState.renderer && message?.isBacklog === true &&
\t\t\tmessage?.id?.startsWith(${JSON.stringify(PREFIX)})) {
\t\t\tif (backlogState.deliveries.length < ${MAX_DELIVERIES})
\t\t\t\tbacklogState.deliveries.push(message.id);
\t\t\telse backlogState.deliveryOverflow++;
\t\t}
\t\treturn Reflect.apply(nativeBacklogDelivery, this, [message, ...args]);
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
  const source = await readFile(join(root, 'dist-extension/page-script.js'), 'utf8');
  const instrumented = instrument(source);
  const preview = await readFile(join(root, 'test/visual/preview.html'), 'utf8');
  const html = buildVisibleWatchHtml(preview, 'Backlog reset fixture video');
  const page = await context.newPage();
  const deliveredBatches = new Set<number>();
  const requests: Array<{ batch: number; atMs: number }> = [];
  const routeHits = { first: 0, second: 0, third: 0 };
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
      const batch = selected && /^[123]$/u.test(selected) ? Number(selected) : null;
      if (batch === 1) routeHits.first++;
      if (batch === 2) routeHits.second++;
      if (batch === 3) routeHits.third++;
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
    originalSettings = await page.evaluate(() => {
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
        queueMaxSize: 50,
        backlogPauseThreshold: 0.3,
        backlogResumeThreshold: 0.1,
        backlogToggleCooldownMs: 500,
        maxConcurrentMessages: 30,
        fontSize: 32,
        opacity: 0.7,
        superChatLayout: 'stacked',
      });
      return settings;
    });
    settingsRestoration = 'pending';
    await page.waitForFunction(
      () =>
        window.__ytBacklogReset?.renderer?.settings.queueMaxSize === 50 &&
        window.__ytBacklogReset.renderer.settings.backlogPauseThreshold === 0.3 &&
        window.__ytBacklogReset.renderer.settings.fontSize === 32 &&
        window.__ytBacklogReset.renderer.settings.opacity === 0.7 &&
        window.__ytBacklogReset.renderer.settings.superChatLayout === 'stacked',
      undefined,
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
      () => window.__ytBacklogReset?.events.some((event) => event.paused && event.queueLength > 15),
      undefined,
      { timeout: 20_000 }
    );
    const initialCongestion = await snapshot(page);
    assert(initialCongestion.controllerPending.length > 0);
    assert(initialCongestion.callbackMatches && initialCongestion.managerRetained);
    assert.equal(initialCongestion.userPaused, true);

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
      if (name === 'stacked') {
        await page.evaluate(() =>
          fetch('/youtubei/v1/live_chat/get_live_chat?windows405=3').then((response) => {
            if (!response.ok) throw new Error('Third routed batch failed');
          })
        );
        await page.waitForFunction(
          () => (window.__ytBacklogReset?.controller?.drainPending().length ?? 0) > 20
        );
      }
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
      await page.waitForFunction(
        ({ count, phase }) =>
          window.__ytBacklogReset?.events
            .slice(count)
            .some(
              (event) =>
                event.paused &&
                event.phase === phase &&
                event.resetPhase === 'complete' &&
                event.rendererPaused &&
                event.queueLength > 15
            ),
        { count: eventCount, phase: name },
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
    assert(drained.deliveries.length > initialCongestion.deliveries.length);
    assert.equal(new Set(drained.deliveries).size, drained.deliveries.length);
    const retainedIds = new Set([
      ...initialCongestion.controllerPending,
      ...retainedBacklog.controllerPending,
      ...phaseResults.flatMap(({ before, after }) => [
        ...before.controllerPending,
        ...after.controllerPending,
      ]),
    ]);
    for (const id of retainedIds) {
      assert(id !== null, 'Retained backlog message lacked an ID');
      assert(drained.deliveries.includes(id), `Lost retained backlog ${id}`);
    }
    assert.equal(drained.eventOverflow, 0);
    assert.equal(drained.deliveryOverflow, 0);
    assert.equal(pageErrors.length, 0);
    assert.equal(pageErrorOverflow, 0);
    assert.equal(consoleErrors.length, 0);
    assert.equal(consoleErrorOverflow, 0);
    assert.deepEqual(routeHits, { first: 1, second: 1, third: 1 });
    assert.deepEqual(
      requests.map((entry) => entry.batch),
      [1, 2, 3]
    );
    return {
      status: 'passed' as const,
      scope: 'installed Edge extension, packaged Main fallback, routed live backlog',
      pageScriptProbeProvenance: provenance,
      bounded: {
        batchSize: BATCH_SIZE,
        batches: 3,
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
