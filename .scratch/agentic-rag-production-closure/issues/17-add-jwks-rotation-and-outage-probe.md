# 17 — Add JWKS rotation and outage acceptance

**What to build:** Prove that enforced identity accepts a controlled new signing key without process restart and fails closed for unknown keys or JWKS unavailability.

**Blocked by:** 16 — Add live OIDC admission acceptance.

**Status:** ready-for-agent

- [ ] A token signed by the pre-rotation key succeeds before rotation and a token signed by the new key succeeds after rotation without restart.
- [ ] Unknown key IDs, tampered signatures, and JWKS outage are rejected and never create AccessContext.
- [ ] Rotation evidence records only safe issuer, audience, key-transition, and outcome metadata.

