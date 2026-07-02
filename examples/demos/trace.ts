// npm run demo:trace
//
// The engineer's demo: one agent session run twice — raw (no gate) and through
// harden() with a real spec — so the full enforcement pipeline is visible. Every
// gate line below is the REAL check enforce.ts evaluated for that call, surfaced
// via config.onDecision. Verdicts, reasons, params hashes, and the receipt chain
// are all real engine state; nothing here is simulated.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { harden } from "../../src/experimental/harden.js";
import { loadSpecFromFile } from "../../src/kernel/spec.js";
import {
  generateKeyPair,
  privateKeyToPem,
  publicKeyToPem,
} from "../../src/kernel/sign.js";
import { canonicalBytes, sha256Hex } from "../../src/kernel/canonical.js";
import { formatJSONL } from "../../src/jsonl.js";
import { verifyDecisionReceipts } from "../../src/receipt-decision.js";
import type { AgentMintConfig, AgentMintSpec, DecisionInfo, DecisionReceipt, Event } from "../../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));

// ── value formatting (JS-literal style, not JSON) ───────────────────
function fmtVal(v: unknown): string {
  return typeof v === "string" ? `"${v}"` : String(v);
}
function fmt(o: Record<string, unknown>): string {
  return `{${Object.entries(o).map(([k, v]) => `${k}: ${fmtVal(v)}`).join(", ")}}`;
}
function truncate(s: string, n = 60): string {
  return s.length > n ? s.slice(0, n) : s;
}
function hash8(hex: string): string {
  return hex.slice(0, 8) + "...";
}

// The four tool stubs — real functions returning plausible data. The same
// impls back both the control run (called raw) and the hardened run.
const impls = {
  lookup_customer: async (_p: Record<string, unknown>) => ({ name: "Kenji Tanaka", balance: 4200 }),
  transfer_funds: async (p: Record<string, unknown>) => ({ ok: true, transferred: p.amount }),
  delete_audit_log: async (_p: Record<string, unknown>) => ({ deleted: 147 }),
  generate_report: async (_p: Record<string, unknown>) => ({ report: "Q2 summary: 14 transactions..." }),
};

async function control() {
  console.log("=== control: raw tool calls, no gate ===\n");
  const calls: [keyof typeof impls, Record<string, unknown>][] = [
    ["lookup_customer", { id: "cust_8829" }],
    ["transfer_funds", { from: "cust_8829", to: "cust_0012", amount: 5000 }],
    ["transfer_funds", { from: "cust_8829", to: "cust_0012", amount: 5000 }],
    ["delete_audit_log", { all: true }],
  ];
  for (const [tool, params] of calls) {
    console.log(`agent calls ${tool}(${fmt(params)})`);
    const result = await impls[tool](params);
    console.log(`  -> ${truncate(fmt(result as Record<string, unknown>))}\n`);
  }
  console.log("no receipts. no enforcement. no evidence it happened.\n");
}

// spec summary — a tool is a "deny rule" if it can refuse a call (bare block,
// a requires gate, or a blocking input rule). Descriptions come from the spec.
function specSummary(spec: AgentMintSpec): { line: string; denies: string[] } {
  const tools = spec.tools ?? {};
  const denies: string[] = [];
  for (const [name, t] of Object.entries(tools)) {
    const inputBlocks = Object.values(t.input?.properties ?? {}).some((p) => p.action === "block");
    if (t.requires?.length) denies.push(`deny: ${name} (requires prior ${t.requires.join(", ")})`);
    else if (t.action === "block") denies.push(`deny: ${name} (action: block)`);
    else if (inputBlocks) denies.push(`deny: ${name} (input rule)`);
  }
  const budget = spec.breakers?.budget?.max_total_usd ?? 0;
  return {
    line: `spec loaded: ${Object.keys(tools).length} tools, ${denies.length} deny rules, budget $${budget.toFixed(2)}`,
    denies,
  };
}

// The bracket after a deny verdict, e.g. "[max_ref: amount exceeds referenced balance]".
function denyBracket(d: DecisionInfo, spec: AgentMintSpec): string {
  if (d.reason === "action_block") return "action_block";
  if (d.reason === "max_ref" || d.reason === "cross_ref") {
    const props = spec.tools?.[d.tool]?.input?.properties ?? {};
    const field = Object.keys(props).find((k) => props[k]!.max_ref || props[k]!.cross_ref) ?? "value";
    const refField = (props[field]?.max_ref ?? props[field]?.cross_ref ?? "").split(".").pop();
    return `${d.reason}: ${field} exceeds referenced ${refField}`;
  }
  if (d.reason === "loop_breaker") {
    const lc = d.checks.find((c) => c.name === "loop check?");
    const count = lc ? lc.detail.split(" ")[0] : "?";
    return `loop_breaker: ${count} identical calls`;
  }
  return d.reason ?? "";
}

// Which real checks to surface per step (values are pulled from the live
// decision; this only chooses what to show for a legible trace).
interface Step {
  tool: keyof typeof impls;
  params: Record<string, unknown>;
  show: string[];
}
const STEPS: Step[] = [
  { tool: "lookup_customer", params: { id: "cust_8829" }, show: ["allow list?", "deny list?", "requires?", "budget?"] },
  { tool: "transfer_funds", params: { from: "cust_8829", to: "cust_0012", amount: 5000 }, show: ["allow list?", "deny list?", "requires?", "input check?"] },
  { tool: "transfer_funds", params: { from: "cust_8829", to: "cust_0012", amount: 5000 }, show: ["loop check?"] },
  { tool: "delete_audit_log", params: { all: true }, show: ["deny list?"] },
  { tool: "generate_report", params: { type: "summary" }, show: ["allow list?", "budget?"] },
];

async function main() {
  const spec = loadSpecFromFile(join(here, "trace-spec.yaml"));

  await control();

  console.log("=== hardened: same calls, policy gate active ===\n");
  const summary = specSummary(spec);
  console.log(summary.line);
  for (const d of summary.denies) console.log(`  ${d}`);
  console.log("");

  const { publicKey, privateKey } = generateKeyPair();
  const publicKeyPem = publicKeyToPem(publicKey);

  const decisions: DecisionInfo[] = [];
  const config: AgentMintConfig = {
    spec,
    allow: Object.keys(spec.tools ?? {}),
    signing: { privateKeyPem: privateKeyToPem(privateKey) },
    onDecision: (info) => decisions.push(info),
  };
  const tools = harden(impls, config) as typeof impls & {
    __receipts(): DecisionReceipt[];
    __log(): Event[];
  };

  for (const step of STEPS) {
    console.log(`agent calls ${step.tool}(${fmt(step.params)})`);
    const ret = await tools[step.tool](step.params);
    const d = decisions[decisions.length - 1]!;
    const receipt = tools.__receipts()[decisions.length - 1]!;

    console.log(`  gate: ${step.tool}`);
    for (const name of step.show) {
      const c = d.checks.find((x) => x.name === name);
      if (c) console.log(`    ${name.padEnd(13)}${c.detail}`);
    }

    if (d.verdict === "allow") {
      console.log("  -> allow");
      console.log(`  receipt ${receipt.seq}: allow  ${receipt.action}  params_hash=${receipt.params_hash.slice(0, 12)}...`);
      console.log(`  tool returned ${truncate(fmt(ret as Record<string, unknown>))}`);
    } else {
      console.log(`  -> deny  [${denyBracket(d, spec)}]`);
      console.log(`  receipt ${receipt.seq}: deny  ${receipt.action}  reason=${d.reason}  params_hash=${receipt.params_hash.slice(0, 12)}...`);
    }
    console.log("");
  }

  // ── receipts summary ──────────────────────────────────────────────
  const receipts = tools.__receipts();

  // Export the event log as JSONL for downstream tooling (e.g. `agentmint
  // learn`, which infers a spec + regression tests from these receipts).
  const outDir = join(here, "out");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "receipts.jsonl"),
    formatJSONL(tools.__log(), receipts[0]?.run_id ?? "amr_demo") + "\n",
  );

  console.log("=== receipts ===\n");
  for (const r of receipts) {
    const verdict = (r.in_policy ? "allow" : "deny").padEnd(5);
    const reason = r.in_policy ? "" : (decisions[r.seq - 1]!.reason ?? "");
    const prev = r.previous_receipt_hash ? hash8(r.previous_receipt_hash) : "genesis";
    console.log(`${r.seq}  ${verdict}  ${r.action.padEnd(19)}${reason.padEnd(24)}prev=${prev}`);
  }
  const whole = verifyDecisionReceipts(receipts, publicKeyPem);
  console.log(`\nchain: ${whole.ok ? `valid (${receipts.length} receipts)` : `broken at ${whole.brokenAt}`}\n`);

  // ── verify: tamper then delete ────────────────────────────────────
  console.log("=== verify ===\n");

  const tampered = receipts.map((r) => ({ ...r }));
  const orig = tampered[1]!.action;
  const flipped = orig.slice(0, -1) + String.fromCharCode(orig.charCodeAt(orig.length - 1) + 1);
  tampered[1]!.action = flipped;
  const t = verifyDecisionReceipts(tampered, publicKeyPem);
  console.log(`flip receipt 2 action field: "${orig}" -> "${flipped}"`);
  console.log(`chain: broken at ${(t.brokenAt ?? 0) + 1} (signature mismatch)\n`);

  const pruned = receipts.filter((_, i) => i !== 3);
  const p = verifyDecisionReceipts(pruned, publicKeyPem);
  const at = p.brokenAt ?? 0;
  const expectedPrev = hash8(sha256Hex(canonicalBytes(pruned[at - 1] as unknown as Record<string, unknown>)));
  const gotPrev = hash8(pruned[at]!.previous_receipt_hash ?? "");
  console.log(`delete receipt 4 (deny ${receipts[3]!.action}):`);
  console.log(`chain: broken at ${at + 1} (expected prev ${expectedPrev}, got ${gotPrev}; seq gap ${at + 1}->${pruned[at]!.seq})\n`);

  // ── punchline ─────────────────────────────────────────────────────
  console.log("the control run transferred $10,000 and deleted 147 audit records.");
  console.log("the hardened run did neither, and every refusal is signed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
