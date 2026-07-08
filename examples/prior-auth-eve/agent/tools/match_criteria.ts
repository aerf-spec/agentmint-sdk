import { defineTool } from "eve/tools";
import { z } from "zod";
import { guarded } from "../lib/agentmint.js";
import { criteriaMatch } from "../lib/ehr.js";

// Requires read_clinical_notes + read_coverage_policy, and its patient_id must
// match the eligibility patient (cross_ref, action: block).
export default defineTool({
  description:
    "Match the member's clinical evidence against the coverage criteria.",
  inputSchema: z.object({ patient_id: z.string() }),
  execute: guarded("match_criteria", async ({ patient_id }) =>
    criteriaMatch(patient_id),
  ),
});
