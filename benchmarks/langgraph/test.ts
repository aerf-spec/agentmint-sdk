import { runBench, formatBenchMarkdown } from "../../src/index.ts";
import { DEMO_SPEC_YAML, createDemoTools } from "../../src/bench-scenarios.ts";
import { writeResultsFile } from "../shared.ts";

async function main(): Promise<void> {
  const report = await runBench("LangGraph", createDemoTools(), DEMO_SPEC_YAML);
  const intro = [
    "# LangGraph Governance Benchmark",
    "",
    "## Governance Matrix",
    "| Property | Framework native | AgentMint adds | AgentMint does not solve |",
    "|----------|------------------|----------------|--------------------------|",
    "| Policy enforcement | Graph orchestration only | Requires ordering and cross-ref checks at the tool boundary | Prompt quality and domain logic outside the spec |",
    "| Destructive command blocking | No native policy layer in raw tools | Pattern and branch blocking before execution | Shell-side effects outside wrapped tools |",
    "| Structured audit trail | Partial graph tracing | Structured event log for every allowed, warned, and blocked call | Human review of the trace |",
    "| Circuit breakers | None by default | Loop and velocity breakers | Semantic loops that use different tools/args |",
    "",
  ].join("\n");
  const markdown = `${intro}${formatBenchMarkdown(report)}`;
  writeResultsFile(import.meta.url, markdown);
  console.log(markdown);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
