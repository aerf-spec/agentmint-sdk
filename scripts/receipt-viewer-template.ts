// Renders the receipt-viewer HTML from data the SDK produced. Pure string
// templating: no framework, no external assets, no network calls at runtime.
// The page uses only system fonts, which keeps it self-contained and mirrors
// the property it is describing, a record that does not call anywhere to be read.
import type { PageData, ReceiptView } from "./build-receipt-viewer.js";

const REPO = "https://github.com/aerf-spec/agentmint-sdk";
const BUILDER = "Aniketh";
const CONTACT = "anikethcov@gmail.com";
const PAYER = "Northgate Health Plan";

function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** "2026-01-15T09:00:01.000000+00:00" -> "2026-01-15 09:00:01 UTC" */
function fmtTime(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]} UTC` : iso;
}

function receiptJson(v: ReceiptView): string {
  return esc(JSON.stringify(v.receipt, null, 2));
}

function field(label: string, value: string): string {
  return `<div class="field"><dt>${esc(label)}</dt><dd><code>${esc(value)}</code></dd></div>`;
}

function card(v: ReceiptView, i: number): string {
  const r = v.receipt as unknown as Record<string, unknown>;
  const prev = r.previous_receipt_hash as string | undefined;
  const seq = String(r.seq);
  const time = fmtTime(String(r.observed_at));

  const details = `
      <details class="raw">
        <summary><span class="raw__label">Signed receipt fields</span><span class="raw__hint">click to open</span></summary>
        <div class="raw__body">
          <dl class="fields">
            ${field("Sequence number", seq)}
            ${field("Receipt id", String(r.id))}
            ${field("In policy", String(r.in_policy))}
            ${field("Issuer signature (Ed25519)", String(r.signature))}
            ${field("Previous receipt hash", prev ?? "none (first receipt in the chain)")}
            ${field("Evidence hash (SHA-512)", String(r.evidence_hash_sha512))}
          </dl>
          <p class="raw__caption">The full signed receipt, exactly as it appears in the evidence file:</p>
          <pre class="code"><code>${receiptJson(v)}</code></pre>
        </div>
      </details>`;

  return `
    <li class="rcpt rcpt--${v.step.kind}">
      <div class="rcpt__rail"><span class="rcpt__seq">${seq}</span></div>
      <article class="rcpt__body">
        <div class="rcpt__head">
          <span class="pill pill--${v.step.kind}">${esc(v.step.status)}</span>
          <code class="rcpt__action">${esc(v.step.action)}</code>
        </div>
        <h3 class="rcpt__title">${esc(v.step.title)}</h3>
        <p class="rcpt__plain">${esc(v.step.plain)}</p>
        <p class="rcpt__meta">Recorded ${esc(time)} &middot; sequence ${esc(seq)} of ${6}</p>
        ${details}
      </article>
    </li>`;
}

function tamperStrip(breakAt: number): string {
  // A compact horizontal echo of the chain, showing the break at receipt breakAt.
  const chips: string[] = [];
  for (let n = 1; n <= 6; n++) {
    const state =
      n < breakAt ? "ok" : n === breakAt ? "broken" : "suspect";
    chips.push(`<span class="chip chip--${state}">${n}</span>`);
    if (n < 6) {
      const linkState = n < breakAt ? "ok" : "cut";
      chips.push(`<span class="link link--${linkState}" aria-hidden="true"></span>`);
    }
  }
  return `<div class="strip">${chips.join("")}</div>`;
}

export function renderPage(data: PageData): string {
  const cards = data.receipts.map((v, i) => card(v, i)).join("\n");
  const t = data.tamper;

  const okRows = data.receipts
    .map((v) => {
      const seq = String((v.receipt as unknown as Record<string, unknown>).seq);
      return `<li><span class="tick">&#10003;</span><span class="ok-seq">${esc(seq)}</span><code>${esc(v.step.action)}</code></li>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>Prior authorization session PA-2210 &middot; AgentMint receipt viewer</title>
<meta name="description" content="A recorded prior authorization agent session: six signed, hash-linked receipts with a standalone verification you can run yourself. Sample data.">
<meta name="robots" content="noindex">
<style>
${STYLES}
</style>
</head>
<body>
<div class="banner" role="note">
  <strong>Sample data. No real patient information.</strong>
  Identifiers, amounts, and the payer name are fictional. The signatures and hashes are real, computed by the SDK over this synthetic session.
</div>

<main class="page">

  <header class="masthead">
    <p class="eyebrow">AgentMint &middot; Receipted session</p>
    <h1>Prior authorization session PA-2210</h1>
    <p class="lede">
      A receipt exists only for actions taken while it was recording. This page is one recorded session: a prior authorization agent working a single case under a plan that was signed before the session began. Each decision the agent made became a signed, hash-linked receipt. You can read every one below, and you can check them yourself without trusting anything on this page.
    </p>
  </header>

  <section class="plan" aria-label="Session plan">
    <h2 class="plan__title">The signed plan</h2>
    <p class="plan__note">This was signed before the session started. It states what the agent was allowed to do. Every receipt below is bound to it.</p>
    <dl class="plan__grid">
      <div><dt>Agent</dt><dd><code>${esc(data.agent)}</code></dd></div>
      <div><dt>Payer</dt><dd>${esc(PAYER)} <span class="tag">example</span></dd></div>
      <div class="plan__wide"><dt>Authorized scope</dt><dd>${data.scope.map((s) => `<code>${esc(s)}</code>`).join(" ")}</dd></div>
      <div class="plan__wide"><dt>Checkpoints (require a clinician)</dt><dd>${data.checkpoints.map((s) => `<code>${esc(s)}</code>`).join(" ")}</dd></div>
      <div><dt>Plan issued</dt><dd>${esc(fmtTime(data.issuedAt))}</dd></div>
      <div><dt>Signing key</dt><dd><code>${esc(data.keyId)}</code></dd></div>
    </dl>
  </section>

  <section class="chain-section" aria-label="Receipt chain">
    <h2 class="section-title">The receipt chain</h2>
    <p class="section-intro">Six actions, in order. Each one carries its own signature and links to the receipt before it by hash. The status on each card is the verdict the plan reached, recorded at the time, not a summary written afterward.</p>
    <ol class="chain">
${cards}
    </ol>
  </section>

  <section class="verify" aria-label="Verification">
    <h2 class="section-title">Verification</h2>

    <div class="panel panel--pass">
      <div class="panel__head">
        <span class="panel__mark panel__mark--pass" aria-hidden="true">&#10003;</span>
        <h3 class="panel__title">The chain verifies</h3>
      </div>
      <p>All six receipts checked out. Every signature is valid, every receipt's recorded link matches the receipt before it, and the sequence runs 1 through 6 with no gaps. A removed or reordered receipt would break one of those checks.</p>
      <ul class="oklist">
${okRows}
      </ul>
      <p class="rooted">Chain root hash <code class="wrap">${esc(data.cleanRootHash)}</code></p>
      <p class="panel__foot">The chain root is a single value that stands for the whole sequence. Publishing it once means a later copy cannot be quietly rewritten and still match.</p>
    </div>

    <div class="panel panel--fail">
      <div class="panel__head">
        <span class="panel__mark panel__mark--fail" aria-hidden="true">&#10007;</span>
        <h3 class="panel__title">The tamper check</h3>
      </div>
      <p>A record is only worth keeping if a change to it is detectable. To show that, one field on receipt ${t.receiptIndex} was edited after it was signed: <code>${esc(t.field)}</code> was changed from <code>${esc(t.from)}</code> to <code>${esc(t.to)}</code>, which would make the blocked read look as though it had been allowed. Nothing else was touched. The same verifier was run again.</p>
      ${tamperStrip(t.receiptIndex)}
      <p class="broke">Verification stops at <strong>receipt ${t.receiptIndex}</strong> and reports the changed field. Every receipt after it is now marked suspect, because each one is linked to the one before.</p>
      <p class="raw__caption">The verifier's own output:</p>
      <pre class="code code--fail"><code>chain invalid
  break at receipt ${t.receiptIndex} (id ${esc(t.receiptId)})
  type: ${esc(t.breakType)}
  ${esc(t.reason)}
  changed field: ${esc(t.field)}  ${esc(t.from)} -> ${esc(t.to)}</code></pre>
      <p class="panel__foot">The check names the exact receipt and does not need to be told where to look. This is what a plain log cannot do: a log can be edited in place and still read as consistent.</p>
    </div>
  </section>

  <section class="howto" aria-label="How to verify this yourself">
    <h2 class="section-title">How to verify this yourself</h2>
    <p class="section-intro">You do not have to trust this page. The six receipts shown here are also in a downloadable evidence file, byte for byte the same. Check them on your own machine. You need Node 18 or newer and nothing else: no install, no account, and no network.</p>
    <pre class="code code--cmd"><code>git clone ${REPO}
cd agentmint-sdk/examples/sample-evidence-packet
unzip evidence.zip -d packet
node packet/verify.mjs</code></pre>
    <p>A pass prints <code>All checks passed: 6 receipt(s), chain intact.</code> and exits 0. Change any field in any receipt and the check fails and names the receipt, the same way the tamper check above does.</p>
    <ul class="links">
      <li><a href="${REPO}">Source repository</a></li>
      <li><a href="${REPO}/blob/main/FOR-REVIEWERS.md">FOR-REVIEWERS.md</a>, the one command in plain language</li>
      <li><a href="./receipts.json">The six receipts on this page (JSON)</a></li>
      <li><a href="./public_key.pem">The public key that verifies them</a></li>
    </ul>
  </section>

  <footer class="foot">
    <p>Built by ${esc(BUILDER)}. <a href="${REPO}">Repository</a>. <a href="mailto:${CONTACT}">${esc(CONTACT)}</a>.</p>
    <p class="foot__fine">AgentMint produces cryptographic receipts for agent actions. This page renders one synthetic session. Sample data, no real patient information.</p>
  </footer>

</main>
</body>
</html>
`;
}

const STYLES = String.raw`
:root {
  --paper: #f4f6f8;
  --surface: #ffffff;
  --ink: #1a232f;
  --ink-2: #303c4c;
  --muted: #59626f;
  --faint: #838d9a;
  --line: #e4e8ed;
  --line-2: #ccd3db;
  --accent: #123b5c;
  --accent-soft: #e9f0f5;

  --allow: #1a7350;
  --allow-soft: #e8f3ed;
  --allow-line: #bfe0ce;
  --block: #b0392f;
  --block-soft: #fbecea;
  --block-line: #ecc8c3;
  --check: #92620f;
  --check-soft: #fbf1de;
  --check-line: #ead6a9;

  --serif: "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;

  --wrap: 44rem;
}

* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: var(--sans);
  font-size: 17px;
  line-height: 1.62;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
code { font-family: var(--mono); font-size: 0.86em; }
a { color: var(--accent); text-underline-offset: 2px; text-decoration-thickness: 1px; }
a:hover { text-decoration-thickness: 2px; }
h1, h2, h3 { font-family: var(--serif); font-weight: 600; letter-spacing: -0.005em; }

/* Banner */
.banner {
  background: var(--accent);
  color: #eaf1f6;
  font-size: 14px;
  line-height: 1.5;
  padding: 11px clamp(18px, 5vw, 40px);
  text-align: center;
}
.banner strong { color: #fff; font-weight: 600; }

/* Page frame */
.page {
  max-width: var(--wrap);
  margin: 0 auto;
  padding: clamp(40px, 7vw, 76px) clamp(20px, 5vw, 40px) 72px;
}

/* Masthead */
.eyebrow {
  font-size: 12px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--faint);
  margin: 0 0 18px;
  font-weight: 600;
}
.masthead h1 {
  font-size: clamp(30px, 6vw, 42px);
  line-height: 1.1;
  margin: 0 0 22px;
  color: var(--ink);
}
.lede {
  font-size: clamp(17px, 2.4vw, 19px);
  color: var(--ink-2);
  margin: 0;
  max-width: 40rem;
}

/* Plan */
.plan {
  margin-top: 44px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: clamp(20px, 4vw, 30px);
}
.plan__title { font-size: 18px; margin: 0 0 4px; color: var(--ink); }
.plan__note { color: var(--muted); font-size: 15px; margin: 0 0 22px; }
.plan__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px 28px;
  margin: 0;
}
.plan__grid > div { min-width: 0; }
.plan__wide { grid-column: 1 / -1; }
.plan__grid dt {
  font-size: 12px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--faint);
  font-weight: 600;
  margin-bottom: 5px;
}
.plan__grid dd { margin: 0; color: var(--ink-2); font-size: 15px; word-break: break-word; }
.plan__grid dd code { color: var(--ink); background: var(--paper); padding: 2px 6px; border-radius: 5px; }
.tag {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--muted);
  border: 1px solid var(--line-2);
  border-radius: 4px;
  padding: 1px 5px;
  vertical-align: middle;
}

/* Section headings */
.chain-section, .verify, .howto { margin-top: 64px; }
.section-title {
  font-size: 24px;
  margin: 0 0 12px;
  color: var(--ink);
  padding-bottom: 14px;
  border-bottom: 1px solid var(--line);
}
.section-intro { color: var(--ink-2); margin: 0 0 30px; max-width: 40rem; }

/* Chain / spine */
.chain { list-style: none; margin: 0; padding: 0; }
.rcpt {
  display: grid;
  grid-template-columns: 46px minmax(0, 1fr);
  column-gap: clamp(12px, 3vw, 22px);
  padding-bottom: 22px;
}
.rcpt__rail { position: relative; }
.rcpt__rail::before {
  content: "";
  position: absolute;
  left: 22px;
  top: 0;
  height: 100%;
  width: 2px;
  background: var(--line-2);
  transform: translateX(-50%);
}
.rcpt:first-child .rcpt__rail::before { top: 23px; height: calc(100% - 23px); }
.rcpt:last-child .rcpt__rail::before { height: 23px; }
.rcpt__seq {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  margin: 6px 0 0 5px;
  border-radius: 50%;
  background: var(--surface);
  border: 2px solid var(--line-2);
  color: var(--muted);
  font-family: var(--mono);
  font-size: 14px;
  font-weight: 600;
}
.rcpt--allow .rcpt__seq { border-color: var(--allow-line); color: var(--allow); }
.rcpt--block .rcpt__seq { border-color: var(--block-line); color: var(--block); }
.rcpt--check .rcpt__seq { border-color: var(--check-line); color: var(--check); }

.rcpt__body {
  min-width: 0;
  background: var(--surface);
  border: 1px solid var(--line);
  border-left: 3px solid var(--line-2);
  border-radius: 10px;
  padding: clamp(16px, 3vw, 22px);
}
.rcpt--allow .rcpt__body { border-left-color: var(--allow); }
.rcpt--block .rcpt__body { border-left-color: var(--block); }
.rcpt--check .rcpt__body { border-left-color: var(--check); }

.rcpt__head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.pill {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  padding: 4px 9px;
  border-radius: 5px;
  white-space: nowrap;
}
.pill--allow { background: var(--allow-soft); color: var(--allow); }
.pill--block { background: var(--block-soft); color: var(--block); }
.pill--check { background: var(--check-soft); color: var(--check); }
.rcpt__action { color: var(--muted); font-size: 13px; word-break: break-all; }
.rcpt__title { font-size: 19px; margin: 0 0 8px; color: var(--ink); }
.rcpt__plain { margin: 0 0 12px; color: var(--ink-2); }
.rcpt__meta { margin: 0; font-size: 13px; color: var(--faint); }

/* Raw disclosure */
.raw { margin-top: 16px; border-top: 1px solid var(--line); padding-top: 12px; }
.raw summary {
  display: flex;
  align-items: baseline;
  gap: 10px;
  cursor: pointer;
  list-style: none;
  color: var(--accent);
  font-size: 14px;
  font-weight: 600;
}
.raw summary::-webkit-details-marker { display: none; }
.raw__label::before { content: "\203A"; margin-right: 8px; display: inline-block; transition: transform 0.15s ease; }
.raw[open] .raw__label::before { transform: rotate(90deg); }
.raw__hint { color: var(--faint); font-weight: 400; font-size: 12px; }
.raw[open] .raw__hint { display: none; }
.raw__body { padding-top: 14px; }
.fields { margin: 0 0 16px; display: grid; gap: 12px; }
.field dt {
  font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase;
  color: var(--faint); font-weight: 600; margin-bottom: 3px;
}
.field dd { margin: 0; }
.field dd code { color: var(--ink-2); word-break: break-all; line-height: 1.45; }
.raw__caption { font-size: 13px; color: var(--muted); margin: 0 0 8px; }

/* Code blocks (the secondary terminal element) */
.code {
  background: #101822;
  color: #d7e0ea;
  border-radius: 8px;
  padding: 16px 18px;
  overflow-x: auto;
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.6;
  margin: 0;
}
.code code { font-size: inherit; color: inherit; }
.code--fail { border-left: 3px solid var(--block); }
.code--cmd { font-size: 13.5px; }

/* Verification panels */
.panel {
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: clamp(20px, 4vw, 28px);
  background: var(--surface);
  margin-bottom: 22px;
}
.panel--pass { border-color: var(--allow-line); background: linear-gradient(var(--allow-soft), var(--surface) 120px); }
.panel--fail { border-color: var(--block-line); background: linear-gradient(var(--block-soft), var(--surface) 120px); }
.panel__head { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.panel__mark {
  display: flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border-radius: 50%; font-size: 15px; font-weight: 700; flex: none;
}
.panel__mark--pass { background: var(--allow); color: #fff; }
.panel__mark--fail { background: var(--block); color: #fff; }
.panel__title { font-size: 20px; margin: 0; color: var(--ink); }
.panel p { color: var(--ink-2); }
.panel p:last-child { margin-bottom: 0; }
.panel code { background: rgba(18,59,92,0.06); padding: 1px 5px; border-radius: 4px; color: var(--ink); }
.panel .code code { background: none; padding: 0; color: inherit; border-radius: 0; }
.panel__foot { font-size: 14px; color: var(--muted); }

.oklist { list-style: none; margin: 18px 0; padding: 0; display: grid; gap: 7px; }
.oklist li { display: flex; align-items: center; gap: 10px; font-size: 14px; }
.tick { color: var(--allow); font-weight: 700; }
.ok-seq {
  font-family: var(--mono); font-size: 12px; color: var(--muted);
  width: 20px; text-align: center; flex: none;
}
.oklist code { background: none; padding: 0; color: var(--ink-2); word-break: break-all; }
.rooted { font-size: 14px; }
.rooted .wrap { word-break: break-all; }

/* Tamper strip */
.strip {
  display: flex; align-items: center; flex-wrap: wrap; gap: 4px;
  margin: 20px 0; padding: 16px; background: var(--surface);
  border: 1px solid var(--line); border-radius: 8px;
}
.chip {
  display: flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; border-radius: 50%;
  font-family: var(--mono); font-size: 13px; font-weight: 600; flex: none;
  border: 2px solid var(--line-2); color: var(--muted); background: var(--surface);
}
.chip--ok { border-color: var(--allow-line); color: var(--allow); }
.chip--broken { border-color: var(--block); color: #fff; background: var(--block); }
.chip--suspect { border-style: dashed; border-color: var(--block-line); color: var(--faint); }
.link { width: 18px; height: 2px; background: var(--line-2); flex: none; }
.link--ok { background: var(--allow-line); }
.link--cut { background: repeating-linear-gradient(90deg, var(--block) 0 4px, transparent 4px 8px); }
.broke { font-size: 15px; }

/* How to verify */
.howto .code--cmd { margin-bottom: 20px; }
.links { list-style: none; margin: 22px 0 0; padding: 0; display: grid; gap: 9px; }
.links li { padding-left: 16px; position: relative; color: var(--muted); font-size: 15px; }
.links li::before { content: "\2192"; position: absolute; left: 0; color: var(--faint); }

/* Footer */
.foot { margin-top: 66px; padding-top: 24px; border-top: 1px solid var(--line); color: var(--muted); font-size: 14px; }
.foot a { color: var(--accent); }
.foot__fine { color: var(--faint); font-size: 13px; margin-bottom: 0; }

@media (max-width: 560px) {
  body { font-size: 16px; }
  .plan__grid { grid-template-columns: 1fr; }
  .rcpt { grid-template-columns: 38px minmax(0, 1fr); column-gap: 12px; }
  .rcpt__rail::before { left: 18px; }
  .rcpt__seq { width: 30px; height: 30px; margin-left: 3px; font-size: 13px; }
  .rcpt:first-child .rcpt__rail::before { top: 21px; height: calc(100% - 21px); }
  .rcpt:last-child .rcpt__rail::before { height: 21px; }
}

@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; }
}
`;
