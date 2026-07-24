# 15 — Publish the smoke CLI and redacted evidence

**What to build:** Provide one bounded command that runs the deterministic probe registry and writes schema-valid, revision-bound SmokeEvidence without secrets or private content.

**Blocked by:** 09 — Bind smoke evidence to profile and revision; 10 — Add the cancellation convergence probe; 11 — Add the Citation integrity probe; 12 — Add the whole-run resource budget probe; 13 — Add the graceful shutdown probe; 14 — Add executable rollback verification.

**Status:** ready-for-agent

- [ ] The CLI runs every registered deterministic probe and exits non-zero when a required probe fails.
- [ ] Evidence is written under the ignored release-artifact area and does not dirty the trusted worktree.
- [ ] Secret scanning rejects persisted JWTs, credentials, prompts, customer text, embeddings, and parser source content.

