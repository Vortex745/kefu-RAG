# 08 — Correct probe configuration vocabulary

**What to build:** Make probe prerequisite checks use the same Elasticsearch, Neo4j, SQLite, model, parser, OIDC, and Langfuse configuration names and defaults consumed by the application.

**Blocked by:** 07 — Unify SmokeEvidence status semantics.

**Status:** ready-for-agent

- [ ] Every declared prerequisite maps to a real application configuration field or an explicitly documented acceptance-only input.
- [ ] Configured services are not reported missing because of invented aliases.
- [ ] Blank and partially configured credentials fail with redacted, capability-specific evidence.

