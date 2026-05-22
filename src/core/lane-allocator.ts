import type { OverlayDimensions } from '@app-types';
import { rendererLayout } from '@core/design-tokens';
import { measureTextHeight } from '@core/text-measure';

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
 * Top-first lane scheduler.
 *
 * Fills lanes from the top of the screen down:
 *
 *   1. Scan lanes from index 0 (topmost) to laneCount (bottommost).
 *   2. Phase 1 (zero-wait): return the first lane with waitMs === 0.
 *      During a burst this distributes across all lanes: msg1 → lane 0,
 *      msg2 → lane 1, ..., msgN → lane N-1.
 *   3. Phase 2 (all busy): return the topmost busy lane. The collision
 *      check in checkPlacement rejects it (right edge near entry), pushing
 *      the message back for retry rather than dropping it.
 *   4. Collision feedback: when checkPlacement detects a collision,
 *      markCollision(laneIndex) is called so subsequent calls in the
 *      same batch skip that lane and try the next one below.
 *   5. Multi-slot messages (superchats, memberships) scan for the first
 *      contiguous block of free lanes, also from the top.
 *   6. Backlog priority: backlog messages skip Phase 2 (busy lane fallback).
 *      They only use completely free lanes; if none exist, they accept
 *      a dropped message rather than competing with real-time traffic.
 *
 * Supports:
 *   - Precision exit-time occupancy for multi-message lane sharing
 *   - Adaptive headway gap (8% of msg width, 16-60px clamp)
 *   - Velocity-aware durationMin (via computeDliosDuration)
 */
export class LaneAllocator {
  /** 4-ary min-heap of [laneIndex, availableAtMs] pairs, sorted by availableAtMs */
  private heap: [number, number][] = [];
  /** Reverse map: laneIndex → heap index for O(1) lookup and update */
  private laneIndexToHeapIndex: Map<number, number> = new Map();
  private laneHeight = 0;
  private laneCount = 0;

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
   * Headway gap between consecutive scrolling comments on the same lane.
   * Dynamically computed as a fraction of message width so short messages
   * get a tighter gap (higher density) while long messages still maintain
   * a readable separation.
   *
   * Formula: headwayPx = clamp(msgWidth * HEADWAY_GAP_RATIO, MIN, MAX)
   *
   * Also used as the lane-reuse gap: a new message can enter when the
   * previous message's right edge has passed the screen's right edge by
   * headwayPx pixels — enabling multiple messages per lane.
   * At font-size 32, "hello" (~80px) → headway 16px (was 40px, -60%).
   * At font-size 32, long msg (~500px) → headway 40px.
   */
  private static readonly HEADWAY_GAP_RATIO = 0.08;
  private static readonly HEADWAY_GAP_MIN_PX = 16;
  private static readonly HEADWAY_GAP_MAX_PX = 60;

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
    const font = `${this.options.fontWeight === 'bold' ? 'bold' : '400'} ${this.options.fontSize}px ${this.options.fontFamily}`;
    const textHeight = measureTextHeight(font, this.options.fontSize);

    this.laneHeight = Math.max(1, textHeight + totalPaddingV + this.options.laneSpacing);

    const usableHeight = dimensions.height * (1 - this.options.safeTop - this.options.safeBottom);
    this.laneCount = Math.max(1, Math.floor(usableHeight / this.laneHeight));

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

    // Store real-time occupancy end-time per lane so backlog messages
    // can prefer lanes without recent real-time traffic.
    if (!isBacklog) {
      const until = startTime + occupancyMs;
      for (let s = 0; s < placement.slotCount; s++) {
        this.realTimeLanesUntil.set(startIdx + s, until);
      }
    }

    // Update all slots occupied by this message with the SAME available time.
    // This prevents partial-slot availability where a new message could enter
    // a "released" top slot while the bottom slot is still occupied, causing
    // visual overlap with the multi-slot message (e.g. SuperChat cards).
    for (let s = 0; s < placement.slotCount; s++) {
      this.updateLane(startIdx + s, nextAvailable);
    }
  }

  // ── Batch control ─────────────────────────────────────────────────────

  /**
   * Called at the start of each drainQueue batch. Clears per-frame collision
   * tracking so lanes can be retried on the next frame.
   */
  resetBatch(): void {
    this.collidedLanes.clear();
    // Prune expired real-time lane entries (availableAt <= now means
    // the lane's occupancy has passed and it's safe to reuse).
    const now = performance.now();
    for (const [laneIdx, until] of this.realTimeLanesUntil) {
      if (until <= now) this.realTimeLanesUntil.delete(laneIdx);
    }
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
        Math.round(msgWidthPx * LaneAllocator.HEADWAY_GAP_RATIO)
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
   * Allocate a single lane — scan from top (lowest index) to bottom.
   *
   * Phase 1 — strict zero-wait: return the first lane with waitMs === 0
   * (completely free right now). This distributes messages across lanes
   * during a burst: msg1 → lane 0, msg2 → lane 1, ..., msgN → lane N-1.
   *
   * Phase 2 — all lanes busy: return the topmost busy lane (only for
   * real-time messages). Backlog messages skip Phase 2 — they only use
   * truly free lanes, accepting a dropped message over visual crowding.
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

    // Phase 1: scan for a zero-wait lane (truly free right now).
    // Skip lanes that previously collided in this batch — they're visually
    // occupied even if their availableAt has technically expired.
    // For backlog messages, also skip lanes with recent real-time traffic.
    for (let i = laneStart; i < laneEnd; i++) {
      if (this.collidedLanes.has(i)) continue;
      if (isBacklog && (this.realTimeLanesUntil.get(i) ?? 0) > now) continue;
      const avail = this.getSlotAvailableAt(i);
      if (avail === undefined) continue;
      const wait = Math.max(0, Math.ceil(avail - now));
      if (wait > 0) {
        // Track the topmost busy lane for phase 2 fallback.
        if (!firstBusy) firstBusy = { laneIndex: i, waitMs: wait };
        continue;
      }
      // Found a zero-wait lane. Epsilon-greedy: 5% chance to skip this
      // lane and pick the next zero-wait lane for visual variety.
      if (Math.random() < LaneAllocator.EPSILON) continue;
      return { laneIndex: i, waitMs: 0 };
    }

    // Phase 2: no zero-wait lane — all lanes are busy.
    // Backlog messages skip this phase — they only use truly free lanes
    // and accept a dropped message rather than competing with real-time
    // traffic on busy lanes. Real-time messages get the topmost busy lane
    // so the collision check can push them back for retry (not dropped).
    if (!isBacklog && firstBusy && firstBusy.waitMs <= maxWaitMs) return firstBusy;
    return null;
  }

  /**
   * Allocate a contiguous block of `slotCount` lanes for tall messages
   * (superchat, membership). Scans from top to bottom for the first
   * block where ALL slots are zero-wait (truly free). Multi-slot
   * messages are rare so the busy-lane fallback from allocateSingleLane
   * handles them when no free block exists.
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

    // Phase 1: scan for a block where ALL slots have waitMs === 0.
    for (let startIdx = laneStart; startIdx <= maxStartLane; startIdx++) {
      let allZeroWait = true;
      let blockMaxWait = 0;
      for (let s = 0; s < slotCount; s++) {
        const slotAvail = this.getSlotAvailableAt(startIdx + s);
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

    // Phase 2: no zero-wait block — delegate to single-lane allocator
    // which returns the topmost busy lane (or null for backlog).
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
