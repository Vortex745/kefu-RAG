# 26 — Add the Langfuse trace round-trip probe

**What to build:** Emit a bounded redacted acceptance trace through the real Langfuse client and verify that the expected trace can be observed when production observability is configured.

**Blocked by:** 15 — Publish the smoke CLI and redacted evidence; external prerequisite OP-05 — Provide Evaluation and Observability Runtimes.

**Status:** ready-for-agent

- [ ] A configured run creates and retrieves the expected trace identity and safe event metadata.
- [ ] Partial credentials, endpoint outage, timeout, and client failure produce explicit optional-observability outcomes.
- [ ] Prompts, answers, tokens, credentials, tenant-private content, and authorization data are absent from persisted reports.

