// The half-day trial, in one runnable file. See TRY-IT.md for the full walk.
//
//   npm run example:trial
//
// Part A is the zero-risk start: wrap your tools with harden() in shadow mode.
// Every call is recorded and nothing is blocked, so your agent behaves exactly
// as before. Part B turns on a signed plan and writes receipts to disk, ready
// for `agentmint export` to bundle into a forwardable evidence packet.
//
// In your own project, import from "@npmsai/agentmint" and
// "@npmsai/agentmint/notary" instead of the relative paths below.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { harden } from "../../src/index.js";
import { Notary, FileReceiptSink } from "../../src/exports/notary.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "out");

// Your real tools. Any async functions. These stand in for a prior auth agent.
const myTools = {
  lookup_auth: async ({ patient_id }: { patient_id: string }) => ({ patient_id, authorized_amount: 40 }),
  submit_prior_auth: async ({ auth_id }: { auth_id: string }) => ({ auth_id, status: "submitted" }),
};

async function partA_observe(): Promise<void> {
  console.log("Part A: shadow mode. Records every call, blocks nothing.\n");
  // One wrapper line. Removal is deleting it.
  const tools = harden(myTools, { mode: "shadow" });
  await tools.lookup_auth({ patient_id: "PT-4821" });
  await tools.submit_prior_auth({ auth_id: "PA-2210" });
  console.log(tools.__receipt());
}

function partB_producePacket(): void {
  console.log("\nPart B: sign a plan and write receipts for export.\n");
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // The notary holds your signing key and writes one receipt per action.
  const notary = new Notary({
    stateDir: outDir,
    sink: new FileReceiptSink(join(outDir, "receipts")),
  });
  const plan = notary.createPlan({
    user: "utilization-management",
    action: "prior_auth_session",
    scope: ["read:patient_record:PT-4821:*", "submit:prior_auth:*"],
    checkpoints: ["submit:appeal:*"],
  });

  // The same two actions, now recorded as signed, chained evidence receipts.
  // Put identifiers in evidence, never clinical payloads.
  notary.notarise({ action: "read:patient_record:PT-4821", agent: "prior-auth-agent", plan, evidence: { patient_id: "PT-4821" } });
  notary.notarise({ action: "submit:prior_auth:PA-2210", agent: "prior-auth-agent", plan, evidence: { auth_id: "PA-2210" } });

  writeFileSync(join(outDir, "plan.json"), JSON.stringify(plan, null, 2));

  console.log("Wrote receipts and the signed plan to examples/trial-agent/out/.");
  console.log("Now produce and verify the packet:");
  console.log("  npx @npmsai/agentmint export \\");
  console.log("    --from examples/trial-agent/out/receipts \\");
  console.log("    --plan examples/trial-agent/out/plan.json \\");
  console.log("    --key examples/trial-agent/out/notary_key.pem \\");
  console.log("    --out examples/trial-agent/evidence.zip");
  console.log("  unzip evidence.zip -d packet && node packet/verify.mjs");
}

async function main(): Promise<void> {
  await partA_observe();
  partB_producePacket();
}

main();
