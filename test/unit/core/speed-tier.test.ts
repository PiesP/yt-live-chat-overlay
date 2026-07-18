// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { describe, it, expect } from 'vitest';
import { getSpeedTier, type SpeedTierConfig } from '@renderer/canvas/speed-tier';
import { computeBaseHeadwayPx } from '@renderer/layout/lane-shared';
import { SPEED_TIER } from '@renderer/constants';
import type { ChatMessage } from '@app-types';

// ── Helpers ───────────────────────────────────────────────────────────────

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    text: 'hello',
    content: [{ type: 'text' as const, content: 'hello' }],
    kind: 'text' as const,
    timestamp: 1234567890,
    authorType: 'normal' as const,
    ...overrides,
  };
}

const scrollConfig: SpeedTierConfig = {
  depthLayersEnabled: true,
  danmakuMode: 'scroll',
};

const disabledConfig: SpeedTierConfig = {
  depthLayersEnabled: false,
  danmakuMode: 'scroll',
};

const topConfig: SpeedTierConfig = {
  depthLayersEnabled: true,
  danmakuMode: 'top',
};

// ═══════════════════════════════════════════════════════════════════════════
// getSpeedTier
// ═══════════════════════════════════════════════════════════════════════════

describe('getSpeedTier', () => {
  // ── Backlog ────────────────────────────────────────────────────────────

  it('returns BACKLOG tier for backlog messages', () => {
    const msg = makeMessage({ isBacklog: true });
    expect(getSpeedTier(msg, scrollConfig)).toBe(SPEED_TIER.BACKLOG);
  });

  it('returns BACKLOG regardless of depthLayersEnabled', () => {
    const msg = makeMessage({ isBacklog: true });
    expect(getSpeedTier(msg, disabledConfig)).toBe(SPEED_TIER.BACKLOG);
  });

  // ── Depth layers disabled ──────────────────────────────────────────────

  it('returns MID when depth layers are disabled', () => {
    const msg = makeMessage();
    expect(getSpeedTier(msg, disabledConfig)).toBe(SPEED_TIER.MID);
  });

  it('returns MID for SuperChat when depth layers are disabled', () => {
    const msg = makeMessage({ kind: 'superchat' });
    expect(getSpeedTier(msg, disabledConfig)).toBe(SPEED_TIER.MID);
  });

  // ── Non-scroll modes ───────────────────────────────────────────────────

  it('returns MID for top mode', () => {
    const msg = makeMessage();
    expect(getSpeedTier(msg, topConfig)).toBe(SPEED_TIER.MID);
  });

  it('returns MID for bottom mode', () => {
    const msg = makeMessage();
    const cfg: SpeedTierConfig = { depthLayersEnabled: true, danmakuMode: 'bottom' };
    expect(getSpeedTier(msg, cfg)).toBe(SPEED_TIER.MID);
  });

  // ── Paid messages → NEAR ───────────────────────────────────────────────

  it('returns NEAR for superchat messages in scroll mode', () => {
    const msg = makeMessage({ kind: 'superchat' });
    expect(getSpeedTier(msg, scrollConfig)).toBe(SPEED_TIER.NEAR);
  });

  it('returns NEAR for membership messages in scroll mode', () => {
    const msg = makeMessage({ kind: 'membership' });
    expect(getSpeedTier(msg, scrollConfig)).toBe(SPEED_TIER.NEAR);
  });

  // ── Deterministic assignment ───────────────────────────────────────────

  it('returns same tier for same message ID (deterministic)', () => {
    const msg1 = makeMessage({ id: 'fixed-id-123' });
    const msg2 = makeMessage({ id: 'fixed-id-123' });
    expect(getSpeedTier(msg1, scrollConfig)).toBe(getSpeedTier(msg2, scrollConfig));
  });

  it('returns same tier for same message ID across calls', () => {
    const msg = makeMessage({ id: 'stable-id' });
    const t1 = getSpeedTier(msg, scrollConfig);
    const t2 = getSpeedTier(msg, scrollConfig);
    expect(t1).toBe(t2);
  });

  it('falls back to timestamp hash when id is missing', () => {
    const msg = makeMessage({ id: undefined, timestamp: 999999 });
    const tier = getSpeedTier(msg, scrollConfig);
    expect([SPEED_TIER.NEAR, SPEED_TIER.FAR]).toContain(tier);
  });

  it('returns NEAR or FAR (never MID or BACKLOG) for regular messages', () => {
    const msg = makeMessage();
    const tier = getSpeedTier(msg, scrollConfig);
    expect([SPEED_TIER.NEAR, SPEED_TIER.FAR]).toContain(tier);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// computeBaseHeadwayPx (shared between main-thread and worker renderer)
// ═══════════════════════════════════════════════════════════════════════════

describe('computeBaseHeadwayPx', () => {
  it('returns clamped value (min 16, max 60)', () => {
    // 200 × 0.08 = 16 → exactly at min
    expect(computeBaseHeadwayPx(200, 0.08)).toBe(16);
    // 800 × 0.08 = 64 → clamped to 60
    expect(computeBaseHeadwayPx(800, 0.08)).toBe(60);
    // 500 × 0.08 = 40 → within range
    expect(computeBaseHeadwayPx(500, 0.08)).toBe(40);
  });

  it('returns HEADWAY_GAP_MIN_PX for NaN or Infinity inputs', () => {
    expect(computeBaseHeadwayPx(NaN, 0.08)).toBe(16);
    expect(computeBaseHeadwayPx(200, Infinity)).toBe(16);
    expect(computeBaseHeadwayPx(200, NaN)).toBe(16);
  });

  it('clamps below minimum', () => {
    // 50 × 0.08 = 4 → clamped to 16
    expect(computeBaseHeadwayPx(50, 0.08)).toBe(16);
    // 0 × anything = 0 → clamped to 16
    expect(computeBaseHeadwayPx(0, 0.08)).toBe(16);
  });

  it('handles ratio of zero', () => {
    // 500 × 0 = 0 → clamped to 16 (min)
    expect(computeBaseHeadwayPx(500, 0)).toBe(16);
  });
});
