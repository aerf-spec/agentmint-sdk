import { describe, expect, it } from "vitest";
import { loadSpec, parseYaml, resolveAction } from "./spec.js";

const FULL_SPEC = `
version: "1.0"
defaults:
  action: warn
tools:
  issue_refund:
    requires:
      - lookup_order
    action: block
    input:
      properties:
        amount:
          max_ref: lookup_order.output.total
        order_id:
          cross_ref: lookup_order.input.order_id
  run_command:
    input:
      properties:
        command:
          blocked_patterns:
            - "rm -rf"
            - "DROP TABLE"
          action: block
        branch:
          blocked_values: [main, master]
breakers:
  loop:
    max_identical_calls: 3
    action: block
  velocity:
    max_calls_per_window: 10
    window_seconds: 30
  cost:
    max_usd: 5.50
`;

describe("parseYaml", () => {
  it("parses inline lists [a, b, c]", () => {
    expect(parseYaml("vals: [a, b, c]")).toEqual({ vals: ["a", "b", "c"] });
  });

  it("parses empty inline lists", () => {
    expect(parseYaml("vals: []")).toEqual({ vals: [] });
  });

  it("handles double- and single-quoted strings", () => {
    expect(parseYaml('name: "hello world"')).toEqual({ name: "hello world" });
    expect(parseYaml("name: 'hi there'")).toEqual({ name: "hi there" });
  });

  it("strips full-line and inline comments and skips blank lines", () => {
    const parsed = parseYaml("# header comment\nversion: 1\n\nfoo: bar # trailing comment\n");
    expect(parsed).toEqual({ version: 1, foo: "bar" });
  });

  it("parses scalar types (bool, int, float)", () => {
    expect(parseYaml("a: true\nb: 42\nc: 3.14\nd: false")).toEqual({
      a: true,
      b: 42,
      c: 3.14,
      d: false,
    });
  });
});

describe("loadSpec", () => {
  it("loads a complete spec with tools and breakers from string content", () => {
    const spec = loadSpec(FULL_SPEC);
    expect(spec.version).toBe("1.0");
    expect(spec.defaults?.action).toBe("warn");
    expect(spec.tools?.issue_refund?.requires).toEqual(["lookup_order"]);
    expect(spec.tools?.issue_refund?.action).toBe("block");
    expect(spec.tools?.issue_refund?.input?.properties?.amount?.max_ref).toBe(
      "lookup_order.output.total",
    );
    expect(spec.tools?.issue_refund?.input?.properties?.order_id?.cross_ref).toBe(
      "lookup_order.input.order_id",
    );
    expect(spec.breakers?.loop?.max_identical_calls).toBe(3);
    expect(spec.breakers?.velocity?.window_seconds).toBe(30);
    expect(spec.breakers?.cost?.max_usd).toBe(5.5);
  });

  it("parses blocked_patterns (block list) and blocked_values (inline list)", () => {
    const spec = loadSpec(FULL_SPEC);
    const props = spec.tools?.run_command?.input?.properties;
    expect(props?.command?.blocked_patterns).toEqual(["rm -rf", "DROP TABLE"]);
    expect(props?.command?.action).toBe("block");
    expect(props?.branch?.blocked_values).toEqual(["main", "master"]);
  });

  it("rejects a spec missing the version field", () => {
    expect(() => loadSpec("defaults:\n  action: warn\ntools:\n  foo:\n    action: block")).toThrow(
      /version/,
    );
  });
});

describe("resolveAction", () => {
  it("prefers the property action over everything else", () => {
    expect(resolveAction("warn", "block", "block", "block")).toBe("warn");
  });

  it("falls back to the tool action when property action is absent", () => {
    expect(resolveAction(undefined, "block", "warn", "warn")).toBe("block");
  });

  it("falls back to the global default when property and tool are absent", () => {
    expect(resolveAction(undefined, undefined, "block", "warn")).toBe("block");
  });

  it("falls back to the category default when nothing is specified", () => {
    expect(resolveAction(undefined, undefined, undefined, "warn")).toBe("warn");
  });
});
