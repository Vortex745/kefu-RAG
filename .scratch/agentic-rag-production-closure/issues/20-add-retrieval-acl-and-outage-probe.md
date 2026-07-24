# 20 — Add retrieval ACL and outage acceptance

**What to build:** Prove the same hybrid retrieval path preserves tenant and group authorization during normal operation and dependency degradation.

**Blocked by:** 19 — Add the live hybrid retrieval success probe.

**Status:** ready-for-agent

- [ ] Cross-tenant and unauthorized-group queries return no usable Evidence across every retrieval channel.
- [ ] A single Elasticsearch, Neo4j, or reranker failure reports explicit degradation without bypassing ACL or Citation gates.
- [ ] Total retrieval failure converges to one insufficient-evidence terminal and never fabricates a grounded answer.

