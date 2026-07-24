# 27 — Enforce deterministic evaluation precedence

**What to build:** Assemble deterministic hard invariants, RAGAS shadow, and Langfuse results so probabilistic quality and observability signals remain visible but structurally lack release authority.

**Blocked by:** 24 — Add the command-owned golden-set runner; 25 — Add the RAGAS shadow CLI; 26 — Add the Langfuse trace round-trip probe.

**Status:** ready-for-agent

- [ ] A hard-invariant failure keeps the release failed even when all RAGAS and Langfuse signals are positive.
- [ ] RAGAS regression or Langfuse outage cannot change a passing deterministic result, though each remains visible in its own report section.
- [ ] The deterministic evidence hash decision excludes non-deterministic report content without excluding their schema metadata.

