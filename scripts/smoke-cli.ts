#!/usr/bin/env node
// Ticket 04 — Smoke CLI for deterministic probes and executable rollback evidence.
//
// Spec issue #15: Publish the smoke CLI and redacted evidence.
//
// Usage:
//   node --import tsx scripts/smoke-cli.ts <profile> [output-path] [--no-rollback]
//
// Examples:
//   node --import tsx scripts/smoke-cli.ts local
//   node --import tsx scripts/smoke-cli.ts production .release-artifacts/smoke-production.json
//   node --import tsx scripts/smoke-cli.ts local --no-rollback
//
// Exit codes:
//   0 — all required probes passed, rollback verified, and no secrets detected
//   1 — at least one required probe failed, rollback unverified, or secrets detected
//   2 — invalid usage
//
// Design (karpathy-guidelines):
//   - Simplest viable shape: run deterministic probes, run rollback, scan for
//     secrets, write evidence under the ignored .release-artifacts/ area.
//   - One command, one exit decision — automation can consume the result.
//   - No caller-supplied pass booleans; probes own their verification logic.

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import {
  runAllProbes,
  writeSmokeEvidence,
  scanForSecrets,
  PROBE_REGISTRY,
  type ProbeProfile,
} from "../src/release/smoke_harness"
import { DETERMINISTIC_PROBE_IMPLEMENTATIONS } from "../src/release/deterministic_probes"
import { verifyRollback } from "../src/release/rollback_check"

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const profile = args[0] as ProbeProfile | undefined
  const outputPathArg = args[1] && !args[1].startsWith("--") ? args[1] : undefined
  const skipRollback = args.includes("--no-rollback")

  if (!profile || (profile !== "local" && profile !== "production")) {
    console.error(
      "Usage: smoke-cli <local|production> [output-path] [--no-rollback]",
    )
    process.exit(2)
  }

  // Default output path under the ignored release-artifact area.
  // .release-artifacts/ is in .gitignore so producing evidence does not dirty
  // the trusted worktree (Issue 15 acceptance criterion #2).
  const outputPath = resolve(
    outputPathArg ?? `.release-artifacts/smoke-${profile}.json`,
  )
  mkdirSync(dirname(outputPath), { recursive: true })

  // -----------------------------------------------------------------------
  // Step 1: Run every registered deterministic probe.
  // -----------------------------------------------------------------------
  console.log(`Running deterministic probes (profile: ${profile})...`)
  const evidence = await runAllProbes({
    profile,
    implementations: DETERMINISTIC_PROBE_IMPLEMENTATIONS,
  })

  for (const result of evidence.results) {
    const decl = PROBE_REGISTRY.find((d) => d.name === result.name)
    const requiredStatus = decl?.requiredPerProfile[profile] ?? "required"
    const tag = requiredStatus === "required" ? "[REQ]" : "[OPT]"
    console.log(
      `  ${tag} ${result.name}: ${result.status} (${result.durationMs}ms)` +
        (result.reason ? ` — ${result.reason}` : ""),
    )
  }

  // -----------------------------------------------------------------------
  // Step 2: Executable rollback verification (Issue 14).
  // -----------------------------------------------------------------------
  let rollbackVerified = true
  if (!skipRollback) {
    console.log("Running rollback verification...")
    const rollback = await verifyRollback({
      revision: evidence.repositoryRevision,
    })
    rollbackVerified = rollback.verified
    console.log(`  Rollback: ${rollback.verified ? "VERIFIED" : "UNVERIFIED"}`)
    for (const step of rollback.steps) {
      console.log(`    - ${step}`)
    }
    // Write rollback evidence alongside smoke evidence so the release runner
    // can bind it to the release artifact (Ticket 04 rollback evidence field).
    const rollbackPath = outputPath.replace(/\.json$/, ".rollback.json")
    writeFileSync(rollbackPath, JSON.stringify(rollback, null, 2) + "\n", "utf8")
    console.log(`  Rollback evidence written: ${rollbackPath}`)
  } else {
    console.log("Skipping rollback verification (--no-rollback)")
  }

  // -----------------------------------------------------------------------
  // Step 3: Defense-in-depth secret scan (Issue 15 acceptance criterion #3).
  // Reject persisted JWTs, credentials, prompts, customer text, embeddings,
  // and parser source content before writing evidence.
  // -----------------------------------------------------------------------
  const secretFindings = scanForSecrets(evidence)
  if (secretFindings.length > 0) {
    console.error("SECRET SCAN FAILED — refusing to write evidence:")
    for (const finding of secretFindings) {
      console.error(`  - ${finding}`)
    }
    process.exit(1)
  }

  // -----------------------------------------------------------------------
  // Step 4: Write schema-valid, revision-bound evidence.
  // -----------------------------------------------------------------------
  writeSmokeEvidence({ evidence, outputPath })
  console.log(`Smoke evidence written: ${outputPath}`)
  console.log(`  Overall passed:   ${evidence.overallPassed}`)
  console.log(`  Production ready: ${evidence.productionReady}`)
  console.log(`  Repository rev:   ${evidence.repositoryRevision}`)
  console.log(`  Generated at:     ${evidence.generatedAt}`)

  // -----------------------------------------------------------------------
  // Step 5: Exit non-zero when a required probe fails or rollback is
  // unverified (Issue 15 acceptance criterion #1).
  // -----------------------------------------------------------------------
  if (!evidence.overallPassed) {
    console.error("FAIL: at least one required probe did not pass")
    process.exit(1)
  }
  if (!rollbackVerified) {
    console.error("FAIL: rollback evidence is unverified")
    process.exit(1)
  }
}

main().catch((err: unknown) => {
  console.error("Smoke CLI error:", err instanceof Error ? err.message : String(err))
  process.exit(1)
})
