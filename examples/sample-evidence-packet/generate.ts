// Regenerate the sample evidence packet. Deterministic: same bytes every run.
//
//   npm run example:packet
//
// This builds the exact deliverable a prior auth vendor hands to a hospital
// reviewer: a signed plan, six signed and linked receipts, the issuer public
// key, and a standalone verifier, zipped into evidence.zip. The scenario is
// the one `agentmint demo` shows. One in-scope patient record read, one prior
// auth, one out-of-scope record read blocked before it ran, and one appeal
// held for a clinician whose approval is itself a signed receipt.
//
// Everything is pinned: a fixed demo key, fixed receipt ids, and fixed
// timestamps. So the committed evidence.zip is byte-identical to what this
// script writes, and a reviewer can diff it to confirm nothing was hand-edited.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { signPlan, computePolicyHash } from "../../src/plan.js";
import {
  buildAerfReceipt,
  aerfChainHash,
  type AerfReceipt,
} from "../../src/receipt-aerf.js";
import { EvidencePackage } from "../../src/evidence.js";
import { privateKeyFromPem, publicKeyToPem } from "../../src/kernel/sign.js";
import { createPublicKey } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));

// A fixed demo key. It only ever signs this sample, so committing it is safe.
// A real vendor keeps their key private and never ships it. They ship the
// public key, which is what the reviewer verifies against.
const DEMO_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIMMDjPZYzRNEj2IDDx9AxZboAfBOQ0toz6uKzFs7lLMx
-----END PRIVATE KEY-----
`;

// The signed plan for the session. The agent may read one patient's records
// and submit prior auths. Any appeal is a checkpoint a clinician has to clear.
const SCOPE = ["read:patient_record:PT-4821:*", "submit:prior_auth:*"];
const CHECKPOINTS = ["submit:appeal:*"];
const AGENT = "prior-auth-agent";
const PLAN_ID = "a0000000-0000-4000-8000-000000000000";
const ISSUED_AT = "2026-01-15T09:00:00.000000+00:00";
const PACKAGE_CREATED = "2026-01-15T09:00:06.000000+00:00";

interface StepInit {
  id: string;
  action: string;
  inPolicy: boolean;
  reason: string;
  evidence: Record<string, unknown>;
  observedAt: string;
}

// The six decisions, in order. The reasons name the plain reason each verdict
// was reached, and the HIPAA or CMS control that backs it where one applies.
const STEPS: StepInit[] = [
  {
    id: "a1000001-0000-4000-8000-000000000001",
    action: "read:patient_record:PT-4821",
    inPolicy: true,
    reason:
      "In scope for this case. HIPAA 164.312(a) access control is satisfied for the assigned patient.",
    evidence: { patient_id: "PT-4821" },
    observedAt: "2026-01-15T09:00:01.000000+00:00",
  },
  {
    id: "a2000002-0000-4000-8000-000000000002",
    action: "submit:prior_auth:PA-2210",
    inPolicy: true,
    reason:
      "In scope. Billed amount 40 does not exceed the authorized amount 40 from the lookup.",
    evidence: { auth_id: "PA-2210", billed_amount: 40, authorized_amount: 40 },
    observedAt: "2026-01-15T09:00:02.000000+00:00",
  },
  {
    id: "a3000003-0000-4000-8000-000000000003",
    action: "read:patient_record:PT-4498",
    inPolicy: false,
    reason:
      "Out of scope. This record is not the assigned patient, so the call was blocked before it ran.",
    evidence: { patient_id: "PT-4498", blocked: true },
    observedAt: "2026-01-15T09:00:03.000000+00:00",
  },
  {
    id: "a4000004-0000-4000-8000-000000000004",
    action: "submit:appeal:APL-1103",
    inPolicy: false,
    reason:
      "Held for human approval. CMS-4201-F and California SB 1120 require a clinician to make this determination.",
    evidence: { appeal_id: "APL-1103", held: true },
    observedAt: "2026-01-15T09:00:04.000000+00:00",
  },
  {
    id: "a5000005-0000-4000-8000-000000000005",
    action: "submit:appeal:APL-1103",
    inPolicy: true,
    reason:
      "Approved by clinician key 4f2a. The clinician's determination is now a signed artifact in the chain.",
    evidence: { appeal_id: "APL-1103", approved_by: "clinician:4f2a" },
    observedAt: "2026-01-15T09:00:05.000000+00:00",
  },
  {
    id: "a6000006-0000-4000-8000-000000000006",
    action: "submit:appeal:APL-1103",
    inPolicy: true,
    reason:
      "Submitted under the clinician's approval. The clinician's decision, not the agent's, is on the receipt.",
    evidence: { appeal_id: "APL-1103", submitted: true },
    observedAt: "2026-01-15T09:00:05.500000+00:00",
  },
];

function main(): void {
  const key = privateKeyFromPem(DEMO_KEY_PEM);
  const publicKeyPem = publicKeyToPem(createPublicKey(key));

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

  const receipts: AerfReceipt[] = [];
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
    receipts.push(receipt);
    previousHash = aerfChainHash(receipt as unknown as Record<string, unknown>);
  }

  const pkg = new EvidencePackage({
    plan,
    publicKeyPem,
    signingKey: key,
    packageCreated: PACKAGE_CREATED,
  });
  for (const r of receipts) pkg.add(r);
  pkg.export(join(here, "evidence.zip"));

  // Ship the public key next to the zip too, so a reviewer can eyeball it
  // without unzipping. It is also inside the zip, which is what verify.mjs uses.
  mkdirSync(here, { recursive: true });
  writeFileSync(join(here, "public_key.pem"), publicKeyPem);

  console.log(`Wrote ${join("examples", "sample-evidence-packet", "evidence.zip")} (${receipts.length} receipts).`);
  console.log("Verify it the way a reviewer would:");
  console.log("  cd examples/sample-evidence-packet && unzip -o evidence.zip -d packet && node packet/verify.mjs");
}

main();
