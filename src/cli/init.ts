import { existsSync, writeFileSync } from "node:fs";
import { dim, fg, green, muted, yellow } from "./color.js";

const STARTER_SPEC = `# AgentMint Spec: https://github.com/aerf-spec/agentmint-app
# Validation rules for your AI agent's tool calls.
#
# Quick start:
#   $ agentmint demo      # see example violations
#   $ agentmint watch     # validate your agent
#   $ agentmint ci        # gate CI on spec compliance

version: "1.0"

# Default action: "warn" (log + continue) or "block" (reject call)
defaults:
  action: warn

# Tool-specific rules
tools:
  # Require a lookup before any mutation
  # issue_refund:
  #   requires:
  #     - lookup_order
  #   input:
  #     properties:
  #       amount:
  #         max_ref: lookup_order.output.total
  #       order_id:
  #         cross_ref: lookup_order.input.order_id

  # Block dangerous commands
  # run_command:
  #   input:
  #     properties:
  #       command:
  #         blocked_patterns:
  #           - "rm -rf"
  #           - "DROP TABLE"
  #         action: block

  # Prevent pushes to protected branches
  # git_push:
  #   input:
  #     properties:
  #       branch:
  #         blocked_values:
  #           - main
  #           - master
  #         action: block

# Circuit breakers. Stop runaway agents.
breakers:
  loop:
    max_identical_calls: 5
    action: block
  velocity:
    max_calls_per_window: 15
    window_seconds: 30
    action: block
  # cost:
  #   max_usd: 10.00
  #   action: block
`;

const REFUND_SPEC = `version: "1.0"
defaults:
  action: warn

tools:
  issue_refund:
    requires:
      - lookup_order
    action: block
    input:
      properties:
        amount:
          max_ref: lookup_order.output.total
        order_id:
          cross_ref: lookup_order.input.order_id
  cancel_order:
    requires:
      - lookup_order
    input:
      properties:
        order_id:
          cross_ref: lookup_order.input.order_id
    action: block

breakers:
  loop:
    max_identical_calls: 3
    action: block
  velocity:
    max_calls_per_window: 10
    window_seconds: 30
    action: block
`;

const CODING_SPEC = `version: "1.0"
defaults:
  action: warn

tools:
  write_file:
    input:
      properties:
        path:
          cross_ref: read_file.input.path
  run_command:
    input:
      properties:
        command:
          blocked_patterns:
            - "rm -rf"
            - "git reset --hard"
            - "DROP TABLE"
            - "sudo"
          action: block
  git_push:
    input:
      properties:
        branch:
          blocked_values:
            - main
            - master
            - production
          action: block

breakers:
  loop:
    max_identical_calls: 5
    action: block
  velocity:
    max_calls_per_window: 15
    window_seconds: 30
    action: block
`;

const DATA_SPEC = `version: "1.0"
defaults:
  action: warn

tools:
  update_record:
    requires:
      - query_database
  delete_record:
    requires:
      - query_database
    action: block
  send_report:
    requires:
      - query_database
    input:
      properties:
        recipients:
          blocked_patterns:
            - "@external.com"
            - "@gmail.com"
          action: block

breakers:
  loop:
    max_identical_calls: 3
    action: block
  velocity:
    max_calls_per_window: 20
    window_seconds: 60
    action: block
  cost:
    max_usd: 5.00
    action: block
`;

const BUDGET_SPEC = `# Budget Guardrails. Runtime cost enforcement at the tool boundary.
# Estimates and caps are evaluated BEFORE a tool runs, so an over-budget
# call never executes. Start in shadow mode, then switch to enforce.

version: "1.1"

tools:
  search_web:
    cost:
      estimate_usd: 0.03      # what one call costs
      max_cost_usd: 0.05      # never let a single call exceed this
      action: warn
    limits:
      max_calls_per_run: 3    # stop retry loops
      action: block

  browser_screenshot:
    cost:
      estimate_usd: 0.08     # a per-call cap needs an estimate to compare against
      max_cost_usd: 0.10
      action: block
    limits:
      max_calls_per_run: 2
      action: block

breakers:
  # Hard ceiling on total estimated spend for the whole run.
  budget:
    max_total_usd: 5.00
    action: block
  # Stop an agent hammering one tool with identical args.
  loop:
    max_identical_calls: 3
    action: block
`;

const RCM_SPEC = `# AgentMint spec for a healthcare RCM prior authorization agent.
# Each rule below names the HIPAA or CMS reason it exists. The agent reads
# patient records, submits prior auths, and can raise appeals, but only a
# clinician clears an appeal and it can never bill above the authorized amount.

version: "1.0"

# Start by logging every call and letting it through. Switch to block once you
# trust the rules, so a real violation stops the call instead of only recording it.
defaults:
  action: warn

tools:
  # Read a patient record only after the authorization on file is looked up. This
  # keeps the agent inside the case it was assigned and honors HIPAA minimum necessary.
  read_patient_record:
    requires:
      - lookup_auth

  # A prior auth submission must follow the authorization lookup, and the amount
  # billed can never exceed the amount the payer authorized. This is the CMS
  # overbilling guardrail: the claim is bounded by the authorization it cites.
  submit_prior_auth:
    requires:
      - lookup_auth
    input:
      properties:
        billed_amount:
          # Bound the billed amount by the authorized amount returned from lookup_auth.
          max_ref: lookup_auth.output.authorized_amount
          action: block

  # An appeal is a coverage determination. CMS and California SB 1120 require a
  # clinician, not an algorithm, to make this call, so this tool is held for human
  # approval and the clinician's decision is recorded as a signed receipt.
  submit_appeal:
    requires_approval: true

  # Deleting a patient record is never in scope for a prior auth agent. Block it
  # outright so an off-task call is refused and the refusal is itself receipted.
  delete_patient_record:
    action: block

breakers:
  # Payers rate limit and return transient errors under load. This loop breaker
  # stops the agent from re-submitting the same prior auth over and over against
  # the payer, which burns money and can look like abuse from the payer's side.
  loop:
    max_identical_calls: 3
    action: block
`;

// Observe-only starter for the trial. Every rule is a comment, so nothing is
// enforced. Paired with harden(tools, { mode: "shadow" }), the agent records
// every call and blocks nothing. This is the safe way to start: your agent's
// behavior does not change, and removal is deleting one wrapper line.
const SHADOW_SPEC = `# AgentMint shadow spec. Observe-only, for a zero-risk trial.
#
# Nothing here blocks anything. Wrap your tools with:
#   const tools = harden(myTools, { spec: loadSpec("agentmint.spec.yaml"), mode: "shadow" });
# In shadow mode every call is recorded and nothing is blocked, so your agent
# behaves exactly as before. When you trust the rules, remove mode: "shadow" to
# start enforcing them. To stop entirely, delete the harden() wrapper line.

version: "1.0"

# warn logs a would-be violation and lets the call through. Shadow mode records
# it either way. Switch to block only once you move off shadow mode.
defaults:
  action: warn

tools:
  # Uncomment to record which patient records the agent reads.
  # read_patient_record:
  #   requires:
  #     - lookup_auth

  # Uncomment to record prior auths and flag any that bill above the authorized amount.
  # submit_prior_auth:
  #   requires:
  #     - lookup_auth
  #   input:
  #     properties:
  #       billed_amount:
  #         max_ref: lookup_auth.output.authorized_amount
  #         action: warn

# Breakers record runaway patterns without stopping the run in shadow mode.
breakers:
  loop:
    max_identical_calls: 3
    action: warn
`;

const EXAMPLES: Record<string, string> = {
  refund: REFUND_SPEC,
  coding: CODING_SPEC,
  data: DATA_SPEC,
  budget: BUDGET_SPEC,
  rcm: RCM_SPEC,
};

export async function runInit(): Promise<void> {
  const args = process.argv.slice(3);
  const force = args.includes("--force");
  // Accept --template (the RCM-era flag) and --example (the original) as aliases.
  const templateIdx = args.indexOf("--template");
  const exampleIdx = args.indexOf("--example");
  const flagIdx = templateIdx >= 0 ? templateIdx : exampleIdx;
  const example = flagIdx >= 0 ? args[flagIdx + 1] : undefined;
  const shadow = args.includes("--shadow");
  const aiFlag = args.includes("--ai");

  if (aiFlag) {
    console.log("");
    console.log(`  ${yellow("⚠")} ${fg("The --ai flag is not available yet.")}`);
    console.log(`  ${muted("For now, use")} ${fg("npx @npmsai/agentmint init")} ${muted("for a starter template.")}`);
    console.log(`  ${muted("Or")} ${fg("npx @npmsai/agentmint init --template rcm")} ${muted("for a prior auth spec.")}`);
    console.log("");
    return;
  }

  const fileName = "agentmint.spec.yaml";

  if (existsSync(fileName) && !force) {
    console.log("");
    console.log(`  ${yellow("⚠")} ${fg(fileName)} already exists. Use ${fg("--force")} to overwrite.`);
    console.log("");
    return;
  }

  const content = shadow
    ? SHADOW_SPEC
    : example && EXAMPLES[example]
      ? EXAMPLES[example]!
      : STARTER_SPEC;
  writeFileSync(fileName, content);

  const label = shadow
    ? "shadow, observe-only"
    : example && EXAMPLES[example]
      ? `${example} template`
      : "starter";

  console.log("");
  console.log(`  ${green("✓")} Created ${fg(fileName)} ${dim(`(${label})`)}`);
  console.log("");
  console.log(`  ${muted("Your spec includes:")}`);
  if (shadow) {
    console.log(`    ${dim("•")} Observe-only defaults. Nothing blocks anything.`);
    console.log(`    ${dim("•")} Commented RCM rules, ready to uncomment when you trust them.`);
    console.log(`    ${dim("•")} A loop breaker set to warn, not block.`);
  } else if (example === "rcm") {
    console.log(`    ${dim("•")} Patient record and prior auth scope rules`);
    console.log(`    ${dim("•")} Billed amount bounded by the authorized amount`);
    console.log(`    ${dim("•")} An appeal checkpoint held for a clinician`);
    console.log(`    ${dim("•")} A loop breaker on payer retries`);
  } else if (example && EXAMPLES[example]) {
    console.log(`    ${dim("•")} Tool rules with cross-ref validation`);
    console.log(`    ${dim("•")} Circuit breakers (loop + velocity)`);
  } else {
    console.log(`    ${dim("•")} Commented examples for every rule type`);
    console.log(`    ${dim("•")} Loop + velocity breakers (active)`);
    console.log(`    ${dim("•")} Uncomment tool rules to activate`);
  }
  console.log("");
  console.log(`  ${muted("Instrument your tools. This one line, plus the spec above, is the whole change:")}`);
  console.log(`    ${dim("import { harden, loadSpec } from \"@npmsai/agentmint\";")}`);
  if (shadow) {
    console.log(`    ${dim(`const tools = harden(myTools, { spec: loadSpec("${fileName}"), mode: "shadow" });`)}`);
    console.log("");
    console.log(`  ${muted("Shadow mode records every call and blocks nothing. Removal is deleting that one line.")}`);
    console.log(`  ${muted("Next: read")} ${fg("TRY-IT.md")} ${muted("for the half-day trial, or run")} ${fg("agentmint doctor")} ${muted("to confirm it works.")}`);
  } else {
    console.log(`    ${dim(`const tools = harden(myTools, { spec: loadSpec("${fileName}") });`)}`);
    console.log("");
    console.log(`  ${muted("Next: run")} ${fg("agentmint watch")} ${muted("to validate your agent against this spec, or")} ${fg("agentmint demo")} ${muted("to see it work first.")}`);
  }
  console.log("");
}
