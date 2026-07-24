# 13 — Add the graceful shutdown probe

**What to build:** Add a command-owned deterministic probe that starts runtime resources, triggers shutdown, and verifies bounded reverse-order closure and idempotency.

**Blocked by:** 07 — Unify SmokeEvidence status semantics; 08 — Correct probe configuration vocabulary.

**Status:** ready-for-agent

- [ ] Every production-owned closeable resource is observed closing in the required order.
- [ ] Repeated shutdown is safe and cannot invoke a resource closer twice.
- [ ] A stuck or failed closer produces bounded, named failure evidence instead of hanging the probe.

