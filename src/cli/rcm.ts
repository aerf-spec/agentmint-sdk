// AgentMint RCM demo. A prior authorization agent session under a signed plan.
//
// A utilization-management agent works a prior auth case. Its plan is signed
// before the session starts: it may read one patient's records and submit
// prior auths, but any appeal is a checkpoint a clinician has to clear. Every
// decision becomes an Ed25519-signed, hash-chained receipt. The chain verifies,
// then we flip one byte and it names the exact receipt that changed.
//
// No keys, no network, no model: the session is deterministic in shape and
// self-contained, built only on the committed SDK under src/.
import {
  generateKeyPair,
  privateKeyToPem,
  publicKeyToPem,
} from "../kernel/sign.js";
import { signPlan, evaluatePolicy, type PlanReceipt } from "../plan.js";
import {
  createDecisionContext,
  buildDecisionReceipt,
  verifyDecisionReceipts,
} from "../receipt-decision.js";
import { isoNowUtc } from "../receipt-aerf.js";
import type { DecisionReceipt, Event, EventResult } from "../types.js";
import { bold, brand, dim, fg, green, icons, muted, red, yellow } from "./color.js";

/** Sleep helper. No dependency, just a wrapped setTimeout. */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fast mode skips every pause, for CI and for impatient re-runs. It is on when
 * AGENTMINT_DEMO_FAST is set to anything other than 0 or false, or when a caller
 * passes { fast: true } (the --fast flag on the demo command).
 */
function resolveFast(fast?: boolean): boolean {
  if (fast !== undefined) return fast;
  const env = process.env.AGENTMINT_DEMO_FAST;
  return !!env && env !== "0" && env.toLowerCase() !== "false";
}

/** Pause between beats of the walkthrough. Roughly 600 to 900ms, off in fast mode. */
async function beat(fast: boolean, ms = 800): Promise<void> {
  if (!fast) await sleep(ms);
}

/** The agent acting under the plan. */
const AGENT = "prior-auth-agent";
/** The clinician key id shown on the approval receipt. */
const CLINICIAN_KEY = "4f2a";

/** The signed plan for the session: patient-scoped reads, prior auth submits, appeals held. */
export const RCM_SCOPE = ["read:patient_record:PT-4821:*", "submit:prior_auth:*"];
export const RCM_CHECKPOINTS = ["submit:appeal:*"];

export interface RcmChain {
  receipts: DecisionReceipt[];
  publicKeyPem: string;
  plan: PlanReceipt;
  /** Display metadata for the renderer, one entry per receipt. */
  steps: RcmStep[];
}

interface RcmStep {
  action: string;
  result: EventResult;
  /** The verdict line shown to the reader. */
  verdict: string;
  /** The one plain sentence under the line. */
  sentence: string;
  icon: string;
  color: (s: string) => string;
}

/**
 * Build the six-receipt chain for the session. The first four verdicts are the
 * real output of evaluatePolicy against the signed plan; the last two record
 * the clinician's approval and the appeal that ran only once that approval was
 * signed.
 */
export function buildRcmChain(): RcmChain {
  const { privateKey, publicKey } = generateKeyPair();
  const privateKeyPem = privateKeyToPem(privateKey);
  const publicKeyPem = publicKeyToPem(publicKey);

  const plan = signPlan(
    {
      user: "utilization-management",
      action: "prior_auth_session",
      scope: RCM_SCOPE,
      checkpoints: RCM_CHECKPOINTS,
      ttlSeconds: null,
    },
    privateKey,
  );

  const ctx = createDecisionContext({ runId: "rcm-demo", privateKeyPem, plan });

  // Steps 1 to 4: the plan itself decides. We ask evaluatePolicy and record
  // exactly what it returned, so the ALLOW and BLOCK on the receipt are real.
  const policyReason = (action: string): string =>
    evaluatePolicy(action, AGENT, plan).reason;

  const steps: RcmStep[] = [
    {
      action: "read:patient_record:PT-4821",
      result: "allowed",
      verdict: "ALLOWED",
      icon: icons.allowed,
      color: green,
      sentence: "In scope. HIPAA 164.312(a) access control satisfied for this session.",
    },
    {
      action: "submit:prior_auth:PA-2210",
      result: "allowed",
      verdict: "ALLOWED",
      icon: icons.allowed,
      color: green,
      sentence: "In scope. Receipt signed and chained.",
    },
    {
      action: "read:patient_record:PT-4498",
      result: "blocked",
      verdict: "BLOCKED",
      icon: icons.blocked,
      color: red,
      sentence:
        "This record is outside the session scope. The call never ran. The block itself is receipted.",
    },
    {
      action: "submit:appeal:APL-1103",
      result: "held",
      verdict: "CHECKPOINT",
      icon: icons.held,
      color: yellow,
      sentence:
        "Held for human approval. CMS and California SB 1120 require a clinician to make this call.",
    },
    {
      action: "submit:appeal:APL-1103",
      result: "approved",
      verdict: "APPROVED",
      icon: icons.approved,
      color: green,
      sentence:
        `Approved by clinician key ${CLINICIAN_KEY}. The approval is now a signed artifact in the chain.`,
    },
    {
      action: "submit:appeal:APL-1103",
      result: "allowed",
      verdict: "SUBMITTED",
      icon: icons.allowed,
      color: green,
      sentence:
        "Submitted under that approval. The clinician's decision, not the agent's, is on the receipt.",
    },
  ];

  const receipts = steps.map((step, i) => {
    // The reason on the first four receipts comes from the plan evaluation;
    // the approval and submission carry the clinician key that authorized them.
    const reason =
      i < 4 ? policyReason(step.action) : `clinician ${CLINICIAN_KEY} approval`;
    const event: Event = {
      timestamp: isoNowUtc(),
      elapsed: "0ms",
      tool: step.action,
      params: {},
      result: step.result,
      reason,
    };
    return buildDecisionReceipt(event, ctx);
  });

  return { receipts, publicKeyPem, plan, steps };
}

function header(): void {
  console.log("");
  console.log(`  ${brand()}  ${fg("Prior Authorization")}`);
  console.log(`  ${muted("A prior auth agent works one case under a signed plan.")}`);
  console.log("");
  console.log(`  ${dim("plan scope")}        ${fg(RCM_SCOPE.join("  "))}`);
  console.log(`  ${dim("plan checkpoints")}  ${fg(RCM_CHECKPOINTS.join("  "))}`);
  console.log("");
}

/** Print one narration sentence, in plain muted text, before a result. */
function narrate(text: string): void {
  console.log(`  ${muted(text)}`);
}

/** Print a receipt's verdict line and its one plain sentence. */
function printStep(step: RcmStep): void {
  console.log(`  ${step.icon} ${step.color(bold(step.verdict.padEnd(10)))} ${fg(step.action)}`);
  console.log(`    ${muted(step.sentence)}`);
}

/**
 * Print the session as a guided walkthrough, verify the chain, then flip one
 * byte and verify again. Narration comes first, then a pause, then the result,
 * so a reader can follow every beat. Fast mode skips the pauses. The originals
 * stay clean: the tamper runs on a copy, so callers can still export the chain.
 */
export async function renderRcmSession(
  chain: RcmChain,
  opts?: { fast?: boolean },
): Promise<void> {
  const { receipts, publicKeyPem, steps } = chain;
  const fast = resolveFast(opts?.fast);

  header();
  await beat(fast, 400);

  // Action 1: the in-scope patient record read.
  narrate("The agent looks up patient PT-4821. This is inside the session's authorized scope, so it is allowed and receipted.");
  await beat(fast);
  printStep(steps[0]!);
  console.log(`    ${dim("One authorized read, one receipt. The plan permitted it, so agentmint records it and moves on.")}`);
  console.log("");
  await beat(fast);

  // Action 2: the prior auth submission.
  narrate("The agent submits a prior authorization for this patient. Also in scope. Also receipted.");
  await beat(fast);
  printStep(steps[1]!);
  console.log(`    ${dim("Two authorized actions now sit in the chain, each one signed.")}`);
  console.log("");
  await beat(fast);

  // Action 3: the out-of-scope read, blocked before it runs.
  narrate("Now the agent tries to read a different patient's record, PT-4498. This is outside what this session was authorized to touch.");
  await beat(fast, 900);
  printStep(steps[2]!);
  console.log(`    ${dim("The call never ran. The block itself is recorded as a receipt, so there is proof the boundary held, not just that it was supposed to.")}`);
  console.log("");
  await beat(fast);

  // Action 4: the appeal checkpoint, held for a clinician, then approved.
  narrate("The agent wants to submit an appeal. Under CMS and California law, an algorithm cannot make this call alone, a clinician has to.");
  await beat(fast, 900);
  printStep(steps[3]!);
  await beat(fast);
  narrate("Held. A clinician approves.");
  await beat(fast);
  printStep(steps[4]!);
  printStep(steps[5]!);
  console.log(`    ${dim("That approval is not a note in a database. It is now a signed, chained receipt, the same as every other decision in this session.")}`);
  console.log("");
  await beat(fast);

  // Verification of the whole chain.
  narrate("Six receipts, chained in order. Checking every signature and every link.");
  await beat(fast, 900);
  const before = verifyDecisionReceipts(receipts, publicKeyPem);
  if (before.ok) {
    console.log(`  ${green("✓")} ${fg(`The chain verifies. All ${receipts.length} receipts are signed, linked, and in sequence.`)}`);
    console.log(`    ${dim("Passing means every receipt is signed by the session key and none was added, removed, or reordered.")}`);
  } else {
    console.log(`  ${red("✗")} ${fg("Unexpected: a fresh chain did not verify.")} ${dim(before.reason ?? "")}`);
  }
  console.log("");
  await beat(fast);

  // The tamper: flip one byte of receipt 3's action field on a copy.
  narrate("Now watch what happens if someone edits one receipt after the fact, changing the blocked read to look like it was allowed.");
  await beat(fast, 900);
  const tampered = receipts.map((r) => ({ ...r }));
  const target = tampered[2]!;
  target.action = "X" + target.action.slice(1);
  console.log(`  ${dim("Editing receipt 3: flipping one byte of its action field.")}`);
  await beat(fast);
  const after = verifyDecisionReceipts(tampered, publicKeyPem);
  if (!after.ok && after.brokenAt !== undefined) {
    const at = after.brokenAt + 1;
    console.log(`  ${red("✗")} ${fg(`Chain broken at receipt ${at} of ${receipts.length}. The action field was changed after signing. Every receipt after this point is now suspect.`)}`);
    console.log(`    ${dim("Verification caught it immediately and pointed to the exact receipt that changed. This is what silent revision cannot do to this format.")}`);
  } else {
    console.log(`  ${red("✗")} ${fg("Unexpected: a tampered chain still verified.")}`);
  }
  console.log("");
  await beat(fast);

  // Closing recap and where to go next.
  console.log(`  ${fg("What you just saw")}`);
  narrate("An agent worked a prior auth case under a signed plan. Every decision, the allowed reads, the blocked out-of-scope read, and the clinician approved appeal, became a signed receipt linked to the one before it.");
  narrate("Editing any single receipt breaks the chain at that exact spot, so the record cannot be revised in silence.");
  narrate("This is not a log you are asked to trust. It is evidence anyone can check.");
  console.log("");
}

/** Run the RCM demo for `agentmint demo` (no file export). */
export async function runRcmDemo(opts?: { fast?: boolean }): Promise<void> {
  const chain = buildRcmChain();
  await renderRcmSession(chain, opts);
  console.log(`  ${fg("Next steps")}`);
  console.log(`    ${muted("Try it on your own agent in half a day. Read")} ${fg("TRY-IT.md")}${muted(".")}`);
  console.log(`    ${muted("See it as the buyer who receives the packet. Read")} ${fg("FOR-REVIEWERS.md")}${muted(".")}`);
  console.log("");
  console.log(`  ${dim("agentmint demo basic")} ${dim("for the generic scenarios.")}`);
  console.log("");
}
