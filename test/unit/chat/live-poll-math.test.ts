// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

import { describe, expect, it } from 'vitest';
import {
  computeErrorBackoffMs,
  computeBurstAdjustedMs,
  computeDensityAdjustedMs,
  calculateAdaptiveDelay,
  recordDensitySample,
} from '@chat/live-poll-math';

const limits = { minPollIntervalMs: 500, maxPollIntervalMs: 30000 };

describe('live-poll-math', () => {
  describe('recordDensitySample', () => {
    it('writes sample and advances cursor', () => {
      const ring = new Uint16Array(5);
      const result = recordDensitySample(ring, 0, 0, 10);
      expect(result.write).toBe(1);
      expect(result.filled).toBe(1);
      expect(ring[0]).toBe(10);
    });

    it('wraps cursor at window size', () => {
      const ring = new Uint16Array(5);
      const result = recordDensitySample(ring, 4, 5, 10);
      expect(result.write).toBe(0);
      expect(result.filled).toBe(5); // already full
    });
  });

  describe('computeErrorBackoffMs', () => {
    it('returns null for zero errors', () => {
      expect(computeErrorBackoffMs(1000, 0, limits)).toBeNull();
    });

    it('returns a delayed value for 1 error', () => {
      const result = computeErrorBackoffMs(1000, 1, limits);
      expect(result).toBe(2000); // 1000 * 2^1
    });

    it('caps at maxPollIntervalMs', () => {
      const result = computeErrorBackoffMs(2000, 10, limits);
      expect(result).toBeLessThanOrEqual(limits.maxPollIntervalMs);
    });
  });

  describe('computeBurstAdjustedMs', () => {
    it('returns null for undefined emaRate', () => {
      expect(computeBurstAdjustedMs(1000, undefined, limits)).toBeNull();
    });

    it('returns 0 for extreme density', () => {
      const result = computeBurstAdjustedMs(1000, 30, limits);
      expect(result).toBe(0);
    });

    it('returns reduced interval for high density', () => {
      const result = computeBurstAdjustedMs(1000, 10, limits);
      expect(result).toBeGreaterThanOrEqual(limits.minPollIntervalMs);
      expect(result).toBeLessThan(1000);
    });
  });

  describe('computeDensityAdjustedMs', () => {
    it('falls back to provided ms for low sample count', () => {
      const ring = new Uint16Array(5);
      const result = computeDensityAdjustedMs(1000, ring, 1, limits);
      expect(result).toBeGreaterThanOrEqual(limits.minPollIntervalMs);
    });

    it('returns 0 for extreme average density', () => {
      const ring = new Uint16Array(5);
      ring.fill(30);
      const result = computeDensityAdjustedMs(1000, ring, 5, limits);
      expect(result).toBe(0);
    });
  });

  describe('calculateAdaptiveDelay', () => {
    it('returns error backoff when errors present', () => {
      const ring = new Uint16Array(5);
      const result = calculateAdaptiveDelay(1000, 2000, 1, undefined, ring, 0, limits);
      expect(result).toBeGreaterThan(1000);
    });

    it('returns burst adjusted when ema is high', () => {
      const ring = new Uint16Array(5);
      const result = calculateAdaptiveDelay(1000, 2000, 0, 10, ring, 0, limits);
      expect(result).toBeGreaterThanOrEqual(limits.minPollIntervalMs);
    });
  });
});