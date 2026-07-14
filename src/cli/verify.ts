import { execFileSync } from "node:child_process";
import { createPublicKey } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  verify,
  demoReceipt,
  formatVerifyReceipt,
  formatVerifyJSONL,
  type VerifyInput,
} from "../verify.js";
import { verifyDecisionReceipts } from "../receipt-decision.js";
import { publicKeyToPem, privateKeyFromPem } from "../kernel/sign.js";
import type { DecisionReceipt } from "../types.js";
import { brand, dim, fg, green, muted, red } from "./color.js";

interface Args {
  demo: boolean;
  dir?: string;
  spec?: string;
  diff?: string;
  context?: string;
  schemaDir?: string;
  mode?: "shadow" | "enforce";
  receipts?: string;
  pub?: string;
  key?: string;
  json: boolean;
  jsonl: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { demo: false, json: false, jsonl: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "demo") args.demo = true;
    else if (a === "--dir") args.dir = argv[++i];
    else if (a === "--spec") args.spec = argv[++i];
    else if (a === "--diff") args.diff = argv[++i];
    else if (a === "--context") args.context = argv[++i];
    else if (a === "--schema-dir") args.schemaDir = argv[++i];
    else if (a === "--mode") args.mode = argv[++i] as "shadow" | "enforce";
    else if (a === "--receipts") args.receipts = argv[++i];
    else if (a === "--pub") args.pub = argv[++i];
    else if (a === "--key") args.key = argv[++i];
    else if (a === "--json") args.json = true;
    else if (a === "--jsonl") args.jsonl = true;
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

function showHelp(): void {
  console.log("");
  console.log(`  ${brand()}  ${dim("verify")}`);
  console.log(`  ${muted("Independently check a receipt chain, or a code change, against its invariants.")}`);
  console.log("");
  console.log(`  ${fg("Usage:")}  agentmint verify ${dim("[demo] [options]")}`);
  console.log("");
  console.log(`  ${fg("Options:")}`);
  console.log(`    ${fg("--receipts")}    ${muted("A receipts file or directory to verify as a signed chain.")}`);
  console.log(`    ${fg("--pub")}         ${muted("The issuer public key (PEM) that signed those receipts.")}`);
  console.log(`    ${fg("--key")}         ${muted("The issuer private key (PEM), if you have it instead of the public key.")}`);
  console.log(`    ${fg("--dir")}         ${muted("A directory of source to verify.")}`);
  console.log(`    ${fg("--diff")}        ${muted("A git ref such as HEAD~1, a diff file, or diff content.")}`);
  console.log(`    ${fg("--spec")}        ${muted("Path to agentmint.spec.yaml.")}`);
  console.log(`    ${fg("--context")}     ${muted("Ticket or PR description text.")}`);
  console.log(`    ${fg("--schema-dir")}  ${muted("Directory with type definitions.")}`);
  console.log(`    ${fg("--json")}        ${muted("Emit the full receipt as JSON.")}`);
  console.log(`    ${fg("--jsonl")}       ${muted("Emit one JSONL event per claim.")}`);
  console.log("");
  console.log(`  ${fg("Examples:")}`);
  console.log(`    ${dim("$")} agentmint verify --receipts examples/demos/out/receipts.json --pub examples/demos/out/public_key.pem`);
  console.log(`    ${dim("$")} agentmint verify demo`);
  console.log(`    ${dim("$")} agentmint verify --dir ./src --spec agentmint.spec.yaml`);
  console.log(`    ${dim("$")} agentmint verify --diff HEAD~1 --context "fix refund bug"`);
  console.log("");
}

/** Load decision receipts from a JSON array file, a JSONL file, or a directory. */
function loadDecisionReceipts(path: string): DecisionReceipt[] {
  const out: DecisionReceipt[] = [];
  const addFile = (file: string): void => {
    const text = readFileSync(file, "utf-8");
    if (file.endsWith(".jsonl")) {
      for (const line of text.split("\n")) {
        if (line.trim()) out.push(JSON.parse(line) as DecisionReceipt);
      }
    } else {
      const parsed = JSON.parse(text) as DecisionReceipt | DecisionReceipt[];
      if (Array.isArray(parsed)) out.push(...parsed);
      else out.push(parsed);
    }
  };
  if (statSync(path).isDirectory()) {
    for (const name of readdirSync(path).sort()) {
      if (name === "public_key.pem" || name === "plan.json") continue;
      const full = join(path, name);
      if (statSync(full).isFile() && (name.endsWith(".json") || name.endsWith(".jsonl"))) {
        addFile(full);
      }
    }
  } else {
    addFile(path);
  }
  // Order by seq when present so an out-of-order load still verifies.
  out.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  return out;
}

/** Resolve the issuer public key PEM from --pub, --key, or a sibling public_key.pem. */
function resolvePublicKey(args: Args): string | undefined {
  if (args.pub && existsSync(args.pub)) return readFileSync(args.pub, "utf-8");
  if (args.key && existsSync(args.key)) {
    return publicKeyToPem(createPublicKey(privateKeyFromPem(readFileSync(args.key, "utf-8"))));
  }
  // Look for a public_key.pem next to the receipts.
  if (args.receipts) {
    const base = statSync(args.receipts).isDirectory() ? args.receipts : join(args.receipts, "..");
    const sibling = join(base, "public_key.pem");
    if (existsSync(sibling)) return readFileSync(sibling, "utf-8");
  }
  return undefined;
}

/**
 * Verify a signed receipt chain and print one plain sentence per check, a PASS
 * or FAIL summary, and on failure the receipt index and what changed. Returns
 * true when the chain is whole so the caller can set the exit code.
 */
function verifyReceiptChain(args: Args): boolean {
  if (!existsSync(args.receipts!)) {
    console.error(`\n  ${red("✗")} No such receipts path: ${args.receipts}\n`);
    return false;
  }
  const receipts = loadDecisionReceipts(args.receipts!);
  if (receipts.length === 0) {
    console.error(`\n  ${red("✗")} No receipts found in ${args.receipts} (.json or .jsonl).\n`);
    return false;
  }
  const publicKeyPem = resolvePublicKey(args);
  if (!publicKeyPem) {
    console.error(`\n  ${red("✗")} Need the issuer key to check signatures. Pass --pub public_key.pem or --key notary_key.pem.\n`);
    return false;
  }

  const result = verifyDecisionReceipts(receipts, publicKeyPem);
  const n = receipts.length;
  console.log("");

  if (result.ok) {
    console.log(`  ${green("✓")} ${fg(`All ${n} signatures hold.`)}`);
    console.log(`  ${green("✓")} ${fg("The chain is intact.")}`);
    console.log(`  ${green("✓")} ${fg("Sequence numbers are complete.")}`);
    console.log("");
    console.log(`  ${green("PASS")} ${muted(`${n} receipts verified against key ${receipts[0]!.key_id}.`)}`);
    console.log("");
    return true;
  }

  // A break stops the walk at the first bad receipt. Report the checks that
  // held up to that point, then the one that failed and what it means.
  const at = result.brokenAt ?? 0;
  // Keep the machine reason for grep, minus any em dash so CLI output stays plain.
  const reason = (result.reason ?? "").replace(/\s*—\s*/g, ": ");
  const isSig = /signature/i.test(reason);
  const isSeq = /seq/i.test(reason) && !isSig;

  if (isSig) {
    console.log(`  ${red("✗")} ${fg(`A signature no longer holds at receipt ${at + 1} of ${n}.`)}`);
    console.log(`  ${muted("A signed field was changed after this receipt was issued.")}`);
  } else if (isSeq) {
    console.log(`  ${green("✓")} ${fg("Every signature holds.")}`);
    console.log(`  ${red("✗")} ${fg(`A sequence number is missing at receipt ${at + 1} of ${n}.`)}`);
    console.log(`  ${muted("A decision was removed from the chain.")}`);
  } else {
    console.log(`  ${green("✓")} ${fg("Every signature holds.")}`);
    console.log(`  ${red("✗")} ${fg(`The chain is broken at receipt ${at + 1} of ${n}.`)}`);
    console.log(`  ${muted("A receipt was removed or reordered. Logs can omit; chains cannot.")}`);
  }
  console.log("");
  console.log(`  ${red("FAIL")} ${muted(`receipt ${at + 1} of ${n}: ${reason}`)} ${dim(`[${result.brokenAt}]`)}`);
  console.log("");
  return false;
}

/** If --diff is a git ref (not a file, not raw diff text), materialize it via git. */
function resolveDiff(value: string): string {
  const looksLikeDiff = value.includes("\n") || value.includes("diff --git");
  if (looksLikeDiff || existsSync(value)) return value;
  try {
    return execFileSync("git", ["diff", value], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    // Not a valid ref — pass through and let verify() treat it as content.
    return value;
  }
}

export async function runVerify(): Promise<void> {
  const args = parseArgs(process.argv.slice(3));

  if (args.help) {
    showHelp();
    return;
  }

  // Receipt-chain verification: check a signed chain and exit 0 (whole) or 1 (broken).
  if (args.receipts) {
    const ok = verifyReceiptChain(args);
    console.log(`  ${muted("Next: send this chain to your buyer. They verify it the same way, on their own machine.")}`);
    console.log("");
    if (!ok) process.exitCode = 1;
    return;
  }

  if (!args.demo && !args.dir && !args.diff) {
    console.error("");
    console.error(`  ${red("✗")} ${fg("agentmint verify")} needs ${fg("--receipts")}, ${fg("demo")}, ${fg("--dir")}, or ${fg("--diff")}.`);
    console.error(`  ${muted("Run")} ${fg("npx @npmsai/agentmint verify --help")} ${muted("for usage.")}`);
    console.error("");
    process.exitCode = 1;
    return;
  }

  const receipt = args.demo
    ? demoReceipt()
    : await verify({
        dir: args.dir,
        spec: args.spec,
        diff: args.diff ? resolveDiff(args.diff) : undefined,
        context: args.context,
        schemaDir: args.schemaDir,
        mode: args.mode,
      } satisfies VerifyInput);

  if (args.json) {
    console.log(JSON.stringify(receipt, null, 2));
  } else if (args.jsonl) {
    console.log(formatVerifyJSONL(receipt));
  } else {
    console.log(formatVerifyReceipt(receipt));
  }

  // In enforce mode, exit non-zero when there is something a human must act on.
  // Shadow mode (the default, and the demo) always exits 0.
  if (args.mode === "enforce" && (receipt.summary.failed > 0 || receipt.summary.blocked > 0)) {
    process.exitCode = 1;
  }
}
