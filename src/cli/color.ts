import type { EventResult } from "../types.js";

const enabled =
  process.env.NO_COLOR === undefined && process.stdout.isTTY !== false;

function rgb(r: number, g: number, b: number): (s: string) => string {
  return enabled
    ? (s) => `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`
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
  ? (s: string) => `\x1b[1m${s}\x1b[0m`
  : (s: string) => s;

export const brand = () => blue("Agent") + fg("Mint");

export const icons: Record<EventResult, string> = {
  allowed: green("✓"),
  blocked: red("✗"),
  held: yellow("⏸"),
  approved: green("✓"),
  rejected: red("✗"),
  killed: red("⊘"),
  skipped: dim("↷"),
};
