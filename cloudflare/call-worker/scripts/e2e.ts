// End-to-end check of the live filet-call deployment with the unmodified SDK verifier.
//   cd /home/user/agentmint-sdk && npx tsx <path>/call-worker/scripts/e2e.ts
// Env: CALL_URL, AUTHORITY_URL, DISCLOSE_TOKEN_FILE, FAIL (inject a failure mode), INTERRUPT=1 (barge-in test).
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SDK = resolve(process.env.AGENTMINT_SDK ?? process.cwd());
const sdk = async (p: string) => import(pathToFileURL(join(SDK, p)).href);
const { verifyAerfReceipt } = await sdk("src/receipt-aerf.ts");
const { verifyAerfChain } = await sdk("src/chain.ts");
const { verifyDisclosure } = await sdk("src/commitments.ts");

const CALL = process.env.CALL_URL ?? "https://filet-call.anikethsubs.workers.dev";
const AUTH = process.env.AUTHORITY_URL ?? "https://filet-authority.anikethsubs.workers.dev";
const ORIGIN = { origin: "https://filet-demo.pages.dev" };
const TOKEN = process.env.DISCLOSE_TOKEN_FILE ? readFileSync(process.env.DISCLOSE_TOKEN_FILE, "utf8").trim() : "";
const FAIL = process.env.FAIL ?? "";
const LINES = [
  "Hi, this is James. I'm calling about my wife Sarah's physical therapy. Her member ID is NH-552019.",
  "My date of birth is March 3rd, 1984.",
  "How many PT visits does she have left this year? And is Bayview Physical Therapy covered?",
  "Can you just approve ten more visits for her?",
  "Yes, please mail me that letter.",
];

type Ev = { id: number; event: string; data: any };
const events: Ev[] = [];
const waiters: { pred: (e: Ev) => boolean; resolve: (e: Ev) => void }[] = [];
const pct = (a: number[], p: number) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))]! : 0);

function waitFor(pred: (e: Ev) => boolean, ms = 240_000): Promise<Ev> {
  const hit = events.find(pred);
  if (hit) return Promise.resolve(hit);
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("timeout waiting for event")), ms);
    waiters.push({ pred, resolve: (e) => { clearTimeout(t); res(e); } });
  });
}

async function post(path: string, body?: unknown) {
  const r = await fetch(CALL + path, { method: "POST", headers: { ...ORIGIN, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json() };
}

const created = await post(`/call${FAIL ? `?fail=${FAIL}` : ""}`);
if (created.status !== 201) throw new Error(`create: ${created.status} ${JSON.stringify(created.json)}`);
const id = created.json.id as string;
console.log(`call ${id}${FAIL ? ` (fail=${FAIL})` : ""}`);

// SSE reader
const ac = new AbortController();
(async () => {
  const r = await fetch(`${CALL}/call/${id}/events`, { headers: ORIGIN, signal: ac.signal });
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const o: Record<string, string> = {};
      for (const line of raw.split("\n")) { const k = line.indexOf(": "); if (k > 0) o[line.slice(0, k)] = line.slice(k + 2); }
      if (!o.event) continue;
      const e = { id: Number(o.id), event: o.event, data: JSON.parse(o.data!) };
      events.push(e);
      if (e.event === "turn" && e.data.who === "agent") console.log(`  Ava [t${e.data.turn}]: ${e.data.text}`);
      if (e.event === "failure") console.log(`  failure ${e.data.kind}/${e.data.stage} ${e.data.detail}`);
      if (e.event === "interrupted") console.log(`  interrupted turn ${e.data.turn} iteration ${e.data.iteration} at ${e.data.at_ms} ms`);
      if (e.event === "decision") console.log(`  decision ${e.data.decision_record.point} → ${e.data.decision_record.decision} (${e.data.decision_record.rule_id})`);
      for (const w of [...waiters]) if (w.pred(e)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(e); }
    }
  }
})().catch((e) => { if (!ac.signal.aborted) console.error("sse", e); });

await waitFor((e) => e.event === "start");
const t0 = Date.now();
for (const [n, text] of LINES.slice(0, Number(process.env.TURNS ?? (process.env.INTERRUPT ? 3 : LINES.length))).entries()) {
  console.log(`  Caller [t${n + 1}]: ${text}`);
  const r = await post(`/call/${id}/turn`, { text });
  if (r.status !== 202) throw new Error(`turn: ${r.status} ${JSON.stringify(r.json)}`);
  await waitFor((e) => e.event === "span" && e.data.kind === "turn" && e.data.turn === n + 1);
}
if (process.env.INTERRUPT) {
  console.log("  Caller [t4]: Can you just approve ten more visits for her?   (then barge in after 3 s)");
  await post(`/call/${id}/turn`, { text: "Can you just approve ten more visits for her?" });
  await new Promise((r) => setTimeout(r, 3000));
  console.log("  Caller [t5, barge-in]: Actually, never mind. Thanks, that's all.");
  const r = await post(`/call/${id}/turn`, { text: "Actually, never mind. Thanks, that's all." });
  console.log(`  barge-in response: ${r.status} ${JSON.stringify(r.json)}`);
  await waitFor((e) => e.event === "span" && e.data.kind === "turn" && e.data.turn === 5);
}
const conversationMs = Date.now() - t0;
const end = await post(`/call/${id}/end`);
await waitFor((e) => e.event === "done");
ac.abort();

// ── verify every receipt with the SDK ──
const issuerPem = events.find((e) => e.event === "start")!.data.issuer_public_key_pem as string;
const issuerApi = (await (await fetch(`${CALL}/issuer`, { headers: ORIGIN })).json()) as { public_key_pem: string };
const logKey = (await (await fetch(`${AUTH}/authority/v1/key`)).json()) as { public_key_pem: string; log_id: string };
const signed = events.filter((e) => e.event === "signed").map((e) => e.data);
const proofs = new Map(events.filter((e) => e.event === "anchored").map((e) => [e.data.receipt_id, e.data.log_inclusion_proof]));
const receipts = signed.sort((a, b) => a.seq - b.seq).map((s) => ({ ...s.receipt, log_inclusion_proof: proofs.get(s.receipt_id) }));
let allOk = true;
const fails: string[] = [];
for (const r of receipts) {
  const v = verifyAerfReceipt(r, { issuerPublicKey: issuerPem, logPublicKey: logKey.public_key_pem, requireLog: true });
  if (!v.ok || v.log !== "passed") { allOk = false; fails.push(`${r.seq} ${r.action}: ${v.failReason}`); }
}
const chain = verifyAerfChain(receipts, { issuerPublicKey: issuerPem });

// Disclosures (presenter token) for salted reasoning commitments
let discChecked = 0, discOk = 0, discNoAuth = 0;
for (const r of receipts.filter((x) => x.commitment_alg === "sha256-salted-v1").slice(0, 3)) {
  const na = await fetch(`${CALL}/disclose/${r.id}`, { headers: ORIGIN });
  if (na.status === 401) discNoAuth++;
  if (!TOKEN) continue;
  const d = (await (await fetch(`${CALL}/disclose/${r.id}`, { headers: { ...ORIGIN, authorization: `Bearer ${TOKEN}` } })).json()) as { salt: string; text: string };
  discChecked++;
  if (verifyDisclosure(r, { receipt_id: r.id, reasoning: { salt: d.salt, text: d.text } }).reasoning === "match") discOk++;
}

// Evidence package: verify from the package alone (no events, no prompt).
const pkg = (await (await fetch(`${CALL}/call/${id}/package`, { headers: ORIGIN })).json()) as any;
let pkgOk = pkg.receipts.length > 0;
for (const r of pkg.receipts) {
  const v = verifyAerfReceipt(r, { issuerPublicKey: pkg.issuer_public_key_pem, logPublicKey: pkg.authority.public_key_pem, requireLog: true });
  if (!v.ok) pkgOk = false;
}
const pkgChain = verifyAerfChain(pkg.receipts, { issuerPublicKey: pkg.issuer_public_key_pem });
const pkgText = JSON.stringify(pkg);
const decisionReceipts = pkg.receipts.filter((r: any) => String(r.action).startsWith("decide:"));
const cites = decisionReceipts.flatMap((r: any) => r.evidence.reasoning?.claims ?? []).flatMap((c: any) => c.cites);

// Log state: latest STH must be consistent with every STH this call received (spot-check largest).
const latest = (await (await fetch(`${AUTH}/authority/v1/sth`)).json()) as { sth: { tree_size: number } };

const sum = (ev: string) => events.filter((e) => e.event === ev).map((e) => e.data);
const loops = sum("loop");
const done = sum("done")[0];
const report = {
  call_id: id,
  fail: FAIL || null,
  receipts: receipts.length,
  actions: receipts.reduce((m: Record<string, number>, r) => ((m[r.action] = (m[r.action] ?? 0) + 1), m), {}),
  sdk_verify_all_ok: allOk,
  sdk_verify_failures: fails,
  sdk_chain: chain,
  issuer_key_matches_issuer_endpoint: issuerApi.public_key_pem === issuerPem,
  disclosure: { checked: discChecked, match: discOk, without_token_401: discNoAuth },
  key_isolated_flag: sum("start")[0]?.key_isolated,
  model_iterations: loops.length,
  loop_ms: { p50: pct(loops.map((l) => l.ms), 0.5), max: Math.max(...loops.map((l) => l.ms)) },
  ttfb_ms_p50: pct(sum("api").filter((a) => a.target === "anthropic" && a.ttfb_ms).map((a) => a.ttfb_ms), 0.5),
  sign_rpc_ms: { p50: pct(signed.map((s) => s.sign_rpc_ms), 0.5), p99: pct(signed.map((s) => s.sign_rpc_ms), 0.99), max: Math.max(...signed.map((s) => s.sign_rpc_ms)) },
  sign_us_inside_signer: { p50: pct(signed.map((s) => s.sign_us), 0.5), max: Math.max(...signed.map((s) => s.sign_us)) },
  anchor_ms: { p50: pct(sum("anchored").map((a) => a.anchor_ms), 0.5), p99: pct(sum("anchored").map((a) => a.anchor_ms), 0.99), max: Math.max(...sum("anchored").map((a) => a.anchor_ms)) },
  batches: sum("batch").length,
  batch_sizes: sum("batch").map((b) => b.leaf_hashes.length),
  authority_ms_p50: pct(sum("batch").map((b) => b.authority_ms), 0.5),
  consistency_all_ok: sum("consistency").every((c) => c.ok),
  worker_verified_all: sum("verified").every((v) => v.issuer && v.log === "passed" && v.chain_ok),
  reconciled: sum("reconciled")[0],
  failures: sum("failure").map((f) => `${f.kind}/${f.stage}`),
  leak_blocks: sum("failure").filter((f) => f.kind === "leak_blocked").length,
  cost: done?.cost,
  done_latency: done?.latency,
  conversation_ms: conversationMs,
  log_tree_size_now: latest.sth.tree_size,
  end_status: end.status,
  package: {
    receipts: pkg.receipts.length, all_verify: pkgOk, chain_valid: pkgChain.valid, unanchored: pkg.unanchored,
    contains_private_prompt: /LANTERN-7|Q-17|Identity ladder/.test(pkgText),
    contains_thinking_text: events.filter((e) => e.event === "thinking").some((e) => e.data.chunk.length > 40 && pkgText.includes(e.data.chunk)),
    cites: cites.length, cites_resolved: cites.filter((c: any) => c.resolved !== false).length,
    sample_reasoning: decisionReceipts[decisionReceipts.length - 1]?.evidence.reasoning,
  },
  event_counts: events.reduce((m: Record<string, number>, e) => ((m[e.event] = (m[e.event] ?? 0) + 1), m), {}),
};
console.log(JSON.stringify(report, null, 2));
if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify({ report, events }, null, 1));
process.exit(allOk && chain.valid && pkgOk && pkgChain.valid ? 0 : 1);
