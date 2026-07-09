// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * BacklogSampler
 *
 * Statistical sampling and priority-based filtering for backlog messages.
 * Handles:
 * 1. Mode-based filtering (none / recent / full)
 * 2. Priority message extraction (SuperChat, Membership)
 * 3. Statistical sampling with tier-based selection
 * 4. Time-distributed picking to avoid temporal clustering
 *
 * Extracted from backlog-controller.ts for single-responsibility separation.
 */

import type { BacklogMode, ChatMessage } from '@app-types';
import { isPriorityMessage, prioritySortOrder } from '@util/backlog-helpers';

export class BacklogSampler {
  static readonly DENSITY_SMALL_THRESHOLD = 200;
  static readonly DENSITY_LARGE_THRESHOLD = 500;
  static readonly SAMPLE_RATIO_SMALL = 0.6;
  static readonly SAMPLE_RATIO_LARGE = 0.35;

  /**
   * Filter messages based on the configured backlog mode.
   * - 'none': returns empty array (no backlog at all).
   * - 'recent': returns only messages within the configured time window.
   * - otherwise: returns all messages unfiltered.
   */
  filterByMode(
    allMessages: ChatMessage[],
    config: { backlogMode: BacklogMode; backlogRecentMinutes: number },
    now: number
  ): ChatMessage[] {
    if (config.backlogMode === 'none') return [];
    if (config.backlogMode === 'recent') {
      const cutoffMs = config.backlogRecentMinutes * 60 * 1000;
      return allMessages.filter((m) => now - m.timestamp < cutoffMs);
    }
    return allMessages;
  }

  /**
   * Split messages into priority (SuperChat/Membership) and regular groups.
   * Priority messages are emitted immediately during backlog injection;
   * regular messages go through the throttled queue.
   */
  extractPriorityMessages(messages: ChatMessage[]): {
    priority: ChatMessage[];
    regular: ChatMessage[];
  } {
    const priority: ChatMessage[] = [];
    const regular: ChatMessage[] = [];
    for (const msg of messages) {
      if (isPriorityMessage(msg)) {
        priority.push(msg);
      } else {
        regular.push(msg);
      }
    }
    return { priority, regular };
  }

  /**
   * Apply smart sampling based on message importance and time distribution.
   * Returns sampled messages sorted by priority then timestamp.
   */
  sampleMessages(messages: ChatMessage[]): ChatMessage[] {
    const count = messages.length;
    if (count < BacklogSampler.DENSITY_SMALL_THRESHOLD) return messages;

    const isSubstantialText = (m: ChatMessage): boolean => {
      if (isPriorityMessage(m)) return false;
      const text = m.text.trim();
      return text.length >= 3 && !/^[\sㅋㅎㅇㄱ]+$/.test(text);
    };

    // Partition into priority / substantial / other tiers in a single pass.
    const tier1: ChatMessage[] = [];
    const tier2: ChatMessage[] = [];
    const tier3: ChatMessage[] = [];
    for (const m of messages) {
      if (isPriorityMessage(m)) {
        tier1.push(m);
      } else if (isSubstantialText(m)) {
        tier2.push(m);
      } else {
        tier3.push(m);
      }
    }

    const normalBudget =
      count < BacklogSampler.DENSITY_LARGE_THRESHOLD
        ? Math.floor(count * BacklogSampler.SAMPLE_RATIO_SMALL)
        : Math.floor(count * BacklogSampler.SAMPLE_RATIO_LARGE);

    const selected: ChatMessage[] = [...tier1];
    let remaining = normalBudget;

    if (tier2.length > 0 && remaining > 0) {
      const pick = Math.min(remaining, tier2.length);
      selected.push(...this.timeDistributedPick(tier2, pick));
      remaining -= pick;
    }

    if (tier3.length > 0 && remaining > 0) {
      const pick = Math.min(remaining, tier3.length);
      selected.push(...this.timeDistributedPick(tier3, pick));
    }

    return selected.sort((a, b) => {
      const priorityA = prioritySortOrder(a.kind);
      const priorityB = prioritySortOrder(b.kind);
      if (priorityA !== priorityB) return priorityA - priorityB;
      return a.timestamp - b.timestamp;
    });
  }

  /**
   * Pick messages with even time distribution to avoid clustering.
   * Divides the time range into buckets and picks one message per bucket.
   */
  timeDistributedPick(messages: ChatMessage[], count: number): ChatMessage[] {
    if (count >= messages.length) return [...messages];
    if (count <= 0) return [];

    const sorted = [...messages].sort((a, b) => a.timestamp - b.timestamp);
    const step = Math.max(1, Math.floor(sorted.length / count));
    const picked: ChatMessage[] = [];

    for (let i = 0; i < count; i++) {
      const idx = Math.min(i * step, sorted.length - 1);
      const msg = sorted[idx];
      if (msg) picked.push(msg);
    }

    return picked;
  }
}
