// Bring-your-own-agent ingest API (docs/BYO-AGENT.md) over real HTTP, the real
// signer process and a local authority.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { startHarness, type Harness } from "./bench.js";
import { Ingest, ingestAuthFromEnv, type IngestOptions } from "./ingest.js";
import { verifyAerfReceipt } from "../src/receipt-aerf.js";
import { verifyAerfChain } from "../src/chain.js";
import { newSalt, saltedCommitment, verifyDisclosure } from "../src/commitments.js";

type R = Record<string, unknown>;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

let h: Harness;
const apis: { server: Server; ingest: Ingest }[] = [];

async function api(opts: Partial<Pick<IngestOptions, "apiKeys" | "allowTestKey">> = {}) {
  const ingest = new Ingest({
    signer: h.signer,
    authorityUrl: h.authorityUrl,
    logKey: { log_id: h.authority.logId, public_key_pem: h.authority.publicKeyPem },
    apiKeys: opts.apiKeys ?? ["k-live-1"],
    allowTestKey: opts.allowTestKey ?? true,
  });
  const server = createServer((req, res) => void ingest.handle(req, res, new URL(req.url ?? "/", "http://x").pathname));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  apis.push({ server, ingest });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return async (method: string, path: string, body?: unknown, key: string | null = "test") => {
    const res = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json", ...(key !== null ? { authorization: `Bearer ${key}` } : {}) },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as R };
  };
}

const RULES = { "R-ID-1": "Verify identity before sharing plan details.", "R-PA-2": "Prior authorization is requested by the provider." };
const SESSION = { agent: "acme/member-line", model: "qwen3-8b", prompt_version: "v7", prompt_sha256: sha("my secret prompt"), rules: RULES };

beforeAll(async () => {
  h = await startHarness({ flushMs: 50 });
});
afterAll(async () => {
  for (const a of apis) {
    a.ingest.stop();
    await new Promise((r) => a.server.close(r));
  }
  await h.close();
});

describe("auth", () => {
  it("accepts a configured key and the test key; rejects wrong / missing keys", async () => {
    const call = await api();
    expect((await call("POST", "/v1/sessions", SESSION, "k-live-1")).status).toBe(201);
    expect((await call("POST", "/v1/sessions", SESSION, "test")).status).toBe(201);
    const wrong = await call("POST", "/v1/sessions", SESSION, "k-live-2");
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBeTypeOf("string");
    expect((await call("POST", "/v1/sessions", SESSION, null)).status).toBe(401);
  });

  it("rejects the test key when ALLOW_TEST_KEY is off", async () => {
    const call = await api({ allowTestKey: false });
    expect((await call("POST", "/v1/sessions", SESSION, "test")).status).toBe(401);
    expect((await call("POST", "/v1/sessions", SESSION, "k-live-1")).status).toBe(201);
  });

  it("reads INGEST_API_KEYS / ALLOW_TEST_KEY from the environment", () => {
    expect(ingestAuthFromEnv({ INGEST_API_KEYS: " a, b ,," })).toEqual({ apiKeys: ["a", "b"], allowTestKey: true });
    expect(ingestAuthFromEnv({ ALLOW_TEST_KEY: "0" }).allowTestKey).toBe(false);
  });

  it("does not expose a session to a different key", async () => {
    const call = await api();
    const s = await call("POST", "/v1/sessions", SESSION, "k-live-1");
    expect((await call("GET", `/v1/sessions/${s.body.session_id}/package`, undefined, "test")).status).toBe(404);
  });
});

describe("validation", () => {
  let call: Awaited<ReturnType<typeof api>>;
  let sid: string;
  beforeAll(async () => {
    call = await api();
    sid = (await call("POST", "/v1/sessions", SESSION)).body.session_id as string;
  });
  const rec = (body: unknown) => call("POST", `/v1/sessions/${sid}/records`, body);
  const decision = (over: R = {}) => ({
    kind: "decision",
    turn: 1,
    iteration: 1,
    decision_record: { point: "identity", decision: "member_verified", rule_id: "R-ID-1", uncertainty: "none", ...over },
    reasoning: { question: "Is the caller verified?", claims: [] },
  });

  it("rejects raw IP field names anywhere in a body", async () => {
    for (const body of [
      { kind: "model_iteration", turn: 0, iteration: 1, model: "m", stop_reason: "end_turn", thinking: "secret" },
      { ...decision(), reasoning: { question: "q", claims: [{ id: "c1", text: "t", cites: [{ kind: "rule", ref: "R-ID-1", value: null, Prompt: "x" }] }] } },
      { kind: "error", turn: 0, iteration: 1, error_kind: "x", detail: "d", extra: [{ reasoning_text: "y" }] },
    ]) {
      const r = await rec(body);
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("raw_ip_rejected");
    }
    const s = await call("POST", "/v1/sessions", { ...SESSION, system: "you are a helpful agent" });
    expect(s).toMatchObject({ status: 400, body: { error: "raw_ip_rejected" } });
  });

  it("rejects unknown fields at any level", async () => {
    expect((await rec({ kind: "tool_call", turn: 0, iteration: 1, name: "lookup", input_sha256: sha("a"), result_sha256: sha("b"), ms: 3, extra: 1 })).status).toBe(400);
    expect((await rec({ kind: "model_iteration", turn: 0, iteration: 1, model: "m", stop_reason: "s", usage: { input_tokens: 1, output_tokens: 2, cached: 0 } })).status).toBe(400);
    expect((await rec(decision({ confidence: 0.9 }))).status).toBe(400);
    expect((await call("POST", "/v1/sessions", { ...SESSION, temperature: 0 })).status).toBe(400);
    expect((await call("POST", `/v1/sessions/${sid}/close`, { force: true })).status).toBe(400);
  });

  it("rejects malformed records", async () => {
    expect((await rec({ kind: "nope", turn: 0, iteration: 1 })).status).toBe(400);
    expect((await rec({ kind: "error", turn: -1, iteration: 1, error_kind: "x" })).status).toBe(400);
    expect((await rec({ kind: "error", turn: 0, iteration: 0, error_kind: "x" })).status).toBe(400);
    expect((await rec({ kind: "model_iteration", turn: 0, iteration: 1, model: "m", stop_reason: "s", reasoning_commitment: "zz" })).status).toBe(400);
    expect((await rec({ kind: "tool_call", turn: 0, iteration: 1, name: "bad name", input_sha256: sha("a"), result_sha256: sha("b"), ms: 1 })).status).toBe(400);
    expect((await rec("not json")).status).toBe(400);
  });

  it("rejects a decision citing an unknown rule_id", async () => {
    const r = await rec(decision({ rule_id: "R-NOPE" }));
    expect(r).toMatchObject({ status: 400, body: { error: "unknown_rule_id" } });
  });

  it("rejects bodies over 32 KB and unknown sessions", async () => {
    expect((await rec({ kind: "error", turn: 0, iteration: 1, error_kind: "x", detail: "a".repeat(40_000) })).status).toBe(413);
    expect((await call("POST", "/v1/sessions/00000000-0000-0000-0000-000000000000/records", decision())).status).toBe(404);
  });
});

describe("a session with every record kind", () => {
  let call: Awaited<ReturnType<typeof api>>;
  let open: R;
  const posted: R[] = [];
  let pkg: R;
  const salt = newSalt();
  const thinking = "The caller gave a matching DOB, so identity is verified.";

  beforeAll(async () => {
    call = await api();
    open = (await call("POST", "/v1/sessions", SESSION)).body;
    const sid = open.session_id as string;
    const records: R[] = [
      { kind: "model_iteration", turn: 1, iteration: 1, model: "qwen3-8b", request_id: "req-1", stop_reason: "tool_use", usage: { input_tokens: 812, output_tokens: 64 }, reasoning_commitment: saltedCommitment(salt, thinking) },
      { kind: "tool_call", turn: 1, iteration: 1, name: "member_lookup", input_sha256: sha("{id:1}"), result_sha256: sha("{dob:…}"), ms: 12.5 },
      { kind: "model_iteration", turn: 1, iteration: 2, model: "qwen3-8b", stop_reason: "end_turn" },
      {
        kind: "decision",
        turn: 1,
        iteration: 2,
        decision_record: { point: "identity", decision: "member_verified", rule_id: "R-ID-1", uncertainty: "none" },
        reasoning: {
          question: "Can we share plan details with this caller?",
          claims: [
            { id: "c1", text: "DOB matches the member record.", cites: [{ kind: "tool", ref: "member_lookup.dob_match", value: true }, { kind: "turn", ref: "1", value: 12.75 }] },
            { id: "c2", text: "Identity verified, so details may be shared.", cites: [{ kind: "rule", ref: "R-ID-1", value: "agent's copy" }, { kind: "claim", ref: "c1", value: null }, { kind: "rule", ref: "R-UNKNOWN", value: "x" }] },
          ],
        },
      },
      { kind: "error", turn: 2, iteration: 1, error_kind: "llm_timeout", detail: "upstream 30s timeout" },
    ];
    for (const r of records) {
      const res = await call("POST", `/v1/sessions/${sid}/records`, r);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      posted.push(res.body);
    }
    const closed = await call("POST", `/v1/sessions/${sid}/close`, {});
    expect(closed.status).toBe(200);
    pkg = closed.body;
  });

  it("opens with the issuer / log keys and the rules' policy hash", () => {
    expect(open).toMatchObject({ issuer_key_id: h.signer.keyId, issuer_public_key_pem: h.signer.publicKeyPem, log_public_key_pem: h.authority.publicKeyPem });
    expect(open.policy_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns receipt id, seq and hash per record, in chain order", () => {
    expect(posted.map((p) => p.seq)).toEqual([1, 2, 3, 4, 5]);
    for (const p of posted) expect(p.receipt_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("closes with a package in which every receipt verifies with requireLog and the chain is valid", () => {
    const receipts = pkg.receipts as R[];
    expect(receipts).toHaveLength(6);
    expect(pkg.unanchored).toBe(0);
    const auth = pkg.authority as R;
    for (const r of receipts) {
      const v = verifyAerfReceipt(r, { issuerPublicKey: pkg.issuer_public_key_pem as string, logPublicKey: auth.public_key_pem as string, requireLog: true });
      expect(v, v.failReason).toMatchObject({ ok: true, issuerOk: true, log: "passed" });
      expect(r.in_policy).toBe(true);
    }
    expect(verifyAerfChain(receipts, { issuerPublicKey: pkg.issuer_public_key_pem as string }).valid).toBe(true);
    expect(receipts.map((r) => r.action)).toEqual(["model:iteration", "tool:member_lookup", "model:iteration", "decide:identity", "error:llm_timeout", "close:session"]);
    expect(receipts.map((r) => r.id)).toEqual([...posted.map((p) => p.receipt_id), receipts[5]!.id]);
    expect(pkg).toMatchObject({ call_id: open.session_id, agent: SESSION.agent, prompt_version: "v7", policy_hash: open.policy_hash, issuer_key_id: h.signer.keyId });
    expect(pkg.rules).toEqual(Object.entries(RULES).map(([id, text]) => ({ id, text })));
    expect((auth.sth as R).sth).toBeDefined();
  });

  it("commits to the thinking without receiving it; the agent can open it later", () => {
    const r = (pkg.receipts as R[])[0]!;
    expect(r).toMatchObject({ commitment_alg: "sha256-salted-v1", reasoning_hash: saltedCommitment(salt, thinking) });
    expect(JSON.stringify(pkg)).not.toContain(thinking);
    expect(verifyDisclosure(r as never, { receipt_id: r.id as string, reasoning: { salt, text: thinking } }).reasoning).toBe("match");
    expect((pkg.receipts as R[])[2]!.reasoning_hash).toBeUndefined();
  });

  it("resolves rule and claim cites on the platform side", () => {
    const d = (pkg.receipts as R[])[3]!.evidence as R;
    expect(d.decision_record).toMatchObject({ schema: "decision-record/v0", point: "identity", rule_id: "R-ID-1", turn: 1, iteration: 2 });
    const cites = ((d.reasoning as R).claims as { cites: R[] }[])[1]!.cites;
    expect(cites[0]).toEqual({ kind: "rule", ref: "R-ID-1", value: RULES["R-ID-1"] });
    expect(cites[1]).toEqual({ kind: "claim", ref: "c1", value: "DOB matches the member record." });
    expect(cites[2]).toEqual({ kind: "rule", ref: "R-UNKNOWN", value: null, resolved: false });
    expect(((d.reasoning as R).claims as { cites: R[] }[])[0]!.cites[1]).toEqual({ kind: "turn", ref: "1", value: "12.75" });
    expect(((pkg.receipts as R[])[1]!.evidence as R).ms).toBe(13);
  });

  it("rejects records after close; package stays readable", async () => {
    const sid = open.session_id as string;
    expect((await call("POST", `/v1/sessions/${sid}/records`, { kind: "error", turn: 3, iteration: 1, error_kind: "late" })).status).toBe(409);
    const again = await call("GET", `/v1/sessions/${sid}/package`);
    expect(again.status).toBe(200);
    expect((again.body.receipts as R[]).length).toBe(6);
  });
});
