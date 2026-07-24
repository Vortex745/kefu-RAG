# 29 — Run limited-mode candidate acceptance

**What to build:** Start the accepted revision in limited mode with the V2 evidence available and prove the bounded rollout mode remains healthy under critical production smoke.

**Blocked by:** 28 — Add one-command production acceptance.

**Status:** ready-for-agent

- [ ] Limited mode starts the accepted build, passes health, and reports the expected runtime mode and revision.
- [ ] Critical identity, retrieval, cancellation, Citation, budget, and shutdown probes pass against the running candidate.
- [ ] Failure keeps default promotion blocked and leaves sufficient redacted evidence for diagnosis.

