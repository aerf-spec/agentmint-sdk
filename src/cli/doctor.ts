// agentmint doctor. A ten second smoke check for a trial.
//
// It answers one question: is it even working. It checks your Node version,
// confirms harden() wraps every supported tool shape on this install, records a
// receipt through a wrapped call, and explains the three modes in one sentence
// each. Pass --tools ./path to also detect the shape of your own tools export.
import { harden } from "../experimental/harden.js";
import { brand, dim, fg, green, muted, red, yellow } from "./color.js";

type Shape = "raw" | "vercel" | "openai" | "anthropic" | "langchain" | "unknown";

/**
 * Name the tool shape the way harden() dispatches on it. Kept in step with the
 * dispatch in harden.ts, so doctor reports the same routing your real call gets.
 */
function detectShape(tools: unknown): Shape {
  if (Array.isArray(tools)) {
    const first = tools[0] as Record<string, unknown> | undefined;
    if (!first || typeof first !== "object") return "unknown";
    if (typeof (first.function as Record<string, unknown>)?.name === "string") return "openai";
    if (typeof first.name === "string" && "input_schema" in first && typeof first.execute === "function") {
      return "anthropic";
    }
    if (typeof first.name === "string" && typeof first._call === "function") return "langchain";
    return "unknown";
  }
  if (tools && typeof tools === "object") {
    const first = Object.values(tools as Record<string, unknown>)[0];
    if (first && typeof first === "object" && first !== null && "execute" in (first as object)) return "vercel";
    return "raw";
  }
  return "unknown";
}

/** One representative tool per shape, the minimum harden() needs to route it. */
const SAMPLES: { shape: Shape; label: string; tools: unknown }[] = [
  { shape: "raw", label: "raw functions", tools: { lookup_auth: async () => ({ ok: true }) } },
  { shape: "vercel", label: "Vercel AI SDK", tools: { lookup_auth: { execute: async () => ({ ok: true }) } } },
  { shape: "openai", label: "OpenAI", tools: [{ function: { name: "lookup_auth" }, execute: async () => ({ ok: true }) }] },
  { shape: "anthropic", label: "Anthropic", tools: [{ name: "lookup_auth", input_schema: {}, execute: async () => ({ ok: true }) }] },
  { shape: "langchain", label: "LangChain", tools: [{ name: "lookup_auth", _call: async () => ({ ok: true }) }] },
];

function nodeMajor(): number {
  return Number(process.versions.node.split(".")[0] ?? "0");
}

export async function runDoctor(): Promise<void> {
  const args = process.argv.slice(3);
  const toolsPath = args.includes("--tools") ? args[args.indexOf("--tools") + 1] : undefined;

  console.log("");
  console.log(`  ${brand()}  ${dim("doctor")}`);
  console.log(`  ${muted("A ten second check that instrumentation works on this machine.")}`);
  console.log("");

  let failures = 0;

  // 1. Node version.
  const major = nodeMajor();
  if (major >= 18) {
    console.log(`  ${green("✓")} ${fg(`Node ${process.versions.node}`)} ${muted("meets the minimum of 18.")}`);
  } else {
    failures++;
    console.log(`  ${red("✗")} ${fg(`Node ${process.versions.node}`)} ${muted("is below the minimum of 18. Upgrade Node.")}`);
  }
  console.log("");

  // 2. Every supported tool shape wraps and records.
  console.log(`  ${muted("Tool shapes harden() can wrap:")}`);
  for (const sample of SAMPLES) {
    const detected = detectShape(sample.tools);
    let ok = detected === sample.shape;
    try {
      const wrapped = harden(sample.tools as Record<string, unknown>, { mode: "shadow" });
      if (typeof (wrapped as { __receipt?: unknown }).__receipt !== "function") ok = false;
    } catch {
      ok = false;
    }
    if (ok) {
      console.log(`    ${green("✓")} ${fg(sample.label.padEnd(16))} ${muted("detected and wrapped.")}`);
    } else {
      failures++;
      console.log(`    ${red("✗")} ${fg(sample.label.padEnd(16))} ${muted(`not wrapped correctly (detected ${detected}).`)}`);
    }
  }
  console.log("");

  // 3. A wrapped call actually records a receipt.
  try {
    const tools = harden(
      { lookup_auth: async (_p: { patient_id: string }) => ({ authorized_amount: 40 }) },
      { mode: "shadow" },
    );
    const result = await tools.lookup_auth({ patient_id: "PT-4821" });
    const recorded = tools.__log().length;
    const unchanged = (result as { authorized_amount?: number })?.authorized_amount === 40;
    if (recorded === 1 && unchanged) {
      console.log(`  ${green("✓")} ${fg("A wrapped call recorded one receipt and returned its normal result.")}`);
    } else {
      failures++;
      console.log(`  ${red("✗")} ${fg("A wrapped call did not record as expected.")} ${muted(`(recorded ${recorded})`)}`);
    }
  } catch (e) {
    failures++;
    console.log(`  ${red("✗")} ${fg("A wrapped call threw.")} ${muted(String(e))}`);
  }
  console.log("");

  // 4. Optional: detect the shape of the caller's own tools export.
  if (toolsPath) {
    try {
      const mod = (await import(toolsPath)) as Record<string, unknown>;
      const candidate = mod.default ?? mod.tools ?? mod;
      const detected = detectShape(candidate);
      if (detected === "unknown") {
        console.log(`  ${yellow("⚠")} ${fg(toolsPath)} ${muted("loaded, but its shape was not recognized. Export your tools as the default.")}`);
      } else {
        console.log(`  ${green("✓")} ${fg(toolsPath)} ${muted(`looks like ${detected} tools. harden() will wrap it.`)}`);
      }
    } catch (e) {
      console.log(`  ${yellow("⚠")} ${muted(`Could not load ${toolsPath}: ${String(e)}`)}`);
    }
    console.log("");
  }

  // 5. The three modes, one sentence each.
  console.log(`  ${muted("Which mode is active is set by how you call harden():")}`);
  console.log(`    ${fg("shadow")}  ${muted("harden(tools, { mode: \"shadow\" }) records every call and blocks nothing.")}`);
  console.log(`    ${fg("gate")}    ${muted("A checkpoint or requires_approval rule holds a high risk action for a human.")}`);
  console.log(`    ${fg("signed")}  ${muted("harden(tools, { signing }) signs and chains each receipt so a buyer can verify it.")}`);
  console.log("");

  if (failures === 0) {
    console.log(`  ${green("PASS")} ${muted("Instrumentation works here. Next: read TRY-IT.md for the half-day trial.")}`);
  } else {
    console.log(`  ${red("FAIL")} ${muted(`${failures} check(s) failed above. Fix those, then rerun agentmint doctor.`)}`);
    process.exitCode = 1;
  }
  console.log("");
}
