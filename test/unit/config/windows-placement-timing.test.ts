// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { runInNewContext } from 'node:vm';

import type { BrowserContext } from '@playwright/test';
import { BurstDetector } from '@renderer/layout/burst-detector';
import { describe, expect, it, vi } from 'vite-plus/test';

import { assertInstrumentedPageScript } from '../../../validation/windows/native-page-script-probe.ts';
import {
  assertBacklogMotion,
  assertBacklogReflow,
  assertCompactRegularRows,
  assertSpacingPhase,
  canvasProbePrelude,
  findOverlappingActivePair,
  instrumentCardPlanCalls,
  instrumentCanvasPageScript,
  MIXED_BURST_SETTINGS,
  MIXED_PRESSURE_CHUNK_SIZE,
  MIXED_PRESSURE_COUNT,
  measureAllocationRowPitch,
  measureMixedHeightClearance,
  measureVisibleRowPitch,
  mixedPressureBatches,
  PLACEMENT_SCENARIOS,
  runPlacementTimingFixture,
  spacingFixtureIds,
  summarizeExactWorkerProbe,
  summarizeSamples,
  workerProbePrelude,
  workerProbeSuffix,
} from '../../../validation/windows/placement-timing.ts';

function spacingSnapshot(renderer: string, gap: number, origins: number[], offscreenIndex = -1) {
  const prefix = `WINDOWS196_GAP${gap}_`;
  const active = origins.map((y, index) => ({
    id: `${prefix}${index}`,
    x: index === offscreenIndex ? 900 : 10,
    y,
    width: 100,
    height: 44,
    startAtEpochMs: 900,
    endAtEpochMs: 1100,
  }));
  const draws = active.map(({ id, x, y }) => ({
    id,
    frameId: 7,
    alpha: 1,
    rect: { left: x, top: y, right: x + 100, bottom: y + 32 },
    japanese: { text: '東京', rect: { left: x, top: y, right: x + 50, bottom: y + 32 } },
  }));
  const config = { renderer, fontSize: 32, laneSpacing: gap };
  return {
    exact: { activeNow: active, config },
    renderFrame: {
      frameId: 7,
      complete: true,
      truncated: false,
      startedAtEpochMs: 1000,
      finishedAtEpochMs: 1001,
      logicalWidth: 800,
      logicalHeight: 400,
      backingRatioX: 2,
      backingRatioY: 2,
      config,
      active,
      draws,
    },
  };
}

describe('Windows placement timing probe', () => {
  it('covers fixed, reduced-motion, safe-zone, congestion and translation states with unique receipts', () => {
    const names = PLACEMENT_SCENARIOS.map((scenario: { name: string }) => scenario.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(
      expect.arrayContaining([
        'worker-top',
        'worker-bottom',
        'worker-reduced-toggle',
        'worker-safe-density',
        'worker-congestion',
        'worker-translation',
        'worker-replay',
        'worker-spacing-speed',
        'main-spacing-speed',
        'worker-mixed-gap',
        'main-mixed-gap',
      ])
    );
  });

  it('routes distinct Japanese message IDs to the zero-gap and eight-gap batches', () => {
    const { gap0, gap8 } = spacingFixtureIds();
    expect(gap0).toHaveLength(12);
    expect(gap8).toHaveLength(12);
    expect(gap0.every((id: string) => id.startsWith('WINDOWS196_GAP0_'))).toBe(true);
    expect(gap8.every((id: string) => id.startsWith('WINDOWS196_GAP8_'))).toBe(true);
    expect(new Set([...gap0, ...gap8]).size).toBe(24);
  });

  it('routes bounded parser callbacks that reach real half-cell density', () => {
    const pressure = ['2', '4', '5'].map((phase) => mixedPressureBatches(phase));
    const actions = pressure.flatMap((batches) => batches.flatMap((batch) => batch.actions));
    const ids = actions.map(
      (action: {
        addChatItemAction: {
          item: {
            liveChatTextMessageRenderer: { id: string };
          };
        };
      }) => action.addChatItemAction.item.liveChatTextMessageRenderer.id
    );
    expect(MIXED_PRESSURE_CHUNK_SIZE).toBeLessThan(5);
    expect(
      pressure.every((batches) =>
        batches.every(
          (batch: { actions: unknown[] }) => batch.actions.length > 0 && batch.actions.length < 5
        )
      )
    ).toBe(true);
    expect(
      pressure.every(
        (batches) =>
          batches.reduce(
            (count: number, batch: { actions: unknown[] }) => count + batch.actions.length,
            0
          ) === MIXED_PRESSURE_COUNT
      )
    ).toBe(true);
    const keys = pressure.flatMap((batches) => batches.map((batch: { key: string }) => batch.key));
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(ids).size).toBe(MIXED_PRESSURE_COUNT * pressure.length);
    vi.useFakeTimers();
    let now = 1000;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const levelAfterPressure = (count: number) => {
      const detector = new BurstDetector();
      try {
        detector.updateThresholds(MIXED_BURST_SETTINGS);
        detector.onMessageReceived();
        detector.onMessageReceived();
        for (let tick = 0; tick < 3; tick++) {
          now += 500;
          vi.advanceTimersByTime(500);
        }
        for (let index = 0; index < count; index++) detector.onMessageReceived();
        now += 500;
        vi.advanceTimersByTime(500);
        return detector.getLevel();
      } finally {
        detector.destroy();
      }
    };
    try {
      // Three 500ms windows span 1.5s; only rates above 10 msg/s are extreme.
      expect(levelAfterPressure(15)).toBe('high');
      expect(levelAfterPressure(16)).toBe('extreme');
      expect(levelAfterPressure(MIXED_PRESSURE_COUNT)).toBe('extreme');
    } finally {
      clock.mockRestore();
      vi.useRealTimers();
    }
  });

  it('labels active-origin spacing as allocation pitch', () => {
    const messages = [
      { id: 'WINDOWS196_GAP0_A', y: 13, height: 32 },
      { id: 'WINDOWS196_GAP0_B', y: 51, height: 32 },
      { id: 'WINDOWS196_GAP0_00', y: 89, height: 32 },
      { id: 'unrelated', y: 14, height: 32 },
    ];
    expect(measureAllocationRowPitch(messages)).toBe(38);
    expect(measureAllocationRowPitch(messages.slice(0, 1))).toBeNull();
  });

  it('measures compact row reservation across adaptive grid epochs', () => {
    const row = (id: string, slotCount: number, laneHeight: number, height = 44) => ({
      id,
      kind: 'activated',
      slotCount,
      laneHeight,
      height,
      laneSpacing: 0,
    });
    const full = row('WINDOWS196_GAP0_A', 1, 44);
    const subdivided = row('WINDOWS196_GAP0_B', 2, 22);
    expect(() => assertCompactRegularRows([full, subdivided])).not.toThrow();
    for (const invalid of [
      row(subdivided.id, 2, 44),
      row(subdivided.id, 1, 22),
      row(subdivided.id, 0, 22),
      row(subdivided.id, 2, Number.NaN),
    ]) {
      expect(() => assertCompactRegularRows([full, invalid])).toThrow(/extra baseline rows/);
    }
    expect(() => assertCompactRegularRows([full])).toThrow(/extra baseline rows/);
  });

  it.each(['main', 'worker'])(
    'accepts healthy sparse %s phase observations without comparing cohort pitch',
    (renderer) => {
      for (const offscreenMiddle of [false, true]) {
        const gap0 = spacingSnapshot(
          renderer,
          0,
          offscreenMiddle ? [0, 44, 88] : [0, 88],
          offscreenMiddle ? 1 : -1
        );
        const gap8 = spacingSnapshot(renderer, 8, [0, 52]);
        const before = assertSpacingPhase(gap0, 'WINDOWS196_GAP0_', 0, renderer);
        const after = assertSpacingPhase(gap8, 'WINDOWS196_GAP8_', 8, renderer);
        expect(before).toMatchObject({
          allocationPitchPx: offscreenMiddle ? 44 : 88,
          visibleRowPitch: {
            status: 'measured',
            pitchPx: 88,
            japaneseVisibleRowOriginsPx: [0, 88],
          },
        });
        expect(after).toMatchObject({
          allocationPitchPx: 52,
          visibleRowPitch: {
            status: 'measured',
            pitchPx: 52,
            japaneseVisibleRowOriginsPx: [0, 52],
          },
        });
        if (offscreenMiddle) {
          expect(before.visibleRowPitch.excluded).toContainEqual({
            id: 'WINDOWS196_GAP0_1',
            reason: 'offscreen_row',
          });
          expect(after.allocationPitchPx).toBeGreaterThan(before.allocationPitchPx);
        } else {
          // The old allocation assertion rejects case A, before the visibility comparison.
          expect(() =>
            expect(after.allocationPitchPx).toBeGreaterThanOrEqual(before.allocationPitchPx)
          ).toThrow();
        }
        // Case B passes the allocation comparison but fails the old visible comparison.
        expect(() =>
          expect(after.visibleRowPitch.pitchPx).toBeGreaterThanOrEqual(
            before.visibleRowPitch.pitchPx!
          )
        ).toThrow();
      }
      const adjacent0 = assertSpacingPhase(
        spacingSnapshot(renderer, 0, [0, 44]),
        'WINDOWS196_GAP0_',
        0,
        renderer
      );
      const adjacent8 = assertSpacingPhase(
        spacingSnapshot(renderer, 8, [0, 52]),
        'WINDOWS196_GAP8_',
        8,
        renderer
      );
      expect(adjacent0.visibleRowPitch.pitchPx).toBe(44);
      expect(adjacent8.visibleRowPitch.pitchPx).toBe(52);
    }
  );

  it.each(['main', 'worker'])(
    'keeps missing and incoherent %s phase evidence unavailable',
    (renderer) => {
      const valid = spacingSnapshot(renderer, 8, [0, 52]);
      for (const [name, frame] of [
        ['no rows', { ...valid.renderFrame, active: [], draws: [] }],
        [
          'one row',
          {
            ...valid.renderFrame,
            active: valid.renderFrame.active.slice(0, 1),
            draws: valid.renderFrame.draws.slice(0, 1),
          },
        ],
        ['incomplete', { ...valid.renderFrame, complete: false }],
        ['truncated', { ...valid.renderFrame, truncated: true }],
        [
          'wrong frame',
          {
            ...valid.renderFrame,
            draws: valid.renderFrame.draws.map((draw) => ({ ...draw, frameId: 8 })),
          },
        ],
        ['invalid viewport', { ...valid.renderFrame, logicalWidth: 0 }],
        [
          'zero alpha',
          {
            ...valid.renderFrame,
            draws: valid.renderFrame.draws.map((draw) => ({ ...draw, alpha: 0 })),
          },
        ],
        [
          'no Japanese ink',
          {
            ...valid.renderFrame,
            draws: valid.renderFrame.draws.map((draw) => ({ ...draw, japanese: null })),
          },
        ],
      ] as const) {
        const measured = measureVisibleRowPitch(frame, 'WINDOWS196_GAP8_');
        if (name !== 'no Japanese ink') {
          expect(measured.pitchPx, name).toBeNull();
          expect(['unknown', 'insufficient'], name).toContain(measured.status);
          expect(measured.reason, name).toEqual(expect.any(String));
        } else {
          expect(measured).toMatchObject({
            status: 'measured',
            pitchPx: 52,
            japaneseVisibleRowOriginsPx: [],
          });
        }
        expect(
          () =>
            assertSpacingPhase({ ...valid, renderFrame: frame }, 'WINDOWS196_GAP8_', 8, renderer),
          name
        ).toThrow(/two visible Japanese rows/);
      }
      expect(() => assertSpacingPhase(valid, 'WINDOWS196_GAP8_', 0, renderer)).toThrow(
        /phase Lane Gap/
      );
      expect(() =>
        assertSpacingPhase(
          {
            ...valid,
            exact: { ...valid.exact, config: { ...valid.exact.config, laneSpacing: 0 } },
          },
          'WINDOWS196_GAP8_',
          8,
          renderer
        )
      ).toThrow(/snapshot did not use/);
      expect(() =>
        assertSpacingPhase(valid, 'WINDOWS196_GAP8_', 8, renderer === 'main' ? 'worker' : 'main')
      ).toThrow(/wrong renderer/);
    }
  );

  it.each(['main', 'worker'])(
    'measures only two painted, eligible row origins in one %s frame',
    (renderer) => {
      const row = (id: string, x: number, y: number) => ({
        id,
        x,
        y,
        width: 100,
        height: 32,
        startAtEpochMs: 900,
        endAtEpochMs: 1100,
      });
      const draw = (id: string, top: number, alpha = 1, frameId = 7) => ({
        id,
        frameId,
        alpha,
        rect: { left: 10, top, right: 110, bottom: top + 32 },
        japanese: { text: '東京', rect: { left: 10, top, right: 50, bottom: top + 32 } },
      });
      const frame = {
        frameId: 7,
        complete: true,
        truncated: false,
        startedAtEpochMs: 1000,
        finishedAtEpochMs: 1001,
        logicalWidth: 800,
        logicalHeight: 400,
        backingRatioX: 2,
        backingRatioY: 2,
        config: { renderer, fontSize: 32, laneSpacing: 0 },
        active: [
          row('WINDOWS196_GAP0_A', 10, 0),
          row('WINDOWS196_GAP0_B', 10, 88),
          row('WINDOWS196_GAP0_C', 810, 44),
        ],
        draws: [
          draw('WINDOWS196_GAP0_A', 0),
          draw('WINDOWS196_GAP0_B', 88),
          draw('WINDOWS196_GAP0_C', 44),
        ],
      };
      expect(measureVisibleRowPitch(frame)).toMatchObject({
        status: 'measured',
        pitchPx: 88,
        includedIds: ['WINDOWS196_GAP0_A', 'WINDOWS196_GAP0_B'],
        excluded: [{ id: 'WINDOWS196_GAP0_C', reason: 'offscreen_row' }],
        japaneseVisibleIds: ['WINDOWS196_GAP0_A', 'WINDOWS196_GAP0_B'],
        japaneseVisibleRowOriginsPx: [0, 88],
      });
      const sameJapaneseRow = measureVisibleRowPitch({
        ...frame,
        active: [
          row('WINDOWS196_GAP0_A', 10, 0),
          row('WINDOWS196_GAP0_B', 10, 0),
          row('WINDOWS196_GAP0_C', 10, 88),
        ],
        draws: [
          draw('WINDOWS196_GAP0_A', 0),
          draw('WINDOWS196_GAP0_B', 0),
          { ...draw('WINDOWS196_GAP0_C', 88), japanese: null },
        ],
      });
      expect(sameJapaneseRow).toMatchObject({
        status: 'measured',
        pitchPx: 88,
        japaneseVisibleIds: ['WINDOWS196_GAP0_A', 'WINDOWS196_GAP0_B'],
        japaneseVisibleRowOriginsPx: [0],
      });
      expect(sameJapaneseRow.japaneseVisibleRowOriginsPx).toHaveLength(1);
      expect(
        measureVisibleRowPitch({
          ...frame,
          active: frame.active.slice(0, 1),
          draws: frame.draws.slice(0, 1),
        })
      ).toMatchObject({ status: 'insufficient', pitchPx: null });
      expect(
        measureVisibleRowPitch({
          ...frame,
          active: [row('WINDOWS196_GAP0_A', 10, 0), row('WINDOWS196_GAP0_B', 10, 0)],
          draws: [draw('WINDOWS196_GAP0_A', 0), draw('WINDOWS196_GAP0_B', 0)],
        })
      ).toMatchObject({ status: 'insufficient', pitchPx: null });
      expect(
        measureVisibleRowPitch({
          ...frame,
          active: frame.active.map((entry) => ({
            ...entry,
            x: 900,
          })),
        })
      ).toMatchObject({ status: 'insufficient', pitchPx: null });
      expect(
        measureVisibleRowPitch({
          ...frame,
          draws: [draw('WINDOWS196_GAP0_A', 0), draw('WINDOWS196_GAP0_B', 10)],
        })
      ).toMatchObject({ status: 'unknown', pitchPx: null, reason: 'draw_row_mismatch' });
      expect(
        measureVisibleRowPitch({
          ...frame,
          draws: [...frame.draws, draw('WINDOWS196_GAP0_MISSING', 132)],
        })
      ).toMatchObject({ status: 'unknown', pitchPx: null, reason: 'draw_without_active_row' });
    }
  );

  it('excludes future, expired, undrawn and transparent rows, and rejects incoherent frames', () => {
    const row = (id: string, y: number, start = 900, end = 1100) => ({
      id,
      x: 10,
      y,
      width: 100,
      height: 30,
      startAtEpochMs: start,
      endAtEpochMs: end,
    });
    const draw = (id: string, top: number, alpha = 1, frameId = 9) => ({
      id,
      frameId,
      alpha,
      rect: { left: 10, top, right: 110, bottom: top + 30 },
    });
    const frame = {
      frameId: 9,
      complete: true,
      truncated: false,
      startedAtEpochMs: 1000,
      finishedAtEpochMs: 1001,
      logicalWidth: 800,
      logicalHeight: 400,
      backingRatioX: 2,
      backingRatioY: 2,
      config: { renderer: 'main', fontSize: 32, laneSpacing: 0 },
      active: [
        row('WINDOWS196_GAP0_A', 0),
        row('WINDOWS196_GAP0_B', 88),
        row('WINDOWS196_GAP0_FUTURE', 44, 1050, 1200),
        row('WINDOWS196_GAP0_EXPIRED', 66, 850, 990),
        row('WINDOWS196_GAP0_NODRAW', 132),
        row('WINDOWS196_GAP0_ZERO', 176),
      ],
      draws: [
        draw('WINDOWS196_GAP0_A', 0),
        draw('WINDOWS196_GAP0_B', 88),
        draw('WINDOWS196_GAP0_FUTURE', 44),
        draw('WINDOWS196_GAP0_EXPIRED', 66),
        draw('WINDOWS196_GAP0_ZERO', 176, 0),
      ],
    };
    expect(measureVisibleRowPitch(frame)).toMatchObject({
      status: 'measured',
      pitchPx: 88,
      excluded: [
        { id: 'WINDOWS196_GAP0_FUTURE', reason: 'future' },
        { id: 'WINDOWS196_GAP0_EXPIRED', reason: 'expired' },
        { id: 'WINDOWS196_GAP0_NODRAW', reason: 'no_current_frame_draw' },
        { id: 'WINDOWS196_GAP0_ZERO', reason: 'zero_alpha' },
      ],
    });
    for (const bad of [
      { ...frame, complete: false },
      { ...frame, truncated: true },
      { ...frame, logicalWidth: null },
      { ...frame, finishedAtEpochMs: null },
      { ...frame, draws: null },
      { ...frame, config: {} },
    ]) {
      expect(measureVisibleRowPitch(bad)).toMatchObject({ status: 'unknown', pitchPx: null });
    }
    expect(
      measureVisibleRowPitch({
        ...frame,
        draws: [draw('WINDOWS196_GAP0_A', 0, 1, 8), draw('WINDOWS196_GAP0_B', 88)],
      })
    ).toMatchObject({ status: 'unknown', pitchPx: null, reason: 'draw_frame_mismatch' });
    expect(
      measureVisibleRowPitch({
        ...frame,
        active: [row('WINDOWS196_GAP0_A', 0, 1000.5), row('WINDOWS196_GAP0_B', 88)],
        draws: frame.draws.slice(0, 2),
      })
    ).toMatchObject({
      status: 'unknown',
      pitchPx: null,
      reason: 'eligibility_changed_during_frame',
    });
  });

  it.each(['main', 'worker'])(
    'requires two simultaneous painted mixed-height rows in a complete %s frame',
    (renderer) => {
      const row = (
        id: string,
        x: number,
        y: number,
        height: number,
        startAtEpochMs = 900,
        endAtEpochMs = 1100
      ) => ({ id, x, y, width: 100, height, startAtEpochMs, endAtEpochMs });
      const draw = (id: string, x: number, y: number, height: number, alpha = 1) => ({
        id,
        frameId: 11,
        alpha,
        rect: { left: x, top: y, right: x + 100, bottom: y + height },
      });
      const regular = row('WINDOWS204_MIX_REGULAR', 10, 5, 46);
      const paid = row('W204P', 10, 59, 44);
      const frame = {
        frameId: 11,
        complete: true,
        truncated: false,
        startedAtEpochMs: 1000,
        finishedAtEpochMs: 1001,
        logicalWidth: 800,
        logicalHeight: 400,
        backingRatioX: 2,
        backingRatioY: 2,
        config: {
          renderer,
          fontSize: 32,
          laneSpacing: 8,
          mode: 'top',
          laneDensityFactor: 0.5,
          safeTop: 0,
          safeBottom: 0,
        },
        active: [regular, paid],
        draws: [draw(regular.id, 10, 5, 46), draw(paid.id, 10, 59, 44)],
      };
      expect(measureMixedHeightClearance(frame)).toMatchObject({
        status: 'measured',
        minimumGapPx: 8,
        paintedIds: [regular.id, paid.id],
        pairs: [{ ids: [regular.id, paid.id], gapPx: 8 }],
      });
      expect(
        measureMixedHeightClearance({
          ...frame,
          config: { ...frame.config, laneDensityFactor: 0.75 },
        })
      ).toMatchObject({
        status: 'unknown',
        reason: 'wrong_lane_density',
        observedLaneDensityFactor: 0.75,
      });
      const violation = {
        ...frame,
        active: [regular, { ...paid, y: 52 }],
        draws: [frame.draws[0], draw(paid.id, 10, 52, 44)],
      };
      expect(measureMixedHeightClearance(violation)).toMatchObject({
        status: 'violation',
        minimumGapPx: 1,
        pairs: [{ gapPx: 1 }],
      });
      expect(
        measureMixedHeightClearance({
          ...frame,
          active: [regular, { ...paid, y: 5 }],
          draws: [frame.draws[0], draw(paid.id, 10, 5, 44)],
        })
      ).toMatchObject({
        status: 'violation',
        minimumGapPx: -46,
      });
      for (const safeZone of [
        { safeTop: 0.1, safeBottom: 0 },
        { safeTop: 0, safeBottom: 0.8 },
      ]) {
        expect(
          measureMixedHeightClearance({ ...frame, config: { ...frame.config, ...safeZone } })
        ).toMatchObject({
          status: 'violation',
          reason: expect.stringContaining('content_outside_safe_zone_'),
        });
      }
      for (const changed of [
        { ...frame, active: frame.active.slice(0, 1), draws: frame.draws.slice(0, 1) },
        { ...frame, active: [regular, { ...paid, height: 46 }] },
        {
          ...frame,
          active: [regular, { ...paid, x: 130 }],
          draws: [frame.draws[0], draw(paid.id, 130, 59, 44)],
        },
        { ...frame, active: [regular, { ...paid, startAtEpochMs: 1050 }] },
        {
          ...frame,
          active: [regular, { ...paid, x: 810 }],
          draws: [frame.draws[0], draw(paid.id, 810, 59, 44)],
        },
        { ...frame, draws: frame.draws.slice(0, 1) },
        { ...frame, draws: [frame.draws[0], draw(paid.id, 10, 59, 44, 0)] },
      ]) {
        expect(measureMixedHeightClearance(changed).status).not.toBe('measured');
      }
      for (const changed of [
        { ...frame, complete: false },
        { ...frame, truncated: true },
        { ...frame, finishedAtEpochMs: null },
        { ...frame, draws: [{ ...frame.draws[0], frameId: 12 }, frame.draws[1]] },
        { ...frame, config: { ...frame.config, laneSpacing: 0 } },
      ]) {
        expect(measureMixedHeightClearance(changed).status).toBe('unknown');
      }
    }
  );

  it('rejects clamped or burst-accelerated Backlog motion while retaining baseline comparison', () => {
    const motion = {
      id: 'WINDOWS195_BACKLOG_LONG',
      kind: 'activated',
      isBacklog: true,
      width: 2200,
      durationMs: 7160,
      travelDistancePx: 3580,
      burstSpeedMultiplier: 1.35,
      actualVelocityPxPerMs: 0.5,
    };
    expect(() => assertBacklogMotion(motion, 'worker')).not.toThrow();
    expect(() => assertBacklogMotion({ ...motion, burstSpeedMultiplier: null }, 'worker')).toThrow(
      /finite burst multiplier/
    );
    expect(() =>
      assertBacklogMotion({ ...motion, burstSpeedMultiplier: null }, 'main')
    ).not.toThrow();
    expect(() => assertBacklogMotion({ ...motion, durationMs: 5000 }, 'worker')).toThrow(/clamped/);
    const accelerated = { ...motion, durationMs: 3580 / 0.675, actualVelocityPxPerMs: 0.675 };
    expect(() => assertBacklogMotion(accelerated, 'worker')).toThrow(/extra burst/);
    expect(() => assertBacklogMotion(accelerated, 'worker', true)).not.toThrow();
  });

  it('keeps Canvas exact observations out of Worker-only timing fields', () => {
    const canvas = {
      exact: {
        dispositions: [{ id: 'WINDOWS196_GAP0_A' }],
        activeNow: [{ id: 'WINDOWS196_GAP0_A' }],
      },
    };
    expect(summarizeExactWorkerProbe(canvas, 'main')).toEqual({
      exactWorkerFrameMs: null,
      exactWorkerDrainMs: null,
      exactWorker: null,
    });
    const worker = {
      exact: { frames: [{ workMs: 2 }], drains: [{ workMs: 1 }], dispositions: [], active: [] },
    };
    expect(summarizeExactWorkerProbe(worker, 'worker')).toMatchObject({
      exactWorkerFrameMs: { count: 1, p95: 2 },
      exactWorkerDrainMs: { count: 1, p95: 1 },
    });
  });

  it('requires real video growth and retention of the same Backlog ID after reflow', () => {
    const before = {
      config: { logicalWidth: 858, logicalHeight: 482, fontSize: 32 },
      activeNow: [{ id: 'WINDOWS195_BACKLOG_LONG' }],
    };
    const after = {
      config: { logicalWidth: 998, logicalHeight: 561, fontSize: 32 },
      activeNow: [{ id: 'WINDOWS195_BACKLOG_LONG' }],
    };
    expect(() => assertBacklogReflow(before, after, 'WINDOWS195_BACKLOG_LONG')).not.toThrow();
    expect(() =>
      assertBacklogReflow(before, { ...after, config: before.config }, 'WINDOWS195_BACKLOG_LONG')
    ).toThrow(/video geometry/);
    expect(() =>
      assertBacklogReflow(before, { ...after, activeNow: [] }, 'WINDOWS195_BACKLOG_LONG')
    ).toThrow(/disappeared/);
  });

  it('adds a Canvas probe only at the expected packaged app entry', () => {
    const source =
      'function getRegularCardInsets() { return { vertical: 1 }; }\n' +
      'var CanvasRenderer = class CanvasRenderer extends RendererBase {};' +
      '\n\tmain();\n})();';
    const instrumented = instrumentCanvasPageScript(source, 'function probe() {}');
    expect(instrumented).toContain(';(function probe() {})(CanvasRenderer, getRegularCardInsets);');
    expect(
      instrumented?.replace('\n\t;(function probe() {})(CanvasRenderer, getRegularCardInsets);', '')
    ).toBe(source);
    expect(instrumentCanvasPageScript(source.replace('RendererBase', 'OtherBase'))).toBeNull();
    expect(instrumentCanvasPageScript(source.replace('})();', '\n\tmain();\n})();'))).toBeNull();
  });

  it('observes shared paid plans in readable and minified emitted shapes and rejects drift', () => {
    const readable =
      'function preparePaidCardPlan(input) { return { height: 1 }; }\n' +
      'function renderWrappedContentSegments() {}\n' +
      'function paint() { const plan = preparePaidCardPlan({ width: 1 }); ' +
      'renderWrappedContentSegments(ctx, plan.body); renderWrappedContentSegments(ctx, plan.translation); }\n' +
      'function getRegularCardInsets() {}\n' +
      'var CanvasRenderer = class CanvasRenderer extends RendererBase {};\n\tmain();\n})();';
    const canvas = instrumentCanvasPageScript(readable, 'function probe() {}', true);
    expect(() => assertInstrumentedPageScript(readable, canvas!)).not.toThrow();
    expect(canvas).toContain('var __ytOriginalPaidPlan = preparePaidCardPlan;');
    expect(canvas).toContain('return __ytObservePaidPlan(__ytOriginalPaidPlan, input);');
    expect(canvas).toContain('var __ytObservePaidPlan = function observePaidPlan');
    const minified =
      'function Mn(e){let t=Math.max(1,e.width-e.paddingH*2),n=e.showAuthor&&!!e.author;' +
      'return {height:t}};function Zt(e,t){};function paint(){let p=Mn({width:1,paddingH:0});' +
      'Zt(ctx,p.body);Zt(ctx,p.translation)}' +
      'self.onmessage=e=>{xr.handleMessage(e)};';
    const worker = instrumentCardPlanCalls(minified);
    expect(worker).toContain('__ytObservePaidPlan(Mn, {width:1,paddingH:0})');
    expect(worker && workerProbeSuffix(worker, undefined, true)).toContain('__ytObservePaidPlan');
    expect(worker && workerProbeSuffix(worker, undefined, true)).toContain(
      'wrapWrappedContent(Zt)'
    );
    expect(() =>
      runInNewContext(worker + workerProbeSuffix(worker!, undefined, true)!, {
        self: {},
        xr: { handleMessage() {} },
        __ytPlacementProbe: { wrapWrappedContent: (render: unknown) => render },
      })
    ).not.toThrow();
    expect(instrumentCardPlanCalls(minified.replace('e.showAuthor', 'e.showName'))).toBeNull();
    expect(workerProbeSuffix(minified, undefined, true)).toBeNull();
    let blobParts: unknown[] = [];
    class FakeBlob {
      constructor(parts: unknown[]) {
        blobParts = parts;
      }
    }
    const pageSandbox = {
      performance: { timeOrigin: 1000, now: () => 1 },
      requestAnimationFrame: () => 1,
      addEventListener: () => {},
      postMessage: () => {},
      MutationObserver: class {
        observe() {}
      },
      document: { querySelectorAll: () => [] },
      Blob: FakeBlob,
      Worker: class {},
      HTMLCanvasElement: class {},
    };
    runInNewContext(
      `${canvasProbePrelude({ observeCardPlans: true })}\n` +
        `new Blob([${JSON.stringify(minified.replace('self.onmessage', '/* OffscreenCanvas */self.onmessage'))}], { type: 'text/javascript' });`,
      pageSandbox
    );
    expect(blobParts).toHaveLength(3);
    expect(String(blobParts[1])).toContain('__ytObservePaidPlan(Mn,');
    expect(String(blobParts[2])).toContain('wrapWrappedContent(Zt)');
  });

  it('keeps the original paid-plan result and call count through an additive Canvas wrapper', () => {
    const source =
      '(() => { function preparePaidCardPlan(input) {' +
      'globalThis.planCalls++; return input; }\n' +
      'function renderWrappedContentSegments() {}\n' +
      'function paint(input) { const plan = preparePaidCardPlan({ width: input }); ' +
      'renderWrappedContentSegments(ctx, plan.body); renderWrappedContentSegments(ctx, plan.translation); return plan; }\n' +
      'function getRegularCardInsets() {}\n' +
      'var CanvasRenderer = class CanvasRenderer extends RendererBase {};\n' +
      'function main() { globalThis.planResult = paint(123); }\n\tmain();\n})();';
    const instrumented = instrumentCanvasPageScript(source, 'function probe() {}', true)!;
    expect(() => assertInstrumentedPageScript(source, instrumented)).not.toThrow();
    const sandbox = {
      RendererBase: class {},
      ctx: {},
      planCalls: 0,
      planResult: null,
      __ytPlacementProbe: { wrapWrappedContent: (render: unknown) => render },
    };
    runInNewContext(instrumented, sandbox);
    expect(sandbox.planCalls).toBe(1);
    expect(sandbox.planResult).toEqual({ width: 123 });
    expect(instrumentCanvasPageScript(instrumented, undefined, true)).toBeNull();
  });

  it('attributes fragmented paid rows and reused bitmap ink to the actual plan section', () => {
    const first = 'WINDOWS380_DETAILED_PAID';
    const second = 'WINDOWS380_DARK_PAID';
    const overlay = { width: 400, height: 200, closest: () => ({}) };
    const glyph = { width: 40, height: 25, closest: () => null };
    let nativeDraws = 0;
    class FakeContext {
      canvas: typeof overlay;
      globalAlpha = 1;
      font = '20px sans-serif';
      lineWidth = 1;
      constructor(canvas: typeof overlay) {
        this.canvas = canvas;
      }
      fillText() {
        nativeDraws++;
      }
      strokeText() {
        nativeDraws++;
      }
      drawImage() {
        nativeDraws++;
      }
      stroke() {}
      clearRect() {}
      measureText(text: string) {
        return {
          width: text.length * 8,
          actualBoundingBoxLeft: 0,
          actualBoundingBoxRight: text.length * 8,
          actualBoundingBoxAscent: 18,
          actualBoundingBoxDescent: 4,
        };
      }
      getTransform() {
        return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
      }
    }
    const source = `(() => {
      function preparePaidCardPlan(input) {
        globalThis.planCalls++;
        return { height: 70, body: { lines: [1], height: 22 }, bodyY: 10,
          translation: input.translatedText ? { lines: [1], height: 22 } : undefined,
          translationY: input.translatedText ? 35 : undefined };
      }
      function renderWrappedContentSegments(ctx, segments, x, y, maxWidth, maxLines,
        color, fontSize, outlineWidth, outlineOpacity, textCache, emojiCache,
        getFont, measure, prepared) {
        if (prepared === globalThis.lastPlan.body) {
          if (globalThis.ownerId === '${first}') new FakeContext(glyph).fillText('WIND', 0, 20);
          ctx.drawImage(glyph, 20, y, 40, 25);
        } else {
          ctx.fillText('한국어', 20, y);
        }
      }
      function paint(id, y) {
        globalThis.ownerId = id;
        const plan = preparePaidCardPlan({ content: [{ content: id + ' original' }],
          context: ctx, maxBodyLines: 4, translatedText: id === '${first}' ? '한국어' : null });
        globalThis.lastPlan = plan;
        renderWrappedContentSegments(ctx, [], 20, y + plan.bodyY, 200, 1,
          '', 20, 0, 0, null, null, null, null, plan.body);
        if (plan.translation) renderWrappedContentSegments(ctx, [], 20,
          y + plan.translationY, 200, 1, '', 20, 0, 0, null, null, null, null,
          plan.translation);
        return plan;
      }
      function getRegularCardInsets() {}
      var CanvasRenderer = class CanvasRenderer extends RendererBase {};
      function main() {
        const probe = globalThis.__ytPlacementProbe;
        const frame = probe.beginRenderFrame({ ctx, logicalWidth: 400, logicalHeight: 200,
          config: { logicalWidth: 400, logicalHeight: 200, superChatLayout: 'stacked' } });
        ctx.clearRect(0, 0, 400, 200);
        globalThis.firstPlan = paint('${first}', 10);
        globalThis.secondPlan = paint('${second}', 100);
        ctx.drawImage(glyph, 300, 170, 40, 25);
        probe.endRenderFrame(frame, [
          { id: '${first}', x: 10, y: 10, width: 200, height: 70 },
          { id: '${second}', x: 10, y: 100, width: 200, height: 70 }
        ]);
      }
\tmain();
    })();`;
    const instrumented = instrumentCanvasPageScript(source, undefined, true);
    expect(instrumented).not.toBeNull();
    expect(() => assertInstrumentedPageScript(source, instrumented!)).not.toThrow();
    const sandbox = {
      FakeContext,
      RendererBase: class {},
      overlay,
      glyph,
      ctx: new FakeContext(overlay),
      planCalls: 0,
      ownerId: '',
      lastPlan: null,
      firstPlan: null,
      secondPlan: null,
      CanvasRenderingContext2D: FakeContext,
      performance: { timeOrigin: 1000, now: () => 1 },
      requestAnimationFrame: () => 1,
      addEventListener: () => {},
      postMessage: () => {},
      MutationObserver: class {
        observe() {}
      },
      document: { querySelectorAll: () => [] },
      Blob: class {},
      Worker: class {},
      HTMLCanvasElement: class {},
    };
    runInNewContext(
      `${canvasProbePrelude({ tokens: [first, second], observeCardPlans: true })}\n${instrumented}`,
      sandbox
    );
    const frame = runInNewContext('__ytPlacementProbe.latestRenderFrame', sandbox);
    expect(sandbox.planCalls).toBe(2);
    expect(frame).toMatchObject({ complete: true, cleared: true, truncated: false });
    expect(
      frame.draws.map((draw: { id: string; section?: string }) => [draw.id, draw.section])
    ).toEqual([
      [first, 'body'],
      [first, 'translation'],
      [second, 'body'],
    ]);
    expect(
      frame.draws.every(
        (draw: { alpha: number; textSnippet: string | null }) =>
          draw.alpha > 0 && !draw.textSnippet?.includes('WINDOWS380_')
      )
    ).toBe(true);
    expect(nativeDraws).toBeGreaterThan(frame.draws.length);
    expect(sandbox.firstPlan).not.toBe(sandbox.secondPlan);
  });

  it('retains only a bounded first complete visible draw with its committed row', () => {
    const id = 'WINDOWS380_BRIGHT_STICKER';
    const sandbox = {
      performance: { timeOrigin: 1000, now: () => 1 },
      requestAnimationFrame: () => 1,
      addEventListener: () => {},
      postMessage: () => {},
    };
    const result = runInNewContext(
      `${workerProbePrelude([id])}
      const probe = globalThis.__ytPlacementProbe;
      const ctx = { canvas: { width: 400, height: 200 } };
      const row = { id: '${id}', x: 10, y: 10, width: 100, height: 30 };
      function finish({ complete = true, rowX = 10, drawX = 10, layout = 'stacked' } = {}) {
        const frame = probe.beginRenderFrame({ ctx, logicalWidth: 400, logicalHeight: 200,
          config: { logicalWidth: 400, logicalHeight: 200, superChatLayout: layout } });
        frame.cleared = complete;
        frame.draws.push({ id: '${id}', alpha: 1, backingRatioX: 1, backingRatioY: 1,
          rect: { left: drawX, right: drawX + 80, top: 10, bottom: 30 } });
        probe.endRenderFrame(frame, [{ ...row, x: rowX }]);
        return frame.frameId;
      }
      finish({ complete: false });
      finish({ rowX: 500 });
      finish({ drawX: 500 });
      const first = finish();
      finish({ rowX: 500 });
      finish({ layout: 'wide' });
      ({ first, stacked: probe.firstCompleteFrames['${id}|stacked']?.frameId,
        wide: probe.firstCompleteFrames['${id}|wide']?.frameId,
        count: Object.keys(probe.firstCompleteFrames).length,
        retainedRow: probe.firstCompleteFrames['${id}|stacked']?.active[0]?.id });`,
      sandbox
    );
    expect(result).toMatchObject({ first: 4, stacked: 4, wide: 6, count: 2, retainedRow: id });
  });

  it.each([
    [0, 'WINDOWS195_BACKLOG_LONG'],
    [2, 'WINDOWS195_BACKLOG_LONG'],
    [0, 'W193P'],
    [0, 'W204P'],
  ] as const)(
    'observes Canvas queue, committed motion, and %i unknown presentations for %s',
    (unknownPresentations, id) => {
      const source = `(() => {
      class RendererBase {}
      function getRegularCardInsets() { return { vertical: 1 }; }
      var CanvasRenderer = class CanvasRenderer extends RendererBase {
        constructor() {
          super(); this.settings = { fontSize: 32, laneSpacing: 0 }; this.activeMessages = [];
          this.pendingQueue = { items: [], get size() { return this.items.length; },
            toArray() { return this.items; } };
          this.laneAllocator = { getLaneHeight: () => 34, getLaneCount: () => 20 };
          this.overlay = { getDimensions: () => ({ width: 1280, height: 720 }) };
          this.observability = { getMetrics: () => ({ totalPresented: 1,
            totalPresentationUnknown: ${unknownPresentations} }) };
        }
        enqueueMessage(message) { this.pendingQueue.items.push(message); }
        placeQueuedMessage(message) {
          this.pendingQueue.items.shift(); this.activeMessages.push({ message, laneIndex: 1,
            x: 1280, y: 34, width: 2200, height: 34, slotCount: 1,
            motion: { durationMs: 7160, actualVelocityPxPerMs: .5,
              travelDistancePx: 3580, viewportEntryTime: 100, visibleExitTime: 7260 } });
          return { placed: true };
        }
        drainQueue() {}
        renderFrame() {}
      };
      function main() { const renderer = new CanvasRenderer();
        const message = { id: '${id}', isBacklog: ${id === 'WINDOWS195_BACKLOG_LONG'} };
        renderer.enqueueMessage(message); renderer.placeQueuedMessage(message);
        renderer.drainQueue(); renderer.renderFrame(); }
      main();
    })();`;
      const state: Record<string, unknown> = {
        beginRenderFrame: () => ({ frameId: 1, cleared: true }),
        endRenderFrame: () => {},
      };
      const script = instrumentCanvasPageScript(source.replace('      main();', '\tmain();'));
      expect(script).not.toBeNull();
      runInNewContext(script!, {
        __ytPlacementProbe: state,
        performance: { timeOrigin: 1000, now: () => 1 },
      });
      const exact = state.exact as {
        peaks: { pending: number; active: number };
        activeNow: Array<{ id: string }>;
        dispositions: Array<{
          id: string;
          laneHeight: number;
          travelDistancePx: number;
          burstSpeedMultiplier: number | null;
        }>;
        presentationCount: number | null;
        totalPresentationUnknown: number | null;
        drains: Array<{ workMs: number; pendingBefore: number }>;
      };
      expect(state.canvasSourceHooked).toBe(true);
      expect(exact.peaks).toEqual({ pending: 1, active: 1 });
      expect(exact.dispositions[0]).toMatchObject({
        id,
        laneHeight: 34,
        travelDistancePx: 3580,
        burstSpeedMultiplier: null,
      });
      expect(exact.presentationCount).toBe(1);
      expect(state.ingress).toMatchObject({ [id]: 1001 });
      expect(exact.activeNow).toContainEqual(expect.objectContaining({ id }));
      expect(exact.totalPresentationUnknown).toBe(unknownPresentations);
      expect(exact.drains).toEqual([
        { atEpochMs: 1001, workMs: 0, pendingBefore: 0, activeBefore: 1, activeAfter: 1 },
      ]);
      if (id === 'WINDOWS195_BACKLOG_LONG')
        expect(() => assertBacklogMotion(exact.dispositions[0], 'main')).not.toThrow();
    }
  );

  it.each(['main', 'worker'])(
    'joins native %s draws and row origins in the same complete frame',
    (renderer) => {
      const listeners: Record<string, (event: { origin: string; data: unknown }) => void> = {};
      const overlay = {
        width: renderer === 'main' ? 800 : 1600,
        height: renderer === 'main' ? 400 : 800,
        closest: () => ({}),
      };
      const bitmapA = { width: 200, height: 50, closest: () => null };
      const bitmapB = { width: 200, height: 50, closest: () => null };
      let nativeDraws = 0;
      let failNativeDraw = false;
      let clock = 100;
      class FakeContext {
        canvas: { width: number; height: number; closest: () => object | null };
        globalAlpha = 1;
        font = 'bold 32px sans-serif';
        lineWidth = 2;
        constructor(canvas: { width: number; height: number; closest: () => object | null }) {
          this.canvas = canvas;
        }
        fillText(_text: string, _x: number, _y: number) {
          if (failNativeDraw) throw new Error('Native draw failed');
          nativeDraws++;
        }
        strokeText(_text: string, _x: number, _y: number) {
          nativeDraws++;
        }
        drawImage(..._args: unknown[]) {
          nativeDraws++;
        }
        clearRect(..._args: number[]) {}
        measureText(text: string) {
          return {
            width: text.length * 10,
            actualBoundingBoxLeft: 0,
            actualBoundingBoxRight: text.length * 10,
            actualBoundingBoxAscent: 20,
            actualBoundingBoxDescent: 5,
          };
        }
        getTransform() {
          return { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 };
        }
      }
      const sandbox = {
        CanvasRenderingContext2D: FakeContext,
        OffscreenCanvasRenderingContext2D: FakeContext,
        FakeContext,
        overlay,
        bitmapA,
        bitmapB,
        self: undefined as unknown,
        performance: { timeOrigin: 1000, now: () => clock++ },
        requestAnimationFrame: (_callback: (time: number) => void) => 1,
        addEventListener: (
          type: string,
          listener: (event: { origin: string; data: unknown }) => void
        ) => {
          listeners[type] = listener;
        },
        postMessage: (_message: unknown) => {},
        MutationObserver: class {
          observe() {}
        },
        document: { querySelectorAll: () => [] },
        Blob: class {},
        Worker: class {},
        HTMLCanvasElement: class {},
      };
      const idA = 'WINDOWS196_GAP0_A';
      const idB = 'WINDOWS196_GAP0_B';
      const active = `[{ id: '${idA}', x: 10, y: 0, width: 100, height: 32,
      startTime: -100, pausedDuration: 0, duration: 1000 },
      { id: '${idB}', x: 10, y: 88, width: 100, height: 32,
      startTime: -100, pausedDuration: 0, duration: 1000 }]`;
      if (renderer === 'main') {
        const source = `(() => {
        class RendererBase {}
        function getRegularCardInsets() { return { vertical: 1 }; }
        var CanvasRenderer = class CanvasRenderer extends RendererBase {
          constructor() {
            super(); this.ctx = new FakeContext(overlay); this.canvas = overlay;
            this.settings = { fontSize: 32, laneSpacing: 0 }; this.activeMessages =
              ${active}.map((entry) => ({ ...entry, message: { id: entry.id } }));
            this.pendingQueue = { size: 0, toArray: () => [] };
            this.laneAllocator = { getLaneHeight: () => 34, getLaneCount: () => 20 };
            this.overlay = { getDimensions: () => ({ width: 800, height: 400 }) };
          }
          enqueueMessage() {} placeQueuedMessage() {} renderFrame() {
            this.canvas.width = 1600; this.canvas.height = 800;
            this.ctx.clearRect(0, 0, 800, 400);
            if (this.paint) {
              this.ctx.fillText('東京 ${idA} MATRIX_TRANSLATED', 10, 25);
              if (this.distortRatio) this.canvas.width = 1800;
              this.ctx.fillText('東京 ${idB}', 10, 113);
            }
          }
        };
        function main() { globalThis.fixtureRenderer = new CanvasRenderer();
          fixtureRenderer.paint = true; fixtureRenderer.renderFrame(); }
\tmain();
      })();`;
        const script = instrumentCanvasPageScript(source);
        expect(script).not.toBeNull();
        runInNewContext(`${canvasProbePrelude({ tokens: [idA, idB] })}\n${script}`, sandbox);
      } else {
        const source = `var sample = {
        ctx: new FakeContext(overlay), canvas: overlay,
        config: { fontSize: 32, laneSpacing: 0 }, logicalWidth: 800, logicalHeight: 400,
        activeMessages: ${active}, pendingQueue: [], numLanes: 20, laneHeight: 34,
        enqueueMessage() {}, activateMessage() {}, recordDrop() {},
        checkCollision() { return true; }, findPlacement() { return {}; }, drainQueue() {},
        renderFrame() {
          this.ctx.clearRect(0, 0, 800, 400);
          if (this.paint) {
            this.ctx.drawImage(bitmapA, 0, 0, 200, 50, 10, 5, 100, 25);
            this.ctx.drawImage(bitmapB, 10, 93, 100, 25);
          }
        }, handleMessage() {},
      }; self.onmessage=e=>{sample.handleMessage(e)};`;
        const suffix = workerProbeSuffix(source);
        expect(suffix).not.toBeNull();
        runInNewContext(
          `self = globalThis; ${workerProbePrelude([idA, idB])}\n${source}${suffix}`,
          sandbox
        );
        listeners.message?.({ origin: '', data: { type: 'init', canvas: overlay } });
        runInNewContext(
          `new FakeContext(bitmapA).fillText('東京 ${idA} MATRIX_TRANSLATED', 0, 20);
        new FakeContext(bitmapB).fillText('東京 ${idB}', 0, 20);
        sample.paint = true; sample.renderFrame();`,
          sandbox
        );
        expect(nativeDraws).toBeGreaterThan(0);
      }
      const frame = runInNewContext('__ytPlacementProbe.latestRenderFrame', sandbox);
      expect(
        runInNewContext('__ytPlacementProbe.exact.totalPresentationUnknown', sandbox)
      ).toBeNull();
      expect(frame).toMatchObject({
        frameId: 1,
        complete: true,
        logicalWidth: 800,
        logicalHeight: 400,
        backingRatioX: 2,
        backingRatioY: 2,
      });
      expect(frame.draws[0].rect).toMatchObject({ left: 10 });
      expect(frame.draws[0].textSnippet).toContain('MATRIX_TRANSLATED');
      expect(nativeDraws).toBeGreaterThan(0);
      if (renderer === 'main') {
        expect(measureVisibleRowPitch(frame)).toMatchObject({
          status: 'measured',
          pitchPx: 88,
          japaneseVisibleIds: [idA, idB],
          japaneseVisibleRowOriginsPx: [0, 88],
        });
        runInNewContext('fixtureRenderer.paint = false; fixtureRenderer.renderFrame();', sandbox);
      } else {
        expect(measureVisibleRowPitch(frame)).toMatchObject({
          status: 'measured',
          pitchPx: 88,
          japaneseVisibleIds: [idA, idB],
          japaneseVisibleRowOriginsPx: [0, 88],
        });
        runInNewContext('sample.paint = false; sample.renderFrame();', sandbox);
      }
      const next = runInNewContext('__ytPlacementProbe.latestRenderFrame', sandbox);
      expect(next.frameId).toBe(2);
      expect(next.draws).toHaveLength(0);
      expect(measureVisibleRowPitch(next)).toMatchObject({
        status: 'insufficient',
        pitchPx: null,
        reason: 'fewer_than_two_distinct_visible_rows',
      });
      if (renderer === 'main') {
        runInNewContext(
          'fixtureRenderer.paint = true; fixtureRenderer.distortRatio = true; fixtureRenderer.renderFrame();',
          sandbox
        );
        const incoherent = runInNewContext('__ytPlacementProbe.latestRenderFrame', sandbox);
        expect(incoherent.complete).toBe(false);
        expect(measureVisibleRowPitch(incoherent)).toMatchObject({
          status: 'unknown',
          pitchPx: null,
        });
        failNativeDraw = true;
        expect(() => runInNewContext('fixtureRenderer.renderFrame();', sandbox)).toThrow(
          'Native draw failed'
        );
        const failedDraw = runInNewContext('__ytPlacementProbe.latestRenderFrame', sandbox);
        expect(failedDraw).toMatchObject({ complete: false, draws: [] });
      }
    }
  );

  it('detects visible active rectangles that overlap after reflow', () => {
    const a = { id: 'a', x: 10, y: 10, width: 50, height: 20 };
    const b = { id: 'b', x: 30, y: 20, width: 50, height: 20 };
    expect(findOverlappingActivePair([a, b], 100, 100)).toEqual(['a', 'b']);
    expect(findOverlappingActivePair([a, { ...b, y: 31 }], 100, 100)).toBeNull();
    expect(findOverlappingActivePair([{ ...a, x: 101 }, b], 100, 100)).toBeNull();
  });

  it('retains bounded timing and geometry when a scenario fails before its final assertion', async () => {
    const raw = {
      sourcePrefixed: true,
      sourceHooked: true,
      requestAtEpochMs: 1000,
      frames: [],
      bounds: [],
      firstEntry: {},
      ingress: {},
      overflow: 0,
      workers: [
        {
          ready: true,
          stats: [],
          sample: {
            frames: [{ workMs: 4, preClearMs: 2 }],
            bounds: [{ id: 'WINDOWS193_SHORT', left: 10, top: 10, right: 20, bottom: 20 }],
            firstEntry: { WINDOWS193_SHORT: 1010 },
            ingress: { WINDOWS193_SHORT: 1000 },
            overflow: 0,
            exact: {
              frames: [{ workMs: 3 }],
              drains: [{ workMs: 1 }],
              dispositions: [],
              active: [],
              activeNow: [],
              config: {},
              overflow: 0,
            },
          },
        },
      ],
    };
    const page = {
      setViewportSize: async () => {},
      emulateMedia: async () => {},
      route: async () => {
        throw new Error('Synthetic fixture setup failure');
      },
      screenshot: async () => {},
      isClosed: () => false,
      close: async () => {},
      evaluate: async (fn: () => unknown) =>
        fn.toString().includes('const probe = window.__ytPlacementProbe') ? raw : undefined,
      waitForTimeout: async () => {},
    };
    const result = await runPlacementTimingFixture({
      context: { newPage: async () => page } as unknown as BrowserContext,
      root: process.cwd(),
      output: '/tmp',
      extensionId: 'fixture',
      selectedScenarios: [...PLACEMENT_SCENARIOS.map((scenario) => scenario.name)],
    });
    expect(result.status).toBe('failed');
    expect(result.scenarios).toHaveLength(PLACEMENT_SCENARIOS.length);
    expect(result.scenarios[0]).toMatchObject({
      status: 'failed',
      errorType: 'Error',
      frameWorkMs: { count: 1, p95: 4 },
      exactWorkerDrainMs: { count: 1, p95: 1 },
      bounds: [{ id: 'WINDOWS193_SHORT' }],
      screenshot: 'placement-worker-scroll.png',
    });
  });

  it('accepts only explicit, known spacing scenario names for a narrow run', async () => {
    const args = {
      context: {} as BrowserContext,
      root: process.cwd(),
      output: '/tmp',
      extensionId: 'fixture',
    };
    for (const options of [
      { spacingOnly: true },
      { spacingOnly: true, selectedScenarios: ['worker-scroll'] },
      { selectedScenarios: ['unknown'] },
      { selectedScenarios: ['worker-spacing-speed', 'worker-spacing-speed'] },
      { selectedScenarios: [] },
    ]) {
      await expect(runPlacementTimingFixture({ ...args, ...options })).rejects.toThrow();
    }
  });

  it('summarizes bounded, nonnegative frame samples without treating invalid values as work', () => {
    expect(summarizeSamples([])).toEqual({ count: 0, p50: null, p95: null, max: null });
    expect(summarizeSamples([10, 1, Infinity, -1, 3, 2, 4])).toEqual({
      count: 5,
      p50: 3,
      p95: 10,
      max: 10,
    });
  });

  it.each([
    [1, 'WINDOWS193_SHORT'],
    [2, 'WINDOWS193_SHORT'],
    [1, 'W193P'],
    [1, 'W204P'],
  ] as const)('associates cached %s bitmap marker %s with viewport bounds', (scale, id) => {
    const listeners: Record<string, (event: { origin: string; data: unknown }) => void> = {};
    const messages: Array<{
      type: string;
      sample?: {
        firstEntry: Record<string, number>;
        bounds: unknown[];
        ink: Array<{ sourceInk?: { fill?: { font: string }; stroke?: { lineWidth: number } } }>;
      };
    }> = [];
    const overlay = { width: 640 * scale, height: 360 * scale };
    const bitmap = { width: 100, height: 24 };
    let now = 5;
    class FakeContext {
      canvas: typeof overlay;
      globalAlpha = 1;
      font = 'bold 32px sans-serif';
      lineWidth = 2;

      constructor(canvas: typeof overlay) {
        this.canvas = canvas;
      }
      fillText(_text: string, _x: number, _y: number) {}
      strokeText(_text: string, _x: number, _y: number) {}
      drawImage(_image: object, _x: number, _y: number, _width: number, _height: number) {}
      clearRect(_x: number, _y: number, _width: number, _height: number) {}
      measureText() {
        return { width: 100, actualBoundingBoxAscent: 20, actualBoundingBoxDescent: 4 };
      }
      getTransform() {
        return { a: scale, b: 0, c: 0, d: scale, e: 0, f: 0 };
      }
    }
    const sandbox = {
      OffscreenCanvasRenderingContext2D: FakeContext,
      performance: { timeOrigin: 1000, now: () => now++ },
      requestAnimationFrame: (callback: (time: number) => void) => callback(0),
      addEventListener: (
        type: string,
        listener: (event: { origin: string; data: unknown }) => void
      ) => {
        listeners[type] = listener;
      },
      postMessage: (message: {
        type: string;
        sample?: {
          firstEntry: Record<string, number>;
          bounds: unknown[];
          ink: Array<{ sourceInk?: { fill?: { font: string }; stroke?: { lineWidth: number } } }>;
        };
      }) => {
        messages.push(message);
      },
    };
    runInNewContext(workerProbePrelude([id]), sandbox);
    listeners.message?.({ origin: '', data: { type: 'init', canvas: overlay } });
    listeners.message?.({
      origin: '',
      data: { type: 'addMessages', messages: [{ id }] },
    });
    sandbox.requestAnimationFrame(() => {
      const cache = new FakeContext(bitmap);
      cache.fillText(id, 0, 0);
      cache.strokeText(id, 0, 0);
      const display = new FakeContext(overlay);
      display.clearRect(0, 0, 640, 360);
      display.globalAlpha = 0;
      display.drawImage(bitmap, 500, 20, 100, 24);
      display.globalAlpha = 1;
      display.drawImage(bitmap, 500, 20, 100, 24);
    });
    listeners.message?.({ origin: 'https://attacker.example', data: { type: 'ytPlacementFlush' } });
    expect(messages).toHaveLength(0);
    listeners.message?.({ origin: '', data: { type: 'ytPlacementFlush' } });

    const sample = messages.at(-1)?.sample;
    expect(sample?.firstEntry[id]).toBeGreaterThan(1000);
    expect(sample?.bounds).toHaveLength(1);
    expect(sample?.bounds[0]).toMatchObject({
      id,
      left: 500 * scale,
      top: 20 * scale,
      right: 600 * scale,
      bottom: 44 * scale,
    });
    expect(sample?.ink[0]?.sourceInk).toMatchObject({
      fill: { font: 'bold 32px sans-serif' },
      stroke: { lineWidth: 2 },
    });
  });

  it.each(['WINDOWS193_SHORT', 'W193P', 'W204P'])(
    'hooks emitted Worker placement and queue residence for %s',
    (id) => {
      const source = `var sample = {
      pendingQueue: [], activeMessages: [], numLanes: 10, laneHeight: 20,
      enqueueMessage(message) { this.pendingQueue.push(message); return true; },
      activateMessage(message) { this.activeMessages.push({ ...message, x: 10, y: 5,
        startX: 10, duration: 100, laneIndex: 1 }); },
      recordDrop(message, reason) { this.lastDrop = [message.id, reason]; }, checkCollision() { return true; },
      findPlacement() { return { laneIndex: 1 }; },
      drainQueue() { const message = this.pendingQueue.shift(); if (message) this.activateMessage(message); },
      renderFrame() { this.drainQueue(); }, handleMessage() {},
    }; self.onmessage=e=>{sample.handleMessage(e)};`;
      expect(workerProbeSuffix(`${source}\n//# sourceMappingURL=renderer.js.map`)).toBeNull();
      const suffix = workerProbeSuffix(source);
      expect(suffix).toContain('(sample)');
      const listeners: Record<string, (event: { origin: string; data: unknown }) => void> = {};
      const messages: Array<{
        sample?: {
          exact?: {
            drops: Record<string, number>;
            drains: unknown[];
            frames: unknown[];
            activeNow: Array<{ id: string }>;
            dispositions: Array<{ queueResidenceMs: number }>;
          };
        };
      }> = [];
      let now = 1;
      const sandbox = {
        performance: { timeOrigin: 1000, now: () => now++ },
        requestAnimationFrame: (_callback: (time: number) => void) => 1,
        addEventListener: (
          type: string,
          listener: (event: { origin: string; data: unknown }) => void
        ) => {
          listeners[type] = listener;
        },
        postMessage: (message: {
          sample?: {
            exact?: {
              drops: Record<string, number>;
              drains: unknown[];
              frames: unknown[];
              activeNow: Array<{ id: string }>;
              dispositions: Array<{ queueResidenceMs: number }>;
            };
          };
        }) => {
          messages.push(message);
        },
      };
      runInNewContext(`self = globalThis; ${workerProbePrelude([id])}${source}${suffix}`, sandbox);
      runInNewContext(
        `sample.enqueueMessage({ id: '${id}' }); sample.renderFrame();
      sample.recordDrop({ id: 'WINDOWS193_DROP' }, 'reflow_capacity');
      sample.recordDrop({ id: 'WINDOWS193_UNTRACKED', trackDrops: false }, 'oversized');`,
        sandbox
      );
      listeners.message?.({ origin: '', data: { type: 'ytPlacementFlush' } });
      const exact = messages.at(-1)?.sample?.exact;
      expect(exact?.drains).toHaveLength(1);
      expect(exact?.frames).toHaveLength(1);
      expect(exact?.dispositions[0]).toMatchObject({
        kind: 'activated',
        id,
        queueResidenceMs: expect.any(Number),
      });
      expect(exact?.activeNow).toContainEqual(expect.objectContaining({ id }));
      expect(exact?.drops).toEqual({ reflow_capacity: 1 });
      expect(runInNewContext('sample.lastDrop', sandbox)).toEqual([
        'WINDOWS193_UNTRACKED',
        'oversized',
      ]);
    }
  );
});
