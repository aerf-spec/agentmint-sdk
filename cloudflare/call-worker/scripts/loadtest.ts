// Load test: 200 concurrent turns' worth of decisions against the live authority.
//   cd /home/user/agentmint-sdk && REGISTRATION_TOKEN_FILE=... npx tsx <path>/scripts/loadtest.ts
// A: 200 concurrent clients (one per turn), each posts its own batch of 3 receipts at once (worst case: no batching).
// B: the same volume batched like the call-worker does (64 leaves/batch), 10 concurrent batches.
// Every proof is verified with the SDK's verifyAerfReceipt. Also measures signing µs locally.
import { readFileSync } from "node:fs";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as C from "../../shared/canonical.ts";

const SDK = resolve(process.env.AGENTMINT_SDK ?? process.cwd());
const sdk = async (p: string) => import(pathToFileURL(join(SDK, p)).href);
const { Notary } = await sdk("src/notary.ts");
const { verifyAerfReceipt } = await sdk("src/receipt-aerf.ts");
const { logLeafHash } = await sdk("src/merkle.ts");
const { signedPayloadBytes } = await sdk("src/kernel/sign.ts");

const AUTH = process.env.AUTHORITY_URL ?? "https://filet-authority.anikethsubs.workers.dev";
const TOKEN = readFileSync(process.env.REGISTRATION_TOKEN_FILE!, "utf8").trim();
const TURNS = Number(process.env.TURNS ?? 200);
const PER_TURN = 3;
const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))]!;
const stats = (a: number[]) => ({ n: a.length, p50: +pct(a, 0.5).toFixed(1), p90: +pct(a, 0.9).toFixed(1), p99: +pct(a, 0.99).toFixed(1), max: +Math.max(...a).toFixed(1) });

const issuer = generateKeyPairSync("ed25519");
const notary = new Notary({ privateKeyPem: issuer.privateKey.export({ type: "pkcs8", format: "pem" }) as string });
const reg = await fetch(`${AUTH}/authority/v1/issuers`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ public_key_pem: notary.publicKeyPem }) });
const keyId = ((await reg.json()) as { key_id: string }).key_id;
const logKey = ((await (await fetch(`${AUTH}/authority/v1/key`)).json()) as { public_key_pem: string }).public_key_pem;

function makeTurn(t: number) {
  const plan = notary.createPlan({ user: "loadtest", action: "member-line", scope: ["decide:*"] });
  return Array.from({ length: PER_TURN }, (_, i) =>
    notary.notarise({ plan, agent: "ava-member-line", action: "decide:visits_remaining", evidence: { turn: t, i, rule_id: "BEN-2" } }) as Record<string, unknown>);
}
function batchBody(leaves: string[]) {
  const batch_ts = new Date().toISOString().replace(/\.(\d{3})Z$/, ".$1000+00:00");
  const digest = createHash("sha256").update(Buffer.concat([...leaves.map((h) => Buffer.from(h, "hex")), Buffer.from(batch_ts)])).digest();
  return { key_id: keyId, leaf_hashes: leaves, batch_signature: edSign(null, digest, issuer.privateKey).toString("hex"), batch_ts };
}
async function postBatch(receipts: Record<string, unknown>[]) {
  const leaves = receipts.map((r) => logLeafHash(signedPayloadBytes(r)));
  const t0 = performance.now();
  const res = await fetch(`${AUTH}/authority/v1/batches`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(batchBody(leaves)) });
  const rtt = performance.now() - t0;
  const body = (await res.json()) as any;
  let verified = 0;
  if (res.status === 200) {
    receipts.forEach((r, i) => {
      const v = verifyAerfReceipt({ ...r, log_inclusion_proof: body.proofs[i] }, { issuerPublicKey: notary.publicKeyPem, logPublicKey: logKey, requireLog: true });
      if (v.ok && v.log === "passed") verified++;
    });
  }
  return { status: res.status, rtt, authority_ms: body.authority_ms as number, verified, n: receipts.length, retryAfter: res.headers.get("retry-after") };
}

// Warm-up (cold isolate / DO) excluded from stats.
await postBatch(makeTurn(-1));

// ── Scenario A ──
const turnsA = Array.from({ length: TURNS }, (_, t) => makeTurn(t));
const tA = performance.now();
const resA = await Promise.all(turnsA.map(postBatch));
const wallA = performance.now() - tA;

// ── Scenario B ──
const allB = Array.from({ length: TURNS }, (_, t) => makeTurn(1000 + t)).flat();
const batchesB: Record<string, unknown>[][] = [];
for (let i = 0; i < allB.length; i += 64) batchesB.push(allB.slice(i, i + 64));
const tB = performance.now();
const resB = await Promise.all(batchesB.map(postBatch));
const wallB = performance.now() - tB;

// ── Signing µs (same canonical + WebCrypto code the signer Worker runs; and SDK node:crypto) ──
const der = issuer.privateKey.export({ type: "pkcs8", format: "der" }) as Buffer;
const k = await C.loadPrivateKey(der.subarray(der.length - 32).toString("hex"));
const wc: number[] = [];
const sdkSign: number[] = [];
const sample = allB.slice(0, 600);
for (const r of sample) {
  const { signature: _s, ...unsigned } = r;
  const t0 = performance.now();
  const payload = C.signedPayloadBytes(unsigned);
  await C.edSign(k.key, payload);
  wc.push((performance.now() - t0) * 1000);
}
const plan = notary.createPlan({ user: "bench", action: "member-line", scope: ["decide:*"] });
for (let i = 0; i < 600; i++) {
  const t0 = performance.now();
  notary.notarise({ plan, agent: "ava-member-line", action: "decide:x", evidence: { i } });
  sdkSign.push((performance.now() - t0) * 1000);
}

const summarize = (rs: Awaited<ReturnType<typeof postBatch>>[], wall: number) => ({
  requests: rs.length,
  receipts: rs.reduce((a, r) => a + r.n, 0),
  ok_200: rs.filter((r) => r.status === 200).length,
  status_other: rs.filter((r) => r.status !== 200).map((r) => r.status),
  proofs_verified_by_sdk: rs.reduce((a, r) => a + r.verified, 0),
  client_rtt_ms: stats(rs.map((r) => r.rtt)),
  authority_ms: stats(rs.filter((r) => r.status === 200).map((r) => r.authority_ms)),
  wall_ms: Math.round(wall),
  receipts_per_s: Math.round((rs.reduce((a, r) => a + r.n, 0) / wall) * 1000),
});
console.log(JSON.stringify({
  authority: AUTH,
  A_unbatched_200_concurrent: summarize(resA, wallA),
  B_batched_64: summarize(resB, wallB),
  signing_us_webcrypto_canonical_node: stats(wc),
  signing_us_sdk_notarise_node: stats(sdkSign),
  note: "client_rtt includes the network path from this test host (via an egress proxy) to Cloudflare; authority_ms is measured inside the log DO (Workers clock: advances on I/O only, so CPU-only work reads ~0).",
}, null, 2));
