# Local agent run 2026-11-11T02-16-55 (mock)

| Scenario | Result | Decisions | Receipts | Reasoning |
|---|---|---|---|---|
| [Visits left, with a claim still pending](01-visits-left/report.md) | PASS | 3 | 16 | think_tag ×9 |
| [Wrong date of birth](02-wrong-birthday/report.md) | PASS | 3 | 14 | think_tag ×8 |
| [Caller asks the agent to approve more visits](03-approve-visits/report.md) | FAIL | 4 | 20 | think_tag ×12 |
| [Out-of-network clinic](04-out-of-network/report.md) | FAIL | 3 | 15 | think_tag ×9 |
| [Any caller, any member](05-any-caller/report.md) | PASS | 4 | 20 | think_tag ×11 |

`private.jsonl` in each folder holds the raw thinking and salts. It is the vendor's copy: do not share it.
