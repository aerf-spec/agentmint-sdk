import { describe, expect, it } from "vitest";
import {
  createSession,
  hashArgs,
  recordInput,
  recordOutput,
  resolveRef,
} from "./session.js";

describe("session store", () => {
  it("recordInput stores params and overwrites on repeat", () => {
    const s = createSession();
    recordInput(s, "lookup_order", { order_id: "ORD-1" });
    expect(s.inputs.get("lookup_order")).toEqual({ order_id: "ORD-1" });

    recordInput(s, "lookup_order", { order_id: "ORD-2" });
    expect(s.inputs.get("lookup_order")).toEqual({ order_id: "ORD-2" });
  });

  it("recordOutput stores output and overwrites on repeat", () => {
    const s = createSession();
    recordOutput(s, "lookup_order", { total: 10 });
    expect(s.outputs.get("lookup_order")).toEqual({ total: 10 });

    recordOutput(s, "lookup_order", { total: 20 });
    expect(s.outputs.get("lookup_order")).toEqual({ total: 20 });
  });

  it("callHistory grows by one per recorded input", () => {
    const s = createSession();
    expect(s.callHistory).toHaveLength(0);
    recordInput(s, "a", { x: 1 });
    recordInput(s, "a", { x: 1 });
    recordInput(s, "b", { y: 2 });
    expect(s.callHistory).toHaveLength(3);
    expect(s.callHistory[0]!.tool).toBe("a");
    expect(s.callHistory[2]!.tool).toBe("b");
  });

  describe("resolveRef", () => {
    it("resolves tool.input.field", () => {
      const s = createSession();
      recordInput(s, "lookup_order", { order_id: "ORD-1" });
      expect(resolveRef(s, "lookup_order.input.order_id")).toEqual({
        found: true,
        value: "ORD-1",
      });
    });

    it("resolves a nested tool.output.nested.field path", () => {
      const s = createSession();
      recordOutput(s, "lookup_order", { customer: { id: "CUST-1", tier: "gold" } });
      expect(resolveRef(s, "lookup_order.output.customer.tier")).toEqual({
        found: true,
        value: "gold",
      });
    });

    it("returns not-found for a missing tool", () => {
      const s = createSession();
      expect(resolveRef(s, "never_called.input.order_id")).toEqual({
        found: false,
        value: undefined,
      });
    });

    it("returns not-found when walking through a missing field", () => {
      const s = createSession();
      recordOutput(s, "lookup_order", { total: 10 });
      // 'customer' does not exist, so descending into '.id' cannot resolve
      expect(resolveRef(s, "lookup_order.output.customer.id")).toEqual({
        found: false,
        value: undefined,
      });
    });

    it("returns not-found for a malformed (too short) ref", () => {
      const s = createSession();
      expect(resolveRef(s, "lookup_order.input").found).toBe(false);
    });
  });

  describe("hashArgs", () => {
    it("is consistent for identical args", () => {
      expect(hashArgs("tool", { a: 1, b: 2 })).toBe(hashArgs("tool", { a: 1, b: 2 }));
    });

    it("is independent of key order", () => {
      expect(hashArgs("tool", { a: 1, b: 2 })).toBe(hashArgs("tool", { b: 2, a: 1 }));
    });

    it("differs by tool name and by args", () => {
      expect(hashArgs("a", { x: 1 })).not.toBe(hashArgs("b", { x: 1 }));
      expect(hashArgs("a", { x: 1 })).not.toBe(hashArgs("a", { x: 2 }));
    });
  });
});
