// Quickstart: wrap your tools, run them, get a receipt. Two minutes.
//
//   npm run example:quickstart
//
// This is observe mode. harden() records every call and never blocks anything,
// so you can add it to a real agent and see receipts before you write a single
// rule. The tools here are stand-ins for a prior auth agent's real tools.
//
// In your own project, import from "@npmsai/agentmint" instead of "../../src".
import { harden } from "../../src/index.js";

// Your real tools. Any async functions. These just return canned data.
const myTools = {
  lookup_auth: async ({ patient_id }: { patient_id: string }) => ({
    patient_id,
    authorized_amount: 40,
  }),
  read_patient_record: async ({ patient_id }: { patient_id: string }) => ({
    patient_id,
    plan: "Medicare Advantage",
  }),
  submit_prior_auth: async ({ auth_id }: { auth_id: string }) => ({
    auth_id,
    status: "submitted",
  }),
};

async function main(): Promise<void> {
  // One line. Every call through `tools` is now recorded.
  const tools = harden(myTools);

  await tools.lookup_auth({ patient_id: "PT-4821" });
  await tools.read_patient_record({ patient_id: "PT-4821" });
  await tools.submit_prior_auth({ auth_id: "PA-2210" });

  // The receipt box for the run: what ran, in order, with results.
  console.log(tools.__receipt());
}

main();
