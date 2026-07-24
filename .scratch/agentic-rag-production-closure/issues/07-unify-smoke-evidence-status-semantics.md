# 07 — Unify SmokeEvidence status semantics

**What to build:** Give every probe outcome one explicit local and production decision so missing or timed-out evidence cannot fall through incompatible status unions as a pass.

**Blocked by:** 02 — Expand the Release Artifact V2 schema.

**Status:** ready-for-agent

- [ ] Passed, failed, missing, timeout, cancelled, and skipped statuses have deterministic production behavior.
- [ ] Every required production probe must pass; no unknown status is accepted.
- [ ] Optional probe absence is reported separately and cannot hide or override a required failure.

