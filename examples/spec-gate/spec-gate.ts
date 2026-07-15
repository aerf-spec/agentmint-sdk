// Control what gets receipted: a checkpoint and a bound, both enforced.
//
//   npm run example:gate
//
// Two rules from a prior auth spec, both live here:
//   1. A billed amount can never exceed the amount the payer authorized.
//   2. An appeal is a decision a clinician has to approve, not the agent.
//
// The run shows one blocked over-bill and one appeal held for approval, then a
// signed receipt for the clinician's decision. Signing is on, so every decision
// becomes a receipt you can verify.
//
// In your own project, import from "@npmsai/agentmint" instead of "../../src".
import { generateKeyPairSync } from "node:crypto";
import { harden, loadSpec } from "../../src/index.js";

const privateKeyPem = generateKeyPairSync("ed25519").privateKey.export({
  type: "pkcs8",
  format: "pem",
}) as string;

// The two tools the rules govern, plus the lookup the bound reads from.
const myTools = {
  lookup_auth: async ({ patient_id }: { patient_id: string }) => ({
    patient_id,
    authorized_amount: 40,
  }),
  submit_prior_auth: async ({ billed_amount }: { billed_amount: number }) => ({
    status: "submitted",
    billed_amount,
  }),
  submit_appeal: async ({ appeal_id }: { appeal_id: string }) => ({
    appeal_id,
    status: "submitted",
  }),
};

const spec = loadSpec(`
version: "1.0"
tools:
  submit_prior_auth:
    requires: [lookup_auth]
    input:
      properties:
        billed_amount:
          # Bill no more than the payer authorized. Read from the prior lookup.
          max_ref: "lookup_auth.output.authorized_amount"
          action: block
`);

async function main(): Promise<void> {
  const tools = harden(myTools, {
    spec,
    signing: { privateKeyPem },
    // An appeal is held. The clinician approves it here. In a real agent this
    // is where a human sees the case and decides.
    checkpoint: ["submit_appeal"],
    onCheckpoint: async (tool) => {
      console.log(`  clinician review: approving ${tool}`);
      return true;
    },
  });

  await tools.lookup_auth({ patient_id: "PT-4821" });

  // The bound holds: 500 is over the authorized 40, so the call never runs.
  const blocked = await tools.submit_prior_auth({ billed_amount: 500 });
  console.log(`  submit_prior_auth(500): ${JSON.stringify(blocked)}`);

  // The appeal is a checkpoint. It is held, then approved, then it runs.
  const appeal = await tools.submit_appeal({ appeal_id: "APL-1103" });
  console.log(`  submit_appeal: ${JSON.stringify(appeal)}`);

  console.log("");
  console.log(tools.__receipt());
  console.log("");
  console.log(`  Receipt chain verifies: ${JSON.stringify(tools.__verifyReceipts())}`);
}

main();
