// Unit tests for the AgentMint guard with a fake eve `ctx` — no eve runtime, no
// model. These pin the three behaviours the durable design turns on: a
// spec-blocked call is recorded as `blocked`, a duplicate delivery of the same
// (session, tool, input) is logged exactly once (idempotent replay), and two
// sessions never share state.
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  guarded,
  sessionReceipt,
  type GuardCtx,
} from "../agent/lib/agentmint.js";

let n = 0;
const sessions: string[] = [];
function newSession(): string {
  const id = `test-sess-${process.pid}-${n++}`;
  sessions.push(id);
  return id;
}
function ctx(sessionId: string, callId = "call-1"): GuardCtx {
  return { session: { id: sessionId, turn: "t0" }, callId };
}

afterEach(() => {
  for (const id of sessions.splice(0)) {
    rmSync(new URL(`../receipts/${id}.jsonl`, import.meta.url), { force: true });
  }
});

describe("guard — enforcement", () => {
  it("records a spec-blocked SUD read as `blocked` and returns a BlockResponse", async () => {
    const sid = newSession();
    let ran = false;
    const exec = guarded("read_patient_sud_records", async () => {
      ran = true;
      return { records: "42 CFR Part 2 PROTECTED" };
    });

    const result = await exec({ patient_id: "PT-4827" }, ctx(sid));

    expect(ran).toBe(false); // enforce blocked before execute
    expect(result).toMatchObject({ error: true, tool: "read_patient_sud_records" });

    const receipt = sessionReceipt(sid)!;
    expect(receipt.events.map((e) => e.result)).toEqual(["blocked"]);
  });

  it("lets an in-scope call through and records `allowed`", async () => {
    const sid = newSession();
    const exec = guarded("check_eligibility", async ({ patient_id }: any) => ({
      eligible: true,
      patient_id,
    }));
    const result = await exec({ patient_id: "PT-4827" }, ctx(sid));
    expect(result).toMatchObject({ eligible: true });
    expect(sessionReceipt(sid)!.events.map((e) => e.result)).toEqual(["allowed"]);
  });
});

describe("guard — idempotent replay", () => {
  it("logs a duplicate delivery of the same (session, tool, input) exactly once", async () => {
    const sid = newSession();
    let runs = 0;
    const exec = guarded("check_eligibility", async ({ patient_id }: any) => {
      runs++;
      return { eligible: true, patient_id, runs };
    });

    const first = await exec({ patient_id: "PT-4827" }, ctx(sid));
    const second = await exec({ patient_id: "PT-4827" }, ctx(sid)); // duplicate

    // execute ran once; the replay returned the cached result
    expect(runs).toBe(1);
    expect(second).toEqual(first);
    // and the receipt has exactly one event, not two
    expect(sessionReceipt(sid)!.events).toHaveLength(1);
  });

  it("treats a different input as a distinct call (logs twice)", async () => {
    const sid = newSession();
    const exec = guarded("check_eligibility", async ({ patient_id }: any) => ({
      eligible: true,
      patient_id,
    }));
    await exec({ patient_id: "PT-4827" }, ctx(sid));
    await exec({ patient_id: "PT-9102" }, ctx(sid, "call-2"));
    expect(sessionReceipt(sid)!.events).toHaveLength(2);
  });
});

describe("guard — session isolation", () => {
  it("two sessions never share state", async () => {
    const a = newSession();
    const b = newSession();
    const execA = guarded("read_patient_sud_records", async () => ({ x: 1 }));
    const execB = guarded("check_eligibility", async ({ patient_id }: any) => ({
      eligible: true,
      patient_id,
    }));

    await execA({ patient_id: "PT-4827" }, ctx(a)); // blocked in A
    await execB({ patient_id: "PT-4827" }, ctx(b)); // allowed in B

    const ra = sessionReceipt(a)!;
    const rb = sessionReceipt(b)!;
    expect(ra.runId).not.toBe(rb.runId);
    expect(ra.events.map((e) => e.result)).toEqual(["blocked"]);
    expect(rb.events.map((e) => e.result)).toEqual(["allowed"]);
    expect(ra.summary.blocked).toBe(1);
    expect(rb.summary.blocked).toBe(0);
  });
});

describe("guard — approval recording", () => {
  it("records held → approved before enforcing an approval-gated tool", async () => {
    const sid = newSession();
    // Simulate eve having granted approval before calling execute.
    const exec = guarded(
      "submit_determination",
      async ({ patient_id, decision }: any) => ({ patient_id, decision, status: "submitted" }),
      { approvalGranted: true },
    );
    // Establish the workflow prerequisites in the same session first.
    await guarded("check_eligibility", async (i: any) => ({ eligible: true, ...i }))(
      { patient_id: "PT-4827" },
      ctx(sid, "c0"),
    );
    await guarded("read_clinical_notes", async (i: any) => ({ ...i, notes: "x" }))(
      { patient_id: "PT-4827" },
      ctx(sid, "c1"),
    );
    await guarded("read_coverage_policy", async () => ({ criteria: [] }))(
      { procedure_code: "72148" },
      ctx(sid, "c2"),
    );
    await guarded("match_criteria", async (i: any) => ({ ...i, result: "criteria_met" }))(
      { patient_id: "PT-4827" },
      ctx(sid, "c3"),
    );

    const result = await exec(
      { patient_id: "PT-4827", decision: "approve" },
      ctx(sid, "c4"),
    );
    expect(result).toMatchObject({ status: "submitted" });

    const results = sessionReceipt(sid)!.events.map((e) => e.result);
    // ...check_eligibility, notes, policy, criteria, then held, approved, allowed
    expect(results.slice(-3)).toEqual(["held", "approved", "allowed"]);
  });
});
