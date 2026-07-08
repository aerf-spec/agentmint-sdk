import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { guarded } from "../lib/agentmint.js";
import { determination } from "../lib/ehr.js";

// The only side-effecting tool: it commits a prior-auth determination. Physician
// review is eve's NATIVE durable approval (`approval: always()`), which pauses
// the turn until a human answers — not AgentMint's console gate. The guard,
// invoked only after approval is granted, records the decision (held → approved)
// onto the AgentMint receipt, then enforces spec rules. Even a rubber-stamped
// approval can't push a cross-patient determination past the cross_ref block.
export default defineTool({
  description:
    "Submit the final prior-authorization determination. Requires physician approval.",
  inputSchema: z.object({
    patient_id: z.string(),
    decision: z.enum(["approve", "deny"]),
    rationale: z.string().optional(),
  }),
  approval: always(),
  execute: guarded(
    "submit_determination",
    async ({ patient_id, decision, rationale }) =>
      determination(patient_id, decision, rationale),
    { approvalGranted: true },
  ),
});
