import type { EventResult } from "../types.js";

const enabled =
  process.env.NO_COLOR === undefined && process.stdout.isTTY !== false;
const RESET = "\x1b[0m";

function wrap(open: string, input: string): string {
  return `${open}${input.replace(/\x1b\[0m/g, `${RESET}${open}`)}${RESET}`;
}

function rgb(r: number, g: number, b: number): (s: string) => string {
  return enabled
    ? (s) => wrap(`\x1b[38;2;${r};${g};${b}m`, s)
    : (s) => s;
}

export const blue = rgb(59, 130, 246);
export const green = rgb(16, 185, 129);
export const red = rgb(239, 68, 68);
export const yellow = rgb(251, 191, 36);
export const dim = rgb(100, 116, 139);
export const muted = rgb(148, 163, 184);
export const fg = rgb(226, 232, 240);

export const bold = enabled
  ? (s: string) => wrap("\x1b[1m", s)
  : (s: string) => s;

export const brand = () => blue("Agent") + fg("Mint");

export const icons: Record<EventResult, string> = {
  allowed: green("✓"),
  warned: yellow("⚠"),
  blocked: red("✗"),
  held: yellow("⏸"),
  approved: green("✓"),
  rejected: red("✗"),
  killed: red("⊘"),
  skipped: dim("↷"),
  attempted_after_kill: red("⊘"),
};
