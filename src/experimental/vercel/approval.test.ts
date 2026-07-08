import { Readable } from "node:stream";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { withAgentMint } from "./index.js";
import { parseJSONL } from "../../jsonl.js";
import type { VercelApprovalArgs, VercelToolCallOptions } from "./types.js";

// A console-gate driver: feed a canned response ("y" / "n" / a reason) on stdin
// and swallow the rendered prompt.
const cannedInput = (response: string): Readable => Readable.from([`${response}\n`]);
const sink = (): Writable =>
  new Writable({ write(_c, _e, cb) { cb(); } });

const approvalArgs = (
  toolName: string,
  input: Record<string, unknown>,
  toolCallId = "call_1",
): VercelApprovalArgs => ({ toolCall: { toolName, toolCallId, input } });

describe("gate() ↔ toolApproval bridge", () => {
  it("approve → tool executes → gate event precedes tool event, hashes linked", async () => {
    const am = withAgentMint();
    const approve = am.toolApproval(
      { tools: ["issue_refund"] },
      { input: cannedInput("y"), output: sink() },
    );

    const status = await approve(approvalArgs("issue_refund", { amount: 42 }, "c_ok"));
    expect(status).toBe("approved");

    // The SDK would now run execute(); simulate that.
    const tools = am.tools({
      issue_refund: {
        execute: async (input: { amount: number }, _o?: VercelToolCallOptions) => ({
          refunded: input.amount,
        }),
      },
    });
    await tools.issue_refund.execute!({ amount: 42 }, { toolCallId: "c_ok" });

    const receipt = am.receipt();
    const results = receipt.events.map((e) => e.result);
    // held (approval requested) → approved (gate) → allowed (tool)
    expect(results).toEqual(["held", "approved", "allowed"]);

    const approved = receipt.events[1]!;
    const executed = receipt.events[2]!;
    expect(approved.reason).toBe("gate_approved");
    expect(approved.details).toMatch(/gate:[0-9a-f]{16}…/); // linked gate hash
    expect(approved.callRef).toBe("c_ok");
    expect(executed.tool).toBe("issue_refund");
    expect(executed.callRef).toBe("c_ok");
  });

  it("deny → tool does not execute, receipt shows the denial", async () => {
    const am = withAgentMint();
    const approve = am.toolApproval(
      { tools: ["issue_refund"] },
      { input: cannedInput("n"), output: sink() },
    );

    const status = await approve(approvalArgs("issue_refund", { amount: 999 }, "c_no"));
    expect(status).toMatchObject({ type: "denied" });

    // The SDK would NOT call execute() on a denial — so we don't.
    const receipt = am.receipt();
    expect(receipt.events.map((e) => e.result)).toEqual(["held", "rejected"]);
    expect(receipt.events[1]!.reason).toBe("gate_rejected");
    expect(receipt.summary.blocked).toBe(1);
    expect(receipt.summary.executed).toBe(0);
  });

  it("passes a rejection reason through to the approval status", async () => {
    const am = withAgentMint();
    const approve = am.toolApproval(
      { tools: ["wire_funds"] },
      { input: cannedInput("amount too high"), output: sink() },
    );
    const status = await approve(approvalArgs("wire_funds", { amount: 1e6 }));
    expect(status).toMatchObject({ type: "denied" });
    expect((status as { reason: string }).reason).toContain("amount too high");
  });

  it("leaves out-of-scope tools not-applicable (no gate, no event)", async () => {
    const am = withAgentMint();
    const approve = am.toolApproval({ tools: ["issue_refund"] });
    const status = await approve(approvalArgs("lookup_order", { order_id: "ORD-1" }));
    expect(status).toBe("not-applicable");
    expect(am.receipt().events).toHaveLength(0);
  });

  it("derives risky tools from the spec (action: block / requires_approval)", async () => {
    const spec = `
version: "1.0"
tools:
  issue_refund:
    requires_approval: true
  delete_account:
    action: block
  lookup_order:
    requires_approval: false
`;
    const am = withAgentMint({ spec });
    const approve = am.toolApproval("spec", {
      input: cannedInput("y"),
      output: sink(),
    });

    // requires_approval: true → gated
    expect(await approve(approvalArgs("issue_refund", { amount: 1 }))).toBe("approved");
    // not risky → passes through
    expect(await approve(approvalArgs("lookup_order", { order_id: "X" }))).toBe(
      "not-applicable",
    );
  });

  it("embeds the gate hash as a signature when opts.signature is set", async () => {
    const am = withAgentMint();
    const approve = am.toolApproval(
      { tools: ["issue_refund"] },
      { input: cannedInput("y"), output: sink(), signature: true },
    );
    const status = await approve(approvalArgs("issue_refund", { amount: 5 }));
    expect(status).toMatchObject({ type: "approved" });
    expect((status as { reason: string }).reason).toMatch(/^agentmint-sig=[0-9a-f]{64}$/);
  });

  it("resulting JSONL parses and preserves the gate→tool ordering", async () => {
    const am = withAgentMint();
    const approve = am.toolApproval(
      { tools: ["issue_refund"] },
      { input: cannedInput("y"), output: sink() },
    );
    await approve(approvalArgs("issue_refund", { amount: 7 }, "c1"));
    const tools = am.tools({
      issue_refund: {
        execute: async (_i: unknown, _o?: VercelToolCallOptions) => ({ ok: true }),
      },
    });
    await tools.issue_refund.execute!({ amount: 7 }, { toolCallId: "c1" });

    const lines = parseJSONL(am.jsonl());
    expect(lines.map((l) => l.result)).toEqual(["held", "approved", "allowed"]);
    // every line is well-formed and correlated
    expect(lines.every((l) => typeof l.timestamp === "string" && l.runId === am.runId)).toBe(true);
    expect((lines[2] as { callRef?: string }).callRef).toBe("c1");
  });
});

describe("recordApproval — out-of-band (useChat) flows", () => {
  it("chains a resolved decision onto the receipt", () => {
    const am = withAgentMint();
    am.recordApproval({
      tool: "issue_refund",
      approved: true,
      approver: "alice@example.com",
      hash: "deadbeef".repeat(8),
      toolCallId: "c_ext",
      context: { amount: 20 },
    });
    const receipt = am.receipt();
    expect(receipt.events.map((e) => e.result)).toEqual(["held", "approved"]);
    expect(receipt.events[1]!.details).toContain("alice@example.com");
    expect(receipt.events[1]!.callRef).toBe("c_ext");
  });

  it("records a denial with blocked count", () => {
    const am = withAgentMint();
    am.recordApproval({
      tool: "wire_funds",
      approved: false,
      reason: "over limit",
      toolCallId: "c_ext2",
    });
    const receipt = am.receipt();
    expect(receipt.events.map((e) => e.result)).toEqual(["held", "rejected"]);
    expect(receipt.summary.blocked).toBe(1);
  });
});
