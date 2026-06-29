import { harden } from "../harden.js";
import type { AgentMintConfig } from "../types.js";
import { blue, bold, brand, dim, fg, green, icons, muted, red, yellow } from "./color.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runDemo() {
  const w = 52;
  console.log("");
  console.log(`  ${blue(`┌${"─".repeat(w)}┐`)}`);
  console.log(
    `  ${blue("│")}${" ".repeat(Math.floor((w - 38) / 2))}${brand()} ${fg("Demo — Prior Authorization")}${" ".repeat(Math.ceil((w - 38) / 2))}${blue("│")}`,
  );
  console.log(`  ${blue("│")}${" ".repeat(w)}${blue("│")}`);
  console.log(
    `  ${blue("│")}  ${muted("Patient:")} ${fg("PT-4827")}  ${muted("·")}  ${muted("Plan:")} ${fg("AETNA-PPO")}${" ".repeat(w - 42)}${blue("│")}`,
  );
  console.log(`  ${blue(`└${"─".repeat(w)}┘`)}`);
  console.log("");

  const mockTools: Record<
    string,
    (p: Record<string, unknown>) => Promise<unknown>
  > = {
    check_eligibility: async (p) => ({ eligible: true, plan: p.plan_id }),
    read_patient_demographics: async () => ({
      name: "Jane Doe",
      dob: "1985-03-14",
    }),
    read_patient_imaging: async () => ({
      studies: ["MRI lumbar 2026-01", "X-ray 2025-11"],
    }),
    read_patient_record: async () => ({ chart: "full chart data" }),
    read_patient_sud_records: async () => ({ data: "substance use records" }),
    read_insurance_benefits: async () => ({
      plan: "Aetna PPO",
      auth_required: true,
    }),
    match_criteria: async () => ({ met: 4, required: 4, result: "criteria_met" }),
    generate_rationale: async () => ({
      text: "Patient meets all criteria...",
      words: 312,
    }),
    submit_determination: async () => ({
      status: "submitted",
      ref: "AUTH-2026-44821",
    }),
    delete_patient_record: async () => ({ deleted: true }),
  };

  const config: AgentMintConfig = {
    bind: { patient_id: "PT-4827", plan_id: "AETNA-PPO" },
    allow: [
      "check_eligibility",
      "read_patient_demographics",
      "read_patient_imaging",
      "read_insurance_benefits",
      "match_criteria",
      "generate_rationale",
      "submit_determination",
    ],
    deny: ["delete_*", "read_patient_sud_*"],
    require: ["check_eligibility", "match_criteria"],
    checkpoint: ["submit_determination"],
    budget: 5.0,
    timeout: 60,
    retryLimit: 3,
    silent: true,
    onCheckpoint: async () => {
      console.log(`    ${yellow("⏸")}  ${muted("Waiting for physician approval...")}`);
      await sleep(500);
      console.log(`    ${green("✓")}  ${muted("Approved by dr.smith@ochsner.org")}`);
      return true;
    },
    costEstimator: () => 0.28,
  };

  const tools = harden(mockTools, config) as Record<string, (params: Record<string, unknown>) => Promise<unknown>> & {
    __receipt: () => string;
    __state: () => { executedCount: number; blockedCount: number; heldCount: number };
  };

  const calls: Array<[string, Record<string, unknown>]> = [
    ["check_eligibility", { plan_id: "AETNA-PPO" }],
    ["read_patient_demographics", { patient_id: "PT-4827" }],
    ["read_patient_imaging", { patient_id: "PT-4827" }],
    ["read_insurance_benefits", { plan_id: "AETNA-PPO" }],
    ["read_patient_record", { patient_id: "PT-9914" }],
    ["read_patient_sud_records", { patient_id: "PT-4827" }],
    ["match_criteria", { patient_id: "PT-4827" }],
    ["generate_rationale", { patient_id: "PT-4827" }],
    ["submit_determination", { patient_id: "PT-4827", determination: "approve" }],
  ];

  for (const [name, params] of calls) {
    const result = await tools[name]!(params);
    if (result && typeof result === "object" && "error" in result) {
      const br = result as { error: boolean; message: string };
      console.log(`  ${icons.blocked} ${red(name)}  ${red(bold("BLOCKED"))}`);
      console.log(`    ${dim("↳")} ${muted(br.message)}`);
    } else {
      const boundDisplay = Object.entries(params)
        .filter(([key]) => config.bind?.[key] !== undefined)
        .map(([, value]) => muted(String(value)))
        .join(muted(" · "));
      console.log(
        `  ${icons.allowed} ${fg(name)}${boundDisplay ? `  ${boundDisplay}` : ""}  ${dim("0.28s")}`,
      );
    }
    await sleep(200);
  }

  console.log("");
  console.log(tools.__receipt());
  console.log(`  ${dim("─".repeat(52))}`);
  console.log("");
  console.log(`  ${muted("What just happened:")}`);

  const state = tools.__state();
  console.log(`    ${green("✓")} ${fg(String(state.executedCount))} tools executed`);
  console.log(
    `    ${red("✗")} ${fg(String(state.blockedCount))} calls blocked ${dim("(1 bind violation, 1 denied)")}`,
  );
  console.log(`    ${yellow("⏸")} ${fg(String(state.heldCount))} checkpoint held and approved`);
  console.log("");
  console.log(`  ${muted("Next steps:")}`);
  console.log(`    ${dim("$")} npm install agentmint`);
  console.log(`    ${dim("$")} ${fg("const tools = harden(myTools, config)")}`);
  console.log(`    ${dim("$")} agentmint help`);
  console.log("");
  console.log(`  ${dim(`${brand()} v0.1.0`)}`);
  console.log("");
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("/demo.ts") || process.argv[1].endsWith("/demo.js"));

if (isMain) {
  runDemo();
}
