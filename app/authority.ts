// Signing authority: a transparency log that sees leaf hashes only.
//
// Local dev fallback for the production authority (same HTTP contract). It
// registers issuer keys, accepts batches of leaf hashes signed once by the
// issuer, appends them to an RFC 6962 log, signs ONE tree head per batch and
// returns an inclusion proof per leaf in the SDK's LogInclusionProof shape.
// It never receives receipt content, PHI or prompts.
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";
import { canonicalBytes } from "../src/kernel/canonical.js";
import { generateKeyPair, keyId, privateKeyFromPem, publicKeyToPem } from "../src/kernel/sign.js";
import { isoNowUtc, type LogInclusionProof } from "../src/receipt-aerf.js";
import { IncrementalLog } from "./log.js";

export type Sth = { tree_size: number; root_hash: string; timestamp: string };
export interface BatchResponse {
  batch_id: number;
  tree_size_before: number;
  proofs: LogInclusionProof[];
  sth: Sth;
  sth_signature: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const MAX_LEAVES = 4096;
const MAX_BODY = 1 << 20;

/** The digest an issuer signs for a batch: sha256 over the concatenated 32-byte leaf hashes. */
export function batchDigest(leafHashes: readonly string[]): Buffer {
  const h = createHash("sha256");
  for (const l of leafHashes) h.update(Buffer.from(l, "hex"));
  return h.digest();
}

export class Authority {
  readonly log = new IncrementalLog();
  readonly logId: string;
  readonly publicKeyPem: string;
  private readonly key: KeyObject;
  private readonly issuers = new Map<string, KeyObject>();
  private batches = 0;
  private latest: { sth: Sth; sth_signature: string };

  constructor(opts: { privateKeyPem?: string } = {}) {
    this.key = opts.privateKeyPem ? privateKeyFromPem(opts.privateKeyPem) : generateKeyPair().privateKey;
    const pub = createPublicKey(this.key);
    this.logId = `filet-log-${keyId(pub)}`;
    this.publicKeyPem = publicKeyToPem(pub);
    this.latest = this.signTreeHead();
  }

  registerIssuer(publicKeyPem: string): string {
    const pub = createPublicKey(publicKeyPem);
    if (pub.asymmetricKeyType !== "ed25519") throw new HttpError(400, "issuer key must be Ed25519");
    const id = keyId(pub);
    this.issuers.set(id, pub);
    return id;
  }

  appendBatch(body: { key_id?: unknown; leaf_hashes?: unknown; batch_signature?: unknown }): BatchResponse {
    const pub = typeof body.key_id === "string" ? this.issuers.get(body.key_id) : undefined;
    if (!pub) throw new HttpError(403, "unknown issuer key_id");
    const leaves = body.leaf_hashes;
    if (!Array.isArray(leaves) || leaves.length === 0 || leaves.length > MAX_LEAVES) {
      throw new HttpError(400, `leaf_hashes must hold 1..${MAX_LEAVES} entries`);
    }
    if (!leaves.every((l) => typeof l === "string" && HEX64.test(l))) throw new HttpError(400, "leaf hash malformed");
    const sig = body.batch_signature;
    if (typeof sig !== "string" || !/^[0-9a-f]{128}$/.test(sig) ||
        !edVerify(null, batchDigest(leaves as string[]), pub, Buffer.from(sig, "hex"))) {
      throw new HttpError(403, "batch_signature invalid");
    }
    const before = this.log.size;
    for (const l of leaves as string[]) this.log.append(l);
    this.latest = this.signTreeHead();
    const { sth, sth_signature } = this.latest;
    const proofs = (leaves as string[]).map((leaf_hash, i): LogInclusionProof => ({
      log_id: this.logId,
      leaf_hash,
      leaf_index: before + i,
      tree_size: sth.tree_size,
      audit_path: this.log.inclusionProof(before + i, sth.tree_size),
      sth,
      sth_signature,
    }));
    this.batches += 1;
    return { batch_id: this.batches, tree_size_before: before, proofs, sth, sth_signature };
  }

  sth(): { sth: Sth; sth_signature: string } {
    return this.latest;
  }

  consistency(from: number, to: number): { from: number; to: number; proof: string[] } {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || from > to || to > this.log.size) {
      throw new HttpError(400, "require 1 <= from <= to <= tree_size");
    }
    return { from, to, proof: this.log.consistencyProof(from, to) };
  }

  private signTreeHead(): { sth: Sth; sth_signature: string } {
    const sth: Sth = { tree_size: this.log.size, root_hash: this.log.root(), timestamp: isoNowUtc() };
    return { sth, sth_signature: edSign(null, canonicalBytes(sth), this.key).toString("hex") };
  }

  /** Route a request under the authority prefix (path like "/v1/sth"). */
  async handle(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams): Promise<void> {
    try {
      const m = req.method ?? "GET";
      if (m === "GET" && path === "/v1/key") return json(res, 200, { log_id: this.logId, public_key_pem: this.publicKeyPem });
      if (m === "GET" && path === "/v1/sth") return json(res, 200, this.sth());
      if (m === "GET" && path === "/v1/consistency") {
        return json(res, 200, this.consistency(Number(query.get("from")), Number(query.get("to"))));
      }
      if (m === "POST" && path === "/v1/issuers") {
        const body = (await readJson(req)) as { public_key_pem?: unknown };
        if (typeof body.public_key_pem !== "string") throw new HttpError(400, "public_key_pem required");
        return json(res, 200, { key_id: this.registerIssuer(body.public_key_pem) });
      }
      if (m === "POST" && path === "/v1/batches") return json(res, 200, this.appendBatch((await readJson(req)) as object));
      json(res, 404, { error: "not found" });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 400;
      json(res, status, { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

/** API base for an authority origin: "https://host" -> "https://host/authority". */
export function authorityBase(url: string): string {
  const u = url.replace(/\/+$/, "");
  return u.endsWith("/authority") ? u : `${u}/authority`;
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", "content-length": buf.length });
  res.end(buf);
}

export async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "body too large");
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}
