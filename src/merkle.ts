import { createHash } from "node:crypto";
import type { MerkleProof } from "./types.js";

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

// ── RFC 6962 primitives (domain-separated hashing) ──────────────────
// These mirror the Go reference verifier's LogLeafHash / hashInternal /
// walkAuditPath exactly. Domain separation (0x00 leaf / 0x01 interior)
// prevents an interior node from being presented as a leaf.

/** RFC 6962 leaf hash: SHA-256(0x00 || data), lowercase hex. */
export function logLeafHash(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
  return createHash("sha256").update(Buffer.from([0x00])).update(bytes).digest("hex");
}

/** RFC 6962 interior hash: SHA-256(0x01 || left || right), hex in/out. */
export function hashInternal(leftHex: string, rightHex: string): string {
  return createHash("sha256")
    .update(Buffer.from([0x01]))
    .update(Buffer.from(leftHex, "hex"))
    .update(Buffer.from(rightHex, "hex"))
    .digest("hex");
}

/**
 * Recompute the root from a leaf hash and an RFC 6962 inclusion proof,
 * following RFC 9162 §2.1.3.2 exactly. Returns "" for a structurally invalid
 * proof (wrong path length for the index/size), which can never equal a root.
 *
 * Agrees with the Go reference verifier's walkAuditPath on every conformance
 * vector; where they differ is Go's right-edge promote branch, which consumes
 * a path entry without hashing it and rejects valid standard proofs for the
 * last leaf of a non-power-of-two tree. Standard semantics win here (the
 * reference proof BUILDER in the aerf repo emits standard RFC 6962 paths).
 */
export function walkAuditPath(
  leafHashHex: string,
  pathHex: readonly string[],
  leafIndex: number,
  treeSize: number,
): string {
  if (leafIndex < 0 || treeSize < 1 || leafIndex >= treeSize) return "";
  let fn = leafIndex;
  let sn = treeSize - 1;
  let r = leafHashHex;
  for (const p of pathHex) {
    if (sn === 0) return "";
    if (fn % 2 === 1 || fn === sn) {
      r = hashInternal(p, r);
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn = Math.floor(fn / 2);
          sn = Math.floor(sn / 2);
        }
      }
    } else {
      r = hashInternal(r, p);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 ? r : "";
}

interface RawNumberLexeme {
  readonly __raw_number_lexeme: true;
  readonly value: string;
}

type CanonicalNode =
  | null
  | boolean
  | number
  | string
  | RawNumberLexeme
  | CanonicalNode[]
  | { [key: string]: CanonicalNode };

function isRawNumberLexeme(value: unknown): value is RawNumberLexeme {
  return (
    typeof value === "object" &&
    value !== null &&
    "__raw_number_lexeme" in value &&
    (value as { __raw_number_lexeme?: unknown }).__raw_number_lexeme === true
  );
}

function normalized(value: string): string {
  return value.normalize("NFC");
}

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  const len = Math.min(leftPoints.length, rightPoints.length);

  for (let i = 0; i < len; i += 1) {
    const a = leftPoints[i]!.codePointAt(0)!;
    const b = rightPoints[i]!.codePointAt(0)!;
    if (a !== b) return a - b;
  }

  return leftPoints.length - rightPoints.length;
}

function encodeString(value: string): string {
  let out = '"';

  for (const ch of normalized(value)) {
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
        const codePoint = ch.codePointAt(0)!;
        if (codePoint <= 0x1f) {
          out += `\\u00${codePoint.toString(16).padStart(2, "0")}`;
        } else {
          out += ch;
        }
      }
    }
  }

  return out + '"';
}

function encodeNumber(value: number): string {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new TypeError(
      "Canonical JSON producer only supports finite integers in signed payloads",
    );
  }
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(
      "Canonical JSON producer only supports safe integers in signed payloads",
    );
  }
  return Object.is(value, -0) ? "0" : String(value);
}

function encodeArray(value: readonly CanonicalNode[]): string {
  return `[${value.map((entry) => encodeCanonical(entry)).join(",")}]`;
}

function encodeObject(value: Record<string, CanonicalNode>): string {
  const entries = Object.entries(value).map(([key, entry]) => ({
    rawKey: key,
    normalizedKey: normalized(key),
    entry,
  }));

  const seen = new Set<string>();
  for (const item of entries) {
    if (seen.has(item.normalizedKey)) {
      throw new TypeError(`Duplicate object key after NFC normalization: ${item.rawKey}`);
    }
    seen.add(item.normalizedKey);
  }

  entries.sort((a, b) => compareUnicodeCodePoints(a.normalizedKey, b.normalizedKey));

  return `{${entries
    .map((item) => `${encodeString(item.normalizedKey)}:${encodeCanonical(item.entry)}`)
    .join(",")}}`;
}

function encodeCanonical(value: CanonicalNode): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return encodeNumber(value);
  if (typeof value === "string") return encodeString(value);
  if (isRawNumberLexeme(value)) return value.value;
  if (Array.isArray(value)) return encodeArray(value);
  return encodeObject(value);
}

function asCanonicalNode(value: unknown): CanonicalNode {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => asCanonicalNode(entry));
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        asCanonicalNode(entry),
      ]),
    );
  }

  throw new TypeError(`Unsupported value in canonicalize(): ${String(value)}`);
}

class JsonParser {
  private index = 0;

  constructor(private readonly input: string) {}

  parse(): CanonicalNode {
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.input.length) {
      throw new SyntaxError(`Unexpected trailing content at index ${this.index}`);
    }
    return value;
  }

  private parseValue(): CanonicalNode {
    this.skipWhitespace();
    const ch = this.peek();

    if (ch === '"') return this.parseString();
    if (ch === "{") return this.parseObject();
    if (ch === "[") return this.parseArray();
    if (ch === "t") return this.expectKeyword("true", true);
    if (ch === "f") return this.expectKeyword("false", false);
    if (ch === "n") return this.expectKeyword("null", null);
    if (ch === "-" || (ch !== undefined && ch >= "0" && ch <= "9")) {
      return this.parseNumber();
    }

    throw new SyntaxError(`Unexpected token ${ch ?? "EOF"} at index ${this.index}`);
  }

  private parseObject(): CanonicalNode {
    this.expectChar("{");
    this.skipWhitespace();
    const out: Record<string, CanonicalNode> = {};
    if (this.peek() === "}") {
      this.index += 1;
      return out;
    }

    while (true) {
      const key = this.parseString();
      this.skipWhitespace();
      this.expectChar(":");
      const value = this.parseValue();
      out[key] = value;
      this.skipWhitespace();
      const ch = this.peek();
      if (ch === "}") {
        this.index += 1;
        return out;
      }
      this.expectChar(",");
    }
  }

  private parseArray(): CanonicalNode {
    this.expectChar("[");
    this.skipWhitespace();
    const out: CanonicalNode[] = [];
    if (this.peek() === "]") {
      this.index += 1;
      return out;
    }

    while (true) {
      out.push(this.parseValue());
      this.skipWhitespace();
      const ch = this.peek();
      if (ch === "]") {
        this.index += 1;
        return out;
      }
      this.expectChar(",");
    }
  }

  private parseString(): string {
    this.expectChar('"');
    let out = "";

    while (true) {
      const ch = this.next();
      if (ch === undefined) {
        throw new SyntaxError("Unterminated string literal");
      }
      if (ch === '"') {
        return out;
      }
      if (ch === "\\") {
        const esc = this.next();
        switch (esc) {
          case '"':
          case "\\":
          case "/":
            out += esc;
            break;
          case "b":
            out += "\b";
            break;
          case "f":
            out += "\f";
            break;
          case "n":
            out += "\n";
            break;
          case "r":
            out += "\r";
            break;
          case "t":
            out += "\t";
            break;
          case "u": {
            const hex = this.input.slice(this.index, this.index + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              throw new SyntaxError(`Invalid unicode escape at index ${this.index}`);
            }
            out += String.fromCharCode(Number.parseInt(hex, 16));
            this.index += 4;
            break;
          }
          default:
            throw new SyntaxError(`Invalid escape sequence \\${esc ?? ""}`);
        }
        continue;
      }
      if (ch <= "\u001f") {
        throw new SyntaxError(`Unescaped control character at index ${this.index - 1}`);
      }
      out += ch;
    }
  }

  private parseNumber(): RawNumberLexeme {
    const start = this.index;
    let ch = this.peek();

    if (ch === "-") {
      this.index += 1;
      ch = this.peek();
    }

    if (ch === "0") {
      this.index += 1;
      ch = this.peek();
      if (ch !== undefined && ch >= "0" && ch <= "9") {
        throw new SyntaxError(`Invalid leading zero at index ${this.index}`);
      }
    } else if (ch !== undefined && ch >= "1" && ch <= "9") {
      this.index += 1;
      while (true) {
        ch = this.peek();
        if (ch === undefined || ch < "0" || ch > "9") break;
        this.index += 1;
      }
    } else {
      throw new SyntaxError(`Invalid number at index ${this.index}`);
    }

    if (this.peek() === ".") {
      this.index += 1;
      const digit = this.peek();
      if (digit === undefined || digit < "0" || digit > "9") {
        throw new SyntaxError(`Invalid fractional number at index ${this.index}`);
      }
      while (true) {
        ch = this.peek();
        if (ch === undefined || ch < "0" || ch > "9") break;
        this.index += 1;
      }
    }

    ch = this.peek();
    if (ch === "e" || ch === "E") {
      this.index += 1;
      ch = this.peek();
      if (ch === "+" || ch === "-") {
        this.index += 1;
      }
      const digit = this.peek();
      if (digit === undefined || digit < "0" || digit > "9") {
        throw new SyntaxError(`Invalid exponent at index ${this.index}`);
      }
      while (true) {
        ch = this.peek();
        if (ch === undefined || ch < "0" || ch > "9") break;
        this.index += 1;
      }
    }

    return { __raw_number_lexeme: true, value: this.input.slice(start, this.index) };
  }

  private expectKeyword<T>(keyword: string, value: T): T {
    if (this.input.slice(this.index, this.index + keyword.length) !== keyword) {
      throw new SyntaxError(`Expected ${keyword} at index ${this.index}`);
    }
    this.index += keyword.length;
    return value;
  }

  private skipWhitespace(): void {
    while (true) {
      const ch = this.peek();
      if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t") {
        this.index += 1;
        continue;
      }
      return;
    }
  }

  private expectChar(expected: string): void {
    const ch = this.next();
    if (ch !== expected) {
      throw new SyntaxError(`Expected ${expected} at index ${this.index - 1}`);
    }
  }

  private peek(): string | undefined {
    return this.input[this.index];
  }

  private next(): string | undefined {
    const ch = this.input[this.index];
    this.index += 1;
    return ch;
  }
}

export function canonicalize(obj: unknown): string {
  return encodeCanonical(asCanonicalNode(obj));
}

export function canonicalizeJson(input: string): string {
  return encodeCanonical(new JsonParser(input).parse());
}

export function canonicalizeToBytes(obj: unknown): Uint8Array {
  return Buffer.from(canonicalize(obj), "utf8");
}

export function canonicalizeJsonToBytes(input: string): Uint8Array {
  return Buffer.from(canonicalizeJson(input), "utf8");
}

// ── RFC 6962 Merkle tree ────────────────────────────────────────────
//
// Correct RFC 6962 semantics throughout (matching the AERF reference
// primitives in the aerf repo's tools/aerf_primitives.py and the Go
// verifier's leaf/interior hashes):
//
//  - leaf hash     = SHA-256(0x00 || data)
//  - interior hash = SHA-256(0x01 || left || right)
//  - split rule: the left subtree holds the largest power of two < n
//    leaves; NO padding leaves are ever inserted
//  - inclusion proofs are standard RFC 6962 audit paths, verifiable by
//    walkAuditPath and by any RFC 9162 checker
//
// Domain separation makes second-preimage splicing impossible: an interior
// node's bytes hash differently as a leaf (0x00 prefix) than as an interior
// node (0x01 prefix), so a subtree cannot be presented as a single leaf.

/** MTH of a slice of leaf HASHES (hex), per RFC 6962 §2.1. */
function merkleRoot(leafHashes: readonly string[]): string {
  if (leafHashes.length === 0) return sha256("");
  if (leafHashes.length === 1) return leafHashes[0]!;
  const mid = largestPowerOfTwoBelow(leafHashes.length);
  return hashInternal(merkleRoot(leafHashes.slice(0, mid)), merkleRoot(leafHashes.slice(mid)));
}

/** Largest power of two strictly less than n (n >= 2). */
function largestPowerOfTwoBelow(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/** RFC 6962 audit path (sibling hashes leaf→root) with positions. */
function auditPathWithPositions(
  leafHashes: readonly string[],
  index: number,
): Array<{ hash: string; position: "left" | "right" }> {
  if (leafHashes.length <= 1) return [];
  const mid = largestPowerOfTwoBelow(leafHashes.length);
  if (index < mid) {
    return [
      ...auditPathWithPositions(leafHashes.slice(0, mid), index),
      { hash: merkleRoot(leafHashes.slice(mid)), position: "right" },
    ];
  }
  return [
    ...auditPathWithPositions(leafHashes.slice(mid), index - mid),
    { hash: merkleRoot(leafHashes.slice(0, mid)), position: "left" },
  ];
}

export class MerkleTree {
  private leaves: string[] = [];

  /** Append a leaf; stores SHA-256(0x00 || data). Returns the leaf index. */
  addLeaf(data: string | Uint8Array): number {
    this.leaves.push(logLeafHash(data));
    return this.leaves.length - 1;
  }

  /** Number of leaves appended so far. */
  get leafCount(): number {
    return this.leaves.length;
  }

  /** Compute the RFC 6962 root. Empty tree hashes to SHA-256(""). */
  build(): string {
    return merkleRoot(this.leaves);
  }

  /** Standard RFC 6962 inclusion proof for the leaf at `index`. */
  getProof(leafIndex: number): MerkleProof {
    if (leafIndex < 0 || leafIndex >= this.leaves.length) {
      throw new RangeError(`leaf index ${leafIndex} out of range [0, ${this.leaves.length})`);
    }
    return {
      leaf: this.leaves[leafIndex]!,
      index: leafIndex,
      siblings: auditPathWithPositions(this.leaves, leafIndex),
      root: this.build(),
    };
  }

  /** Bare RFC 6962 audit path (hashes only), e.g. for a log_inclusion_proof. */
  auditPath(leafIndex: number): string[] {
    return this.getProof(leafIndex).siblings.map((s) => s.hash);
  }

  static verify(proof: MerkleProof): boolean {
    let hash = proof.leaf;
    for (const sibling of proof.siblings) {
      hash =
        sibling.position === "left"
          ? hashInternal(sibling.hash, hash)
          : hashInternal(hash, sibling.hash);
    }
    return hash === proof.root;
  }
}
