// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { describe, it, expect, vi } from 'vitest';
import {
  buildPartialWorkerConfig,
  sendUpdateConfigToWorker,
  sendSetPausedToWorker,
  sendClearStateToWorker,
} from '@renderer/worker/common';
import type { OverlaySettings } from '@app-types';

// Minimal settings shape for testing — all fields the worker config picks from
const mockSettings = {
  safeTop: 0.05,
  safeBottom: 0.05,
  fontSize: 16,
  fontWeight: 400 as const,
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
  depthLayersEnabled: true,
  depthFarOpacityMul: 0.6,
  backlogOpacityMultiplier: 0.5,
  opacity: 1,
  fadeDurationMs: 300,
  showAuthor: { normal: true, superchat: true, membership: true, owner: true, moderator: true },
  authorRateLimit: 'off' as const,
  burstSampleWindow: 10,
  burstElevatedThreshold: 5,
  burstHighThreshold: 15,
  burstExtremeThreshold: 30,
  backlogToggleCooldownMs: 5000,
  backlogPauseThreshold: 0.9,
  backlogResumeThreshold: 0.5,
  queueMaxSize: 500,
  topBottomDurationMs: 0,
  translationEnabled: false,
  translationService: 'none' as const,
  translationSource: 'auto' as const,
  translationTarget: 'en' as const,
  superChatMaxBodyLines: 2,
  membershipMaxBodyLines: 2,
  emojiFetchTimeout: 3000,
  livePollFallbackMs: 2000,
  minPollIntervalMs: 200,
  maxPollIntervalMs: 2000,
} as unknown as OverlaySettings;

describe('buildPartialWorkerConfig', () => {
  it('picks only the specified keys', () => {
    const config = buildPartialWorkerConfig(mockSettings, ['fontSize', 'laneSpacing']);
    expect(Object.keys(config)).toEqual(['fontSize', 'laneSpacing']);
    expect(config.fontSize).toBe(16);
    expect(config.laneSpacing).toBe(4);
  });

  it('returns empty object for empty keys array', () => {
    const config = buildPartialWorkerConfig(mockSettings, []);
    expect(Object.keys(config)).toHaveLength(0);
  });

  it('picks all provided keys with correct values', () => {
    const keys: (keyof OverlaySettings)[] = ['fontSize', 'fontWeight', 'fontFamily', 'opacity'];
    const config = buildPartialWorkerConfig(mockSettings, keys);
    expect(config.fontSize).toBe(16);
    expect(config.fontWeight).toBe(400);
    expect(config.fontFamily).toBe('sans-serif');
    expect(config.opacity).toBe(1);
  });

  it('copies boolean values correctly', () => {
    const config = buildPartialWorkerConfig(mockSettings, ['depthLayersEnabled', 'showDebugOverlay']);
    expect(config.depthLayersEnabled).toBe(true);
    expect(config.showDebugOverlay).toBe(false);
  });

  it('copies object values (like showAuthor) by reference', () => {
    const config = buildPartialWorkerConfig(mockSettings, ['showAuthor']);
    expect(config.showAuthor).toEqual({
      normal: true,
      superchat: true,
      membership: true,
      owner: true,
      moderator: true,
    });
  });

  it('does not include keys not in the provided list', () => {
    const config = buildPartialWorkerConfig(mockSettings, ['fontSize']);
    expect(config).not.toHaveProperty('laneSpacing');
    expect(config).not.toHaveProperty('safeTop');
  });

  it('returns unknown record type (duck-typed)', () => {
    const config = buildPartialWorkerConfig(mockSettings, ['fontSize']);
    // buildPartialWorkerConfig returns Record<string, unknown>
    expect(typeof config.fontSize).toBe('number');
  });
});

// ── sendUpdateConfigToWorker ────────────────────────────────────────────

describe('sendUpdateConfigToWorker', () => {
  it('posts updateConfig message with config', () => {
    const postMessage = vi.fn();
    const manager = { worker: { postMessage } as unknown as Worker };

    sendUpdateConfigToWorker(manager, { speedPxPerSec: 150, opacity: 0.8 });

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({
      type: 'updateConfig',
      config: { speedPxPerSec: 150, opacity: 0.8 },
    });
  });

  it('no-ops when worker is null', () => {
    const manager = { worker: null };
    expect(() => sendUpdateConfigToWorker(manager, {})).not.toThrow();
  });
});

// ── sendSetPausedToWorker ───────────────────────────────────────────────

describe('sendSetPausedToWorker', () => {
  it('posts setPaused message with paused flag and no videoPaused', () => {
    const postMessage = vi.fn();
    const manager = { worker: { postMessage } as unknown as Worker };

    sendSetPausedToWorker(manager, true);

    expect(postMessage).toHaveBeenCalledWith({
      type: 'setPaused',
      paused: true,
      videoPaused: undefined,
    });
  });

  it('includes videoPaused when provided', () => {
    const postMessage = vi.fn();
    const manager = { worker: { postMessage } as unknown as Worker };

    sendSetPausedToWorker(manager, false, true);

    expect(postMessage).toHaveBeenCalledWith({
      type: 'setPaused',
      paused: false,
      videoPaused: true,
    });
  });

  it('no-ops when worker is null', () => {
    const manager = { worker: null };
    expect(() => sendSetPausedToWorker(manager, true)).not.toThrow();
  });
});

// ── sendClearStateToWorker ──────────────────────────────────────────────

describe('sendClearStateToWorker', () => {
  it('posts clearState message', () => {
    const postMessage = vi.fn();
    const manager = { worker: { postMessage } as unknown as Worker };

    sendClearStateToWorker(manager);

    expect(postMessage).toHaveBeenCalledWith({ type: 'clearState' });
  });

  it('no-ops when worker is null', () => {
    const manager = { worker: null };
    expect(() => sendClearStateToWorker(manager)).not.toThrow();
  });
});
