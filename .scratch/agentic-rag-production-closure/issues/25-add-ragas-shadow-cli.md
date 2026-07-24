# 25 — Add the RAGAS shadow CLI

**What to build:** Run the existing bounded RAGAS evaluator over the command-owned golden-set results in the pinned offline Python environment and persist a non-blocking shadow report.

**Blocked by:** 24 — Add the command-owned golden-set runner; external prerequisite OP-05 — Provide Evaluation and Observability Runtimes.

**Status:** ready-for-agent

- [ ] Fixed evaluator model identities and run counts produce a reproducible versioned shadow report with variance.
- [ ] Missing Python runtime, timeout, malformed output, output overflow, and evaluator failure are explicit bounded outcomes.
- [ ] RAGAS execution remains outside the online Answer runtime and cannot change deterministic gate results.

