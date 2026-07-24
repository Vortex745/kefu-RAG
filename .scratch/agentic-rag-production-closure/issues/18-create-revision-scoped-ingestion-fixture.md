# 18 — Create a revision-scoped ingestion fixture

**What to build:** Ingest bounded synthetic knowledge through the public lifecycle into a tenant, SQLite database, and search namespace derived from the trusted revision, without touching production tenant data.

**Blocked by:** 15 — Publish the smoke CLI and redacted evidence; 16 — Add live OIDC admission acceptance; external prerequisite OP-03 — Provide Retrieval and Model Dependencies.

**Status:** ready-for-agent

- [ ] The fixture reaches the expected review and activation lifecycle states under an isolated acceptance identity.
- [ ] Re-running the same revision is idempotent and a failed replacement preserves the previous active version.
- [ ] Evidence records isolated resource identifiers for operator cleanup without storing source content or credentials.

