// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { describe, it, expect } from 'vitest';
import { getSpeedTier, computeHeadwayPx, type SpeedTierConfig } from '@renderer/canvas/speed-tier';
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
// computeHeadwayPx
// ═══════════════════════════════════════════════════════════════════════════

describe('computeHeadwayPx', () => {
  it('returns activeWidth × headwayGapRatio for normal tiers', () => {
    const result = computeHeadwayPx(200, SPEED_TIER.MID, SPEED_TIER.NEAR, 0.08, 2);
    expect(result).toBe(Math.round(200 * 0.08)); // 16
  });

  it('does NOT apply multiplier when active is BACKLOG (NEAR < BACKLOG numerically)', () => {
    // SPEED_TIER: FAR=0, MID=1, NEAR=2, BACKLOG=3
    // No tier is > BACKLOG, so the multiplier branch is unreachable
    // with the current tier values. Test verifies the base value is returned.
    const base = Math.round(200 * 0.08); // 16
    const result = computeHeadwayPx(200, SPEED_TIER.BACKLOG, SPEED_TIER.NEAR, 0.08, 2);
    expect(result).toBe(base); // 16 — NEAR (2) is NOT > BACKLOG (3)
  });

  it('does NOT apply multiplier when active is BACKLOG but new is same tier', () => {
    const result = computeHeadwayPx(200, SPEED_TIER.BACKLOG, SPEED_TIER.BACKLOG, 0.08, 2);
    expect(result).toBe(Math.round(200 * 0.08)); // 16 — no multiplier
  });

  it('does NOT apply multiplier when active is not BACKLOG', () => {
    const result = computeHeadwayPx(200, SPEED_TIER.MID, SPEED_TIER.NEAR, 0.08, 3);
    expect(result).toBe(Math.round(200 * 0.08)); // 16 — no multiplier
  });

  it('returns 0 for zero width', () => {
    const result = computeHeadwayPx(0, SPEED_TIER.MID, SPEED_TIER.NEAR, 0.08, 2);
    expect(result).toBe(0);
  });

  it('handles extreme multiplier values (branch unreachable, returns base)', () => {
    // With current SPEED_TIER values, no tier is > BACKLOG (3),
    // so the multiplier branch never triggers.
    const base = Math.round(100 * 0.1); // 10
    const result = computeHeadwayPx(100, SPEED_TIER.BACKLOG, SPEED_TIER.NEAR, 0.1, 10);
    expect(result).toBe(base); // 10
  });

  it('handles ratio of zero', () => {
    const result = computeHeadwayPx(500, SPEED_TIER.MID, SPEED_TIER.NEAR, 0, 2);
    expect(result).toBe(0);
  });
});
