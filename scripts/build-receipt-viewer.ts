// Build the GitHub Pages receipt viewer (site/index.html).
//
//   npx tsx scripts/build-receipt-viewer.ts
//
// The page is a static, self-contained rendering of one prior authorization
// agent session. Every receipt on the page is produced HERE by the real SDK:
// signPlan() signs the plan, buildAerfReceipt() signs and chains each receipt,
// and verifyAerfChain() runs both the clean check and the tamper check. Nothing
// on the page is hand-written crypto. The scenario is synthetic; the signatures,
// hashes, and chain links are real.
//
// The signing key, receipt ids, and timestamps are pinned to the exact values
// in examples/sample-evidence-packet/generate.ts, so the receipts shown on the
// page are byte-identical to the downloadable evidence.zip a reviewer verifies
// with `node packet/verify.mjs`. The page shows the same records you can check.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicKey } from "node:crypto";
import { signPlan, computePolicyHash } from "../src/plan.js";
import {
  buildAerfReceipt,
  aerfChainHash,
  verifyAerfReceipt,
  type AerfReceipt,
} from "../src/receipt-aerf.js";
import { verifyAerfChain } from "../src/chain.js";
import { privateKeyFromPem, publicKeyToPem } from "../src/kernel/sign.js";
import { renderPage } from "./receipt-viewer-template.js";
import {
  renderReceiptsMarkdown,
  renderVerificationMarkdown,
  type ReceiptCheck,
} from "./receipt-exports.js";

const here = dirname(fileURLToPath(import.meta.url));
const siteDir = join(here, "..", "site");

// Pinned demo key. It only ever signs this synthetic sample, so committing it
// is safe. It matches examples/sample-evidence-packet/generate.ts, so the
// receipts here equal the ones inside the committed evidence.zip.
const DEMO_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIMMDjPZYzRNEj2IDDx9AxZboAfBOQ0toz6uKzFs7lLMx
-----END PRIVATE KEY-----
`;

const SCOPE = ["read:patient_record:PT-4821:*", "submit:prior_auth:*"];
const CHECKPOINTS = ["submit:appeal:*"];
const AGENT = "prior-auth-agent";
const PLAN_ID = "a0000000-0000-4000-8000-000000000000";
const ISSUED_AT = "2026-01-15T09:00:00.000000+00:00";

/** One agent decision, plus the plain-language labels shown on the card. */
export interface Step {
  id: string;
  action: string;
  inPolicy: boolean;
  reason: string;
  evidence: Record<string, unknown>;
  observedAt: string;
  // Display metadata (not part of the signed receipt).
  status: "Allowed" | "Blocked" | "Checkpoint" | "Approved" | "Submitted";
  kind: "allow" | "block" | "check";
  title: string;
  plain: string;
}

const STEPS: Step[] = [
  {
    id: "a1000001-0000-4000-8000-000000000001",
    action: "read:patient_record:PT-4821",
    inPolicy: true,
    reason:
      "In scope for this case. HIPAA 164.312(a) access control is satisfied for the assigned patient.",
    evidence: { patient_id: "PT-4821" },
    observedAt: "2026-01-15T09:00:01.000000+00:00",
    status: "Allowed",
    kind: "allow",
    title: "Patient record read",
    plain: "The agent read the record for the patient assigned to this case, PT-4821. This is inside the authorized scope, so it ran and was recorded.",
  },
  {
    id: "a2000002-0000-4000-8000-000000000002",
    action: "submit:prior_auth:PA-2210",
    inPolicy: true,
    reason:
      "In scope. Billed amount 40 does not exceed the authorized amount 40 from the lookup.",
    evidence: { auth_id: "PA-2210", billed_amount: 40, authorized_amount: 40 },
    observedAt: "2026-01-15T09:00:02.000000+00:00",
    status: "Allowed",
    kind: "allow",
    title: "Prior authorization submitted",
    plain: "The agent submitted prior authorization PA-2210. The billed amount matched the authorized amount from the lookup, so it stayed in scope.",
  },
  {
    id: "a3000003-0000-4000-8000-000000000003",
    action: "read:patient_record:PT-4498",
    inPolicy: false,
    reason:
      "Out of scope. This record is not the assigned patient, so the call was blocked before it ran.",
    evidence: { patient_id: "PT-4498", blocked: true },
    observedAt: "2026-01-15T09:00:03.000000+00:00",
    status: "Blocked",
    kind: "block",
    title: "Out-of-scope record read blocked",
    plain: "The agent tried to read a different patient's record, PT-4498. That record is outside this session's authorized scope, so the call was blocked before it ran. The block itself is recorded.",
  },
  {
    id: "a4000004-0000-4000-8000-000000000004",
    action: "submit:appeal:APL-1103",
    inPolicy: false,
    reason:
      "Held for human approval. CMS-4201-F and California SB 1120 require a clinician to make this determination.",
    evidence: { appeal_id: "APL-1103", held: true },
    observedAt: "2026-01-15T09:00:04.000000+00:00",
    status: "Checkpoint",
    kind: "check",
    title: "Appeal held for clinician approval",
    plain: "The agent reached an appeal. Under CMS-4201-F and California SB 1120 a clinician, not an algorithm, has to make this determination, so the action was held at a checkpoint.",
  },
  {
    id: "a5000005-0000-4000-8000-000000000005",
    action: "submit:appeal:APL-1103",
    inPolicy: true,
    reason:
      "Approved by clinician key 4f2a. The clinician's determination is now a signed artifact in the chain.",
    evidence: { appeal_id: "APL-1103", approved_by: "clinician:4f2a" },
    observedAt: "2026-01-15T09:00:05.000000+00:00",
    status: "Approved",
    kind: "allow",
    title: "Clinician approval recorded",
    plain: "A clinician reviewed the appeal and approved it. The approval is its own signed receipt in the chain, carrying the clinician key that authorized it.",
  },
  {
    id: "a6000006-0000-4000-8000-000000000006",
    action: "submit:appeal:APL-1103",
    inPolicy: true,
    reason:
      "Submitted under the clinician's approval. The clinician's decision, not the agent's, is on the receipt.",
    evidence: { appeal_id: "APL-1103", submitted: true },
    observedAt: "2026-01-15T09:00:05.500000+00:00",
    status: "Submitted",
    kind: "allow",
    title: "Appeal submitted under approval",
    plain: "The appeal was submitted, and only after the clinician approval was in place. The receipt records that the clinician's decision, not the agent's, authorized the submission.",
  },
];

export interface ReceiptView {
  step: Step;
  receipt: AerfReceipt;
  chainHash: string;
}

export interface PageData {
  plan: Record<string, unknown>;
  publicKeyPem: string;
  keyId: string;
  scope: string[];
  checkpoints: string[];
  agent: string;
  issuedAt: string;
  receipts: ReceiptView[];
  cleanRootHash: string;
  tamper: {
    receiptIndex: number; // 1-based, for display
    receiptId: string;
    field: string;
    from: string;
    to: string;
    breakType: string;
    reason: string;
  };
}

function main(): void {
  const key = privateKeyFromPem(DEMO_KEY_PEM);
  const pub = createPublicKey(key);
  const publicKeyPem = publicKeyToPem(pub);

  const plan = signPlan(
    {
      user: "utilization-management",
      action: "prior_auth_session",
      scope: SCOPE,
      checkpoints: CHECKPOINTS,
      ttlSeconds: null,
      id: PLAN_ID,
      issuedAt: ISSUED_AT,
    },
    key,
  );
  const policyHash = computePolicyHash(plan);

  // Build and chain the six signed receipts.
  const views: ReceiptView[] = [];
  let previousHash: string | undefined;
  let seq = 0;
  for (const step of STEPS) {
    const receipt = buildAerfReceipt(
      {
        planId: plan.id,
        agent: AGENT,
        action: step.action,
        inPolicy: step.inPolicy,
        policyReason: step.reason,
        evidence: step.evidence,
        observedAt: step.observedAt,
        previousReceiptHash: previousHash,
        seq: ++seq,
        planSignature: plan.signature,
        policyHash,
        id: step.id,
      },
      { issuerPrivateKey: key },
    );
    const chainHash = aerfChainHash(receipt as unknown as Record<string, unknown>);
    views.push({ step, receipt, chainHash });
    previousHash = chainHash;
  }

  const receipts = views.map((v) => v.receipt as unknown as Record<string, unknown>);

  // 1. Clean verification. The real SDK checks every signature, hash link, and seq.
  const clean = verifyAerfChain(receipts, { issuerPublicKey: pub });
  if (!clean.valid) {
    throw new Error(`clean chain did not verify: ${clean.reason ?? "unknown"}`);
  }

  // 2. Tamper. Flip in_policy on receipt 3 (the blocked read) from false to
  //    true, to make a blocked action look allowed. Re-run the same verifier.
  const tamperedIndex = 2; // 0-based
  const original = receipts[tamperedIndex]!;
  const tampered = receipts.map((r, i) =>
    i === tamperedIndex ? { ...r, in_policy: true } : r,
  );
  const broken = verifyAerfChain(tampered, { issuerPublicKey: pub });
  if (broken.valid || broken.breakAtIndex !== tamperedIndex) {
    throw new Error(
      `tamper check did not break at receipt ${tamperedIndex}: ${JSON.stringify(broken)}`,
    );
  }

  const data: PageData = {
    plan: plan as unknown as Record<string, unknown>,
    publicKeyPem,
    keyId: String((plan as unknown as Record<string, unknown>).key_id),
    scope: SCOPE,
    checkpoints: CHECKPOINTS,
    agent: AGENT,
    issuedAt: ISSUED_AT,
    receipts: views,
    cleanRootHash: clean.rootHash,
    tamper: {
      receiptIndex: tamperedIndex + 1,
      receiptId: String(original.id),
      field: "in_policy",
      from: String(original.in_policy),
      to: "true",
      breakType: broken.breakType ?? "signature_invalid",
      // The SDK reason uses an em dash; the page copy avoids em dashes, so
      // normalize it to a comma while keeping the wording intact.
      reason: (broken.reason ?? "").replace(/\s*[—–]\s*/g, ", "),
    },
  };

  // Per-receipt issuer-signature checks, for the verification report. Each is
  // the real result of the SDK verifier, not an assertion.
  const checks: ReceiptCheck[] = views.map((v) => {
    const r = v.receipt as unknown as Record<string, unknown>;
    const res = verifyAerfReceipt(r, { issuerPublicKey: pub });
    return { seq: Number(r.seq), action: String(r.action), id: String(r.id), ok: res.issuerOk };
  });
  if (checks.some((c) => !c.ok)) {
    throw new Error("a receipt failed its issuer-signature check");
  }

  const html = renderPage(data);
  mkdirSync(siteDir, { recursive: true });
  writeFileSync(join(siteDir, "index.html"), html);

  // Linkable side files, all built from the same SDK-produced data:
  //   receipts.json    the raw signed chain (machine format)
  //   receipts.md      a plain-language rendering of every receipt
  //   verification.md  the clean pass and the tamper failure, both real
  //   public_key.pem   the key that verifies the signatures
  writeFileSync(
    join(siteDir, "receipts.json"),
    JSON.stringify(receipts, null, 2) + "\n",
  );
  writeFileSync(join(siteDir, "receipts.md"), renderReceiptsMarkdown(data));
  writeFileSync(join(siteDir, "verification.md"), renderVerificationMarkdown(data, checks));
  writeFileSync(join(siteDir, "public_key.pem"), publicKeyPem);

  console.log(`Wrote site/index.html (${views.length} receipts).`);
  console.log("Wrote site/receipts.json, site/receipts.md, site/verification.md, site/public_key.pem.");
  console.log(`Clean chain root: ${clean.rootHash}`);
  console.log(
    `Tamper check: breaks at receipt ${tamperedIndex + 1} (${broken.breakType}).`,
  );
}

main();
