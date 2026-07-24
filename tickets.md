# Agentic RAG Production Closure Tracker

Status: `ready-for-agent`
Updated at: 2026-07-24
Authority: This tracker supersedes references to the absent `docs/remaining-repair-closure-spec.md` and `.scratch/remaining-repair-closure/issues/` tracker. It does not restore any user-deleted historical file.

## Master Specification

### Problem Statement

The repository has a substantially complete controlled Agentic RAG Answer lifecycle, including routing, bounded retrieval, Evidence and Citation validation, Critic correction, memory, Handoff, cancellation, terminal convergence, and whole-run resource budgets. It cannot yet produce a trustworthy production promotion decision because repository provenance is unavailable, the full deterministic test gate is red, live smoke probes have declarations but no production caller, smoke evidence contracts disagree, release and Mastra startup gates consume incompatible artifact types, rollback evidence is not command-owned, and required external services are unavailable.

The production closure must be reproducible, fail closed, revision-bound, redacted, and executable without caller-supplied pass booleans. Missing OIDC, retrieval, parser, or deterministic evidence must never be represented as a production pass. Non-deterministic RAGAS and Langfuse signals must remain visible without overriding deterministic failures.

### Solution

Create one repository-owned production acceptance path. Command-owning probes generate validated SmokeEvidence from real capabilities. A command-owning evaluator generates deterministic hard-invariant input plus non-deterministic RAGAS and Langfuse reports. A single Release Artifact V2 binds those results to a clean Git revision, verified rollback evidence, and the production profile. Promotion validation and Mastra default startup consume only that artifact. Limited mode remains the application-level recovery path.

Execution follows Graph Engineering: one ticket per round, independent Executor implementation, independent Supervisor verification, explicit dependency edges, and no downstream acceptance while an upstream node is blocked.

### User Stories

1. As a release operator, I want every production decision bound to a trusted Git revision, so that I can identify exactly what is being promoted.
2. As a release operator, I want a dirty or unknown worktree to fail closed, so that unreviewed code cannot be promoted.
3. As a maintainer, I want deleted historical documentation to stay deleted, so that stale artifacts are not silently restored to satisfy tests.
4. As a maintainer, I want the full deterministic test gate green, so that release evidence starts from a valid repository baseline.
5. As a release operator, I want one canonical release artifact, so that the CLI and runtime startup cannot disagree about readiness.
6. As a release operator, I want smoke evidence schema, profile, and revision validated, so that stale or unrelated evidence cannot be reused.
7. As a security owner, I want missing, skipped, failed, and timed-out required probes to block production, so that absence of evidence is never treated as evidence of success.
8. As a security owner, I want optional observability probes distinguished from required safety probes, so that optional outages are reported honestly without corrupting deterministic policy.
9. As an operator, I want probe prerequisites to use the application's real configuration vocabulary, so that configured services are not reported missing under invented variable names.
10. As an identity owner, I want live issuer, audience, signature, claims, and JWKS rotation checked, so that enforced access mode is proven against a real trust boundary.
11. As an identity owner, I want invalid issuer, audience, key ID, expiry, and JWKS outage to fail closed, so that identity degradation cannot become anonymous access.
12. As a tenant owner, I want isolated ingestion and retrieval acceptance, so that release probes cannot read or mutate production tenant data.
13. As a tenant owner, I want cross-tenant and cross-group queries to return no evidence, so that hybrid retrieval preserves authorization in every channel.
14. As a support user, I want vector, BM25, graph, PageIndex, reranking, Evidence, and Citation behavior tested together, so that production retrieval is verified as an end-to-end flow.
15. As a support user, I want dependency outages to converge to an explicit degraded or insufficient-evidence terminal, so that partial failures do not fabricate grounded answers.
16. As an ingestion operator, I want MarkItDown, Marker, and MinerU tested with bounded fixtures, so that advertised parser capabilities are genuinely available.
17. As a knowledge owner, I want parser failures to preserve the previous active version, so that a broken replacement cannot corrupt live knowledge.
18. As an evaluator, I want the committed golden set executed through the public Answer seam, so that evaluation measures the shipped workflow.
19. As an evaluator, I want RAGAS isolated in a pinned Python environment, so that offline evaluation cannot destabilize the online Node runtime.
20. As an observability operator, I want a real Langfuse trace round trip when configured, so that trace export is verified rather than assumed.
21. As a release owner, I want RAGAS and Langfuse reports structurally unable to override hard-invariant failures, so that non-deterministic quality signals cannot weaken safety gates.
22. As a release owner, I want cancellation, graceful shutdown, citation integrity, and resource-budget behavior verified without external dependencies, so that core controls always have runnable evidence.
23. As a release owner, I want rollback evidence generated by an executable check, so that rollback is a tested capability rather than prose.
24. As an operator, I want one acceptance command with a non-zero failure exit, so that automation can consume the production decision reliably.
25. As an operator, I want limited startup verified before default startup, so that promotion has a bounded application-level rollout step.
26. As an auditor, I want redacted artifacts with hashes and timestamps, so that evidence can be inspected without exposing tokens or customer content.
27. As a maintainer, I want every implementation ticket independently mergeable, so that an external dependency cannot block unrelated release improvements.
28. As a maintainer, I want state files updated after every accepted ticket, so that a later session can resume from verified evidence.

### Implementation Decisions

- The highest behavior seams are SmokeEvidence, the public Answer run event stream, and one canonical Release Artifact V2. No parallel release-decision path will be introduced.
- Release Artifact V2 replaces both current persisted release artifact shapes for promotion and default startup. V1 artifacts remain readable only for diagnostics and cannot authorize default production startup.
- Production smoke is command-owned. Probe implementations invoke the real capability and return observable results; callers cannot supply pass booleans.
- Probe requiredness is evaluated against registry declarations. Required production probes must pass. Optional probe failures are reported separately and cannot convert a deterministic failure into a pass.
- Smoke evidence is bound to the production profile and the same repository revision as the release artifact.
- The probe registry uses the existing application configuration vocabulary for Elasticsearch, Neo4j, SQLite, models, parser commands, OIDC, and Langfuse.
- Identity acceptance uses enforced access mode and validates both live admission and controlled JWKS rotation. AccessContext is constructed only from verified claims.
- Retrieval acceptance uses a Git-revision-derived tenant, SQLite database, and search index namespace. It never reuses a production tenant identifier.
- Parser acceptance uses bounded, synthetic, non-private fixtures and the existing parser process safety limits.
- Deterministic hard invariants remain release blocking. RAGAS shadow and Langfuse reports remain non-deterministic sections with no authority over the deterministic decision.
- Rollback verification executes limited-mode startup, health checking, and graceful shutdown. It does not delete or migrate business data.
- Release artifacts are written under the ignored `.release-artifacts` directory so producing evidence does not dirty the worktree.
- Platform-specific deployment, traffic splitting, secret provisioning, and external resource cleanup remain operator responsibilities.

### Testing Decisions

- Tests assert observable exit codes, artifact contents, event sequences, authorization results, and external effects. They do not assert private helper structure.
- Existing release runner, smoke harness, promotion, Mastra startup gate, identity adapter, ingestion lifecycle, Searcher, parser adapters, Answer event stream, RAGAS evaluator, and Langfuse smoke seams are reused.
- Contract tests cover malformed JSON, wrong schema version, wrong profile, wrong revision, hash tampering, dirty worktree, missing rollback evidence, missing required probes, timeout, cancellation, and partial external failure.
- Identity tests cover valid rotation plus invalid issuer, audience, expiry, not-before, key ID, claims, and JWKS outage.
- Retrieval tests cover the happy path, zero-result path, cross-tenant denial, cross-group denial, single dependency degradation, and total retrieval failure.
- Parser tests cover successful normalized output, missing executable, timeout, output quota, malformed output, cancellation, and active-version preservation.
- Evaluation tests prove deterministic precedence when RAGAS regresses or Langfuse is unavailable.
- Final verification runs focused tests first, then `npm test`, `npx tsc --noEmit`, `npm run build`, `npm run build:frontend`, schema verification, release acceptance, and promotion validation.

### Out of Scope

- Cloud-provider deployment automation, Kubernetes manifests, traffic splitting, and DNS changes.
- Restoring deleted historical documentation or tracker directories.
- Replacing Mastra, Elasticsearch, Neo4j, SQLite, the parser stack, or the model provider.
- Adding write-capable autonomous business tools, CRM actions, refunds, orders, or general ReAct behavior.
- Deleting production tenant data or automatically cleaning external acceptance resources.
- Allowing RAGAS, Langfuse, or other probabilistic metrics to override deterministic release gates.

### Further Notes

- Current environment evidence: `.git` is absent; Elasticsearch and Neo4j ports are closed; OIDC, Langfuse, and Mastra promotion configuration is absent; MarkItDown fails on a Python 3.14/NumPy ABI mismatch; Marker, MinerU, and RAGAS are unavailable.
- The load-bearing assumption is that trusted Git metadata can be recovered. Without it, no production artifact can provide reliable provenance and the runtime must remain in limited mode.
- No ticket may request secrets in an artifact. Tokens, credentials, prompts, customer text, embeddings, and parser source content must be removed before evidence is persisted.

## Dependency Graph

```text
OP-01 Trusted Git provenance
  -> 01 Green deterministic baseline
      -> 02 Canonical Release Artifact V2
          -> 03 SmokeEvidence contract and registry correction
              -> 04 Deterministic probes and rollback check
                  -> 05 Live OIDC admission and rotation [also OP-02]
                  -> 06 Isolated ingestion and hybrid retrieval [also OP-03, 05]
                  -> 07 Live parser acceptance [also OP-04]
                  -> 08 Evaluation and observability runners [also OP-05]
                      -> 09 One-command production acceptance [also 05, 06, 07]
                          -> 10 Limited/default final acceptance and closeout
```

Initial frontier: Ticket 01 after OP-01 is satisfied. Tickets 02-04 are then agent-executable without live external services.

## Operator Prerequisites

### OP-01 — Restore Trusted Repository Provenance

Owner: Operator

Recover the original `.git` directory from the trusted remote clone or last trusted backup. Do not create a new unrelated history with `git init`.

Acceptance:

- `git rev-parse HEAD` returns the trusted revision.
- `git status --porcelain` executes successfully.
- The current working tree is reviewed and committed on a non-main release branch before final production acceptance.

### OP-02 — Provide Controlled OIDC Acceptance Tenant

Owner: Operator

Provide an issuer, audience, JWKS endpoint, acceptance client, tenant claim mapping, and a controlled two-key rotation path. Credentials remain environment-only.

### OP-03 — Provide Retrieval and Model Dependencies

Owner: Operator

Start Elasticsearch and Neo4j, provision an isolated acceptance tenant, and provide chat and embedding provider configuration with bounded quotas.

### OP-04 — Provide Parser Runtimes

Owner: Operator

Repair MarkItDown in a compatible Python environment and install working Marker and MinerU commands. Each command must pass its own help/version invocation before acceptance.

### OP-05 — Provide Evaluation and Observability Runtimes

Owner: Operator

Create a Python 3.11 or 3.12 RAGAS virtual environment from the pinned requirements and provide Langfuse endpoint and credentials when live observability acceptance is required.

## Ready-For-Agent Tickets

### Ticket 01 — Restore a Green Deterministic Baseline

Status: `ready-for-agent`
Blocked by: OP-01

Outcome: The repository has a truthful green baseline without restoring deleted history.

Scope:

- Classify each of the nine current missing-document failures as deleted-history-only or current runtime contract.
- Retire only deleted-history-only assertions.
- Replace broken agent navigation targets with existing, current sources.
- Preserve source/runtime assertions in mixed tests.

Acceptance:

- The five deleted documentation files remain absent.
- `npm test`, `npx tsc --noEmit`, `npm run build`, and `git diff --check` exit 0.
- `verify.json` records the exact retired assertions and retained runtime assertions.

Rollback: Revert only the test and navigation changes. No runtime or data change is permitted.

### Ticket 02 — Establish Canonical Release Artifact V2

Status: `ready-for-agent`
Blocked by: Ticket 01

Outcome: Promotion validation and Mastra default startup consume one revision-bound artifact contract.

Scope:

- Define Release Artifact V2 with production profile, repository revision, deterministic gates, smoke metadata, evidence hash, dirty-worktree state, rollback evidence, and non-deterministic reports.
- Make the command-owning release runner produce V2.
- Make promotion validation and Mastra default startup validate V2.
- Reject V1 for production authorization while preserving diagnostic readability.

Acceptance:

- Valid V2 passes schema and hash validation.
- Wrong profile, revision, hash, dirty state, empty hard invariants, missing smoke evidence, or missing rollback evidence fails closed.
- Default startup rejects V1 and malformed artifacts; limited startup remains available.
- Focused release, promotion, and startup tests plus TypeScript checking pass.

Rollback: Return the runtime to limited mode; no persisted application schema changes exist.

### Ticket 03 — Correct SmokeEvidence Contract and Registry Semantics

Status: `ready-for-agent`
Blocked by: Ticket 02

Outcome: Smoke evidence has one validated status model and uses real application configuration names.

Scope:

- Align release runner consumption with SmokeEvidence rather than the legacy loose smoke-result cast.
- Treat missing, failed, timeout, cancelled, and skipped required production probes as failures.
- Permit optional observability probes to report absence without changing deterministic pass/fail.
- Replace invented prerequisite names with the configuration names already consumed by the application.
- Bind smoke profile and repository revision to the release artifact.

Acceptance:

- Every registry status has an explicit production decision.
- Required timeout and missing implementation cannot pass through status mismatch.
- Optional Langfuse absence is reported but cannot hide a deterministic failure.
- Wrong-profile or wrong-revision smoke evidence is rejected.
- Focused smoke harness and runner tests pass.

Rollback: Restore the prior contract in release-only modules; the online Answer path remains untouched.

### Ticket 04 — Add Deterministic Probes and Executable Rollback Evidence

Status: `ready-for-agent`
Blocked by: Ticket 03

Outcome: Core controls and rollback can be verified without external services.

Scope:

- Add command-owning probes for cancellation, graceful shutdown, citation integrity, and whole-run call/token/cost budgets.
- Add an executable rollback check that starts limited mode on an isolated port, verifies health, triggers shutdown, and records closer completion.
- Add a smoke CLI that writes redacted evidence under `.release-artifacts`.

Acceptance:

- Each deterministic probe passes on the current implementation and fails when its observable invariant is deliberately broken in a test fixture.
- Cancellation and budget exhaustion emit exactly one terminal event.
- Rollback evidence is marked verified only after startup, health, and graceful shutdown succeed.
- Evidence contains no tokens, prompts, customer text, embeddings, or secrets.

Rollback: Remove the release-only probe registrations and CLI; no online runtime behavior changes.

### Ticket 05 — Add Live OIDC Admission and Rotation Acceptance

Status: `ready-for-agent`
Blocked by: Ticket 04, OP-02

Outcome: Enforced identity is proven against a real HTTP issuer and controlled key rotation.

Scope:

- Add live admission and JWKS rotation probe implementations through the existing identity adapter and access middleware seam.
- Verify configured claim mapping produces the expected tenant, subject, groups, and scopes only after signature validation.
- Redact all JWTs and authorization material before evidence persistence.

Acceptance:

- Valid pre-rotation and post-rotation tokens are accepted at the correct stage.
- Wrong issuer, audience, expiry, not-before, key ID, signature, tenant claim, and JWKS outage are rejected.
- Rotation does not require process restart.
- Production smoke marks the identity capability passed only after both admission and rotation succeed.

Rollback: Set runtime to limited mode; do not weaken enforced identity in a production profile.

### Ticket 06 — Add Isolated Ingestion and Hybrid Retrieval Acceptance

Status: `ready-for-agent`
Blocked by: Ticket 04, Ticket 05, OP-03

Outcome: A revision-scoped fixture proves the real ingestion-to-grounded-answer path without touching production tenant data.

Scope:

- Create a bounded synthetic source under a Git-revision-derived acceptance tenant and resource namespace.
- Ingest through the public lifecycle and query through the public Answer seam.
- Verify vector, BM25, Neo4j provenance, PageIndex, parent expansion, Evidence, Citation, Critic, and terminal behavior.
- Record isolated external resource identifiers for operator cleanup.

Acceptance:

- The happy path completes with verified citations and one terminal event.
- Cross-tenant and unauthorized-group queries return no usable evidence.
- A single retrieval dependency outage reports degradation without bypassing authorization.
- Total retrieval failure converges to `insufficient_evidence`.
- Previous active knowledge remains available when a replacement fails.

Rollback: Stop using the isolated acceptance namespace. No automatic deletion of external data is performed.

### Ticket 07 — Add Live Parser Acceptance

Status: `ready-for-agent`
Blocked by: Ticket 04, OP-04

Outcome: MarkItDown, Marker, and MinerU are verified as bounded production capabilities.

Scope:

- Add bounded synthetic document, PDF, and image fixtures with stable identities.
- Invoke each existing parser adapter through the production routing and process-safety seams.
- Verify normalized blocks, structure, page/media provenance, and active-version failure isolation.

Acceptance:

- All three parser probes pass with expected normalized output and provenance.
- Missing executable, timeout, output limit, malformed output, and cancellation produce explicit failures.
- Failed replacement parsing cannot activate or overwrite the previous successful version.
- Raw document text and image bytes are excluded from persisted smoke evidence.

Rollback: Disable the failing parser command and remain on the previous active knowledge version.

### Ticket 08 — Add Command-Owned Evaluation and Observability Runners

Status: `ready-for-agent`
Blocked by: Ticket 02, Ticket 04, OP-05

Outcome: Deterministic evaluation, RAGAS shadow, and Langfuse evidence are reproducibly generated from the shipped Answer seam.

Scope:

- Execute the committed golden set through the public Answer run seam and write hard-invariant input.
- Invoke the existing bounded RAGAS evaluator from the dedicated pinned Python environment.
- Invoke the existing Langfuse smoke seam with a real injected client when configured.
- Store RAGAS and Langfuse outputs in non-deterministic artifact sections.

Acceptance:

- Golden-set case results contain bounded latency, token, Evidence, Citation, terminal, and degradation observations.
- RAGAS missing runtime, timeout, malformed output, and evaluator failure are explicit and bounded.
- A configured Langfuse run creates and retrieves the expected redacted trace.
- RAGAS regression or Langfuse outage cannot flip a deterministic failure to pass.

Rollback: Disable RAGAS and Langfuse execution; deterministic release gates continue unchanged.

### Ticket 09 — Add One-Command Production Acceptance

Status: `ready-for-agent`
Blocked by: Ticket 05, Ticket 06, Ticket 07, Ticket 08

Outcome: One command produces the complete production artifact or exits non-zero with actionable evidence.

Scope:

- Orchestrate smoke, evaluation, full tests, TypeScript checking, backend and frontend builds, schema verification, rollback verification, artifact generation, and promotion validation.
- Write all evidence under `.release-artifacts` without dirtying the worktree.
- Preserve partial evidence when a stage fails while withholding production-ready status.

Acceptance:

- `npm run release:acceptance` exits 0 only when every required deterministic gate and live probe passes.
- The command exits non-zero for unavailable services, malformed evidence, dirty worktree, wrong revision, failed rollback, or failed build/test/schema gates.
- The final V2 artifact passes the promotion CLI for `git rev-parse HEAD`.
- Non-deterministic reports are present but excluded from the deterministic evidence hash decision.

Rollback: Evidence generation is side-effect-free outside the isolated acceptance namespace; retain artifacts for diagnosis and keep runtime limited.

### Ticket 10 — Run Limited/Default Final Acceptance and Close State

Status: `ready-for-agent`
Blocked by: Ticket 09

Outcome: The same accepted revision is proven in limited and default application modes, and project state records production closure truthfully.

Scope:

- Start the accepted revision in limited mode with the V2 artifact available.
- Re-run production smoke against limited mode.
- Start default mode with the same artifact and revision, then repeat critical identity, retrieval, cancellation, citation, and shutdown checks.
- Update project state and durable memory with final evidence or exact blockers.

Acceptance:

- Limited and default runs use the same revision and artifact hash.
- Default startup refuses a missing, stale, tampered, or failing artifact.
- Critical production smoke passes in both modes.
- `progress.md` reports completed, `verify.json` has no unresolved required check, and touched backlog items are closed or explicitly deferred.

Rollback: Return to limited mode and the previous immutable deployment revision. No database table, knowledge version, trace history, or tenant data is deleted.

## Execution Protocol

- Execute one ready ticket per Graph Engineering round.
- Before each ticket, confirm all dependency edges and operator prerequisites.
- The Executor implements only that ticket's scope and records evidence.
- The Supervisor independently reruns the ticket acceptance commands from a clean context.
- A ticket becomes accepted only after both implementation and independent verification pass.
- Any external blocker leaves the ticket blocked; it does not manufacture skipped production evidence.
- After each accepted ticket, update `progress.md`, `verify.json`, `TODO.md`, and `MEMORY.md` only when the information is durable.
