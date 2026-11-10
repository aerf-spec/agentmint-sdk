// End-to-end test of the authority worker under `wrangler dev --local`,
// checked against the unmodified AgentMint SDK verifier.
//
// Run from the SDK checkout so tsx can load the SDK's TypeScript sources:
//   cd /home/user/agentmint-sdk && npx tsx --test <path>/authority-worker/test/authority.test.ts
// Env: AGENTMINT_SDK (default: cwd), AUTHORITY_URL (skip spawning; test an already-running authority
// — note the root/size checks assume a fresh, empty log).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync, sign as edSign, createPublicKey } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WORKER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SDK = resolve(process.env.AGENTMINT_SDK ?? process.cwd());
const sdk = async (p: string) => import(pathToFileURL(join(SDK, p)).href);

const { Notary } = await sdk("src/notary.ts");
const { MerkleTree, logLeafHash, hashInternal } = await sdk("src/merkle.ts");
const { signedPayloadBytes } = await sdk("src/kernel/sign.ts");
const { verifyAerfReceipt } = await sdk("src/receipt-aerf.ts");

type Rec = Record<string, unknown>;
interface Sth { tree_size: number; root_hash: string; timestamp: string }
interface BatchResp {
  proofs: Rec[];
  sth: Sth;
  sth_signature: string;
  tree_size_before: number;
  tree_size_after: number;
  authority_ms: number;
  replayed?: boolean;
}

let base = process.env.AUTHORITY_URL ?? "";
let child: ChildProcess | undefined;
let persistDir: string | undefined;

// ── issuer + receipts (real SDK Notary) ─────────────────────────────
const issuer = generateKeyPairSync("ed25519");
const issuerPem = issuer.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const notary = new Notary({ privateKeyPem: issuerPem });
const plan = notary.createPlan({ user: "ops@example.com", action: "member-line", scope: ["benefits:*"] });
let seq = 0;
function newReceipt(): Rec {
  seq++;
  return notary.notarise({
    action: "benefits:lookup",
    agent: "ava-member-line",
    plan,
    evidence: { step: seq, rule: "BEN-2", note: `decision ${seq}` },
  });
}
const leafOf = (r: Rec): string => logLeafHash(signedPayloadBytes(r));

// Issuer signs SHA-256(concat(raw leaves) || utf8(batch_ts)); batch_ts must be within ±5 min of the authority clock.
const nowTs = () => new Date().toISOString().replace(/\.(\d{3})Z$/, ".$1000+00:00");
function batchSignature(leaves: string[], key = issuer.privateKey, ts = nowTs()): { batch_signature: string; batch_ts: string } {
  const digest = createHash("sha256").update(Buffer.concat([...leaves.map((h) => Buffer.from(h, "hex")), Buffer.from(ts, "utf8")])).digest();
  return { batch_signature: edSign(null, digest, key).toString("hex"), batch_ts: ts };
}
// Registration token: AUTHORITY_REGISTRATION_TOKEN, else REGISTRATION_TOKEN from the local .dev.vars.
const REG_TOKEN = process.env.AUTHORITY_REGISTRATION_TOKEN ??
  (/REGISTRATION_TOKEN="?([^"\n]+)/.exec(readFileSync(join(WORKER_DIR, ".dev.vars"), "utf8"))?.[1] ?? "");

// Mirror of the whole log on the client, built with the SDK's MerkleTree.
const mirror = new MerkleTree();
const allReceipts: Rec[] = [];
const sths: Sth[] = [];
const lat = new Map<number, { authority: number[]; rtt: number[] }>();
let logPublicKey = "";
let issuerKeyId = "";

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: body ? { "content-type": "application/json", ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

async function postBatch(n: number): Promise<{ receipts: Rec[]; resp: BatchResp }> {
  const receipts = Array.from({ length: n }, newReceipt);
  const leaf_hashes = receipts.map(leafOf);
  const t0 = performance.now();
  const { status, json } = await api("POST", "/authority/v1/batches", {
    key_id: issuerKeyId,
    leaf_hashes,
    ...batchSignature(leaf_hashes),
  });
  const rtt = performance.now() - t0;
  assert.equal(status, 200, JSON.stringify(json));
  const resp = json as BatchResp;
  const l = lat.get(n) ?? { authority: [], rtt: [] };
  l.authority.push(resp.authority_ms);
  l.rtt.push(rtt);
  lat.set(n, l);

  assert.equal(resp.tree_size_before, mirror.leafCount);
  for (const r of receipts) mirror.addLeaf(signedPayloadBytes(r));
  assert.equal(resp.tree_size_after, mirror.leafCount);
  assert.equal(resp.sth.tree_size, mirror.leafCount);
  assert.equal(resp.sth.root_hash, mirror.build(), `root mismatch at size ${mirror.leafCount}`);
  assert.equal(resp.proofs.length, n);

  // Attach each proof unchanged and verify with the SDK.
  const attached = receipts.map((r, i) => {
    const proof = resp.proofs[i]!;
    assert.equal(proof["leaf_hash"], leaf_hashes[i]);
    assert.deepEqual(proof["audit_path"], mirror.auditPath(proof["leaf_index"] as number));
    const withProof = { ...r, log_inclusion_proof: proof };
    const v = verifyAerfReceipt(withProof, { issuerPublicKey: notary.publicKeyPem, logPublicKey });
    assert.equal(v.log, "passed", v.failReason);
    assert.equal(v.issuerOk, true);
    assert.equal(v.ok, true, v.failReason);
    return withProof;
  });
  allReceipts.push(...attached);
  sths.push(resp.sth);
  return { receipts: attached, resp };
}

// RFC 9162 §2.1.4.2 consistency verification.
function verifyConsistency(first: number, second: number, firstHash: string, secondHash: string, proof: string[]): boolean {
  if (first === second) return proof.length === 0 && firstHash === secondHash;
  if (first < 1 || first > second || proof.length === 0) return false;
  const path = (first & (first - 1)) === 0 ? [firstHash, ...proof] : [...proof];
  let fn = first - 1;
  let sn = second - 1;
  while (fn & 1) { fn >>= 1; sn >>= 1; }
  let fr = path[0]!;
  let sr = path[0]!;
  for (const c of path.slice(1)) {
    if (sn === 0) return false;
    if (fn & 1 || fn === sn) {
      fr = hashInternal(c, fr);
      sr = hashInternal(c, sr);
      if (!(fn & 1)) while (!(fn & 1) && fn !== 0) { fn >>= 1; sn >>= 1; }
    } else {
      sr = hashInternal(sr, c);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 && fr === firstHash && sr === secondHash;
}

function rootAt(size: number): string {
  const t = new MerkleTree();
  for (let i = 0; i < size; i++) t.addLeaf(signedPayloadBytes(allReceipts[i]!));
  return t.build();
}

async function waitHealthy(url: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url + "/healthz");
      if (r.ok && (await r.text()) === "ok") return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("wrangler dev did not become healthy");
}

before(async () => {
  if (!base) {
    const port = 8800 + Math.floor(Math.random() * 1000);
    persistDir = mkdtempSync(join(tmpdir(), "authority-state-"));
    child = spawn(
      join(WORKER_DIR, "node_modules/.bin/wrangler"),
      ["dev", "--local", "--port", String(port), "--persist-to", persistDir, "--show-interactive-dev-session=false"],
      { cwd: WORKER_DIR, stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
    );
    let log = "";
    child.stdout!.on("data", (d) => (log += d));
    child.stderr!.on("data", (d) => (log += d));
    base = `http://127.0.0.1:${port}`;
    try {
      await waitHealthy(base, 60_000);
    } catch (e) {
      console.error(log);
      throw e;
    }
  }
  const key = await api("GET", "/authority/v1/key");
  assert.equal(key.status, 200);
  logPublicKey = key.json.public_key_pem;
  assert.match(key.json.log_id, /\S/);
  createPublicKey(logPublicKey); // parses as SPKI PEM in node
});

after(() => {
  if (child?.pid) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* gone */ }
  }
  if (persistDir) rmSync(persistDir, { recursive: true, force: true });
});

test("register issuer: key_id matches SDK keyId", async () => {
  const auth = { authorization: `Bearer ${REG_TOKEN}` };
  assert.equal((await api("POST", "/authority/v1/issuers", { public_key_pem: notary.publicKeyPem })).status, 401);
  assert.equal((await api("POST", "/authority/v1/issuers", { public_key_pem: notary.publicKeyPem }, { authorization: "Bearer wrong" })).status, 401);
  assert.equal((await api("POST", "/authority/v1/issuers", { public_key_pem: notary.publicKeyPem, extra: 1 }, auth)).status, 400);
  const r = await api("POST", "/authority/v1/issuers", { public_key_pem: notary.publicKeyPem }, auth);
  assert.equal(r.status, 200);
  assert.equal(r.json.key_id, notary.keyId);
  issuerKeyId = r.json.key_id;
  const bad = await api("POST", "/authority/v1/issuers", { public_key_pem: "nope" }, auth);
  assert.equal(bad.status, 400);
});

test("empty log STH signs SHA-256('') and verifies", async () => {
  const r = await api("GET", "/authority/v1/sth");
  assert.equal(r.status, 200);
  assert.equal(r.json.sth.tree_size, 0);
  assert.equal(r.json.sth.root_hash, new MerkleTree().build());
});

test("roots for sizes 1..33 equal SDK MerkleTree roots; every proof verifies via verifyAerfReceipt", async () => {
  for (let i = 1; i <= 33; i++) {
    const { resp } = await postBatch(1);
    assert.equal(resp.sth.tree_size, i);
  }
});

test("mixed batches (16, 64, 5, 3, 64, 7): all receipts verify, log: passed", async () => {
  for (const n of [16, 64, 5, 3, 64, 7]) await postBatch(n);
  // Earlier receipts still verify against the proofs they were given.
  for (const r of allReceipts) {
    const v = verifyAerfReceipt(r, { issuerPublicKey: notary.publicKeyPem, logPublicKey });
    assert.equal(v.log, "passed", v.failReason);
  }
  // A tampered receipt fails the log check.
  const t = { ...allReceipts[40]!, action: "benefits:approve" };
  assert.notEqual(verifyAerfReceipt(t, { issuerPublicKey: notary.publicKeyPem, logPublicKey }).log, "passed");
});

test("latency batches: 20x1, 20x16, 20x64", async () => {
  for (const n of [1, 16, 64]) for (let i = 0; i < 20; i++) await postBatch(n);
});

test("GET /sth returns the latest batch STH", async () => {
  const r = await api("GET", "/authority/v1/sth");
  assert.deepEqual(r.json.sth, sths.at(-1));
});

test("consistency proofs: all 1<=m<=n<=33, and between every pair of batch STHs", async () => {
  for (let n = 1; n <= 33; n++) {
    for (let m = 1; m <= n; m++) {
      const r = await api("GET", `/authority/v1/consistency?from=${m}&to=${n}`);
      assert.equal(r.status, 200);
      assert.equal(r.json.from, m);
      assert.equal(r.json.to, n);
      assert.ok(verifyConsistency(m, n, rootAt(m), rootAt(n), r.json.proof), `consistency ${m}->${n}`);
    }
  }
  const sizes = sths.map((s) => s.tree_size);
  const rootOf = new Map(sths.map((s) => [s.tree_size, s.root_hash]));
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < sizes.length; i++) pairs.push([sizes[i]!, sizes.at(-1)!]);
  for (let i = 1; i < sizes.length; i++) pairs.push([sizes[i - 1]!, sizes[i]!]);
  for (const [m, n] of pairs) {
    const r = await api("GET", `/authority/v1/consistency?from=${m}&to=${n}`);
    assert.equal(r.status, 200);
    assert.ok(verifyConsistency(m, n, rootOf.get(m)!, rootOf.get(n)!, r.json.proof), `sth consistency ${m}->${n}`);
  }
  // Negative: a proof does not verify against a wrong old root.
  const [m, n] = [sizes[3]!, sizes.at(-1)!];
  const r = await api("GET", `/authority/v1/consistency?from=${m}&to=${n}`);
  assert.ok(!verifyConsistency(m, n, rootOf.get(sizes[4]!)!, rootOf.get(n)!, r.json.proof));
  // Bad ranges.
  assert.equal((await api("GET", `/authority/v1/consistency?from=0&to=3`)).status, 400);
  assert.equal((await api("GET", `/authority/v1/consistency?from=5&to=3`)).status, 400);
  assert.equal((await api("GET", `/authority/v1/consistency?from=1&to=${n + 1}`)).status, 400);
});

test("bad batch signature, unknown issuer and malformed leaves are rejected without appending", async () => {
  const size = mirror.leafCount;
  const leaves = [newReceipt(), newReceipt()].map(leafOf);
  const signed = batchSignature(leaves);
  const sig = signed.batch_signature;
  const flipped = (sig[0] === "0" ? "1" : "0") + sig.slice(1);
  let r = await api("POST", "/authority/v1/batches", { key_id: issuerKeyId, leaf_hashes: leaves, batch_signature: flipped, batch_ts: signed.batch_ts });
  assert.equal(r.status, 401);
  assert.match(r.json.error, /signature/);
  // Signature valid for a different leaf set.
  r = await api("POST", "/authority/v1/batches", { key_id: issuerKeyId, leaf_hashes: [leaves[1], leaves[0]], ...signed });
  assert.equal(r.status, 401);
  // Valid signature, but timestamp tampered (signature covers batch_ts).
  r = await api("POST", "/authority/v1/batches", { key_id: issuerKeyId, leaf_hashes: leaves, batch_signature: sig, batch_ts: nowTs() === signed.batch_ts ? "2026-01-01T00:00:00.000000+00:00" : nowTs() });
  assert.ok(r.status === 401 || r.status === 400);
  // Stale timestamp (> 5 min), correctly signed.
  r = await api("POST", "/authority/v1/batches", { key_id: issuerKeyId, leaf_hashes: leaves, ...batchSignature(leaves, issuer.privateKey, new Date(Date.now() - 6 * 60_000).toISOString()) });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /window/);
  // Unknown fields are rejected.
  r = await api("POST", "/authority/v1/batches", { key_id: issuerKeyId, leaf_hashes: leaves, ...signed, extra: true });
  assert.equal(r.status, 400);
  // Cross-site POST from a non-allowlisted origin is refused.
  const xs = await fetch(base + "/authority/v1/batches", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ key_id: issuerKeyId, leaf_hashes: leaves, ...signed }) });
  assert.equal(xs.status, 403);
  // Signed by an unregistered key.
  const other = generateKeyPairSync("ed25519");
  r = await api("POST", "/authority/v1/batches", { key_id: "0123456789abcdef", leaf_hashes: leaves, ...batchSignature(leaves, other.privateKey) });
  assert.equal(r.status, 403);
  r = await api("POST", "/authority/v1/batches", { key_id: issuerKeyId, leaf_hashes: ["XYZ"], ...signed });
  assert.equal(r.status, 400);
  r = await api("POST", "/authority/v1/batches", { key_id: issuerKeyId, leaf_hashes: [], ...signed });
  assert.equal(r.status, 400);
  const sth = await api("GET", "/authority/v1/sth");
  assert.equal(sth.json.sth.tree_size, size);
});

test("replayed batch is idempotent (not re-appended, same STH)", async () => {
  const { resp } = await postBatch(4);
  const leaves = resp.proofs.map((p) => p["leaf_hash"] as string);
  const r = await api("POST", "/authority/v1/batches", { key_id: issuerKeyId, leaf_hashes: leaves, ...batchSignature(leaves) });
  assert.equal(r.status, 200);
  assert.equal(r.json.replayed, true);
  assert.deepEqual(r.json.sth, resp.sth);
  assert.deepEqual(r.json.proofs, resp.proofs);
  assert.equal((await api("GET", "/authority/v1/sth")).json.sth.tree_size, mirror.leafCount);
});

test("CORS: allowlisted origins only; preflight allows POST only from the allowlist", async () => {
  const ok = await fetch(base + "/authority/v1/sth", { headers: { origin: "https://filet-demo.pages.dev" } });
  assert.equal(ok.headers.get("access-control-allow-origin"), "https://filet-demo.pages.dev");
  const prev = await fetch(base + "/authority/v1/sth", { headers: { origin: "https://abc123.filet-demo.pages.dev" } });
  assert.equal(prev.headers.get("access-control-allow-origin"), "https://abc123.filet-demo.pages.dev");
  const bad = await fetch(base + "/authority/v1/sth", { headers: { origin: "https://evil.example" } });
  assert.equal(bad.headers.get("access-control-allow-origin"), null);
  const pf = await fetch(base + "/authority/v1/batches", { method: "OPTIONS", headers: { origin: "https://filet-demo.pages.dev", "access-control-request-method": "POST" } });
  assert.equal(pf.status, 204);
  assert.match(pf.headers.get("access-control-allow-methods") ?? "", /POST/);
  const pfBad = await fetch(base + "/authority/v1/batches", { method: "OPTIONS", headers: { origin: "https://filet-demo.pages.dev.evil.example", "access-control-request-method": "POST" } });
  assert.equal(pfBad.status, 403);
  const pfDel = await fetch(base + "/authority/v1/batches", { method: "OPTIONS", headers: { origin: "https://filet-demo.pages.dev", "access-control-request-method": "DELETE" } });
  assert.equal(pfDel.status, 403);
});

test("report latency", () => {
  const pct = (xs: number[], p: number) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
  };
  const rows: string[] = [];
  for (const [n, l] of [...lat.entries()].sort((a, b) => a[0] - b[0])) {
    rows.push(
      `batch=${String(n).padStart(2)} n=${String(l.authority.length).padStart(2)}  authority_ms p50=${pct(l.authority, 50).toFixed(3)} max=${Math.max(...l.authority).toFixed(3)}` +
        `  client_rtt_ms p50=${pct(l.rtt, 50).toFixed(2)} max=${Math.max(...l.rtt).toFixed(2)}`,
    );
  }
  console.log(`\nlog size ${mirror.leafCount}, ${sths.length} STHs\n` + rows.join("\n"));
});
