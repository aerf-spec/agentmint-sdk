// AgentMint signing authority: an append-only RFC 6962 transparency log of
// receipt leaf hashes, one signed tree head per batch, one inclusion proof per
// leaf. Sees hashes only — never receipt content.
//
// Worker (stateless router) → one Durable Object (single writer, SQLite storage).

import { DurableObject } from "cloudflare:workers";
import {
  ed25519Sign,
  ed25519Verify,
  fromHex,
  importEd25519PublicPem,
  importEd25519PublicRaw,
  isoNowUtc,
  keyIdOf,
  loadLogSigner,
  sha256,
  sthCanonicalBytes,
  toHex,
  type LogSigner,
  type Sth,
} from "./crypto";
import { appendLeaves, TreeView, type NodeReader } from "./merkle";
import {
  HttpError,
  RateLimiter,
  assertPostOrigin,
  corsHeaders,
  preflight,
  rateLimit,
  readCappedJson,
  requireBearer,
  strictObject,
} from "../../shared/http";
import { batchMessage } from "../../shared/canonical";

export interface Env {
  AUTHORITY_LOG: DurableObjectNamespace<AuthorityLog>;
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;
  AUTHORITY_PRIVATE_KEY?: string;
  REGISTRATION_TOKEN?: string;
  LOG_ID?: string;
}

export { RateLimiter };

const MAX_BATCH = 1024;
const MAX_BATCH_BODY = 96 * 1024; // 1024 leaves * 67 bytes + signature + framing
const MAX_ISSUER_BODY = 2 * 1024;
const BATCH_TS_SKEW_MS = 5 * 60 * 1000;
const LEAF_RE = /^[0-9a-f]{64}$/;
const KEY_ID_RE = /^[0-9a-f]{16}$/;
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/;
const METHODS = "GET, POST";
const ALLOW_HEADERS = "content-type, authorization";

// Per-IP limits (requests/minute). Internal service-binding calls carry no
// CF-Connecting-IP and are not limited here; they still need a registered issuer key.
const LIMITS = { read: 300, issuers: 10, batches: 1200 };

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) return json({ error: e.message }, e.status, e.headers);
  console.error(e);
  return json({ error: "internal error" }, 500);
}

// ── Worker entry ────────────────────────────────────────────────────
// The Worker does all request hardening (CORS, rate limit, auth, size caps,
// strict schemas) before anything reaches the single-writer log object.

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return preflight(request, METHODS, ALLOW_HEADERS);
    const cors = corsHeaders(request, METHODS, ALLOW_HEADERS);
    return withCors(await handle(request, env, url), cors);
  },
} satisfies ExportedHandler<Env>;

async function handle(request: Request, env: Env, url: URL): Promise<Response> {
    try {
      if (url.pathname === "/healthz") {
        return new Response("ok", { headers: { "content-type": "text/plain" } });
      }
      if (!url.pathname.startsWith("/authority/v1/")) throw new HttpError(404, "not found");
      const stub = env.AUTHORITY_LOG.get(env.AUTHORITY_LOG.idFromName("agentmint-log-v1"));
      const route = `${request.method} ${url.pathname}`;
      if (request.method === "GET" || request.method === "HEAD") {
        await rateLimit(env, request, "read", LIMITS.read);
        return stub.fetch(request);
      }
      if (request.method !== "POST") throw new HttpError(405, "method not allowed");
      assertPostOrigin(request);
      let body: Record<string, unknown>;
      if (route === "POST /authority/v1/issuers") {
        await rateLimit(env, request, "issuers", LIMITS.issuers);
        requireBearer(request, env.REGISTRATION_TOKEN);
        body = strictObject(await readCappedJson(request, MAX_ISSUER_BODY), ["public_key_pem"]);
        if (typeof body.public_key_pem !== "string" || body.public_key_pem.length > 1024) {
          throw new HttpError(400, "public_key_pem (string) required");
        }
      } else if (route === "POST /authority/v1/batches") {
        await rateLimit(env, request, "batches", LIMITS.batches);
        body = strictObject(await readCappedJson(request, MAX_BATCH_BODY), ["key_id", "leaf_hashes", "batch_signature", "batch_ts"]);
        validateBatch(body);
      } else {
        throw new HttpError(url.pathname.match(/\/(key|sth|consistency)$/) ? 405 : 404, "not found");
      }
      const fwd = new Request(request.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return stub.fetch(fwd);
    } catch (e) {
      return errorResponse(e);
    }
}

function withCors(res: Response, cors: Record<string, string>): Response {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(cors)) r.headers.set(k, v);
  return r;
}

function validateBatch(body: Record<string, unknown>): void {
  const { key_id, leaf_hashes, batch_signature, batch_ts } = body;
  if (typeof key_id !== "string" || !KEY_ID_RE.test(key_id)) throw new HttpError(400, "key_id malformed");
  if (!Array.isArray(leaf_hashes) || leaf_hashes.length === 0) throw new HttpError(400, "leaf_hashes must be a non-empty array");
  if (leaf_hashes.length > MAX_BATCH) throw new HttpError(413, `batch exceeds ${MAX_BATCH} leaves`);
  if (!leaf_hashes.every((h) => typeof h === "string" && LEAF_RE.test(h))) {
    throw new HttpError(400, "leaf_hashes must be 64-char lowercase hex SHA-256 leaf hashes");
  }
  if (new Set(leaf_hashes).size !== leaf_hashes.length) throw new HttpError(400, "duplicate leaf in batch");
  if (typeof batch_signature !== "string" || !/^[0-9a-f]{128}$/.test(batch_signature)) {
    throw new HttpError(400, "batch_signature must be 128 lowercase hex chars");
  }
  if (typeof batch_ts !== "string" || !TS_RE.test(batch_ts)) throw new HttpError(400, "batch_ts must be an ISO-8601 UTC timestamp");
  const skew = Math.abs(Date.parse(batch_ts.replace("+00:00", "Z")) - Date.now());
  if (!(skew <= BATCH_TS_SKEW_MS)) throw new HttpError(400, "batch_ts outside the ±5 min window");
}

// ── Durable Object: the log ─────────────────────────────────────────

interface StoredSth {
  sth: Sth;
  sth_signature: string;
}

export class AuthorityLog extends DurableObject<Env> {
  private sql: SqlStorage;
  private signer?: Promise<LogSigner>;
  private issuerKeys = new Map<string, CryptoKey>();
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        level INTEGER NOT NULL, idx INTEGER NOT NULL, hash BLOB NOT NULL,
        PRIMARY KEY (level, idx)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS sths (
        tree_size INTEGER PRIMARY KEY, root_hash TEXT NOT NULL,
        timestamp TEXT NOT NULL, sth_signature TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS issuers (
        key_id TEXT PRIMARY KEY, public_raw BLOB NOT NULL, registered_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS batches (
        digest TEXT PRIMARY KEY, key_id TEXT NOT NULL,
        first_index INTEGER NOT NULL, count INTEGER NOT NULL, tree_size INTEGER NOT NULL);
    `);
  }

  // Writers are serialized: a batch reads the tree, awaits WebCrypto, then
  // commits in one transactionSync. Readers see only committed state.
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.writeChain.then(fn);
    this.writeChain = p.catch(() => undefined);
    return p;
  }

  private getSigner(): Promise<LogSigner> {
    if (!this.env.AUTHORITY_PRIVATE_KEY) {
      return Promise.reject(new HttpError(500, "AUTHORITY_PRIVATE_KEY is not configured"));
    }
    this.signer ??= loadLogSigner(this.env.AUTHORITY_PRIVATE_KEY).catch((e) => {
      this.signer = undefined;
      throw new HttpError(500, `AUTHORITY_PRIVATE_KEY invalid: ${(e as Error).message}`);
    });
    return this.signer;
  }

  private async logId(): Promise<string> {
    return this.env.LOG_ID || `agentmint-log-${(await this.getSigner()).keyId}`;
  }

  private nodeReader(): NodeReader {
    const sql = this.sql;
    return {
      get(level, idx) {
        const row = sql
          .exec<{ hash: ArrayBuffer }>("SELECT hash FROM nodes WHERE level = ? AND idx = ?", level, idx)
          .toArray()[0];
        if (!row) throw new Error(`missing node ${level}:${idx}`);
        return new Uint8Array(row.hash);
      },
    };
  }

  private latestSth(): StoredSth | undefined {
    const r = this.sql
      .exec<{ tree_size: number; root_hash: string; timestamp: string; sth_signature: string }>(
        "SELECT tree_size, root_hash, timestamp, sth_signature FROM sths ORDER BY tree_size DESC LIMIT 1",
      )
      .toArray()[0];
    return r && this.toStored(r);
  }

  private sthAt(size: number): StoredSth | undefined {
    const r = this.sql
      .exec<{ tree_size: number; root_hash: string; timestamp: string; sth_signature: string }>(
        "SELECT tree_size, root_hash, timestamp, sth_signature FROM sths WHERE tree_size = ?",
        size,
      )
      .toArray()[0];
    return r && this.toStored(r);
  }

  private toStored(r: { tree_size: number; root_hash: string; timestamp: string; sth_signature: string }): StoredSth {
    // Key order is irrelevant on the wire: verifiers re-canonicalize.
    return {
      sth: { tree_size: r.tree_size, root_hash: r.root_hash, timestamp: r.timestamp },
      sth_signature: r.sth_signature,
    };
  }

  private treeSize(): number {
    return this.latestSth()?.sth.tree_size ?? 0;
  }

  private async signSth(treeSize: number, root: Uint8Array): Promise<StoredSth> {
    const sth: Sth = { tree_size: treeSize, root_hash: toHex(root), timestamp: isoNowUtc() };
    const sig = await ed25519Sign((await this.getSigner()).privateKey, sthCanonicalBytes(sth));
    return { sth, sth_signature: sig };
  }

  private insertSth(s: StoredSth): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO sths (tree_size, root_hash, timestamp, sth_signature) VALUES (?, ?, ?, ?)",
      s.sth.tree_size,
      s.sth.root_hash,
      s.sth.timestamp,
      s.sth_signature,
    );
  }

  async fetch(request: Request): Promise<Response> {
    const t0 = performance.now();
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    try {
      switch (route) {
        case "GET /authority/v1/key": {
          const s = await this.getSigner();
          return json({ log_id: await this.logId(), public_key_pem: s.publicPem, key_id: s.keyId });
        }
        case "GET /authority/v1/sth":
          return json(await this.currentSth());
        case "GET /authority/v1/consistency":
          return json(await this.consistency(url));
        case "POST /authority/v1/issuers":
          return json(await this.registerIssuer((await request.json()) as Record<string, unknown>));
        case "POST /authority/v1/batches": {
          const body = (await request.json()) as Record<string, unknown>;
          const res = await this.exclusive(() => this.appendBatch(body));
          return json({ ...res, authority_ms: Math.round((performance.now() - t0) * 1000) / 1000 });
        }
        default:
          if (url.pathname.startsWith("/authority/v1/") && ["GET", "POST"].includes(request.method)) {
            const known = ["key", "sth", "consistency", "issuers", "batches"].some(
              (p) => url.pathname === `/authority/v1/${p}`,
            );
            if (known) throw new HttpError(405, "method not allowed");
          }
          throw new HttpError(404, "not found");
      }
    } catch (e) {
      return errorResponse(e);
    }
  }

  private async currentSth(): Promise<StoredSth> {
    const cur = this.latestSth();
    if (cur) return cur;
    // Empty log: sign the size-0 head (root = SHA-256("")) once.
    return this.exclusive(async () => {
      const again = this.latestSth();
      if (again) return again;
      const s = await this.signSth(0, await new TreeView(this.nodeReader()).root(0));
      this.insertSth(s);
      return s;
    });
  }

  private async consistency(url: URL): Promise<{ from: number; to: number; proof: string[] }> {
    const from = parseSize(url.searchParams.get("from"), "from");
    const to = parseSize(url.searchParams.get("to"), "to");
    const size = this.treeSize();
    if (from < 1 || from > to) throw new HttpError(400, "require 1 <= from <= to");
    if (to > size) throw new HttpError(400, `to exceeds current tree size ${size}`);
    return { from, to, proof: await new TreeView(this.nodeReader()).consistency(from, to) };
  }

  private async registerIssuer(body: Record<string, unknown>): Promise<{ key_id: string }> {
    const pem = body["public_key_pem"];
    if (typeof pem !== "string") throw new HttpError(400, "public_key_pem (string) required");
    let raw: Uint8Array;
    try {
      raw = (await importEd25519PublicPem(pem)).raw;
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    const keyId = await keyIdOf(raw);
    this.sql.exec(
      "INSERT OR IGNORE INTO issuers (key_id, public_raw, registered_at) VALUES (?, ?, ?)",
      keyId,
      raw,
      isoNowUtc(),
    );
    return { key_id: keyId };
  }

  private async issuerKey(keyId: string): Promise<CryptoKey> {
    const cached = this.issuerKeys.get(keyId);
    if (cached) return cached;
    const row = this.sql
      .exec<{ public_raw: ArrayBuffer }>("SELECT public_raw FROM issuers WHERE key_id = ?", keyId)
      .toArray()[0];
    if (!row) throw new HttpError(403, "unknown issuer key_id");
    const key = await importEd25519PublicRaw(new Uint8Array(row.public_raw));
    this.issuerKeys.set(keyId, key);
    return key;
  }

  private async appendBatch(body: Record<string, unknown>) {
    // Shape, size, timestamp window and duplicates were validated by the Worker entry.
    const key_id = body.key_id as string;
    const leaf_hashes = body.leaf_hashes as string[];
    const batch_signature = body.batch_signature as string;
    const batch_ts = body.batch_ts as string;

    // Issuer signs SHA-256(concat(raw 32-byte leaf hashes) || utf8(batch_ts)).
    // The batch identity for replay detection is SHA-256(concat(leaves)) alone,
    // so the same leaves re-sent with a fresh timestamp are not appended twice.
    const leaves = leaf_hashes.map(fromHex);
    const concat = new Uint8Array(leaves.length * 32);
    leaves.forEach((l, i) => concat.set(l, i * 32));
    const digest = await sha256(concat);
    const issuer = await this.issuerKey(key_id);
    if (!(await ed25519Verify(issuer, batch_signature, await batchMessage(leaf_hashes, batch_ts)))) {
      throw new HttpError(401, "batch_signature verification failed");
    }
    const digestHex = toHex(digest);
    const logId = await this.logId();

    // Idempotent retry: an identical signed batch is not appended twice; the
    // original proofs are re-derived against the STH that batch produced.
    const prior = this.sql
      .exec<{ first_index: number; count: number; tree_size: number }>(
        "SELECT first_index, count, tree_size FROM batches WHERE digest = ?",
        digestHex,
      )
      .toArray()[0];
    if (prior) {
      const head = this.sthAt(prior.tree_size)!;
      const view = new TreeView(this.nodeReader());
      const proofs = await this.proofs(view, leaf_hashes as string[], prior.first_index, head, logId);
      return {
        proofs,
        ...head,
        tree_size_before: prior.first_index,
        tree_size_after: prior.tree_size,
        replayed: true,
      };
    }

    const before = this.treeSize();
    const after = before + leaves.length;
    const { pending, reader } = await appendLeaves(this.nodeReader(), before, leaves);
    const view = new TreeView(reader);
    const head = await this.signSth(after, await view.root(after));
    const proofs = await this.proofs(view, leaf_hashes as string[], before, head, logId);

    // Commit atomically: all nodes, the STH, and the batch record, or nothing.
    this.ctx.storage.transactionSync(() => {
      for (const n of pending.values()) {
        this.sql.exec("INSERT INTO nodes (level, idx, hash) VALUES (?, ?, ?)", n.level, n.idx, n.hash);
      }
      this.insertSth(head);
      this.sql.exec(
        "INSERT INTO batches (digest, key_id, first_index, count, tree_size) VALUES (?, ?, ?, ?, ?)",
        digestHex,
        key_id,
        before,
        leaves.length,
        after,
      );
    });

    return { proofs, ...head, tree_size_before: before, tree_size_after: after };
  }

  private async proofs(view: TreeView, leafHashes: string[], firstIndex: number, head: StoredSth, logId: string) {
    const out = [];
    for (let i = 0; i < leafHashes.length; i++) {
      out.push({
        log_id: logId,
        leaf_hash: leafHashes[i]!,
        leaf_index: firstIndex + i,
        tree_size: head.sth.tree_size,
        audit_path: await view.inclusion(firstIndex + i, head.sth.tree_size),
        sth: head.sth,
        sth_signature: head.sth_signature,
      });
    }
    return out;
  }
}

function parseSize(v: string | null, name: string): number {
  if (v === null || !/^\d+$/.test(v)) throw new HttpError(400, `${name} must be a non-negative integer`);
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new HttpError(400, `${name} too large`);
  return n;
}
