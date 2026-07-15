// The prior-auth agent's three tools, defined with the Vercel AI SDK's `tool()`
// helper plus zod schemas over the pure handlers in ./handlers.ts. Nothing here
// imports AgentMint. run.ts wraps these with `am.tools()` so the guardrails sit
// between the model and the tool.
import { tool } from "ai";
import * as z from "zod";
import * as handlers from "./handlers.ts";

export const tools = {
  lookup_auth: tool({
    description: "Look up the payer authorization on file by id. Returns its authorized amount and payer.",
    inputSchema: z.object({ auth_id: z.string() }),
    execute: handlers.lookup_auth,
  }),
  submit_prior_auth: tool({
    description: "Submit a prior authorization claim. Requires human approval.",
    inputSchema: z.object({
      auth_id: z.string(),
      billed_amount: z.number().describe("USD amount to bill"),
    }),
    execute: handlers.submit_prior_auth,
  }),
  notify_payer: tool({
    description: "Send the payer a submission confirmation.",
    inputSchema: z.object({ to: z.string(), body: z.string() }),
    execute: handlers.notify_payer,
  }),
};
