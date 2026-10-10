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
    authorType: 'normal', timestamp: Date.now(), videoOffsetMs: offsetMs,
  };
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
    x: number; y: number; width: number; motion: NonNullable<CanvasMessage['motion']>;
  }>;
  close(): void;
}

function createHarness(mode: 'main' | 'worker', clock: { now: number }): Harness {
  const settings: OverlaySettings = {
    ...DEFAULT_SETTINGS,
    fontSize: 20, speedPxPerSec: 350, laneSpacing: 0,
    safeTop: 0, safeBottom: 0, depthLayersEnabled: false,
    outline: { enabled: false, widthPx: 0, opacity: 0 },
    staggerMaxDelayMs: 100, staggerMediumDelayMs: 50,
    scrollDurationMinMs: 5_000, scrollDurationMaxMs: 30_000,
    exitPaddingPx: 100, headwayGapRatio: 0.08,
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
            width: message.width, motion: message.motion,
          };
        });
      }
      const active = (renderer as unknown as { activeMessages: CanvasMessage[] }).activeMessages;
      return active.map((message) => {
        if (!message.motion) throw new Error(`Missing committed Canvas motion for ${message.message.id}`);
        return {
          id: message.message.id ?? '', laneIndex: message.laneIndex,
          startTime: message.startTime, duration: message.duration,
          x: message.x, y: message.y, width: message.width, motion: message.motion,
        };
      });
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

describe('Replay placement through source, runtime and renderer', () => {
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
});
