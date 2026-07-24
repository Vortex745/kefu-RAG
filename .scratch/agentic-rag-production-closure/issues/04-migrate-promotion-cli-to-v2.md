# 04 — Make promotion validation consume V2

**What to build:** Make the promotion command authorize only a complete, untampered V2 artifact for the exact expected revision.

**Blocked by:** 03 — Make the command-owning runner emit V2.

**Status:** ready-for-agent

- [ ] A valid V2 artifact for the expected revision passes promotion validation.
- [ ] Wrong revision, dirty worktree, failed gate, empty hard invariants, missing smoke evidence, missing rollback evidence, and hash tampering each produce a non-zero result with a specific reason.
- [ ] Non-deterministic RAGAS or Langfuse content cannot turn a failed deterministic artifact into a promoted artifact.

