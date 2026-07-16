// Renders the receipt-viewer HTML from data the SDK produced. Pure string
// templating: no framework, no external assets, no scripts, no network calls.
//
// This is the minimal flow page: one opening line, five steps that show how a
// receipt comes to exist and what the reviewer holds at the end, then a footer.
import type { PageData } from "./build-receipt-viewer.js";

const REPO = "https://github.com/aerf-spec/agentmint-sdk";
const BUILDER = "Aniketh";
const CONTACT = "aniketh@agentmint.run";

function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderPage(data: PageData): string {
  const allowed = data.receipts[0]!; // read of the assisted patient
  const blocked = data.receipts[2]!; // attempted read of a different patient
  const blockedJson = esc(JSON.stringify(blocked.receipt, null, 2));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>How a signed receipt is created &middot; AgentMint</title>
<meta name="description" content="How an AI agent's action becomes a signed receipt, and how a reviewer checks it. Sample data.">
<meta name="robots" content="noindex">
<style>
${STYLES}
</style>
</head>
<body>
<main class="page">

  <p class="note">Sample data. No real patient information.</p>

  <p class="opening">Every action an AI agent takes gets a signed receipt, created the moment it happens, that a hospital can check without trusting the vendor's logs.</p>

  <ol class="flow">

    <li class="step">
      <p class="step__text">The vendor wraps the agent's tool calls.</p>
      <pre class="art"><code>import { harden } from "@npmsai/agentmint";
const tools = harden(myTools);</code></pre>
    </li>

    <li class="step">
      <p class="step__text">The agent acts, and each action is checked against a signed plan.</p>
      <div class="art moments">
        <div class="moment">
          <div class="moment__top"><span class="status status--allow">Allowed</span><code>${esc(allowed.step.action)}</code></div>
          <p class="moment__why">The record of the patient the agent is assisting. Inside the plan's scope, so it ran and was recorded.</p>
        </div>
        <div class="moment">
          <div class="moment__top"><span class="status status--block">Blocked</span><code>${esc(blocked.step.action)}</code></div>
          <p class="moment__why">A different patient, outside the plan's scope. The call never ran, and the block itself was recorded.</p>
        </div>
      </div>
    </li>

    <li class="step">
      <p class="step__text">Each decision becomes a signed receipt linked to the one before it.</p>
      <p class="step__sub">The blocked read, as a receipt. The signature covers the fields; the previous hash links it to the receipt before it; the sequence number fixes its place.</p>
      <pre class="art art--quiet"><code>${blockedJson}</code></pre>
    </li>

    <li class="step">
      <p class="step__text">The vendor exports one packet for the reviewer.</p>
      <ul class="art files">
        <li><code>evidence.zip</code><span>the packet the reviewer receives, containing:</span></li>
        <li class="files__in"><code>receipts/</code><span>one signed receipt per action</span></li>
        <li class="files__in"><code>plan.json</code><span>the signed plan the actions were checked against</span></li>
        <li class="files__in"><code>public_key.pem</code><span>the key that checks every signature</span></li>
        <li class="files__in"><code>verify.mjs</code><span>a standalone verifier</span></li>
      </ul>
    </li>

    <li class="step">
      <p class="step__text">The reviewer checks it on their own machine.</p>
      <pre class="art"><code>unzip evidence.zip -d packet
node packet/verify.mjs</code></pre>
      <p class="step__sub">A pass reports that every receipt checked out and the chain is intact. If any receipt changed after signing, the check fails and names the exact receipt that changed. It needs Node 18 and nothing else: no install, no network. A receipt proves what was signed, not that the action was correct. The fuller guide is <a href="${REPO}/blob/main/FOR-REVIEWERS.md">FOR-REVIEWERS.md</a>.</p>
    </li>

  </ol>

  <footer class="foot">
    ${esc(BUILDER)} &middot; <a href="mailto:${CONTACT}">${esc(CONTACT)}</a> &middot; <a href="${REPO}">${esc(REPO.replace("https://", ""))}</a>
  </footer>

</main>
</body>
</html>
`;
}

const STYLES = String.raw`
:root {
  --bg: #fcfcfb;
  --ink: #1c2530;
  --ink-2: #3c4654;
  --muted: #6b7280;
  --faint: #9aa1ab;
  --line: #e6e8eb;
  --code-bg: #f3f4f6;
  --allow: #1a7350;
  --block: #b0392f;
  --font: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}

* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--font);
  font-size: 17px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--ink); text-underline-offset: 2px; }
a:hover { text-decoration-thickness: 2px; }
code { font-family: var(--mono); font-size: 0.85em; }

.page {
  max-width: 40rem;
  margin: 0 auto;
  padding: clamp(40px, 8vw, 80px) clamp(20px, 5vw, 32px) 64px;
}

.note {
  font-size: 12px;
  letter-spacing: 0.04em;
  color: var(--faint);
  margin: 0 0 40px;
}

.opening {
  font-size: clamp(20px, 3.4vw, 25px);
  line-height: 1.4;
  color: var(--ink);
  margin: 0 0 8px;
  font-weight: 400;
}

.flow {
  list-style: none;
  counter-reset: step;
  margin: 0;
  padding: 0;
}
.step {
  counter-increment: step;
  position: relative;
  padding: 40px 0 0 0;
  border-top: 1px solid var(--line);
  margin-top: 40px;
}
.step:first-child { border-top: 0; }
.step__text {
  position: relative;
  padding-left: 34px;
  margin: 0 0 18px;
  font-size: 18px;
  color: var(--ink);
}
.step__text::before {
  content: counter(step);
  position: absolute;
  left: 0;
  top: -1px;
  width: 22px;
  height: 22px;
  border: 1px solid var(--line);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--mono);
  font-size: 12px;
  color: var(--muted);
}
.step__sub {
  padding-left: 34px;
  margin: 16px 0 0;
  font-size: 15px;
  color: var(--muted);
}
.step__sub a { color: var(--ink-2); }

/* Artifacts */
.art { margin: 0 0 0 34px; }
pre.art, .art pre {
  background: var(--code-bg);
  border-radius: 8px;
  padding: 14px 16px;
  overflow-x: auto;
  font-family: var(--mono);
  font-size: 13px;
  line-height: 1.55;
  color: var(--ink-2);
}
pre.art code { font-size: inherit; color: inherit; }
.art--quiet {
  background: transparent;
  border: 1px solid var(--line);
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
}

/* Step 2 moments */
.moments { display: grid; gap: 12px; }
.moment {
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 14px 16px;
  background: #fff;
}
.moment__top { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 6px; }
.moment__top code { color: var(--ink-2); word-break: break-all; }
.status {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.status--allow { color: var(--allow); }
.status--block { color: var(--block); }
.moment__why { margin: 0; font-size: 14.5px; color: var(--muted); }

/* Step 4 file list */
.files { list-style: none; margin: 0 0 0 34px; padding: 0; }
.files li {
  display: flex;
  gap: 12px;
  align-items: baseline;
  padding: 7px 0;
  flex-wrap: wrap;
}
.files code { color: var(--ink); }
.files span { color: var(--muted); font-size: 14.5px; }
.files__in { padding-left: 22px; }
.files__in code { color: var(--ink-2); }

.foot {
  margin-top: 56px;
  padding-top: 22px;
  border-top: 1px solid var(--line);
  color: var(--muted);
  font-size: 14px;
}
.foot a { color: var(--ink-2); }

@media (max-width: 430px) {
  body { font-size: 16px; }
  .files li { gap: 6px; }
}

@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;
