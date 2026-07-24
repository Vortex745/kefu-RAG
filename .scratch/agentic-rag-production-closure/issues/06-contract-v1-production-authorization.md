# 06 — Contract V1 production authorization

**What to build:** Finish the artifact migration by preventing legacy V1 evidence from authorizing promotion or default startup while preserving diagnostic readability.

**Blocked by:** 04 — Make promotion validation consume V2; 05 — Make Mastra default startup consume V2.

**Status:** ready-for-agent

- [ ] Promotion and default startup reject V1 with an explicit unsupported-production-schema reason.
- [ ] Existing V1 artifacts can still be parsed or displayed for diagnosis without being rewritten as V2.
- [ ] The full release, promotion, and startup regression suite remains green after the old authorization path is removed.

