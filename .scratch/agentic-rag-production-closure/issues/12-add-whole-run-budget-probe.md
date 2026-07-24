# 12 — Add the whole-run resource budget probe

**What to build:** Add a command-owned deterministic probe that exercises model-call, aggregate-token, and aggregate-cost limits across an entire Answer run.

**Blocked by:** 07 — Unify SmokeEvidence status semantics; 08 — Correct probe configuration vocabulary.

**Status:** ready-for-agent

- [ ] Each configured limit can independently stop the run at the shared provider boundary.
- [ ] Missing usage or pricing data fails closed when the corresponding limit requires it.
- [ ] Budget exhaustion produces one terminal with the resource-budget degradation reason and no later provider call.

