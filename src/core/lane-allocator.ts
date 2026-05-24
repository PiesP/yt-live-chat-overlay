import type { OverlayDimensions } from '@app-types';
import { rendererLayout } from '@core/design-tokens';
import { forEachSlot } from '@core/dom';
import { createLogger } from '@core/logging';
import { getFontString, measureTextHeight } from '@core/text-measure';

const log = createLogger('LaneAllocator');

export interface LanePlacement {
  laneIndex: number;
  waitMs: number;
  laneY: number;
  /** Number of lane slots this message occupies (1 for regular, 2+ for superchat/membership) */
  slotCount: number;
  /**
   * Vertical centering offset within the allocated lane block (px).
   * Tall messages (with author, multi-line cards) are centered in their
   * multi-slot block to distribute empty space evenly above and below.
   * Single-slot messages return 0 (close to the lane top, no visible gap).
   */
  verticalOffset: number;
}

interface LaneAllocatorOptions {
  safeTop: number;
  safeBottom: number;
  readonly fontSize: number;
  readonly fontWeight: 'normal' | 'bold';
  readonly fontFamily: string;
  readonly laneSpacing: number;
}

/**
 * Top-first lane scheduler with speed-isolated lane allocation.
 *
 * Fills lanes from the top of the screen down using a three-phase strategy
 * that naturally groups messages with similar speeds together:
 *
 *   1. Phase 1 (zero-wait, speed-filtered): return the first lane with
 *      waitMs === 0 that also passes the speed compatibility check.
 *      Real-time messages skip lanes with active backlog content;
 *      backlog messages skip lanes with active real-time content.
 *      During a burst this distributes across all lanes: msg1 → lane 0,
 *      msg2 → lane 1, ..., msgN → lane N-1.
 *
 *   2. Phase 2 (speed-matched): when all lanes are busy, prefer lanes
 *      that already have same-speed content. Real-time messages cluster
 *      with real-time, backlog with backlog. This produces natural
 *      visual zones without hard-coded partitions.
 *
 *   3. Phase 3 (fastest-free): when no speed-matched lane is available,
 *      return the topmost busy lane (shortest wait) for all message types.
 *      Speed-isolated headway scaling in checkPlacement() prevents visual
 *      overtaking when a fast backlog message shares a lane with a slower
 *      real-time message.
 *
 * Supports:
 *   - Precision exit-time occupancy for multi-message lane sharing
 *   - Adaptive headway gap (8% of msg width, 16-60px clamp)
 *   - Velocity-aware durationMin (via computeScrollDuration)
 */
export class LaneAllocator {
  /** 4-ary min-heap of [laneIndex, availableAtMs] pairs, sorted by availableAtMs */
  private heap: [number, number][] = [];
  /** Reverse map: laneIndex → heap index for O(1) lookup and update */
  private laneIndexToHeapIndex: Map<number, number> = new Map();
  private laneHeight = 0;
  private laneCount = 0;
  /** Cached utilization value, recomputed in resetBatch for O(1) reads. */
  private cachedUtilization = 0;

  /**
   * Set of lane indices that collided with an active message in the current
   * batch. Updated via markCollision() from renderer-canvas.ts checkPlacement.
   * Cleared on resetBatch(). When a lane is in this set, allocateSingleLane
   * skips it and tries the next lane down, avoiding repeated collisions on
   * the same lane within a single frame.
   */
  private collidedLanes: Set<number> = new Set();

  /**
   * Tracks until when each lane has active real-time content (non-backlog).
   * Map laneIndex → timestamp (performance.now()) until which the lane is
   * considered to have real-time occupancy. Backlog messages skip these
   * lanes when zero-wait lanes exist without recent real-time traffic.
   * Stale entries (timestamp < now) are cleared on each resetBatch().
   */
  private realTimeLanesUntil: Map<number, number> = new Map();

  /**
   * Tracks until when each lane has active backlog content.
   * Real-time messages skip these lanes in Phase 1 so they naturally
   * cluster together, forming visually distinct speed zones.
   */
  private backlogLanesUntil: Map<number, number> = new Map();

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

  static readonly HEADWAY_GAP_MIN_PX = 16;
  static readonly HEADWAY_GAP_MAX_PX = 60;

  /**
   * Epsilon-greedy selection probability (0–1).
   * 5% chance to skip the strict topmost zero-wait lane and pick the
   * next one below. Prevents all traffic from consolidating on lane 0
   * when the incoming message rate is low.
   */
  private static readonly EPSILON = 0.05;

  constructor(private readonly options: LaneAllocatorOptions) {}

  /** Update safe-zone ratios without rebuilding lane state. */
  updateSafeZone(safeTop: number, safeBottom: number): void {
    this.options.safeTop = safeTop;
    this.options.safeBottom = safeBottom;
  }

  reset(dimensions: OverlayDimensions | null): void {
    this.heap = [];
    this.laneIndexToHeapIndex = new Map();
    this.collidedLanes.clear();
    this.realTimeLanesUntil.clear();
    this.backlogLanesUntil.clear();
    this.cachedUtilization = 0;
    if (!dimensions) {
      this.laneHeight = 0;
      this.laneCount = 0;
      return;
    }

    // Formula: laneHeight = textHeight + paddingV*2 + laneSpacing
    // The author section is NOT included because most messages have
    // showAuthor=false by default. Messages WITH author (moderator,
    // owner, superChat) report a taller msgHeight from estimateDimensions,
    // so slotCount = ceil(msgHeight / laneHeight) auto-assigns 2+ slots.
    const totalPaddingV = rendererLayout.paddingV * 2;
    const font = getFontString(
      this.options.fontSize,
      this.options.fontWeight,
      this.options.fontFamily
    );
    const textHeight = measureTextHeight(font, this.options.fontSize);

    this.laneHeight = Math.max(1, textHeight + totalPaddingV + this.options.laneSpacing);

    const usableHeight = dimensions.height * (1 - this.options.safeTop - this.options.safeBottom);
    this.laneCount = Math.max(1, Math.floor(usableHeight / this.laneHeight));

    log.debug('Reset', { lanes: this.laneCount, height: Math.round(this.laneHeight) });

    // Uniform initialization: all lanes start at the same available time.
    const now = performance.now();
    for (let i = 0; i < this.laneCount; i++) {
      this.heap.push([i, now]);
      this.laneIndexToHeapIndex.set(i, i);
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

  /** Get current lane utilization ratio (0-1): occupied lanes / total lanes. O(1) cached value. */
  getUtilization(): number {
    if (this.heap.length === 0) return 0;
    return this.cachedUtilization;
  }

  getLaneHeight(): number {
    return this.laneHeight;
  }

  getLaneY(laneIndex: number, viewportHeight: number): number {
    return viewportHeight * this.options.safeTop + laneIndex * this.laneHeight;
  }

  findPlacement(
    messageHeight: number,
    dimensions: OverlayDimensions,
    isBacklog = false
  ): LanePlacement | null {
    const now = performance.now();
    const totalLanes = this.laneCount;
    if (totalLanes <= 0) return null;

    // Calculate how many lane slots this message needs.
    // A superchat card may be 3-5x taller than a regular message.
    const slotCount = Math.max(1, Math.ceil(messageHeight / this.laneHeight));

    // Scan from the top for the first free lane/block.
    const result = this.allocateMultiSlot(now, 0, totalLanes, slotCount, isBacklog);
    if (!result) return null;

    return {
      laneIndex: result.laneIndex,
      waitMs: result.waitMs,
      laneY: this.getLaneY(result.laneIndex, dimensions.height),
      slotCount,
      verticalOffset: Math.floor((slotCount * this.laneHeight - messageHeight) / 2),
    };
  }

  /**
   * Commit the placement — update the lane's available time for the
   * next message. For multi-slot messages, all occupied lanes are updated.
   *
   * For scrolling mode, uses precision exit-time:
   *   occupancyMs = rightEdgePassMs
   * where rightEdgePassMs is when the comment's right edge exits the
   * screen plus a small headway gap. This replaces the old duration +
   * cooldown model and dramatically reduces dead space between consecutive
   * comments on the same lane.
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
    screenWidth?: number,
    isBacklog = false
  ): void {
    const occupancyMs = this.computeOccupancyMs(durationMs, msgWidth, screenWidth);
    const nextAvailable = startTime + occupancyMs;
    const startIdx = placement.laneIndex;

    // Store speed-profile visibility end-time per lane so that
    // subsequent allocations can group messages by speed profile.
    // Uses durationMs (full on-screen time) rather than occupancyMs
    // (right-edge-pass time) to prevent cross-speed overtaking.
    // A faster backlog message must never enter a lane where a slower
    // real-time message is still visible, even if its right edge has
    // already passed the screen edge.
    // Real-time → realTimeLanesUntil, backlog → backlogLanesUntil.
    const until = startTime + durationMs;
    if (isBacklog) {
      forEachSlot(startIdx, placement.slotCount, (slotIdx) => {
        this.backlogLanesUntil.set(slotIdx, until);
      });
    } else {
      forEachSlot(startIdx, placement.slotCount, (slotIdx) => {
        this.realTimeLanesUntil.set(slotIdx, until);
      });
    }

    // Update all slots occupied by this message with the SAME available time.
    // This prevents partial-slot availability where a new message could enter
    // a "released" top slot while the bottom slot is still occupied, causing
    // visual overlap with the multi-slot message (e.g. SuperChat cards).
    forEachSlot(startIdx, placement.slotCount, (slotIdx) => {
      this.updateLane(slotIdx, nextAvailable);
    });
  }

  // ── Batch control ─────────────────────────────────────────────────────

  /**
   * Called at the start of each drainQueue batch. Clears per-frame collision
   * tracking so lanes can be retried on the next frame.
   */
  resetBatch(): void {
    this.collidedLanes.clear();
    // Prune expired speed-profile lane entries.
    const now = performance.now();
    for (const [laneIdx, until] of this.realTimeLanesUntil) {
      if (until <= now) this.realTimeLanesUntil.delete(laneIdx);
    }
    for (const [laneIdx, until] of this.backlogLanesUntil) {
      if (until <= now) this.backlogLanesUntil.delete(laneIdx);
    }
    // Recompute cached utilization for O(1) getUtilization().
    let occupied = 0;
    for (const [, availableAt] of this.heap) {
      if (availableAt > now) occupied++;
    }
    this.cachedUtilization = this.heap.length > 0 ? occupied / this.heap.length : 0;
  }

  /**
   * Mark a lane as having collided with an active message in this batch.
   * Subsequent findPlacement() calls in the same batch skip this lane,
   * falling through to the next available lane below.
   */
  markCollision(laneIndex: number): void {
    this.collidedLanes.add(laneIndex);
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
    // exitPadding must match renderFrame's travel distance computation.
    const totalDistance = screenWidth + msgWidthPx + rendererLayout.exitPaddingMin;
    // Adaptive headway gap: proportional to message width so short messages
    // get tighter spacing (higher lane density) while long messages maintain
    // readable separation. At font-size 32, a 3-char message (~80px) gets
    // 16px gap, a long message (~500px) gets 40px gap.
    const headwayPx = Math.max(
      LaneAllocator.HEADWAY_GAP_MIN_PX,
      Math.min(
        LaneAllocator.HEADWAY_GAP_MAX_PX,
        Math.round(msgWidthPx * rendererLayout.headwayGapRatio)
      )
    );
    // Multi-message lane sharing: the lane is freed when the message has
    // scrolled just beyond its own width + headway gap. This allows a new
    // message to enter from the right while the previous message is still
    // visible on screen — they simply share the same lane without overlap.
    // Previously the lane was held until the message fully exited the left
    // edge (visualExitMs), which blocked the lane for ~95% of its duration.
    const rightEdgePassFraction = (msgWidthPx + headwayPx) / totalDistance;
    const rightEdgePassMs = Math.round(rightEdgePassFraction * durationMs);
    // The headway gap in time is already accounted for in rightEdgePassMs
    // (via headwayPx). No separate headwayMs needed.
    return rightEdgePassMs;
  }

  /**
   * Allocate a single lane with three-phase speed-isolated scanning.
   *
   * Phase 1 — zero-wait with speed filter: return the first completely
   * free lane (waitMs === 0) that is compatible with this message's speed
   * profile. Real-time skips backlog-occupied lanes; backlog skips
   * real-time-occupied lanes. Epsilon-greedy (5%) skips the first match
   * for visual variety.
   *
   * Phase 2 — speed-matched busy lane: if no zero-wait lane is compatible,
   * prefer lanes that already have same-speed content (shortest wait first).
   * Both real-time and backlog benefit from clustering with their own kind.
   *
   * Phase 3 — fastest-free lane (real-time only): fall back to the topmost
   * busy lane regardless of speed profile. Backlog messages stop here and
   * return null — they don't compete with real-time on busy lanes.
   *
   * Collided lanes (from markCollision feedback) are excluded from all phases.
   */
  private allocateSingleLane(
    now: number,
    laneStart: number,
    laneEnd: number,
    isBacklog = false
  ): { laneIndex: number; waitMs: number } | null {
    if (this.heap.length === 0) return null;

    const maxWaitMs = rendererLayout.durationMax;
    let firstBusy: { laneIndex: number; waitMs: number } | null = null;
    let speedMatched: { laneIndex: number; waitMs: number } | null = null;

    // ── Phase 1: zero-wait lane with speed compatibility filter ──
    for (let i = laneStart; i < laneEnd; i++) {
      if (this.collidedLanes.has(i)) continue;

      // Speed compatibility check
      if (isBacklog) {
        // Backlog: skip lanes with active real-time content
        if ((this.realTimeLanesUntil.get(i) ?? 0) > now) continue;
      } else {
        // Real-time: skip lanes with active backlog content
        if ((this.backlogLanesUntil.get(i) ?? 0) > now) continue;
      }

      const avail = this.getSlotAvailableAt(i);
      if (avail === undefined) continue;
      const wait = Math.max(0, Math.ceil(avail - now));
      if (wait > 0) {
        // Track for phases 2-3
        if (!firstBusy) firstBusy = { laneIndex: i, waitMs: wait };
        // Track speed-matched candidate for phase 2
        if (!speedMatched || wait < speedMatched.waitMs) {
          const hasSameSpeed = isBacklog
            ? (this.backlogLanesUntil.get(i) ?? 0) > now
            : (this.realTimeLanesUntil.get(i) ?? 0) > now;
          if (hasSameSpeed) speedMatched = { laneIndex: i, waitMs: wait };
        }
        continue;
      }
      // Found a zero-wait compatible lane.
      // Epsilon-greedy: 5% chance to skip for visual variety.
      if (Math.random() < LaneAllocator.EPSILON) continue;
      return { laneIndex: i, waitMs: 0 };
    }

    // ── Phase 2: speed-matched busy lane ──
    // Prefer lanes already running at the same speed profile.
    if (speedMatched && speedMatched.waitMs <= maxWaitMs) return speedMatched;

    // ── Phase 3: fastest-free lane (all message types) ──
    // Real-time and backlog both fall back to the soonest-available lane.
    // Backlog previously returned null here (hard drop), but with drainQueue
    // now retrying 'no_lane' via retryQueue, backlog messages can wait for
    // a lane to free up naturally. Speed-isolated headway scaling in
    // checkPlacement() prevents visual overtaking on cross-speed lanes.
    if (firstBusy && firstBusy.waitMs <= maxWaitMs) return firstBusy;
    return null;
  }

  /**
   * Allocate a contiguous block of `slotCount` lanes for tall messages
   * (superchat, membership). Uses a 3-phase strategy:
   *
   * Phase 1 — zero-wait block: scan for a block where ALL slots are free
   * and speed-compatible. First match wins (epsilon-greedy not needed here
   * since multi-slot messages are rare).
   *
   * Phase 2 — busy block within maxWaitMs: scan for a contiguous block
   * where ALL slots pass speed-compatibility AND have waitMs <= maxWaitMs.
   * Among valid blocks, pick the one with the shortest max wait.
   *
   * Phase 3 — fallback: backlog messages return null (don't compete with
   * real-time on busy lanes). Real-time messages fall back to the
   * single-lane allocator as a last resort.
   *
   * Single-slot messages are forwarded to allocateSingleLane.
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

    // Phase 1: scan for a block where ALL slots have waitMs === 0 and
    // are compatible with this message's speed profile.
    for (let startIdx = laneStart; startIdx <= maxStartLane; startIdx++) {
      let allZeroWait = true;
      let blockMaxWait = 0;
      for (let s = 0; s < slotCount; s++) {
        const slotIdx = startIdx + s;
        if (this.collidedLanes.has(slotIdx)) {
          allZeroWait = false;
          break;
        }
        // Speed compatibility check for the block
        if (isBacklog) {
          if ((this.realTimeLanesUntil.get(slotIdx) ?? 0) > now) {
            allZeroWait = false;
            break;
          }
        } else {
          if ((this.backlogLanesUntil.get(slotIdx) ?? 0) > now) {
            allZeroWait = false;
            break;
          }
        }
        const slotAvail = this.getSlotAvailableAt(slotIdx);
        if (slotAvail === undefined) {
          allZeroWait = false;
          break;
        }
        const slotWait = Math.max(0, Math.ceil(slotAvail - now));
        if (slotWait > 0) allZeroWait = false;
        if (slotWait > maxWaitMs) {
          allZeroWait = false;
          break;
        }
        blockMaxWait = Math.max(blockMaxWait, slotWait);
      }
      if (allZeroWait) return { laneIndex: startIdx, waitMs: blockMaxWait };
    }

    // Phase 2: scan for a contiguous block where ALL slots are busy but
    // within maxWaitMs and pass speed-compatibility. Pick the block with
    // the shortest maximum wait (same strategy as allocateSingleLane Phase 2).
    let bestBlock: { laneIndex: number; waitMs: number } | null = null;
    for (let startIdx = laneStart; startIdx <= maxStartLane; startIdx++) {
      let allCompatible = true;
      let blockMaxWait = 0;
      for (let s = 0; s < slotCount; s++) {
        const slotIdx = startIdx + s;
        if (this.collidedLanes.has(slotIdx)) {
          allCompatible = false;
          break;
        }
        // Speed compatibility check (same as Phase 1)
        if (isBacklog) {
          if ((this.realTimeLanesUntil.get(slotIdx) ?? 0) > now) {
            allCompatible = false;
            break;
          }
        } else {
          if ((this.backlogLanesUntil.get(slotIdx) ?? 0) > now) {
            allCompatible = false;
            break;
          }
        }
        const slotAvail = this.getSlotAvailableAt(slotIdx);
        if (slotAvail === undefined) {
          allCompatible = false;
          break;
        }
        const slotWait = Math.max(0, Math.ceil(slotAvail - now));
        if (slotWait > maxWaitMs) {
          allCompatible = false;
          break;
        }
        blockMaxWait = Math.max(blockMaxWait, slotWait);
      }
      if (allCompatible && blockMaxWait <= maxWaitMs) {
        if (!bestBlock || blockMaxWait < bestBlock.waitMs) {
          bestBlock = { laneIndex: startIdx, waitMs: blockMaxWait };
        }
      }
    }
    if (bestBlock) return bestBlock;

    // Phase 3: no multi-slot block found.
    // Both real-time and backlog fall back to the single-lane allocator.
    return this.allocateSingleLane(now, laneStart, laneEnd, isBacklog);
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

  /** Shift all lane timers and speed-isolation tracking by a fixed offset. */
  shiftAll(offsetMs: number): void {
    const capped = Math.min(offsetMs, rendererLayout.maxMessageAgeMs);
    if (capped <= 0) return;

    // Shift lane occupancy timers (4-ary min-heap)
    if (this.heap.length > 0) {
      for (let i = 0; i < this.heap.length; i++) {
        const entry = this.heap[i];
        if (entry) {
          this.heap[i] = [entry[0], entry[1] + capped];
        }
      }
      // Rebuild heap invariant after bulk update (4-ary)
      for (let i = Math.floor((this.heap.length - 2) / 4); i >= 0; i--) {
        this.siftDown(i);
      }
    }

    // Shift speed-isolation tracking so real-time/backlog lane profiles
    // survive pause/resume. Without this, resetBatch() prunes all speed
    // entries as expired, allowing cross-speed overtaking after resume.
    for (const [idx, until] of this.realTimeLanesUntil) {
      this.realTimeLanesUntil.set(idx, until + capped);
    }
    for (const [idx, until] of this.backlogLanesUntil) {
      this.backlogLanesUntil.set(idx, until + capped);
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
