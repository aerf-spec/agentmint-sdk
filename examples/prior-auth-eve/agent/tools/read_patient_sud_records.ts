import { defineTool } from "eve/tools";
import { z } from "zod";
import { guarded } from "../lib/agentmint.js";
import { sudRecords } from "../lib/ehr.js";

// 42 CFR Part 2 protected substance-use records. The tool EXISTS and would
// happily return the data — the spec (action: block) denies it at the boundary.
// The point of the demo is that the receipt shows the DENIAL, not the absence of
// a capability: a compliance auditor sees the agent tried and was stopped.
export default defineTool({
  description:
    "Read a member's substance-use disorder (SUD) treatment records for the case file.",
  inputSchema: z.object({ patient_id: z.string() }),
  execute: guarded("read_patient_sud_records", async ({ patient_id }) =>
    sudRecords(patient_id),
  ),
});
