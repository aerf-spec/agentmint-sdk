/**
 * @kernel
 * Ed25519 signing + key handling for AERF receipts.
 *
 * Semantics fixed by the ground truth (docs/SESSION-PREAMBLE.txt) and mirrored
 * from the Python producer (_derive_key_id / _canonical_json) and Go verifier:
 *
 *  - Ed25519 via node:crypto only: generateKeyPairSync("ed25519"),
 *    sign(null, bytes, key), verify(null, bytes, pub, sig).
 *  - Keys serialized as PEM: SPKI for public (RFC 8410), PKCS8 for private.
 *  - Raw public key = the last 32 bytes of the SPKI DER encoding.
 *  - key_id = first 16 hex chars of SHA-256(raw 32-byte public key).
 *  - The SIGNED PAYLOAD is the receipt object MINUS the five post-issuance
 *    fields, canonicalized (JCS) and signed. Signature is lowercase hex.
 *
 * Kernel rule: imports node:crypto and the sibling canonical module only. Never
 * imports from experimental/ or from .vendor/.
 */
import {
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  createPublicKey,
  createPrivateKey,
  type KeyObject,
} from "node:crypto";
import { canonicalBytes, sha256Hex } from "./canonical.js";

/** Fields stripped from a receipt before signing/verifying — set post-issuance. */
export const POST_ISSUANCE_FIELDS = [
  "signature",
  "timestamp",
  "parent_signature",
  "parent_key_id",
  "log_inclusion_proof",
] as const;

/** Generate a fresh Ed25519 keypair as KeyObjects. */
export function generateKeyPair(): { publicKey: KeyObject; privateKey: KeyObject } {
  return generateKeyPairSync("ed25519");
}

/** Serialize a public key as an SPKI PEM string (RFC 8410). */
export function publicKeyToPem(key: KeyObject): string {
  return key.export({ type: "spki", format: "pem" }) as string;
}

/** Parse a public key from an SPKI PEM string. */
export function publicKeyFromPem(pem: string): KeyObject {
  return createPublicKey(pem);
}

/** Serialize a private key as a PKCS8 PEM string. */
export function privateKeyToPem(key: KeyObject): string {
  return key.export({ type: "pkcs8", format: "pem" }) as string;
}

/** Parse a private key from a PKCS8 PEM string. */
export function privateKeyFromPem(pem: string): KeyObject {
  return createPrivateKey(pem);
}

/** Raw 32-byte Ed25519 public key = the last 32 bytes of the SPKI DER. */
export function rawPublicKey(pub: KeyObject): Buffer {
  const der = pub.export({ type: "spki", format: "der" }) as Buffer;
  return Buffer.from(der.subarray(der.length - 32));
}

/** key_id = first 16 hex chars of SHA-256(raw 32-byte public key). */
export function keyId(pub: KeyObject): string {
  return sha256Hex(rawPublicKey(pub)).slice(0, 16);
}

/** Strip the five post-issuance fields, returning a shallow copy. */
function stripPostIssuance(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...obj };
  for (const f of POST_ISSUANCE_FIELDS) delete out[f];
  return out;
}

/**
 * Sign the stripped, canonicalized receipt object with Ed25519.
 * Returns the signature as lowercase hex.
 */
export function signStripped(
  obj: Record<string, unknown>,
  privateKey: KeyObject,
): string {
  const payload = canonicalBytes(stripPostIssuance(obj));
  return edSign(null, payload, privateKey).toString("hex");
}

/**
 * Verify a hex Ed25519 signature over the stripped, canonicalized receipt.
 * Accepts the public key as an SPKI PEM string or a KeyObject.
 */
export function verifyStripped(
  obj: Record<string, unknown>,
  pub: string | KeyObject,
  sigHex: string,
): boolean {
  const pubKey = typeof pub === "string" ? createPublicKey(pub) : pub;
  const payload = canonicalBytes(stripPostIssuance(obj));
  try {
    return edVerify(null, payload, pubKey, Buffer.from(sigHex, "hex"));
  } catch {
    return false;
  }
}
