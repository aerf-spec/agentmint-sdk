# Receipt viewer (GitHub Pages)

This folder is the published receipt viewer. It renders one prior authorization
agent session as a set of signed, hash-linked receipts, with a verification
section and a tamper check.

The scenario is synthetic. The signatures and hashes are real, produced by the
SDK over the synthetic session. The receipts here are byte-identical to the
downloadable evidence packet at
[`examples/sample-evidence-packet/evidence.zip`](../examples/sample-evidence-packet/),
so the same records shown on the page can be verified standalone with
`node packet/verify.mjs`.

## Files

- `index.html` : the page. Self-contained. No scripts, no external assets, no network calls.
- `receipts.json` : the six receipts shown on the page, as raw JSON.
- `public_key.pem` : the key that verifies those receipts.

## Regenerate

The page is generated from the SDK, not hand-edited. Do not edit `index.html`
directly; change the generator and rebuild.

```
npm run site:build
```

This runs [`scripts/build-receipt-viewer.ts`](../scripts/build-receipt-viewer.ts),
which signs the plan, builds and chains the receipts, runs the clean and tamper
verifications, and writes `index.html`, `receipts.json`, and `public_key.pem`.

## Deploy

[`.github/workflows/pages.yml`](../.github/workflows/pages.yml) regenerates the
site from source and deploys it to GitHub Pages on every push to `main`. Enable
Pages once under Settings, Pages, Source: GitHub Actions.
