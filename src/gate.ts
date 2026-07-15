import { createHash, randomBytes } from "node:crypto";
import * as readline from "node:readline";
import type { Readable } from "node:stream";
import { bold, brand, dim, green, muted, red } from "./cli/color.js";

// ── Types ──────────────────────────────────────────────────────────

export interface GateOptions {
  action: string;
  context: Record<string, unknown>;
  channel?: "console" | "slack" | "webhook";
  /** Seconds before the request auto-denies. Default 300. */
  ttl?: number;
  /** Webhook URL for the "slack" or "webhook" channel. */
  webhookUrl?: string;
  /** Test/embedding hook: read the console response from here instead of stdin. */
  input?: Readable;
  /** Test/embedding hook: write the console prompt here instead of stdout. */
  output?: NodeJS.WritableStream;
}

export interface GateResult {
  approved: boolean;
  approver?: string;
  reason?: string;
  timestamp: number;
  duration_ms: number;
  action: string;
  context: Record<string, unknown>;
  /** SHA-256 hash of this decision, chained to the previous gate call. */
  hash: string;
}

// ── Hash chain (in-memory, per process) ────────────────────────────

const hashChain: string[] = [];

function chainHash(payload: unknown): string {
  const prev = hashChain[hashChain.length - 1] ?? "";
  const hash = createHash("sha256")
    .update(prev + JSON.stringify(payload))
    .digest("hex");
  hashChain.push(hash);
  return hash;
}

// ── Console channel ─────────────────────────────────────────────────

function formatCountdown(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Visible width ignores ANSI color escapes (which don't occupy columns) but
// counts wide glyphs like emoji as two columns so borders line up.
function visibleWidth(s: string): number {
  const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
  let w = 0;
  for (const ch of plain) w += /\p{Extended_Pictographic}/u.test(ch) ? 2 : 1;
  return w;
}

function renderBox(options: GateOptions): string {
  const width = 54;
  const line = (s = "") =>
    `│  ${s}${" ".repeat(Math.max(0, width - visibleWidth(s)))}│`;
  const rule = (l: string, r: string) => `${l}${"─".repeat(width + 2)}${r}`;

  const rows: string[] = [];
  rows.push(rule("┌", "┐"));
  rows.push(line(`🔒 ${brand()}  Approval Required`));
  rows.push(line());
  rows.push(line(`Action:  ${bold(options.action)}`));
  rows.push(line("Context:"));
  for (const [k, v] of Object.entries(options.context)) {
    rows.push(line(`  ${muted(k)}: ${String(v)}`));
  }
  rows.push(line());
  rows.push(line(dim(`Auto-deny in ${formatCountdown(options.ttl ?? 300)}`)));
  rows.push(line());
  rows.push(line(`${green("[y]")} Approve  ${red("[n/reason]")} Reject`));
  rows.push(rule("└", "┘"));
  return rows.join("\n");
}

interface ConsoleResponse {
  approved: boolean;
  reason?: string;
  timedOut: boolean;
}

function readConsole(ttlMs: number, input: Readable): Promise<ConsoleResponse> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, terminal: false });
    let settled = false;

    const finish = (res: ConsoleResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      // Release stdin so the process can exit after a CLI gate resolves.
      if (input === process.stdin) process.stdin.pause();
      resolve(res);
    };

    const timer = setTimeout(
      () => finish({ approved: false, reason: "timeout", timedOut: true }),
      ttlMs,
    );

    rl.once("line", (raw) => {
      const text = raw.trim();
      const lower = text.toLowerCase();
      if (lower === "y" || lower === "yes") {
        finish({ approved: true, timedOut: false });
      } else if (lower === "n" || lower === "no" || text === "") {
        finish({ approved: false, timedOut: false });
      } else {
        finish({ approved: false, reason: text, timedOut: false });
      }
    });
  });
}

function currentUser(): string {
  return process.env.USER || process.env.USERNAME || "console";
}

async function consoleGate(
  options: GateOptions,
  note?: string,
): Promise<Omit<GateResult, "timestamp" | "duration_ms" | "hash">> {
  const out = options.output ?? process.stdout;
  out.write("\n" + renderBox(options) + "\n");
  if (note) out.write(`  ${dim(note)}\n`);
  out.write("\n");

  const ttlMs = (options.ttl ?? 300) * 1000;
  const res = await readConsole(ttlMs, options.input ?? process.stdin);

  if (res.timedOut) {
    return { approved: false, reason: "timeout", action: options.action, context: options.context };
  }
  return {
    approved: res.approved,
    approver: currentUser(),
    ...(res.reason !== undefined && { reason: res.reason }),
    action: options.action,
    context: options.context,
  };
}

// ── Slack channel ───────────────────────────────────────────────────

function slackWebhook(options: GateOptions): string {
  const url = options.webhookUrl ?? process.env.AGENTMINT_SLACK_WEBHOOK;
  if (!url) {
    throw new Error(
      "Slack channel requires AGENTMINT_SLACK_WEBHOOK environment variable or webhookUrl option.",
    );
  }
  return url;
}

function slackBlocks(options: GateOptions): unknown {
  const contextLines = Object.entries(options.context)
    .map(([k, v]) => {
      const val = typeof v === "number" ? v.toLocaleString("en-US") : String(v);
      return `*${k}:* ${val}`;
    })
    .join("\n");
  return {
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "🔒 AgentMint  Approval Required" },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Action:* \`${options.action}\`\n${contextLines}`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "✅ Approve" },
            style: "primary",
            action_id: "agentmint_approve",
          },
          {
            type: "button",
            text: { type: "plain_text", text: "❌ Reject" },
            style: "danger",
            action_id: "agentmint_reject",
          },
        ],
      },
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: "Auto-deny in 5 minutes if no response" },
        ],
      },
    ],
  };
}

async function slackGate(
  options: GateOptions,
): Promise<Omit<GateResult, "timestamp" | "duration_ms" | "hash">> {
  const url = slackWebhook(options);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(slackBlocks(options)),
    });
  } catch {
    // Network failure is non-fatal for the MVP; we still fall back to console.
  }
  // MVP: receiving Slack's interactive payload needs a public URL, so we fall
  // back to console stdin for the actual decision.
  return consoleGate(options, "Slack message sent. Approve/reject here or via Slack.");
}

// ── Webhook channel ─────────────────────────────────────────────────

async function webhookGate(
  options: GateOptions,
): Promise<Omit<GateResult, "timestamp" | "duration_ms" | "hash">> {
  if (!options.webhookUrl) {
    throw new Error("Webhook channel requires a webhookUrl option.");
  }
  const request_id = randomBytes(8).toString("hex");
  try {
    await fetch(options.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: options.action,
        context: options.context,
        request_id,
        ttl: options.ttl ?? 300,
      }),
    });
  } catch {
    // Non-fatal; fall back to console for the response.
  }
  return consoleGate(options, `Webhook notified (request ${request_id}). Approve/reject here.`);
}

// ── Entry point ─────────────────────────────────────────────────────

function normalize(
  a: GateOptions | string,
  context?: Record<string, unknown>,
  opts?: Partial<GateOptions>,
): GateOptions {
  if (typeof a === "string") {
    return { ...opts, action: a, context: context ?? {} };
  }
  return a;
}

export async function gate(options: GateOptions): Promise<GateResult>;
export async function gate(
  action: string,
  context: Record<string, unknown>,
  opts?: Partial<GateOptions>,
): Promise<GateResult>;
export async function gate(
  a: GateOptions | string,
  context?: Record<string, unknown>,
  opts?: Partial<GateOptions>,
): Promise<GateResult> {
  const options = normalize(a, context, opts);
  const start = Date.now();
  const channel = options.channel ?? "console";

  let decision: Omit<GateResult, "timestamp" | "duration_ms" | "hash">;
  switch (channel) {
    case "slack":
      decision = await slackGate(options);
      break;
    case "webhook":
      decision = await webhookGate(options);
      break;
    default:
      decision = await consoleGate(options);
      break;
  }

  const timestamp = Date.now();
  const duration_ms = timestamp - start;

  const hash = chainHash({
    action: decision.action,
    context: decision.context,
    approved: decision.approved,
    approver: decision.approver,
    reason: decision.reason,
    timestamp,
  });

  return { ...decision, timestamp, duration_ms, hash };
}
