// SPDX-License-Identifier: MIT
// @vitest-environment jsdom

import { Overlay } from '@app/overlay';
import { RuntimeManager } from '@app/runtime-manager';
import type { ChatMessage, OverlaySettings } from '@app-types';
import { ReplayChatSource } from '@chat/source-replay';
import { CanvasRenderer } from '@renderer/canvas-renderer';
import type { CanvasMessage } from '@renderer/constants';
import { motionPlansCollide } from '@renderer/layout/message-schedule';
import { WorkerRenderer } from '@renderer/worker/renderer';
import type { ActiveMessage } from '@renderer/worker/types';
import { DEFAULT_SETTINGS } from '@settings/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dimensions = { width: 640, height: 160 };

function makeContext() {
  return {
    setTransform: vi.fn(), getTransform: vi.fn(() => ({ a: 1 })), scale: vi.fn(),
    clearRect: vi.fn(), measureText: vi.fn((text: string) => ({
      width: text.length * 10, actualBoundingBoxAscent: 16, actualBoundingBoxDescent: 4,
    })),
    fillText: vi.fn(), strokeText: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(),
    drawImage: vi.fn(), save: vi.fn(), restore: vi.fn(), translate: vi.fn(),
    beginPath: vi.fn(), closePath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
    arc: vi.fn(), arcTo: vi.fn(), fill: vi.fn(), stroke: vi.fn(), clip: vi.fn(),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    font: '', textBaseline: 'top', textAlign: 'left', textRendering: 'optimizeSpeed',
    fontKerning: 'none', fillStyle: '', strokeStyle: '', lineWidth: 1,
    globalAlpha: 1, filter: 'none', imageSmoothingEnabled: true,
  };
}

type TestContext = ReturnType<typeof makeContext>;

class TestOffscreenCanvas {
  readonly context = makeContext();
  constructor(public width = dimensions.width, public height = dimensions.height) {}
  getContext(): TestContext { return this.context; }
  transferToImageBitmap(): { close(): void } { return { close() {} }; }
}

class CoupledWorker {
  static last: CoupledWorker | null = null;
  readonly backend = new WorkerRenderer();
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: OnErrorEventHandler = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly messages: unknown[] = [];
  private readonly listeners = new Set<EventListener>();

  constructor() { CoupledWorker.last = this; }

  postMessage(data: unknown): void {
    this.messages.push(data);
    this.backend.handleMessage({ data } as MessageEvent);
  }

  receive(data: unknown): void {
    const event = { data } as MessageEvent;
    this.onmessage?.(event);
    for (const listener of this.listeners) listener(event);
  }

  addEventListener(type: string, listener: EventListener): void {
    if (type === 'message') this.listeners.add(listener);
  }
  removeEventListener(type: string, listener: EventListener): void {
    if (type === 'message') this.listeners.delete(listener);
  }
  terminate(): void {}
}

function makeMessage(id: string, offsetMs: number): ChatMessage {
  return {
    id, text: id, content: [{ type: 'text', content: id }], kind: 'text',
    author: id, authorType: 'normal', timestamp: Date.now(), videoOffsetMs: offsetMs,
  };
}

function makeLiveMessage(id: string): ChatMessage {
  const message = makeMessage(id, 0);
  delete message.videoOffsetMs;
  return message;
}

interface Harness {
  readonly source: ReplayChatSource;
  readonly renderer: CanvasRenderer;
  readonly mainContext: TestContext;
  readonly worker: CoupledWorker | null;
  readonly delivered: string[];
  playback: { offsetMs: number; paused: boolean };
  insert(id: string, offsetMs: number): void;
  flush(): Promise<void>;
  frame(now: number): void;
  active(): Array<{
    id: string; laneIndex: number; startTime: number; duration: number;
    x: number; y: number; width: number; height: number;
    motion: NonNullable<CanvasMessage['motion']>;
  }>;
  resize(width: number, height: number): Promise<void>;
  close(): void;
}

function createHarness(
  mode: 'main' | 'worker',
  clock: { now: number },
  settingsOverrides: Partial<OverlaySettings> = {}
): Harness {
  const settings: OverlaySettings = {
    ...DEFAULT_SETTINGS,
    fontSize: 20, speedPxPerSec: 350, laneSpacing: 0,
    safeTop: 0, safeBottom: 0, depthLayersEnabled: false,
    outline: { enabled: false, widthPx: 0, opacity: 0 },
    staggerMaxDelayMs: 100, staggerMediumDelayMs: 50,
    scrollDurationMinMs: 5_000, scrollDurationMaxMs: 30_000,
    exitPaddingPx: 100, headwayGapRatio: 0.08,
    ...settingsOverrides,
  };
  const mainContext = makeContext();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() =>
    mainContext as unknown as CanvasRenderingContext2D
  );
  vi.stubGlobal('OffscreenCanvas', TestOffscreenCanvas);
  vi.stubGlobal('ImageBitmap', class { close(): void {} });
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('Worker', mode === 'worker' ? CoupledWorker : undefined);
  if (mode === 'worker') {
    vi.stubGlobal('postMessage', (data: unknown) => CoupledWorker.last?.receive(data));
    Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', {
      configurable: true, value: () => new TestOffscreenCanvas(),
    });
  }

  const overlay = new Overlay();
  const container = document.createElement('div');
  document.body.appendChild(container);
  (overlay as unknown as { container: HTMLDivElement }).container = container;
  (overlay as unknown as { dimensions: typeof dimensions }).dimensions = dimensions;
  const renderer = new CanvasRenderer(overlay, settings);
  const worker = mode === 'worker' ? CoupledWorker.last : null;
  expect(Boolean(worker)).toBe(mode === 'worker');
  renderer.setReplayMode(true);
  renderer.setConnectionStatus('connected');

  const runtime = new RuntimeManager({
    getCurrentUrl: () => 'https://www.youtube.com/watch?v=replay',
    getSettings: () => settings,
    isValidPage: () => true,
  });
  const source = new ReplayChatSource(() => settings);
  const runtimeInternals = runtime as unknown as {
    state: string;
    renderer: CanvasRenderer | null;
    chatSource: ReplayChatSource | null;
    overlay: Overlay | null;
    routeMessages(messages: ChatMessage[]): void;
    handleReplaySeek(): void;
  };
  runtimeInternals.state = 'active';
  runtimeInternals.renderer = renderer;
  runtimeInternals.chatSource = source;
  runtimeInternals.overlay = overlay;
  const delivered: string[] = [];
  const sourceInternals = source as unknown as {
    callback: ((messages: ChatMessage | ChatMessage[]) => void) | null;
    replayBuffer: { insert(message: ChatMessage, offsetMs: number): void };
    getPlaybackSnapshot(): { offsetMs: number; paused: boolean };
    flushReplayBuffer(): void;
  };
  const harness: Harness = {
    source, renderer, mainContext, worker, delivered,
    playback: { offsetMs: 10_000, paused: false },
    insert(id, offsetMs) {
      sourceInternals.replayBuffer.insert(makeMessage(id, offsetMs), offsetMs);
    },
    async flush() {
      sourceInternals.flushReplayBuffer();
      await Promise.resolve(); // RenderWorkerManager batches during this microtask.
    },
    frame(now) {
      clock.now = now;
      if (worker) {
        (worker.backend as unknown as { renderFrame(): void }).renderFrame();
      } else {
        (renderer as unknown as { renderFrame(): void }).renderFrame();
      }
    },
    active() {
      if (worker) {
        const active = (worker.backend as unknown as { activeMessages: ActiveMessage[] }).activeMessages;
        return active.map((message) => {
          if (!message.motion) throw new Error(`Missing committed Worker motion for ${message.id}`);
          return {
            id: message.id, laneIndex: message.laneIndex, startTime: message.startTime,
            duration: message.duration, x: message.x, y: message.y,
            width: message.width, height: message.height, motion: message.motion,
          };
        });
      }
      const active = (renderer as unknown as { activeMessages: CanvasMessage[] }).activeMessages;
      return active.map((message) => {
        if (!message.motion) throw new Error(`Missing committed Canvas motion for ${message.message.id}`);
        return {
          id: message.message.id ?? '', laneIndex: message.laneIndex,
          startTime: message.startTime, duration: message.duration,
          x: message.x, y: message.y, width: message.width, height: message.height,
          motion: message.motion,
        };
      });
    },
    async resize(width, height) {
      (overlay as unknown as { updateDimensionsFromRect(width: number, height: number): void }).updateDimensionsFromRect(width, height);
      await Promise.resolve();
      await Promise.resolve();
    },
    close() { runtime.destroy(); container.remove(); },
  };
  vi.spyOn(sourceInternals, 'getPlaybackSnapshot').mockImplementation(() => harness.playback);
  sourceInternals.callback = (messages) => {
    const batch = Array.isArray(messages) ? messages : [messages];
    delivered.push(...batch.map((message) => message.id ?? ''));
    runtimeInternals.routeMessages(batch);
  };
  source.onSeek = () => runtimeInternals.handleReplaySeek();
  return harness;
}

describe('Placement through source, runtime and renderer', () => {
  let harness: Harness | null = null;
  const clock = { now: 10_000 };

  beforeEach(() => { clock.now = 10_000; });

  afterEach(() => {
    harness?.close();
    harness = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
    CoupledWorker.last = null;
  });

  it.each(['main', 'worker'] as const)('keeps future replay offsets out of %s drawing across pause and frame hitches', async (mode) => {
    vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
    vi.spyOn(Math, 'random').mockReturnValue(0.25);
    harness = createHarness(mode, clock);
    for (const [id, offset] of [
      ['too-late', 7_999], ['late-boundary', 8_000], ['due', 10_000],
      ['just-future', 10_001], ['prefetched', 11_500],
    ] as const) harness.insert(id, offset);

    await harness.flush();
    harness.frame(10_000);
    expect(harness.delivered).toEqual(['late-boundary', 'due']);
    expect(harness.active().map((message) => message.id)).toEqual(['late-boundary', 'due']);
    // At activation the fade opacity is zero; the next animation frame draws.
    harness.frame(10_016);
    const drawnContext = harness.worker
      ? (harness.worker.backend as unknown as { ctx: TestContext }).ctx
      : harness.mainContext;
    expect(drawnContext.fillText.mock.calls.length + drawnContext.drawImage.mock.calls.length)
      .toBeGreaterThan(0);

    harness.playback = { offsetMs: 10_001, paused: true };
    await harness.flush();
    harness.frame(10_032);
    expect(harness.delivered).toEqual(['late-boundary', 'due']);

    harness.playback = { offsetMs: 10_001, paused: false };
    await harness.flush();
    harness.frame(10_048);
    expect(harness.delivered).toContain('just-future');
    expect(harness.delivered).not.toContain('prefetched');

    harness.playback = { offsetMs: 11_500, paused: false };
    await harness.flush();
    harness.frame(11_500);
    expect(harness.delivered).toContain('prefetched');
    expect(harness.active().some((message) => message.id === 'prefetched')).toBe(true);
    for (const [index, left] of harness.active().entries()) {
      for (const right of harness.active().slice(index + 1)) {
        if (left.laneIndex !== right.laneIndex) continue;
        expect(motionPlansCollide(left.motion, right.motion, 0.08, clock.now)).toBe(false);
      }
    }
  });

  it.each(['main', 'worker'] as const)('clears the old %s timeline on seek and ignores a stopped source', async (mode) => {
    vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
    harness = createHarness(mode, clock);
    harness.insert('old', 10_000);
    harness.insert('old-future', 11_500);
    await harness.flush();
    harness.frame(10_000);
    expect(harness.active().map((message) => message.id)).toContain('old');

    (harness.source as unknown as { handleSeeked(offsetMs: number): void }).handleSeeked(5_000);
    await Promise.resolve();
    expect(harness.active()).toEqual([]);
    harness.playback = { offsetMs: 5_000, paused: false };
    harness.insert('new', 5_000);
    await harness.flush();
    harness.frame(10_016);
    expect(harness.delivered).toEqual(['old', 'new']);
    expect(harness.active().map((message) => message.id)).toEqual(['new']);

    harness.source.stop();
    harness.insert('after-stop', 5_000);
    await harness.flush();
    harness.frame(10_032);
    expect(harness.delivered).toEqual(['old', 'new']);
  });

  it.each((['main', 'worker'] as const).flatMap((mode) => [14, 32, 50].map((fontSize) => ({ mode, fontSize }))))('reconciles cached vertical geometry, density, pause and resize in $mode at $fontSize px', async ({ mode, fontSize }) => {
    vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    harness = createHarness(mode, clock, { fontSize, laneSpacing: 0, showAuthor: { ...DEFAULT_SETTINGS.showAuthor, normal: false }, outline: { enabled: false, widthPx: 0, opacity: 0 } });
    for (const id of ['日本語コメント1', '한국어댓글2']) harness.insert(id, 10_000);
    await harness.flush(); harness.frame(10_000);
    const initial = harness.active();
    expect(initial).toHaveLength(2);
    expect(Math.abs((initial[1]?.y ?? 0) - (initial[0]?.y ?? 0))).toBe(initial[0]?.height);
    harness.frame(11_000);
    const previous = harness.active();
    const settings = (harness.renderer as unknown as { settings: OverlaySettings }).settings;
    harness.renderer.setUserPaused(true);
    const next = { ...settings, laneSpacing: 8, fontSize: 40, backgroundColors: { ...settings.backgroundColors, normal: '#00000040' }, outline: { enabled: true, widthPx: 4, opacity: 0.7 } };
    harness.renderer.updateSettings(next);
    await Promise.resolve(); await Promise.resolve();
    // Apply a geometry refresh through Overlay's production resize callback.
    await harness.resize(1280, 1080);
    const changed = harness.active();
    expect(changed).toHaveLength(2);
    expect(changed.every((message) => message.height > (initial[0]?.height ?? 0))).toBe(true);
    for (const message of changed) {
      const old = previous.find((entry) => entry.id === message.id);
      if (!old) throw new Error('lost prior placement');
      const beforeProgress = (11_000 - old.motion.startTime) / old.duration;
      expect((11_000 - message.motion.startTime) / message.duration).toBeCloseTo(beforeProgress);
    }
    if (mode === 'worker') {
      if (!harness.worker) throw new Error('Worker missing');
      const backend = harness.worker.backend as unknown as { laneHeight: number };
      const beforeHeight = backend.laneHeight;
      harness.worker.postMessage({ type: 'laneDensity', factor: 0.5 });
      expect(backend.laneHeight).toBeCloseTo(beforeHeight / 4);
    } else {
      const allocator = (harness.renderer as unknown as { laneAllocator: { updateLaneDensityFactor(factor: number): void } }).laneAllocator;
      allocator.updateLaneDensityFactor(0.5);
      harness.renderer.resetAllocator({ width: 1280, height: 1080 });
      (harness.renderer as unknown as { reflowActiveMessages(size: { width: number; height: number }): void }).reflowActiveMessages({ width: 1280, height: 1080 });
    }
    clock.now = 12_000;
    harness.renderer.setUserPaused(false);
    const measurement = mode === 'worker'
      ? (harness.worker?.backend as unknown as { ctx: TestContext }).ctx.measureText : harness.mainContext.measureText;
    measurement.mockClear();
    const originalMeasurement = measurement.getMockImplementation();
    const measurementStacks: string[] = [];
    measurement.mockImplementation((text) => {
      measurementStacks.push(new Error().stack ?? '');
      return originalMeasurement?.(text) ?? { width: 0, actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 0 };
    });
    harness.frame(12_000);
    // Existing inline-width/bitmap measurements have separate caches. The new
    // vertical bounds must be prepared before this first resumed draw.
    expect(measurementStacks.filter((stack) => stack.includes('measureTextTopBounds'))).toEqual([]);
    const resumed = harness.active();
    expect(resumed).toHaveLength(2);
    const [first, second] = resumed;
    if (!first || !second) throw new Error('resumed placements missing');
    expect(motionPlansCollide(first.motion, second.motion, 0.08, 12_000) &&
      first.y + first.height > second.y && second.y + second.height > first.y).toBe(false);
    harness.renderer.updateSettings(settings);
    await Promise.resolve(); await Promise.resolve();
    await harness.resize(640, 160);
    harness.frame(12_000);
    const restored = harness.active();
    expect(restored).toHaveLength(2);
    expect(restored.every((message) => message.height === initial[0]?.height)).toBe(true);
    const drawing = mode === 'worker'
      ? (harness.worker?.backend as unknown as { ctx: TestContext }).ctx : harness.mainContext;
    expect(drawing.font).toContain(`${fontSize}px`);
  });

  it('keeps committed geometry and drops equivalent across Canvas and Worker frame partitions', async () => {
    async function run(mode: 'main' | 'worker', frames: number[]) {
      clock.now = 10_000;
      vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
      vi.spyOn(Math, 'random').mockReturnValue(0.25);
      const current = createHarness(mode, clock);
      for (const id of ['first', 'second', 'third']) current.insert(id, 10_000);
      await current.flush();
      for (const frame of frames) current.frame(frame);
      const result = {
        delivered: [...current.delivered],
        active: current.active().map((message) => ({
          id: message.id, x: message.x, y: message.y, width: message.width,
          startTime: message.startTime, duration: message.duration,
          entry: message.motion.viewportEntryTime,
          exit: message.motion.visibleExitTime,
        })).sort((left, right) => left.id.localeCompare(right.id)),
        drops: current.worker
          ? (current.worker.backend as unknown as { totalDrops: number }).totalDrops
          : current.renderer.observability.getMetrics().totalDropped,
      };
      current.close();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      document.body.replaceChildren();
      CoupledWorker.last = null;
      return result;
    }

    const main = await run('main', [10_000, 10_016, 10_032]);
    const worker = await run('worker', [10_000, 10_008, 10_016, 10_024, 10_032]);
    expect(main.delivered).toEqual(['first', 'second', 'third']);
    expect(worker.delivered).toEqual(main.delivered);
    expect(main.active).toHaveLength(3);
    expect(worker.active).toEqual(main.active);
    expect(worker.drops).toBe(main.drops);
    expect(worker.drops).toBe(0);
  });

  it.each([
    { burst: 1, width: 1_980, mode: 'scroll', author: 'normal', duration: 8_000 },
    { burst: 1.1, width: 1_980, mode: 'scroll', author: 'normal', duration: 8_000 },
    { burst: 1.2, width: 1_980, mode: 'scroll', author: 'normal', duration: 8_000 },
    { burst: 1.35, width: 1_980, mode: 'scroll', author: 'normal', duration: 8_000 },
    { burst: 1.35, width: 1_980, mode: 'reverse', author: 'normal', duration: 8_000 },
    { burst: 1.35, width: 200, mode: 'scroll', author: 'normal', duration: 5_000 },
    { burst: 1.35, width: 1_980, mode: 'scroll', author: 'moderator', duration: 12_000 },
    { burst: 1.35, width: 1_980, mode: 'scroll', author: 'owner', duration: 12_000 },
  ] as const)(
    'keeps Backlog motion aligned for burst $burst, $mode, width $width, $author',
    async ({ burst, width, mode, author, duration }) => {
      async function run(rendererMode: 'main' | 'worker') {
        clock.now = 10_000;
        dimensions.width = 1_920;
        vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
        vi.spyOn(Math, 'random').mockReturnValue(0.25);
        const current = createHarness(rendererMode, clock, {
          speedPxPerSec: 250, backlogSpeedMultiplier: 2,
          staggerMaxDelayMs: 0, staggerMediumDelayMs: 0,
          danmakuMode: mode,
        });
        current.renderer.setReplayMode(false);
        const internals = current.renderer as unknown as {
          estimateDimensions(message: ChatMessage): { width: number; height: number };
          getEffectiveSpeedPxPerSec(): number;
        };
        internals.estimateDimensions = () => ({ width, height: 20 });
        internals.getEffectiveSpeedPxPerSec = () => 250 * burst;
        current.renderer.addMessage({
          ...makeLiveMessage('backlog'), isBacklog: true, authorType: author,
        });
        await Promise.resolve();
        // The serialized burst sample is retained while this Backlog message waits.
        internals.getEffectiveSpeedPxPerSec = () => 500;
        current.frame(10_000);
        const active = current.active().find((message) => message.id === 'backlog');
        const dispatched = current.worker?.messages
          .filter((message): message is { type: string; messages: Array<{ burstSpeedMultiplier: number }> } =>
            typeof message === 'object' && message !== null &&
            'type' in message && message.type === 'addMessages'
          )
          .flatMap((message) => message.messages);
        clock.now = 11_000;
        if (current.worker) {
          (current.worker.backend as unknown as { reflowActiveMessages(): void })
            .reflowActiveMessages();
        } else {
          (current.renderer as unknown as { reflowActiveMessages(size: typeof dimensions): void })
            .reflowActiveMessages(dimensions);
        }
        const reflowed = current.active().find((message) => message.id === 'backlog');
        current.close();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        document.body.replaceChildren();
        CoupledWorker.last = null;
        return { active, reflowed, dispatched };
      }

      try {
        const main = await run('main');
        const worker = await run('worker');
        expect(worker.dispatched?.[0]?.burstSpeedMultiplier).toBeCloseTo(burst);
        expect(main.active?.motion.travelDistancePx).toBe(1_920 + width + 100);
        expect(main.active?.motion.durationMs).toBe(duration);
        expect(main.active?.motion.actualVelocityPxPerMs).toBe(
          (1_920 + width + 100) / duration
        );
        expect(worker.active?.motion).toMatchObject({
          durationMs: main.active?.motion.durationMs,
          actualVelocityPxPerMs: main.active?.motion.actualVelocityPxPerMs,
          viewportEntryTime: main.active?.motion.viewportEntryTime,
          visibleExitTime: main.active?.motion.visibleExitTime,
        });
        expect(worker.reflowed?.motion).toMatchObject({
          durationMs: main.reflowed?.motion.durationMs,
          actualVelocityPxPerMs: main.reflowed?.motion.actualVelocityPxPerMs,
          viewportEntryTime: main.reflowed?.motion.viewportEntryTime,
          visibleExitTime: main.reflowed?.motion.visibleExitTime,
        });
      } finally {
        dimensions.width = 640;
      }
    }
  );

  it.each(['scroll', 'reverse'] as const)(
    'keeps a same-lane %s Backlog reservation after burst serialization',
    async (motionMode) => {
      async function run(rendererMode: 'main' | 'worker') {
        clock.now = 10_000;
        dimensions.width = 1_920;
        dimensions.height = 25;
        vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
        vi.spyOn(Math, 'random').mockReturnValue(0.25);
        const current = createHarness(rendererMode, clock, {
          danmakuMode: motionMode, speedPxPerSec: 250, backlogSpeedMultiplier: 2,
          staggerMaxDelayMs: 0, staggerMediumDelayMs: 0,
        });
        current.renderer.setReplayMode(false);
        const internals = current.renderer as unknown as {
          estimateDimensions(message: ChatMessage): { width: number; height: number };
          getEffectiveSpeedPxPerSec(): number;
        };
        internals.estimateDimensions = () => ({ width: 1_980, height: 20 });
        internals.getEffectiveSpeedPxPerSec = () => 337.5;
        for (const id of ['first', 'second']) {
          current.renderer.addMessage({ ...makeLiveMessage(id), isBacklog: true });
        }
        await Promise.resolve();
        current.frame(10_000);
        const active = current.active().sort((left, right) => left.id.localeCompare(right.id));
        current.close();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        document.body.replaceChildren();
        CoupledWorker.last = null;
        return active;
      }

      try {
        const main = await run('main');
        const worker = await run('worker');
        expect(main).toHaveLength(2);
        expect(worker).toHaveLength(2);
        const [mainFirst, mainSecond] = main;
        const [workerFirst, workerSecond] = worker;
        if (!mainFirst || !mainSecond || !workerFirst || !workerSecond) {
          throw new Error('Expected two committed Backlog reservations per renderer');
        }
        expect(mainFirst.laneIndex).toBe(mainSecond.laneIndex);
        expect(workerFirst.laneIndex).toBe(workerSecond.laneIndex);
        expect(motionPlansCollide(mainFirst.motion, mainSecond.motion, 0.08, 10_000)).toBe(false);
        expect(motionPlansCollide(workerFirst.motion, workerSecond.motion, 0.08, 10_000)).toBe(false);
        expect(worker.map(({ id, laneIndex, motion }) => ({
          id, laneIndex, startTime: motion.startTime,
          entry: motion.viewportEntryTime, exit: motion.visibleExitTime,
        }))).toEqual(main.map(({ id, laneIndex, motion }) => ({
          id, laneIndex, startTime: motion.startTime,
          entry: motion.viewportEntryTime, exit: motion.visibleExitTime,
        })));
      } finally {
        dimensions.width = 640;
        dimensions.height = 160;
      }
    }
  );

  it.each(['main', 'worker'] as const)(
    'retains the %s live entry cursor after a frame boundary',
    async (mode) => {
      vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
      vi.spyOn(Math, 'random').mockReturnValue(0.25);
      harness = createHarness(mode, clock);
      harness.renderer.setReplayMode(false);
      harness.renderer.addMessage(makeLiveMessage('seed-one'));
      harness.renderer.addMessage(makeLiveMessage('seed-two'));
      await Promise.resolve();
      harness.frame(10_000);
      const seed = harness.active().find((message) => message.id === 'seed-two');
      expect(seed).toBeDefined();
      expect(seed?.motion.viewportEntryTime).toBeGreaterThan(10_000);

      clock.now = 10_001;
      harness.renderer.addMessage(makeLiveMessage('next-frame'));
      await Promise.resolve();
      harness.frame(10_001);
      const next = harness.active().find((message) => message.id === 'next-frame');
      expect(next).toBeDefined();
      expect(next?.motion.viewportEntryTime).toBeGreaterThanOrEqual(
        seed?.motion.viewportEntryTime ?? Number.POSITIVE_INFINITY
      );
      expect(next?.motion.viewportEntryTime).toBeLessThanOrEqual(10_001 + 98);
      expect(next?.motion.staggerLimitMs).toBe(98);
      expect(harness.active().length).toBe(3);
    }
  );

  const pressureCases = [
    { depth: 29, limit: 52 }, { depth: 30, limit: 50 },
    { depth: 31, limit: 48 }, { depth: 49, limit: 3 },
    { depth: 50, limit: 0 }, { depth: 51, limit: 0 },
  ];

  it.each(pressureCases.flatMap(({ depth, limit }) =>
    (['main', 'worker'] as const).map((mode) => ({ mode, depth, limit }))
  ))('bounds $mode live entry at queue depth $depth', async ({ mode, depth, limit }) => {
    vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
    vi.spyOn(Math, 'random').mockReturnValue(0.25);
    harness = createHarness(mode, clock);
    harness.renderer.setReplayMode(false);
    for (let index = 0; index < depth; index++) {
      harness.renderer.addMessage(makeLiveMessage(`live-${index}`));
    }
    await Promise.resolve();
    harness.frame(10_000);

    const active = harness.active();
    expect(active.length).toBeGreaterThan(0);
    expect(active.length).toBeLessThanOrEqual(32);
    const first = active.find((message) => message.id === 'live-0');
    expect(first?.motion.staggerLimitMs).toBe(limit);
    expect(first?.motion.viewportEntryTime).toBeGreaterThanOrEqual(10_000);
    expect(first?.motion.viewportEntryTime).toBeLessThanOrEqual(10_000 + limit);
    for (const message of active) {
      const plan = message.motion;
      const horizontalDelay = plan.horizontalStaggerPx / plan.actualVelocityPxPerMs;
      expect(plan.staggerLimitMs).toBe(limit);
      expect(plan.staggerDelayMs + horizontalDelay).toBeLessThanOrEqual(limit + 0.001);
      if (limit === 0) {
        expect(plan.staggerDelayMs).toBe(0);
        expect(plan.horizontalStaggerPx).toBe(0);
      }
    }
    for (const [index, left] of active.entries()) {
      for (const right of active.slice(index + 1)) {
        if (left.y + left.height <= right.y || right.y + right.height <= left.y) continue;
        expect(motionPlansCollide(left.motion, right.motion, 0.08, 10_000)).toBe(false);
      }
    }

    if (depth > 32) {
      expect(harness.renderer.getQueueLength()).toBeGreaterThanOrEqual(depth - 32);
      harness.frame(30_000);
      expect(harness.active().some((message) => message.id === 'live-32')).toBe(true);
    }
  });

  it.each(['main', 'worker'] as const)(
    'removes temporal and horizontal live staggering when %s delay settings are zero',
    async (mode) => {
      vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
      vi.spyOn(Math, 'random').mockReturnValue(0.25);
      harness = createHarness(mode, clock, {
        staggerMaxDelayMs: 0, staggerMediumDelayMs: 0,
      });
      harness.renderer.setReplayMode(false);
      harness.renderer.addMessage(makeLiveMessage('zero-one'));
      harness.renderer.addMessage(makeLiveMessage('zero-two'));
      await Promise.resolve();
      harness.frame(10_000);
      for (const message of harness.active()) {
        expect(message.motion.staggerLimitMs).toBe(0);
        expect(message.motion.staggerDelayMs).toBe(0);
        expect(message.motion.horizontalStaggerPx).toBe(0);
        expect(message.motion.viewportEntryTime).toBe(message.startTime);
      }
      expect(harness.active().length).toBe(2);
    }
  );
});
