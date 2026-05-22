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
 *   - Precision exit-time: for scrolling mode, lane occupancy is computed
 *     as the exact time until the comment's right edge exits the screen,
 *     plus a small headway gap (30-200ms). This replaces the old blanket
 *     duration + 15% cooldown — reducing horizontal dead-space between
 *     consecutive comments from ~433px to ~10-20px at 200px/s.
 *   - Normalized composite scoring: wait time, spatial density, message
 *     count, temporal batch density, and batch-adjacent penalty are all
 *     normalized to [0, 1] so no single term dominates.
 *   - Temporal density: per-batch lane assignment counters spread messages
 *     across lanes within the same drainQueue batch, preventing vertical
 *     clumping when multiple comments arrive simultaneously.
 *   - Batch-adjacent penalty: prevents diagonal entry patterns by penalizing
 *     consecutive batch assignments to the same or adjacent lanes.
 *   - Epsilon-greedy selection: 10% of allocations randomly explore a
 *     non-optimal lane from the top-K candidates, breaking deterministic
 *     long-term diagonal bands.
 *   - Backlog adjacency penalty: during backlog injection, penalizes lanes
 *     whose neighbours were recently used, enforcing vertical spread.
 *   - Backlog lane partitioning: during backlog injection, a subset of lanes
 *     is reserved for backlog messages, preventing visual overlap with
 *     real-time messages.
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
  /** Per-lane batch assignment count (reset per drainQueue batch). */
  private batchMessageCounts: number[] = [];
  /** Index of the last lane assigned in the current batch (diagonal prevention). */
  private lastBatchLane: number | null = null;
  private laneHeight = 0;
  private laneCount = 0;

  /**
   * Minimum cooldown between consecutive uses of the same lane (ms).
   * Used only for top/bottom (non-scrolling) modes where the message
   * stays visible for the full duration. For scrolling mode, precision
   * exit-time is used instead.
   */
  private static readonly LANE_COOLDOWN_MIN_MS = 500;

  /**
   * Safety margin ratio applied to message duration.
   * Used only for top/bottom (non-scrolling) modes.
   */
  private static readonly SAFETY_MARGIN_RATIO = 0.15;

  /**
   * Headway gap between consecutive scrolling comments on the same lane (ms).
   * This replaces the duration-proportional cooldown for scrolling mode.
   * After the previous comment's right edge exits the screen, we wait only
   * this short gap before releasing the lane — dramatically reducing visual
   * dead space between consecutive comments on the same row.
   *
   * The gap is clamped between HEADWAY_GAP_MS_MIN and HEADWAY_GAP_MS_MAX,
   * with a time-proportional component for natural feel at various speeds.
   * At 200px/s: ~50-100ms headway → ~10-20px gap (vs 433px before).
   */
  private static readonly HEADWAY_GAP_MS_MIN = 30;
  private static readonly HEADWAY_GAP_MS_MAX = 200;
  private static readonly HEADWAY_GAP_TIME_RATIO = 0.025;

  /**
   * Epsilon-greedy lane selection probability (0–1).
   * With this probability, instead of picking the absolute best lane by
   * composite score, a random lane is chosen from the remaining top-K
   * candidates. This breaks deterministic diagonal patterns that emerge
   * when the scoring function always picks the same lane order.
   *
   * 0.10 = 10% of allocations explore alternatives (roughly 1 in 10
   * messages in a batch). Low enough to not degrade primary DLIOS
   * invariant (constant velocity), high enough to disrupt steady-state
   * diagonal bands.
   */
  private static readonly EPSILON = 0.1;

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
    this.batchMessageCounts = [];
    this.lastBatchLane = null;
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
      this.batchMessageCounts.push(0);
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
   * For scrolling mode, uses precision exit-time:
   *   occupancyMs = visualExitTime + HEADWAY_GAP
   * where visualExitTime is when the comment's right edge exits the screen.
   * This replaces the old duration + cooldown model and dramatically reduces
   * dead space between consecutive comments on the same lane.
   *
   * For top/bottom mode, msgWidth/screenWidth are omitted and the old
   * duration + cooldown model applies (message stays visible for full duration).
   *
   * @param placement   - The lane placement returned by findPlacement()
   * @param startTime   - The timestamp (performance.now()) when the message starts
   * @param durationMs  - The actual animation duration in milliseconds
   * @param msgWidth    - Message pixel width (scrolling mode only)
   * @param screenWidth - Viewport width (scrolling mode only)
   */
  commitPlacement(
    placement: LanePlacement,
    startTime: number,
    durationMs: number,
    msgWidth?: number,
    screenWidth?: number
  ): void {
    const occupancyMs = this.computeOccupancyMs(durationMs, msgWidth, screenWidth);

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
      // Track batch assignment count for temporal density scoring
      const batchCount = this.batchMessageCounts[laneIdx];
      if (batchCount !== undefined) {
        this.batchMessageCounts[laneIdx] = batchCount + 1;
      }
    }
    // Update density cache for spatial scoring
    this.updateDensityOnCommit(startIdx, startTime);
    // Track last batch lane for anti-diagonal penalty
    this.lastBatchLane = startIdx;
  }

  // ── Partition and batch control ───────────────────────────────────────

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

  /**
   * Reset per-batch tracking state. Must be called at the start of each
   * drainQueue batch (typically once per render frame).
   *
   * Resets:
   *   - batchMessageCounts: per-lane assignment counters
   *   - lastBatchLane: the most recently assigned lane index
   */
  resetBatch(): void {
    this.batchMessageCounts.fill(0);
    this.lastBatchLane = null;
  }

  // ── Private helpers ─────────────────────────────────────────────────

  /**
   * Compute the effective time this message occupies its lane.
   *
   * For scrolling mode: the comment exits the frame when its right edge
   * passes the left edge. This happens before `duration` ends because
   * duration includes the exitPadding. We compute the exact exit time
   * and add only a small headway gap.
   *
   * For top/bottom mode: the message stays visible for the full duration,
   * so the old cooldown model applies.
   */
  private computeOccupancyMs(
    durationMs: number,
    msgWidthPx?: number,
    screenWidth?: number
  ): number {
    // Top/bottom mode: full duration + safety cooldown
    if (msgWidthPx === undefined || screenWidth === undefined) {
      const safetyMargin = Math.round(durationMs * LaneAllocator.SAFETY_MARGIN_RATIO);
      return durationMs + Math.max(LaneAllocator.LANE_COOLDOWN_MIN_MS, safetyMargin);
    }

    // Scrolling mode: precision exit-time
    const exitPadding = Math.max(
      this.options.fontSize * rendererLayout.exitPaddingScale,
      rendererLayout.exitPaddingMin
    );
    const totalDistance = screenWidth + msgWidthPx + exitPadding;
    // Fraction of duration until the right edge passes x=0
    const visibleFraction = (screenWidth + msgWidthPx) / totalDistance;
    const visualExitMs = Math.round(visibleFraction * durationMs);
    // Headway gap: proportional but clamped
    const headwayMs = Math.round(
      Math.max(
        LaneAllocator.HEADWAY_GAP_MS_MIN,
        Math.min(
          LaneAllocator.HEADWAY_GAP_MS_MAX,
          durationMs * LaneAllocator.HEADWAY_GAP_TIME_RATIO
        )
      )
    );
    return visualExitMs + headwayMs;
  }

  /**
   * Per-lane cached spatial density score.
   * Updated incrementally on commitPlacement instead of O(n) scan.
   * Decays exponentially over DECAY_WINDOW_MS.
   */
  private readonly laneDensityScore: number[] = [];
  private static readonly DENSITY_DECAY_WINDOW_MS = 8_000;

  /** Incrementally update density scores when a lane is committed. */
  private updateDensityOnCommit(laneIndex: number, now: number): void {
    // Only update the committed lane and nearby lanes (distance <= 3).
    // Distant lanes get negligible weight (1/(1+3*0.1) ≈ 0.77 at dist=3,
    // decaying rapidly), so skipping them saves O(n) per commit.
    const range = 3;
    const start = Math.max(0, laneIndex - range);
    const end = Math.min(this.laneCount - 1, laneIndex + range);
    for (let i = start; i <= end; i++) {
      const distance = Math.abs(i - laneIndex);
      const proximityWeight = 1 / (1 + distance * 0.1);
      const current = this.laneDensityScore[i] ?? 0;
      this.laneDensityScore[i] = current + proximityWeight;
    }
    this.laneLastUsedAt[laneIndex] = now;
  }

  /** Get normalized spatial density for a lane (O(1) cached). */
  private getCachedDensity(laneIndex: number, now: number): number {
    const rawDensity = this.laneDensityScore[laneIndex] ?? 0;
    // Apply time-based decay to the cached score
    const lastUsed = this.laneLastUsedAt[laneIndex] ?? 0;
    if (lastUsed === 0) return 0;
    const age = now - lastUsed;
    if (age >= LaneAllocator.DENSITY_DECAY_WINDOW_MS) {
      this.laneDensityScore[laneIndex] = 0;
      return 0;
    }
    const decay = 1 - age / LaneAllocator.DENSITY_DECAY_WINDOW_MS;
    return rawDensity * decay;
  }

  /**
   * Composite lane score: lower is better.
   * All components are normalized to [0, 1] so no single term dominates.
   *
   * Components:
   *   - wait: normalized wait time (primary — DLIOS invariant)
   *   - density: global spatial density (secondary — prevents clustering)
   *   - count: normalized message count (tertiary — load balancing)
   *   - temporal: batch-internal lane assignment count (vertical spread)
   *   - batchAdjacent: penalty for placing near the last batch lane (diagonal break)
   */
  private laneScore(laneIndex: number, waitMs: number, now: number): number {
    // Normalize wait to [0, 1] using the max scroll duration as upper bound
    const maxWait = rendererLayout.durationMax;
    const normalizedWait = Math.min(1, waitMs / maxWait);

    // Normalize spatial density to [0, 1] — O(1) cached
    const rawDensity = this.getCachedDensity(laneIndex, now);
    const maxRawDensity = this.laneCount * 0.5; // theoretical upper bound
    const normalizedDensity = Math.min(1, rawDensity / maxRawDensity);

    // Normalize message count to [0, 1]
    const maxCount = Math.max(1, ...this.laneMessageCounts);
    const normalizedCount = (this.laneMessageCounts[laneIndex] ?? 0) / maxCount;

    // Temporal density: how many messages in this batch went to this lane
    const maxBatch = Math.max(1, ...this.batchMessageCounts);
    const normalizedTemporal = (this.batchMessageCounts[laneIndex] ?? 0) / maxBatch;

    // Batch-adjacent penalty: avoid placing consecutive batch messages
    // in the same or adjacent lanes (breaks diagonal patterns).
    const batchAdjacent = this.computeBatchAdjacent(laneIndex);

    // Weighted combination: wait is primary, density/count secondary,
    // temporal and batch-adjacent are tertiary (prevent clustering).
    return (
      normalizedWait * 0.4 +
      normalizedDensity * 0.25 +
      normalizedCount * 0.15 +
      normalizedTemporal * 0.1 +
      batchAdjacent * 0.1
    );
  }

  /**
   * Penalty for placing a message near the most recently assigned lane
   * in the current batch. This prevents sequential lane assignment patterns
   * (diagonal entry) when multiple messages are drained in a single frame.
   *
   * Returns 1.0 for the same lane, 0.5 for adjacent, 0 otherwise.
   */
  private computeBatchAdjacent(laneIndex: number): number {
    if (this.lastBatchLane === null) return 0;
    const dist = Math.abs(laneIndex - this.lastBatchLane);
    if (dist === 0) return 1.0;
    if (dist === 1) return 0.5;
    return 0;
  }

  /**
   * Normalized score for a multi-slot block.
   * Uses the same normalization as laneScore but operates on block-aggregate
   * values (max wait, avg density, avg count, avg batch) plus an adjacency
   * penalty and batch-adjacent penalty.
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

    // Temporal density for the block (average batch count across slots)
    const maxBatch = Math.max(1, ...this.batchMessageCounts);
    let avgBatch = 0;
    for (let s = 0; s < slotCount; s++) {
      avgBatch += this.batchMessageCounts[startIdx + s] ?? 0;
    }
    avgBatch /= slotCount;
    const normalizedTemporal = avgBatch / maxBatch;

    // Batch-adjacent penalty
    const batchAdjacent = this.computeBatchAdjacent(startIdx);

    // Adjacent penalty: check if lanes immediately above or below the
    // block were recently used. This prevents tall messages from being
    // stacked directly on top of each other.
    const adjacentPenalty = this.adjacentPenalty(startIdx, slotCount, now);

    return (
      normalizedWait * 0.4 +
      normalizedDensity * 0.25 +
      normalizedCount * 0.15 +
      normalizedTemporal * 0.1 +
      batchAdjacent * 0.1 +
      adjacentPenalty
    );
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
   * the best composite score (wait time + spatial density + message count
   * + temporal batch density + batch-adjacent penalty).
   *
   * With probability EPSILON (10%), a random lane from the non-best
   * top-K candidates is selected instead (epsilon-greedy exploration).
   * This breaks deterministic diagonal bands in the steady state.
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

    // Epsilon-greedy: with EPSILON probability, pick a random lane from the
    // remaining candidates instead of the absolute best. This breaks
    // deterministic diagonal patterns in the steady state.
    if (candidates.length > 1 && Math.random() < LaneAllocator.EPSILON) {
      // Pick a random candidate that scored well but isn't the absolute best
      const exploreCount = Math.min(candidates.length - 1, 4);
      const exploreIdx = 1 + Math.floor(Math.random() * exploreCount);
      const explore = candidates[exploreIdx];
      if (explore) {
        const wait = Math.max(0, Math.ceil(explore.availableAt - now));
        if (wait <= maxWaitMs) {
          return { laneIndex: explore.laneIndex, waitMs: wait };
        }
      }
    }

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
        blockDensitySum += this.getCachedDensity(slotIdx, now);
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
