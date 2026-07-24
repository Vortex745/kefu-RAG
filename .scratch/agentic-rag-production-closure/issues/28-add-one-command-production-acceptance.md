# 28 — Add one-command production acceptance

**What to build:** Provide one command that runs smoke, evaluation, full tests, TypeScript checking, backend and frontend builds, schema verification, rollback verification, V2 artifact generation, and promotion validation.

**Blocked by:** 06 — Contract V1 production authorization; 17 — Add JWKS rotation and outage acceptance; 20 — Add retrieval ACL and outage acceptance; 21 — Add live MarkItDown acceptance; 22 — Add live Marker acceptance; 23 — Add live MinerU acceptance; 27 — Enforce deterministic evaluation precedence.

**Status:** ready-for-agent

- [ ] The command exits zero only when every required deterministic gate and production probe passes for the clean trusted revision.
- [ ] Failure preserves partial redacted evidence while withholding production-ready status and returning a non-zero exit.
- [ ] The final V2 artifact passes promotion validation for the current trusted revision and contains verified rollback evidence.

