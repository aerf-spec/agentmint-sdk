// Evidence package export — a portable, self-verifying zip (port of the
// Python producer's EvidencePackage).
//
// Contents:
//   receipt_index.json   table of contents + chain verification + Merkle root
//   plan.json            the signed plan (when supplied)
//   public_key.pem       issuer Ed25519 public key (SPKI PEM)
//   receipts/{id}.json   each signed receipt, chain order
//   verify.mjs           standalone verifier — node:crypto only, no AgentMint
//
// An auditor unzips and runs `node verify.mjs`: plan signature, every receipt
// signature, §8.4 hash links, seq continuity, and the chain root in the index
// are all checked with zero dependencies beyond Node itself.
import { writeFileSync } from "node:fs";
import type { KeyObject } from "node:crypto";
import { buildZip, type ZipEntryInit } from "./kernel/zip.js";
import { signStripped, signedPayloadBytes, privateKeyFromPem } from "./kernel/sign.js";
import { isoNowUtc, AIUC_CONTROLS, type AerfReceipt } from "./receipt-aerf.js";
import { MerkleTree } from "./merkle.js";
import { verifyAerfChain, chainRootCommitment } from "./chain.js";
import type { PlanReceipt } from "./plan.js";

export interface EvidencePackageOptions {
  plan?: PlanReceipt;
  publicKeyPem: string;
  /** When present, the chain root commitment is signed into the index. */
  signingKey?: string | KeyObject;
  /** Deterministic override for the index's package_created timestamp. */
  packageCreated?: string;
}

export class EvidencePackage {
  private readonly receiptList: AerfReceipt[] = [];

  constructor(private readonly opts: EvidencePackageOptions) {}

  add(receipt: AerfReceipt): void {
    this.receiptList.push(receipt);
  }

  get receipts(): AerfReceipt[] {
    return [...this.receiptList];
  }

  /** Assemble every archive entry (exposed for tests). */
  buildEntries(): ZipEntryInit[] {
    const entries: ZipEntryInit[] = [];
    const receipts = this.receiptList as unknown as Record<string, unknown>[];

    if (this.opts.plan) {
      entries.push({ name: "plan.json", content: JSON.stringify(this.opts.plan, null, 2) });
    }
    entries.push({ name: "public_key.pem", content: this.opts.publicKeyPem });
    for (const r of this.receiptList) {
      entries.push({ name: `receipts/${r.id}.json`, content: JSON.stringify(r, null, 2) });
    }

    const chain = verifyAerfChain(receipts, { issuerPublicKey: this.opts.publicKeyPem });
    const tree = new MerkleTree();
    for (const r of receipts) tree.addLeaf(signedPayloadBytes(r));

    const inCount = this.receiptList.filter((r) => r.in_policy).length;
    const index: Record<string, unknown> = {
      package_created: this.opts.packageCreated ?? isoNowUtc(),
      ...(this.opts.plan
        ? { plan_id: this.opts.plan.id, plan_user: this.opts.plan.user, key_id: this.opts.plan.key_id }
        : {}),
      total_receipts: this.receiptList.length,
      in_policy_count: inCount,
      out_of_policy_count: this.receiptList.length - inCount,
      aiuc_controls: [...AIUC_CONTROLS],
      receipts: this.receiptList.map((r) => ({
        receipt_id: r.id,
        short_id: r.id.slice(0, 8),
        action: r.action,
        agent: r.agent,
        in_policy: r.in_policy,
        policy_reason: r.policy_reason,
        observed_at: r.observed_at,
        ...(r.seq !== undefined ? { seq: r.seq } : {}),
        previous_receipt_hash: r.previous_receipt_hash ?? null,
        file: `receipts/${r.id}.json`,
      })),
      chain: {
        valid: chain.valid,
        length: chain.length,
        root_hash: chain.rootHash,
        ...(chain.valid ? {} : { break_at_index: chain.breakAtIndex, reason: chain.reason }),
        ...(chain.rootHash && this.opts.signingKey && this.opts.plan
          ? {
              root_signature: signStripped(
                chainRootCommitment(this.opts.plan.id, chain),
                typeof this.opts.signingKey === "string"
                  ? privateKeyFromPem(this.opts.signingKey)
                  : this.opts.signingKey,
              ),
            }
          : {}),
      },
      merkle: {
        root: tree.build(),
        leaf_count: tree.leafCount,
        note: "RFC 6962 tree over each receipt's stripped canonical payload",
      },
    };
    entries.push({ name: "receipt_index.json", content: JSON.stringify(index, null, 2) });
    entries.push({ name: "verify.mjs", content: VERIFY_MJS, mode: 0o755 });
    return entries;
  }

  /** Build the zip in memory. */
  toBuffer(): Buffer {
    return buildZip(this.buildEntries());
  }

  /** Write the zip to disk and return the path. */
  export(outPath: string): string {
    writeFileSync(outPath, this.toBuffer());
    return outPath;
  }
}

/** Verify a receipt_index-style summary offline (used by tests and the CLI). */
export function summarizeEvidence(receipts: readonly AerfReceipt[]): {
  total: number;
  inPolicy: number;
  outOfPolicy: number;
  chainRoot: string;
} {
  const rs = receipts as unknown as Record<string, unknown>[];
  const chain = verifyAerfChain(rs);
  const inPolicy = receipts.filter((r) => r.in_policy).length;
  return {
    total: receipts.length,
    inPolicy,
    outOfPolicy: receipts.length - inPolicy,
    chainRoot: chain.rootHash,
  };
}

// ── Standalone verifier, shipped inside every package ───────────────
// Mirrors the oracle's semantics (test/aerf-verify-poc.mjs): JCS
// canonicalization with number lexemes replayed verbatim, post-issuance strip,
// Ed25519 verify — plus §8.4 chain links and seq continuity.

const VERIFY_MJS = `#!/usr/bin/env node
// AgentMint evidence package verifier — STANDALONE. Requires only Node >= 18.
// Checks: plan signature, every receipt signature, previous_receipt_hash
// links (AERF SPEC.md §8.4), seq continuity, and the chain root in
// receipt_index.json. Exit 0 = every check passed.
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// Number-preserving JSON parse (like Go's json.Number).
function parsePreserving(src) {
  let i = 0;
  const ws = () => { while (i < src.length && /[\\s]/.test(src[i])) i++; };
  function value() {
    ws();
    const c = src[i];
    if (c === "{") return obj();
    if (c === "[") return arr();
    if (c === '"') return str();
    if (c === "t") { i += 4; return true; }
    if (c === "f") { i += 5; return false; }
    if (c === "n") { i += 4; return null; }
    return num();
  }
  function obj() {
    i++; const out = new Map(); ws();
    if (src[i] === "}") { i++; return out; }
    for (;;) {
      ws(); const k = str(); ws(); i++;
      out.set(k, value()); ws();
      if (src[i] === ",") { i++; continue; }
      i++; return out;
    }
  }
  function arr() {
    i++; const out = []; ws();
    if (src[i] === "]") { i++; return out; }
    for (;;) {
      out.push(value()); ws();
      if (src[i] === ",") { i++; continue; }
      i++; return out;
    }
  }
  function str() {
    let out = ""; i++;
    while (src[i] !== '"') {
      if (src[i] === "\\\\") {
        const e = src[i + 1];
        if (e === "u") { out += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16)); i += 6; }
        else { out += ({ '"': '"', "\\\\": "\\\\", "/": "/", b: "\\b", f: "\\f", n: "\\n", r: "\\r", t: "\\t" })[e]; i += 2; }
      } else { out += src[i++]; }
    }
    i++; return out;
  }
  function num() {
    const start = i;
    while (i < src.length && /[-+0-9.eE]/.test(src[i])) i++;
    return { __num: src.slice(start, i) };
  }
  return value();
}

function esc(s) {
  let out = '"';
  for (const ch of s.normalize("NFC")) {
    const code = ch.codePointAt(0);
    if (ch === '"') out += '\\\\"';
    else if (ch === "\\\\") out += "\\\\\\\\";
    else if (ch === "\\b") out += "\\\\b";
    else if (ch === "\\f") out += "\\\\f";
    else if (ch === "\\n") out += "\\\\n";
    else if (ch === "\\r") out += "\\\\r";
    else if (ch === "\\t") out += "\\\\t";
    else if (code < 0x20) out += "\\\\u" + code.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + '"';
}
function canonical(v) {
  if (v === null) return "null";
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "string") return esc(v);
  if (v && v.__num !== undefined) return v.__num;
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v instanceof Map) {
    const keys = [...v.keys()].sort();
    return "{" + keys.map((k) => esc(k) + ":" + canonical(v.get(k))).join(",") + "}";
  }
  throw new Error("unsupported type");
}

const POST_ISSUANCE = ["signature", "timestamp", "parent_signature", "parent_key_id", "log_inclusion_proof"];
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function strippedPayload(receiptMap) {
  const stripped = new Map(receiptMap);
  for (const f of POST_ISSUANCE) stripped.delete(f);
  return Buffer.from(canonical(stripped), "utf-8");
}

const pub = createPublicKey(readFileSync(join(here, "public_key.pem"), "utf-8"));
const index = JSON.parse(readFileSync(join(here, "receipt_index.json"), "utf-8"));
let failures = 0;
const fail = (msg) => { failures++; console.error("  FAIL  " + msg); };
const ok = (msg) => console.log("  ok    " + msg);

// 1. Plan signature.
const planPath = join(here, "plan.json");
if (existsSync(planPath)) {
  const plan = parsePreserving(readFileSync(planPath, "utf-8"));
  const sig = plan.get("signature");
  const planStripped = new Map(plan);
  planStripped.delete("signature");
  const valid = edVerify(null, Buffer.from(canonical(planStripped), "utf-8"), pub, Buffer.from(sig, "hex"));
  valid ? ok("plan signature") : fail("plan signature INVALID");
}

// 2. Receipts: signatures + chain links + seq, in index order.
let expectedPrev = undefined;
let prevSeq = undefined;
for (const entry of index.receipts) {
  const receipt = parsePreserving(readFileSync(join(here, entry.file), "utf-8"));
  const id = receipt.get("id");
  const payload = strippedPayload(receipt);
  const sigOk = edVerify(null, payload, pub, Buffer.from(receipt.get("signature"), "hex"));
  sigOk ? ok("signature  " + id.slice(0, 8) + "  " + receipt.get("action")) : fail("signature INVALID for " + id);

  const declaredPrev = receipt.has("previous_receipt_hash") ? receipt.get("previous_receipt_hash") : undefined;
  if (declaredPrev !== expectedPrev) fail("chain link broken at " + id + " (a receipt was removed or reordered)");
  const seq = receipt.has("seq") ? Number(receipt.get("seq").__num ?? receipt.get("seq")) : undefined;
  if (seq !== undefined && prevSeq !== undefined && seq !== prevSeq + 1) fail("seq gap at " + id + ": expected " + (prevSeq + 1) + ", got " + seq);
  if (seq !== undefined) prevSeq = seq;
  expectedPrev = sha256(payload);
}

// 3. Chain root matches the index.
if (index.chain && index.chain.root_hash) {
  index.chain.root_hash === (expectedPrev ?? "")
    ? ok("chain root " + index.chain.root_hash.slice(0, 16) + "…")
    : fail("chain root mismatch: index says " + index.chain.root_hash + ", recomputed " + (expectedPrev ?? "<empty>"));
}

console.log("");
if (failures > 0) {
  console.error(failures + " check(s) FAILED");
  process.exit(1);
}
console.log("All checks passed: " + index.receipts.length + " receipt(s), chain intact.");
`;
