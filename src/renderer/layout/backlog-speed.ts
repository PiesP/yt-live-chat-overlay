// SPDX-License-Identifier: MIT

/** Backlog has its own speed policy; live burst acceleration is not applied. */
export function computeBacklogSpeed(baseSpeedPxPerSec: number, backlogMultiplier: number): number {
  return Math.max(1, baseSpeedPxPerSec * Math.max(1, backlogMultiplier));
}
