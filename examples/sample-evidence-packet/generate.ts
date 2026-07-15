// Regenerate the sample evidence packet, deterministically.
//
//   npm run packet:sample
//
// This builds a fixed prior authorization session, signs every decision into an
// AERF receipt, chains the receipts, and then calls the real agentmint CLI to
// export evidence.zip. Nothing here is random: the signing keys come from fixed
// seeds and every timestamp is fixed, so running it again produces a
// byte-identical packet. The scenario is described in this folder's README.md.
//
// The scenario, in order:
//   1. read:patient_record:PT-4821     ALLOWED    in-scope record read
//   2. submit:prior_auth:PA-2210       ALLOWED    prior auth, billed within the authorized amount
//   3. read:patient_record:PT-4498     BLOCKED    a different patient, outside session scope
//   4. submit:appeal:APL-1103          CHECKPOINT held for a clinician (an algorithm may not decide)
//   5. approve:appeal:APL-1103         APPROVED   the clinician's signed approval receipt
//   6. submit:appeal:APL-1103          SUBMITTED  the appeal, filed under that approval
import { spawnSync } from "node:child_process";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildAerfReceipt,
  aerfChainHash,
  isoNowUtc,
  type AerfReceipt,
} from "../../src/receipt-aerf.js";
import { signPlan, computePolicyHash } from "../../src/plan.js";
import { privateKeyToPem, publicKeyToPem } from "../../src/kernel/sign.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

// ── Fixed inputs (this is what makes regeneration deterministic) ────────
// PKCS8 DER prefix for an Ed25519 private key, followed by a 32-byte seed.
// These are throwaway demo keys, derived from constant seeds. They exist only
// so the sample can be rebuilt byte-for-byte. Do not reuse them for anything.
function ed25519FromSeed(seedByte: number) {
  const der = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.alloc(32, seedByte),
  ]);
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

const issuerKey = ed25519FromSeed(0x11); // the notary that signs the receipts
const clinicianKey = ed25519FromSeed(0x22); // the human reviewer who approves the appeal

const CLOCK_BASE = Date.parse("2026-07-15T14:00:00.000Z");
const at = (offsetSeconds: number) => isoNowUtc(new Date(CLOCK_BASE + offsetSeconds * 1000));

const SESSION_ID = "5a1e0000-0000-4000-8000-0000000000aa";
const AGENT = "prior-auth-agent";
const CLINICIAN = "clinician-4f2a";

// ── The signed plan the receipts bind to ───────────────────────────────
const plan = signPlan(
  {
    id: "b0a70000-0000-4000-8000-000000000001",
    user: "utilization-management",
    action: "prior_auth_session",
    scope: ["read:patient_record:PT-4821:*", "submit:prior_auth:*"],
    checkpoints: ["submit:appeal:*"],
    ttlSeconds: null, // never expires, so the packet verifies at any future date
    issuedAt: at(0),
  },
  issuerKey,
);

const policyHash = computePolicyHash(plan);

// ── The six decisions of the session ────────────────────────────────────
interface Step {
  id: string;
  agent: string;
  action: string;
  inPolicy: boolean;
  reason: string;
  evidence: Record<string, unknown>;
  /** Present only on the clinician's approval: signs the evidence with a human key. */
  humanSigned?: boolean;
}

const steps: Step[] = [
  {
    id: "c0000000-0000-4000-8000-000000000001",
    agent: AGENT,
    action: "read:patient_record:PT-4821",
    inPolicy: true,
    reason: "matched scope read:patient_record:PT-4821:*",
    evidence: { patient_id: "PT-4821", record_type: "clinical_notes", purpose: "prior_auth_review" },
  },
  {
    id: "c0000000-0000-4000-8000-000000000002",
    agent: AGENT,
    action: "submit:prior_auth:PA-2210",
    inPolicy: true,
    reason: "matched scope submit:prior_auth:*",
    evidence: {
      prior_auth_id: "PA-2210",
      patient_id: "PT-4821",
      authorized_amount: 40,
      billed_amount: 40,
    },
  },
  {
    id: "c0000000-0000-4000-8000-000000000003",
    agent: AGENT,
    action: "read:patient_record:PT-4498",
    inPolicy: false,
    reason: "no scope pattern matched",
    evidence: { patient_id: "PT-4498", blocked: true, note: "different patient, outside session scope" },
  },
  {
    id: "c0000000-0000-4000-8000-000000000004",
    agent: AGENT,
    action: "submit:appeal:APL-1103",
    inPolicy: false,
    reason: "matched checkpoint submit:appeal:*",
    evidence: { appeal_id: "APL-1103", patient_id: "PT-4821", status: "held_for_clinician" },
  },
  {
    id: "c0000000-0000-4000-8000-000000000005",
    agent: CLINICIAN,
    action: "approve:appeal:APL-1103",
    inPolicy: true,
    reason: "clinician 4f2a approved checkpoint submit:appeal:APL-1103",
    evidence: {
      appeal_id: "APL-1103",
      determination: "approved",
      clinician_key_id: "4f2a",
      basis: "medical necessity confirmed",
    },
    humanSigned: true,
  },
  {
    id: "c0000000-0000-4000-8000-000000000006",
    agent: AGENT,
    action: "submit:appeal:APL-1103",
    inPolicy: true,
    reason: "submitted under clinician 4f2a approval",
    evidence: {
      appeal_id: "APL-1103",
      submitted: true,
      approval_receipt: "c0000000-0000-4000-8000-000000000005",
    },
  },
];

const receipts: AerfReceipt[] = [];
let previousReceiptHash: string | undefined;
steps.forEach((step, i) => {
  const receipt = buildAerfReceipt(
    {
      id: step.id,
      planId: plan.id,
      agent: step.agent,
      action: step.action,
      inPolicy: step.inPolicy,
      policyReason: step.reason,
      evidence: step.evidence,
      observedAt: at(i + 1),
      previousReceiptHash,
      policyHash,
      planSignature: plan.signature,
      sessionId: SESSION_ID,
      seq: i + 1,
    },
    {
      issuerPrivateKey: issuerKey,
      agentPrivateKey: step.humanSigned ? clinicianKey : undefined,
    },
  );
  receipts.push(receipt);
  previousReceiptHash = aerfChainHash(receipt);
});

// ── Stage the CLI inputs, then export with the real CLI ─────────────────
const work = mkdtempSync(join(tmpdir(), "agentmint-sample-"));
try {
  const receiptsDir = join(work, "receipts");
  mkdirSync(receiptsDir);
  for (const r of receipts) {
    writeFileSync(join(receiptsDir, `${r.id}.json`), JSON.stringify(r, null, 2));
  }
  writeFileSync(join(work, "plan.json"), JSON.stringify(plan, null, 2));
  writeFileSync(join(work, "notary_key.pem"), privateKeyToPem(issuerKey));

  const publicKeyPem = publicKeyToPem(createPublicKey(issuerKey));
  writeFileSync(join(work, "public_key.pem"), publicKeyPem);

  const outDir = HERE;
  const outZip = join(outDir, "evidence.zip");
  const result = spawnSync(
    "npx",
    [
      "tsx",
      join(REPO, "src", "cli", "entry.ts"),
      "export",
      "--from", receiptsDir,
      "--out", outZip,
      "--plan", join(work, "plan.json"),
      "--key", join(work, "notary_key.pem"),
      "--created", at(0),
    ],
    { cwd: REPO, stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(`agentmint export failed with exit code ${result.status}`);
  }

  // The buyer also gets the public key on its own, alongside the zip.
  copyFileSync(join(work, "public_key.pem"), join(outDir, "public_key.pem"));

  console.log(`  Wrote ${outZip}`);
  console.log(`  Wrote ${join(outDir, "public_key.pem")}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
