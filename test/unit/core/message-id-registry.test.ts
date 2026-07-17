import { describe, expect, it } from "vitest";
import { createMessageIdRegistry } from "@util/message-id-registry";

describe("MessageIdRegistry", () => {
  // ═══════════════════════════════════════════════════════════
  // Basic operations
  // ═══════════════════════════════════════════════════════════

  it("returns false for unknown IDs", () => {
    const registry = createMessageIdRegistry(100);
    expect(registry.has("msg-1")).toBe(false);
  });

  it("returns true for marked IDs", () => {
    const registry = createMessageIdRegistry(100);
    registry.mark("msg-1");
    expect(registry.has("msg-1")).toBe(true);
  });

  it("tracks multiple IDs independently", () => {
    const registry = createMessageIdRegistry(100);
    registry.mark("msg-1");
    registry.mark("msg-2");

    expect(registry.has("msg-1")).toBe(true);
    expect(registry.has("msg-2")).toBe(true);
    expect(registry.has("msg-3")).toBe(false);
  });

  it("re-marking is idempotent", () => {
    const registry = createMessageIdRegistry(100);
    registry.mark("msg-1");
    registry.mark("msg-1");
    registry.mark("msg-1");

    expect(registry.has("msg-1")).toBe(true);
  });

  // ═══════════════════════════════════════════════════════════
  // FIFO eviction
  // ═══════════════════════════════════════════════════════════

  it("evicts oldest entry when exceeding maxSize", () => {
    const registry = createMessageIdRegistry(2);

    registry.mark("a");
    registry.mark("b");
    registry.mark("c"); // should evict oldest ("a"), keep "b" and "c"

    expect(registry.has("a")).toBe(false);
    expect(registry.has("b")).toBe(true);
    expect(registry.has("c")).toBe(true);
  });

  it("evicts multiple excess entries at once", () => {
    const registry = createMessageIdRegistry(3);

    registry.mark("a");
    registry.mark("b");
    registry.mark("c");
    registry.mark("d");
    registry.mark("e"); // after this, should only have "c", "d", "e"

    expect(registry.has("a")).toBe(false);
    expect(registry.has("b")).toBe(false);
    expect(registry.has("c")).toBe(true);
    expect(registry.has("d")).toBe(true);
    expect(registry.has("e")).toBe(true);
  });

  it("handles size 1 correctly", () => {
    const registry = createMessageIdRegistry(1);

    registry.mark("a");
    expect(registry.has("a")).toBe(true);

    registry.mark("b");
    expect(registry.has("a")).toBe(false);
    expect(registry.has("b")).toBe(true);
  });
});
