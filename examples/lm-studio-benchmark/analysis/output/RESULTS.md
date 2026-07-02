# AgentMint diagnostic — RESULTS

- Model: `meta-llama-3.1-8b-instruct`
- Generated: 2026-07-02T02:03:20.372Z
- Runs per arm: baseline 3, hardened 3, shaped 3
- Proxy pricing: $3/M in, $15/M out (NOT an invoice)
- Receipts emitted: 30. Verified: 30. Tamper checks: PASS.

## Per-task / per-arm

| task | arm | promptTok (min–max) | out | reason | $prx | succ | cap | calls | blk | aftBlk | dedup |
|---|---|---|---|---|---|---|---|---|---|---|---|
| coding-agent | baseline | 24318 (24318–24318) | 3643 | 0 | $0.128 | 100% | 0% | 5 | 0 | 0 | 0 |
| coding-agent | hardened | 28904 (28904–28904) | 3952 | 0 | $0.146 | 100% | 0% | 6 | 2 | 2 | 0 |
| coding-agent | shaped | 33760 (33760–33760) | 2969 | 0 | $0.146 | 100% | 0% | 6 | 2 | 2 | 0 |
| scope-creep | baseline | 62117 (62117–62117) | 404 | 0 | $0.192 | 0% | 100% | 15 | 0 | 0 | 0 |
| scope-creep | hardened | 43806 (43806–57541) | 364 | 0 | $0.137 | 100% | 0% | 10 | 3 | 6 | 0 |
| scope-creep | shaped | 22099 (22099–22099) | 183 | 0 | $0.069 | 100% | 0% | 5 | 0 | 0 | 0 |
| loop-trigger | baseline | 19080 (19080–19080) | 256 | 0 | $0.061 | 0% | 100% | 15 | 0 | 0 | 0 |
| loop-trigger | hardened | 6475 (6475–6475) | 214 | 0 | $0.023 | 100% | 0% | 5 | 2 | 3 | 0 |
| loop-trigger | shaped | 6475 (6475–6475) | 214 | 0 | $0.023 | 100% | 0% | 5 | 2 | 3 | 0 |
| context-bloat | baseline | 67250 (67250–67250) | 340 | 0 | $0.207 | 0% | 100% | 15 | 0 | 0 | 0 |
| context-bloat | hardened | 48826 (48826–67250) | 387 | 0 | $0.152 | 0% | 33% | 10 | 5 | 7 | 0 |
| context-bloat | shaped | 27582 (27582–27582) | 223 | 0 | $0.086 | 0% | 0% | 5 | 0 | 0 | 0 |
| linear-control | baseline | 3066 (3066–3066) | 97 | 0 | $0.011 | 100% | 0% | 2 | 0 | 0 | 0 |
| linear-control | hardened | 3066 (3066–3066) | 97 | 0 | $0.011 | 100% | 0% | 2 | 0 | 0 | 0 |
| linear-control | shaped | 3066 (3066–3066) | 97 | 0 | $0.011 | 100% | 0% | 2 | 0 | 0 | 0 |

## Verdicts

- **PASS** T1 shaped <= 80% of baseline prompt tokens on context-bloat — shaped/baseline = 41%
- **PASS** T4 shaping adds >=10pp beyond enforcement (context-bloat) — hardened->shaped = 32% of baseline
- **PASS** T2 shaped success within 10pp of hardened (all tasks) — coding-agent 100%->100%  scope-creep 100%->100%  loop-trigger 100%->100%  context-bloat 0%->0%  linear-control 100%->100%
- **PASS** T3 linear-control sanity: savings <5% and success intact — control savings 0%, success drop 0%
- **PASS** ATTRIBUTION enforcement (hardened-baseline) vs truncation (shaped-hardened) prompt-token delta per task — coding-agent enf +4586 / trunc +4856  |  scope-creep enf -18311 / trunc -21707  |  loop-trigger enf -12605 / trunc +0  |  context-bloat enf -18424 / trunc -21244  |  linear-control enf +0 / trunc +0  ||  guardrail tax (shaped>hardened): coding-agent
- **PASS** H8 reasoning-token share of completion (info, not pass/fail) — ~0% of output tokens are <think> — suppressing on routine turns could cut output cost by roughly this much

## Summary

Core verdicts T1–T4: 4/4 passed (T1 PASS, T4 PASS, T2 PASS, T3 PASS). Shaping thesis SURVIVES on meta-llama-3.1-8b-instruct.

