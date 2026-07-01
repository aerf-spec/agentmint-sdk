import { gate } from "../gate.js";
import { brand, dim, fg, green, muted, red } from "./color.js";

function parseArgs(argv: string[]): {
  action?: string;
  context?: string;
  channel?: string;
  ttl?: number;
  webhookUrl?: string;
  help: boolean;
} {
  let action: string | undefined;
  let context: string | undefined;
  let channel: string | undefined;
  let ttl: number | undefined;
  let webhookUrl: string | undefined;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--action") action = argv[++i];
    else if (a === "--context") context = argv[++i];
    else if (a === "--channel") channel = argv[++i];
    else if (a === "--ttl") ttl = Number(argv[++i]);
    else if (a === "--webhook" || a === "--webhook-url") webhookUrl = argv[++i];
    else if (a === "--help" || a === "-h") help = true;
  }
  return { action, context, channel, ttl, webhookUrl, help };
}

function showHelp(): void {
  console.log("");
  console.log(`  ${brand()}  ${dim("gate")}`);
  console.log(`  ${muted("Request human approval for a high-risk action")}`);
  console.log("");
  console.log(`  ${fg("Usage:")}  agentmint gate --action ${dim("<name>")} [--context ${dim("<json>")}] [--channel ${dim("<c>")}] [--ttl ${dim("<s>")}]`);
  console.log("");
  console.log(`  ${fg("Options:")}`);
  console.log(`    ${fg("--action")}   ${muted("Name of the action requiring approval (required)")}`);
  console.log(`    ${fg("--context")}  ${muted("JSON object of context shown to the approver")}`);
  console.log(`    ${fg("--channel")}  ${muted("console (default), slack, or webhook")}`);
  console.log(`    ${fg("--ttl")}      ${muted("Seconds before auto-deny (default 300)")}`);
  console.log(`    ${fg("--webhook")}  ${muted("Webhook URL for slack/webhook channels")}`);
  console.log("");
  console.log(`  ${fg("Examples:")}`);
  console.log(`    ${dim("$")} agentmint gate --action "deploy" --context '{"env":"production"}'`);
  console.log("");
}

export async function runGate(): Promise<void> {
  const { action, context, channel, ttl, webhookUrl, help } = parseArgs(
    process.argv.slice(3),
  );

  if (help || !action) {
    showHelp();
    if (!action && !help) process.exitCode = 1;
    return;
  }

  let parsedContext: Record<string, unknown> = {};
  if (context) {
    try {
      parsedContext = JSON.parse(context) as Record<string, unknown>;
    } catch {
      console.error("");
      console.error(`  ${red("✗")} --context must be valid JSON`);
      console.error("");
      process.exitCode = 1;
      return;
    }
  }

  const result = await gate({
    action,
    context: parsedContext,
    channel: (channel as "console" | "slack" | "webhook") ?? "console",
    ...(ttl !== undefined && { ttl }),
    ...(webhookUrl !== undefined && { webhookUrl }),
  });

  console.log("");
  if (result.approved) {
    console.log(`  ${green("✓")} ${fg("Approved")} ${dim(`by ${result.approver ?? "?"}`)}`);
  } else {
    console.log(`  ${red("✗")} ${fg("Rejected")}${result.reason ? ` ${dim(`(${result.reason})`)}` : ""}`);
  }
  console.log(`  ${muted("hash")} ${dim(result.hash.slice(0, 16) + "…")}`);
  console.log("");

  if (!result.approved) process.exitCode = 1;
}
