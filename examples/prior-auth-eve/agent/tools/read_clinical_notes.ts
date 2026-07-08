import { defineTool } from "eve/tools";
import { z } from "zod";
import { guarded } from "../lib/agentmint.js";
import { clinicalNotes } from "../lib/ehr.js";

// Requires check_eligibility first, and its patient_id must match the one
// eligibility was run for (cross_ref, action: block).
export default defineTool({
  description: "Read a member's clinical notes for the referred procedure.",
  inputSchema: z.object({ patient_id: z.string() }),
  execute: guarded("read_clinical_notes", async ({ patient_id }) =>
    clinicalNotes(patient_id),
  ),
});
