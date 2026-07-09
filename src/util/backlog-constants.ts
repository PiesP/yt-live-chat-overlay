// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Shared backlog constants — single source of truth for backlog density
 * thresholds used by both BacklogSampler and BacklogScheduler.
 */

/** Message count threshold below which the backlog is considered "small". */
export const DENSITY_SMALL_THRESHOLD = 200;

/** Message count threshold above which the backlog is considered "large". */
export const DENSITY_LARGE_THRESHOLD = 500;
