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

- `index.html` : the overview page. Self-contained. No scripts, no external assets.
- `verify.html` : a no-code, in-browser verifier. Checks every signature and hash link locally with Web Crypto. The receipts and key are embedded, so it also works offline. This is the only page with scripts, and it still makes no network calls.
- `receipts.json` : the six receipts shown on the page, as raw signed JSON.
- `receipts.md` : the same receipts in plain language, one section each.
- `verification.md` : the verification report, the clean pass and the tamper failure.
- `public_key.pem` : the key that verifies those receipts.
- `CNAME` : the custom domain, `agentmint.run`.

The Markdown files render on GitHub when linked as repository files, and are
served as plain text at the site (for example
`https://agentmint.run/verification.md`).

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
site from source and deploys it to GitHub Pages on every push to `main`. Pages
source is GitHub Actions, and the custom domain `agentmint.run` is set by the
committed `CNAME`. The domain's DNS must point at GitHub Pages (apex A records
to 185.199.108.153, 185.199.109.153, 185.199.110.153, 185.199.111.153).
