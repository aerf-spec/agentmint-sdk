// Reach for this example if you are an engineer wrapping tools built on the
// Vercel AI SDK generateText tool loop, and you want to see the bridge from a
// spec gate to the SDK's tool-approval flow.
//
// Prior-auth agent on the Vercel AI SDK, guarded by AgentMint.
//
//   npx tsx run.ts            # MockLanguageModelV3, no API key (default)
//   echo y | npx tsx run.ts   # auto-approve the prior auth at the console gate
//   npx tsx run.ts --live     # a real model via the AI SDK Gateway
//
// The agent looks an authorization up, submits a prior auth (which requires
// human approval through AgentMint's gate()), and notifies the payer. Every
// tool call becomes a line in a signed JSONL receipt. A final verify() pass
// prints a verification receipt over the guardrail spec.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { generateText, stepCountIs } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModel, LanguageModelV3Usage } from "@ai-sdk/provider";
import { withAgentMint } from "../../src/experimental/vercel/index.ts";
import { verify, formatVerifyReceipt } from "../../src/index.ts";
import { tools } from "./tools.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC = join(HERE, "agentmint.spec.yaml");
const live = process.argv.includes("--live");

const usage = (): LanguageModelV3Usage => ({
  inputTokens: { total: 120, noCache: 120, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 24, text: 24, reasoning: 0 },
});

// A scripted three-step tool loop so the demo runs with no API key. On --live a
// real model plans the same task through the AI Gateway (set AI_GATEWAY_API_KEY).
const mockModel = new MockLanguageModelV3({
  modelId: "mock-prior-auth-agent",
  provider: "mock.gateway",
  doGenerate: [
    {
      content: [{
        type: "tool-call",
        toolCallId: "call_lookup",
        toolName: "lookup_auth",
        input: JSON.stringify({ auth_id: "PA-2210" }),
      }],
      finishReason: { unified: "tool-calls", raw: "tool_calls" },
      usage: usage(),
      warnings: [],
    },
    {
      content: [{
        type: "tool-call",
        toolCallId: "call_submit",
        toolName: "submit_prior_auth",
        input: JSON.stringify({ auth_id: "PA-2210", billed_amount: 42.5 }),
      }],
      finishReason: { unified: "tool-calls", raw: "tool_calls" },
      usage: usage(),
      warnings: [],
    },
    {
      content: [{
        type: "tool-call",
        toolCallId: "call_notify",
        toolName: "notify_payer",
        input: JSON.stringify({
          to: "aetna@example.com",
          body: "The prior auth for $42.50 has been submitted.",
        }),
      }],
      finishReason: { unified: "tool-calls", raw: "tool_calls" },
      usage: usage(),
      warnings: [],
    },
    {
      content: [{ type: "text", text: "All done. Prior auth submitted and the payer notified." }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: usage(),
      warnings: [],
    },
  ],
});

async function main(): Promise<void> {
  const model: LanguageModel = live ? "openai/gpt-4.1-mini" : mockModel;

  const am = withAgentMint({ spec: SPEC, mode: "enforce" });

  console.log(`\n  Prior-auth agent. Model: ${live ? "openai/gpt-4.1-mini (live)" : "mock"}`);
  console.log("  When the agent tries to submit the prior auth, AgentMint's gate");
  console.log("  will ask you to approve it (type y / n at the prompt).\n");

  const result = await generateText({
    model,
    tools: am.tools(tools),
    // Spec-driven approval: submit_prior_auth is `requires_approval: true`, so
    // the gate fires only for it. All decisions land on the receipt.
    toolApproval: am.toolApproval("spec"),
    onStepFinish: am.onStepFinish,
    stopWhen: stepCountIs(6),
    prompt:
      "Submit the prior auth PA-2210 in full and notify the payer to confirm.",
  });

  console.log(`\n  Model said: ${result.text}\n`);
  console.log(am.formatReceipt());

  const receiptPath = join(HERE, "receipts", "run.jsonl");
  am.writeJSONL(receiptPath);
  console.log(`\n  Receipt written to ${receiptPath}`);

  console.log("\n  Step metadata captured from the AI SDK:");
  for (const step of am.steps()) {
    console.log(
      `    step ${step.stepNumber}: ${step.model?.modelId} · ${step.finishReason} · ` +
        `${step.usage?.totalTokens ?? "?"} tokens`,
    );
  }

  // Independent verification of the guardrail spec against the tool source.
  const verification = await verify({ dir: HERE, spec: SPEC });
  console.log(formatVerifyReceipt(verification));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
