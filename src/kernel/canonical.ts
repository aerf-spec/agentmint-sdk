/**
 * @kernel
 * AERF-conformant canonical JSON (JCS) + hashing primitives.
 *
 * This is the crypto core the wedge signs and verifies over. Semantics are
 * fixed by AERF SPEC.md §5.1 and locked by the conformance oracle
 * (test/aerf-verify-poc.mjs) and the Python producer / Go verifier:
 *
 *  - Object keys sorted by Unicode code point; separators "," and ":" with no
 *    whitespace.
 *  - Strings NFC-normalized; RFC 8785 §3.2.2.2 escapes ONLY
 *    (\" \\ \b \f \n \r \t), other control chars as \u00XX lowercase hex, and
 *    RAW UTF-8 for every other character (never \uXXXX for printable non-ASCII).
 *  - Numbers: the producer path THROWS a TypeError naming the JSON path on any
 *    non-integer finite number (JS cannot round-trip e.g. 1250.0). -0 becomes 0.
 *    NaN/Infinity are rejected.
 *
 * The verifier path must instead replay each number's ORIGINAL lexeme verbatim
 * from the source bytes (like Go's json.Number) — feed a {@link RawNumberLexeme}
 * sentinel in place of a JS number and it is emitted unchanged.
 *
 * Kernel rule: this module imports node:crypto only. It never imports from
 * experimental/ or from .vendor/.
 */
import { createHash } from "node:crypto";

/**
 * A number replayed verbatim from source bytes. The verify path parses receipt
 * JSON preserving each number's original lexeme (e.g. "1250.0") and wraps it in
 * this sentinel so canonicalization emits it unchanged instead of round-tripping
 * it through a lossy JS number.
 */
export interface RawNumberLexeme {
  readonly __raw_number_lexeme: true;
  readonly value: string;
}

/** Wrap a verbatim numeric lexeme so canonicalize() emits it unchanged. */
export function rawNumber(lexeme: string): RawNumberLexeme {
  return { __raw_number_lexeme: true, value: lexeme };
}

function isRawNumberLexeme(value: unknown): value is RawNumberLexeme {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __raw_number_lexeme?: unknown }).__raw_number_lexeme === true &&
    typeof (value as { value?: unknown }).value === "string"
  );
}

function encodeString(value: string): string {
  let out = '"';
  for (const ch of value.normalize("NFC")) {
    switch (ch) {
      case '"':
        out += '\\"';
        break;
      case "\\":
        out += "\\\\";
        break;
      case "\b":
        out += "\\b";
        break;
      case "\f":
        out += "\\f";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\t":
        out += "\\t";
        break;
      default: {
        const code = ch.codePointAt(0)!;
        if (code <= 0x1f) {
          out += "\\u" + code.toString(16).padStart(4, "0");
        } else {
          // RAW UTF-8 for everything else — never \uXXXX for printable chars.
          out += ch;
        }
      }
    }
  }
  return out + '"';
}

function encodeNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) {
    throw new TypeError(
      `Non-finite number (${value}) at JSON path ${path}: canonical JSON forbids NaN/Infinity`,
    );
  }
  if (!Number.isInteger(value)) {
    throw new TypeError(
      `Non-integer finite number (${value}) at JSON path ${path}: canonical JSON ` +
        `cannot round-trip fractional numbers — use integer micro-units or a string`,
    );
  }
  if (Object.is(value, -0)) return "0";
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(
      `Unsafe integer (${value}) at JSON path ${path}: exceeds Number.MAX_SAFE_INTEGER — use a string`,
    );
  }
  return String(value);
}

function joinKey(path: string, key: string): string {
  return path === "$" ? `$.${key}` : `${path}.${key}`;
}

function encode(value: unknown, path: string): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") return encodeString(value);
  if (typeof value === "number") return encodeNumber(value, path);
  if (isRawNumberLexeme(value)) return value.value;
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) {
    return "[" + value.map((entry, i) => encode(entry, `${path}[${i}]`)).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // Skip undefined-valued keys (mirrors JSON.stringify object semantics).
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .map((k) => ({ raw: k, norm: k.normalize("NFC") }));
    const seen = new Set<string>();
    for (const k of keys) {
      if (seen.has(k.norm)) {
        throw new TypeError(`Duplicate object key after NFC normalization: ${k.raw}`);
      }
      seen.add(k.norm);
    }
    keys.sort((a, b) => compareCodePoints(a.norm, b.norm));
    return (
      "{" +
      keys
        .map((k) => encodeString(k.norm) + ":" + encode(obj[k.raw], joinKey(path, k.norm)))
        .join(",") +
      "}"
    );
  }
  throw new TypeError(`Unsupported value at JSON path ${path}: ${String(value)}`);
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

/** Canonicalize a value to a JCS string per AERF SPEC.md §5.1. */
export function canonicalize(value: unknown): string {
  return encode(value, "$");
}

/** Canonicalize a value to UTF-8 bytes — the exact bytes that get signed. */
export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalize(value), "utf-8");
}

/** SHA-256 of a buffer, as lowercase hex. */
export function sha256Hex(buf: Buffer | Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** SHA-512 of a buffer, as lowercase hex. */
export function sha512Hex(buf: Buffer | Uint8Array): string {
  return createHash("sha512").update(buf).digest("hex");
}
