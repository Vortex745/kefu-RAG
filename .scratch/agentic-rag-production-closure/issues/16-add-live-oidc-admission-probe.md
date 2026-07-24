# 16 — Add live OIDC admission acceptance

**What to build:** Exercise enforced access through the real HTTP issuer, identity adapter, and access middleware so verified claims are proven to become the correct tenant-bound AccessContext.

**Blocked by:** 15 — Publish the smoke CLI and redacted evidence; external prerequisite OP-02 — Provide Controlled OIDC Acceptance Tenant.

**Status:** ready-for-agent

- [ ] A valid signed token with the configured issuer, audience, and claims is admitted with the expected tenant, subject, groups, and scopes.
- [ ] Wrong issuer, audience, signature, expiry, not-before, and missing tenant claim are rejected.
- [ ] Tokens and authorization headers are absent from persisted smoke evidence and diagnostic tails.

