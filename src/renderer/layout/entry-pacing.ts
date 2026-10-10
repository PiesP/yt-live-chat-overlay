// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { MessageMotionPlan } from '@renderer/layout/motion-types';

interface EntryCursor {
  entryTime: number;
  sequence: number;
}

/** Instance-owned pacing for the existing priority/tier groups, never replay. */
export class EntryPacingState {
  private readonly groups = new Map<string, EntryCursor>();

  input(priority: number, tier: number, now: number, replay: boolean) {
    const cursor = replay ? undefined : this.groups.get(`${priority}:${tier}`);
    return cursor && cursor.entryTime >= now
      ? {
          entrySequence: Math.min(5, cursor.sequence + 1),
          previousViewportEntryTime: cursor.entryTime,
        }
      : { entrySequence: undefined, previousViewportEntryTime: undefined };
  }

  commit(priority: number, tier: number, now: number, replay: boolean, plan: MessageMotionPlan) {
    if (replay) return;
    const key = `${priority}:${tier}`;
    const previous = this.groups.get(key);
    // Valid production priorities/tier combinations fit in 18 entries. Keep
    // unexpected input bounded too, without retaining message data here.
    if (!previous && this.groups.size >= 32) {
      const oldest = this.groups.keys().next().value;
      if (oldest !== undefined) this.groups.delete(oldest);
    }
    this.groups.set(key, {
      entryTime: plan.viewportEntryTime,
      sequence: previous && previous.entryTime >= now ? Math.min(5, previous.sequence + 1) : 0,
    });
  }

  shift(pausedMs: number): void {
    for (const cursor of this.groups.values()) cursor.entryTime += pausedMs;
  }

  clear(): void {
    this.groups.clear();
  }
}
