// IP scan: nothing this agent sends to the platform may carry its private prompt, its raw
// thinking, or the salts that open its commitments.
//
//   prompt    any run of 6 words shared with the prompt (same rule as the live worker's leak scan)
//   thinking  any run of 12 words shared with one thinking block (shorter blocks: the whole block,
//             if it has at least 5 words). Longer than the prompt window because a claim may restate
//             a fact the model also thought about; copying a 12-word stretch is a leak, not a paraphrase.
//   salt      the hex salt anywhere in the body
//   field     a key named prompt / system / thinking / reasoning_text (the platform rejects these too)
// Words are lowercased and stripped to letters and digits, so punctuation and spacing don't hide a copy.

export const PROMPT_WINDOW = 6;
export const THINKING_WINDOW = 12;
export const FORBIDDEN_FIELDS = new Set(["prompt", "system", "thinking", "reasoning_text"]);

export function words(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\S+/g)) {
    const w = m[0].toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    if (w) out.push(w);
  }
  return out;
}

/** Finds any n-word run of a secret inside other text. */
export class NgramScanner {
  private grams = new Set<string>();
  readonly n: number;
  constructor(secret: string, n: number, minWords = n) {
    const w = words(secret);
    this.n = Math.min(n, w.length);
    if (w.length < minWords || this.n === 0) return;
    for (let i = 0; i + this.n <= w.length; i++) this.grams.add(w.slice(i, i + this.n).join(" "));
  }
  get empty(): boolean {
    return this.grams.size === 0;
  }
  /** First matching run in `text`, or null. */
  find(text: string): string | null {
    if (this.empty) return null;
    const w = words(text);
    for (let i = 0; i + this.n <= w.length; i++) {
      const g = w.slice(i, i + this.n).join(" ");
      if (this.grams.has(g)) return g;
    }
    return null;
  }
  /** Scans each string in a JSON value, then all of them joined (catches a copy split across fields). */
  findIn(value: unknown): string | null {
    const all = strings(value);
    for (const s of all) { const f = this.find(s); if (f) return f; }
    return all.length > 1 ? this.find(all.join(" ")) : null;
  }
}

function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, out));
  return out;
}

function keys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => keys(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); keys(x, out); }
  return out;
}

export interface IpFinding {
  /** Index of the request body (order sent). */
  body: number;
  what: "prompt" | "thinking" | "salt" | "field";
  /** A short hint of what matched (first words only, so the report does not repeat the leak). */
  hint: string;
}

export interface Secrets {
  prompt: string;
  thinking: string[];
  salts: string[];
}

const hint = (gram: string) => {
  const w = gram.split(" ");
  return w.slice(0, 3).join(" ") + (w.length > 3 ? " …" : "");
};

export class IpScanner {
  private prompt: NgramScanner;
  private thinking: NgramScanner[] = [];
  private salts: string[] = [];
  constructor(secrets: Secrets) {
    this.prompt = new NgramScanner(secrets.prompt, PROMPT_WINDOW);
    for (const t of secrets.thinking) this.addThinking(t);
    for (const s of secrets.salts) this.addSalt(s);
  }
  addThinking(t: string): void {
    const s = new NgramScanner(t, THINKING_WINDOW, 5);
    if (!s.empty) this.thinking.push(s);
  }
  addSalt(s: string): void {
    if (s) this.salts.push(s.toLowerCase());
  }
  /** Text-level check for one string: does it copy the prompt or a thinking block? */
  leaks(text: string): boolean {
    return this.prompt.find(text) !== null || this.thinking.some((s) => s.find(text) !== null);
  }
  /** Every finding in one request body (a JSON string, or any string). */
  scanBody(body: string, index = 0): IpFinding[] {
    const out: IpFinding[] = [];
    let value: unknown = body;
    try { value = JSON.parse(body); } catch { /* scan as text */ }
    const p = this.prompt.findIn(value);
    if (p) out.push({ body: index, what: "prompt", hint: hint(p) });
    for (const s of this.thinking) {
      const t = s.findIn(value);
      if (t) { out.push({ body: index, what: "thinking", hint: hint(t) }); break; }
    }
    const lower = body.toLowerCase();
    for (const s of this.salts) if (lower.includes(s)) { out.push({ body: index, what: "salt", hint: s.slice(0, 8) + "…" }); break; }
    for (const k of keys(value)) if (FORBIDDEN_FIELDS.has(k)) out.push({ body: index, what: "field", hint: k });
    return out;
  }
  scanAll(bodies: string[]): IpFinding[] {
    return bodies.flatMap((b, i) => this.scanBody(b, i));
  }
}
