// WebCrypto-only primitives: SHA-256, Ed25519, hex/PEM helpers, and the exact
// byte formats the AgentMint SDK verifier expects.

export const enc = new TextEncoder();

export function toHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, "0");
  return s;
}

const HEX_RE = /^(?:[0-9a-f]{2})*$/;
export function fromHex(h: string): Uint8Array {
  if (!HEX_RE.test(h)) throw new Error("invalid lowercase hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

/** RFC 6962 interior hash: SHA-256(0x01 || L || R). */
export async function hashInternal(l: Uint8Array, r: Uint8Array): Promise<Uint8Array> {
  const buf = new Uint8Array(65);
  buf[0] = 0x01;
  buf.set(l, 1);
  buf.set(r, 33);
  return sha256(buf);
}

/** RFC 6962 MTH of the empty tree: SHA-256(""). */
export async function emptyRoot(): Promise<Uint8Array> {
  return sha256(new Uint8Array(0));
}

// ── PEM / DER ───────────────────────────────────────────────────────

// SPKI DER prefix for an Ed25519 public key (RFC 8410), followed by the raw 32 bytes.
const SPKI_ED25519_PREFIX = fromHex("302a300506032b6570032100");
// PKCS8 DER prefix for an Ed25519 private key, followed by the raw 32-byte seed.
const PKCS8_ED25519_PREFIX = fromHex("302e020100300506032b657004220420");

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64encode(b: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]!);
  return btoa(bin);
}

export function pemToDer(pem: string, label: string): Uint8Array {
  const re = new RegExp(`-----BEGIN ${label}-----([\\s\\S]+?)-----END ${label}-----`);
  const m = re.exec(pem);
  if (!m) throw new Error(`expected a PEM ${label}`);
  return b64decode(m[1]!.replace(/\s+/g, ""));
}

/** Same shape as node's KeyObject.export({type:"spki",format:"pem"}). */
export function rawPublicKeyToPem(raw: Uint8Array): string {
  const der = new Uint8Array(SPKI_ED25519_PREFIX.length + 32);
  der.set(SPKI_ED25519_PREFIX);
  der.set(raw, SPKI_ED25519_PREFIX.length);
  const b64 = b64encode(der).replace(/(.{64})/g, "$1\n").replace(/\n$/, "");
  return `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----\n`;
}

/** Parse an Ed25519 SPKI PEM into its raw 32-byte public key + a verify key. */
export async function importEd25519PublicPem(pem: string): Promise<{ raw: Uint8Array; key: CryptoKey }> {
  const der = pemToDer(pem, "PUBLIC KEY");
  if (der.length !== 44 || toHex(der.subarray(0, 12)) !== toHex(SPKI_ED25519_PREFIX)) {
    throw new Error("public_key_pem is not an Ed25519 SPKI key");
  }
  const raw = der.slice(12);
  const key = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, true, ["verify"]);
  return { raw, key };
}

export async function importEd25519PublicRaw(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
}

/** key_id = first 16 hex of SHA-256(raw 32-byte public key) — same as the SDK keyId(). */
export async function keyIdOf(raw: Uint8Array): Promise<string> {
  return toHex(await sha256(raw)).slice(0, 16);
}

export interface LogSigner {
  privateKey: CryptoKey;
  publicRaw: Uint8Array;
  publicPem: string;
  keyId: string;
}

/**
 * Load the log signing key from AUTHORITY_PRIVATE_KEY: either a PKCS8 PEM
 * ("-----BEGIN PRIVATE KEY-----", what node / openssl emit) or 64 hex chars
 * (the raw 32-byte Ed25519 seed).
 */
export async function loadLogSigner(secret: string): Promise<LogSigner> {
  const s = secret.trim();
  let pkcs8: Uint8Array;
  if (/^[0-9a-fA-F]{64}$/.test(s)) {
    pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
    pkcs8.set(PKCS8_ED25519_PREFIX);
    pkcs8.set(fromHex(s.toLowerCase()), PKCS8_ED25519_PREFIX.length);
  } else {
    pkcs8 = pemToDer(s.replace(/\\n/g, "\n"), "PRIVATE KEY");
  }
  const extractable = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
  const jwk = (await crypto.subtle.exportKey("jwk", extractable)) as JsonWebKey;
  if (!jwk.x) throw new Error("could not derive log public key");
  const publicRaw = b64decode(jwk.x.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (jwk.x.length % 4)) % 4));
  const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  return { privateKey, publicRaw, publicPem: rawPublicKeyToPem(publicRaw), keyId: await keyIdOf(publicRaw) };
}

export async function ed25519Sign(key: CryptoKey, msg: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, msg)));
}

export async function ed25519Verify(key: CryptoKey, sigHex: string, msg: Uint8Array): Promise<boolean> {
  let sig: Uint8Array;
  try {
    sig = fromHex(sigHex);
  } catch {
    return false;
  }
  if (sig.length !== 64) return false;
  return crypto.subtle.verify({ name: "Ed25519" }, key, sig, msg);
}

// ── STH ─────────────────────────────────────────────────────────────

export interface Sth {
  tree_size: number;
  root_hash: string;
  timestamp: string;
}

/**
 * Canonical JSON (JCS, SDK canonicalBytes) of the STH. Keys sorted by code
 * point: root_hash < timestamp < tree_size. Values are lowercase hex, an ASCII
 * ISO timestamp and a safe integer, so no escaping or number formatting
 * ambiguity: this is byte-identical to canonicalBytes(sth).
 */
export function sthCanonicalBytes(sth: Sth): Uint8Array {
  if (!Number.isSafeInteger(sth.tree_size) || sth.tree_size < 0) throw new Error("bad tree_size");
  if (!/^[0-9a-f]{64}$/.test(sth.root_hash)) throw new Error("bad root_hash");
  if (!/^[0-9T:.+-]+$/.test(sth.timestamp)) throw new Error("bad timestamp");
  return enc.encode(
    `{"root_hash":"${sth.root_hash}","timestamp":"${sth.timestamp}","tree_size":${sth.tree_size}}`,
  );
}

/** SDK isoNowUtc(): Python isoformat() shape, microsecond precision, "+00:00". */
export function isoNowUtc(date = new Date()): string {
  return date.toISOString().replace(/\.(\d{3})Z$/, ".$1000+00:00");
}
