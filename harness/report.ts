// Renders a harness run as plain Markdown and as a large-type HTML page in the agentmint style.
import type { Scenario } from "./run.js";

export interface Cite { kind: string; ref: string; value: unknown; resolved: boolean }
export interface Decision {
  n: number;
  turn: number;
  question: string;
  point: string;
  decision: string;
  rule_id: string;
  rule_text: string;
  maps_to?: string[];
  uncertainty: string;
  claims: { id: string; text: string; cites: Cite[] }[];
  thinking: string;
  receipt_id: string | null;
  backend_verified: boolean;
  own_verified: boolean;
}
export type Step = { kind: "say"; who: string; at: string; text: string } | { kind: "decision"; n: number };
export interface Report {
  scenario: Scenario;
  call_id: string;
  ran_at: string;
  model: string;
  prompt_version: string;
  transcript: { who: string; at: string; text: string }[];
  timeline: Step[];
  decisions: Decision[];
  tools: { turn: number; name: string; blocked: boolean; result: unknown }[];
  checks: { label: string; ok: boolean; detail: string }[];
  passed: boolean;
  totals: { receipts: number; usd: number | null };
}

const words = (s: string) => s.replace(/_/g, " ");
const short = (v: unknown, n = 140) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};

/** One citation as a plain phrase. */
export function citeText(c: Cite): string {
  if (!c.resolved) return `${c.ref} (not found)`;
  switch (c.kind) {
    case "rule": return `Rule ${c.ref}`;
    case "tool": return `${c.ref} = ${short(c.value)}`;
    case "turn": return short(c.value);
    case "claim": return `point ${c.ref.replace(/^c/, "")}`;
    default: return `${c.ref}: ${short(c.value)}`;
  }
}

const who = (w: string) => (w === "agent" ? "Agent" : "Caller");

// ── Markdown ────────────────────────────────────────────────────────

export function renderMarkdown(r: Report): string {
  const out: string[] = [];
  out.push(`# ${r.scenario.title}`, "", r.scenario.purpose, "");
  out.push(`**Result: ${r.passed ? "PASS" : "FAIL"}**`, "");
  for (const c of r.checks) out.push(`- ${c.ok ? "✓" : "✗"} ${c.label}${c.ok ? "" : ` (${c.detail})`}`);
  out.push("");
  for (const s of r.timeline) {
    if (s.kind === "say") { out.push(`**${who(s.who)}:** ${s.text}`, ""); continue; }
    const d = r.decisions[s.n - 1]!;
    out.push(`> **Decision ${d.n}: ${words(d.decision)}**`, ">");
    out.push(`> Question: ${d.question}`, ">");
    out.push(`> Rule ${d.rule_id}: ${d.rule_text}`, ">");
    if (d.maps_to?.length) out.push(`> Maps to: ${d.maps_to.join("; ")}`, ">");
    out.push(`> Because:`);
    d.claims.forEach((c, i) => out.push(`> ${i + 1}. ${c.text}${c.cites.length ? ` _(${c.cites.map(citeText).join("; ")})_` : ""}`));
    if (d.uncertainty !== "none") out.push(">", `> Caveat: ${words(d.uncertainty)}`);
    out.push(">", `> Receipt ${d.receipt_id ?? "missing"}: ${d.own_verified ? "signed and logged ✓" : "NOT verified ✗"}`, "");
  }
  out.push("---", "", `Call ${r.call_id} · ${r.model} · prompt ${r.prompt_version} · ${r.totals.receipts} receipts${r.totals.usd == null ? "" : ` · $${r.totals.usd.toFixed(3)}`}`, "");
  return out.join("\n");
}

// ── HTML ────────────────────────────────────────────────────────────

const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function renderHtml(r: Report): string {
  const steps = r.timeline.map((s, i) => {
    if (s.kind === "say") {
      return `<div class="step say ${s.who}" data-i="${i}"><b>${who(s.who)}</b> ${esc(s.text)}</div>`;
    }
    const d = r.decisions[s.n - 1]!;
    const claims = d.claims.map((c) => `<li>${esc(c.text)}${c.cites.length ? `<div class="ev">${c.cites.map((x) => `<span class="${x.resolved ? "" : "bad"}">${esc(citeText(x))}</span>`).join("")}</div>` : ""}</li>`).join("");
    return `<section class="step decision" data-i="${i}">
  <p class="kick">Decision ${d.n}</p>
  <h3>${esc(words(d.decision))}</h3>
  <p class="q">${esc(d.question)}</p>
  <p><b>Rule ${esc(d.rule_id)}.</b> ${esc(d.rule_text)}</p>
  ${d.maps_to?.length ? `<p class="maps"><b>Maps to</b><br>${d.maps_to.map(esc).join("<br>")}</p>` : ""}
  <p><b>Because</b></p>
  <ol>${claims}</ol>
  ${d.uncertainty !== "none" ? `<p class="caveat"><b>Caveat:</b> ${esc(words(d.uncertainty))}</p>` : ""}
  ${d.thinking ? `<details><summary>Model's thinking</summary><p>${esc(d.thinking)}</p></details>` : ""}
  <p class="receipt"><span class="status ${d.own_verified ? "ok" : "bad"}">${d.own_verified ? "✓ Receipt signed and logged" : "✗ Receipt not verified"}</span>${d.receipt_id ? `<code>${esc(d.receipt_id.split("-").pop())}</code>` : ""}</p>
</section>`;
  });
  const checks = r.checks.map((c) => `<li><span class="${c.ok ? "ok" : "bad"}">${c.ok ? "✓" : "✗"}</span> ${esc(c.label)}${c.ok ? "" : ` <span class="bad">(${esc(c.detail)})</span>`}</li>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(r.scenario.title)}</title>
<style>
:root { --bg:#fcfcfb; --ink:#1c2530; --ink-2:#3c4654; --muted:#6b7280; --faint:#9aa1ab; --line:#e6e8eb; --code-bg:#f3f4f6; --card:#fff; --allow:#1a7350; --block:#b0392f;
  --font: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --bg:#14171b; --ink:#e6e9ed; --ink-2:#c3c9d1; --muted:#9aa3ae; --faint:#7b838e; --line:#2b3138; --code-bg:#1d2228; --card:#181c21; --allow:#5cc597; --block:#f08a80; color-scheme: dark; } }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin:0; background:var(--bg); color:var(--ink); font: 20px/1.6 var(--font); -webkit-font-smoothing: antialiased; overflow-wrap: anywhere; }
main { max-width: 46rem; margin: 0 auto; padding: clamp(40px, 8vw, 72px) 16px 96px; }
.note { font-size: 16px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--faint); margin: 0 0 14px; }
h1 { font-size: clamp(30px, 5vw, 36px); line-height:1.2; font-weight: 600; letter-spacing: -0.01em; margin: 0 0 10px; }
h2 { font-size: 16px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--faint); margin: 48px 0 12px; }
h3 { font-size: 24px; line-height: 1.3; font-weight: 600; margin: 4px 0 12px; }
h3::first-letter { text-transform: uppercase; }
p { margin: 8px 0; } .lead { color: var(--muted); font-size: 21px; line-height: 1.5; }
b { font-weight: 600; }
.status, .result { font-size: 16px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
.result { display: inline-block; margin: 20px 0 4px; padding: 4px 12px; border: 1px solid currentColor; border-radius: 999px; }
.ok { color: var(--allow); } .bad { color: var(--block); }
ul.checks { list-style: none; padding: 0; margin: 8px 0 0; border: 1px solid var(--line); border-radius: 8px; background: var(--card); }
ul.checks li { padding: 10px 16px; border-top: 1px solid var(--line); font-size: 18px; }
ul.checks li:first-child { border-top: 0; }
.scrub { position: sticky; top: 0; background: var(--bg); padding: 12px 0; border-bottom: 1px solid var(--line); display:flex; gap:12px; align-items:center; z-index:1; }
.scrub input { flex: 1; min-width: 0; height: 32px; font-size: 16px; accent-color: var(--ink); }
.scrub button { font: inherit; font-size: 18px; padding: 6px 14px; border:1px solid var(--line); background:var(--card); color:var(--ink); border-radius:8px; cursor:pointer; }
.scrub button:hover { border-color: var(--muted); }
#n { font: 16px var(--mono); color: var(--muted); }
.step { margin: 16px 0; } .step.hidden { display: none; } .step.current { outline: 2px solid var(--muted); outline-offset: 6px; border-radius: 8px; }
.say b { display:inline-block; min-width: 88px; font-size: 16px; letter-spacing: 0.04em; color: var(--faint); }
.say.agent { color: var(--ink-2); } .say.caller { color: var(--ink); }
.decision { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 20px 24px; margin: 20px 0; }
.kick { font-size: 16px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--faint); margin: 0; }
.q { color: var(--ink-2); } .maps { color: var(--ink-2); }
ol { list-style: none; counter-reset: why; padding: 0; margin: 8px 0; }
ol li { counter-increment: why; position: relative; padding-left: 38px; margin: 12px 0; }
ol li::before { content: counter(why); position: absolute; left: 0; top: 2px; width: 26px; height: 26px; border: 1px solid var(--line); border-radius: 50%; display: flex; align-items: center; justify-content: center; font: 16px/1 var(--mono); color: var(--muted); }
.ev span { display: block; color: var(--muted); font-size: 18px; padding-left: 14px; border-left: 2px solid var(--line); margin-top: 4px; }
.ev span.bad { color: var(--block); }
.caveat { padding: 10px 14px; background: var(--code-bg); border-radius: 8px; }
details { margin: 12px 0; } summary { cursor: pointer; color: var(--muted); font-size: 17px; } summary:hover { color: var(--ink); }
details p { background: var(--code-bg); color: var(--ink-2); padding: 12px 16px; border-radius: 8px; font-size: 18px; white-space: pre-wrap; }
.receipt { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; margin: 16px 0 0; padding-top: 14px; border-top: 1px solid var(--line); }
code { font: 16px var(--mono); font-weight: normal; letter-spacing: 0; text-transform: none; color: var(--ink-2); background: var(--code-bg); padding: 2px 8px; border-radius: 4px; }
footer { margin-top: 56px; padding-top: 22px; border-top: 1px solid var(--line); color: var(--muted); font-size: 17px; }
footer .id { font: 16px var(--mono); color: var(--ink-2); }
@media (max-width: 600px) { body { font-size: 19px; } .decision { padding: 16px; } h3 { font-size: 22px; } ol li { padding-left: 34px; } }
</style></head><body><main>
<p class="note">Harness run</p>
<h1>${esc(r.scenario.title)}</h1>
<p class="lead">${esc(r.scenario.purpose)}</p>
<p class="result ${r.passed ? "ok" : "bad"}">${r.passed ? "✓ Pass" : "✗ Fail"}</p>
<ul class="checks">${checks}</ul>
<h2>The call</h2>
<div class="scrub"><button id="prev" aria-label="Previous step">◀</button><input id="s" type="range" min="1" max="${steps.length}" value="${steps.length}" aria-label="Step"><button id="next" aria-label="Next step">▶</button><span id="n">${steps.length}/${steps.length}</span></div>
${steps.join("\n")}
<footer>Call <span class="id">${esc(r.call_id)}</span><br>${esc(r.model)} · prompt ${esc(r.prompt_version)} · ${r.totals.receipts} receipts${r.totals.usd == null ? "" : ` · $${r.totals.usd.toFixed(3)}`}<br>${esc(r.ran_at)}</footer>
</main>
<script>
const s = document.getElementById("s"), n = document.getElementById("n"), all = [...document.querySelectorAll(".step")];
function show(v) {
  v = Math.max(1, Math.min(all.length, v)); s.value = v; n.textContent = v + "/" + all.length;
  all.forEach((el, i) => { el.classList.toggle("hidden", i >= v); el.classList.toggle("current", i === v - 1 && v < all.length); });
}
s.oninput = () => show(+s.value);
document.getElementById("prev").onclick = () => show(+s.value - 1);
document.getElementById("next").onclick = () => show(+s.value + 1);
document.addEventListener("keydown", (e) => { if (e.key === "ArrowLeft") show(+s.value - 1); if (e.key === "ArrowRight") show(+s.value + 1); });
</script>
</body></html>
`;
}
