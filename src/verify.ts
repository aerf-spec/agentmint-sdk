import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { canonicalize } from "./merkle.js";
import { loadSpec } from "./spec.js";
import { matchPattern } from "./cross-ref.js";
import type { AgentMintSpec } from "./types.js";
import * as C from "./cli/color.js";

// ── Public types ───────────────────────────────────────────────────

export interface VerifyInput {
  diff?: string; // git diff content or path to diff file
  dir?: string; // directory to verify
  context?: string; // ticket/PR description text
  spec?: string; // path to agentmint.spec.yaml
  schemaDir?: string; // directory with type definitions
  mode?: "shadow" | "enforce";
}

export interface VerifyClaim {
  id: string;
  type: "invariant" | "policy" | "pattern" | "property";
  description: string;
  status: "verified" | "failed" | "unverified" | "blocked";
  evidence?: string;
  source: "spec" | "schema" | "context" | "heuristic";
}

export interface VerifyReceipt {
  timestamp: string;
  scope: {
    files_changed: number;
    functions_touched: number;
    tools_found: number;
    risky_actions: string[];
  };
  claims: VerifyClaim[];
  summary: {
    verified: number;
    failed: number;
    unverified: number;
    blocked: number;
    needs_review: string[];
  };
  hash: string;
}

// ── Source scanning primitives ─────────────────────────────────────

interface ScannedFile {
  path: string;
  content: string;
}

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage", "build"]);

/** Recursively collect .ts/.js source files from a directory. */
function collectSourceFiles(dir: string): ScannedFile[] {
  const out: ScannedFile[] = [];
  const walk = (d: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(d, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (CODE_EXT.test(entry) && !entry.endsWith(".d.ts")) {
        try {
          out.push({ path: full, content: readFileSync(full, "utf-8") });
        } catch {
          /* unreadable file, skip */
        }
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * Parse a unified diff into per-file added content.
 * Returns one ScannedFile per changed file, whose `content` is the set of
 * added ("+") lines — the surface a verifier can make claims about.
 */
function parseDiff(diff: string): ScannedFile[] {
  const files = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of diff.split("\n")) {
    const header = line.match(/^\+\+\+ (?:b\/)?(.+)$/);
    if (header) {
      const name = header[1]!.trim();
      current = name === "/dev/null" ? null : name;
      if (current && !files.has(current)) files.set(current, []);
      continue;
    }
    if (line.startsWith("diff --git")) {
      current = null;
      continue;
    }
    if (current && line.startsWith("+") && !line.startsWith("+++")) {
      files.get(current)!.push(line.slice(1));
    }
  }
  return [...files.entries()].map(([path, added]) => ({
    path,
    content: added.join("\n"),
  }));
}

/** Resolve the `diff` input into scanned files (content or path to a diff file). */
function loadDiff(diff: string): ScannedFile[] {
  let content = diff;
  const looksLikeDiff =
    diff.includes("\n") &&
    (diff.includes("diff --git") || diff.includes("@@ ") || diff.includes("+++ "));
  if (!looksLikeDiff) {
    try {
      content = readFileSync(diff, "utf-8");
    } catch {
      content = diff; // best-effort: treat the string itself as diff content
    }
  }
  return parseDiff(content);
}

interface Discovery {
  tools: Set<string>;
  functions: Set<string>;
}

const TOOL_PATTERNS = [
  /export\s+async\s+function\s+([A-Za-z_$][\w$]*)/g,
  /(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*async\b/g,
  /([A-Za-z_$][\w$]*)\s*:\s*async\b/g, // object method:  foo: async () => {}
  /\basync\s+([A-Za-z_$][\w$]*)\s*\(/g, // method shorthand:  async foo() {}
];

const FUNCTION_PATTERNS = [
  /\bfunction\s+([A-Za-z_$][\w$]*)/g,
  /(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g,
  /([A-Za-z_$][\w$]*)\s*:\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>)/g,
];

const RESERVED = new Set([
  "async",
  "function",
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "await",
]);

/** Discover tool (async) and function names across scanned files. */
function discover(files: ScannedFile[]): Discovery {
  const tools = new Set<string>();
  const functions = new Set<string>();
  for (const file of files) {
    for (const re of TOOL_PATTERNS) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(file.content))) {
        const name = m[1]!;
        if (!RESERVED.has(name)) {
          tools.add(name);
          functions.add(name);
        }
      }
    }
    for (const re of FUNCTION_PATTERNS) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(file.content))) {
        const name = m[1]!;
        if (!RESERVED.has(name)) functions.add(name);
      }
    }
  }
  return { tools, functions };
}

/** Extract all string-literal contents (single, double, backtick). */
function extractStringLiterals(content: string): string[] {
  const out: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|`((?:\\.|[^`\\])*)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    out.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return out;
}

// ── Risky-action heuristics ────────────────────────────────────────

const PROTECTED_BRANCHES = ["main", "master", "prod", "production", "release"];
const DESTRUCTIVE = ["rm -rf", "rm -r", "sudo ", "drop table", "truncate", "> /dev", "mkfs", ":(){"];

function isRisky(tool: string): boolean {
  const t = tool.toLowerCase();
  return (
    t.startsWith("delete_") ||
    t.includes("delete") ||
    t === "run_command" ||
    t.includes("run_command") ||
    t.includes("exec") ||
    t.includes("shell") ||
    t === "git_push" ||
    t.includes("git_push") ||
    t.includes("force_push")
  );
}

// ── Claim builders ─────────────────────────────────────────────────

let claimSeq = 0;
function nextId(prefix: string): string {
  claimSeq += 1;
  return `${prefix}-${claimSeq}`;
}

interface CoreInput {
  files: ScannedFile[]; // scannable source (full files, or added diff lines)
  changedFiles: string[]; // file paths considered "changed"
  specContent?: string;
  context?: string;
  schemaFiles?: ScannedFile[];
}

/** Deterministic verification core — shared by verify() and the demo. */
function runVerification(input: CoreInput): VerifyReceipt {
  claimSeq = 0;
  const claims: VerifyClaim[] = [];

  const { tools, functions } = discover(input.files);
  const literals = input.files.flatMap((f) => extractStringLiterals(f.content));
  const literalBlob = literals.join("\n");

  // ── Step 2 + 3: Spec-derived deterministic claims ────────────────
  let spec: AgentMintSpec | undefined;
  if (input.specContent) {
    try {
      spec = loadSpec(input.specContent);
    } catch {
      spec = undefined;
    }
  }

  if (spec?.tools) {
    for (const [tool, cfg] of Object.entries(spec.tools)) {
      // requires: prerequisite tool must exist in the scanned codebase
      for (const prereq of cfg.requires ?? []) {
        const present = tools.has(prereq) || functions.has(prereq);
        claims.push({
          id: nextId("requires"),
          type: "invariant",
          description: present
            ? `${tool} requires ${prereq} to run first`
            : `${tool} called without required ${prereq}`,
          status: present ? "verified" : "failed",
          evidence: present
            ? `${prereq} defined in scanned code`
            : `${prereq} not found among ${tools.size} scanned tools`,
          source: "spec",
        });
      }

      // property-level rules: blocked_patterns / blocked_values / max_ref
      const props = cfg.input?.properties ?? {};
      for (const [field, prop] of Object.entries(props)) {
        for (const pattern of prop.blocked_patterns ?? []) {
          const hit = literals.find((lit) => matchPattern(lit, pattern));
          claims.push({
            id: nextId("blocked_pattern"),
            type: "pattern",
            description: hit
              ? `${tool}.${field} contains blocked pattern "${pattern}"`
              : `${tool}.${field} free of blocked pattern "${pattern}"`,
            status: hit ? "blocked" : "verified",
            evidence: hit ? `matched literal "${hit}"` : `no literal matched`,
            source: "spec",
          });
        }
        for (const blocked of prop.blocked_values ?? []) {
          const hit = literals.find((lit) =>
            blocked.includes("*") ? matchPattern(lit, blocked) : lit === blocked,
          );
          claims.push({
            id: nextId("blocked_value"),
            type: "pattern",
            description: hit
              ? `${tool}.${field} uses blocked value "${blocked}"`
              : `${tool}.${field} free of blocked value "${blocked}"`,
            status: hit ? "blocked" : "verified",
            evidence: hit ? `exact literal "${hit}" found` : `no literal matched`,
            source: "spec",
          });
        }
        if (prop.max_ref) {
          const [refTool] = prop.max_ref.split(".");
          const resolvable = tools.has(refTool!) || functions.has(refTool!);
          claims.push({
            id: nextId("max_ref"),
            type: "property",
            description: `${tool}.${field} bounded by ${prop.max_ref}`,
            status: resolvable ? "verified" : "unverified",
            evidence: resolvable
              ? `reference source ${refTool} present`
              : `reference source ${refTool} not statically resolvable`,
            source: "spec",
          });
        }
      }
    }
  }

  // breaker configs → policy claims (structurally verified)
  if (spec?.breakers) {
    for (const [kind, cfg] of Object.entries(spec.breakers)) {
      if (!cfg) continue;
      claims.push({
        id: nextId("breaker"),
        type: "policy",
        description: `${kind} breaker configured (${canonicalize(cfg)})`,
        status: "verified",
        evidence: `breaker present in spec`,
        source: "spec",
      });
    }
  }

  // ── Step 2 + 3: Schema-derived type-constraint claims ────────────
  if (input.schemaFiles && input.schemaFiles.length > 0) {
    for (const file of input.schemaFiles) {
      const re = /\binterface\s+([A-Za-z_$][\w$]*)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(file.content))) {
        claims.push({
          id: nextId("type"),
          type: "property",
          description: `type ${m[1]} declared and well-formed`,
          status: "verified",
          evidence: `defined in ${file.path}`,
          source: "schema",
        });
      }
    }
  }

  // ── Step 2 + 3: Heuristic tool-name analysis ─────────────────────
  const riskyActions: string[] = [];
  for (const tool of [...tools].sort()) {
    if (!isRisky(tool)) continue;
    riskyActions.push(tool);
    const t = tool.toLowerCase();
    if (t.includes("git_push") || t.includes("push")) {
      const branch = PROTECTED_BRANCHES.find((b) =>
        literals.some((lit) => lit === b || lit.split(/[\s/:]+/).includes(b)),
      );
      claims.push({
        id: nextId("risky"),
        type: "policy",
        description: branch
          ? `${tool} targets protected branch ${branch}`
          : `${tool} target branch unverified`,
        status: branch ? "blocked" : "unverified",
        evidence: branch
          ? `protected branch "${branch}" referenced in source`
          : `no protected-branch literal found; needs review`,
        source: "heuristic",
      });
    } else if (t.includes("exec") || t.includes("run_command") || t.includes("shell")) {
      const bad = DESTRUCTIVE.find((d) => literalBlob.toLowerCase().includes(d));
      claims.push({
        id: nextId("risky"),
        type: "policy",
        description: bad
          ? `${tool} may run destructive command`
          : `${tool} command surface unverified`,
        status: bad ? "blocked" : "unverified",
        evidence: bad ? `destructive token "${bad}" found` : `no destructive token found; needs review`,
        source: "heuristic",
      });
    } else {
      claims.push({
        id: nextId("risky"),
        type: "policy",
        description: `${tool} is a destructive action`,
        status: "unverified",
        evidence: `risky tool name; effect not statically verifiable`,
        source: "heuristic",
      });
    }
  }

  // ── Step 2 + 3: Context-derived heuristic claims ─────────────────
  if (input.context) {
    for (const clause of extractInvariants(input.context)) {
      claims.push({
        id: nextId("context"),
        type: "invariant",
        description: clause,
        status: "unverified",
        evidence: `derived from context; no deterministic check available`,
        source: "heuristic",
      });
    }
  }

  // ── Step 4: Build receipt ────────────────────────────────────────
  const summary = {
    verified: claims.filter((c) => c.status === "verified").length,
    failed: claims.filter((c) => c.status === "failed").length,
    unverified: claims.filter((c) => c.status === "unverified").length,
    blocked: claims.filter((c) => c.status === "blocked").length,
    needs_review: claims
      .filter((c) => c.status !== "verified")
      .map((c) => c.description),
  };

  const scope = {
    files_changed: input.changedFiles.length,
    functions_touched: functions.size,
    tools_found: tools.size,
    risky_actions: riskyActions,
  };

  const receipt: VerifyReceipt = {
    timestamp: new Date().toISOString(),
    scope,
    claims,
    summary,
    hash: "",
  };
  receipt.hash = hashReceipt(receipt);
  return receipt;
}

/** Extract "must / should / never / always" clauses from free text. */
function extractInvariants(text: string): string[] {
  const out: string[] = [];
  const sentences = text.split(/(?<=[.!?\n])\s+/);
  for (const raw of sentences) {
    const s = raw.trim().replace(/[.!?]+$/, "");
    if (!s) continue;
    if (/\b(must|should|never|always)\b/i.test(s)) {
      out.push(s.length > 80 ? s.slice(0, 77) + "…" : s);
    }
  }
  return out;
}

/** SHA-256 over the receipt's deterministic content (excludes timestamp + hash). */
function hashReceipt(receipt: VerifyReceipt): string {
  const material = canonicalize({
    scope: receipt.scope,
    claims: receipt.claims,
    summary: receipt.summary,
  });
  return createHash("sha256").update(material).digest("hex");
}

// ── Public API ─────────────────────────────────────────────────────

export async function verify(input: VerifyInput): Promise<VerifyReceipt> {
  let files: ScannedFile[];
  let changedFiles: string[];

  if (input.diff) {
    files = loadDiff(input.diff);
    changedFiles = files.map((f) => f.path);
  } else if (input.dir) {
    files = collectSourceFiles(input.dir);
    changedFiles = files.map((f) => f.path);
  } else {
    files = [];
    changedFiles = [];
  }

  let specContent: string | undefined;
  if (input.spec) {
    try {
      specContent = readFileSync(input.spec, "utf-8");
    } catch {
      specContent = undefined;
    }
  }

  const schemaFiles = input.schemaDir ? collectSourceFiles(input.schemaDir) : undefined;

  return runVerification({
    files,
    changedFiles,
    specContent,
    context: input.context,
    schemaFiles,
  });
}

// ── Terminal receipt rendering ─────────────────────────────────────

function visibleLength(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function recommend(receipt: VerifyReceipt): string {
  const { summary } = receipt;
  const unverifiedText = receipt.claims
    .filter((c) => c.status === "unverified")
    .map((c) => c.description.toLowerCase())
    .join(" ");
  if (/refund|negative amount/.test(unverifiedText)) return "review refund edge cases";
  if (summary.failed > 0) return "resolve failed invariants before merge";
  if (summary.blocked > 0) return "review blocked actions";
  if (summary.unverified > 0) return "manually review unverified areas";
  return "no action required";
}

export function formatVerifyReceipt(receipt: VerifyReceipt): string {
  const INNER = 52;
  const lines: string[] = [];
  const line = (content = ""): void => {
    const pad = Math.max(0, INNER - visibleLength(content));
    lines.push(`${C.dim("│")}  ${content}${" ".repeat(pad)}  ${C.dim("│")}`);
  };

  const s = receipt.summary;
  const risky = receipt.scope.risky_actions.length;
  line(`${C.brand()} ${C.dim("Verify")} ${C.muted("— Receipt")}`);
  line();
  line(
    C.muted(
      `Scope: ${receipt.scope.files_changed} file${
        receipt.scope.files_changed === 1 ? "" : "s"
      } · ${receipt.scope.tools_found} tool${
        receipt.scope.tools_found === 1 ? "" : "s"
      } · ${risky} risky action${risky === 1 ? "" : "s"}`,
    ),
  );
  line();
  line(`${C.green("✓")} ${C.fg(`${s.verified} claim${s.verified === 1 ? "" : "s"} verified`)}`);

  if (s.failed > 0) {
    line(`${C.red("✗")} ${C.fg(`${s.failed} claim${s.failed === 1 ? "" : "s"} failed`)}`);
    for (const c of receipt.claims.filter((c) => c.status === "failed")) {
      line(`  ${C.red("→")} ${C.muted(truncate(c.description, 46))}`);
    }
  }
  if (s.unverified > 0) {
    line(`${C.yellow("?")} ${C.fg(`${s.unverified} claim${s.unverified === 1 ? "" : "s"} unverified`)}`);
    for (const c of receipt.claims.filter((c) => c.status === "unverified")) {
      line(`  ${C.yellow("→")} ${C.muted(truncate(c.description, 46))}`);
    }
  }
  if (s.blocked > 0) {
    line(`${C.red("⛔")} ${C.fg(`${s.blocked} action${s.blocked === 1 ? "" : "s"} blocked`)}`);
    for (const c of receipt.claims.filter((c) => c.status === "blocked")) {
      line(`  ${C.red("→")} ${C.muted(truncate(c.description, 46))}`);
    }
  }
  line();
  line(`${C.muted("Recommendation:")} ${C.fg(recommend(receipt))}`);
  line(`${C.muted("Hash:")} ${C.dim(receipt.hash.slice(0, 12) + "…")}`);

  const top = `${C.dim("┌" + "─".repeat(INNER + 4) + "┐")}`;
  const bottom = `${C.dim("└" + "─".repeat(INNER + 4) + "┘")}`;
  return ["", top, ...lines, bottom, ""].join("\n");
}

// ── JSONL emission (each claim + summary event) ────────────────────

function statusToResult(status: VerifyClaim["status"]): string {
  switch (status) {
    case "verified":
      return "allowed";
    case "failed":
      return "rejected";
    case "blocked":
      return "blocked";
    default:
      return "skipped";
  }
}

export function formatVerifyJSONL(receipt: VerifyReceipt, runId = "verify"): string {
  const lines = receipt.claims.map((c) =>
    JSON.stringify({
      timestamp: receipt.timestamp,
      runId,
      tool: c.id,
      result: statusToResult(c.status),
      reason: c.type,
      details: c.description,
      params: { source: c.source, ...(c.evidence ? { evidence: c.evidence } : {}) },
    }),
  );
  lines.push(
    JSON.stringify({
      timestamp: receipt.timestamp,
      runId,
      tool: "verify:summary",
      result: receipt.summary.failed > 0 || receipt.summary.blocked > 0 ? "blocked" : "allowed",
      details: `verified=${receipt.summary.verified} failed=${receipt.summary.failed} unverified=${receipt.summary.unverified} blocked=${receipt.summary.blocked}`,
      params: { hash: receipt.hash, scope: receipt.scope },
    }),
  );
  return lines.join("\n");
}

// ── Built-in demo ──────────────────────────────────────────────────
// Runs the real deterministic pipeline over in-memory sources — no I/O,
// no external deps — and yields: 5 verified · 1 failed · 2 unverified · 1 blocked.

export function demoReceipt(): VerifyReceipt {
  const spec = `
version: "1.0"
tools:
  issue_refund:
    requires: [lookup_order]
  charge_card:
    requires: [validate_payment]
  send_receipt:
    requires: [render_template]
  update_ledger:
    requires: [charge_card]
    input:
      properties:
        note:
          blocked_patterns: ["*@competitor.com"]
          blocked_values: ["OVERRIDE"]
`;

  const source = `
export async function validate_payment(p) { return true; }
export async function render_template(t) { return t; }
export async function charge_card(p) { return { ok: true }; }
export async function update_ledger(e) { return e; }
export async function send_receipt(o) { return o; }
export async function issue_refund(o) { return o; }
export async function git_push(branch) {
  // deploy pipeline pushes to "main"
  return run("git", "push", "origin", "main");
}
`;

  return runVerification({
    files: [
      { path: "src/tools/payments.ts", content: source },
      { path: "src/tools/deploy.ts", content: `export async function git_push() { return "main"; }` },
    ],
    changedFiles: [
      "src/tools/payments.ts",
      "src/tools/deploy.ts",
      "src/tools/refund.ts",
      "src/tools/ledger.ts",
      "src/tools/receipt.ts",
      "src/index.ts",
      "agentmint.spec.yaml",
    ],
    specContent: spec,
    context:
      "Refund with negative amount must be rejected. Retry behavior under network failure should be graceful.",
  });
}
