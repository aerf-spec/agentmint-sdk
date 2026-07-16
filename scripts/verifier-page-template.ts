// Renders verify.html: a no-code, in-browser verifier for the receipts.
//
// A reviewer opens the page and it checks every signature and hash link locally,
// using the browser's built-in Web Crypto Ed25519. Nothing is uploaded and the
// page makes no network requests after it loads: the demo receipts and the
// public key are embedded, and any packet the reviewer drops in is read with a
// local FileReader, never sent anywhere.
//
// The in-page verifier reproduces the SDK signing scheme exactly (src/kernel):
//   - signed payload = receipt minus the five post-issuance fields, canonicalized
//   - canonical JSON per AERF SPEC.md §5.1 (sorted keys, NFC strings, JCS escapes)
//   - Ed25519 over those bytes; chain hash = SHA-256 of the same bytes
import type { PageData } from "./build-receipt-viewer.js";

const REPO = "https://github.com/aerf-spec/agentmint-sdk";

/** Embed text inside a script tag safely. */
function safe(s: string): string {
  return s.replace(/<\/(script)/gi, "<\\/$1");
}

export function renderVerifierPage(data: PageData): string {
  const receipts = data.receipts.map((v) => v.receipt);
  const receiptsJson = safe(JSON.stringify(receipts));
  const pubPem = safe(data.publicKeyPem.trim());

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>Verify the receipts in your browser &middot; AgentMint</title>
<meta name="description" content="Check every signature and hash link locally in your browser. Nothing is uploaded. Sample data.">
<meta name="robots" content="noindex">
<style>${STYLES}</style>
</head>
<body>
<div class="banner" role="note">
  <strong>Sample data. No real patient information.</strong>
  The signatures and hashes are real. This page checks them in your browser.
</div>

<main class="page">
  <header class="masthead">
    <p class="eyebrow"><a href="./">AgentMint &middot; Prior authorization session PA-2210</a></p>
    <h1>Verify these receipts in your browser</h1>
    <p class="lede">
      No install and no command line. This page checks every signature and every hash link on your device, using your browser's built-in cryptography. Nothing is uploaded, and after the page loads it makes no network requests.
    </p>
  </header>

  <section aria-label="Result">
    <div id="verdict" class="verdict verdict--wait">
      <span class="verdict__mark" aria-hidden="true">&#8230;</span>
      <div>
        <p class="verdict__line" id="verdict-line">Checking the receipts.</p>
        <p class="verdict__sub" id="verdict-sub"></p>
      </div>
    </div>
    <ul class="checks" id="checks"></ul>
    <dl class="meta" id="meta"></dl>
  </section>

  <section class="own" aria-label="Check a different packet">
    <h2 class="section-title">Check a different packet</h2>
    <p class="section-intro">To check receipts a vendor sent you, drop their files here: the receipt JSON (one array, or the individual receipt files) and the public key <code>.pem</code>. They are read on your device and never uploaded.</p>
    <label class="drop" id="drop">
      <input type="file" id="files" multiple accept=".json,.pem,application/json" hidden>
      <span id="drop-text">Choose files, or drag them here</span>
    </label>
    <div class="own__actions">
      <button type="button" id="reset">Back to the sample</button>
    </div>
  </section>

  <section class="notes" aria-label="Why this is safe">
    <h2 class="section-title">Why this is trustworthy</h2>
    <ul class="notelist">
      <li><strong>It runs on your device.</strong> The check uses your browser's Web Crypto Ed25519, the same signature scheme as the command-line verifier. The receipts and key never leave the page.</li>
      <li><strong>No network.</strong> The sample receipts and key are embedded in this page. After it loads, it makes no requests. Open your browser's network tab to confirm.</li>
      <li><strong>It works offline.</strong> Save this page and open it with no internet connection. It still verifies.</li>
      <li><strong>You can cross-check it.</strong> For independent assurance, run the standalone verifier, which does not depend on this page: <a href="${REPO}/blob/main/FOR-REVIEWERS.md">FOR-REVIEWERS.md</a>.</li>
    </ul>
    <p class="back"><a href="./">Back to the session overview</a></p>
  </section>

  <footer class="foot">
    <p><a href="${REPO}">Repository</a>. Sample data, no real patient information.</p>
  </footer>
</main>

<script id="receipts" type="application/json">${receiptsJson}</script>
<script id="pubkey" type="text/plain">${pubPem}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

// ── The in-browser verifier (plain JS, runs in the page) ─────────────
const SCRIPT = String.raw`
"use strict";

// Fields stripped from a receipt before signing (src/kernel/sign.ts).
const POST_ISSUANCE = ["signature","timestamp","parent_signature","parent_key_id","log_inclusion_proof"];

// ---- Canonical JSON (JCS), matching src/kernel/canonical.ts ----
function encodeString(value) {
  let out = '"';
  for (const ch of value.normalize("NFC")) {
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else {
      const code = ch.codePointAt(0);
      if (code <= 0x1f) out += "\\u" + code.toString(16).padStart(4, "0");
      else out += ch;
    }
  }
  return out + '"';
}
function encodeNumber(value) {
  if (!Number.isFinite(value)) throw new Error("non-finite number");
  if (Object.is(value, -0)) return "0";
  if (!Number.isInteger(value)) throw new Error("fractional number in signed payload");
  if (!Number.isSafeInteger(value)) throw new Error("unsafe integer");
  return String(value);
}
function cmpCodePoints(a, b) {
  const ap = Array.from(a), bp = Array.from(b);
  const n = Math.min(ap.length, bp.length);
  for (let i = 0; i < n; i++) {
    const d = ap[i].codePointAt(0) - bp[i].codePointAt(0);
    if (d !== 0) return d;
  }
  return ap.length - bp.length;
}
function encode(value) {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") return encodeString(value);
  if (typeof value === "number") return encodeNumber(value);
  if (Array.isArray(value)) return "[" + value.map(encode).join(",") + "]";
  if (typeof value === "object") {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .map((k) => k.normalize("NFC"));
    keys.sort(cmpCodePoints);
    return "{" + keys.map((k) => encodeString(k) + ":" + encode(value[k])).join(",") + "}";
  }
  throw new Error("unsupported value");
}
function canonicalBytes(value) {
  return new TextEncoder().encode(encode(value));
}
function stripPostIssuance(obj) {
  const out = Object.assign({}, obj);
  for (const f of POST_ISSUANCE) delete out[f];
  return out;
}

// ---- hex / base64 / hash ----
function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function bytesToHex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}
async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(d));
}
function pemToDer(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return der;
}

// ---- verification ----
async function importPubKey(pem) {
  const der = pemToDer(pem);
  const key = await crypto.subtle.importKey("spki", der, { name: "Ed25519" }, true, ["verify"]);
  // key_id = first 16 hex of SHA-256(last 32 bytes of SPKI DER)
  const raw = der.slice(der.length - 32);
  const keyId = (await sha256Hex(raw)).slice(0, 16);
  return { key, keyId };
}

async function verifyChain(receipts, pem) {
  const { key, keyId } = await importPubKey(pem);
  const rows = [];
  let ok = true;
  let expectedPrev = undefined;
  let prevSeq = undefined;

  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i];
    const row = { seq: r.seq, action: r.action, id: r.id, sig: false, link: true, seqOk: true };

    // 1. signature over stripped canonical payload
    const payload = canonicalBytes(stripPostIssuance(r));
    const sigBytes = hexToBytes(r.signature || "");
    try {
      row.sig = !!sigBytes && (await crypto.subtle.verify({ name: "Ed25519" }, key, sigBytes, payload));
    } catch (e) { row.sig = false; }

    // 2. hash link (genesis omits previous_receipt_hash)
    if (i === 0) {
      row.link = !("previous_receipt_hash" in r);
    } else {
      row.link = r.previous_receipt_hash === expectedPrev;
    }

    // 3. monotonic seq
    if (typeof r.seq === "number") {
      row.seqOk = i === 0 ? r.seq >= 1 : r.seq === (prevSeq || 0) + 1;
      prevSeq = r.seq;
    }

    if (!row.sig || !row.link || !row.seqOk) ok = false;
    rows.push(row);
    expectedPrev = await sha256Hex(payload);
  }

  return { ok, rows, rootHash: expectedPrev, keyId };
}

// ---- UI ----
const $ = (id) => document.getElementById(id);

function setVerdict(state, line, sub) {
  const v = $("verdict");
  v.className = "verdict verdict--" + state;
  v.querySelector(".verdict__mark").innerHTML = state === "pass" ? "&#10003;" : state === "fail" ? "&#10007;" : "&#8230;";
  $("verdict-line").textContent = line;
  $("verdict-sub").textContent = sub || "";
}

function render(result, keyProvided) {
  const total = result.rows.length;
  const bad = result.rows.filter((r) => !r.sig || !r.link || !r.seqOk).length;
  if (result.ok) {
    setVerdict("pass", "Verified.", "All " + total + " receipts are signed by the key, linked in order, and unchanged.");
  } else {
    setVerdict("fail", "Verification failed.", bad + " of " + total + " receipts did not check out. The failing rows are marked below.");
  }
  const checks = $("checks");
  checks.innerHTML = "";
  for (const r of result.rows) {
    const good = r.sig && r.link && r.seqOk;
    const li = document.createElement("li");
    li.className = good ? "row row--ok" : "row row--bad";
    const marks = [];
    if (!r.sig) marks.push("signature");
    if (!r.link) marks.push("hash link");
    if (!r.seqOk) marks.push("sequence");
    li.innerHTML =
      '<span class="rowmark">' + (good ? "&#10003;" : "&#10007;") + '</span>' +
      '<span class="rowseq">' + (r.seq != null ? r.seq : "?") + '</span>' +
      '<code class="rowact"></code>' +
      (good ? '<span class="rownote">signed, linked</span>' : '<span class="rownote rownote--bad">changed: ' + marks.join(", ") + '</span>');
    li.querySelector(".rowact").textContent = r.action || r.id || "";
    checks.appendChild(li);
  }
  const meta = $("meta");
  meta.innerHTML = "";
  const add = (dt, dd) => {
    const d1 = document.createElement("dt"); d1.textContent = dt;
    const d2 = document.createElement("dd"); d2.innerHTML = dd;
    meta.appendChild(d1); meta.appendChild(d2);
  };
  add("Chain root", '<code class="wrap">' + result.rootHash + '</code>');
  add("Signing key id", '<code>' + result.keyId + '</code>' + (keyProvided ? "" : " (from this page)"));
}

async function run(receipts, pem, keyProvided) {
  try {
    if (!("subtle" in crypto) || !crypto.subtle.importKey) throw new Error("nosubtle");
    // Feature-detect Ed25519 support.
    try { await importPubKey(pem); }
    catch (e) { throw new Error("noed25519"); }
    const result = await verifyChain(receipts, pem);
    render(result, keyProvided);
  } catch (e) {
    if (e && (e.message === "noed25519" || e.message === "nosubtle")) {
      setVerdict("fail", "This browser cannot run the check.",
        "It does not support Ed25519 in Web Crypto. Use a current browser, or the command-line verifier in FOR-REVIEWERS.md.");
    } else {
      setVerdict("fail", "Could not read those files.", (e && e.message) ? e.message : String(e));
    }
    $("checks").innerHTML = "";
    $("meta").innerHTML = "";
  }
}

// Embedded sample data.
const SAMPLE_RECEIPTS = JSON.parse($("receipts").textContent);
const SAMPLE_PEM = $("pubkey").textContent.trim();

run(SAMPLE_RECEIPTS, SAMPLE_PEM, false);

// Expose for testing.
window.__verifyChain = verifyChain;

// ---- upload handling ----
async function handleFiles(fileList) {
  const files = Array.from(fileList);
  if (!files.length) return;
  let pem = null;
  const receipts = [];
  for (const f of files) {
    const text = await f.text();
    if (/-----BEGIN [A-Z ]*PUBLIC KEY-----/.test(text) || f.name.endsWith(".pem")) { pem = text; continue; }
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { continue; }
    if (Array.isArray(parsed)) receipts.push(...parsed);
    else if (parsed && parsed.signature && parsed.id) receipts.push(parsed);
    else if (parsed && Array.isArray(parsed.receipts)) receipts.push(...parsed.receipts);
  }
  if (!receipts.length) { setVerdict("fail", "No receipts found in those files.", "Drop a receipts JSON array, or the individual receipt files."); return; }
  if (!pem) { setVerdict("fail", "No public key found.", "Include the .pem public key so signatures can be checked."); return; }
  receipts.sort((a, b) => (a.seq || 0) - (b.seq || 0));
  $("drop-text").textContent = receipts.length + " receipts and a key loaded.";
  run(receipts, pem, true);
}

$("files").addEventListener("change", (e) => handleFiles(e.target.files));
const drop = $("drop");
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("drop--over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("drop--over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault(); drop.classList.remove("drop--over");
  if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files);
});
$("reset").addEventListener("click", () => {
  $("drop-text").textContent = "Choose files, or drag them here";
  $("files").value = "";
  run(SAMPLE_RECEIPTS, SAMPLE_PEM, false);
});
`;

const STYLES = String.raw`
:root {
  --paper:#f4f6f8; --surface:#fff; --ink:#1a232f; --ink-2:#303c4c; --muted:#59626f;
  --faint:#838d9a; --line:#e4e8ed; --line-2:#ccd3db; --accent:#123b5c;
  --allow:#1a7350; --allow-soft:#e8f3ed; --allow-line:#bfe0ce;
  --block:#b0392f; --block-soft:#fbecea; --block-line:#ecc8c3;
  --wait:#6b7480;
  --serif:"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
  --wrap:44rem;
}
* { box-sizing:border-box; }
body { margin:0; background:var(--paper); color:var(--ink); font-family:var(--sans); font-size:17px; line-height:1.6; -webkit-font-smoothing:antialiased; }
code { font-family:var(--mono); font-size:0.86em; }
a { color:var(--accent); text-underline-offset:2px; }
h1,h2 { font-family:var(--serif); font-weight:600; letter-spacing:-0.005em; }
.banner { background:var(--accent); color:#eaf1f6; font-size:14px; line-height:1.5; padding:11px clamp(18px,5vw,40px); text-align:center; }
.banner strong { color:#fff; font-weight:600; }
.page { max-width:var(--wrap); margin:0 auto; padding:clamp(36px,6vw,60px) clamp(20px,5vw,40px) 60px; }
.eyebrow { font-size:12px; letter-spacing:0.14em; text-transform:uppercase; color:var(--faint); margin:0 0 16px; font-weight:600; }
.eyebrow a { color:var(--faint); text-decoration:none; }
.eyebrow a:hover { color:var(--accent); }
.masthead h1 { font-size:clamp(27px,5vw,38px); line-height:1.12; margin:0 0 18px; }
.lede { font-size:clamp(16px,2.2vw,18px); color:var(--ink-2); margin:0 0 34px; max-width:40rem; }

.verdict { display:flex; gap:16px; align-items:flex-start; border:1px solid var(--line-2); border-radius:12px; padding:20px 22px; background:var(--surface); }
.verdict--pass { border-color:var(--allow-line); background:linear-gradient(var(--allow-soft),var(--surface) 120px); }
.verdict--fail { border-color:var(--block-line); background:linear-gradient(var(--block-soft),var(--surface) 120px); }
.verdict__mark { display:flex; align-items:center; justify-content:center; width:34px; height:34px; border-radius:50%; font-size:18px; font-weight:700; flex:none; color:#fff; background:var(--wait); margin-top:1px; }
.verdict--pass .verdict__mark { background:var(--allow); }
.verdict--fail .verdict__mark { background:var(--block); }
.verdict__line { margin:0 0 3px; font-weight:600; font-size:19px; font-family:var(--serif); }
.verdict__sub { margin:0; color:var(--ink-2); font-size:15px; }

.checks { list-style:none; margin:18px 0 0; padding:0; display:grid; gap:6px; }
.row { display:flex; align-items:center; gap:12px; padding:10px 14px; border:1px solid var(--line); border-radius:8px; background:var(--surface); font-size:14px; }
.row--bad { border-color:var(--block-line); background:var(--block-soft); }
.rowmark { flex:none; font-weight:700; color:var(--allow); }
.row--bad .rowmark { color:var(--block); }
.rowseq { flex:none; width:20px; text-align:center; font-family:var(--mono); font-size:12px; color:var(--muted); }
.rowact { flex:1; min-width:0; color:var(--ink-2); word-break:break-all; }
.rownote { flex:none; color:var(--muted); font-size:12.5px; }
.rownote--bad { color:var(--block); font-weight:600; }

.meta { display:grid; grid-template-columns:auto 1fr; gap:8px 16px; margin:18px 0 0; font-size:14px; }
.meta dt { color:var(--faint); font-size:12px; text-transform:uppercase; letter-spacing:0.05em; font-weight:600; padding-top:2px; }
.meta dd { margin:0; }
.meta code { color:var(--ink-2); }
.meta .wrap { word-break:break-all; }

.own, .notes { margin-top:48px; }
.section-title { font-size:20px; margin:0 0 10px; padding-bottom:12px; border-bottom:1px solid var(--line); }
.section-intro { color:var(--ink-2); font-size:15px; margin:0 0 18px; max-width:40rem; }
.section-intro code { background:var(--paper); padding:1px 5px; border-radius:4px; }
.drop { display:flex; align-items:center; justify-content:center; text-align:center; padding:26px; border:2px dashed var(--line-2); border-radius:10px; color:var(--muted); cursor:pointer; background:var(--surface); font-size:14.5px; }
.drop:hover, .drop--over { border-color:var(--accent); color:var(--accent); background:#f7fafc; }
.own__actions { margin-top:14px; }
#reset { font:inherit; font-size:14px; color:var(--accent); background:none; border:1px solid var(--line-2); border-radius:7px; padding:7px 12px; cursor:pointer; }
#reset:hover { border-color:var(--accent); }

.notelist { list-style:none; margin:0; padding:0; display:grid; gap:12px; }
.notelist li { color:var(--ink-2); font-size:15px; padding-left:16px; position:relative; }
.notelist li::before { content:"\2192"; position:absolute; left:0; color:var(--faint); }
.notelist strong { color:var(--ink); font-weight:600; }
.back { margin-top:22px; font-size:15px; }

.foot { margin-top:52px; padding-top:22px; border-top:1px solid var(--line); color:var(--muted); font-size:14px; }

@media (max-width:560px) {
  body { font-size:16px; }
  .meta { grid-template-columns:1fr; gap:3px 0; }
  .meta dt { padding-top:8px; }
  .row { flex-wrap:wrap; }
  .rownote { width:100%; padding-left:32px; }
}
@media (prefers-reduced-motion:reduce) { * { transition:none !important; } }
`;
