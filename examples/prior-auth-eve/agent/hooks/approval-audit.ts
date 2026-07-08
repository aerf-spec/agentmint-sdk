// Records physician-approval DENIALS onto the AgentMint receipt.
//
// A granted approval flows through the tool's guarded execute, which records
// held → approved itself. A DENIED approval never runs execute, so eve is the
// only place that sees it — this hook bridges it back to the receipt so a denied
// determination shows held → rejected, symmetric with a grant.
//
// `input.requested` stashes each pending approval's tool + input; the denial
// (an `action.result` carrying `TOOL_EXECUTION_DENIED`) consumes it.
import { defineHook } from "eve/hooks";
import { stashPendingApproval, recordApprovalDenied } from "../lib/agentmint.js";

interface PendingRequest {
  action?: { callId?: string; toolName?: string; input?: Record<string, unknown> };
}

export default defineHook({
  events: {
    "input.requested"(event, ctx) {
      const data = event.data as unknown as {
        requests?: ReadonlyArray<PendingRequest>;
      };
      for (const req of data.requests ?? []) {
        const a = req.action;
        if (a?.callId && a.toolName) {
          stashPendingApproval(ctx.session.id, a.callId, a.toolName, a.input ?? {});
        }
      }
    },
    "action.result"(event, ctx) {
      const data = event.data as unknown as {
        error?: { code?: string };
        result?: { callId?: string };
      };
      if (data.error?.code !== "TOOL_EXECUTION_DENIED") return;
      const callId = data.result?.callId;
      if (!callId) return;
      const denier = ctx.session.auth?.current?.principalId;
      recordApprovalDenied(ctx.session.id, callId, denier);
    },
  },
});
