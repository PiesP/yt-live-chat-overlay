import type { LaneState, OverlayDimensions } from '@app-types';
import { rendererLayout, spacing } from '@core/design-tokens';
import { measureTextHeight } from '@core/text-measure';

export interface LanePlacement {
  lane: LaneState;
  waitMs: number;
  laneY: number;
  /** Number of lane slots this message occupies (1 for regular, 2+ for superchat/membership) */
  slotCount: number;
}

interface LaneAllocatorOptions {
  readonly safeTop: number;
  readonly safeBottom: number;
  readonly fontSize: number;
  readonly fontWeight: 'normal' | 'bold';
  readonly fontFamily: string;
  readonly laneSpacing: number;
}

/**
 * DLIOS constant-velocity lane scheduler.
 *
 * Core algorithm (from DLIOS / ByteDance TikTok paper):
 *
 *   1. Constant-velocity lemma — all comments in the same lane move at
 *      the same velocity `v`. Therefore a later-starting comment can
 *      NEVER overtake an earlier one (zero rear-end collision).
 *
 *   2. Available-time launch rule — each lane tracks the earliest time
 *      it becomes available for the next message:
 *
 *        t_available(k) = t_start + (w + g) / v
 *
 *      where w = text width, g = safety gap, v = constant velocity.
 *
 *   3. Min-heap selection — the lane with the minimum t_available is
 *      selected in O(log n) time.
 *
 * Extensions over base DLIOS:
 *   - Lane cooldown: minimum time between consecutive uses of the same lane
 *     prevents vertical clustering.
 *   - Normalized composite scoring: wait time, spatial density, and message
 *     count are all normalized to [0, 1] so no single term dominates.
 *   - Uniform initialization: all lanes start at the same available time;
 *     spatial spread order prevents diagonal entry patterns.
 */
export class LaneAllocator {
  /** 4-ary min-heap of [laneIndex, availableAtMs] pairs, sorted by availableAtMs */
  private heap: [number, number][] = [];
  /** Reverse map: laneIndex → heap index for O(1) lookup and update */
  private laneIndexToHeapIndex: Map<number, number> = new Map();
  /** Per-lane message count for weighted selection */
  private laneMessageCounts: number[] = [];
  /** Per-lane last commit timestamp for spatial density calculation */
  private laneLastUsedAt: number[] = [];
  private laneHeight = 0;
  private laneCount = 0;

  /**
   * Minimum cooldown between consecutive uses of the same lane (ms).
   * This is the floor value; the actual cooldown scales with message duration
   * to ensure the previous message has fully exited the screen before the next
   * one enters, even under variable playback rates or pause/resume cycles.
   */
  private static readonly LANE_COOLDOWN_MIN_MS = 500;

  /**
   * Safety margin ratio applied to message duration.
   * The total cooldown = max(LANE_COOLDOWN_MIN_MS, durationMs * SAFETY_MARGIN_RATIO).
   * A 15% margin ensures that even if the timer is slightly imprecise (e.g.
   * after pause/resume), the previous message has cleared the screen.
   */
  private static readonly SAFETY_MARGIN_RATIO = 0.15;

  /**
   * When backlog partitioning is active, backlog messages are restricted
   * to lanes [0, backlogLaneEnd) and real-time messages use
   * [backlogLaneEnd, laneCount). This prevents visual overlap during
   * the initial backlog injection phase.
   * -1 means partitioning is disabled (all lanes shared).
   */
  private backlogLaneEnd = -1;

  constructor(private readonly options: LaneAllocatorOptions) {}

  reset(dimensions: OverlayDimensions | null): void {
    this.heap = [];
    this.laneIndexToHeapIndex = new Map();
    this.laneMessageCounts = [];
    this.laneLastUsedAt = [];
    this.backlogLaneEnd = -1;
    if (!dimensions) {
      this.laneHeight = 0;
      this.laneCount = 0;
      return;
    }

    // Compute lane height from actual font metrics, not a hardcoded multiplier.
    // Must account for the author section (photo + name) which adds height
    // beyond the text body. Without this, messages with showAuthor enabled
    // would exceed the lane height and overlap adjacent lanes.
    //
    // Formula: laneHeight = authorSection + gap + textHeight + paddingV*2 + laneSpacing
    // where authorSection = max(authorPhotoSize, authorNameHeight)
    const totalPaddingV = rendererLayout.paddingV * 2;
    const font = `${this.options.fontWeight === 'bold' ? 'bold' : '400'} ${this.options.fontSize}px ${this.options.fontFamily}`;
    const textHeight = measureTextHeight(font, this.options.fontSize);

    // Author section height: max of photo size and rendered name height.
    const authorFontSize = Math.round(this.options.fontSize * rendererLayout.authorFontScale);
    const authorFont = `${this.options.fontWeight === 'bold' ? 'bold' : '400'} ${authorFontSize}px ${this.options.fontFamily}`;
    const authorNameHeight = measureTextHeight(authorFont, authorFontSize);
    const authorSectionHeight = Math.max(rendererLayout.authorPhotoSize, authorNameHeight);

    this.laneHeight = Math.max(
      1,
      authorSectionHeight + spacing.xs + textHeight + totalPaddingV + this.options.laneSpacing
    );

    const usableHeight = dimensions.height * (1 - this.options.safeTop - this.options.safeBottom);
    this.laneCount = Math.max(1, Math.floor(usableHeight / this.laneHeight));

    // Uniform initialization: all lanes start at the same available time.
    // This prevents diagonal entry patterns caused by staggered offsets.
    // Spatial distribution is handled by the composite lane score instead.
    const now = performance.now();
    for (let i = 0; i < this.laneCount; i++) {
      this.heap.push([i, now]);
      this.laneIndexToHeapIndex.set(i, i);
      this.laneMessageCounts.push(0);
      this.laneLastUsedAt.push(0);
    }
    // Build min-heap (4-ary): start from last non-leaf node
    for (let i = Math.floor((this.heap.length - 2) / 4); i >= 0; i--) {
      this.siftDown(i);
    }
  }

  isEmpty(): boolean {
    return this.heap.length === 0;
  }

  getLaneCount(): number {
    return this.laneCount;
  }

  /** Get current lane utilization ratio (0-1): occupied lanes / total lanes */
  getUtilization(): number {
    if (this.heap.length === 0) return 0;
    const now = performance.now();
    let occupied = 0;
    for (const [, availableAt] of this.heap) {
      if (availableAt > now) occupied++;
    }
    return occupied / this.heap.length;
  }

  getLaneHeight(): number {
    return this.laneHeight;
  }

  getLaneY(laneIndex: number, viewportHeight: number): number {
    return viewportHeight * this.options.safeTop + laneIndex * this.laneHeight;
  }

  findPlacement(
    messageHeight: number,
    _dimensions: OverlayDimensions,
    isBacklog = false
  ): LanePlacement | null {
    const now = performance.now();
    const totalLanes = this.laneCount;

    // Determine the effective lane range based on partition state.
    let laneStart = 0;
    let laneEnd = totalLanes;
    if (this.backlogLaneEnd > 0) {
      if (isBacklog) {
        laneEnd = this.backlogLaneEnd;
      } else {
        laneStart = this.backlogLaneEnd;
      }
    }
    const effectiveLaneCount = laneEnd - laneStart;
    if (effectiveLaneCount <= 0) return null;

    // Calculate how many lane slots this message needs.
    // A superchat card may be 3-5x taller than a regular message.
    const slotCount = Math.max(1, Math.ceil(messageHeight / this.laneHeight));

    // For multi-slot messages, find the best starting lane such that
    // all slots [laneIndex, laneIndex + slotCount) are within range.
    const result = this.allocateMultiSlot(now, laneStart, laneEnd, slotCount, isBacklog);
    if (!result) return null;

    const lane: LaneState = {
      index: result.laneIndex,
      lastItemStartTime: now,
      lastItemEndTime: 0,
      lastItemWidthPx: 0,
      totalMessages: 0,
    };

    return {
      lane,
      waitMs: result.waitMs,
      laneY: this.getLaneY(result.laneIndex, _dimensions.height),
      slotCount,
    };
  }

  /**
   * Commit the placement — update the lane's available time for the
   * next message. For multi-slot messages, all occupied lanes are updated.
   *
   * @param placement   - The lane placement returned by findPlacement()
   * @param startTime   - The timestamp (performance.now()) when the message starts
   * @param durationMs  - The actual animation duration in milliseconds. This must
   *   match the duration used by the renderer so that the lane is not released
   *   before the message has fully exited the screen.
   */
  commitPlacement(placement: LanePlacement, startTime: number, durationMs: number): void {
    // Dynamic cooldown: max of fixed minimum or duration-proportional safety margin.
    // This ensures long messages get enough clearance time, while short messages
    // still benefit from the minimum cooldown to prevent vertical clustering.
    const safetyMargin = Math.round(durationMs * LaneAllocator.SAFETY_MARGIN_RATIO);
    const cooldownMs = Math.max(LaneAllocator.LANE_COOLDOWN_MIN_MS, safetyMargin);
    const occupancyMs = durationMs + cooldownMs;

    const nextAvailable = startTime + occupancyMs;
    const startIdx = placement.lane.index;

    // Update all slots occupied by this message with the SAME available time.
    // This prevents partial-slot availability where a new message could enter
    // a "released" top slot while the bottom slot is still occupied, causing
    // visual overlap with the multi-slot message (e.g. SuperChat cards).
    for (let s = 0; s < placement.slotCount; s++) {
      const laneIdx = startIdx + s;
      this.updateLane(laneIdx, nextAvailable);
      const count = this.laneMessageCounts[laneIdx];
      if (count !== undefined) {
        this.laneMessageCounts[laneIdx] = count + 1;
      }
      this.laneLastUsedAt[laneIdx] = startTime;
    }
  }

  // ── Partition control ────────────────────────────────────────────────

  /**
   * Enable or disable backlog lane partitioning.
   * When active, backlog messages use lanes [0, partitionEnd) and
   * real-time messages use [partitionEnd, laneCount).
   * @param active - true to enable partitioning
   * @param partitionEnd - exclusive end index for the backlog partition
   */
  setBacklogPartition(active: boolean, partitionEnd: number): void {
    if (active) {
      this.backlogLaneEnd = Math.max(1, Math.min(partitionEnd, this.laneCount - 1));
    } else {
      this.backlogLaneEnd = -1;
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────

  /**
   * Global spatial density at a lane: weighted sum of recent usage across
   * ALL lanes (not just immediate neighbors). Lanes used within the decay
   * window contribute to density, with closer lanes weighted higher.
   *
   * This prevents vertical clustering by preferring lanes that are far from
   * recently used lanes across the entire screen, not just locally.
   */
  private spatialDensity(laneIndex: number, now: number): number {
    let density = 0;
    const DECAY_WINDOW_MS = 8_000;
    for (let i = 0; i < this.laneCount; i++) {
      if (i === laneIndex) continue;
      const lastUsed = this.laneLastUsedAt[i] ?? 0;
      if (lastUsed === 0) continue;
      const age = now - lastUsed;
      if (age >= DECAY_WINDOW_MS) continue;
      const distance = Math.abs(i - laneIndex);
      const proximityWeight = 1 / (1 + distance * 0.1);
      const recency = 1 - age / DECAY_WINDOW_MS;
      density += proximityWeight * recency;
    }
    return density;
  }

  /**
   * Composite lane score: lower is better.
   * All three components are normalized to [0, 1] so no single term dominates.
   *
   * Components:
   *   - wait: normalized wait time (primary — DLIOS invariant)
   *   - density: global spatial density (secondary — prevents clustering)
   *   - count: normalized message count (tertiary — load balancing)
   */
  private laneScore(laneIndex: number, waitMs: number, now: number): number {
    // Normalize wait to [0, 1] using the max scroll duration as upper bound
    const maxWait = rendererLayout.durationMax;
    const normalizedWait = Math.min(1, waitMs / maxWait);

    // Normalize spatial density to [0, 1]
    const rawDensity = this.spatialDensity(laneIndex, now);
    const maxRawDensity = this.laneCount * 0.5; // theoretical upper bound
    const normalizedDensity = Math.min(1, rawDensity / maxRawDensity);

    // Normalize message count to [0, 1]
    const maxCount = Math.max(1, ...this.laneMessageCounts);
    const normalizedCount = (this.laneMessageCounts[laneIndex] ?? 0) / maxCount;

    // Weighted combination: wait is primary, density secondary, count tertiary
    return normalizedWait * 0.5 + normalizedDensity * 0.3 + normalizedCount * 0.2;
  }

  /**
   * Normalized score for a multi-slot block.
   * Uses the same normalization as laneScore but operates on block-aggregate
   * values (max wait, avg density, avg count) plus an adjacency penalty.
   */
  private blockScore(
    blockMaxWait: number,
    avgDensity: number,
    avgCount: number,
    startIdx: number,
    slotCount: number,
    now: number
  ): number {
    const maxWait = rendererLayout.durationMax;
    const normalizedWait = Math.min(1, blockMaxWait / maxWait);

    const maxRawDensity = this.laneCount * 0.5;
    const normalizedDensity = Math.min(1, avgDensity / maxRawDensity);

    const maxCount = Math.max(1, ...this.laneMessageCounts);
    const normalizedCount = avgCount / maxCount;

    // Adjacent penalty: check if lanes immediately above or below the
    // block were recently used. This prevents tall messages from being
    // stacked directly on top of each other.
    const adjacentPenalty = this.adjacentPenalty(startIdx, slotCount, now);

    return normalizedWait * 0.5 + normalizedDensity * 0.3 + normalizedCount * 0.2 + adjacentPenalty;
  }

  /**
   * Penalty for placing a block adjacent to recently used lanes.
   * Returns 0 if no adjacent lanes were recently used, or a value in
   * (0, 0.3] proportional to how recently the adjacent lane was used.
   */
  private adjacentPenalty(startIdx: number, slotCount: number, now: number): number {
    const ADJACENT_WINDOW_MS = 2_000;
    let penalty = 0;
    // Check lane immediately above the block
    const above = startIdx - 1;
    if (above >= 0) {
      const lastUsed = this.laneLastUsedAt[above] ?? 0;
      if (lastUsed > 0 && now - lastUsed < ADJACENT_WINDOW_MS) {
        penalty = Math.max(penalty, (1 - (now - lastUsed) / ADJACENT_WINDOW_MS) * 0.3);
      }
    }
    // Check lane immediately below the block
    const below = startIdx + slotCount;
    if (below < this.laneCount) {
      const lastUsed = this.laneLastUsedAt[below] ?? 0;
      if (lastUsed > 0 && now - lastUsed < ADJACENT_WINDOW_MS) {
        penalty = Math.max(penalty, (1 - (now - lastUsed) / ADJACENT_WINDOW_MS) * 0.3);
      }
    }
    return penalty;
  }

  /**
   * Extract the top-K lanes from the heap by available-at time.
   * Uses a temporary min-heap of size K for O(n log K) selection.
   * Returns lanes sorted by availableAt (earliest first).
   */
  private topKLanes(
    k: number,
    laneStart: number,
    laneEnd: number
  ): Array<{ laneIndex: number; availableAt: number }> {
    const result: Array<{ laneIndex: number; availableAt: number }> = [];
    // Simple approach: scan heap entries and maintain a sorted array of top K
    // Since heap is small (20-50 entries), O(n) scan is efficient
    for (let i = 0; i < this.heap.length; i++) {
      const entry = this.heap[i];
      if (!entry) continue;
      const [idx, avail] = entry;
      if (idx < laneStart || idx >= laneEnd) continue;

      // Insert into sorted position (insertion sort on small array)
      const item = { laneIndex: idx, availableAt: avail };
      let inserted = false;
      for (let j = 0; j < result.length; j++) {
        const candidate = result[j];
        if (candidate && avail < candidate.availableAt) {
          result.splice(j, 0, item);
          inserted = true;
          break;
        }
      }
      if (!inserted) result.push(item);

      // Keep only top K
      if (result.length > k) {
        result.pop();
      }
    }
    return result;
  }

  /**
   * Allocate a single lane using spatial-density-aware selection.
   * Scans the top-K earliest-available lanes and picks the one with
   * the best composite score (wait time + spatial density + message count).
   *
   * When `isBacklog` is true, an additional adjacency gap penalty is
   * applied to spread messages vertically and prevent clustering during
   * the initial backlog injection phase.
   */
  private allocateSingleLane(
    now: number,
    laneStart: number,
    laneEnd: number,
    isBacklog = false
  ): { laneIndex: number; waitMs: number } | null {
    if (this.heap.length === 0) return null;

    const maxWaitMs = rendererLayout.durationMax;

    // Consider top 8 earliest-available lanes, then pick by composite score
    const CANDIDATE_COUNT = 8;
    const candidates = this.topKLanes(CANDIDATE_COUNT, laneStart, laneEnd);
    if (candidates.length === 0) return null;

    let bestLane = -1;
    let bestWait = Infinity;
    let bestScore = Infinity;

    for (const { laneIndex: idx, availableAt: avail } of candidates) {
      const wait = Math.max(0, Math.ceil(avail - now));
      if (wait > maxWaitMs) continue;

      let score = this.laneScore(idx, wait, now);

      // During backlog injection, penalize lanes that are close to
      // recently-used lanes to enforce vertical spread.
      if (isBacklog) {
        score += this.backlogAdjacencyPenalty(idx, now);
      }

      if (score < bestScore) {
        bestScore = score;
        bestWait = wait;
        bestLane = idx;
      }
    }

    if (bestLane === -1) return null;
    return { laneIndex: bestLane, waitMs: bestWait };
  }

  /**
   * Allocate a contiguous block of `slotCount` lanes for tall messages
   * (superchat, membership). Finds the starting lane where all slots
   * [laneIndex, laneIndex + slotCount) fit within [laneStart, laneEnd).
   *
   * Uses the top-K earliest-available starting lanes and picks the one
   * with the best composite score (max wait + avg density + avg count).
   *
   * When `isBacklog` is true, single-slot messages are routed through
   * `allocateSingleLane` with the backlog adjacency penalty applied.
   */
  private allocateMultiSlot(
    now: number,
    laneStart: number,
    laneEnd: number,
    slotCount: number,
    isBacklog = false
  ): { laneIndex: number; waitMs: number } | null {
    if (this.heap.length === 0) return null;
    if (slotCount <= 1) {
      return this.allocateSingleLane(now, laneStart, laneEnd, isBacklog);
    }

    const maxWaitMs = rendererLayout.durationMax;
    const maxStartLane = laneEnd - slotCount;
    if (maxStartLane < laneStart) return null;

    // Get top-K candidate starting lanes
    const CANDIDATE_COUNT = 8;
    const candidates = this.topKLanes(CANDIDATE_COUNT, laneStart, maxStartLane + 1);
    if (candidates.length === 0) return null;

    let bestLane = -1;
    let bestWait = Infinity;
    let bestScore = Infinity;

    for (const { laneIndex: startIdx } of candidates) {
      // Check all slots in the block
      let blockMaxWait = 0;
      let blockDensitySum = 0;
      let blockCountSum = 0;
      let allValid = true;

      for (let s = 0; s < slotCount; s++) {
        const slotIdx = startIdx + s;
        const slotAvail = this.getSlotAvailableAt(slotIdx);
        if (slotAvail === undefined) {
          allValid = false;
          break;
        }
        const slotWait = Math.max(0, Math.ceil(slotAvail - now));
        if (slotWait > maxWaitMs) {
          allValid = false;
          break;
        }
        blockMaxWait = Math.max(blockMaxWait, slotWait);
        blockDensitySum += this.spatialDensity(slotIdx, now);
        blockCountSum += this.laneMessageCounts[slotIdx] ?? 0;
      }

      if (!allValid) continue;

      // Use the same normalized scoring as single-lane allocation,
      // applied to the block's aggregate values.
      const avgDensity = blockDensitySum / slotCount;
      const avgCount = blockCountSum / slotCount;
      const score = this.blockScore(blockMaxWait, avgDensity, avgCount, startIdx, slotCount, now);

      if (score < bestScore) {
        bestScore = score;
        bestWait = blockMaxWait;
        bestLane = startIdx;
      }
    }

    if (bestLane === -1) return null;
    return { laneIndex: bestLane, waitMs: bestWait };
  }

  /**
   * Penalty for placing a backlog message in a lane whose immediate
   * neighbours were recently used. This enforces vertical spread during
   * the initial backlog injection phase, preventing messages from
   * clustering together.
   *
   * Returns 0 if no adjacent lanes were recently used, or a value in
   * (0, 0.4] proportional to how recently the adjacent lane was used.
   */
  private backlogAdjacencyPenalty(laneIndex: number, now: number): number {
    const ADJACENT_WINDOW_MS = 3_000;
    let penalty = 0;
    // Check lane immediately above
    const above = laneIndex - 1;
    if (above >= 0) {
      const lastUsed = this.laneLastUsedAt[above] ?? 0;
      if (lastUsed > 0 && now - lastUsed < ADJACENT_WINDOW_MS) {
        penalty = Math.max(penalty, (1 - (now - lastUsed) / ADJACENT_WINDOW_MS) * 0.4);
      }
    }
    // Check lane immediately below
    const below = laneIndex + 1;
    if (below < this.laneCount) {
      const lastUsed = this.laneLastUsedAt[below] ?? 0;
      if (lastUsed > 0 && now - lastUsed < ADJACENT_WINDOW_MS) {
        penalty = Math.max(penalty, (1 - (now - lastUsed) / ADJACENT_WINDOW_MS) * 0.4);
      }
    }
    return penalty;
  }

  /** Get the available-at time for a lane by its index. */
  private getSlotAvailableAt(laneIndex: number): number | undefined {
    const heapIdx = this.laneIndexToHeapIndex.get(laneIndex);
    if (heapIdx === undefined) return undefined;
    return this.heap[heapIdx]?.[1];
  }

  /** Update a lane's available time in the heap. */
  private updateLane(laneIndex: number, newAvailableAt: number): void {
    const idx = this.laneIndexToHeapIndex.get(laneIndex);
    if (idx === undefined) return;
    const entry = this.heap[idx];
    if (!entry) return;
    const old = entry[1];
    this.heap[idx] = [laneIndex, newAvailableAt];
    if (newAvailableAt > old) {
      this.siftDown(idx);
    } else if (newAvailableAt < old) {
      this.siftUp(idx);
    }
  }

  /** Shift all lane available times by a fixed offset (e.g., pause duration). */
  shiftAll(offsetMs: number): void {
    if (offsetMs <= 0 || this.heap.length === 0) return;
    for (let i = 0; i < this.heap.length; i++) {
      const entry = this.heap[i];
      if (entry) {
        this.heap[i] = [entry[0], entry[1] + offsetMs];
      }
    }
    // Rebuild heap invariant after bulk update (4-ary)
    for (let i = Math.floor((this.heap.length - 2) / 4); i >= 0; i--) {
      this.siftDown(i);
    }
  }

  // ── 4-ary min-heap operations ──────────────────────────────────────
  // 4-ary heap: children of node i are at 4i+1..4i+4, parent at (i-1)/4.
  // Sift-down does up to 4 comparisons per level but traverses ~half the
  // levels of a binary heap. Net win for cache locality and total comparisons.

  private siftDown(startIdx: number): void {
    const size = this.heap.length;
    let idx = startIdx;
    while (true) {
      let smallest = idx;
      const firstChild = 4 * idx + 1;

      // Check up to 4 children
      for (let c = 0; c < 4; c++) {
        const childIdx = firstChild + c;
        if (childIdx >= size) break;
        const childEntry = this.heap[childIdx];
        const smallestEntry = this.heap[smallest];
        if (childEntry && smallestEntry && childEntry[1] < smallestEntry[1]) {
          smallest = childIdx;
        }
      }

      if (smallest === idx) break;
      const current = this.heap[idx];
      const smallestEntrySwap = this.heap[smallest];
      if (!current || !smallestEntrySwap) break;
      this.heap[idx] = smallestEntrySwap;
      this.heap[smallest] = current;
      this.laneIndexToHeapIndex.set(current[0], smallest);
      this.laneIndexToHeapIndex.set(smallestEntrySwap[0], idx);
      idx = smallest;
    }
  }

  private siftUp(startIdx: number): void {
    let idx = startIdx;
    while (idx > 0) {
      const parent = Math.floor((idx - 1) / 4);
      const parentEntry = this.heap[parent];
      const currentEntry = this.heap[idx];
      if (!parentEntry || !currentEntry) break;
      if (parentEntry[1] <= currentEntry[1]) break;
      this.heap[parent] = currentEntry;
      this.heap[idx] = parentEntry;
      this.laneIndexToHeapIndex.set(parentEntry[0], idx);
      this.laneIndexToHeapIndex.set(currentEntry[0], parent);
      idx = parent;
    }
  }
}
