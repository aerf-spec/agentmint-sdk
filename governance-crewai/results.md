# Results

Generated: 2026-07-01T00:51:33.458Z

## Summary

- Runtime-tested scenarios: 27
- PASS: 19
- FAIL: 5
- PARTIAL: 0
- INFO: 3

Comparison boundary:
- AgentMint results below are runtime-tested from `test.ts`.
- CrewAI conclusions are source-researched from `research.md`; this harness does not execute CrewAI itself.

## Results Table

| ID | Area | Expected | Verdict | Observed | Notes |
| --- | --- | --- | --- | --- | --- |
| P1 | Policy | Block `send_email` without prior `analyze_data`. | PASS | Blocked before execution. | Reason: requires |
| P2 | Policy | Block `generate_report` without prior `analyze_data`. | PASS | Blocked before execution. | Reason: requires |
| P3 | Policy | Block `create_crm_record` without prior `web_search`. | PASS | Blocked before execution. | Reason: requires |
| P4 | Policy | Block `update_crm_record` without prior `create_crm_record`. | PASS | Blocked before execution. | Reason: requires |
| P5 | Policy | Allow the full compliant chain. | PASS | All four steps executed cleanly. | Raw tool executions: 4; AgentMint events: 4. |
| P6 | Policy | Block `send_email` when `web_search` happened but `analyze_data` did not. | PASS | Blocked after partial chain. | Reason: requires |
| E1 | Enforcement | After prerequisites are satisfied, block competitor email domain via `blocked_patterns`. | FAIL | Allowed competitor domain. | This directly probes wildcard pattern enforcement instead of being short-circuited by the `requires` rule. |
| E2 | Enforcement | After prerequisites are satisfied, block personal email domain via `blocked_patterns`. | FAIL | Allowed personal domain. | This isolates wildcard pattern enforcement from the prerequisite gate. |
| E3 | Enforcement | Allow valid email after analysis. | PASS | Allowed clean send. | Events: web_search:allowed, analyze_data:allowed, send_email:allowed |
| E4 | Enforcement | Detect CRM update mismatch. In the current spec semantics, this should warn unless `action: block` is attached to the property or tool. | PASS | Allowed execution, but emitted a `cross_ref` warning. | Summary: allowed=true, warned=1, outcomes=warned -> allowed |
| E5 | Enforcement | Allow CRM update when `id` matches created record. | PASS | Allowed matching cross-ref. | Raw tool executions: web_search -> create_crm_record -> update_crm_record |
| E6 | Enforcement | Block destructive delete tool. | FAIL | Allowed delete despite `action: block` in the spec. | This surfaces whether bare tool-level `action: block` is enforced without any additional property rule. |
| E7 | Enforcement | Block mass-update tool. | FAIL | Allowed bulk update despite `action: block` in the spec. | This checks the same bare tool-level block path on a second destructive operation. |
| A1 | Audit | AgentMint event log should match the clean framework execution path and include timestamps. | PASS | Raw execution log and AgentMint allowed-event log matched 1:1. | Raw calls: web_search -> read_document -> analyze_data -> generate_report -> create_crm_record -> send_email. Event outcomes: web_search:allowed, read_document:allowed, analyze_data:allowed, generate_report:allowed, create_crm_record:allowed, send_email:allowed |
| A2 | Audit | Audit should preserve all three `send_email` outcomes, even though only the successful one reaches the underlying tool. | FAIL | Outcome sequence did not match expected audit pattern. | Raw send_email executions: 2. Event outcomes: blocked, allowed, allowed. The second outcome reveals whether wildcard email blocking actually fires. |
| B1 | Breakers | Loop breaker should trigger on repeated identical calls. | PASS | Outcome pattern: allowed, allowed, blocked, blocked, blocked. | Event reasons: allowed, allowed, loop_breaker, loop_breaker, loop_breaker |
| B2 | Breakers | Different queries should not look like a loop. | PASS | All three distinct searches were allowed. | Outcome pattern: allowed, allowed, allowed |
| B3 | Breakers | Velocity breaker should trip once the burst reaches call 8 in the 30s window. | PASS | First blocked rapid call appeared at position 8. | Used a breaker-only harness so policy rules would not mask the velocity limiter. |
| B4 | Breakers | Three calls with 5-second gaps should stay under the velocity threshold. | PASS | All spaced calls were allowed. | This scenario uses real 5-second waits because the breaker uses wall-clock time. |
| C1 | Clean Runs | Perfect research workflow should complete with zero violations. | PASS | Completed with zero blocks and zero warnings. | Summary: blocked=0, warned=0 |
| C2 | Clean Runs | Read-only research path should complete with zero violations. | PASS | Completed with zero violations. | Event outcomes: allowed, allowed, allowed |
| X1 | Edge Cases | A tool absent from the spec should execute normally. | PASS | Allowed unspecced tool. | Raw executions: 1 |
| X2 | Edge Cases | No default framework rule should block an incomplete analysis unless explicitly modeled. | PASS | Report generation still proceeded from completeness=0.4. | This mirrors the prompt's concern: the spec has no completeness guard, so neither the raw workflow nor AgentMint flags it by default. |
| X3 | Edge Cases | Seven-step valid chain should complete without depth-related breakage. | PASS | Seven-step chain completed cleanly. | Executed path: web_search -> read_document -> analyze_data -> generate_report -> create_crm_record -> update_crm_record -> send_email |
| L1 | Latency | Measure 100 raw calls. | INFO | 1.70 ms for 100 raw calls. | Raw benchmark used direct tool execution with no governance wrapper. |
| L2 | Latency | Measure 100 wrapped AgentMint calls. | INFO | 1.49 ms for 100 AgentMint-wrapped calls. | Used a minimal `ping` tool with no spec rules to isolate wrapper overhead. |
| L3 | Latency | Report wrapper overhead. | INFO | -0.21 ms total overhead, -0.0021 ms per call. | Not directly comparable to CrewAI tool latency because this harness measures AgentMint only. |

## Honest Assessment

- AgentMint enforced prerequisites, cross-reference warnings, loop breaking, and velocity limiting correctly in this run.
- Two real implementation gaps were exposed. First, bare tool-level `action: block` rules did not stop `delete_crm_record` or `bulk_update_crm`. Second, `blocked_patterns` behaved like plain substring checks, so glob-like patterns such as `*@competitor.com` and `*@personal.com` were not enforced as written in the prompt.
- The audit scenarios showed the practical difference between underlying tool logs and governance logs: blocked calls never reached the raw tool functions, but they were still recorded in AgentMint's event stream when a blocking rule actually fired.
- The incomplete-analysis edge case stayed allowed, which is the correct result for this spec. If you want `completeness < 1.0` to stop downstream steps, that rule has to be modeled explicitly.
- CrewAI already has useful governance primitives, but based on docs and source it does not currently match this spec style out of the box. The biggest gaps are declarative tool dependencies, cross-tool lineage validation, delegation-loop detection, and framework-level tool-call rate limiting.
- CrewAI's structured outputs are best-effort rather than fail-closed. That is a meaningful distinction if governance depends on guaranteed typed handoffs.
