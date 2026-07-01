import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  verify,
  demoReceipt,
  formatVerifyReceipt,
  formatVerifyJSONL,
  type VerifyReceipt,
} from "./verify.js";
import { parseJSONL } from "./jsonl.js";

const tmpDirs: string[] = [];

function makeDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "amverify-"));
  tmpDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf-8");
  }
  return dir;
}

function specFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "amspec-"));
  tmpDirs.push(dir);
  const p = join(dir, "agentmint.spec.yaml");
  writeFileSync(p, content, "utf-8");
  return p;
}

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("verify — spec-derived checks", () => {
  it("1. requires with missing prerequisite → claim failed", async () => {
    const dir = makeDir({
      "tools.ts": `export async function issue_refund(o) { return o; }`,
    });
    const spec = specFile(`
version: "1.0"
tools:
  issue_refund:
    requires: [lookup_order]
`);
    const receipt = await verify({ dir, spec });
    const requires = receipt.claims.find((c) => c.id.startsWith("requires"));
    expect(requires?.status).toBe("failed");
    expect(receipt.summary.failed).toBe(1);
  });

  it("2. blocked_patterns match in source → claim blocked", async () => {
    const dir = makeDir({
      "tools.ts": `export async function notify(o) { return "ceo@competitor.com"; }`,
    });
    const spec = specFile(`
version: "1.0"
tools:
  notify:
    input:
      properties:
        to:
          blocked_patterns: ["*@competitor.com"]
`);
    const receipt = await verify({ dir, spec });
    const claim = receipt.claims.find((c) => c.id.startsWith("blocked_pattern"));
    expect(claim?.status).toBe("blocked");
    expect(receipt.summary.blocked).toBe(1);
  });

  it("3. clean code and spec → all claims verified", async () => {
    const dir = makeDir({
      "tools.ts": `
export async function lookup_order(id) { return { total: 10 }; }
export async function issue_refund(o) { return o; }
`,
    });
    const spec = specFile(`
version: "1.0"
tools:
  issue_refund:
    requires: [lookup_order]
    input:
      properties:
        reason:
          blocked_patterns: ["*@competitor.com"]
          blocked_values: ["FRAUD"]
`);
    const receipt = await verify({ dir, spec });
    expect(receipt.claims.length).toBeGreaterThan(0);
    expect(receipt.claims.every((c) => c.status === "verified")).toBe(true);
    expect(receipt.summary.failed).toBe(0);
    expect(receipt.summary.blocked).toBe(0);
  });

  it("12. blocked_values exact match in source → claim blocked", async () => {
    const dir = makeDir({
      "tools.ts": `export async function set_flag(o) { return "OVERRIDE"; }`,
    });
    const spec = specFile(`
version: "1.0"
tools:
  set_flag:
    input:
      properties:
        value:
          blocked_values: ["OVERRIDE"]
`);
    const receipt = await verify({ dir, spec });
    const claim = receipt.claims.find((c) => c.id.startsWith("blocked_value"));
    expect(claim?.status).toBe("blocked");
    expect(claim?.evidence).toContain("OVERRIDE");
  });
});

describe("verify — heuristics", () => {
  it("4. no spec → only heuristic-source claims", async () => {
    const dir = makeDir({
      "tools.ts": `
export async function delete_user(id) { return id; }
export async function git_push(b) { return "main"; }
`,
    });
    const receipt = await verify({ dir });
    expect(receipt.claims.length).toBeGreaterThan(0);
    expect(receipt.claims.every((c) => c.source === "heuristic")).toBe(true);
    expect(receipt.scope.risky_actions).toContain("delete_user");
    expect(receipt.scope.risky_actions).toContain("git_push");
  });

  it("6. missing context → risky claims are unverified, not failed", async () => {
    const dir = makeDir({
      "tools.ts": `export async function delete_account(id) { return id; }`,
    });
    const receipt = await verify({ dir });
    expect(receipt.summary.failed).toBe(0);
    const risky = receipt.claims.find((c) => c.description.includes("delete_account"));
    expect(risky?.status).toBe("unverified");
  });
});

describe("verify — scope", () => {
  it("5. diff scopes to changed files only", async () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -0,0 +1,2 @@
+export async function foo() { return 1; }
+export async function bar() { return 2; }
`;
    const receipt = await verify({ diff });
    expect(receipt.scope.files_changed).toBe(1);
    expect(receipt.scope.tools_found).toBe(2);
  });

  it("11. empty dir → zero claims, no crash", async () => {
    const dir = makeDir({});
    const receipt = await verify({ dir });
    expect(receipt.claims).toEqual([]);
    expect(receipt.scope.files_changed).toBe(0);
    expect(receipt.summary.needs_review).toEqual([]);
    expect(receipt.hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("verify — receipt", () => {
  it("7. receipt includes a SHA-256 hash", async () => {
    const dir = makeDir({ "tools.ts": `export async function foo() {}` });
    const receipt = await verify({ dir });
    expect(receipt.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("8. formatVerifyReceipt renders a terminal box", () => {
    const receipt = demoReceipt();
    const out = formatVerifyReceipt(receipt);
    expect(out).toContain("┌");
    expect(out).toContain("┐");
    expect(out).toContain("└");
    expect(out).toContain("┘");
    expect(out).toContain("Verify");
    expect(out).toContain("verified");
  });

  it("9. demo produces the expected receipt shape", () => {
    const receipt: VerifyReceipt = demoReceipt();
    expect(receipt.summary.verified).toBe(5);
    expect(receipt.summary.failed).toBe(1);
    expect(receipt.summary.unverified).toBe(2);
    expect(receipt.summary.blocked).toBe(1);
  });

  it("10. JSONL output is valid and parseable", () => {
    const receipt = demoReceipt();
    const jsonl = formatVerifyJSONL(receipt);
    const events = parseJSONL(jsonl);
    // one event per claim + one summary event
    expect(events.length).toBe(receipt.claims.length + 1);
    expect(events.every((e) => typeof e.tool === "string")).toBe(true);
    expect(events.some((e) => e.tool === "verify:summary")).toBe(true);
  });

  it("schema-dir type constraints produce schema-source claims", async () => {
    const dir = makeDir({ "tools.ts": `export async function foo() {}` });
    const schemaDir = makeDir({
      "types.ts": `export interface Order { id: string; total: number; }`,
    });
    const receipt = await verify({ dir, schemaDir });
    expect(receipt.claims.some((c) => c.source === "schema")).toBe(true);
  });
});
