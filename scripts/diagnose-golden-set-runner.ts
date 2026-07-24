// Diagnostic: run goldenSetRunner + evaluateHardInvariants to see actual
// invariant pass/fail distribution. NOT a test — just a verification probe.
import { goldenSetRunner } from "../src/release/golden_set_runner"
import { evaluateHardInvariants } from "../src/evaluation/hard_invariants"
import { GOLDEN_SET } from "../src/evaluation/golden/fixtures"

async function main() {
  const result = await goldenSetRunner({
    signal: new AbortController().signal,
    deadlineMs: 60_000,
    fixture: { revision: "abc123def4567890abcdef1234567890abcdef12" },
  })
  if (!result.ok || !result.outputs) {
    console.error("runner failed:", result.reason)
    process.exit(1)
  }
  const caseResults = result.outputs.caseResults as ReturnType<
    typeof evaluateHardInvariants
  > extends never ? never : Array<{ caseId: string; status: string; terminalStatus?: string }>
  const outputs = result.outputs as {
    caseResults: Array<{ caseId: string; status: string; terminalStatus?: string }>
    passedCases: number
    failedCases: number
    totalCases: number
    totalDurationMs: number
  }
  console.log("=== goldenSetRunner summary ===")
  console.log("totalCases:", outputs.totalCases)
  console.log("passedCases:", outputs.passedCases)
  console.log("failedCases:", outputs.failedCases)
  console.log("totalDurationMs:", outputs.totalDurationMs)
  console.log()
  console.log("=== terminal status distribution ===")
  const termDist: Record<string, number> = {}
  for (const cr of outputs.caseResults) {
    const t = cr.terminalStatus ?? "undefined"
    termDist[t] = (termDist[t] ?? 0) + 1
  }
  for (const [t, n] of Object.entries(termDist).sort()) {
    console.log(`  ${t}: ${n}`)
  }
  console.log()
  console.log("=== hard invariant evaluation ===")
  const invariants = evaluateHardInvariants(
    GOLDEN_SET.cases,
    outputs.caseResults as never,
  )
  for (const inv of invariants) {
    console.log(
      `  ${inv.passed ? "PASS" : "FAIL"} ${inv.key}: ${inv.actual}` +
      (inv.failingCaseIds.length > 0
        ? ` (failing: ${inv.failingCaseIds.slice(0, 5).join(", ")}${inv.failingCaseIds.length > 5 ? ` +${inv.failingCaseIds.length - 5}` : ""})`
        : ""),
    )
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
