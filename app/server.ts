// filet reasoning demo server: one Node process.
//
//   GET  /                         landing page (public/index.html)
//   GET  /events?speed=1&fail=…    SSE: one full scripted call per connection
//   GET  /disclose/:receipt_id     vendor-side opening of a receipt's salted commitments (demo)
//   *    /authority/v1/…           local signing authority (dev fallback when AUTHORITY_URL is unset)
//   *    /v1/sessions/…            bring-your-own-agent ingest API (app/ingest.ts, docs/BYO-AGENT.md)
//   GET  /healthz                  ok
//
// The issuer key lives only in the signer child process (app/signer-proc.ts).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Authority, authorityBase } from "./authority.js";
import { SignerClient } from "./signer.js";
import { DisclosureStore, FAILURE_KINDS, runCall, type FailureKind } from "./call.js";
import { otel } from "./links.js";
import { Ingest, ingestAuthFromEnv } from "./ingest.js";
import type { TraceLinkPlugin } from "../src/trace-links.js";
import { SALTED_COMMITMENT_ALG } from "../src/commitments.js";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4173);
const RING = 1000;
const HEARTBEAT_MS = 15_000;
const MAX_LIVE_RUNS = 25;
const ABANDON_MS = 60_000;

// ── Runs: decoupled from connections so Last-Event-ID can resume ────

let lastEventId = 0;

interface Frame {
  id: number;
  text: string;
}

class Run {
  readonly frames: Frame[] = [];
  readonly subscribers = new Set<ServerResponse>();
  finished = false;
  lastSeen = Date.now();
  finishedAt = 0;

  emit(event: string, data: unknown): void {
    const id = ++lastEventId;
    const text = `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    this.frames.push({ id, text });
    if (this.frames.length > RING) this.frames.shift();
    for (const res of this.subscribers) res.write(text);
  }

  holds(id: number): boolean {
    const first = this.frames[0];
    const last = this.frames[this.frames.length - 1];
    return !!first && !!last && id >= first.id - 1 && id <= last.id;
  }

  replayAfter(id: number, res: ServerResponse): number {
    let n = 0;
    for (const f of this.frames) {
      if (f.id > id) {
        res.write(f.text);
        n++;
      }
    }
    return n;
  }

  finish(): void {
    this.finished = true;
    this.finishedAt = Date.now();
    for (const res of this.subscribers) res.end();
    this.subscribers.clear();
  }
}

const runs = new Set<Run>();
setInterval(() => {
  const now = Date.now();
  for (const r of runs) if (r.finished && now - r.finishedAt > 5 * 60_000) runs.delete(r);
}, 30_000).unref();

// ── Boot ────────────────────────────────────────────────────────────

const localAuthority = process.env.AUTHORITY_URL ? undefined : new Authority({ privateKeyPem: process.env.AUTHORITY_PRIVATE_KEY_PEM });
delete process.env.AUTHORITY_PRIVATE_KEY_PEM;
const authorityUrl = process.env.AUTHORITY_URL ?? `http://127.0.0.1:${PORT}`;
const issuerKeyPem = process.env.ISSUER_PRIVATE_KEY_PEM;
delete process.env.ISSUER_PRIVATE_KEY_PEM; // handed to the signer process only
const links: TraceLinkPlugin[] = process.env.TRACE_LINK_TEMPLATE ? [otel({ urlTemplate: process.env.TRACE_LINK_TEMPLATE })] : [];
const disclosures = new DisclosureStore();

let signer: SignerClient | undefined;
let logKey: { log_id: string; public_key_pem: string } | undefined;
let ingest: Ingest | undefined;
let ready: Promise<void> | undefined;

async function boot(): Promise<void> {
  // The verifier fetches the log key independently of the signer.
  const res = await fetch(`${authorityBase(authorityUrl)}/v1/key`);
  if (!res.ok) throw new Error(`authority key fetch failed: ${res.status}`);
  logKey = (await res.json()) as { log_id: string; public_key_pem: string };
  signer = await SignerClient.start({
    authorityUrl,
    stateDir: process.env.SIGNER_STATE_DIR ?? join(tmpdir(), "filet-signer-state"),
    issuerPrivateKeyPem: issuerKeyPem,
  });
  const auth = ingestAuthFromEnv();
  ingest = new Ingest({ signer, authorityUrl, logKey, ...auth });
  if (auth.allowTestKey) console.log("filet demo: ingest API accepts the test key (ALLOW_TEST_KEY=1); set ALLOW_TEST_KEY=0 in production");
  console.log(`filet demo: signer pid ${signer.pid}, issuer ${signer.keyId}, log ${logKey.log_id} at ${authorityBase(authorityUrl)}`);
}

// ── HTTP ────────────────────────────────────────────────────────────

function parseFailures(v: string | null): Set<FailureKind> {
  const out = new Set<FailureKind>();
  for (const f of (v ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    if ((FAILURE_KINDS as readonly string[]).includes(f)) out.add(f as FailureKind);
  }
  return out;
}

function sseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.socket?.setNoDelay(true);
  res.flushHeaders();
  res.write("retry: 2000\n\n");
}

function subscribe(run: Run, req: IncomingMessage, res: ServerResponse): void {
  run.subscribers.add(res);
  run.lastSeen = Date.now();
  const ping = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
  req.on("close", () => {
    clearInterval(ping);
    run.subscribers.delete(res);
    run.lastSeen = Date.now();
  });
}

async function events(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const lastId = Number(req.headers["last-event-id"] ?? url.searchParams.get("lastEventId") ?? NaN);
  if (Number.isFinite(lastId)) {
    const run = [...runs].find((r) => r.holds(lastId));
    if (run) {
      if (run.finished && !run.frames.some((f) => f.id > lastId)) {
        res.writeHead(204).end(); // nothing more: tells EventSource to stop reconnecting
        return;
      }
      sseHeaders(res);
      run.replayAfter(lastId, res);
      if (run.finished) res.end();
      else subscribe(run, req, res);
      return;
    }
  }
  if ([...runs].filter((r) => !r.finished).length >= MAX_LIVE_RUNS) {
    res.writeHead(503, { "retry-after": "10" }).end("busy");
    return;
  }
  await ready;
  if (!signer || !logKey) {
    res.writeHead(503).end("signer not ready");
    return;
  }
  const speed = Number(url.searchParams.get("speed") ?? 1);
  const run = new Run();
  runs.add(run);
  sseHeaders(res);
  subscribe(run, req, res);
  runCall({
    speed: Number.isFinite(speed) ? Math.min(10, Math.max(0.25, speed)) : 1,
    failures: parseFailures(url.searchParams.get("fail")),
    signer,
    logPublicKeyPem: logKey.public_key_pem,
    logId: logKey.log_id,
    authorityUrl,
    links,
    disclosures,
    emit: (event, data) => run.emit(event, data),
    aborted: () => run.subscribers.size === 0 && Date.now() - run.lastSeen > ABANDON_MS,
  })
    .catch((err) => run.emit("error", { message: err instanceof Error ? err.message : String(err) }))
    .finally(() => run.finish());
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  if (path === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }
  if (path.startsWith("/authority/")) {
    if (!localAuthority) return json(res, 404, { error: "remote authority in use", authority: authorityBase(authorityUrl) });
    void localAuthority.handle(req, res, path.slice("/authority".length), url.searchParams);
    return;
  }
  if (path === "/events") {
    void events(req, res, url).catch((err) => {
      if (!res.headersSent) json(res, 500, { error: String(err) });
      else res.end();
    });
    return;
  }
  if (path === "/v1/sessions" || path.startsWith("/v1/sessions/")) {
    void (async () => {
      await ready;
      if (!ingest) return json(res, 503, { error: "signer not ready" });
      await ingest.handle(req, res, path);
    })().catch((err) => {
      if (!res.headersSent) json(res, 500, { error: String(err) });
      else res.end();
    });
    return;
  }
  const disclose = /^\/disclose\/([0-9a-f-]{36})$/.exec(path);
  if (disclose) {
    const t0 = process.hrtime.bigint();
    const d = disclosures.get(disclose[1]!);
    if (!d) return json(res, 404, { error: "unknown receipt id" });
    const { notify, ...opening } = d;
    // Demo only: in production this is gated to parties entitled to the text.
    json(res, 200, {
      ...opening,
      commitment_alg: SALTED_COMMITMENT_ALG,
      salt: d.reasoning?.salt ?? null,
      text: d.reasoning?.text ?? null,
    });
    notify?.({
      method: "GET",
      url: path,
      request_summary: "",
      status: 200,
      response_summary: `{ reasoning: { salt, text: ${d.reasoning?.text.length ?? 0} chars }, context: { salt, canonical: ${d.context?.canonical.length ?? 0} chars }${d.claims ? ", claims: { salt, canonical }" : ""} }`,
      ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e5) / 10,
      receipt_ids: [d.receipt_id],
    });
    return;
  }
  if (path === "/" || path === "/index.html") {
    try {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
      res.end(readFileSync(join(here, "..", "public", "index.html")));
    } catch {
      res.writeHead(500).end("missing public/index.html");
    }
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" }).end("not found");
});

server.keepAliveTimeout = 65_000;
server.listen(PORT, () => {
  console.log(`filet demo: http://localhost:${PORT}`);
  ready = boot();
  ready.catch((err) => {
    console.error("boot failed:", err);
    process.exit(1);
  });
});

function shutdown(): void {
  ingest?.stop();
  signer?.stop();
  server.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
