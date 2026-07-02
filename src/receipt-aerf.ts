// Full AERF evidence receipts (AERF SPEC.md §4, profile AERF-EVIDENCE).
//
// This is the wire-format receipt: the same shape the Python reference
// producer (agentmint.notary.NotarisedReceipt) emits and the Go reference
// verifier checks. Field inclusion conditions mirror the Python producer's
// signable_dict() byte-for-byte for the shared field set, so a receipt built
// here and a receipt built by the Python producer for the same logical action
// canonicalize to identical bytes and verify under the same verifier.
//
// Deliberate divergences from the Python producer (AERF SPEC.md wins):
//  - `agent_signature` is serialized inside the signed payload when present
//    (SPEC §4.3). Python computes it but never serializes it.
//  - v0.2 multi-agent fields (`impact_tags`, `context_hash_sha256`,
//    `pdp_signature`, `pdp_key_id`, `parent_signature`, `parent_key_id`,
//    `log_inclusion_proof`) are supported per SPEC §4.6; Python 0.2.x does not
//    emit them yet.
//  - The chain hash (§8.4) is computed over the STRIPPED canonical payload
//    (post-issuance fields removed, signature NOT included) as the conformance
//    vectors require. Python hashes the payload including the signature.
import { randomUUID, sign as edSign, verify as edVerify, createPublicKey, type KeyObject } from "node:crypto";
import { canonicalBytes, sha256Hex, sha512Hex } from "./kernel/canonical.js";
import {
  keyId,
  signStripped,
  verifyStripped,
  signedPayloadBytes,
  privateKeyFromPem,
} from "./kernel/sign.js";
import { logLeafHash, walkAuditPath, MerkleTree } from "./merkle.js";

// ── Constants (mirror notary.py) ────────────────────────────────────

export const MAX_ACTION_LEN = 128;
export const MAX_IDENTITY_LEN = 256;
export const MAX_EVIDENCE_BYTES = 1024 * 1024;
export const AIUC_CONTROLS: readonly string[] = ["E015", "D003", "B001"];

/** Enforcement mode carried on a receipt. "enforce" is the default and is omitted from the wire. */
export type AerfMode = "enforce" | "shadow" | "warn";

export class AerfReceiptError extends Error {}

// ── Receipt shape (SPEC §4) ─────────────────────────────────────────

export interface SessionTrajectoryEntry {
  action: string;
  agent: string;
  in_policy: boolean;
  observed_at: string;
}

/** RFC 9162-aligned inclusion proof against a transparency log (SPEC §4.6, §15). */
export interface LogInclusionProof {
  log_id: string;
  leaf_hash: string;
  leaf_index?: number;
  tree_size: number;
  audit_path: string[];
  sth: { tree_size: number; root_hash: string; timestamp: string };
  sth_signature: string;
}

/**
 * A signed AERF evidence receipt as it appears on the wire. Optional fields
 * are omitted (never null) when absent; `previous_receipt_hash` is omitted on
 * genesis (SPEC §8.1).
 */
export interface AerfReceipt {
  id: string;
  type: "notarised_evidence";
  plan_id: string;
  agent: string;
  action: string;
  in_policy: boolean;
  policy_reason: string;
  evidence_hash_sha512: string;
  evidence: Record<string, unknown>;
  observed_at: string;
  aiuc_controls: string[];
  key_id: string;
  agent_key_id: string;
  policy_hash?: string;
  output_hash?: string;
  agent_signature?: string;
  session_id?: string;
  session_trajectory?: SessionTrajectoryEntry[];
  session_escalation?: string;
  reasoning_hash?: string;
  mode?: string;
  original_verdict?: boolean;
  previous_receipt_hash?: string;
  plan_signature?: string;
  seq?: number;
  compliance_tags?: string[];
  // v0.2 multi-agent fields, signed pre-issuance (SPEC §4.6)
  impact_tags?: string[];
  context_hash_sha256?: string;
  pdp_signature?: string;
  pdp_key_id?: string;
  // issuer signature (post-issuance strip set starts here)
  signature: string;
  // post-issuance fields, excluded from every signature and chain hash
  timestamp?: { tsa_url: string; digest_hex: string };
  parent_signature?: string;
  parent_key_id?: string;
  log_inclusion_proof?: LogInclusionProof;
}

// ── Validation (mirror notary.py) ───────────────────────────────────

function requireNonEmptyString(value: string, name: string, maxLen: number): string {
  if (typeof value !== "string") {
    throw new AerfReceiptError(`${name} must be a string, got ${typeof value}`);
  }
  const stripped = value.trim();
  if (!stripped) throw new AerfReceiptError(`${name} must not be empty`);
  if (stripped.length > maxLen) {
    throw new AerfReceiptError(`${name} must be at most ${maxLen} characters, got ${stripped.length}`);
  }
  for (const ch of stripped) {
    if (ch.codePointAt(0)! < 32) throw new AerfReceiptError(`${name} contains control characters`);
  }
  return stripped;
}

function requireEvidence(evidence: unknown): Record<string, unknown> {
  if (typeof evidence !== "object" || evidence === null || Array.isArray(evidence)) {
    throw new AerfReceiptError(`evidence must be an object, got ${evidence === null ? "null" : typeof evidence}`);
  }
  const raw = canonicalBytes(evidence);
  if (raw.length > MAX_EVIDENCE_BYTES) {
    throw new AerfReceiptError(
      `serialized evidence is ${raw.length.toLocaleString("en-US")} bytes, max is ${MAX_EVIDENCE_BYTES.toLocaleString("en-US")}`,
    );
  }
  return evidence as Record<string, unknown>;
}

// ── Hashes ──────────────────────────────────────────────────────────

/** SHA-512 hex of canonical(evidence) — the `evidence_hash_sha512` field. */
export function evidenceHashSha512(evidence: Record<string, unknown>): string {
  return sha512Hex(canonicalBytes(evidence));
}

/**
 * The chain-hash of a receipt per SPEC §8.4: SHA-256 hex of the canonical
 * payload with the post-issuance fields removed. This is what the NEXT
 * receipt's `previous_receipt_hash` must equal, and the §15 log leaf preimage
 * (without the 0x00 prefix).
 */
export function aerfChainHash(receipt: Record<string, unknown>): string {
  return sha256Hex(signedPayloadBytes(receipt));
}

// ── Builder ─────────────────────────────────────────────────────────

export interface AerfReceiptInit {
  planId: string;
  agent: string;
  action: string;
  inPolicy: boolean;
  policyReason: string;
  evidence: Record<string, unknown>;
  /** Omit for a genesis receipt (SPEC §8.1). Never pass null/"" — genesis omits the field. */
  previousReceiptHash?: string;
  policyHash?: string;
  outputHash?: string;
  sessionId?: string;
  sessionTrajectory?: readonly SessionTrajectoryEntry[];
  sessionEscalation?: string;
  reasoningHash?: string;
  /** "enforce" (default) is omitted from the wire, matching the Python producer. */
  mode?: AerfMode | string;
  originalVerdict?: boolean;
  planSignature?: string;
  aiucControls?: readonly string[];
  complianceTags?: readonly string[];
  /** Monotonic per-chain sequence number (TS extension; signed when present). */
  seq?: number;
  // v0.2 multi-agent fields — signed pre-issuance (SPEC §7 step 1)
  impactTags?: readonly string[];
  contextHashSha256?: string;
  pdpSignature?: string;
  pdpKeyId?: string;
  // deterministic overrides (tests, replay)
  id?: string;
  observedAt?: string;
}

export interface AerfSignOptions {
  /** Issuer (notary) private key: PKCS8 PEM or KeyObject. */
  issuerPrivateKey: string | KeyObject;
  /** Optional acting agent's own key: adds agent_signature over canonical(evidence). */
  agentPrivateKey?: string | KeyObject;
}

function asPrivateKey(key: string | KeyObject): KeyObject {
  return typeof key === "string" ? privateKeyFromPem(key) : key;
}

/**
 * Assemble the signable receipt object with the exact field-inclusion
 * conditions of the Python producer's signable_dict(), plus the SPEC v0.2
 * fields Python does not emit yet. Canonical JSON sorts keys, so inclusion
 * conditions — not insertion order — determine the signed bytes.
 */
export function buildAerfSignable(init: AerfReceiptInit, issuerKeyId: string, agentKeyId = "", agentSignature = ""): Record<string, unknown> {
  const action = requireNonEmptyString(init.action, "action", MAX_ACTION_LEN);
  const agent = requireNonEmptyString(init.agent, "agent", MAX_IDENTITY_LEN);
  const evidence = requireEvidence(init.evidence);
  if (init.previousReceiptHash !== undefined && !init.previousReceiptHash) {
    throw new AerfReceiptError(
      "previousReceiptHash must be omitted on genesis, not empty (SPEC §8.1)",
    );
  }

  const d: Record<string, unknown> = {
    id: init.id ?? randomUUID(),
    type: "notarised_evidence",
    plan_id: init.planId,
    agent,
    action,
    in_policy: init.inPolicy,
    policy_reason: init.policyReason,
    evidence_hash_sha512: evidenceHashSha512(evidence),
    evidence,
    observed_at: init.observedAt ?? isoNowUtc(),
    aiuc_controls: [...(init.aiucControls ?? AIUC_CONTROLS)],
    key_id: issuerKeyId,
    agent_key_id: agentKeyId,
  };
  if (init.policyHash) d.policy_hash = init.policyHash;
  if (init.outputHash) d.output_hash = init.outputHash;
  if (agentSignature) d.agent_signature = agentSignature;
  if (init.sessionId) d.session_id = init.sessionId;
  if (init.sessionTrajectory && init.sessionTrajectory.length > 0) {
    d.session_trajectory = init.sessionTrajectory.map((e) => ({ ...e }));
  }
  if (init.sessionEscalation) d.session_escalation = init.sessionEscalation;
  if (init.reasoningHash) d.reasoning_hash = init.reasoningHash;
  if (init.mode !== undefined && init.mode !== "enforce") d.mode = init.mode;
  if (init.originalVerdict !== undefined) d.original_verdict = init.originalVerdict;
  if (init.previousReceiptHash !== undefined) d.previous_receipt_hash = init.previousReceiptHash;
  if (init.planSignature) d.plan_signature = init.planSignature;
  if (init.seq !== undefined) d.seq = init.seq;
  if (init.complianceTags && init.complianceTags.length > 0) d.compliance_tags = [...init.complianceTags];
  if (init.impactTags && init.impactTags.length > 0) d.impact_tags = [...init.impactTags];
  if (init.contextHashSha256) d.context_hash_sha256 = init.contextHashSha256;
  if (init.pdpSignature) {
    d.pdp_signature = init.pdpSignature;
    if (!init.pdpKeyId) throw new AerfReceiptError("pdp_key_id is required when pdp_signature is present (SPEC §4.6)");
    d.pdp_key_id = init.pdpKeyId;
  }
  return d;
}

/**
 * Build and issuer-sign a full AERF evidence receipt (SPEC §7). When an agent
 * key is supplied, `agent_signature` (Ed25519 over canonical(evidence)) and
 * `agent_key_id` are populated BEFORE issuer signing, so both are covered by
 * the issuer signature.
 */
export function buildAerfReceipt(init: AerfReceiptInit, opts: AerfSignOptions): AerfReceipt {
  const issuerKey = asPrivateKey(opts.issuerPrivateKey);
  const issuerPub = createPublicKey(issuerKey);

  let agentSig = "";
  let agentKid = "";
  if (opts.agentPrivateKey) {
    const agentKey = asPrivateKey(opts.agentPrivateKey);
    agentSig = edSign(null, canonicalBytes(requireEvidence(init.evidence)), agentKey).toString("hex");
    agentKid = keyId(createPublicKey(agentKey));
  }

  const signable = buildAerfSignable(init, keyId(issuerPub), agentKid, agentSig);
  const signature = signStripped(signable, issuerKey);
  return { ...signable, signature } as AerfReceipt;
}

// ── Verification ────────────────────────────────────────────────────

export type AerfCheckOutcome = "skipped" | "passed" | "failed" | "missing";

export interface AerfVerifyOptions {
  issuerPublicKey: string | KeyObject;
  agentPublicKey?: string | KeyObject;
  parentPublicKey?: string | KeyObject;
  pdpPublicKey?: string | KeyObject;
  logPublicKey?: string | KeyObject;
  requireParentSig?: boolean;
  requirePdpSig?: boolean;
  requireLog?: boolean;
}

export interface AerfVerifyResult {
  ok: boolean;
  issuerOk: boolean;
  agent: AerfCheckOutcome;
  parent: AerfCheckOutcome;
  pdp: AerfCheckOutcome;
  log: AerfCheckOutcome;
  hasImpact: boolean;
  impactTags: string[];
  failCategory?: string;
  failReason?: string;
}

function asPublicKey(key: string | KeyObject): KeyObject {
  return typeof key === "string" ? createPublicKey(key) : key;
}

function verifyHexSig(payload: Buffer, pub: KeyObject, sigHex: string): boolean {
  try {
    const sig = Buffer.from(sigHex, "hex");
    if (sig.length !== 64 || sig.toString("hex") !== sigHex.toLowerCase()) return false;
    return edVerify(null, payload, pub, sig);
  } catch {
    return false;
  }
}

/**
 * Verify every applicable signature on an AERF receipt, mirroring the Go
 * reference verifier (verify.go VerifyReceipt): issuer signature always;
 * parent counter-signature and PDP signature REQUIRED when `impact_tags` is
 * non-empty (SPEC §3, §16, §17); log inclusion proof when present. A single
 * compromised issuer key therefore cannot forge in_policy=true on a
 * HIGH-IMPACT action.
 */
export function verifyAerfReceipt(
  receipt: Record<string, unknown>,
  opts: AerfVerifyOptions,
): AerfVerifyResult {
  const res: AerfVerifyResult = {
    ok: false,
    issuerOk: false,
    agent: "skipped",
    parent: "skipped",
    pdp: "skipped",
    log: "skipped",
    hasImpact: false,
    impactTags: [],
  };
  const fail = (category: string, reason: string): AerfVerifyResult => {
    res.ok = false;
    res.failCategory = category;
    res.failReason = reason;
    return res;
  };

  const tags = Array.isArray(receipt["impact_tags"])
    ? (receipt["impact_tags"] as unknown[]).filter((t): t is string => typeof t === "string")
    : [];
  res.hasImpact = tags.length > 0;
  res.impactTags = tags;

  // Genesis conformance (SPEC §8.1): the field is either absent or a non-empty string.
  if ("previous_receipt_hash" in receipt) {
    const prev = receipt["previous_receipt_hash"];
    if (typeof prev !== "string" || prev === "") {
      return fail("chain", "previous_receipt_hash present but null/empty — genesis must omit the field (SPEC §8.1)");
    }
  }

  // 1. Issuer signature over the stripped canonical payload (SPEC §7).
  const sig = receipt["signature"];
  if (typeof sig !== "string" || !sig) return fail("issuer_signature", "receipt missing 'signature' field");
  if (!verifyStripped(receipt, asPublicKey(opts.issuerPublicKey), sig)) {
    return fail("issuer_signature", "issuer signature verification FAILED");
  }
  res.issuerOk = true;

  // 2. Agent co-signature over canonical(evidence), when present and key supplied.
  const agentSig = receipt["agent_signature"];
  if (typeof agentSig === "string" && agentSig) {
    if (opts.agentPublicKey) {
      const evidence = receipt["evidence"];
      const okAgent =
        typeof evidence === "object" &&
        evidence !== null &&
        verifyHexSig(canonicalBytes(evidence), asPublicKey(opts.agentPublicKey), agentSig);
      if (!okAgent) {
        res.agent = "failed";
        return fail("agent_signature", "agent signature verification FAILED");
      }
      res.agent = "passed";
    }
  }

  // 3. Parent counter-signature (SPEC §16): same stripped payload as issuer.
  const parentOutcome = checkCounterSig(receipt, opts, res.hasImpact);
  res.parent = parentOutcome.outcome;
  if (parentOutcome.error) return fail("parent_signature", parentOutcome.error);

  // 4. PDP signature over {context_hash_sha256, in_policy, policy_hash} (SPEC §17).
  const pdpOutcome = checkPdpSig(receipt, opts, res.hasImpact);
  res.pdp = pdpOutcome.outcome;
  if (pdpOutcome.error) return fail("pdp_signature", pdpOutcome.error);

  // 5. Log inclusion proof (SPEC §15), when present.
  const logOutcome = checkLogInclusion(receipt, opts);
  res.log = logOutcome.outcome;
  if (logOutcome.error) return fail("log_inclusion", logOutcome.error);

  res.ok = true;
  return res;
}

interface CheckResult {
  outcome: AerfCheckOutcome;
  error?: string;
}

function checkCounterSig(
  receipt: Record<string, unknown>,
  opts: AerfVerifyOptions,
  hasImpact: boolean,
): CheckResult {
  const sigHex = receipt["parent_signature"];
  const hasSig = typeof sigHex === "string" && sigHex !== "";
  if (hasImpact && !hasSig) {
    return { outcome: "missing", error: "impact_tags non-empty but parent_signature absent" };
  }
  if (!hasSig) {
    if (opts.requireParentSig) {
      return { outcome: "missing", error: "requireParentSig set but parent_signature absent" };
    }
    return { outcome: "skipped" };
  }
  if (!opts.parentPublicKey) {
    if (opts.requireParentSig || hasImpact) {
      return { outcome: "missing", error: "parent_signature present but no parent key supplied" };
    }
    return { outcome: "skipped" };
  }
  const ok = verifyHexSig(signedPayloadBytes(receipt), asPublicKey(opts.parentPublicKey), sigHex as string);
  if (!ok) return { outcome: "failed", error: "parent signature verification FAILED" };
  return { outcome: "passed" };
}

function checkPdpSig(
  receipt: Record<string, unknown>,
  opts: AerfVerifyOptions,
  hasImpact: boolean,
): CheckResult {
  const sigHex = receipt["pdp_signature"];
  const hasSig = typeof sigHex === "string" && sigHex !== "";
  if (hasImpact && !hasSig) {
    return { outcome: "missing", error: "impact_tags non-empty but pdp_signature absent" };
  }
  if (!hasSig) {
    if (opts.requirePdpSig) {
      return { outcome: "missing", error: "requirePdpSig set but pdp_signature absent" };
    }
    return { outcome: "skipped" };
  }
  if (!opts.pdpPublicKey) {
    if (opts.requirePdpSig || hasImpact) {
      return { outcome: "missing", error: "pdp_signature present but no PDP key supplied" };
    }
    return { outcome: "skipped" };
  }
  const ctxHash = receipt["context_hash_sha256"];
  const policyHash = receipt["policy_hash"];
  const inPolicy = receipt["in_policy"];
  if (typeof ctxHash !== "string" || !ctxHash || typeof policyHash !== "string" || !policyHash || typeof inPolicy !== "boolean") {
    return { outcome: "failed", error: "pdp_signature requires context_hash_sha256, policy_hash, in_policy" };
  }
  const tuple = pdpTuple(ctxHash, inPolicy, policyHash);
  const ok = verifyHexSig(canonicalBytes(tuple), asPublicKey(opts.pdpPublicKey), sigHex as string);
  if (!ok) return { outcome: "failed", error: "pdp signature verification FAILED" };
  return { outcome: "passed" };
}

function checkLogInclusion(receipt: Record<string, unknown>, opts: AerfVerifyOptions): CheckResult {
  const proof = receipt["log_inclusion_proof"];
  const hasProof = typeof proof === "object" && proof !== null && !Array.isArray(proof);
  if (!hasProof) {
    if (opts.requireLog) return { outcome: "missing", error: "requireLog set but log_inclusion_proof absent" };
    return { outcome: "skipped" };
  }
  if (!opts.logPublicKey) {
    if (opts.requireLog) return { outcome: "missing", error: "requireLog set but no log key supplied" };
    return { outcome: "skipped" };
  }
  const err = verifyLogInclusionProof(receipt, proof as Record<string, unknown>, asPublicKey(opts.logPublicKey));
  if (err) return { outcome: "failed", error: err };
  return { outcome: "passed" };
}

/**
 * SHA-256 hex of the canonical JSON of the input context the agent observed
 * (SPEC §4.6). Per §5.1 rule 2, every numeric value inside the hashed context
 * is encoded as a JSON string, sidestepping number-representation ambiguity.
 */
export function contextHashSha256(context: unknown): string {
  return sha256Hex(canonicalBytes(numbersAsStrings(context)));
}

function numbersAsStrings(value: unknown): unknown {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new AerfReceiptError("context contains a non-finite number");
    return String(value);
  }
  if (typeof value === "object" && value !== null && "__raw_number_lexeme" in value) {
    return (value as unknown as { value: string }).value;
  }
  if (Array.isArray(value)) return value.map(numbersAsStrings);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = numbersAsStrings(v);
    return out;
  }
  return value;
}

/** The canonical PDP-bound tuple (SPEC §4.6/§17): exactly these three keys. */
export function pdpTuple(
  contextHashSha256: string,
  inPolicy: boolean,
  policyHash: string,
): Record<string, unknown> {
  return {
    context_hash_sha256: contextHashSha256,
    in_policy: inPolicy,
    policy_hash: policyHash,
  };
}

/** Sign the PDP-bound tuple with the PDP's key. Returns lowercase hex. */
export function signPdpTuple(
  contextHashSha256: string,
  inPolicy: boolean,
  policyHash: string,
  pdpPrivateKey: string | KeyObject,
): string {
  return edSign(
    null,
    canonicalBytes(pdpTuple(contextHashSha256, inPolicy, policyHash)),
    asPrivateKey(pdpPrivateKey),
  ).toString("hex");
}

/**
 * Counter-sign an issued receipt as the parent agent (SPEC §16.3): Ed25519
 * over exactly the canonical payload the issuer signed. Returns a copy with
 * parent_signature + parent_key_id attached (post-issuance — the issuer
 * signature and chain hash are unchanged).
 */
export function counterSignAerfReceipt<T extends Record<string, unknown>>(
  receipt: T,
  parentPrivateKey: string | KeyObject,
): T & { parent_signature: string; parent_key_id: string } {
  const key = asPrivateKey(parentPrivateKey);
  const sig = edSign(null, signedPayloadBytes(receipt), key).toString("hex");
  return { ...receipt, parent_signature: sig, parent_key_id: keyId(createPublicKey(key)) };
}

// ── Log inclusion (SPEC §15, RFC 6962) ──────────────────────────────

/**
 * Verify a log_inclusion_proof, mirroring the Go verifier's
 * VerifyLogInclusion: STH signature, leaf-hash recomputation from the
 * receipt's stripped canonical payload, and the RFC 6962 audit path walk.
 * Returns an error string, or undefined when the proof is valid.
 */
export function verifyLogInclusionProof(
  receipt: Record<string, unknown>,
  proof: Record<string, unknown>,
  logPublicKey: KeyObject,
): string | undefined {
  const sth = proof["sth"];
  if (typeof sth !== "object" || sth === null) return "log_inclusion_proof.sth missing";
  const sthSig = proof["sth_signature"];
  if (typeof sthSig !== "string" || !sthSig) return "sth_signature missing";
  if (!verifyHexSig(canonicalBytes(sth), logPublicKey, sthSig)) {
    return "sth signature verification FAILED";
  }

  const leafHashHex = proof["leaf_hash"];
  if (typeof leafHashHex !== "string" || !/^[0-9a-f]{64}$/.test(leafHashHex)) {
    return "leaf_hash malformed";
  }
  const expected = logLeafHash(signedPayloadBytes(receipt));
  if (expected !== leafHashHex) return "leaf_hash does not match recomputed receipt leaf";

  const auditPath = proof["audit_path"];
  if (!Array.isArray(auditPath) || !auditPath.every((s) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s))) {
    return "audit_path malformed";
  }
  const treeSize = numberField(proof["tree_size"]);
  const leafIndex = numberField(proof["leaf_index"]) ?? 0;
  if (treeSize === undefined) return "tree_size malformed";

  const root = walkAuditPath(leafHashHex, auditPath as string[], leafIndex, treeSize);
  const sthRoot = (sth as Record<string, unknown>)["root_hash"];
  if (root !== sthRoot) return "audit_path does not lead to STH root_hash";
  return undefined;
}

function numberField(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isSafeInteger(v)) return v;
  if (typeof v === "object" && v !== null && "__raw_number_lexeme" in v) {
    const n = Number((v as unknown as { value: string }).value);
    if (Number.isSafeInteger(n)) return n;
  }
  return undefined;
}

/**
 * Commit a set of receipts to an RFC 6962 log and attach a
 * log_inclusion_proof to one of them (SPEC §15). The leaf set is the §8.4
 * stripped canonical payload of each receipt; the STH is signed by the log's
 * key. Post-issuance: the receipt's issuer signature and chain hash are
 * unchanged.
 */
export function attachLogInclusionProof<T extends Record<string, unknown>>(
  receipts: readonly Record<string, unknown>[],
  leafIndex: number,
  opts: { logId: string; logPrivateKey: string | KeyObject; sthTimestamp?: string },
): T & { log_inclusion_proof: LogInclusionProof } {
  const tree = new MerkleTree();
  for (const r of receipts) tree.addLeaf(signedPayloadBytes(r));
  const sth = {
    tree_size: tree.leafCount,
    root_hash: tree.build(),
    timestamp: opts.sthTimestamp ?? isoNowUtc(),
  };
  const sthSignature = edSign(null, canonicalBytes(sth), asPrivateKey(opts.logPrivateKey)).toString("hex");
  const proof: LogInclusionProof = {
    log_id: opts.logId,
    leaf_hash: logLeafHash(signedPayloadBytes(receipts[leafIndex]!)),
    leaf_index: leafIndex,
    tree_size: tree.leafCount,
    audit_path: tree.auditPath(leafIndex),
    sth,
    sth_signature: sthSignature,
  };
  return { ...(receipts[leafIndex] as T), log_inclusion_proof: proof };
}

// ── Timestamp helper ────────────────────────────────────────────────

/**
 * ISO 8601 UTC timestamp in the Python datetime.isoformat() shape the
 * reference producer emits: microsecond precision, "+00:00" offset.
 */
export function isoNowUtc(date = new Date()): string {
  // JS Date has millisecond precision; pad to microseconds for shape parity.
  return date.toISOString().replace(/\.(\d{3})Z$/, ".$1000+00:00");
}
