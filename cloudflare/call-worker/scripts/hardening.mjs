// Live hardening checks for filet-call + filet-authority (no Claude calls).
import { readFileSync } from "node:fs";
const CALL = "https://filet-call.anikethsubs.workers.dev", AUTH = "https://filet-authority.anikethsubs.workers.dev";
const GOOD = "https://filet-demo.pages.dev", PREVIEW = "https://3f2a1b.filet-demo.pages.dev", EVIL = "https://evil.example";
const R = [];
const check = (name, ok, got) => { R.push({ name, ok: !!ok, got }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}  (${got})`); };
const f = (url, o = {}) => fetch(url, o).then(async (r) => ({ s: r.status, h: r.headers, t: await r.text() }));
const J = { "content-type": "application/json" };

// CORS
let r = await f(`${CALL}/healthz`, { headers: { origin: GOOD } }); check("call: ACAO for filet-demo.pages.dev", r.h.get("access-control-allow-origin") === GOOD, r.h.get("access-control-allow-origin"));
r = await f(`${CALL}/healthz`, { headers: { origin: PREVIEW } }); check("call: ACAO for preview subdomain", r.h.get("access-control-allow-origin") === PREVIEW, r.h.get("access-control-allow-origin"));
r = await f(`${CALL}/healthz`, { headers: { origin: "http://localhost:5173" } }); check("call: ACAO for localhost", r.h.get("access-control-allow-origin") === "http://localhost:5173", r.h.get("access-control-allow-origin"));
r = await f(`${CALL}/healthz`, { headers: { origin: EVIL } }); check("call: no ACAO for other origins", !r.h.get("access-control-allow-origin"), r.h.get("access-control-allow-origin"));
r = await f(`${CALL}/call`, { method: "OPTIONS", headers: { origin: EVIL, "access-control-request-method": "POST" } }); check("call: preflight from other origin refused", r.s === 403, r.s);
r = await f(`${CALL}/call`, { method: "POST", headers: { origin: EVIL } }); check("call: cross-site POST refused", r.s === 403, r.s);
r = await f(`${AUTH}/authority/v1/batches`, { method: "OPTIONS", headers: { origin: GOOD, "access-control-request-method": "POST" } }); check("authority: preflight POST allowed for allowlist", r.s === 204, r.s);
r = await f(`${AUTH}/authority/v1/batches`, { method: "OPTIONS", headers: { origin: EVIL, "access-control-request-method": "POST" } }); check("authority: preflight POST refused for others", r.s === 403, r.s);
r = await f(`${AUTH}/authority/v1/sth`, { headers: { origin: EVIL } }); check("authority: no ACAO for others", !r.h.get("access-control-allow-origin"), r.h.get("access-control-allow-origin"));

// Create one call to test input validation on (greeting only, no model call)
r = await f(`${CALL}/call`, { method: "POST", headers: { origin: GOOD, ...J }, body: "{}" });
const id = JSON.parse(r.t).id;
check("call: create", r.s === 201, r.s);
r = await f(`${CALL}/call/${id}/turn`, { method: "POST", headers: { origin: GOOD, ...J }, body: JSON.stringify({ text: "x".repeat(2049) }) }); check("turn: >2 KB rejected", r.s === 413, r.s);
r = await f(`${CALL}/call/${id}/turn`, { method: "POST", headers: { origin: GOOD, ...J }, body: JSON.stringify({ text: "hi", extra: 1 }) }); check("turn: unknown field rejected", r.s === 400, `${r.s} ${r.t}`);
r = await f(`${CALL}/call/${id}/turn`, { method: "POST", headers: { origin: GOOD, "content-type": "text/plain" }, body: "hi" }); check("turn: non-JSON rejected", r.s === 415, r.s);
r = await f(`${CALL}/call/${id}/turn`, { method: "POST", headers: { origin: GOOD, ...J }, body: JSON.stringify({ text: 5 }) }); check("turn: wrong type rejected", r.s === 400, r.s);
r = await f(`${CALL}/call/${id}/turn`, { method: "POST", headers: { origin: GOOD, ...J }, body: "x".repeat(10000) }); check("turn: oversized body rejected", r.s === 413, r.s);
r = await f(`${CALL}/call?fail=bogus`, { method: "POST", headers: { origin: GOOD } }); check("call: bad fail mode rejected", r.s === 400 || r.s === 429, r.s);
r = await f(`${CALL}/call/00000000-0000-4000-8000-000000000000/turn`, { method: "POST", headers: { origin: GOOD, ...J }, body: JSON.stringify({ text: "hi" }) }); check("turn: unknown call 404", r.s === 404, r.s);
r = await f(`${CALL}/disclose/${id}-r1`); check("disclose: no token 401", r.s === 401, r.s);
r = await f(`${CALL}/disclose/${id}-r1`, { headers: { authorization: "Bearer nope" } }); check("disclose: wrong token 401", r.s === 401, r.s);
const tok = readFileSync(process.argv[2], "utf8").trim();
r = await f(`${CALL}/disclose/${id}-r1`, { headers: { authorization: `Bearer ${tok}` } }); check("disclose: greeting receipt has no reasoning to open → 404", r.s === 404, r.s);
r = await f(`${CALL}/call/${id}/end`, { method: "POST", headers: { origin: GOOD } }); check("call: end", r.s === 200, r.s);

// Rate limits (per IP)
let s429 = null, n = 0;
for (let i = 0; i < 32 && !s429; i++) { n++; const x = await f(`${CALL}/call/${id}/turn`, { method: "POST", headers: { origin: GOOD, ...J }, body: JSON.stringify({ text: "hi" }) }); if (x.s === 429) s429 = x; }
check("turns: 30/min per IP → 429 + Retry-After", s429 && s429.h.get("retry-after"), s429 ? `429 after ${n} requests, retry-after ${s429.h.get("retry-after")}` : "no 429");
s429 = null; n = 0;
for (let i = 0; i < 7 && !s429; i++) { n++; const x = await f(`${CALL}/call`, { method: "POST", headers: { origin: GOOD } }); if (x.s === 429) s429 = x; }
check("calls: 5/min per IP → 429 + Retry-After", s429 && s429.h.get("retry-after"), s429 ? `429 after ${n} more creates, retry-after ${s429.h.get("retry-after")}` : "no 429");

// Authority auth + validation
r = await f(`${AUTH}/authority/v1/issuers`, { method: "POST", headers: J, body: JSON.stringify({ public_key_pem: "x" }) }); check("authority: issuer registration needs bearer", r.s === 401, r.s);
r = await f(`${AUTH}/authority/v1/batches`, { method: "POST", headers: J, body: JSON.stringify({ key_id: "0123456789abcdef", leaf_hashes: ["a".repeat(64)], batch_signature: "0".repeat(128), batch_ts: "2020-01-01T00:00:00.000000+00:00" }) }); check("authority: stale batch_ts rejected", r.s === 400 && /window/.test(r.t), `${r.s} ${r.t}`);
r = await f(`${AUTH}/authority/v1/batches`, { method: "POST", headers: J, body: JSON.stringify({ key_id: "0123456789abcdef", leaf_hashes: Array.from({ length: 1025 }, (_, i) => i.toString(16).padStart(64, "0")), batch_signature: "0".repeat(128), batch_ts: new Date().toISOString() }) }); check("authority: >1024 leaves rejected", r.s === 413, r.s);
r = await f(`${AUTH}/authority/v1/batches`, { method: "POST", headers: J, body: JSON.stringify({ key_id: "0123456789abcdef", leaf_hashes: ["a".repeat(64)], batch_signature: "0".repeat(128), batch_ts: new Date().toISOString(), x: 1 }) }); check("authority: unknown field rejected", r.s === 400, `${r.s} ${r.t}`);
r = await f(`${AUTH}/authority/v1/batches`, { method: "POST", headers: J, body: JSON.stringify({ key_id: "0123456789abcdef", leaf_hashes: ["a".repeat(64)], batch_signature: "0".repeat(128), batch_ts: new Date().toISOString() }) }); check("authority: unknown issuer 403", r.s === 403, r.s);
s429 = null; n = 0;
for (let i = 0; i < 12 && !s429; i++) { n++; const x = await f(`${AUTH}/authority/v1/issuers`, { method: "POST", headers: J, body: "{}" }); if (x.s === 429) s429 = x; }
check("authority: issuer endpoint 10/min per IP → 429", !!s429, s429 ? `429 after ${n}` : "none");

// Signer has no public route
try { const x = await fetch("https://filet-signer.anikethsubs.workers.dev/", { signal: AbortSignal.timeout(8000) }); check("signer: not publicly reachable", x.status === 404 || x.status >= 500, x.status); }
catch (e) { check("signer: not publicly reachable", true, String(e.cause?.code ?? e.message)); }
console.log(`\n${R.filter((x) => x.ok).length}/${R.length} passed`);
