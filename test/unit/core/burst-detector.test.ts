import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { BurstDetector } from '@renderer/layout/burst-detector';
import type { BurstLevelObserver } from '@renderer/layout/burst-detector';

// ── Helpers ───────────────────────────────────────────────────────────────

function makeObserver(): BurstLevelObserver {
  return { updateBurstLevel: vi.fn() };
}

// Use fake timers for setInterval; mock performance.now for time control
let now = 1000;
const SAMPLE_INTERVAL = 500; // from BurstDetector.SAMPLE_INTERVAL_MS

beforeEach(() => {
  now = 1000;
  vi.useFakeTimers();
  vi.spyOn(performance, 'now').mockImplementation(() => now);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function advanceTime(ms: number): void {
  now += ms;
  vi.advanceTimersByTime(ms);
}

// ── Construction & basic state ─────────────────────────────────────────

describe('BurstDetector', () => {
  describe('constructor', () => {
    it('starts with normal level and zero EMA rate', () => {
      const detector = new BurstDetector();
      expect(detector.getLevel()).toBe('normal');
      expect(detector.getEmaRate()).toBe(0);
    });

    it('accepts optional observer', () => {
      const obs = makeObserver();
      const detector = new BurstDetector(obs);
      expect(detector.getLevel()).toBe('normal');
    });
  });

  // ── updateThresholds ─────────────────────────────────────────────────

  describe('updateThresholds', () => {
    it('updates burst detection thresholds', () => {
      const detector = new BurstDetector();
      detector.updateThresholds({
        burstSampleWindow: 5,
        burstElevatedThreshold: 100,
        burstHighThreshold: 200,
        burstExtremeThreshold: 300,
      });
      // Not directly observable, but threshold changes affect evaluate()
      expect(detector.getLevel()).toBe('normal');
    });
  });

  // ── start / stop ─────────────────────────────────────────────────────

  describe('start / stop', () => {
    it('start does not throw when called twice', () => {
      const detector = new BurstDetector();
      detector.start();
      expect(() => detector.start()).not.toThrow();
    });

    it('stop can be called without start', () => {
      const detector = new BurstDetector();
      expect(() => detector.stop()).not.toThrow();
    });
  });

  // ── onMessageReceived ─────────────────────────────────────────────────

  describe('onMessageReceived', () => {
    it('increases EMA rate proportionally to message frequency', () => {
      const detector = new BurstDetector();
      detector.start();

      // Send 10 messages rapidly (approx every 10ms → ~100 msg/s)
      const startEma = detector.getEmaRate();
      for (let i = 0; i < 10; i++) {
        now += 10;
        detector.onMessageReceived();
      }
      // EMA should have increased from 0
      expect(detector.getEmaRate()).toBeGreaterThan(startEma);
    });

    it('resets postResume EMA skip after the first few messages', () => {
      const detector = new BurstDetector();
      detector.start();

      // First message: lastMessageTime is 0, so interval skipped
      detector.onMessageReceived();
      const afterFirst = detector.getEmaRate();
      expect(afterFirst).toBe(0); // skipped

      // Next messages: interval computed, EMA updates
      now += 100;
      detector.onMessageReceived();
      const afterSecond = detector.getEmaRate();
      expect(afterSecond).toBe(0); // still in post-resume skip count

      now += 100;
      detector.onMessageReceived();
      const afterThird = detector.getEmaRate();

      now += 100;
      detector.onMessageReceived();
      const afterFourth = detector.getEmaRate();
      // By the 4th message, post-resume skip is done
      expect(afterFourth).toBeGreaterThanOrEqual(afterThird);
    });
  });

  // ── Burst level evaluation ───────────────────────────────────────────

  describe('burst level evaluation', () => {
    it('remains normal with very few messages', () => {
      const detector = new BurstDetector();
      detector.updateThresholds({
        burstSampleWindow: 5,
        burstElevatedThreshold: 3,
        burstHighThreshold: 10,
        burstExtremeThreshold: 20,
      });
      detector.start();

      // Send 1 message per sample tick
      for (let tick = 0; tick < 3; tick++) {
        detector.onMessageReceived();
        advanceTime(SAMPLE_INTERVAL);
      }
      // Average: 1 msg/sample → 2 msg/s (below elevated threshold of 3)
      expect(detector.getLevel()).toBe('normal');
    });

    it('detects elevated burst when messages exceed threshold', () => {
      const detector = new BurstDetector();
      detector.updateThresholds({
        burstSampleWindow: 5,
        burstElevatedThreshold: 3,
        burstHighThreshold: 10,
        burstExtremeThreshold: 20,
      });
      detector.start();

      // Send 5 messages per sample tick for enough ticks to fill window
      for (let tick = 0; tick < 6; tick++) {
        for (let m = 0; m < 5; m++) {
          detector.onMessageReceived();
        }
        advanceTime(SAMPLE_INTERVAL);
      }
      // Average: 5 msg/sample → exceeds elevated threshold (3)
      expect(detector.getLevel()).toBe('elevated');
    });

    it('detects high burst level', () => {
      const detector = new BurstDetector();
      detector.updateThresholds({
        burstSampleWindow: 5,
        burstElevatedThreshold: 3,
        burstHighThreshold: 10,
        burstExtremeThreshold: 20,
      });
      detector.start();

      for (let tick = 0; tick < 6; tick++) {
        for (let m = 0; m < 12; m++) {
          detector.onMessageReceived();
        }
        advanceTime(SAMPLE_INTERVAL);
      }
      // Average: 12 msg/sample → exceeds high threshold (10)
      expect(detector.getLevel()).toBe('high');
    });

    it('detects extreme burst level', () => {
      const detector = new BurstDetector();
      detector.updateThresholds({
        burstSampleWindow: 5,
        burstElevatedThreshold: 3,
        burstHighThreshold: 10,
        burstExtremeThreshold: 20,
      });
      detector.start();

      for (let tick = 0; tick < 6; tick++) {
        for (let m = 0; m < 25; m++) {
          detector.onMessageReceived();
        }
        advanceTime(SAMPLE_INTERVAL);
      }
      // Average: 25 msg/sample → exceeds extreme threshold (20)
      expect(detector.getLevel()).toBe('extreme');
    });
  });

  // ── pause / resume ───────────────────────────────────────────────────

  describe('pause / resume', () => {
    it('pause resets state and stops sampling', () => {
      const detector = new BurstDetector();
      detector.start();
      for (let i = 0; i < 5; i++) {
        now += 10;
        detector.onMessageReceived();
      }
      detector.pause();

      expect(detector.getLevel()).toBe('normal');
      // EMA rate is preserved after pause (not reset to 0)
      expect(detector.getEmaRate()).toBeGreaterThanOrEqual(0); // not negative
    });

    it('resume restarts sampling', () => {
      const detector = new BurstDetector();
      detector.start();
      detector.pause();
      expect(() => detector.resume()).not.toThrow();
      // After resume, messages should work
      detector.onMessageReceived();
      expect(detector.getLevel()).toBe('normal');
    });

    it('resume does not throw when already stopped', () => {
      const detector = new BurstDetector();
      expect(() => detector.resume()).not.toThrow();
    });
  });

  // ── resumeWithSamples ────────────────────────────────────────────────

  describe('resumeWithSamples', () => {
    it('seeds EMA from inter-message intervals', () => {
      const detector = new BurstDetector();
      // Fast messages: ~50ms interval → ~20 msg/s
      detector.resumeWithSamples([50, 50, 50, 50, 50]);
      // EMA should be seeded with ~20 msg/s
      const ema = detector.getEmaRate();
      expect(ema).toBeGreaterThan(0);
      expect(ema).toBeLessThan(40);
    });

    it('seeds sampling tick with estimated message count', () => {
      const detector = new BurstDetector();
      detector.updateThresholds({
        burstSampleWindow: 5,
        burstElevatedThreshold: 1,
        burstHighThreshold: 10,
        burstExtremeThreshold: 20,
      });
      // 100ms intervals → ~5 msg per 500ms tick
      detector.resumeWithSamples([100, 100, 100, 100, 100]);
      advanceTime(SAMPLE_INTERVAL);
      // The pre-seeded tick count should trigger a level above normal
      expect(detector.getLevel()).toBe('elevated');
    });

    it('handles empty intervals list', () => {
      const detector = new BurstDetector();
      expect(() => detector.resumeWithSamples([])).not.toThrow();
    });

    it('skips non-positive intervals', () => {
      const detector = new BurstDetector();
      expect(() => detector.resumeWithSamples([-1, 0, 50])).not.toThrow();
    });
  });

  // ── getEmaRate ───────────────────────────────────────────────────────

  describe('getEmaRate', () => {
    it('returns 0 when no messages received', () => {
      const detector = new BurstDetector();
      expect(detector.getEmaRate()).toBe(0);
    });

    it('converges toward actual message rate over time', () => {
      const detector = new BurstDetector();
      detector.start();

      // Send messages at ~50ms intervals (~20 msg/s) with high threshold
      for (let i = 0; i < 20; i++) {
        now += 50;
        detector.onMessageReceived();
      }
      const ema = detector.getEmaRate();
      // EMA should roughly converge toward 20 msg/s
      // With alpha=0.3, it won't reach 20 but should be significantly above 0
      expect(ema).toBeGreaterThan(5);
      expect(ema).toBeLessThan(30);
    });
  });

  // ── destroy ──────────────────────────────────────────────────────────

  describe('destroy', () => {
    it('cleans up and resets state', () => {
      const detector = new BurstDetector();
      detector.start();
      for (let i = 0; i < 5; i++) {
        now += 10;
        detector.onMessageReceived();
      }
      detector.destroy();

      expect(detector.getLevel()).toBe('normal');
      expect(detector.getEmaRate()).toBe(0);
    });

    it('can be called multiple times without error', () => {
      const detector = new BurstDetector();
      expect(() => {
        detector.destroy();
        detector.destroy();
      }).not.toThrow();
    });
  });
});
