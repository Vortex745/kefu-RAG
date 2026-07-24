# 03 — Make the command-owning runner emit V2

**What to build:** Make release verification execute its gates and produce a complete V2 artifact from observed command results rather than caller-supplied pass decisions.

**Blocked by:** 02 — Expand the Release Artifact V2 schema.

**Status:** ready-for-agent

- [ ] The runner records the trusted repository revision, dirty-worktree result, gate evidence, durations, failure categories, and V2 evidence hash.
- [ ] Missing evaluation, smoke, or rollback inputs fail production verification instead of manufacturing empty passing sections.
- [ ] Local verification remains usable but cannot produce a production-ready artifact.

