// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ObservabilityReporter } from "@util/observability";

describe("ObservabilityReporter", () => {
  let reporter: ObservabilityReporter;

  beforeEach(() => {
    reporter = new ObservabilityReporter(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ═══════════════════════════════════════════════════════════
  // Initial state
  // ═══════════════════════════════════════════════════════════

  it("starts with zero counts", () => {
    const metrics = reporter.getMetrics();
    expect(metrics.totalReceived).toBe(0);
    expect(metrics.totalRendered).toBe(0);
    expect(metrics.totalDropped).toBe(0);
    expect(metrics.dropRate).toBe(0);
    expect(metrics.queueDepth).toBe(0);
    expect(metrics.burstLevel).toBe("normal");
  });

  // ═══════════════════════════════════════════════════════════
  // Message lifecycle
  // ═══════════════════════════════════════════════════════════

  it("tracks received → rendered counts", () => {
    reporter.onMessageReceived();
    reporter.onMessageReceived();
    reporter.onMessageRendered();
    reporter.onMessageRendered();

    const metrics = reporter.getMetrics();
    expect(metrics.totalReceived).toBe(2);
    expect(metrics.totalRendered).toBe(2);
    expect(metrics.totalDropped).toBe(0);
  });

  it("tracks dropped messages", () => {
    reporter.onMessageReceived();
    reporter.onMessageReceived();
    reporter.onMessageDropped("queue_priority");

    const metrics = reporter.getMetrics();
    expect(metrics.totalReceived).toBe(2);
    expect(metrics.totalDropped).toBe(1);
    expect(metrics.dropRate).toBe(0.5);
  });

  it("adds batched Worker render and drop totals without per-message loops", () => {
    reporter.onMessageReceived();
    reporter.onMessageReceived();
    reporter.onMessageReceived();
    reporter.onMessageReceived();

    reporter.onMessagesRendered(3);
    reporter.onMessagesDropped(2, "worker_backpressure");

    const metrics = reporter.getMetrics();
    expect(metrics.totalRendered).toBe(3);
    expect(metrics.totalDropped).toBe(2);
    expect(metrics.dropRate).toBe(0.5);
  });

  it("counts batched pre-render drops in the received denominator", () => {
    reporter.onMessagesReceived(3);
    reporter.onMessagesDropped(3, "replay_late");
    expect(reporter.getMetrics()).toMatchObject({
      totalReceived: 3,
      totalDropped: 3,
      dropRate: 1,
    });

    reporter.onMessagesReceived(2);
    expect(reporter.getMetrics()).toMatchObject({
      totalReceived: 5,
      totalDropped: 3,
      dropRate: 0.6,
    });
  });

  it("keeps an all-late batch in the new window after idle expiry without a HUD tick", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 60_000);

    reporter.onMessagesReceived(3);
    reporter.onMessagesDropped(3, "replay_late");

    expect(reporter.getMetrics()).toMatchObject({
      totalReceived: 3,
      totalDropped: 3,
      dropRate: 1,
    });
  });

  it("keeps ordinary drops in the new window after idle expiry", () => {
    vi.useFakeTimers();
    reporter.onMessageReceived();
    reporter.onMessageDropped("queue_priority");
    vi.setSystemTime(Date.now() + 60_000);

    reporter.onMessageReceived();
    reporter.onMessageDropped("queue_priority");

    expect(reporter.getMetrics()).toMatchObject({
      totalReceived: 2,
      totalDropped: 2,
      dropRate: 1,
    });
  });

  it("ignores invalid received batch counts", () => {
    for (const count of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      reporter.onMessagesReceived(count);
    }
    expect(reporter.getMetrics().totalReceived).toBe(0);
  });

  it("computes zero drop rate when no messages received", () => {
    reporter.onMessageDropped("queue_priority");
    const metrics = reporter.getMetrics();
    expect(metrics.totalDropped).toBe(1);
    // 0 received → dropRate = 0 (avoids division by zero)
    expect(metrics.dropRate).toBe(0);
  });

  // ═══════════════════════════════════════════════════════════
  // State updates
  // ═══════════════════════════════════════════════════════════

  it("updates queue depth", () => {
    reporter.updateQueueDepth(42);
    expect(reporter.getMetrics().queueDepth).toBe(42);
  });

  it("updates burst level", () => {
    reporter.updateBurstLevel("high");
    expect(reporter.getMetrics().burstLevel).toBe("high");
  });

  it("updates active messages count", () => {
    reporter.updateActiveMessages(15);
    expect(reporter.getMetrics().activeMessages).toBe(15);
  });

  it("clamps lane utilization to [0, 1]", () => {
    reporter.updateLaneUtilization(1.5);
    expect(reporter.getMetrics().laneUtilization).toBe(1);

    reporter.updateLaneUtilization(-0.5);
    expect(reporter.getMetrics().laneUtilization).toBe(0);
  });

  it("clamps backlog progress to [0, 1]", () => {
    reporter.updateBacklogProgress(1.5);
    expect(reporter.getMetrics().backlogProgress).toBe(1);

    reporter.updateBacklogProgress(-0.5);
    expect(reporter.getMetrics().backlogProgress).toBe(0);
  });

  // ═══════════════════════════════════════════════════════════
  // Debug overlay
  // ═══════════════════════════════════════════════════════════

  it("creates debug overlay when showDebug is true", () => {
    reporter.setShowDebug(true);
    const el = document.getElementById("yt-chat-overlay-debug");
    expect(el).not.toBeNull();
    reporter.destroy();
  });

  it("does not create debug overlay when showDebug is false", () => {
    const el = document.getElementById("yt-chat-overlay-debug");
    expect(el).toBeNull();
  });

  it("tick updates overlay content when visible", () => {
    reporter.setShowDebug(true);
    reporter.onMessageReceived();
    reporter.tick();

    const el = document.getElementById("yt-chat-overlay-debug");
    expect(el?.textContent).toContain("Rcvd:");
    expect(el?.textContent).toContain("1");
    reporter.destroy();
  });

  it("labels frame timings unavailable when rendering is Worker-owned", () => {
    reporter.setShowDebug(true);
    reporter.setFrameTimingAvailable(false);
    reporter.tick();

    const el = document.getElementById("yt-chat-overlay-debug");
    expect(el?.textContent).toContain("Render: n/a | Drain: n/a");
    expect(el?.textContent).toContain("Coll: n/a | Text: n/a");
    reporter.destroy();
  });

  // ═══════════════════════════════════════════════════════════
  // Snapshot isolation
  // ═══════════════════════════════════════════════════════════

  it("getMetrics returns a snapshot (not live reference)", () => {
    reporter.onMessageReceived();
    const snapshot = reporter.getMetrics();
    reporter.onMessageReceived();

    expect(snapshot.totalReceived).toBe(1);
  });
});
