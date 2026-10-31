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
 * 4. Even message-rank picking across the admitted candidate range
 *
 * Extracted from backlog-controller.ts for single-responsibility separation.
 */

import type { BacklogMode, ChatMessage } from '@app-types';
import { DENSITY_LARGE_THRESHOLD, DENSITY_SMALL_THRESHOLD } from '@util/backlog-constants';
import { isPriorityMessage, prioritySortOrder } from '@util/backlog-helpers';

export class BacklogSampler {
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
   * Priority messages precede ordinary messages in the same throttled
   * injection queue; both remain subject to the configured rate.
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
   * Apply smart sampling based on message importance and message-rank coverage.
   * Returns sampled messages sorted by priority then timestamp.
   */
  sampleMessages(messages: ChatMessage[]): ChatMessage[] {
    const count = messages.length;
    if (count < DENSITY_SMALL_THRESHOLD) return messages;

    const isSubstantialText = (m: ChatMessage): boolean => {
      if (isPriorityMessage(m)) return false;
      const text = m.text.trim();
      if (/^[\sㅋㅎㅇㄱ]+$/.test(text)) return false;
      // Bounded display-text heuristic: short CJK and emoji can carry meaning,
      // but this does not infer the message's actual semantics.
      return (
        text.length >= 3 ||
        /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}]/u.test(
          text
        )
      );
    };

    // Partition into priority / substantial / other tiers in a single pass.
    const tier1: ChatMessage[] = [];
    const tier2: ChatMessage[] = [];
    const tier3: ChatMessage[] = [];
    let oldestOrdinary: ChatMessage | undefined;
    let latestOrdinary: ChatMessage | undefined;
    for (const m of messages) {
      if (isPriorityMessage(m)) {
        tier1.push(m);
      } else {
        if (!oldestOrdinary || m.timestamp < oldestOrdinary.timestamp) oldestOrdinary = m;
        if (!latestOrdinary || m.timestamp >= latestOrdinary.timestamp) latestOrdinary = m;
        if (isSubstantialText(m)) tier2.push(m);
        else tier3.push(m);
      }
    }

    const normalBudget =
      count < DENSITY_LARGE_THRESHOLD
        ? Math.floor(count * BacklogSampler.SAMPLE_RATIO_SMALL)
        : Math.floor(count * BacklogSampler.SAMPLE_RATIO_LARGE);

    const selected: ChatMessage[] = [...tier1];
    let remaining = normalBudget;
    const reserved = new Set<ChatMessage>();

    // Cover the entire admitted ordinary range before applying text-tier bias.
    // Priority messages remain fully protected outside the ordinary budget.
    if (remaining > 1 && oldestOrdinary) {
      selected.push(oldestOrdinary);
      reserved.add(oldestOrdinary);
      remaining--;
    }
    if (remaining > 0 && latestOrdinary && !reserved.has(latestOrdinary)) {
      selected.push(latestOrdinary);
      reserved.add(latestOrdinary);
      remaining--;
    }

    const availableTier2 = tier2.filter((message) => !reserved.has(message));
    if (availableTier2.length > 0 && remaining > 0) {
      const pick = Math.min(remaining, availableTier2.length);
      selected.push(...this.rankDistributedPick(availableTier2, pick));
      remaining -= pick;
    }

    const availableTier3 = tier3.filter((message) => !reserved.has(message));
    if (availableTier3.length > 0 && remaining > 0) {
      const pick = Math.min(remaining, availableTier3.length);
      selected.push(...this.rankDistributedPick(availableTier3, pick));
    }

    return selected.sort((a, b) => {
      const priorityA = prioritySortOrder(a.kind);
      const priorityB = prioritySortOrder(b.kind);
      if (priorityA !== priorityB) return priorityA - priorityB;
      return a.timestamp - b.timestamp;
    });
  }

  /**
   * Cover the admitted messages by rank after timestamp ordering. Equal-time
   * buckets would overrepresent sparse periods and lose dense recent chat.
   * Both endpoints are selected when count > 1; one slot favors the latest.
   */
  rankDistributedPick(messages: ChatMessage[], count: number): ChatMessage[] {
    if (count >= messages.length) return [...messages];
    if (count <= 0) return [];

    const sorted = [...messages].sort((a, b) => a.timestamp - b.timestamp);
    const picked: ChatMessage[] = [];

    for (let i = 0; i < count; i++) {
      const idx =
        count === 1 ? sorted.length - 1 : Math.floor((i * (sorted.length - 1)) / (count - 1));
      const msg = sorted[idx];
      if (msg) picked.push(msg);
    }

    return picked;
  }
}
