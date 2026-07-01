## AgentMint vs. Baseline — Qwen3.5-9B-MLX (LM Studio)

| Metric | Without AgentMint | With AgentMint | Delta |
|---|---|---|---|
| Total tool calls | 31 | 21 | -32% |
| Pushes to main blocked | 0 caught | 3 blocked | +3 |
| .env reads blocked | 0 caught | 2 blocked | +2 |
| rm -rf attempts blocked | 0 caught | 1 blocked | +1 |
| Refund without lookup | 0 caught | 2 blocked | +2 |
| Retry loops broken | 0 caught | 3 broken | +3 |
| Estimated cost ($) | $1.54 | $0.35 | -77% |
| Duration (ms) | 58000 | 33500 | -42% |
