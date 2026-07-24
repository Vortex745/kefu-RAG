# 09 — Bind smoke evidence to profile and revision

**What to build:** Ensure production verification consumes only schema-valid production SmokeEvidence generated for the same trusted revision as the release artifact.

**Blocked by:** 03 — Make the command-owning runner emit V2; 07 — Unify SmokeEvidence status semantics; 08 — Correct probe configuration vocabulary.

**Status:** ready-for-agent

- [ ] Production verification rejects local-profile, wrong-revision, malformed, and internally inconsistent smoke evidence.
- [ ] Smoke evidence revision and profile are covered by the production evidence hash.
- [ ] A valid matching production evidence document reaches the release runner without unsafe type casts.

