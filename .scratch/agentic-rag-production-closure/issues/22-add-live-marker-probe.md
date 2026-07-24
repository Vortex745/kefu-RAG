# 22 — Add live Marker acceptance

**What to build:** Run a bounded synthetic PDF through production parser routing and verify reading order, pages, sections, equations, tables, and provenance survive normalization.

**Blocked by:** 15 — Publish the smoke CLI and redacted evidence; external prerequisite OP-04 — Provide Parser Runtimes.

**Status:** ready-for-agent

- [ ] The configured Marker runtime returns structured output with expected page and section provenance.
- [ ] Missing runtime, timeout, output quota, malformed renderer output, and cancellation fail explicitly.
- [ ] Raw PDF content is excluded from persisted smoke evidence and failed replacement output remains inactive.

