// AgentMint RCM demo — a prior authorization agent session under a signed plan.
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
import { blue, bold, brand, dim, fg, green, icons, muted, red, yellow } from "./color.js";

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

/**
 * Print the session, verify the chain, then flip one byte and verify again.
 * The originals stay clean: the tamper runs on a copy, so callers can still
 * export the untouched chain.
 */
export function renderRcmSession(chain: RcmChain): void {
  const { receipts, publicKeyPem, steps } = chain;

  header();
  for (const step of steps) {
    console.log(`  ${step.icon} ${step.color(bold(step.verdict.padEnd(10)))} ${fg(step.action)}`);
    console.log(`    ${muted(step.sentence)}`);
  }

  console.log("");
  const before = verifyDecisionReceipts(receipts, publicKeyPem);
  if (before.ok) {
    console.log(`  ${green("✓")} ${fg(`The chain verifies. All ${receipts.length} receipts are signed, linked, and in sequence.`)}`);
  } else {
    console.log(`  ${red("✗")} ${fg("Unexpected: a fresh chain did not verify.")} ${dim(before.reason ?? "")}`);
  }

  // Flip one byte of receipt 3's action field on a copy and verify again.
  const tampered = receipts.map((r) => ({ ...r }));
  const target = tampered[2]!;
  target.action = "X" + target.action.slice(1);
  const after = verifyDecisionReceipts(tampered, publicKeyPem);

  console.log("");
  if (!after.ok && after.brokenAt !== undefined) {
    const at = after.brokenAt + 1;
    console.log(`  ${red("✗")} ${fg(`Chain broken at receipt ${at} of ${receipts.length}. The action field was changed after signing. Every receipt after this point is now suspect.`)}`);
  } else {
    console.log(`  ${red("✗")} ${fg("Unexpected: a tampered chain still verified.")}`);
  }
  console.log("");
}

/** Run the RCM demo for `agentmint demo` (no file export). */
export async function runRcmDemo(): Promise<void> {
  const chain = buildRcmChain();
  renderRcmSession(chain);
  console.log(`  ${muted("Next: run")} ${fg("agentmint init --template rcm")} ${muted("to generate this plan for your own agent.")}`);
  console.log("");
  console.log(`  ${dim(`${brand()} demo`)} ${dim(blue("·"))} ${dim("agentmint demo basic")} ${dim("for the generic scenarios.")}`);
  console.log("");
}
