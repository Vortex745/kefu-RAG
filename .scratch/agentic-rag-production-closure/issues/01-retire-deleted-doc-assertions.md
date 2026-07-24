# 01 — Retire deleted-document-only assertions

**What to build:** Restore a truthful green deterministic baseline without recreating documentation that the user intentionally deleted. Preserve every assertion that still protects a live source or runtime contract.

**Blocked by:** External prerequisite OP-01 — Restore Trusted Repository Provenance.

**Status:** ready-for-agent

- [ ] Each current missing-document failure is classified as deleted-history-only or current source/runtime behavior, with mixed tests split instead of removed wholesale.
- [ ] The deleted documentation remains absent and broken navigation references are redirected only to current sources.
- [ ] `npm test`, TypeScript checking, backend build, and diff validation pass from the restored trusted repository.

