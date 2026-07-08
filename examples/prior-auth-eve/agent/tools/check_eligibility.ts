import { defineTool } from "eve/tools";
import { z } from "zod";
import { guarded } from "../lib/agentmint.js";
import { getPatient } from "../lib/ehr.js";

// The first step of the workflow. It records the patient the whole session is
// bound to — every later tool's patient_id is cross-referenced against this one.
export default defineTool({
  description:
    "Check a member's insurance eligibility for a procedure. Run this first; it establishes the patient for the whole case.",
  inputSchema: z.object({
    patient_id: z.string().describe("Member ID, e.g. PT-4827"),
    plan_id: z.string().optional(),
  }),
  execute: guarded("check_eligibility", async ({ patient_id }) => {
    const patient = getPatient(patient_id);
    if (!patient) return { error: `Patient ${patient_id} not found` };
    return { eligible: true, plan: patient.insurance, patient_id };
  }),
});
