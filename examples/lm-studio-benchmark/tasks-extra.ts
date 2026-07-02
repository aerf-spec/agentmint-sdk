// tasks-extra.ts — two tasks the existing suite lacks.
// context-bloat is FOR the thesis (repeated reads of the same large files).
// linear-control is AGAINST it (no repeats; shaping should save ~nothing and
// must not hurt success). The control is the task a skeptic trusts most.

import { SYSTEM, type Task } from "./tasks/base.ts";

export const contextBloat: Task = {
  name: "context-bloat",
  triggers: "repeated reads of the same large files (dedup should fire)",
  system: SYSTEM,
  user: `Audit how the discount calculation works across this repo. Read
src/pricing.ts, src/discounts.ts, and src/cart.ts. Cross-check every place a
discount is applied in src/cart.ts and src/discounts.ts against the rules in
src/pricing.ts — re-read a file whenever you need to confirm a detail rather
than working from memory, accuracy matters more than speed. Then write a
summary of any inconsistencies to docs/audit.md and fix the worst one in
src/discounts.ts. Run the test suite when you're done.`,
};

export const linearControl: Task = {
  name: "linear-control",
  triggers: "control: no natural repeats — shaping should save ~nothing",
  system: SYSTEM,
  user: `Create a new file src/greeting.ts that exports a function
greet(name: string) which returns "Hello, <name>!". Then run the test suite
once and report the result. Keep it minimal: do not read other files unless a
test fails.`,
};

export const EXTRA_TASKS: Task[] = [contextBloat, linearControl];
