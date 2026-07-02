// Demo flows as tests (Gate 3). Exercises the exact scripted session both
// demos print, asserting the story holds: a valid signed chain, tamper caught
// by signature, and a deleted decision caught by the broken hash link.
import { describe, it, expect } from "vitest";
import { runDemoSession } from "../examples/demos/session.js";
import { verifyDecisionReceipts } from "../src/receipt-decision.js";

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
