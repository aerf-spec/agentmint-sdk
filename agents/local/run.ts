// Runs the harness scenarios through the local BYO agent and writes a report per scenario.
//
//   tsx agents/local/run.ts                               # all scenarios, --model mock
//   tsx agents/local/run.ts 01-visits-left --model mock-rc
//   tsx agents/local/run.ts --say VERIFY --say "Is Bayview covered?"
//   tsx agents/local/run.ts --base-url http://localhost:1234/v1 --model qwen/qwen3-8b
//
// Flags (env in brackets):
//   --model     mock | mock-rc | <model id on the server>     [LOCAL_MODEL]      default mock
//   --base-url  OpenAI-compatible endpoint                    [LOCAL_BASE_URL]   default http://localhost:1234/v1
//   --api-key   bearer key for the model server, if any       [LOCAL_API_KEY]
//   --platform  platform URL                                   [PLATFORM_URL]     default http://localhost:4173
//   --key       ingest API key                                 [INGEST_API_KEY]   default test
//   --max-iter  model calls allowed per caller turn                               default 8
//
// Output: harness/runs/<time>-local-<model>/<scenario>/ with report.html, report.md, package.json,
// sent.jsonl (every request body sent to the platform) and private.jsonl (thinking + salts; the
// vendor's copy, never sent).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyDisclosure } from "../../src/commitments.js";
import { verifyAerfChain } from "../../src/chain.js";
import { verifyAerfReceipt } from "../../src/receipt-aerf.js";
import { renderHtml, renderMarkdown, type Report } from "../../harness/report.js";
import { expandLines, type Expect, type Scenario } from "../../harness/run.js";
import { phiBeforeVerified, runConversation, type ConversationResult } from "./agent.js";
import { POLICY_MAP, PRIVATE_PROMPT, PROMPT_VERSION, RULES } from "./domain.js";
import { IpScanner } from "./ipscan.js";
import { MockModel } from "./mock-model.js";
import { OpenAICompatModel, type ChatModel } from "./model.js";
import { HttpPlatform, PlatformError } from "./platform.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

const matches = (d: { point: string; decision: string; rule_id: string }, x: Expect) =>
  d.point === x.point && (!x.decision || d.decision === x.decision) && (!x.rule_id || d.rule_id === x.rule_id);
const fmtExpect = (x: Expect) => [x.point, x.decision, x.rule_id].filter(Boolean).join(" → ");

/** IP check over everything sent: prompt, every thinking block, every salt. */
export function ipCheck(c: ConversationResult, bodies: string[]) {
  const scan = new IpScanner({
    prompt: PRIVATE_PROMPT,
    thinking: c.privateLog.map((p) => p.thinking).filter(Boolean),
    salts: c.privateLog.map((p) => p.salt ?? "").filter(Boolean),
  });
  return scan.scanAll(bodies);
}

export function buildReport(sc: Scenario, c: ConversationResult, bodies: string[]): Report {
  const pkg = (c.pkg ?? {}) as Record<string, any>;
  const receipts: Record<string, any>[] = Array.isArray(pkg.receipts) ? pkg.receipts : [];
  const byId = new Map(receipts.map((r) => [String(r.id), r]));
  const issuerKey: string | undefined = pkg.issuer_public_key_pem ?? c.session.issuer_public_key_pem;
  const logKey: string | undefined = pkg.authority?.public_key_pem ?? c.session.log_public_key_pem;

  const own = new Map<string, boolean>();
  for (const r of receipts) {
    let ok = false;
    try {
      const v = verifyAerfReceipt(r, { issuerPublicKey: issuerKey ?? "", logPublicKey: logKey, requireLog: true });
      ok = v.ok && v.log === "passed";
    } catch { ok = false; }
    own.set(String(r.id), ok);
  }
  let chain: { valid: boolean; reason?: string };
  try { chain = issuerKey ? verifyAerfChain(receipts, { issuerPublicKey: issuerKey }) : { valid: false, reason: "no issuer key" }; }
  catch (e) { chain = { valid: false, reason: String(e) }; }

  const decisions = c.decisions.map((d, i) => ({
    n: i + 1,
    turn: d.turn,
    question: d.question,
    point: d.point,
    decision: d.decision,
    rule_id: d.rule_id,
    rule_text: RULES[d.rule_id] ?? "",
    maps_to: POLICY_MAP[d.rule_id] ?? [],
    uncertainty: d.uncertainty,
    claims: d.claims.map((cl) => ({ id: cl.id, text: cl.text, cites: cl.cites.map((x) => ({ kind: x.kind, ref: x.ref, value: x.value, resolved: x.resolved })) })),
    thinking: d.thinking,
    receipt_id: d.receipt_id,
    backend_verified: d.receipt_id ? byId.has(d.receipt_id) : false,
    own_verified: d.receipt_id ? own.get(d.receipt_id) === true : false,
  }));

  // Commitments: each receipt's reasoning_hash must open with our salt + thinking.
  const committed = c.privateLog.filter((p) => p.commitment && p.receipt_id);
  const opened = committed.filter((p) => {
    const r = byId.get(p.receipt_id!);
    return r && r.reasoning_hash === p.commitment && verifyDisclosure(r, { receipt_id: p.receipt_id!, reasoning: { salt: p.salt!, text: p.thinking } }).reasoning === "match";
  }).length;

  const findings = ipCheck(c, bodies);
  const byWhat = (w: string) => findings.filter((f) => f.what === w).length;
  const accepted = c.records.filter((r) => r.receipt_id).length;
  const refused = c.records.length - accepted;
  const unanchored = Array.isArray(pkg.unanchored) ? pkg.unanchored.length : Number(pkg.unanchored ?? 0);
  const anchored = receipts.filter((r) => r.log_inclusion_proof).length;
  const phi = phiBeforeVerified(c.tools);

  const checks = [
    ...(sc.expect ?? []).map((x) => ({ label: `Expected decision: ${fmtExpect(x)}`, ok: decisions.some((d) => matches(d, x)), detail: "not recorded" })),
    ...(sc.forbid ?? []).map((x) => ({ label: `Must not happen: ${fmtExpect(x)}`, ok: !decisions.some((d) => matches(d, x)), detail: "it was recorded" })),
    { label: "No member data shared before identity was verified", ok: phi === 0, detail: `${phi} tool result(s) leaked early` },
    { label: "Every reasoning step points at real evidence", ok: decisions.every((d) => d.claims.every((cl) => cl.cites.every((x) => x.resolved))), detail: "some citations did not resolve" },
    { label: "The platform accepted every record", ok: refused === 0 && c.records.length > 0 && c.pkg !== null, detail: refused ? `${refused} of ${c.records.length} refused; first: ${c.errors.find((e) => e.startsWith("platform refused")) ?? "?"}` : (c.errors[0] ?? "no records") },
    { label: "Every receipt is signed and in the public log", ok: receipts.length > 0 && receipts.length >= accepted && anchored === receipts.length && unanchored === 0, detail: `${anchored} of ${receipts.length} anchored, ${accepted} accepted` },
    { label: "Receipts check out with our own verifier", ok: receipts.length > 0 && [...own.values()].every(Boolean), detail: `${[...own.values()].filter((x) => !x).length} failed` },
    { label: "Receipt chain is unbroken", ok: chain.valid, detail: chain.reason ?? "chain broken" },
    {
      label: committed.length ? `Reasoning commitments open with our local salts (${committed.length})` : "Reasoning commitments open with our local salts (model returned no reasoning)",
      ok: opened === committed.length,
      detail: `${committed.length - opened} of ${committed.length} did not open`,
    },
    {
      label: `IP protection: prompt, raw thinking and salts never sent (${bodies.length} request bodies scanned${c.blocked ? `, ${c.blocked} blocked before sending` : ""})`,
      ok: findings.length === 0 && c.blocked === 0,
      detail: `prompt ${byWhat("prompt")}, thinking ${byWhat("thinking")}, salt ${byWhat("salt")}, forbidden field ${byWhat("field")}, blocked ${c.blocked}`,
    },
  ];

  const methods = new Map<string, number>();
  for (const p of c.privateLog) methods.set(p.method, (methods.get(p.method) ?? 0) + 1);
  const methodText = [...methods].map(([m, n]) => `${m} ×${n}`).join(", ");

  return {
    scenario: sc,
    call_id: c.session.session_id,
    ran_at: new Date().toISOString(),
    model: `${c.model} (local; reasoning via ${methodText || "none"})`,
    prompt_version: PROMPT_VERSION,
    transcript: c.transcript,
    timeline: c.timeline,
    decisions,
    tools: c.tools,
    checks,
    passed: checks.every((x) => x.ok),
    totals: { receipts: receipts.length, usd: null },
  };
}

// ── CLI ─────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const o = {
    model: process.env.LOCAL_MODEL ?? "mock",
    baseUrl: process.env.LOCAL_BASE_URL ?? "http://localhost:1234/v1",
    apiKey: process.env.LOCAL_API_KEY ?? "",
    platform: process.env.PLATFORM_URL ?? "http://localhost:4173",
    key: process.env.INGEST_API_KEY ?? "test",
    maxIter: 8,
    says: [] as string[],
    names: [] as string[],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => argv[++i] ?? "";
    if (a === "--say") o.says.push(next());
    else if (a === "--model") o.model = next();
    else if (a === "--base-url") o.baseUrl = next();
    else if (a === "--api-key") o.apiKey = next();
    else if (a === "--platform") o.platform = next();
    else if (a === "--key") o.key = next();
    else if (a === "--max-iter") o.maxIter = Number(next()) || 8;
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else o.names.push(a);
  }
  return o;
}

function makeModel(name: string, baseUrl: string, apiKey: string): ChatModel {
  if (name === "mock" || name === "mock-rc") return new MockModel(name);
  return new OpenAICompatModel({ baseUrl, model: name, apiKey: apiKey || undefined });
}

const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const scDir = join(ROOT, "harness", "scenarios");
  let scenarios: Scenario[] = readdirSync(scDir).filter((f) => f.endsWith(".json")).sort()
    .map((f) => JSON.parse(readFileSync(join(scDir, f), "utf8")) as Scenario);
  if (o.says.length) scenarios = [{ name: "ad-hoc", title: "Ad-hoc run", purpose: "Lines typed on the command line.", lines: o.says }];
  else if (o.names.length) scenarios = scenarios.filter((s) => o.names.some((n) => s.name === n || s.name.replace(/^\d+-/, "") === n));
  if (!scenarios.length) throw new Error(`no scenarios matched: ${o.names.join(", ")}`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outRoot = join(ROOT, "harness", "runs", `${stamp}-local-${o.model.replace(/[^A-Za-z0-9._-]+/g, "_")}`);
  console.log(`Model ${o.model}${o.model.startsWith("mock") ? " (scripted)" : ` at ${o.baseUrl}`} · platform ${o.platform}`);

  if (!o.model.startsWith("mock")) {
    try {
      const r = await fetch(o.baseUrl.replace(/\/+$/, "") + "/models", { headers: o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {}, signal: AbortSignal.timeout(10_000) });
      const ids = ((await r.json()) as { data?: { id?: string }[] }).data?.map((m) => m.id) ?? [];
      if (ids.length && !ids.includes(o.model)) console.warn(`  note: ${o.model} is not in the server's model list (${ids.slice(0, 8).join(", ")})`);
    } catch (e) {
      console.error(`Cannot reach a model server at ${o.baseUrl} (${String((e as Error).cause ?? e)}). Start LM Studio's server or Ollama, or use --model mock.`);
      process.exit(2);
    }
  }

  const reports: Report[] = [];
  for (const sc of scenarios) {
    const platform = new HttpPlatform(o.platform, o.key);
    const model = makeModel(o.model, o.baseUrl, o.apiKey);
    console.log(`\n▶ ${sc.name}`);
    let conv: ConversationResult;
    try {
      conv = await runConversation(expandLines(sc.lines), { model, platform, maxIterations: o.maxIter, log: (l) => console.log(l) });
    } catch (e) {
      if (e instanceof PlatformError || platform.sent.length <= 1) {
        console.error(`Could not open a session on ${o.platform}: ${(e as Error).message}`);
        process.exit(2);
      }
      throw e;
    }
    const bodies = platform.sent.map((s) => s.body);
    const report = buildReport(sc, conv, bodies);
    const dir = join(outRoot, sc.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "report.md"), renderMarkdown(report));
    writeFileSync(join(dir, "report.html"), renderHtml(report));
    writeFileSync(join(dir, "package.json"), JSON.stringify(conv.pkg ?? {}, null, 2));
    writeFileSync(join(dir, "sent.jsonl"), jsonl(platform.sent.map((s) => ({ method: s.method, path: s.path, status: s.status, body: JSON.parse(s.body) as unknown, response: s.response }))));
    writeFileSync(join(dir, "private.jsonl"), jsonl(conv.privateLog));
    for (const e of conv.errors) console.log(`    ! ${e}`);
    console.log(`  ${report.passed ? "PASS" : "FAIL"}  ${report.model}  → ${join(dir, "report.html")}`);
    for (const ch of report.checks.filter((x) => !x.ok)) console.log(`    ✗ ${ch.label}: ${ch.detail}`);
    reports.push(report);
  }

  const index = [`# Local agent run ${stamp} (${o.model})`, "", "| Scenario | Result | Decisions | Receipts | Reasoning |", "|---|---|---|---|---|"];
  for (const r of reports) index.push(`| [${r.scenario.title}](${r.scenario.name}/report.md) | ${r.passed ? "PASS" : "FAIL"} | ${r.decisions.length} | ${r.totals.receipts} | ${r.model.replace(/^.*reasoning via /, "").replace(/\)$/, "")} |`);
  index.push("", "`private.jsonl` in each folder holds the raw thinking and salts. It is the vendor's copy: do not share it.");
  writeFileSync(join(outRoot, "README.md"), index.join("\n") + "\n");
  console.log(`\n${reports.filter((r) => r.passed).length}/${reports.length} passed. Output: ${outRoot}`);
  if (reports.some((r) => !r.passed)) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
