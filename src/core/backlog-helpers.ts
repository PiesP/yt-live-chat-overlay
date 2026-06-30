// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Shared helper functions for backlog message handling.
 *
 * Extracted from backlog-controller.ts for single-responsibility separation.
 * Contains pure utility functions: priority checking, sorting, and
 * exponential distribution sampling.
 */

import type { ChatMessage } from '@app-types';

/**
 * Priority-check helper shared by sampling, partitioning, and sorting.
 * Returns true for messages that should always be shown (SuperChat, Membership).
 */
export function isPriorityMessage(m: ChatMessage): boolean {
  return m.kind === 'superchat' || m.kind === 'membership';
}

/**
 * Get the priority sort order for message kinds.
 * Lower number = higher priority (SuperChat → Membership → regular).
 */
export function prioritySortOrder(kind: ChatMessage['kind']): number {
  return kind === 'superchat' ? 0 : kind === 'membership' ? 1 : 2;
}

/**
 * Sample from an exponential distribution with the given mean.
 * Uses the inverse-CDF method: -mean * ln(1 - U) where U ~ Uniform(0, 1).
 */
export function sampleExponential(mean: number): number {
  return -mean * Math.log(Math.max(Number.EPSILON, 1 - Math.random()));
}
