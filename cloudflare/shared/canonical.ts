// Canonical JSON (JCS), byte-identical to the AgentMint SDK's src/kernel/canonical.ts
// (producer path): keys sorted by code point, NFC strings, RFC 8785 escapes only,
// raw UTF-8 otherwise, integers only (fractional numbers throw), -0 -> 0.
// Workers-safe: no node:crypto, no Buffer.

export const enc = new TextEncoder();

function encodeString(value: string): string {
  let out = '"';
  for (const ch of value.normalize("NFC")) {
    switch (ch) {
      case '"': out += '\\"'; break;
      case "\\": out += "\\\\"; break;
      case "\b": out += "\\b"; break;
      case "\f": out += "\\f"; break;
      case "\n": out += "\\n"; break;
      case "\r": out += "\\r"; break;
      case "\t": out += "\\t"; break;
      default: {
        const code = ch.codePointAt(0)!;
        out += code <= 0x1f ? "\\u" + code.toString(16).padStart(4, "0") : ch;
      }
    }
  }
  return out + '"';
}

function encodeNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) throw new TypeError(`Non-finite number at ${path}`);
  if (Object.is(value, -0)) return "0";
  if (!Number.isInteger(value)) throw new TypeError(`Non-integer number (${value}) at ${path}`);
  if (!Number.isSafeInteger(value)) throw new TypeError(`Unsafe integer (${value}) at ${path}`);
  return String(value);
}

function compareCodePoints(a: string, b: string): number {
  const ap = Array.from(a);
  const bp = Array.from(b);
  const len = Math.min(ap.length, bp.length);
  for (let i = 0; i < len; i++) {
    const d = ap[i]!.codePointAt(0)! - bp[i]!.codePointAt(0)!;
    if (d !== 0) return d;
  }
  return ap.length - bp.length;
}

function encode(value: unknown, path: string): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") return encodeString(value);
  if (typeof value === "number") return encodeNumber(value, path);
  if (Array.isArray(value)) return "[" + value.map((v, i) => encode(v, `${path}[${i}]`)).join(",") + "]";
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .map((k) => ({ raw: k, norm: k.normalize("NFC") }));
    const seen = new Set<string>();
    for (const k of keys) {
      if (seen.has(k.norm)) throw new TypeError(`Duplicate key after NFC: ${k.raw}`);
      seen.add(k.norm);
    }
    keys.sort((a, b) => compareCodePoints(a.norm, b.norm));
    return "{" + keys.map((k) => encodeString(k.norm) + ":" + encode(obj[k.raw], `${path}.${k.norm}`)).join(",") + "}";
  }
  throw new TypeError(`Unsupported value at ${path}`);
}

export function canonicalize(value: unknown): string {
  return encode(value, "$");
}

export function canonicalBytes(value: unknown): Uint8Array {
  return enc.encode(canonicalize(value));
}

export const POST_ISSUANCE_FIELDS = ["signature", "timestamp", "parent_signature", "parent_key_id", "log_inclusion_proof"];

/** SDK signedPayloadBytes: receipt minus post-issuance fields, canonicalized. */
export function signedPayloadBytes(receipt: Record<string, unknown>): Uint8Array {
  const o: Record<string, unknown> = { ...receipt };
  for (const f of POST_ISSUANCE_FIELDS) delete o[f];
  return canonicalBytes(o);
}

export function toHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, "0");
  return s;
}

export function fromHex(h: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(h)) throw new Error("invalid lowercase hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  const b = typeof data === "string" ? enc.encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", b));
}
export const sha256Hex = async (d: Uint8Array | string) => toHex(await sha256(d));
export const sha512Hex = async (d: Uint8Array | string) =>
  toHex(new Uint8Array(await crypto.subtle.digest("SHA-512", typeof d === "string" ? enc.encode(d) : d)));

/** RFC 6962 leaf hash SHA-256(0x00 || data), hex. */
export async function logLeafHash(data: Uint8Array): Promise<string> {
  const b = new Uint8Array(data.length + 1);
  b.set(data, 1);
  return sha256Hex(b);
}

async function hashInternal(lHex: string, rHex: string): Promise<string> {
  const b = new Uint8Array(65);
  b[0] = 1;
  b.set(fromHex(lHex), 1);
  b.set(fromHex(rHex), 33);
  return sha256Hex(b);
}

/** RFC 9162 §2.1.3.2 — mirrors SDK walkAuditPath. "" on structural failure. */
export async function walkAuditPath(leaf: string, path: readonly string[], leafIndex: number, treeSize: number): Promise<string> {
  if (leafIndex < 0 || treeSize < 1 || leafIndex >= treeSize) return "";
  let fn = leafIndex;
  let sn = treeSize - 1;
  let r = leaf;
  for (const p of path) {
    if (sn === 0) return "";
    if (fn % 2 === 1 || fn === sn) {
      r = await hashInternal(p, r);
      if (fn % 2 === 0) while (fn % 2 === 0 && fn !== 0) { fn = Math.floor(fn / 2); sn = Math.floor(sn / 2); }
    } else {
      r = await hashInternal(r, p);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 ? r : "";
}

/** RFC 9162 §2.1.4.2 consistency verification. */
export async function verifyConsistency(first: number, second: number, firstHash: string, secondHash: string, proof: string[]): Promise<boolean> {
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
      fr = await hashInternal(c, fr);
      sr = await hashInternal(c, sr);
      if (!(fn & 1)) while (!(fn & 1) && fn !== 0) { fn >>= 1; sn >>= 1; }
    } else {
      sr = await hashInternal(sr, c);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 && fr === firstHash && sr === secondHash;
}

// ── Ed25519 / PEM ──
const SPKI_PREFIX = "302a300506032b6570032100";
const PKCS8_PREFIX = "302e020100300506032b657004220420";

function b64d(s: string): Uint8Array {
  const bin = atob(s);
  const o = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i);
  return o;
}
function b64e(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s);
}

export function rawPublicKeyToPem(raw: Uint8Array): string {
  const der = fromHex(SPKI_PREFIX + toHex(raw));
  return `-----BEGIN PUBLIC KEY-----\n${b64e(der).replace(/(.{64})/g, "$1\n").replace(/\n$/, "")}\n-----END PUBLIC KEY-----\n`;
}

export function pemToRawPublic(pem: string): Uint8Array {
  const m = /-----BEGIN PUBLIC KEY-----([\s\S]+?)-----END PUBLIC KEY-----/.exec(pem);
  if (!m) throw new Error("expected PUBLIC KEY PEM");
  const der = b64d(m[1]!.replace(/\s+/g, ""));
  if (der.length !== 44 || toHex(der.subarray(0, 12)) !== SPKI_PREFIX) throw new Error("not an Ed25519 SPKI key");
  return der.slice(12);
}

export async function importPublicPem(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", pemToRawPublic(pem), { name: "Ed25519" }, false, ["verify"]);
}

export async function keyIdOfRaw(raw: Uint8Array): Promise<string> {
  return (await sha256Hex(raw)).slice(0, 16);
}

/** Private key from 64-hex seed or PKCS8 PEM. */
export async function loadPrivateKey(secret: string): Promise<{ key: CryptoKey; publicRaw: Uint8Array; publicPem: string; keyId: string }> {
  const s = secret.trim();
  let pkcs8: Uint8Array;
  if (/^[0-9a-fA-F]{64}$/.test(s)) pkcs8 = fromHex(PKCS8_PREFIX + s.toLowerCase());
  else {
    const m = /-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/.exec(s.replace(/\\n/g, "\n"));
    if (!m) throw new Error("expected PKCS8 PEM or 64-hex seed");
    pkcs8 = b64d(m[1]!.replace(/\s+/g, ""));
  }
  const ex = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
  const jwk = (await crypto.subtle.exportKey("jwk", ex)) as JsonWebKey;
  const x = jwk.x!.replace(/-/g, "+").replace(/_/g, "/");
  const publicRaw = b64d(x + "=".repeat((4 - (x.length % 4)) % 4));
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  return { key, publicRaw, publicPem: rawPublicKeyToPem(publicRaw), keyId: await keyIdOfRaw(publicRaw) };
}

export async function edSign(key: CryptoKey, msg: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, msg)));
}

export async function edVerify(key: CryptoKey, sigHex: string, msg: Uint8Array): Promise<boolean> {
  if (!/^[0-9a-f]{128}$/.test(sigHex)) return false;
  return crypto.subtle.verify({ name: "Ed25519" }, key, fromHex(sigHex), msg);
}

/** Python isoformat() shape used by the SDK: microseconds, "+00:00". */
export function isoNowUtc(d = new Date()): string {
  return d.toISOString().replace(/\.(\d{3})Z$/, ".$1000+00:00");
}

/** Batch message the issuer signs: SHA-256(concat(raw leaves) || utf8(batch_ts)). */
export async function batchMessage(leafHashes: string[], batchTs: string): Promise<Uint8Array> {
  const ts = enc.encode(batchTs);
  const buf = new Uint8Array(leafHashes.length * 32 + ts.length);
  leafHashes.forEach((h, i) => buf.set(fromHex(h), i * 32));
  buf.set(ts, leafHashes.length * 32);
  return sha256(buf);
}
