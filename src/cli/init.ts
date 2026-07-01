import { existsSync, writeFileSync } from "node:fs";
import { dim, fg, green, muted, yellow } from "./color.js";

const STARTER_SPEC = `# AgentMint Spec — https://github.com/aerf-spec/agentmint-app
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

# Circuit breakers — stop runaway agents
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

const EXAMPLES: Record<string, string> = {
  refund: REFUND_SPEC,
  coding: CODING_SPEC,
  data: DATA_SPEC,
};

export async function runInit(): Promise<void> {
  const args = process.argv.slice(3);
  const force = args.includes("--force");
  const exampleIdx = args.indexOf("--example");
  const example = exampleIdx >= 0 ? args[exampleIdx + 1] : undefined;
  const aiFlag = args.includes("--ai");

  if (aiFlag) {
    console.log("");
    console.log(`  ${yellow("⚠")} ${fg("--ai flag coming this week.")}`);
    console.log(`  ${muted("For now, use")} ${fg("npx @npmsai/agentmint init")} ${muted("for a starter template.")}`);
    console.log(`  ${muted("Or")} ${fg("npx @npmsai/agentmint init --example refund|coding|data")}`);
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

  const content = example && EXAMPLES[example] ? EXAMPLES[example]! : STARTER_SPEC;
  writeFileSync(fileName, content);

  const label = example && EXAMPLES[example] ? `${example} example` : "starter";

  console.log("");
  console.log(`  ${green("✓")} Created ${fg(fileName)} ${dim(`(${label})`)}`);
  console.log("");
  console.log(`  ${muted("Your spec includes:")}`);
  if (example && EXAMPLES[example]) {
    console.log(`    ${dim("•")} Tool rules with cross-ref validation`);
    console.log(`    ${dim("•")} Circuit breakers (loop + velocity)`);
  } else {
    console.log(`    ${dim("•")} Commented examples for every rule type`);
    console.log(`    ${dim("•")} Loop + velocity breakers (active)`);
    console.log(`    ${dim("•")} Uncomment tool rules to activate`);
  }
  console.log("");
  console.log(`  ${muted("Next steps:")}`);
  console.log(`    ${dim("$")} agentmint demo a         ${muted("# see all three scenarios")}`);
  console.log(`    ${dim("$")} agentmint watch           ${muted("# validate against your agent")}`);
  console.log("");
}
