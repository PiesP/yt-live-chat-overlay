// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { expect, it } from 'vite-plus/test';

import {
  applyEvent,
  enabledEvents,
  initialState,
  type Replacement,
  type ReplayTransition,
} from './replay-admission-model';

it.each(['seek', 'session'] as const)(
  'checks every legal two-request %s event prefix against its history',
  (mode: Replacement) => {
    const explored = {
      prefixes: 0,
      terminal: 0,
      depth: 0,
      lateSuccess: 0,
      lateFailure: 0,
      deadlineThenStop: 0,
      oldLoopAfterStart: 0,
      healthyReplacement: 0,
    };

    function check(state: typeof initialState, trace: ReplayTransition[]): void {
      explored.prefixes += 1;
      explored.depth = Math.max(explored.depth, trace.length);
      expect(trace.length).toBeLessThanOrEqual(mode === 'seek' ? 5 : 7);
      const diagnostic = trace.join(' → ');
      const oldSettlesAt = trace.findIndex(
        (event) => event.startsWith('old-') && event !== 'old-loop-finish'
      );
      const replacementStartsAt = trace.indexOf('begin-replacement');
      const replacementSettled =
        trace.includes('replacement-success') || trace.includes('replacement-failure');
      const invalidation = mode === 'seek' ? 'seek' : 'stop';
      const invalidatesAt = trace.indexOf(invalidation);
      const newOwnerBegins = trace.includes(mode === 'seek' ? 'seek' : 'start');
      const firstAbort = trace.find(
        (event, index) =>
          (event === 'deadline' || event === invalidation) &&
          (oldSettlesAt < 0 || index < oldSettlesAt)
      );
      const oldFinishesWith = trace.find((_, index) => index === oldSettlesAt);
      const replacementOutcome = trace.includes('replacement-success')
        ? 'success'
        : trace.includes('replacement-failure')
          ? 'failure'
          : null;
      expect(state.replacementOutcome, diagnostic).toBe(replacementOutcome);
      const oldStillOwns = oldSettlesAt < 0;

      expect(state.active, diagnostic).toBe(
        oldStillOwns
          ? 'old'
          : replacementStartsAt >= 0 && !replacementSettled
            ? 'replacement'
            : null
      );
      expect(
        state.queue.map(({ id }) => id),
        diagnostic
      ).toEqual([
        ...(oldStillOwns ? ['old'] : []),
        ...(newOwnerBegins && !replacementSettled ? ['replacement'] : []),
      ]);
      expect(state.firstAbort, diagnostic).toBe(firstAbort ?? null);
      expect(state.oldOutcome, diagnostic).toBe(
        oldStillOwns
          ? null
          : oldFinishesWith === 'old-failure'
            ? 'failure'
            : (firstAbort ?? 'success')
      );
      expect(state.displayed, diagnostic).toEqual(
        trace.includes('replacement-success')
          ? ['replacement']
          : oldFinishesWith === 'old-success' && invalidatesAt < 0 && !firstAbort
            ? ['old']
            : []
      );
      if (replacementStartsAt >= 0) {
        expect(oldSettlesAt, diagnostic).toBeGreaterThanOrEqual(0);
        expect(replacementStartsAt, diagnostic).toBeGreaterThan(oldSettlesAt);
      }
      if (mode === 'session') {
        expect(state.observer, diagnostic).toBe(
          newOwnerBegins ? 1 : invalidatesAt >= 0 || trace.includes('old-loop-finish') ? null : 0
        );
      }

      const events = enabledEvents(state, mode);
      if (events.length === 0) {
        explored.terminal += 1;
        expect(state.queue).toEqual([]);
        expect(state.active).toBeNull();
        if (invalidatesAt < oldSettlesAt) {
          if (oldFinishesWith === 'old-success') explored.lateSuccess += 1;
          if (oldFinishesWith === 'old-failure') explored.lateFailure += 1;
        }
        if (firstAbort === 'deadline' && invalidatesAt < oldSettlesAt && mode === 'session') {
          explored.deadlineThenStop += 1;
        }
        if (mode === 'session' && trace.indexOf('old-loop-finish') > trace.indexOf('start')) {
          explored.oldLoopAfterStart += 1;
        }
        if (state.displayed.includes('replacement')) explored.healthyReplacement += 1;
      }
      for (const event of events) check(applyEvent(state, event), [...trace, event]);
    }

    check(initialState, []);
    expect(explored).toEqual(
      mode === 'seek'
        ? {
            prefixes: 66,
            terminal: 28,
            depth: 5,
            lateSuccess: 6,
            lateFailure: 6,
            deadlineThenStop: 0,
            oldLoopAfterStart: 0,
            healthyReplacement: 14,
          }
        : {
            prefixes: 466,
            terminal: 194,
            depth: 7,
            lateSuccess: 48,
            lateFailure: 48,
            deadlineThenStop: 42,
            oldLoopAfterStart: 156,
            healthyReplacement: 97,
          }
    );
  }
);
