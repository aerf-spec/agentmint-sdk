import type { ReportOptions, RunState } from "./types.js";

export function parseDuration(s: string): number {
  return parseInt(s, 10) * 86_400_000;
}

export function pct(n: number, total: number): string {
  return total === 0 ? "0%" : Math.round((n / total) * 100) + "%";
}

export class AgentMintReport {
  private runs: RunState[] = [];

  addRun(state: RunState): void {
    this.runs.push(state);
  }

  generate(options?: ReportOptions): string {
    let filtered = this.runs;
    if (options?.last) {
      const cutoff = Date.now() - parseDuration(options.last);
      filtered = this.runs.filter((r) => r.startedAt >= cutoff);
    }

    const totalRuns = filtered.length;
    const completedRuns = filtered.filter((r) => r.status === "completed").length;
    const killedRuns = filtered.filter((r) => r.status === "killed").length;
    const totalBlocked = filtered.reduce((s, r) => s + r.blockedCount, 0);
    const totalWarned = filtered.reduce((s, r) => s + r.warnedCount, 0);
    const totalHeld = filtered.reduce((s, r) => s + r.heldCount, 0);
    const totalCost = filtered.reduce((s, r) => s + r.totalCost, 0);
    const avgCost = totalRuns > 0 ? totalCost / totalRuns : 0;
    const bindViolations = filtered.reduce(
      (s, r) => s + r.events.filter((e) => e.reason === "bind_violation").length,
      0,
    );
    const denyBlocks = filtered.reduce(
      (s, r) => s + r.events.filter((e) => e.reason === "denied").length,
      0,
    );
    const requireBlocks = filtered.reduce(
      (s, r) =>
        s + r.events.filter((e) => e.reason === "prerequisite_missing").length,
      0,
    );

    if (options?.format === "json") {
      return JSON.stringify(
        {
          period: options?.last ?? "all",
          totalRuns,
          completedRuns,
          killedRuns,
          totalBlocked,
          totalWarned,
          totalHeld,
          bindViolations,
          denyBlocks,
          requireBlocks,
          totalCost: +totalCost.toFixed(2),
          avgCost: +avgCost.toFixed(2),
        },
        null,
        2,
      );
    }

    return [
      "AgentMint Production Report",
      `Period: ${options?.last ?? "all time"} · Generated ${new Date().toLocaleDateString()}`,
      "─".repeat(60),
      "",
      `RUNS              ${totalRuns} total`,
      `                  ${completedRuns} completed (${pct(completedRuns, totalRuns)})`,
      `                  ${killedRuns} killed (${pct(killedRuns, totalRuns)})`,
      "",
      `ISOLATION         ${bindViolations} bind violations blocked`,
      "",
      `ACCESS CONTROL    ${denyBlocks} denied tool calls blocked`,
      "",
      `WORKFLOW          ${requireBlocks} prerequisite violations blocked`,
      `                  ${totalHeld} checkpoint holds`,
      `                  ${totalWarned} warnings`,
      "",
      `COST              avg $${avgCost.toFixed(2)}/run`,
      `                  total $${totalCost.toFixed(2)}`,
    ].join("\n");
  }
}
