# 05 — Make Mastra default startup consume V2

**What to build:** Gate default runtime startup with the same V2 artifact contract used by the promotion command, while retaining limited mode as the application-level recovery path.

**Blocked by:** 03 — Make the command-owning runner emit V2.

**Status:** ready-for-agent

- [ ] Default startup accepts a valid production V2 artifact for the deployed revision before creating runtime resources.
- [ ] Missing, malformed, stale, tampered, local-profile, or failing artifacts prevent default startup with actionable errors.
- [ ] Limited startup remains possible without a production authorization decision and does not weaken identity or data contracts.

