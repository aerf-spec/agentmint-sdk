// Cross-producer canonicalization check: assert that canonicalize() produces
// byte-identical output to Python's json.dumps(sort_keys=True,
// separators=(",",":")) for ASCII/integer/nested fixtures. Skips gracefully if
// python3 is unavailable.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { canonicalize } from "../src/kernel/canonical.js";

function pythonAvailable(): boolean {
  const r = spawnSync("python3", ["--version"], { encoding: "utf-8" });
  return r.status === 0;
}

function pythonCanonical(obj: unknown): string {
  const r = spawnSync(
    "python3",
    ["-c", "import json,sys;print(json.dumps(json.load(sys.stdin),sort_keys=True,separators=(',',':')),end='')"],
    { input: JSON.stringify(obj), encoding: "utf-8" },
  );
  if (r.status !== 0) throw new Error(`python3 failed: ${r.stderr}`);
  return r.stdout;
}

const fixtures: Record<string, unknown> = {
  "pure ASCII": {
    z: "last",
    a: "first",
    m: "middle",
    action: "submit:claim:CLM-9920",
    in_policy: true,
    policy_reason: "matched scope submit:claim:*",
  },
  integers: {
    seq: 3,
    amount_micros: 1250000000,
    zero: 0,
    negative: -42,
    big: 9007199254740991,
    nested_ints: [1, 2, 3, 0],
  },
  nested: {
    id: "7473e179",
    evidence: {
      tool: "submit-claim",
      claim_id: "CLM-9920",
      controls: ["E015", "D003", "B001"],
      meta: { a: 1, b: { c: 2, d: [true, false, null] } },
    },
    trajectory: [
      { action: "a", ok: true },
      { action: "b", ok: false },
    ],
  },
};

describe("cross-producer canonicalization (vs python3 json.dumps)", () => {
  const have = pythonAvailable();
  for (const [name, obj] of Object.entries(fixtures)) {
    it.skipIf(!have)(`${name} is byte-identical to python3`, () => {
      expect(canonicalize(obj)).toBe(pythonCanonical(obj));
    });
  }

  it("reports if python3 was unavailable", () => {
    if (!have) {
      // Not a failure — the cross-check is best-effort per the task.
      console.warn("python3 not found; cross-producer byte-equality checks skipped");
    }
    expect(true).toBe(true);
  });
});
