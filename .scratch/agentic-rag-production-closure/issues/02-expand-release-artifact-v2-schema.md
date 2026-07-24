# 02 — Expand the Release Artifact V2 schema

**What to build:** Add a versioned production release contract beside the existing artifact so revision, profile, deterministic gates, smoke evidence, rollback evidence, dirty-worktree state, evidence hash, and non-deterministic reports have one validated shape.

**Blocked by:** 01 — Retire deleted-document-only assertions.

**Status:** ready-for-agent

- [ ] V2 accepts a complete production artifact and returns actionable validation errors for every missing or malformed required field.
- [ ] V1 and V2 remain distinguishable during the expansion period, and adding V2 does not break existing local verification behavior.
- [ ] Hash canonicalization excludes non-deterministic reports while covering every field that can authorize production.

