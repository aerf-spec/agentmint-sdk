# Harness

Runs short scripted calls against the live backend and writes a plain report for each one.

```bash
npm run harness                    # all scenarios
npm run harness -- 03-approve-visits
npm run harness -- --say VERIFY --say "Is Bayview covered?"
```

`VERIFY` on its own line is replaced with an identity check, so you can skip straight to the question. In test mode the backend accepts any name, member ID and date of birth, and makes up believable member data. Only the date of birth 1900-01-01 fails, so the refusal path can still be tested.

Each run writes to `harness/runs/<time>/<scenario>/`:

- `report.html`: the call step by step. Each decision shows the question, the rule, the reasoning with its evidence, and whether the receipt checks out.
- `report.md`: the same, as text.
- `package.json`: the evidence package (signed receipts).
- `events.jsonl`: every raw event.

A scenario is a JSON file in `scenarios/` with `lines` (what the caller says), and optional `expect` / `forbid` decisions.
