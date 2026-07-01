# AgentMint Framework Governance Benchmarks

Reproducible governance analysis across 5 agent frameworks.
Tests 4 properties: policy enforcement, destructive command blocking,
structured audit trail, and circuit breakers.

## Run all

```bash
cd benchmarks/langgraph && node --import tsx test.ts
cd ../crewai && node --import tsx test.ts
cd ../openai-sdk && node --import tsx test.ts
cd ../anthropic && node --import tsx test.ts
cd ../swe-agent && node --import tsx test.ts
```

## Summary

| Framework | Scenarios | Policy | Enforce | Audit | Breakers | FP | Overhead |
|-----------|-----------|--------|---------|-------|----------|----|----------|
| LangGraph | 20 | NO | NO | Partial | NO | 0 | ~3us |
| CrewAI | 22 | NO | NO | Partial | NO | 0 | ~3us |
| OpenAI SDK | 22 | NO | NO | Partial | NO | 0 | ~3us |
| Anthropic | 25 | NO | NO | NO | NO | 0 | ~3us |
| SWE-Agent | 28 | NO | NO | NO | NO | 0 | ~3us |

See each framework's `results.md` for detailed findings.
