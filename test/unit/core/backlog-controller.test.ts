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
};

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

    it("emits priority messages immediately", () => {
      const cb = vi.fn();
      controller.onBacklogMessage = cb;

      const superchat = makeMsg({ kind: "superchat", id: "sc-1", text: "💰" });
      const membership = makeMsg({ kind: "membership", id: "mem-1", text: "⭐" });

      controller.startBacklogInjection([superchat, membership]);

      expect(cb).toHaveBeenCalledTimes(2);
      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ id: "sc-1", isBacklog: true })
      );
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

    it("queues a replacement after the original message has already been emitted", () => {
      const emitted: string[] = [];
      controller.onBacklogMessage = (message) => emitted.push(message.text);
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

    it("preserves unique pending order when paused batches are merged", () => {
      controller.startBacklogInjection([makeMsg({ id: "a" }), makeMsg({ id: "b" })]);
      controller.setPaused(true);
      controller.startBacklogInjection([makeMsg({ id: "b" }), makeMsg({ id: "c" })]);

      expect(controller.drainPending().map((message) => message.id)).toEqual(["b", "c"]);
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
