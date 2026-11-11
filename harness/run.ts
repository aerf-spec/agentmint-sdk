// Mini harness: runs short scripted caller conversations against the live call backend,
// captures everything, and writes a plain-English audit report per run.
//
//   npm run harness                       # every scenario in harness/scenarios
//   npm run harness -- visits-left        # one scenario by name
//   npm run harness -- --say VERIFY --say "Is Bayview in network?"   # ad-hoc lines
//
// Keyword: a line that is exactly VERIFY expands to an identity check, so a test can skip
// straight to the question. The backend accepts any credentials in test mode; the date of
// birth 1900-01-01 always fails, to test the refusal path.
// Env: CALL_URL, AUTHORITY_URL.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyAerfReceipt } from "../src/receipt-aerf.js";
import { verifyAerfChain } from "../src/chain.js";
import { renderHtml, renderMarkdown, type Report, type Step } from "./report.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CALL = process.env.CALL_URL ?? "https://filet-call.anikethsubs.workers.dev";
const AUTH = process.env.AUTHORITY_URL ?? "https://filet-authority.anikethsubs.workers.dev";
const HEADERS = { origin: "https://filet-demo.pages.dev" };

/** Valid test credentials. These match the mock member system behind the live backend. */
export const VERIFY_LINES = [
  "Hi, this is James. I'm calling about my wife Sarah. Her member ID is NH-552019.",
  "My date of birth is March 3rd, 1984.",
];

export interface Expect { point: string; decision?: string; rule_id?: string }
export interface Scenario {
  name: string;
  title: string;
  purpose: string;
  lines: string[];
  expect?: Expect[];
  forbid?: Expect[];
}

type Ev = { id: number; event: string; data: any };

export const expandLines = (lines: string[]) => lines.flatMap((l) => (l.trim() === "VERIFY" ? VERIFY_LINES : [l]));

// ── preflight: every service answers and the keys agree ─────────────

async function preflight(): Promise<string[]> {
  const problems: string[] = [];
  const get = async (url: string) => {
    try {
      const r = await fetch(url, { headers: HEADERS });
      return { status: r.status, text: await r.text() };
    } catch (e) {
      return { status: 0, text: String(e) };
    }
  };
  for (const url of [`${CALL}/healthz`, `${AUTH}/healthz`]) {
    const r = await get(url);
    if (r.status !== 200) problems.push(`${url} answered ${r.status}`);
  }
  const issuer = await get(`${CALL}/issuer`);
  if (issuer.status !== 200 || !JSON.parse(issuer.text).public_key_pem) problems.push("issuer key not available from /issuer");
  const key = await get(`${AUTH}/authority/v1/key`);
  if (key.status !== 200 || !JSON.parse(key.text).public_key_pem) problems.push("log key not available from the authority");
  return problems;
}

// ── one run ─────────────────────────────────────────────────────────

async function post(path: string, body?: unknown) {
  const r = await fetch(CALL + path, {
    method: "POST",
    headers: { ...HEADERS, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
}

async function runScenario(sc: Scenario, outRoot: string): Promise<Report> {
  const lines = expandLines(sc.lines);
  let created = await post("/call");
  for (let tries = 0; created.status === 429 && tries < 6; tries++) {
    console.log("  rate limited, waiting 15 s");
    await new Promise((r) => setTimeout(r, 15_000));
    created = await post("/call");
  }
  if (created.status !== 201) throw new Error(`could not start call: ${created.status} ${JSON.stringify(created.json)}`);
  const id = created.json.id as string;
  console.log(`\n▶ ${sc.name}  (call ${id})`);

  const events: Ev[] = [];
  const waiters: { pred: (e: Ev) => boolean; resolve: (e: Ev) => void }[] = [];
  const waitFor = (pred: (e: Ev) => boolean, ms = 180_000) => {
    const hit = events.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise<Ev>((res, rej) => {
      const t = setTimeout(() => rej(new Error("timed out waiting for the agent")), ms);
      waiters.push({ pred, resolve: (e) => { clearTimeout(t); res(e); } });
    });
  };

  // Read the event stream. If the connection drops, resume after the last event seen.
  const ac = new AbortController();
  let lastId = 0;
  const readOnce = async () => {
    const r = await fetch(`${CALL}/call/${id}/events?last_event_id=${lastId}`, { headers: HEADERS, signal: ac.signal });
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const o: Record<string, string> = {};
        for (const line of raw.split("\n")) { const k = line.indexOf(": "); if (k > 0) o[line.slice(0, k)] = line.slice(k + 2); }
        if (!o.event || !o.data) continue;
        const e: Ev = { id: Number(o.id), event: o.event, data: JSON.parse(o.data) };
        if (e.id <= lastId) continue;
        lastId = e.id;
        events.push(e);
        if (e.event === "turn" && e.data.who === "agent") console.log(`  Ava:    ${e.data.text}`);
        if (e.event === "decision") {
          const d = e.data.decision_record;
          console.log(`          [decision] ${d.point} → ${d.decision} (${d.rule_id})`);
        }
        for (const w of [...waiters]) if (w.pred(e)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(e); }
      }
    }
  };
  void (async () => {
    for (let drops = 0; !ac.signal.aborted && drops < 20; drops++) {
      try { await readOnce(); } catch (e) { if (ac.signal.aborted) return; }
      if (!ac.signal.aborted) { console.log("  (stream dropped, resuming)"); await new Promise((r) => setTimeout(r, 1000)); }
    }
  })();

  await waitFor((e) => e.event === "start");
  for (const [n, text] of lines.entries()) {
    console.log(`  Caller: ${text}`);
    const r = await post(`/call/${id}/turn`, { text });
    if (r.status !== 202) throw new Error(`turn ${n + 1} refused: ${r.status} ${JSON.stringify(r.json)}`);
    await waitFor((e) => e.event === "span" && e.data.kind === "turn" && e.data.turn === n + 1);
  }
  await post(`/call/${id}/end`);
  await waitFor((e) => e.event === "done");
  ac.abort();

  const pkg = (await (await fetch(`${CALL}/call/${id}/package`, { headers: HEADERS })).json()) as any;
  const report = buildReport(sc, id, events, pkg);

  const dir = join(outRoot, sc.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  writeFileSync(join(dir, "report.md"), renderMarkdown(report));
  writeFileSync(join(dir, "report.html"), renderHtml(report));
  console.log(`  ${report.passed ? "PASS" : "FAIL"}  → ${join(dir, "report.html")}`);
  for (const c of report.checks.filter((c) => !c.ok)) console.log(`    ✗ ${c.label}: ${c.detail}`);
  return report;
}

// ── turn the raw events + package into a plain report ───────────────

const PHI_TOOLS = new Set(["lookup_benefits", "check_network", "check_prior_auth", "send_pa_letter"]);
const matches = (d: any, x: Expect) =>
  d.point === x.point && (!x.decision || d.decision === x.decision) && (!x.rule_id || d.rule_id === x.rule_id);
const fmtExpect = (x: Expect) => [x.point, x.decision, x.rule_id].filter(Boolean).join(" → ");

export function buildReport(sc: Scenario, callId: string, events: Ev[], pkg: any): Report {
  const of = (name: string) => events.filter((e) => e.event === name).map((e) => e.data);
  const start = of("start")[0] ?? {};
  const rules: Record<string, string> = start.rules ?? {};

  const thinkingByStep = new Map<number, string>();
  for (const t of of("thinking")) thinkingByStep.set(t.step, (thinkingByStep.get(t.step) ?? "") + t.chunk);

  const receiptByToolUse = new Map<string, string>();
  for (const r of of("tool_result")) if (r.name === "record_decision" && r.result?.receipt_id) receiptByToolUse.set(r.tool_use_id, r.result.receipt_id);
  // The live backend streams no tool_result for record_decision, so match each decision to the
  // next unused decide:<point> receipt signed in the same model step.
  const usedSigned = new Set<string>();
  const signedEvents = of("signed");
  const matchSigned = (d: any): string | undefined => {
    const hit = signedEvents.find((s) => !usedSigned.has(s.receipt_id) && s.step === d.step && s.receipt?.action === `decide:${d.decision_record.point}`);
    if (hit) usedSigned.add(hit.receipt_id);
    return hit?.receipt_id;
  };
  const verifiedById = new Map(of("verified").map((v) => [v.receipt_id, v]));

  // Verify every receipt in the evidence package with the SDK, independently of the backend.
  const receipts: any[] = pkg.receipts ?? [];
  const ownCheck = new Map<string, boolean>();
  for (const r of receipts) {
    const v = verifyAerfReceipt(r, { issuerPublicKey: pkg.issuer_public_key_pem, logPublicKey: pkg.authority?.public_key_pem, requireLog: true });
    ownCheck.set(r.id, v.ok && v.log === "passed");
  }
  const chain = verifyAerfChain(receipts, { issuerPublicKey: pkg.issuer_public_key_pem });

  const decisions = of("decision").map((d, i) => {
    const receiptId = receiptByToolUse.get(d.tool_use_id) ?? matchSigned(d) ?? null;
    const claims = (d.reasoning?.claims ?? d.claims ?? []).map((c: any) => ({
      id: c.id,
      text: typeof c.text === "string" ? c.text : "(withheld by leak scan)",
      cites: (c.cites ?? []).map((x: any) => ({ kind: x.kind, ref: x.ref, value: x.value, resolved: x.resolved !== false && x.value != null })),
    }));
    return {
      n: i + 1,
      turn: d.turn,
      question: typeof d.reasoning?.question === "string" ? d.reasoning.question : "(withheld)",
      point: d.decision_record.point,
      decision: d.decision_record.decision,
      rule_id: d.decision_record.rule_id,
      rule_text: d.rule_text ?? rules[d.decision_record.rule_id] ?? "",
      maps_to: d.maps_to ?? start.policy_map?.[d.decision_record.rule_id] ?? [],
      uncertainty: d.decision_record.uncertainty,
      claims,
      thinking: (thinkingByStep.get(d.step) ?? "").trim(),
      receipt_id: receiptId,
      backend_verified: receiptId ? verifiedById.get(receiptId)?.issuer === true && verifiedById.get(receiptId)?.log === "passed" : false,
      own_verified: receiptId ? ownCheck.get(receiptId) === true : false,
    };
  });

  // Tool activity, in order, with the PHI gate check.
  let verified = false;
  let phiBeforeId = 0;
  const tools = of("tool_result")
    .filter((r) => r.name !== "record_decision")
    .map((r) => {
      if (r.name === "verify_rep_dob" && r.result?.match === true) verified = true;
      const blocked = r.result?.error === "caller_not_verified";
      if (PHI_TOOLS.has(r.name) && !blocked && !verified) phiBeforeId++;
      return { turn: r.turn, name: r.name, blocked, result: r.result };
    });

  const done = of("done")[0] ?? {};
  const signed = of("signed").length;
  const anchored = new Set(of("anchored").map((a) => a.receipt_id)).size;
  const checks = [
    ...(sc.expect ?? []).map((x) => ({ label: `Expected decision: ${fmtExpect(x)}`, ok: decisions.some((d) => matches(d, x)), detail: "not recorded" })),
    ...(sc.forbid ?? []).map((x) => ({ label: `Must not happen: ${fmtExpect(x)}`, ok: !decisions.some((d) => matches(d, x)), detail: "it was recorded" })),
    { label: "No member data shared before identity was verified", ok: phiBeforeId === 0, detail: `${phiBeforeId} tool result(s) leaked early` },
    { label: "Every reasoning step points at real evidence", ok: decisions.every((d) => d.claims.every((c: any) => c.cites.every((x: any) => x.resolved))), detail: "some citations did not resolve" },
    { label: "Every receipt is signed and in the public log", ok: signed > 0 && anchored === signed && (done.unanchored ?? 0) === 0, detail: `${anchored} of ${signed} anchored` },
    { label: "Receipts check out with our own verifier", ok: receipts.length > 0 && [...ownCheck.values()].every(Boolean), detail: `${[...ownCheck.values()].filter((x) => !x).length} failed` },
    { label: "Receipt chain is unbroken", ok: chain.valid, detail: (chain as any).reason ?? "chain broken" },
  ];

  return {
    scenario: sc,
    call_id: callId,
    ran_at: new Date().toISOString(),
    model: start.model ?? "",
    prompt_version: start.prompt_version ?? "",
    transcript: of("turn").map((t) => ({ who: t.who, at: t.at, text: t.text })),
    timeline: timeline(events),
    decisions,
    tools,
    checks,
    passed: checks.every((c) => c.ok),
    totals: { receipts: receipts.length, usd: done.cost?.usd_total ?? null },
  };
}

/** Spoken lines and decisions in the order they happened. */
function timeline(events: Ev[]): Step[] {
  let n = 0;
  const out: Step[] = [];
  for (const e of events) {
    if (e.event === "turn") out.push({ kind: "say", who: e.data.who, at: e.data.at, text: e.data.text });
    else if (e.event === "decision") out.push({ kind: "decision", n: ++n });
  }
  return out;
}

// ── CLI ─────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const says: string[] = [];
  const names: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--say") says.push(args[++i] ?? "");
    else names.push(args[i]!);
  }
  const scDir = join(HERE, "scenarios");
  let scenarios: Scenario[] = readdirSync(scDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(scDir, f), "utf8")));
  if (says.length) scenarios = [{ name: "ad-hoc", title: "Ad-hoc run", purpose: "Lines typed on the command line.", lines: says }];
  else if (names.length) scenarios = scenarios.filter((s) => names.includes(s.name));
  if (!scenarios.length) throw new Error(`no scenarios matched: ${names.join(", ")}`);

  const problems = await preflight();
  if (problems.length) {
    console.error("Preflight failed:\n  " + problems.join("\n  "));
    process.exit(2);
  }
  console.log(`Preflight ok: ${CALL} and ${AUTH} are up, keys available.`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outRoot = join(HERE, "runs", stamp);
  const reports: Report[] = [];
  for (const sc of scenarios) reports.push(await runScenario(sc, outRoot));

  const index = ["# Harness run " + stamp, "", "| Scenario | Result | Decisions | Receipts | Cost |", "|---|---|---|---|---|"];
  for (const r of reports) index.push(`| [${r.scenario.title}](${r.scenario.name}/report.md) | ${r.passed ? "PASS" : "FAIL"} | ${r.decisions.length} | ${r.totals.receipts} | ${r.totals.usd == null ? "?" : "$" + Number(r.totals.usd).toFixed(3)} |`);
  writeFileSync(join(outRoot, "README.md"), index.join("\n") + "\n");
  console.log(`\n${reports.filter((r) => r.passed).length}/${reports.length} passed. Output: ${outRoot}`);
  if (reports.some((r) => !r.passed)) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((e) => { console.error(e); process.exit(1); });
