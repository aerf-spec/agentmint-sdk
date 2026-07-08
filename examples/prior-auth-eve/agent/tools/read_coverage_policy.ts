import { defineTool } from "eve/tools";
import { z } from "zod";
import { guarded } from "../lib/agentmint.js";
import { coveragePolicy } from "../lib/ehr.js";

export default defineTool({
  description: "Read the payer coverage policy and criteria for a procedure code.",
  inputSchema: z.object({ procedure_code: z.string() }),
  execute: guarded("read_coverage_policy", async ({ procedure_code }) =>
    coveragePolicy(procedure_code),
  ),
});
