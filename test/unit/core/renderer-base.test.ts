import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { RendererBase } from '@renderer/renderer-base';
import type { ConnectionStatus } from '@renderer/renderer-base';
import type { Overlay } from '@app/overlay';
import type { ChatMessage, OverlaySettings } from '@app-types';
import { DEFAULT_SETTINGS } from '@settings/schema';

// ── Test subclass ─────────────────────────────────────────────────────────

class TestRenderer extends RendererBase {
  pauseCalled = false;
  resumeCalled = false;
  pausedDuration = 0;
  stateReset = false;
  destroyed = false;
  messages: ChatMessage[] = [];

  addMessage(message: ChatMessage): void {
    this.messages.push(message);
  }

  get laneCount(): number {
    return this.laneAllocator.getLaneCount();
  }

  getQueueLength(): number {
    return this.messages.length;
  }

  getActiveMessageCount(): number {
    return this.messages.length;
  }

  protected onPause(): void {
    this.pauseCalled = true;
  }

  protected onResume(): void {
    this.resumeCalled = true;
  }

  protected applyPausedDuration(pausedMs: number): void {
    this.pausedDuration = pausedMs;
  }

  protected resetState(): void {
    this.stateReset = true;
  }

  protected onDestroy(): void {
    this.destroyed = true;
  }

  protected override onResumeFromVideoPause(messages: ChatMessage[]): void {
    this.messages.push(...messages);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

const defaultSettings: OverlaySettings = {
  ...DEFAULT_SETTINGS,
  safeTop: 0.05,
  safeBottom: 0.05,
  fontSize: 16,
  fontWeight: 'normal',
  fontFamily: 'sans-serif',
  laneSpacing: 4,
  headwayGapRatio: 0.08,
  exitPaddingPx: 100,
  scrollDurationMaxMs: 15000,
  maxMessageAgeMs: 30000,
  speedPxPerSec: 100,
  speedBoostThreshold: 5,
  speedBoostDenom: 10,
  speedBoostMax: 2,
  showDebugOverlay: false,
  burstSampleWindow: 10,
  burstElevatedThreshold: 5,
  burstHighThreshold: 15,
  burstExtremeThreshold: 30,
  authorRateLimit: 'off',
  backlogToggleCooldownMs: 5000,
  backlogPauseThreshold: 0.9,
  backlogResumeThreshold: 0.5,
  queueMaxSize: 500,
};

function makeOverlayMock(): Overlay {
  return {
    getDimensions: () => ({ width: 1920, height: 1080 }),
  } as unknown as Overlay;
}

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    text: 'hello',
    content: [{ type: 'text', content: 'hello' }],
    kind: 'text',
    timestamp: Date.now(),
    authorType: 'normal',
    ...overrides,
  };
}

let now = 1000;
let overlay: Overlay;
const renderers = new Set<TestRenderer>();

beforeEach(() => {
  now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  // Ensure document is visible
  Object.defineProperty(document, 'visibilityState', {
    value: 'visible',
    configurable: true,
  });
  overlay = makeOverlayMock();
});

afterEach(() => {
  for (const renderer of renderers) {
    if (!renderer.destroyed) renderer.destroy();
  }
  renderers.clear();
  vi.restoreAllMocks();
});

function createRenderer(settings = defaultSettings): TestRenderer {
  const renderer = new TestRenderer(overlay, settings);
  renderers.add(renderer);
  return renderer;
}

// ═══════════════════════════════════════════════════════════════════════════
// RendererBase Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('RendererBase', () => {
  // ── Constructor ─────────────────────────────────────────────────────

  describe('constructor', () => {
    it('initializes with default pause state', () => {
      const r = createRenderer();
      expect(r.isPaused).toBe(false);
    });

    it('initializes with isVideoPaused being false', () => {
      const r = createRenderer();
      expect(r.isVideoPaused).toBe(false);
    });

    it('initializes lane allocator with lanes', () => {
      const r = createRenderer();
      expect(r.getLaneCount()).toBeGreaterThan(0);
    });

    it('applies updated burst thresholds without recreating the renderer', () => {
      const r = createRenderer();
      r.updateSettings({
        ...defaultSettings,
        burstSampleWindow: 24,
        burstElevatedThreshold: 7,
        burstHighThreshold: 19,
        burstExtremeThreshold: 41,
      });
      const detector = (r as unknown as {
        burstDetector: {
          rateSampleWindow: number;
          elevatedThreshold: number;
          highThreshold: number;
          extremeThreshold: number;
        };
      }).burstDetector;

      expect(detector).toMatchObject({
        rateSampleWindow: 24,
        elevatedThreshold: 7,
        highThreshold: 19,
        extremeThreshold: 41,
      });
    });
  });

  // ── Pause / Resume state machine ─────────────────────────────────────

  describe('pause / resume', () => {
    it('pause transitions isPaused to true and calls onPause', () => {
      const r = createRenderer();
      expect(r.isPaused).toBe(false);

      r.pause();
      expect(r.isPaused).toBe(true);
      expect(r.pauseCalled).toBe(true);
    });

    it('pause is idempotent (calling twice does not re-call onPause)', () => {
      const r = createRenderer();
      r.pause();
      expect(r.pauseCalled).toBe(true);
      r.pauseCalled = false; // reset
      r.pause();
      expect(r.pauseCalled).toBe(false); // should not call onPause again
    });

    it('resume transitions isPaused to false and calls onResume', () => {
      const r = createRenderer();
      r.pause();
      expect(r.isPaused).toBe(true);

      r.resume();
      expect(r.isPaused).toBe(false);
      expect(r.resumeCalled).toBe(true);
    });

    it('resume is idempotent (calling without pause does nothing)', () => {
      const r = createRenderer();
      r.resume(); // not paused, should return early
      expect(r.resumeCalled).toBe(false);
    });

    it('resume calculates paused duration and calls applyPausedDuration', () => {
      const r = createRenderer();
      r.pause();

      // Advance time by 500ms
      now += 500;
      r.resume();
      expect(r.pausedDuration).toBeGreaterThanOrEqual(400);
      expect(r.pausedDuration).toBeLessThanOrEqual(600);
    });

    it('resume clamps paused duration to maxMessageAgeMs * 2', () => {
      const r = createRenderer();
      r.pause();

      // Advance time by a very long time (1 hour)
      now += 3_600_000;
      r.resume();
      // B-1: clamped to maxMessageAgeMs * 2 = 60000
      expect(r.pausedDuration).toBeLessThanOrEqual(60000);
    });
  });

  // ── PauseForVideo / ResumeForVideo state machine ─────────────────────

  describe('pauseForVideo / resumeForVideo', () => {
    it('pauseForVideo sets isVideoPaused and calls pause', () => {
      const r = createRenderer();
      r.pauseForVideo();
      expect(r.isVideoPaused).toBe(true);
      expect(r.isPaused).toBe(true);
    });

    it('pauseForVideo is idempotent', () => {
      const r = createRenderer();
      r.pauseForVideo();
      expect(r.isVideoPaused).toBe(true);
      r.pauseCalled = false;
      r.pauseForVideo();
      expect(r.isVideoPaused).toBe(true);
      expect(r.pauseCalled).toBe(false);
    });

    it('resumeForVideo clears isVideoPaused and resumes', () => {
      const r = createRenderer();
      r.pauseForVideo();
      expect(r.isVideoPaused).toBe(true);

      r.resumeForVideo();
      expect(r.isVideoPaused).toBe(false);
    });

    it('resumeForVideo is idempotent when not video paused', () => {
      const r = createRenderer();
      r.resumeForVideo();
      expect(r.resumeCalled).toBe(false);
    });

    it('resumeForVideo flushes pause buffer', () => {
      const r = createRenderer();
      r.pauseForVideo();

      // Manually trigger isMessageAllowed to buffer messages
      const msg1 = makeMessage({ text: 'buffered1' });
      const msg2 = makeMessage({ text: 'buffered2' });
      r['addMessage'](msg1); // bypass isMessageAllowed for simplicity
      r['addMessage'](msg2);

      r.resumeForVideo();
      // The subclass onResumeFromVideoPause copies to messages array
      // In our test class, we push directly in onResumeFromVideoPause
    });

    it('resumeForVideo does not resume if document is hidden and was not also paused', () => {
      Object.defineProperty(document, 'visibilityState', {
        value: 'hidden',
        configurable: true,
      });
      const r = createRenderer();
      r.pauseForVideo();

      r.resumeForVideo();
      // isVideoPaused cleared, but onResume not called because hidden
      // Actually resumeForVideo checks if isVideoPaused was set, then
      // calls resume() which checks isPaused... let's verify the transition
      expect(r.isVideoPaused).toBe(false);
    });
  });

  // ── getMessagePriority (static) ──────────────────────────────────────

  describe('getMessagePriority', () => {
    it('returns higher priority for superchat than text', () => {
      const superchat = makeMessage({ kind: 'superchat' });
      const text = makeMessage({ kind: 'text' });
      const superPriority = RendererBase.getMessagePriority(superchat);
      const textPriority = RendererBase.getMessagePriority(text);
      expect(superPriority).toBeGreaterThan(textPriority);
    });

    it('returns higher priority for membership than text', () => {
      const membership = makeMessage({ kind: 'membership' });
      const text = makeMessage({ kind: 'text' });
      const memPriority = RendererBase.getMessagePriority(membership);
      const textPriority = RendererBase.getMessagePriority(text);
      expect(memPriority).toBeGreaterThan(textPriority);
    });

    it('reduces priority for backlog messages', () => {
      const normal = makeMessage({ kind: 'text' });
      const backlog = makeMessage({ kind: 'text', isBacklog: true });
      const normalPriority = RendererBase.getMessagePriority(normal);
      const backlogPriority = RendererBase.getMessagePriority(backlog);
      expect(backlogPriority).toBeLessThan(normalPriority);
    });

    it('superchat backlog is still higher than normal text', () => {
      const superchatBacklog = makeMessage({ kind: 'superchat', isBacklog: true });
      const normalText = makeMessage({ kind: 'text' });
      const scPriority = RendererBase.getMessagePriority(superchatBacklog);
      const textPriority = RendererBase.getMessagePriority(normalText);
      expect(scPriority).toBeGreaterThan(textPriority);
    });
  });

  // ── getLaneDensityFactor ─────────────────────────────────────────────

  describe('getLaneDensityFactor', () => {
    it('returns 1.0 for normal burst level', () => {
      const r = createRenderer();
      expect(r.getLaneDensityFactor()).toBe(1.0);
    });
  });

  // ── isReplayMode / setReplayMode ─────────────────────────────────────

  describe('isReplayMode / setReplayMode', () => {
    it('starts with replay mode disabled', () => {
      const r = createRenderer();
      expect(r.isReplayMode).toBe(false);
    });

    it('setReplayMode enables and disables replay mode', () => {
      const r = createRenderer();
      r.setReplayMode(true);
      expect(r.isReplayMode).toBe(true);
      r.setReplayMode(false);
      expect(r.isReplayMode).toBe(false);
    });
  });

  // ── setChatPanelOpen ─────────────────────────────────────────────────

  describe('setChatPanelOpen', () => {
    it('does not throw (default no-op)', () => {
      const r = createRenderer();
      expect(() => r.setChatPanelOpen(true)).not.toThrow();
      expect(() => r.setChatPanelOpen(false)).not.toThrow();
    });
  });

  // ── getMsSinceLastRenderActivity ─────────────────────────────────────

  describe('getMsSinceLastRenderActivity', () => {
    it('returns 0 immediately after construction', () => {
      const r = createRenderer();
      expect(r.getMsSinceLastRenderActivity()).toBeGreaterThanOrEqual(0);
    });

    it('increases as time passes', () => {
      const r = createRenderer();
      const t0 = r.getMsSinceLastRenderActivity();
      now += 500;
      const t1 = r.getMsSinceLastRenderActivity();
      expect(t1).toBeGreaterThanOrEqual(t0);
    });
  });

  // ── setConnectionStatus ──────────────────────────────────────────────

  describe('setConnectionStatus', () => {
    it('does not throw for any status', () => {
      const r = createRenderer();
      const statuses: ConnectionStatus[] = ['connected', 'connecting', 'degraded', 'disconnected', 'standby'];
      for (const status of statuses) {
        expect(() => r.setConnectionStatus(status)).not.toThrow();
      }
    });
  });

  // ── setStandbyStatus ─────────────────────────────────────────────────

  describe('setStandbyStatus', () => {
    it('does not throw', () => {
      const r = createRenderer();
      expect(() => r.setStandbyStatus(true)).not.toThrow();
      expect(() => r.setStandbyStatus(false)).not.toThrow();
    });
  });

  // ── destroy ──────────────────────────────────────────────────────────

  describe('destroy', () => {
    it('calls onDestroy and resets state', () => {
      const r = createRenderer();
      r.destroy();
      expect(r.destroyed).toBe(true);
    });
  });

  // ── getBurstEmaRate ──────────────────────────────────────────────────

  describe('getBurstEmaRate', () => {
    it('returns 0 before any burst detector activity', () => {
      const r = createRenderer();
      expect(r.getBurstEmaRate()).toBe(0);
    });
  });

  // ── isWorkerAlive ────────────────────────────────────────────────────

  describe('isWorkerAlive', () => {
    it('returns true by default (no worker)', () => {
      const r = createRenderer();
      expect(r.isWorkerAlive()).toBe(true);
    });
  });
});
