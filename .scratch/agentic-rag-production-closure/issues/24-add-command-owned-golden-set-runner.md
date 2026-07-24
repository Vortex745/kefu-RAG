# 24 — Add the command-owned golden-set runner

**What to build:** Execute the committed evaluation set through the public Answer run seam and generate bounded CaseResult evidence from the shipped workflow.

**Blocked by:** 18 — Create a revision-scoped ingestion fixture; 20 — Add retrieval ACL and outage acceptance.

**Status:** ready-for-agent

- [ ] Every committed golden case produces an observed terminal, latency, token count, retrieved Evidence identities, citations, and degradation status.
- [ ] A case timeout, cancellation, malformed terminal, or provider failure is explicit and cannot be silently dropped from the dataset.
- [ ] The output is accepted directly by deterministic hard-invariant evaluation without caller-supplied pass fields.

