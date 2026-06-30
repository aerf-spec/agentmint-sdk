import { describe, expect, it } from "vitest";
import { eventToJSONL, formatJSONL, parseJSONL } from "./jsonl.js";
import type { Event } from "./types.js";

function makeEvent(over: Partial<Event> = {}): Event {
  return {
    timestamp: "2026-01-01T00:00:00.000Z",
    elapsed: "0.1s",
    tool: "lookup_order",
    params: { order_id: "ORD-1" },
    result: "allowed",
    durationMs: 5,
    ...over,
  };
}

describe("eventToJSONL", () => {
  it("maps an event to a JSONL record with runId and drops elapsed", () => {
    const json = eventToJSONL(makeEvent(), "amr_abc");
    expect(json).toEqual({
      timestamp: "2026-01-01T00:00:00.000Z",
      runId: "amr_abc",
      tool: "lookup_order",
      result: "allowed",
      params: { order_id: "ORD-1" },
      durationMs: 5,
    });
    expect(json).not.toHaveProperty("elapsed");
  });

  it("omits empty params and undefined optional fields", () => {
    const json = eventToJSONL(
      makeEvent({ params: {}, durationMs: undefined }),
      "amr_abc",
    );
    expect(json).not.toHaveProperty("params");
    expect(json).not.toHaveProperty("durationMs");
    expect(json).not.toHaveProperty("reason");
  });

  it("includes reason and details when present", () => {
    const json = eventToJSONL(
      makeEvent({ result: "warned", reason: "cross_ref", details: "mismatch" }),
      "amr_abc",
    );
    expect(json.reason).toBe("cross_ref");
    expect(json.details).toBe("mismatch");
  });
});

describe("formatJSONL", () => {
  it("produces one valid JSON object per line", () => {
    const out = formatJSONL([makeEvent(), makeEvent({ tool: "issue_refund" })], "amr_x");
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

describe("parseJSONL", () => {
  it("round-trips through formatJSONL", () => {
    const events = [makeEvent(), makeEvent({ tool: "issue_refund", result: "blocked", reason: "denied" })];
    const parsed = parseJSONL(formatJSONL(events, "amr_x"));
    expect(parsed).toEqual([
      eventToJSONL(events[0]!, "amr_x"),
      eventToJSONL(events[1]!, "amr_x"),
    ]);
  });

  it("ignores empty and whitespace-only lines", () => {
    const body = formatJSONL([makeEvent(), makeEvent()], "amr_x");
    const parsed = parseJSONL(`${body}\n\n   \n`);
    expect(parsed).toHaveLength(2);
  });
});
