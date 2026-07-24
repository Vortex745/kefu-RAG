# 10 — Add the cancellation convergence probe

**What to build:** Add a command-owned deterministic probe that starts an Answer run, cancels it during downstream work, and verifies propagation and exactly-once terminal convergence.

**Blocked by:** 07 — Unify SmokeEvidence status semantics; 08 — Correct probe configuration vocabulary.

**Status:** ready-for-agent

- [ ] Cancellation reaches active downstream work and produces one recognizable cancelled terminal.
- [ ] No answer content is published after cancellation and no second terminal appears.
- [ ] Timeout and probe-internal failure are distinguishable from a successful cancellation assertion.

