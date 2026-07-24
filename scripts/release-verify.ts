#!/usr/bin/env node
// Ticket 03 — CLI entry point for the command-owning release runner.
//
// Usage:
//   node --import tsx scripts/release-verify.ts <profile> <output-path> [eval-input-path] [smoke-evidence-path]
//
// Examples:
//   node --import tsx scripts/release-verify.ts local ./release-verification-local.json
//   node --import tsx scripts/release-verify.ts production ./release-verification-production.json ./eval.json ./smoke.json
//
// Exit codes:
//   0 — all gates passed (local: overallPassed=true; production: productionReady=true)
//   1 — at least one gate failed
//   2 — invalid usage (missing required arguments)

import { runReleaseVerification } from "../src/release/runner"
import type { EvaluationProfile } from "../src/evaluation/types"

async function main(): Promise<void> {
  const profile = process.argv[2] as EvaluationProfile
  const outputPath = process.argv[3]
  const evaluationInputPath = process.argv[4]
  const smokeEvidencePath = process.argv[5]

  if (
    !profile ||
    !outputPath ||
    (profile !== "local" && profile !== "production")
  ) {
    console.error(
      "Usage: release-verify <local|production> <output-path> [eval-input-path] [smoke-evidence-path]",
    )
    process.exit(2)
  }

  const artifact = await runReleaseVerification({
    profile,
    outputPath,
    evaluationInputPath: evaluationInputPath || undefined,
    smokeEvidencePath: smokeEvidencePath || undefined,
  })

  console.log(
    `Release verification ${artifact.overallPassed ? "PASSED" : "FAILED"} (profile: ${profile})`,
  )
  console.log(`  Overall passed:   ${artifact.overallPassed}`)
  console.log(`  Production ready: ${artifact.productionReady}`)
  console.log(`  Hard invariants:  ${artifact.hardInvariantStatus}`)
  console.log(`  Repository rev:   ${artifact.repositoryRevision}`)
  console.log(`  Generated at:     ${artifact.generatedAt}`)
  console.log(`  Gates:`)
  for (const gate of artifact.gates) {
    const status =
      gate.failureCategory === "none"
        ? gate.blocked
          ? "BLOCKED"
          : "PASS"
        : `FAIL (${gate.failureCategory})`
    console.log(
      `    ${gate.name}: ${status} (${gate.durationMs}ms)${gate.failureReason ? " — " + gate.failureReason : ""}`,
    )
  }
  console.log(`  Artifact written: ${outputPath}`)

  if (profile === "production" && !artifact.productionReady) {
    process.exit(1)
  }
  if (profile === "local" && !artifact.overallPassed) {
    process.exit(1)
  }
}

main().catch((err: unknown) => {
  console.error(
    "Release verification error:",
    err instanceof Error ? err.message : String(err),
  )
  process.exit(1)
})
