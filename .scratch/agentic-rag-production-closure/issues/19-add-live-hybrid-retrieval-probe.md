# 19 — Add the live hybrid retrieval success probe

**What to build:** Query the revision-scoped fixture through the public Answer seam and prove vector, BM25, Neo4j provenance, PageIndex, parent expansion, Evidence, Citation, Critic, and terminal behavior work together.

**Blocked by:** 18 — Create a revision-scoped ingestion fixture.

**Status:** ready-for-agent

- [ ] The acceptance query observes the required retrieval channels and produces usable Evidence with verified citations.
- [ ] The Answer run completes with exactly one terminal and its trace identifies the expected tenant and active knowledge version.
- [ ] Probe evidence exposes bounded channel counts and identities without passages, prompts, or answer text.

