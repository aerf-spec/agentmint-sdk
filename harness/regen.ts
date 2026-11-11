// Re-render saved harness runs (live backend) with the current renderer.
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildReport } from "./run.js";
import { renderHtml, renderMarkdown } from "./report.js";
const root = join(import.meta.dirname, "runs");
const scDir = join(import.meta.dirname, "scenarios");
for (const run of readdirSync(root).filter((r) => !r.includes("local"))) {
  for (const name of readdirSync(join(root, run))) {
    const dir = join(root, run, name);
    if (!existsSync(join(dir, "events.jsonl"))) continue;
    const scFile = readdirSync(scDir).find((f) => f.startsWith(name));
    if (!scFile) continue;
    const sc = JSON.parse(readFileSync(join(scDir, scFile), "utf8"));
    const events = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const r = buildReport(sc, pkg.call_id, events, pkg);
    writeFileSync(join(dir, "report.html"), renderHtml(r));
    writeFileSync(join(dir, "report.md"), renderMarkdown(r));
    console.log(run, name, r.passed ? "PASS" : "FAIL", r.decisions.map((d) => d.own_verified ? "✓" : "✗").join(""));
  }
}
