// The refund agent's three tools, defined with the Vercel AI SDK's `tool()`
// helper + zod schemas over the pure handlers in ./handlers.ts. Nothing here
// imports AgentMint — run.ts wraps these with `am.tools()` so the guardrails sit
// between the model and the tool.
import { tool } from "ai";
import * as z from "zod";
import * as handlers from "./handlers.ts";

export const tools = {
  lookup_order: tool({
    description: "Look up an order by id. Returns its total and customer email.",
    inputSchema: z.object({ order_id: z.string() }),
    execute: handlers.lookup_order,
  }),
  issue_refund: tool({
    description: "Issue a refund for an order. Requires human approval.",
    inputSchema: z.object({
      order_id: z.string(),
      amount: z.number().describe("USD amount to refund"),
    }),
    execute: handlers.issue_refund,
  }),
  send_email: tool({
    description: "Email the customer a refund confirmation.",
    inputSchema: z.object({ to: z.string(), body: z.string() }),
    execute: handlers.send_email,
  }),
};
