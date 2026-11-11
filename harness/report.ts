// Renders a harness run as plain Markdown and as a plain, large-type HTML page.
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
  <h3>${esc(words(d.decision))}</h3>
  <p class="q">${esc(d.question)}</p>
  <p><b>Rule ${esc(d.rule_id)}.</b> ${esc(d.rule_text)}</p>
  ${d.maps_to?.length ? `<p class="maps"><b>Maps to</b><br>${d.maps_to.map(esc).join("<br>")}</p>` : ""}
  <p><b>Because</b></p>
  <ol>${claims}</ol>
  ${d.uncertainty !== "none" ? `<p class="caveat"><b>Caveat:</b> ${esc(words(d.uncertainty))}</p>` : ""}
  ${d.thinking ? `<details><summary>Model's thinking</summary><p>${esc(d.thinking)}</p></details>` : ""}
  <p class="receipt ${d.own_verified ? "ok" : "bad"}">${d.own_verified ? "✓ Receipt signed and logged" : "✗ Receipt not verified"}${d.receipt_id ? ` <code>${esc(d.receipt_id.split("-").pop())}</code>` : ""}</p>
</section>`;
  });
  const checks = r.checks.map((c) => `<li class="${c.ok ? "ok" : "bad"}">${c.ok ? "✓" : "✗"} ${esc(c.label)}${c.ok ? "" : ` (${esc(c.detail)})`}</li>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(r.scenario.title)}</title>
<style>
:root { --bg:#fffdf8; --fg:#1a1a1a; --mute:#555; --line:#ddd6c8; --card:#fff; --ok:#1d6b2f; --bad:#a3221b; --hl:#f3ecdc; }
@media (prefers-color-scheme: dark) { :root { --bg:#161513; --fg:#f2efe8; --mute:#b5b0a5; --line:#3a3731; --card:#1f1e1b; --ok:#7fd18f; --bad:#ff8a80; --hl:#2a2822; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font: 21px/1.6 Georgia, "Times New Roman", serif; }
main { max-width: 760px; margin: 0 auto; padding: 32px 16px 96px; }
h1 { font-size: 34px; line-height:1.2; margin: 0 0 8px; } h2 { font-size: 26px; margin: 40px 0 12px; } h3 { font-size: 24px; margin: 0 0 8px; text-transform: capitalize; }
p { margin: 8px 0; } .lead { color: var(--mute); }
.result { font-size: 28px; font-weight: bold; } .ok { color: var(--ok); } .bad { color: var(--bad); }
ul.checks { list-style: none; padding: 0; } ul.checks li { padding: 4px 0; }
.scrub { position: sticky; top: 0; background: var(--bg); padding: 12px 0; border-bottom: 1px solid var(--line); display:flex; gap:12px; align-items:center; z-index:1; }
.scrub input { flex: 1; height: 32px; } .scrub button { font: inherit; padding: 4px 14px; border:1px solid var(--line); background:var(--card); color:var(--fg); border-radius:6px; cursor:pointer; }
.step { margin: 16px 0; } .step.hidden { display: none; } .step.current { outline: 3px solid var(--fg); outline-offset: 6px; border-radius: 4px; }
.say b { display:inline-block; min-width: 88px; } .say.agent { color: var(--fg); } .say.caller { color: var(--mute); }
.decision { background: var(--card); border: 1px solid var(--line); border-left: 6px solid var(--fg); border-radius: 8px; padding: 20px 24px; }
.q { font-style: italic; } .maps { color: var(--mute); }
ol { padding-left: 28px; } ol li { margin: 10px 0; }
.ev span { display: block; color: var(--mute); padding-left: 16px; border-left: 3px solid var(--line); margin-top: 4px; }
.ev span.bad { color: var(--bad); }
details { margin: 12px 0; } summary { cursor: pointer; } details p { background: var(--hl); padding: 12px 16px; border-radius: 6px; }
.receipt { font-weight: bold; margin-top: 16px; } code { font: inherit; font-weight: normal; color: var(--mute); }
footer { margin-top: 48px; color: var(--mute); border-top: 1px solid var(--line); padding-top: 16px; }
</style></head><body><main>
<h1>${esc(r.scenario.title)}</h1>
<p class="lead">${esc(r.scenario.purpose)}</p>
<p class="result ${r.passed ? "ok" : "bad"}">${r.passed ? "✓ Pass" : "✗ Fail"}</p>
<ul class="checks">${checks}</ul>
<h2>The call</h2>
<div class="scrub"><button id="prev" aria-label="Previous step">◀</button><input id="s" type="range" min="1" max="${steps.length}" value="${steps.length}" aria-label="Step"><button id="next" aria-label="Next step">▶</button><span id="n">${steps.length}/${steps.length}</span></div>
${steps.join("\n")}
<footer>Call ${esc(r.call_id)}<br>${esc(r.model)} · prompt ${esc(r.prompt_version)} · ${r.totals.receipts} receipts${r.totals.usd == null ? "" : ` · $${r.totals.usd.toFixed(3)}`}<br>${esc(r.ran_at)}</footer>
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
