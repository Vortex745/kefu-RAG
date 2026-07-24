#!/usr/bin/env node
// Ticket 04 — Promotion-check CLI.
//
// Validates an existing release artifact for production promotion.
// Only validates — never reruns or mutates production systems.
//
// Usage:
//   node --import tsx scripts/release-promotion-check.ts <artifact-path> <expected-revision>
//
// Exit codes:
//   0 — artifact is valid and can be promoted to production
//   1 — artifact cannot be promoted (rejection reasons printed)
//   2 — invalid usage (missing arguments or unreadable file)

import { readFileSync } from "node:fs"
import { checkPromotion } from "../src/release/promotion"
import type { ReleaseRunnerArtifact } from "../src/release/runner"

function main(): void {
  const artifactPath = process.argv[2]
  const expectedRevision = process.argv[3]

  if (!artifactPath || !expectedRevision) {
    console.error(
      "Usage: release-promotion-check <artifact-path> <expected-revision>",
    )
    process.exit(2)
  }

  let raw: string
  try {
    raw = readFileSync(artifactPath, "utf8")
  } catch (err) {
    console.error(
      `Cannot read artifact file: ${err instanceof Error ? err.message : String(err)}`,
    )
    process.exit(2)
  }

  let artifact: unknown
  try {
    artifact = JSON.parse(raw)
  } catch (err) {
    console.error(
      `Artifact file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
    process.exit(1)
  }

  const result = checkPromotion(
    artifact as ReleaseRunnerArtifact,
    { expectedRevision },
  )

  if (result.promoted) {
    console.log("Promotion check: PASSED")
    console.log(`  Artifact: ${artifactPath}`)
    console.log(`  Revision: ${expectedRevision}`)
    console.log("  All promotion conditions satisfied.")
    process.exit(0)
  }

  console.log("Promotion check: FAILED")
  console.log(`  Artifact: ${artifactPath}`)
  console.log(`  Revision: ${expectedRevision}`)
  console.log(`  Rejection reasons (${result.reasons.length}):`)
  for (const reason of result.reasons) {
    console.log(`    - ${reason}`)
  }
  process.exit(1)
}

main()
