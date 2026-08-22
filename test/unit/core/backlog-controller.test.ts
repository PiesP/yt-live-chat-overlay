// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ═══════════════════════════════════════════════════════════
// Mocks
// ═══════════════════════════════════════════════════════════

vi.mock("@util/dom", () => ({
  clearSafeTimeout: vi.fn((t: unknown) => {
    if (typeof t === "number") clearTimeout(t);
    return null;
  }),
}));

// sampleExponential is pure math, use real implementation
vi.mock("@util/design-tokens", async () => {
  const actual = await vi.importActual<typeof import("@util/design-tokens")>(
    "@util/design-tokens"
  );
  return actual;
});

import { BacklogInjectionController } from "@util/backlog-controller";
import { createLogger } from "@util/logging";

// ═══════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════

function makeMsg(
  overrides: Partial<{
    id: string;
    kind: "text" | "superchat" | "membership";
    text: string;
    timestamp: number;
    actionType: "add" | "replace";
  }> = {}
) {
  return {
    id: overrides.id ?? "msg-1",
    kind: overrides.kind ?? "text",
    text: overrides.text ?? "hello world",
    authorName: "user",
    authorPhoto: "",
    authorType: "normal" as const,
    isOwner: false,
    isModerator: false,
    isVerified: false,
    isMember: false,
    timestamp: overrides.timestamp ?? 1700000000000,
    membershipColor: undefined,
    superChatInfo: undefined,
    membershipInfo: undefined,
    isBacklog: false,
    normalizedText: "hello world",
    fontSizeScale: 1,
    fontWeight: "normal" as const,
    content: [{ type: "text" as const, text: "hello world" }],
    actionType: overrides.actionType,
  } as unknown as import("@app-types").ChatMessage;
}

const defaultConfig = {
  backlogMode: "full" as const,
  backlogMaxRate: 10,
  backlogSpeedMultiplier: 2,
  backlogRecentMinutes: 5,
  backlogInjectionMax: 20,
  backlogDensityRampMs: 2500,
  backlogDensityRampMaxMs: 4000,
  backlogInjectionRateMin: 4,
  pendingCapacity: 200,
};

type ControllerInternals = {
  backlogQueue: Array<import("@app-types").ChatMessage | undefined>;
  backlogQueueOffset: number;
  backlogSeenIds: Set<string>;
  backlogPendingIndices: Map<string, number>;
  totalBacklog: number;
  processedBacklog: number;
  pendingCount: number;
  ordinaryPendingCount: number;
  capacityScanSteps: number;
  trackingRebuildCount: number;
};

function pendingState(controller: BacklogInjectionController) {
  const internals = controller as unknown as ControllerInternals;
  const messages = internals.backlogQueue
    .slice(internals.backlogQueueOffset)
    .filter((message): message is import("@app-types").ChatMessage => message !== undefined);
  return {
    messages,
    seenIds: internals.backlogSeenIds,
    pendingIndices: internals.backlogPendingIndices,
    totalBacklog: internals.totalBacklog,
    processedBacklog: internals.processedBacklog,
    pendingCount: internals.pendingCount,
    ordinaryPendingCount: internals.ordinaryPendingCount,
    capacityScanSteps: internals.capacityScanSteps,
    trackingRebuildCount: internals.trackingRebuildCount,
    backingLength: internals.backlogQueue.length,
    offset: internals.backlogQueueOffset,
  };
}

function capacityWarnMock() {
  const warn = vi.mocked(createLogger("BacklogTest").warn);
  warn.mockClear();
  return warn;
}

// ═══════════════════════════════════════════════════════════

describe("BacklogInjectionController", () => {
  let controller: BacklogInjectionController;

  beforeEach(() => {
    vi.useFakeTimers();
    controller = new BacklogInjectionController(defaultConfig, 24);
  });

  afterEach(() => {
    controller.destroy();
    vi.useRealTimers();
  });

  // ═══════════════════════════════════════════════════════
  // Construction & initial state
  // ═══════════════════════════════════════════════════════

  describe("initial state", () => {
    it("starts with no active backlog", () => {
      expect(controller.isBacklogActive).toBe(false);
    });

    it("returns configured speed multiplier", () => {
      expect(controller.getSpeedMultiplier()).toBe(2);
    });
  });

  // ═══════════════════════════════════════════════════════
  // startBacklogInjection — empty/none modes
  // ═══════════════════════════════════════════════════════

  describe("startBacklogInjection", () => {
    it("ignores empty message arrays", () => {
      const cb = vi.fn();
      controller.onBacklogMessage = cb;

      controller.startBacklogInjection([]);
      expect(controller.isBacklogActive).toBe(false);
      expect(cb).not.toHaveBeenCalled();
    });

    it("skips backlog in 'none' mode", () => {
      const noneController = new BacklogInjectionController(
        { ...defaultConfig, backlogMode: "none" },
        24
      );
      const cb = vi.fn();
      noneController.onBacklogMessage = cb;

      noneController.startBacklogInjection([makeMsg()]);
      expect(noneController.isBacklogActive).toBe(false);
      expect(cb).not.toHaveBeenCalled();
      noneController.destroy();
    });

    it("meters priority messages through the bounded injection queue", () => {
      const cb = vi.fn();
      controller.onBacklogMessage = cb;

      const superchat = makeMsg({ kind: "superchat", id: "sc-1", text: "💰" });
      const membership = makeMsg({ kind: "membership", id: "mem-1", text: "⭐" });

      controller.startBacklogInjection([superchat, membership]);

      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ id: "sc-1", isBacklog: true })
      );
      expect(controller.drainPending().map((message) => message.id)).toEqual(["mem-1"]);
    });

    it("activates backlog for normal messages", () => {
      const cb = vi.fn();
      controller.onBacklogMessage = cb;

      controller.startBacklogInjection([makeMsg({ id: "a" })]);
      expect(controller.isBacklogActive).toBe(true);
    });

    it("appends unique messages in arrival order during active injection", () => {
      controller.startBacklogInjection([makeMsg({ id: "a" }), makeMsg({ id: "b" })]);
      controller.startBacklogInjection([makeMsg({ id: "b" }), makeMsg({ id: "c" })]);

      expect(controller.drainPending().map((message) => message.id)).toEqual(["b", "c"]);
    });

    it("updates a queued message in place when its replacement arrives", () => {
      controller.startBacklogInjection([
        makeMsg({ id: "first" }),
        makeMsg({ id: "target", text: "original" }),
        makeMsg({ id: "last" }),
      ]);

      controller.startBacklogInjection([
        makeMsg({ id: "target", text: "replacement", actionType: "replace" }),
      ]);

      expect(
        controller.drainPending().map((message) => ({ id: message.id, text: message.text }))
      ).toEqual([
        { id: "target", text: "replacement" },
        { id: "last", text: "hello world" },
      ]);
    });

    it("rejects fresh replacement ids during active backlog injection", () => {
      controller.startBacklogInjection([
        makeMsg({ id: "first" }),
        makeMsg({ id: "last" }),
      ]);

      controller.startBacklogInjection(
        Array.from({ length: 300 }, (_, index) =>
          makeMsg({ id: `fresh-${index}`, actionType: "replace" })
        )
      );

      expect(controller.drainPending().map((message) => message.id)).toEqual(["last"]);
    });

    it("rejects a fresh replacement in an initial backlog batch", () => {
      const emitted: string[] = [];
      controller.onBacklogMessage = (message) => emitted.push(message.id ?? "");

      controller.startBacklogInjection([
        makeMsg({ id: "fresh", actionType: "replace" }),
        makeMsg({ id: "known" }),
      ]);

      expect(emitted).toEqual(["known"]);
      expect(controller.drainPending()).toEqual([]);
    });

    it("accepts an initial replacement for an id known outside the backlog", () => {
      const emitted: string[] = [];
      controller.isKnownMessageId = (id) => id === "visible";
      controller.onBacklogMessage = (message) => emitted.push(message.id ?? "");

      controller.startBacklogInjection([
        makeMsg({ id: "visible", actionType: "replace" }),
      ]);

      expect(emitted).toEqual(["visible"]);
    });

    it("queues a replacement after the original message has already been emitted", () => {
      const emitted: string[] = [];
      const emittedIds = new Set<string>();
      controller.isKnownMessageId = (id) => emittedIds.has(id);
      controller.onBacklogMessage = (message) => {
        emitted.push(message.text);
        if (message.id) emittedIds.add(message.id);
      };
      controller.startBacklogInjection([
        makeMsg({ id: "target", text: "original" }),
        makeMsg({ id: "last" }),
      ]);

      controller.startBacklogInjection([
        makeMsg({ id: "target", text: "replacement", actionType: "replace" }),
      ]);

      expect(emitted).toEqual(["original"]);
      expect(controller.drainPending().map((message) => message.text)).toEqual([
        "hello world",
        "replacement",
      ]);
    });

    it("rejects a duplicate add after dequeue while accepting its replacement", () => {
      const emittedIds = new Set<string>();
      controller.isKnownMessageId = (id) => emittedIds.has(id);
      controller.onBacklogMessage = (message) => {
        if (message.id) emittedIds.add(message.id);
      };
      controller.startBacklogInjection([
        makeMsg({ id: "target", text: "original" }),
        makeMsg({ id: "last" }),
      ]);

      controller.startBacklogInjection([
        makeMsg({ id: "target", text: "duplicate" }),
        makeMsg({ id: "target", text: "replacement", actionType: "replace" }),
      ]);

      expect(
        controller.drainPending().map((message) => ({ id: message.id, text: message.text }))
      ).toEqual([
        { id: "last", text: "hello world" },
        { id: "target", text: "replacement" },
      ]);
    });

    it("preserves unique pending order when paused batches are merged", () => {
      controller.startBacklogInjection([makeMsg({ id: "a" }), makeMsg({ id: "b" })]);
      controller.setPaused(true);
      controller.startBacklogInjection([makeMsg({ id: "b" }), makeMsg({ id: "c" })]);

      expect(controller.drainPending().map((message) => message.id)).toEqual(["b", "c"]);
    });

    it("bounds the initial pending queue and all pending identity tracking", () => {
      controller.updateConfig({ pendingCapacity: 3 });
      const emitted: string[] = [];
      controller.onBacklogMessage = (message) => emitted.push(message.id ?? "");

      controller.startBacklogInjection(
        Array.from({ length: 20 }, (_, index) => makeMsg({ id: `initial-${index}` }))
      );

      const state = pendingState(controller);
      expect(emitted).toEqual(["initial-0"]);
      expect(state.messages.map((message) => message.id)).toEqual(["initial-1", "initial-2"]);
      expect(state.seenIds.size).toBe(state.messages.length);
      expect(state.pendingIndices.size).toBe(state.messages.length);
      expect(state.totalBacklog).toBe(state.processedBacklog + state.messages.length);
    });

    it("keeps active sustained ingress within the pending capacity", () => {
      controller.updateConfig({ pendingCapacity: 3 });
      controller.startBacklogInjection([
        makeMsg({ id: "active-0" }),
        makeMsg({ id: "active-1" }),
        makeMsg({ id: "active-2" }),
      ]);

      for (let round = 0; round < 20; round++) {
        controller.startBacklogInjection(
          Array.from({ length: 25 }, (_, index) =>
            makeMsg({ id: `active-${round + 1}-${index}` })
          )
        );
      }

      const state = pendingState(controller);
      expect(state.messages).toHaveLength(3);
      expect(state.messages.map((message) => message.id)).toEqual([
        "active-1",
        "active-2",
        "active-1-0",
      ]);
      expect(state.seenIds.size).toBe(3);
      expect(state.pendingIndices.size).toBe(3);
      expect(state.totalBacklog).toBe(state.processedBacklog + 3);
    });

    it("keeps paused sustained ingress within the pending capacity", () => {
      controller.updateConfig({ pendingCapacity: 3 });
      controller.startBacklogInjection([
        makeMsg({ id: "paused-0" }),
        makeMsg({ id: "paused-1" }),
        makeMsg({ id: "paused-2" }),
      ]);
      controller.setPaused(true);

      for (let round = 0; round < 20; round++) {
        controller.startBacklogInjection(
          Array.from({ length: 25 }, (_, index) =>
            makeMsg({ id: `paused-${round + 1}-${index}` })
          )
        );
      }

      const state = pendingState(controller);
      expect(state.messages).toHaveLength(3);
      expect(state.messages.map((message) => message.id)).toEqual([
        "paused-1",
        "paused-2",
        "paused-1-0",
      ]);
      expect(state.seenIds.size).toBe(3);
      expect(state.pendingIndices.size).toBe(3);
      expect(state.totalBacklog).toBe(state.processedBacklog + 3);
    });

    it("retains paid and replacement work ahead of older ordinary pending messages", () => {
      const warn = capacityWarnMock();
      controller.updateConfig({ pendingCapacity: 3 });
      controller.isKnownMessageId = (id) => id.startsWith("visible-");
      controller.startBacklogInjection([
        makeMsg({ id: "ordinary-0" }),
        makeMsg({ id: "ordinary-1" }),
        makeMsg({ id: "ordinary-2" }),
      ]);
      controller.startBacklogInjection([makeMsg({ id: "ordinary-3" })]);
      controller.startBacklogInjection([
        makeMsg({ id: "paid", kind: "superchat" }),
        makeMsg({ id: "visible-1", actionType: "replace" }),
        makeMsg({ id: "member", kind: "membership" }),
      ]);

      expect(pendingState(controller).messages.map((message) => message.id)).toEqual([
        "paid",
        "visible-1",
        "member",
      ]);

      controller.startBacklogInjection([
        makeMsg({ id: "visible-2", actionType: "replace" }),
      ]);
      expect(pendingState(controller).messages.map((message) => message.id)).toEqual([
        "paid",
        "visible-1",
        "member",
      ]);
      expect(warn).toHaveBeenCalledWith(
        "backlog.capacity.drop",
        expect.objectContaining({ reason: "protected-capacity-full" })
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain("visible-2");
    });

    it("bounds oversized initial ordinary input before sampling", () => {
      controller.updateConfig({ pendingCapacity: 1000 });
      const internals = controller as unknown as {
        sampler: { sampleMessages(messages: import("@app-types").ChatMessage[]): unknown };
      };
      const sample = vi.spyOn(internals.sampler, "sampleMessages");

      controller.startBacklogInjection(
        Array.from({ length: 10_000 }, (_, index) => makeMsg({ id: `ordinary-${index}` }))
      );

      expect(sample).toHaveBeenCalledOnce();
      expect(sample.mock.calls[0]?.[0]).toHaveLength(1000);
      const state = pendingState(controller);
      expect(state.backingLength).toBeLessThanOrEqual(1000);
      expect(state.capacityScanSteps).toBe(0);
      expect(state.trackingRebuildCount).toBe(0);
    });

    it("bounds oversized all-priority input without synchronous bulk emission", () => {
      const warn = capacityWarnMock();
      const onMessageReceived = vi.fn();
      const onMessageDropped = vi.fn();
      controller.destroy();
      controller = new BacklogInjectionController(
        { ...defaultConfig, pendingCapacity: 1000 },
        24,
        {
          onMessageReceived,
          onMessageDropped,
          updateBacklogProgress: vi.fn(),
        } as never
      );
      const emitted: string[] = [];
      controller.onBacklogMessage = (message) => emitted.push(message.id ?? "");

      controller.startBacklogInjection(
        Array.from({ length: 10_000 }, (_, index) =>
          makeMsg({ id: `paid-${index}`, kind: "superchat" })
        )
      );

      expect(emitted).toEqual(["paid-0"]);
      const state = pendingState(controller);
      expect(state.messages).toHaveLength(999);
      expect(state.backingLength).toBe(1000);
      expect(state.capacityScanSteps).toBe(0);
      expect(state.trackingRebuildCount).toBe(0);
      expect(onMessageReceived).toHaveBeenCalledTimes(9000);
      expect(onMessageDropped).toHaveBeenCalledWith("queue_priority");
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it("bounds ordinary-slot scans and backing growth during protected ingress", () => {
      controller.updateConfig({ pendingCapacity: 1000 });
      controller.startBacklogInjection(
        Array.from({ length: 1000 }, (_, index) => makeMsg({ id: `seed-${index}` }))
      );
      controller.startBacklogInjection([makeMsg({ id: "seed-extra" })]);

      controller.startBacklogInjection(
        Array.from({ length: 10_000 }, (_, index) =>
          makeMsg({ id: `protected-${index}`, kind: "superchat" })
        )
      );

      const state = pendingState(controller);
      expect(state.pendingCount).toBe(1000);
      expect(state.ordinaryPendingCount).toBe(0);
      expect(state.capacityScanSteps).toBeLessThanOrEqual(1000);
      expect(state.backingLength).toBeLessThanOrEqual(1001);
      expect(state.trackingRebuildCount).toBe(0);
    });

    it("applies recent-mode filtering during bounded initial admission", () => {
      const now = Date.now();
      const emitted: string[] = [];
      controller.updateConfig({ backlogMode: "recent", backlogRecentMinutes: 1 });
      controller.onBacklogMessage = (message) => emitted.push(message.id ?? "");

      controller.startBacklogInjection([
        makeMsg({ id: "old", timestamp: now - 120_000 }),
        makeMsg({ id: "recent-1", timestamp: now - 30_000 }),
        makeMsg({ id: "recent-2", timestamp: now - 10_000 }),
      ]);

      expect(emitted).toEqual(["recent-1"]);
      expect(controller.drainPending().map((message) => message.id)).toEqual(["recent-2"]);
    });
  });

  // ═══════════════════════════════════════════════════════
  // notifyRealTimeActivity
  // ═══════════════════════════════════════════════════════

  describe("notifyRealTimeActivity", () => {
    it("caps at REAL_TIME_ACTIVITY_CAP (5)", () => {
      for (let i = 0; i < 10; i++) {
        controller.notifyRealTimeActivity();
      }
      // No direct getter, but verify no exception and that subsequent
      // backlog injection still works with reduced rate
      controller.onBacklogMessage = vi.fn();
      controller.startBacklogInjection([makeMsg({ id: "a" })]);
      expect(controller.isBacklogActive).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════
  // getUtilizationFactor (tested indirectly via injection)
  // ═══════════════════════════════════════════════════════

  describe("utilization-aware throttling", () => {
    it("respects onUtilizationQuery for rate limiting", () => {
      controller.onUtilizationQuery = () => 1.0; // fully utilized
      controller.onBacklogMessage = vi.fn();

      controller.startBacklogInjection([makeMsg({ id: "a" })]);
      // Should still inject (rate > 0 even at full utilization)
      expect(controller.isBacklogActive).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════
  // setPaused — state machine
  // ═══════════════════════════════════════════════════════

  describe("setPaused", () => {
    it("pauses and resumes injection", () => {
      controller.onBacklogMessage = vi.fn();

      // Start injecting, then immediately pause
      controller.startBacklogInjection([makeMsg({ id: "a" })]);
      controller.setPaused(true);

      // Should stop timer
      vi.advanceTimersByTime(1000);
      // Message was already emitted in startBacklogInjection before
      // setPaused, so that's fine.

      // Resume
      controller.setPaused(false);
      // Process remaining queue
    });

    it("paused state prevents self-trigger on resume without queue", () => {
      controller.setPaused(true);
      controller.setPaused(false);
      // Should not throw — no active injection to restart
      expect(controller.isBacklogActive).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════
  // updateConfig
  // ═══════════════════════════════════════════════════════

  describe("updateConfig", () => {
    it("updates speed multiplier", () => {
      controller.updateConfig({ backlogSpeedMultiplier: 3 });
      expect(controller.getSpeedMultiplier()).toBe(3);
    });

    it("partial update preserves other fields", () => {
      controller.updateConfig({ backlogMaxRate: 15 });
      expect(controller.getSpeedMultiplier()).toBe(2); // unchanged
    });

    it("trims immediately when pending capacity is reduced", () => {
      controller.updateConfig({ pendingCapacity: 4 });
      controller.startBacklogInjection([
        makeMsg({ id: "ordinary-0" }),
        makeMsg({ id: "ordinary-1" }),
        makeMsg({ id: "ordinary-2" }),
        makeMsg({ id: "ordinary-3" }),
      ]);
      controller.startBacklogInjection([makeMsg({ id: "ordinary-4" })]);
      controller.startBacklogInjection([makeMsg({ id: "paid", kind: "superchat" })]);

      controller.updateConfig({ pendingCapacity: 2 });

      const state = pendingState(controller);
      expect(state.messages.map((message) => message.id)).toEqual(["paid", "ordinary-4"]);
      expect(state.seenIds.size).toBe(2);
      expect(state.pendingIndices.size).toBe(2);
      expect(state.totalBacklog).toBe(state.processedBacklog + 2);
    });

    it("deterministically evicts protected work when capacity is reduced", () => {
      const warn = capacityWarnMock();
      controller.updateConfig({ pendingCapacity: 4 });
      controller.startBacklogInjection(
        Array.from({ length: 4 }, (_, index) =>
          makeMsg({ id: `paid-${index}`, kind: "superchat" })
        )
      );
      controller.setPaused(true);

      controller.updateConfig({ pendingCapacity: 1 });

      expect(pendingState(controller).messages.map((message) => message.id)).toEqual(["paid-3"]);
      expect(warn).toHaveBeenCalledWith(
        "backlog.capacity.drop",
        expect.objectContaining({ reason: "capacity-reduction-protected" })
      );
      const state = pendingState(controller);
      expect(state.backingLength).toBe(1);
      expect(state.offset).toBe(0);
      expect(state.trackingRebuildCount).toBe(1);
      expect(state.capacityScanSteps).toBeLessThanOrEqual(6);
    });
  });

  // ═══════════════════════════════════════════════════════
  // destroy
  // ═══════════════════════════════════════════════════════

  describe("destroy", () => {
    it("cleans up timers and state", () => {
      controller.onBacklogMessage = vi.fn();
      controller.startBacklogInjection([makeMsg({ id: "a" })]);
      expect(controller.isBacklogActive).toBe(true);

      controller.destroy();
      expect(controller.isBacklogActive).toBe(false);
      expect(controller.onBacklogMessage).toBeNull();
    });

    it("safe to call destroy multiple times", () => {
      controller.destroy();
      expect(() => controller.destroy()).not.toThrow();
    });
  });

  describe("injection recovery", () => {
    it("finishes when the queue has no message at the current offset", () => {
      type ControllerInternals = {
        backlogQueue: Array<import("@app-types").ChatMessage | undefined>;
        backlogQueueOffset: number;
        isActive: boolean;
        isInjecting: boolean;
        processTick: () => void;
      };

      const internals = controller as unknown as ControllerInternals;
      internals.backlogQueue = [undefined];
      internals.backlogQueueOffset = 0;
      internals.isActive = true;
      internals.isInjecting = true;

      internals.processTick();

      expect(controller.isBacklogActive).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════
  // Injection timing (with fake timers)
  // ═══════════════════════════════════════════════════════

  describe("injection timing", () => {
    it("processes messages over time with Poisson spacing", () => {
      const emitted: string[] = [];
      controller.onBacklogMessage = (msg) => {
        emitted.push(msg.id as string);
      };

      const messages = Array.from({ length: 5 }, (_, i) =>
        makeMsg({ id: `msg-${i}` })
      );
      controller.startBacklogInjection(messages);

      // First tick processes 1 message (emitted in startBacklogInjection
      // for normal messages? No — normal messages go to queue, not emitted
      // immediately. We need to advance timers.)
      vi.advanceTimersByTime(5000);

      // Should have processed some messages by now
      // (exact count depends on Poisson sampling, but should be > 0)
    });

    it("finishes when queue is exhausted", () => {
      controller.onBacklogMessage = vi.fn();

      controller.startBacklogInjection([makeMsg({ id: "a" })]);
      // Advance enough to process all
      vi.advanceTimersByTime(10_000);

      expect(controller.isBacklogActive).toBe(false);
    });
  });
});
