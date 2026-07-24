# 21 — Add live MarkItDown acceptance

**What to build:** Run a bounded synthetic common-document fixture through production parser routing and verify normalized blocks, provenance, and active-version failure isolation.

**Blocked by:** 15 — Publish the smoke CLI and redacted evidence; external prerequisite OP-04 — Provide Parser Runtimes.

**Status:** ready-for-agent

- [ ] The configured MarkItDown runtime produces the expected non-empty normalized block structure and parser identity.
- [ ] Missing runtime, ABI failure, timeout, output quota, malformed output, and cancellation are explicit failures.
- [ ] A failed parse cannot activate or overwrite the previous successful knowledge version.

