// GET /receipt/:sessionId — the AgentMint receipt for one eve session, as the
// formatted terminal box plus the raw JSONL evidence. This is the "receipts
// survive as session artifacts, retrievable over HTTP" half of the demo: a
// compliance reviewer pulls the signed audit trail for any session by id.
import { defineChannel, GET } from "eve/channels";
import {
  hasReceipt,
  sessionReceipt,
  sessionReceiptText,
  sessionJSONL,
} from "../lib/agentmint.js";

export default defineChannel({
  routes: [
    GET("/receipt/:sessionId", async (req, { params }) => {
      const sessionId = params.sessionId;
      if (!hasReceipt(sessionId)) {
        return Response.json({ error: `No receipt for session ${sessionId}` }, { status: 404 });
      }

      const url = new URL(req.url);
      const format = url.searchParams.get("format");
      const jsonl = sessionJSONL(sessionId);

      if (format === "jsonl") {
        return new Response((jsonl ?? "") + "\n", {
          headers: { "content-type": "application/x-ndjson; charset=utf-8" },
        });
      }
      if (format === "text") {
        return new Response((sessionReceiptText(sessionId) ?? "") + "\n", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }

      // Default: JSON with the AERF record, the rendered box, the evidence root,
      // and the JSONL lines.
      return Response.json({
        sessionId,
        receipt: sessionReceipt(sessionId),
        evidenceRoot: sessionReceipt(sessionId)?.evidenceRoot ?? null,
        formatted: sessionReceiptText(sessionId),
        jsonl: jsonl ? jsonl.split("\n") : [],
      });
    }),
  ],
});
