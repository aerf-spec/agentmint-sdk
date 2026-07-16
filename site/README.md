# Receipt viewer (GitHub Pages)

This folder is the published receipt viewer. It renders one prior authorization
agent session as a minimal flow: how a signed receipt comes to exist, and what
the reviewer holds at the end.

The scenario is synthetic. The signatures and hashes are real, produced by the
SDK over the synthetic session. The receipts here are byte-identical to the
downloadable evidence packet at
[`examples/sample-evidence-packet/evidence.zip`](../examples/sample-evidence-packet/),
so the same records shown on the page can be verified standalone with
`node packet/verify.mjs`.

## Files

- `index.html` : the flow page. Self-contained. No scripts, no external assets, no network calls.
- `receipts.json` : the six receipts, as raw signed JSON.
- `receipts.md` : the same receipts in plain language, one section each.
- `verification.md` : the verification report, the clean pass and the tamper failure.
- `public_key.pem` : the key that verifies those receipts.

The Markdown files render on GitHub when linked as repository files, and are
served as plain text at the Pages URL (for example
`https://aerf-spec.github.io/agentmint-sdk/verification.md`).

## Regenerate

The page is generated from the SDK, not hand-edited. Do not edit `index.html`
directly; change the generator and rebuild.

```
npm run site:build
```

This runs [`scripts/build-receipt-viewer.ts`](../scripts/build-receipt-viewer.ts),
which signs the plan, builds and chains the receipts, verifies them, and writes
`index.html`, `receipts.json`, `receipts.md`, `verification.md`, and
`public_key.pem`.

## Deploy

[`.github/workflows/pages.yml`](../.github/workflows/pages.yml) regenerates the
site from source and deploys it to GitHub Pages on every push to `main`. Pages
source is GitHub Actions. The site is served at
`https://aerf-spec.github.io/agentmint-sdk/`.
