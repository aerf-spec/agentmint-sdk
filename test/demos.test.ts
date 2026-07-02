// Demo flows as tests (Gate 3). Exercises the exact scripted session both
// demos print, asserting the story holds: a valid signed chain, tamper caught
// by signature, and a deleted decision caught by the broken hash link.
import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDemoSession } from "../examples/demos/session.js";
import { verifyDecisionReceipts } from "../src/receipt-decision.js";
import { harden } from "../src/experimental/harden.js";
import { loadSpecFromFile } from "../src/kernel/spec.js";
import { generateKeyPair, privateKeyToPem } from "../src/kernel/sign.js";
import type { AgentMintConfig, DecisionInfo } from "../src/types.js";

describe("demo flows", () => {
  it("produces the 5-decision scripted session with a valid chain", async () => {
    const { receipts, publicKeyPem, specHash } = await runDemoSession();

    expect(receipts.map((r) => [r.action, r.in_policy])).toEqual([
      ["lookup_customer", true],
      ["transfer_funds", false],
      ["generate_report", true],
      ["generate_report", false], // budget kill
      ["exfiltrate", false], // attempted after kill
    ]);
    expect(receipts[3]!.policy_reason).toMatch(/budget_exceeded/);
    expect(receipts[4]!.policy_reason).toMatch(/run_killed/);
    // spec-derived hash present and shared by every receipt.
    expect(specHash).toBeTruthy();
    for (const r of receipts) expect(r.spec_hash).toBe(specHash);

    expect(verifyDecisionReceipts(receipts, publicKeyPem)).toEqual({ ok: true });
  });

  it("tamper demo: flipping receipt 2's action breaks the signature at index 1", async () => {
    const { receipts, publicKeyPem } = await runDemoSession();
    receipts[1]!.action = "X" + receipts[1]!.action.slice(1);

    const result = verifyDecisionReceipts(receipts, publicKeyPem);
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(1);
    expect(result.reason).toMatch(/signature/i);
  });

  it("silence demo: deleting the DENY receipt breaks the chain at index 1", async () => {
    const { receipts, publicKeyPem } = await runDemoSession();
    const denyIdx = receipts.findIndex((r) => r.action === "transfer_funds");
    expect(denyIdx).toBe(1);

    const withHole = [...receipts];
    withHole.splice(denyIdx, 1);

    const result = verifyDecisionReceipts(withHole, publicKeyPem);
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(1);
    expect(result.reason).toMatch(/deleted|prev_hash|missing/i);
    expect(result.reason).toMatch(/Logs can omit; chains cannot/);
  });
});

describe("trace demo — real onDecision gate internals", () => {
  const specPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "../examples/demos/trace-spec.yaml",
  );
  const ok = {
    lookup_customer: async () => ({ name: "Kenji Tanaka", balance: 4200 }),
    transfer_funds: async (p: Record<string, unknown>) => ({ ok: true, transferred: p.amount }),
    delete_audit_log: async () => ({ deleted: 147 }),
    generate_report: async () => ({ report: "Q2 summary: 14 transactions..." }),
  };

  async function run(): Promise<DecisionInfo[]> {
    const spec = loadSpecFromFile(specPath);
    const { privateKey } = generateKeyPair();
    const decisions: DecisionInfo[] = [];
    const tools = harden(ok, {
      spec,
      allow: Object.keys(spec.tools ?? {}),
      signing: { privateKeyPem: privateKeyToPem(privateKey) },
      onDecision: (info) => decisions.push(info),
    } as AgentMintConfig);
    await tools.lookup_customer({ id: "cust_8829" });
    await tools.transfer_funds({ from: "cust_8829", to: "cust_0012", amount: 5000 });
    await tools.transfer_funds({ from: "cust_8829", to: "cust_0012", amount: 5000 });
    await tools.delete_audit_log({ all: true });
    await tools.generate_report({ type: "summary" });
    return decisions;
  }

  it("surfaces the real verdicts the engine reached", async () => {
    const d = await run();
    expect(d.map((x) => [x.tool, x.verdict, x.reason])).toEqual([
      ["lookup_customer", "allow", undefined],
      ["transfer_funds", "deny", "max_ref"],
      ["transfer_funds", "deny", "loop_breaker"],
      ["delete_audit_log", "deny", "action_block"],
      ["generate_report", "allow", undefined],
    ]);
  });

  it("reports the real check details from engine state", async () => {
    const d = await run();
    const detail = (i: number, name: string) => d[i]!.checks.find((c) => c.name === name)?.detail;

    // Real values: balance from the lookup result, amount from params, costs from spec.
    expect(detail(0, "budget?")).toBe("$0.10 / $2.00");
    expect(detail(1, "requires?")).toBe("lookup_customer (satisfied)");
    expect(detail(1, "input check?")).toBe("amount 5000 > balance 4200 (cross_ref: max_ref)");
    expect(detail(2, "loop check?")).toBe("2 identical calls (limit: 2)");
    expect(detail(3, "deny list?")).toBe("yes (action: block)");
    expect(detail(4, "budget?")).toBe("$0.80 / $2.00");
  });
});
