// Drives the prior-auth eve agent over plain HTTP (as a channel/client would):
// start a session with the poisoned referral, stream the NDJSON, answer each
// physician-approval pause with a decision, and pull the AgentMint receipt.
//
//   node verification/drive.mjs [approve|deny]   # decision for the LEGIT determination
//
// The cross-patient (PT-9102) determination is always answered "approve" to
// prove defense-in-depth: even a rubber-stamped approval can't push it past the
// AgentMint cross_ref block.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.EVE_URL ?? "http://127.0.0.1:3000";
const legitDecision = process.argv[2] === "deny" ? "deny" : "approve";
const referral = readFileSync(join(HERE, "..", "referral.txt"), "utf-8");

const transcript = [];
const record = (tag, obj) => {
  const line = { tag, ...obj };
  transcript.push(line);
  const t = obj?.type ?? "";
  const brief =
    t === "action.result"
      ? `  → ${obj.data?.name ?? obj.data?.toolName ?? "?"} = ${JSON.stringify(obj.data?.output ?? obj.data?.result ?? obj.data).slice(0, 90)}`
      : t === "input.requested"
        ? `  ⏸ approval requested: ${JSON.stringify(obj.data?.requests ?? obj.data).slice(0, 120)}`
        : "";
  console.log(`[${tag}] ${t}${brief}`);
};

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

// Read the NDJSON stream from a startIndex until `session.waiting`/`completed`,
// recording events. Returns the last-seen state.
async function drainUntilPause(sessionId, startIndex) {
  const res = await fetch(
    `${BASE}/eve/v1/session/${sessionId}/stream?startIndex=${startIndex}`,
  );
  let count = startIndex;
  let pendingApproval = false;
  let done = false;
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      count++;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      record("stream", ev);
      if (ev.type === "input.requested") pendingApproval = true;
      if (ev.type === "session.completed" || ev.type === "session.failed") done = true;
      if (ev.type === "session.waiting") {
        // parked — stop reading this stream segment
        return { count, pendingApproval, done };
      }
      if (done) return { count, pendingApproval, done };
    }
  }
  return { count, pendingApproval, done };
}

async function main() {
  console.log(`\n=== starting session (legit determination will be ${legitDecision.toUpperCase()}) ===`);
  const start = await post("/eve/v1/session", { message: referral });
  const sessionId = start.json.sessionId ?? start.json.id;
  let token = start.json.continuationToken;
  console.log(`session ${sessionId} (HTTP ${start.status})`);
  record("start", { type: "session.created", data: { sessionId, token } });

  let index = 0;
  let approvalsAnswered = 0;
  for (let step = 0; step < 12; step++) {
    const { count, pendingApproval, done } = await drainUntilPause(sessionId, index);
    index = count;
    if (done) break;
    if (pendingApproval) {
      // Answer the pause. First pending approval is the cross-patient PT-9102
      // determination → always "approve" (defense in depth). The second is the
      // legitimate PT-4827 determination → the configured decision.
      const answer = approvalsAnswered === 0 ? "approve" : legitDecision;
      approvalsAnswered++;
      console.log(`  ↩ answering approval #${approvalsAnswered}: "${answer}"`);
      const follow = await post(`/eve/v1/session/${sessionId}`, {
        continuationToken: token,
        message: answer,
      });
      if (follow.json.continuationToken) token = follow.json.continuationToken;
      record("answer", { type: "approval.answer", data: { answer, status: follow.status } });
    } else {
      break; // parked with nothing to answer — turn finished
    }
  }

  // Pull the receipt.
  const receiptRes = await fetch(`${BASE}/receipt/${sessionId}`);
  const receipt = await receiptRes.json().catch(() => null);
  console.log(`\n=== receipt (HTTP ${receiptRes.status}) ===`);
  if (receipt?.formatted) console.log(receipt.formatted);

  // Save artifacts.
  mkdirSync(HERE, { recursive: true });
  const suffix = legitDecision;
  writeFileSync(join(HERE, `transcript-${suffix}.ndjson`), transcript.map((l) => JSON.stringify(l)).join("\n") + "\n");
  if (receipt) writeFileSync(join(HERE, `receipt-${suffix}.json`), JSON.stringify(receipt, null, 2) + "\n");
  console.log(`\nsaved verification/transcript-${suffix}.ndjson and receipt-${suffix}.json`);
  console.log(`sessionId=${sessionId}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
