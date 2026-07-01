import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractToolNames,
  generateSpecYaml,
  scanDir,
  runScan,
} from "./cli/scan.js";
import { loadSpec } from "./spec.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentmint-scan-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const full = join(dir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf-8");
}

describe("extractToolNames", () => {
  it("finds object-method async tools", () => {
    const names = extractToolNames(`
      const tools = {
        read_file: async (args) => ({}),
        delete_user: async function (args) { return {}; },
      };
    `);
    expect(names).toContain("read_file");
    expect(names).toContain("delete_user");
  });

  it("finds exported async functions", () => {
    const names = extractToolNames(`export async function issue_refund(args) {}`);
    expect(names).toContain("issue_refund");
  });

  it("finds name/type function tool definitions", () => {
    const names = extractToolNames(`
      const t = { type: "function", name: "search_web", parameters: {} };
    `);
    expect(names).toContain("search_web");
  });
});

describe("generateSpecYaml heuristics", () => {
  it("blocks destructive tools", () => {
    const yaml = generateSpecYaml(["delete_account"]);
    const spec = loadSpec(yaml);
    expect(spec.tools?.delete_account?.action).toBe("block");
  });

  it("gives read-only tools no rules", () => {
    const yaml = generateSpecYaml(["read_file"]);
    const spec = loadSpec(yaml);
    expect(spec.tools?.read_file?.action).toBeUndefined();
    expect(spec.tools?.read_file?.requires).toBeUndefined();
  });

  it("blocks destructive shell patterns", () => {
    const yaml = generateSpecYaml(["run_command"]);
    const spec = loadSpec(yaml);
    const cmd = spec.tools?.run_command?.input?.properties?.command;
    expect(cmd?.blocked_patterns).toContain("rm -rf");
    expect(cmd?.action).toBe("block");
  });

  it("blocks protected deploy targets", () => {
    const yaml = generateSpecYaml(["git_push"]);
    const spec = loadSpec(yaml);
    const branch = spec.tools?.git_push?.input?.properties?.branch;
    expect(branch?.blocked_values).toContain("main");
  });

  it("always includes default breakers", () => {
    const spec = loadSpec(generateSpecYaml([]));
    expect(spec.breakers?.loop?.max_identical_calls).toBe(5);
    expect(spec.breakers?.velocity?.max_calls_per_window).toBe(15);
    expect(spec.breakers?.velocity?.window_seconds).toBe(30);
  });

  it("empty tool list → minimal spec (version + breakers)", () => {
    const spec = loadSpec(generateSpecYaml([]));
    expect(spec.version).toBe("1.0");
    expect(spec.tools).toBeUndefined();
    expect(spec.breakers).toBeDefined();
  });

  it("output always parses with loadSpec", () => {
    const yaml = generateSpecYaml([
      "delete_x",
      "read_x",
      "run_x",
      "git_push",
      "send_x",
      "update_x",
      "mystery",
    ]);
    expect(() => loadSpec(yaml)).not.toThrow();
  });
});

describe("scanDir", () => {
  it("generates a spec for async tool functions found on disk", () => {
    write(
      "tools.ts",
      `export const tools = { delete_row: async (a) => ({}), read_row: async (a) => ({}) };`,
    );
    const spec = loadSpec(scanDir(dir));
    expect(spec.tools?.delete_row?.action).toBe("block");
    expect(spec.tools?.read_row).toBeDefined();
  });

  it("scans nested directories", () => {
    write("a/b/deep.ts", `export async function purge_all(a) {}`);
    const spec = loadSpec(scanDir(dir));
    expect(spec.tools?.purge_all?.action).toBe("block");
  });

  it("ignores non-ts/js files", () => {
    write("notes.md", `read_file: async () => {}`);
    write("data.json", `{"remove_thing": "async ("}`);
    const spec = loadSpec(scanDir(dir));
    expect(spec.tools).toBeUndefined();
  });

  it("empty dir → minimal spec", () => {
    const spec = loadSpec(scanDir(dir));
    expect(spec.tools).toBeUndefined();
    expect(spec.breakers).toBeDefined();
  });
});

describe("runScan --out", () => {
  const savedArgv = process.argv;
  afterEach(() => {
    process.argv = savedArgv;
    process.exitCode = 0;
  });

  it("writes the spec to a file", async () => {
    write("tools.ts", `export async function delete_all(a) {}`);
    const out = join(dir, "agentmint.spec.yaml");
    process.argv = ["node", "entry", "scan", "--dir", dir, "--out", out];
    await runScan();
    const spec = loadSpec(readFileSync(out, "utf-8"));
    expect(spec.tools?.delete_all?.action).toBe("block");
  });
});
