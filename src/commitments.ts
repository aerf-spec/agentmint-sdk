// Salted commitments for reasoning and context (AERF notary extension).
//
// A plain `reasoning_hash` = SHA-256(reasoning) can be confirmed by anyone
// who can guess the text (a short rationale, a templated prompt, a patient
// record with few plausible values). In salted mode each committed field gets
// a fresh 32-byte random salt:
//
//   reasoning_hash      = SHA-256(utf8(salt_hex + ":" + reasoning))
//   context_hash_sha256 = SHA-256(utf8(salt_hex + ":" + canonical_context))
//
// and the receipt carries the signed marker `commitment_alg:
// "sha256-salted-v1"`. Salts never appear in the receipt; the producer holds
// them in a separate Disclosure and reveals one only to a party entitled to
// see the underlying text, who checks it with verifyDisclosure().
import { randomBytes } from "node:crypto";
import { sha256Hex } from "./kernel/canonical.js";
import { contextCanonical, type AerfReceipt } from "./receipt-aerf.js";

/** Value of the signed `commitment_alg` receipt field in salted mode. */
export const SALTED_COMMITMENT_ALG = "sha256-salted-v1";

/** How the Notary commits to reasoning / context. */
export type CommitmentMode = "plain" | "salted";

/** Opening for one receipt's salted commitments. Never stored on the receipt. */
export interface Disclosure {
  receipt_id: string;
  reasoning?: { salt: string; text: string };
  context?: { salt: string; canonical: string };
}

/** Anything that accepts disclosures (a vault, an encrypted store, a test capture). */
export interface DisclosureSink {
  emit(disclosure: Disclosure): void;
}

export type DisclosureOutcome = "match" | "mismatch" | "absent";

export interface DisclosureVerification {
  reasoning: DisclosureOutcome;
  context: DisclosureOutcome;
}

const SALT_RE = /^[0-9a-f]{64}$/;

/** A fresh 32-byte salt, lowercase hex. */
export function newSalt(): string {
  return randomBytes(32).toString("hex");
}

/** SHA-256(utf8(salt_hex + ":" + text)), lowercase hex. */
export function saltedCommitment(saltHex: string, text: string): string {
  if (typeof saltHex !== "string" || !SALT_RE.test(saltHex)) {
    throw new TypeError("salt must be 64 lowercase hex characters");
  }
  return sha256Hex(Buffer.from(`${saltHex}:${text}`, "utf-8"));
}

/** Salted commitment over a context's canonical JSON (see contextCanonical). */
export function saltedContextCommitment(saltHex: string, context: unknown): { hash: string; canonical: string } {
  const canonical = contextCanonical(context);
  return { hash: saltedCommitment(saltHex, canonical), canonical };
}

/**
 * Check a disclosure against a receipt's commitments. For each field:
 * "absent" when the disclosure does not open it, "match" when the opening
 * reproduces the receipt's hash under its `commitment_alg`, "mismatch"
 * otherwise (wrong text, wrong salt, wrong receipt, malformed salt, or the
 * receipt carries no such commitment).
 *
 * Receipts without `commitment_alg` are checked as plain SHA-256 commitments
 * (the salt is ignored). This does NOT verify the receipt's signature — run
 * verifyAerfReceipt first so the hashes being opened are authentic.
 */
export function verifyDisclosure(
  receipt: Pick<AerfReceipt, "id" | "reasoning_hash" | "context_hash_sha256" | "commitment_alg"> | Record<string, unknown>,
  disclosure: Disclosure,
): DisclosureVerification {
  const r = receipt as Record<string, unknown>;
  const alg = r["commitment_alg"];
  const sameReceipt = typeof r["id"] === "string" && disclosure.receipt_id === r["id"];
  const salted = alg === SALTED_COMMITMENT_ALG;
  const knownAlg = alg === undefined || salted;

  const check = (opening: { salt: string; value: string } | undefined, committed: unknown): DisclosureOutcome => {
    if (!opening) return "absent";
    if (!sameReceipt || !knownAlg || typeof committed !== "string" || typeof opening.value !== "string") {
      return "mismatch";
    }
    try {
      const recomputed = salted
        ? saltedCommitment(opening.salt, opening.value)
        : sha256Hex(Buffer.from(opening.value, "utf-8"));
      return recomputed === committed ? "match" : "mismatch";
    } catch {
      return "mismatch";
    }
  };

  return {
    reasoning: check(
      disclosure.reasoning && { salt: disclosure.reasoning.salt, value: disclosure.reasoning.text },
      r["reasoning_hash"],
    ),
    context: check(
      disclosure.context && { salt: disclosure.context.salt, value: disclosure.context.canonical },
      r["context_hash_sha256"],
    ),
  };
}
