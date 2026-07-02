// AERF conformance suite — reproduce EVERY oracle expectation using ONLY the
// two kernel modules (canonical + sign). This is the TS port's acceptance bar;
// it mirrors test/aerf-verify-poc.mjs but drives src/kernel directly.
//
// The verifier path replays each number's original lexeme verbatim from the
// vector source bytes (vector 01 contains 1250.0, which a plain JSON.parse →
// canonicalize round-trip would lose). We do that with a small number-
// preserving JSON reader that wraps every number in the kernel's
// RawNumberLexeme sentinel.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rawNumber, type RawNumberLexeme } from "../src/kernel/canonical.js";
import { verifyStripped, keyId, publicKeyFromPem } from "../src/kernel/sign.js";

const here = dirname(fileURLToPath(import.meta.url));
const vectorsDir = join(here, "vectors");

// ── Number-preserving JSON reader ───────────────────────────────────
// Produces plain objects/arrays with numbers wrapped as RawNumberLexeme so
// canonicalize() emits their original lexeme verbatim (like Go's json.Number).
type Preserved =
  | null
  | boolean
  | string
  | RawNumberLexeme
  | Preserved[]
  | { [k: string]: Preserved };

function parsePreserving(src: string): Preserved {
  let i = 0;
  const skipWs = () => {
    while (i < src.length && (src[i] === " " || src[i] === "\n" || src[i] === "\r" || src[i] === "\t")) i++;
  };
  function value(): Preserved {
    skipWs();
    const c = src[i];
    if (c === "{") return obj();
    if (c === "[") return arr();
    if (c === '"') return str();
    if (c === "t") { i += 4; return true; }
    if (c === "f") { i += 5; return false; }
    if (c === "n") { i += 4; return null; }
    return num();
  }
  function obj(): { [k: string]: Preserved } {
    i++; const out: { [k: string]: Preserved } = {}; skipWs();
    if (src[i] === "}") { i++; return out; }
    for (;;) {
      skipWs(); const k = str(); skipWs(); i++; // ':'
      out[k] = value(); skipWs();
      if (src[i] === ",") { i++; continue; }
      i++; return out; // '}'
    }
  }
  function arr(): Preserved[] {
    i++; const out: Preserved[] = []; skipWs();
    if (src[i] === "]") { i++; return out; }
    for (;;) {
      out.push(value()); skipWs();
      if (src[i] === ",") { i++; continue; }
      i++; return out; // ']'
    }
  }
  function str(): string {
    let out = ""; i++; // opening quote
    while (src[i] !== '"') {
      if (src[i] === "\\") {
        const e = src[i + 1];
        if (e === "u") {
          out += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16));
          i += 6;
        } else {
          out += ({ '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" } as Record<string, string>)[e!];
          i += 2;
        }
      } else {
        out += src[i++];
      }
    }
    i++; return out;
  }
  function num(): RawNumberLexeme {
    const start = i;
    while (i < src.length && /[-+0-9.eE]/.test(src[i]!)) i++;
    return rawNumber(src.slice(start, i));
  }
  return value();
}

interface ManifestEntry {
  dir: string;
  outcome: string;
  reason_code: string;
}

const manifest: ManifestEntry[] = JSON.parse(
  readFileSync(join(vectorsDir, "manifest.json"), "utf-8"),
);

function loadReceipts(dir: string): Record<string, Preserved>[] {
  const receiptPath = join(dir, "receipt.json");
  if (existsSync(receiptPath)) {
    return [parsePreserving(readFileSync(receiptPath, "utf-8")) as Record<string, Preserved>];
  }
  const receiptsDir = join(dir, "receipts");
  if (existsSync(receiptsDir)) {
    return readdirSync(receiptsDir)
      .sort()
      .map((f) => parsePreserving(readFileSync(join(receiptsDir, f), "utf-8")) as Record<string, Preserved>);
  }
  throw new Error(`no receipts in ${dir}`);
}

describe("AERF conformance vectors", () => {
  it("has a non-empty manifest", () => {
    expect(manifest.length).toBeGreaterThanOrEqual(12);
  });

  for (const v of manifest) {
    it(`${v.dir} matches its expected outcome`, () => {
      const dir = join(vectorsDir, v.dir);
      const pubPem = readFileSync(join(dir, "public_key.pem"), "utf-8");
      const receipts = loadReceipts(dir);

      const allValid = receipts.every((r) => {
        const sig = r["signature"];
        expect(typeof sig).toBe("string");
        return verifyStripped(r as Record<string, unknown>, pubPem, sig as string);
      });

      // A vector is expected to verify at the signature layer UNLESS it is a
      // FAIL specifically for issuer_signature (the two tamper vectors).
      const expectValid = !(v.outcome === "FAIL" && v.reason_code === "issuer_signature");
      expect(allValid, `${v.dir}: sig valid ${allValid}, expected ${expectValid}`).toBe(expectValid);
    });
  }

  it("both tamper vectors fail on issuer_signature", () => {
    for (const name of ["03-tamper-evidence", "04-tamper-chain"]) {
      const dir = join(vectorsDir, name);
      const pubPem = readFileSync(join(dir, "public_key.pem"), "utf-8");
      const receipts = loadReceipts(dir);
      const allValid = receipts.every((r) =>
        verifyStripped(r as Record<string, unknown>, pubPem, r["signature"] as string),
      );
      expect(allValid).toBe(false);
    }
  });

  it("derives the issuer key_id from the public key (SPKI DER last 32 bytes)", () => {
    // Vector 01's issuer key_id is locked; sign.ts must reproduce it.
    const dir = join(vectorsDir, "01-genesis-happy-path");
    const pubPem = readFileSync(join(dir, "public_key.pem"), "utf-8");
    const receipt = parsePreserving(readFileSync(join(dir, "receipt.json"), "utf-8")) as Record<
      string,
      Preserved
    >;
    expect(keyId(publicKeyFromPem(pubPem))).toBe(receipt["key_id"]);
  });
});
