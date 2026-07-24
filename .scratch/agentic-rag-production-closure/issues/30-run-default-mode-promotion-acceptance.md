# 30 — Run default-mode promotion acceptance

**What to build:** Promote the same limited-mode candidate to default using the same revision and V2 artifact, then repeat critical runtime acceptance and artifact rejection checks.

**Blocked by:** 29 — Run limited-mode candidate acceptance.

**Status:** ready-for-agent

- [ ] Default mode starts only with the exact V2 artifact and revision that passed limited acceptance.
- [ ] Missing, stale, local-profile, tampered, or failing artifacts are rejected before runtime resources are created.
- [ ] Critical production smoke and graceful shutdown pass in default mode with exactly one terminal per Answer run.

