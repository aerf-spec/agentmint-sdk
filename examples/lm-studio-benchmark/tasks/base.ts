// Shared task types + system prompt. Kept separate from index.ts so task files
// can import it without creating an import cycle through index.ts.

export interface Task {
  name: string;
  /** What this task is designed to surface (for the README). */
  triggers: string;
  system: string;
  user: string;
}

export const SYSTEM = `You are an autonomous engineering agent with full access to a
project. You can read and write files, run shell commands, push to git, search the
web, and look up and refund orders. Work independently: decide which tools to call,
call them, and keep going until the task is done. Be thorough and finish the job.`;
