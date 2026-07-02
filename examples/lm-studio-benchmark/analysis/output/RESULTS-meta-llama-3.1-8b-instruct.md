# AgentMint diagnostic — RESULTS

- Model: `meta-llama-3.1-8b-instruct`
- Generated: 2026-07-02T01:22:16.826Z
- Runs per arm: baseline 2, hardened-steer 3, hardened 3, shaped-steer 3, shaped 2
- Proxy pricing: $3/M in, $15/M out (NOT an invoice)
- Receipts emitted: 10. Verified: 10. Tamper checks: PASS.

## Per-task / per-arm

| task | arm | promptTok (min–max) | out | reason | $prx | succ | cap | calls | blk | aftBlk | dedup |
|---|---|---|---|---|---|---|---|---|---|---|---|
| coding-agent | baseline | 24318 (24318–24318) | 3643 | 0 | $0.128 | 100% | 0% | 5 | 0 | 0 | 0 |
| coding-agent | hardened-steer | 86587 (86089–86587) | 1073 | 0 | $0.276 | 0% | 100% | 15 | 11 | 10 | 0 |
| coding-agent | hardened | 85239 (76473–85310) | 1149 | 0 | $0.273 | 0% | 100% | 15 | 11 | 10 | 0 |
| coding-agent | shaped-steer | 64108 (60795–64108) | 2288 | 0 | $0.227 | 0% | 100% | 15 | 6 | 10 | 0 |
| coding-agent | shaped | 33760 (33760–33760) | 2969 | 0 | $0.146 | 100% | 0% | 6 | 2 | 2 | 0 |
| scope-creep | baseline | 62117 (62117–62117) | 404 | 0 | $0.192 | 0% | 100% | 15 | 0 | 0 | 0 |
| scope-creep | hardened-steer | 28061 (28061–28061) | 1222 | 0 | $0.103 | 0% | 100% | 15 | 11 | 10 | 0 |
| scope-creep | hardened | 0 (Infinity–-Infinity) | 0 | 0 | $0.000 | 0% | 0% | 0 | 0 | 0 | 0 |
| scope-creep | shaped-steer | 28061 (28061–28061) | 1222 | 0 | $0.103 | 0% | 100% | 15 | 11 | 10 | 0 |
| scope-creep | shaped | 22099 (22099–22099) | 183 | 0 | $0.069 | 100% | 0% | 5 | 0 | 0 | 0 |
| loop-trigger | baseline | 19080 (19080–19080) | 256 | 0 | $0.061 | 0% | 100% | 15 | 0 | 0 | 0 |
| loop-trigger | hardened-steer | 26801 (26801–26801) | 1442 | 0 | $0.102 | 0% | 100% | 15 | 9 | 10 | 0 |
| loop-trigger | hardened | 0 (Infinity–-Infinity) | 0 | 0 | $0.000 | 0% | 0% | 0 | 0 | 0 | 0 |
| loop-trigger | shaped-steer | 26801 (26801–26801) | 1442 | 0 | $0.102 | 0% | 100% | 15 | 9 | 10 | 0 |
| loop-trigger | shaped | 6475 (6475–6475) | 214 | 0 | $0.023 | 100% | 0% | 5 | 2 | 3 | 0 |
| context-bloat | baseline | 67250 (67250–67250) | 340 | 0 | $0.207 | 0% | 100% | 15 | 0 | 0 | 0 |
| context-bloat | hardened-steer | 52352 (52352–52352) | 1253 | 0 | $0.176 | 0% | 100% | 17 | 1 | 12 | 0 |
| context-bloat | hardened | 0 (Infinity–-Infinity) | 0 | 0 | $0.000 | 0% | 0% | 0 | 0 | 0 | 0 |
| context-bloat | shaped-steer | 832 (832–832) | 225 | 0 | $0.006 | 0% | 0% | 3 | 0 | 0 | 0 |
| context-bloat | shaped | 27582 (27582–27582) | 223 | 0 | $0.086 | 0% | 0% | 5 | 0 | 0 | 0 |
| linear-control | baseline | 3066 (3066–3066) | 97 | 0 | $0.011 | 100% | 0% | 2 | 0 | 0 | 0 |
| linear-control | hardened-steer | 2768 (2768–2768) | 300 | 0 | $0.013 | 100% | 0% | 2 | 0 | 0 | 0 |
| linear-control | hardened | 0 (Infinity–-Infinity) | 0 | 0 | $0.000 | 0% | 0% | 0 | 0 | 0 | 0 |
| linear-control | shaped-steer | 2768 (2768–2768) | 300 | 0 | $0.013 | 100% | 0% | 2 | 0 | 0 | 0 |
| linear-control | shaped | 3066 (3066–3066) | 97 | 0 | $0.011 | 100% | 0% | 2 | 0 | 0 | 0 |

## Verdicts

- **PASS** T1 shaped <= 80% of baseline prompt tokens on context-bloat — shaped/baseline = 41%
- **FAIL** T4 shaping adds >=10pp beyond enforcement (context-bloat) — hardened->shaped = -41% of baseline
- **PASS** T2 shaped success within 10pp of hardened (all tasks) — coding-agent 0%->100%  scope-creep 0%->100%  loop-trigger 0%->100%  context-bloat 0%->0%  linear-control 0%->100%
- **PASS** T3 linear-control sanity: savings <5% and success intact — control savings 0%, success drop -100%
- **FAIL** H1 steering block messages reduce post-block turns — median turnsAfterFirstBlock 0 -> 10
- **PASS** H8 reasoning-token share of completion (info, not pass/fail) — ~0% of output tokens are <think> — suppressing on routine turns could cut output cost by roughly this much

## Summary

Core verdicts T1–T4: 3/4 passed (T1 PASS, T4 FAIL, T2 PASS, T3 PASS). Shaping thesis DOES NOT SURVIVE on meta-llama-3.1-8b-instruct.

