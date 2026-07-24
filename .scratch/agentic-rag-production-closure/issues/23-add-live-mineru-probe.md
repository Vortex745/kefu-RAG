# 23 — Add live MinerU acceptance

**What to build:** Run a bounded synthetic image or scanned document through production parser routing and verify OCR text, page/layout metadata, media provenance, and image chunk boundaries.

**Blocked by:** 15 — Publish the smoke CLI and redacted evidence; external prerequisite OP-04 — Provide Parser Runtimes.

**Status:** ready-for-agent

- [ ] The configured MinerU runtime returns non-empty OCR output with expected media and page provenance.
- [ ] Missing runtime, timeout, output quota, malformed output, missing media reference, and cancellation fail explicitly.
- [ ] Image bytes, OCR text, and provider payloads are excluded from persisted smoke evidence.

