import { describe, expect, it } from "vitest";
import {
  checkRequires,
  matchPattern,
  validateInputCrossRefs,
  validateOutputCrossRefs,
} from "./cross-ref.js";
import { createSession, recordInput, recordOutput } from "./session.js";
import type { AgentMintSpec } from "./types.js";

function specWith(properties: AgentMintSpec["tools"]): AgentMintSpec {
  return { version: "1.0", tools: properties };
}

describe("cross_ref validation", () => {
  const spec = specWith({
    issue_refund: {
      input: { properties: { order_id: { cross_ref: "lookup_order.input.order_id" } } },
    },
  });

  it("passes when the referenced value matches", () => {
    const s = createSession();
    recordInput(s, "lookup_order", { order_id: "ORD-1" });
    const v = validateInputCrossRefs("issue_refund", { order_id: "ORD-1" }, spec, s);
    expect(v).toHaveLength(0);
  });

  it("detects a mismatch", () => {
    const s = createSession();
    recordInput(s, "lookup_order", { order_id: "ORD-1" });
    const v = validateInputCrossRefs("issue_refund", { order_id: "ORD-9" }, spec, s);
    expect(v).toHaveLength(1);
    expect(v[0]!.type).toBe("cross_ref");
    expect(v[0]!.expected).toBe("ORD-1");
    expect(v[0]!.actual).toBe("ORD-9");
  });
});

describe("max_ref validation", () => {
  const spec = specWith({
    issue_refund: {
      input: { properties: { amount: { max_ref: "lookup_order.output.total" } } },
    },
  });

  it("passes when value is under the referenced max", () => {
    const s = createSession();
    recordOutput(s, "lookup_order", { total: 50 });
    expect(validateInputCrossRefs("issue_refund", { amount: 30 }, spec, s)).toHaveLength(0);
  });

  it("flags when value exceeds the referenced max", () => {
    const s = createSession();
    recordOutput(s, "lookup_order", { total: 50 });
    const v = validateInputCrossRefs("issue_refund", { amount: 75 }, spec, s);
    expect(v).toHaveLength(1);
    expect(v[0]!.type).toBe("max_ref");
  });
});

describe("matchPattern (glob support)", () => {
  it("matches a leading wildcard", () => {
    expect(matchPattern("ceo@competitor.com", "*@competitor.com")).toBe(true);
  });

  it("matches a leading wildcard for any prefix", () => {
    expect(matchPattern("anyone@competitor.com", "*@competitor.com")).toBe(true);
  });

  it("does not match a different suffix", () => {
    expect(matchPattern("ceo@partner.com", "*@competitor.com")).toBe(false);
  });

  it("treats a pattern without `*` as a substring match", () => {
    expect(matchPattern("rm -rf /tmp", "rm -rf")).toBe(true);
  });

  it("matches `*.env` against a bare `.env`", () => {
    expect(matchPattern(".env", "*.env")).toBe(true);
  });

  it("matches `*.env` against a nested path", () => {
    expect(matchPattern("path/to/.env", "*.env")).toBe(true);
  });

  it("anchors the glob so `*.env` does NOT match `.environment`", () => {
    // Full-string match: `*` consumes any prefix but the value must END in `.env`.
    expect(matchPattern(".environment", "*.env")).toBe(false);
  });

  it("still works as a plain substring when there is no `*`", () => {
    expect(matchPattern("hello world", "lo wo")).toBe(true);
  });

  it("never matches an empty pattern", () => {
    expect(matchPattern("anything", "")).toBe(false);
  });

  it("never matches an empty value", () => {
    expect(matchPattern("", "*@competitor.com")).toBe(false);
  });

  it("flags a wildcard pattern inside blocked_patterns validation", () => {
    const spec = specWith({
      send_email: {
        input: { properties: { to: { blocked_patterns: ["*@competitor.com"], action: "block" } } },
      },
    });
    const s = createSession();
    const v = validateInputCrossRefs("send_email", { to: "ceo@competitor.com" }, spec, s);
    expect(v).toHaveLength(1);
    expect(v[0]!.type).toBe("blocked_pattern");
    expect(v[0]!.action).toBe("block");
  });

  it("passes a value that does not match the wildcard pattern", () => {
    const spec = specWith({
      send_email: {
        input: { properties: { to: { blocked_patterns: ["*@competitor.com"] } } },
      },
    });
    const s = createSession();
    expect(
      validateInputCrossRefs("send_email", { to: "ceo@partner.com" }, spec, s),
    ).toHaveLength(0);
  });
});

describe("blocked_patterns validation", () => {
  const spec = specWith({
    run_command: {
      input: { properties: { command: { blocked_patterns: ["rm -rf"], action: "block" } } },
    },
  });

  it("flags a substring match", () => {
    const s = createSession();
    const v = validateInputCrossRefs("run_command", { command: "rm -rf /tmp" }, spec, s);
    expect(v).toHaveLength(1);
    expect(v[0]!.type).toBe("blocked_pattern");
    expect(v[0]!.action).toBe("block");
  });

  it("passes a clean command", () => {
    const s = createSession();
    expect(validateInputCrossRefs("run_command", { command: "ls -la" }, spec, s)).toHaveLength(0);
  });
});

describe("blocked_values validation", () => {
  const spec = specWith({
    git_push: {
      input: { properties: { branch: { blocked_values: ["main", "master"], action: "block" } } },
    },
  });

  it("flags an exact blocked value", () => {
    const s = createSession();
    const v = validateInputCrossRefs("git_push", { branch: "main" }, spec, s);
    expect(v).toHaveLength(1);
    expect(v[0]!.type).toBe("blocked_value");
  });

  it("passes a non-blocked value", () => {
    const s = createSession();
    expect(validateInputCrossRefs("git_push", { branch: "feature/x" }, spec, s)).toHaveLength(0);
  });
});

describe("checkRequires", () => {
  const spec = specWith({
    issue_refund: { requires: ["lookup_order"], action: "block" },
  });

  it("passes when the prerequisite step is completed", () => {
    expect(checkRequires("issue_refund", spec, new Set(["lookup_order"]))).toHaveLength(0);
  });

  it("flags a missing prerequisite as a block-level violation", () => {
    const v = checkRequires("issue_refund", spec, new Set<string>());
    expect(v).toHaveLength(1);
    expect(v[0]!.type).toBe("requires");
    expect(v[0]!.action).toBe("block");
  });
});

describe("action cascade", () => {
  it("uses the global default when no tool/property action is set", () => {
    const spec: AgentMintSpec = {
      version: "1.0",
      defaults: { action: "block" },
      tools: {
        issue_refund: {
          input: { properties: { order_id: { cross_ref: "lookup_order.input.order_id" } } },
        },
      },
    };
    const s = createSession();
    recordInput(s, "lookup_order", { order_id: "ORD-1" });
    const v = validateInputCrossRefs("issue_refund", { order_id: "ORD-9" }, spec, s);
    expect(v[0]!.action).toBe("block");
  });

  it("lets a property action override the global default", () => {
    const spec: AgentMintSpec = {
      version: "1.0",
      defaults: { action: "block" },
      tools: {
        issue_refund: {
          input: {
            properties: { order_id: { cross_ref: "lookup_order.input.order_id", action: "warn" } },
          },
        },
      },
    };
    const s = createSession();
    recordInput(s, "lookup_order", { order_id: "ORD-1" });
    const v = validateInputCrossRefs("issue_refund", { order_id: "ORD-9" }, spec, s);
    expect(v[0]!.action).toBe("warn");
  });

  it("defaults cross-ref violations to warn when nothing is configured", () => {
    const spec = specWith({
      issue_refund: {
        input: { properties: { order_id: { cross_ref: "lookup_order.input.order_id" } } },
      },
    });
    const s = createSession();
    recordInput(s, "lookup_order", { order_id: "ORD-1" });
    const v = validateInputCrossRefs("issue_refund", { order_id: "ORD-9" }, spec, s);
    expect(v[0]!.action).toBe("warn");
  });
});

describe("multiple violations from one call", () => {
  it("reports every violating property", () => {
    const spec = specWith({
      issue_refund: {
        input: {
          properties: {
            order_id: { cross_ref: "lookup_order.input.order_id" },
            amount: { max_ref: "lookup_order.output.total" },
          },
        },
      },
    });
    const s = createSession();
    recordInput(s, "lookup_order", { order_id: "ORD-1" });
    recordOutput(s, "lookup_order", { total: 50 });
    const v = validateInputCrossRefs(
      "issue_refund",
      { order_id: "ORD-9", amount: 999 },
      spec,
      s,
    );
    expect(v).toHaveLength(2);
    expect(v.map((x) => x.type).sort()).toEqual(["cross_ref", "max_ref"]);
  });
});

describe("output cross-ref validation", () => {
  const spec = specWith({
    issue_refund: {
      output: { properties: { amount: { cross_ref: "input.amount" } } },
    },
  });

  it("passes when output matches the current input", () => {
    const s = createSession();
    recordInput(s, "issue_refund", { amount: 30 });
    expect(validateOutputCrossRefs("issue_refund", { amount: 30 }, spec, s)).toHaveLength(0);
  });

  it("flags when output diverges from the current input", () => {
    const s = createSession();
    recordInput(s, "issue_refund", { amount: 30 });
    const v = validateOutputCrossRefs("issue_refund", { amount: 999 }, spec, s);
    expect(v).toHaveLength(1);
    expect(v[0]!.type).toBe("cross_ref");
  });
});
