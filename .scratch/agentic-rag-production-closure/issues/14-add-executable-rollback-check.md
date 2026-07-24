# 14 — Add executable rollback verification

**What to build:** Prove that the accepted build can start in limited mode on an isolated port, answer a health check, and shut down cleanly before rollback evidence is marked verified.

**Blocked by:** 03 — Make the command-owning runner emit V2; 13 — Add the graceful shutdown probe.

**Status:** ready-for-agent

- [ ] Rollback evidence is verified only after limited startup, health, and graceful shutdown all succeed.
- [ ] Startup timeout, health failure, process exit, or incomplete shutdown leaves rollback evidence unverified.
- [ ] The check does not migrate, truncate, or delete business data.

