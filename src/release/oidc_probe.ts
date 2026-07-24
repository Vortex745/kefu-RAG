// Ticket 16 + 17 — Live OIDC admission + JWKS rotation/outage probe.
//
// Command-owning probe that exercises the real jose identity pipeline
// (JWT signature + issuer + audience + claims + JWKS rotation + outage
// fail-closed) using the existing LocalOidcServer as a candidate-mode
// substitute for OP-02 (controlled OIDC acceptance tenant).
//
// Design (karpathy-guidelines):
//   - Simplest viable shape: probe accepts a fixture describing the OIDC
//     scenario, creates a JoseIdentityAdapter, and exercises the real
//     jwtVerify pipeline for each case.
//   - No caller-supplied pass booleans — the probe owns verification:
//     ok=true only when every expected acceptance AND every expected
//     rejection is observed.
//   - Outputs contain only safe metadata (issuer, audience, outcome
//     flags, key-transition phase) — no tokens, signatures, keys, or
//     authorization headers.
//   - Uses the production JoseIdentityAdapter — no test-only shortcuts
//     in the verification path.
//
// Rollback boundary: remove this module + the registry entry; no online
// runtime behavior changes (per Ticket 16/17 rollback spec).

import { JoseIdentityAdapter } from "../identity/jose_adapter"
import type { AccessContext } from "../access/context"
import type { ProbeContext, ProbeImplementation, ProbeResult } from "./smoke_harness"

// ---------------------------------------------------------------------------
// Fixture contract
// ---------------------------------------------------------------------------

/**
 * Fixture describing the OIDC scenario to exercise. The probe creates a
 * fresh JoseIdentityAdapter per fixture and exercises the real jwtVerify
 * pipeline against the provided JWKS endpoint.
 *
 * Token strings are NEVER persisted in outputs — they are inputs only.
 */
export interface OidcProbeFixture {
  /** Issuer URL the adapter will be configured to trust. */
  issuer: string
  /** Expected audience claim. */
  audience: string
  /** JWKS endpoint URL the adapter will fetch keys from. */
  jwksEndpoint: string
  /** Token expected to be admitted with full claim extraction. */
  validToken: string
  /** Optional rejection test cases — each must yield null from adapter. */
  rejectionCases?: Array<{
    name: string
    token: string
    expectRejected: boolean
  }>
  /** Optional rotation test — verifies admission or rejection of a token. */
  rotationTest?: {
    phase: string
    token: string
    expectAdmitted: boolean
  }
  /** Optional outage test — uses an unreachable JWKS endpoint. */
  outageTest?: {
    token: string
    expectRejected: boolean
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wrap a JWT as a Bearer-token Express request. The adapter's
 * `extractBearerToken` reads the `authorization` header.
 */
function makeRequest(token: string): unknown {
  return {
    headers: {
      authorization: `Bearer ${token}`,
    },
  }
}

/**
 * Construct an active JoseIdentityAdapter wired to the given OIDC config.
 * cooldownDuration=0 allows immediate JWKS re-fetch on key rotation
 * without the 30s default cooldown blocking the test.
 */
function makeAdapter(
  issuer: string,
  audience: string,
  jwksEndpoint: string,
): JoseIdentityAdapter {
  return new JoseIdentityAdapter({
    config: {
      kind: "active",
      issuer,
      audience,
      jwksEndpoint,
      claimMapping: {
        tenantClaim: "tenant_id",
        subjectClaim: "sub",
        groupsClaim: "groups",
      },
      clockSkewSeconds: 60,
    },
    jwksOptions: {
      cooldownDuration: 0,
      cacheMaxAge: 60_000,
      timeoutDuration: 2_000,
    },
  })
}

// ---------------------------------------------------------------------------
// Probe implementation
// ---------------------------------------------------------------------------

export const oidcProbe: ProbeImplementation = async (ctx) => {
  const start = Date.now()
  const fixture = ctx.fixture as OidcProbeFixture

  if (!fixture) {
    return {
      ok: false,
      reason: "missing fixture: OidcProbeFixture required (issuer/audience/jwksEndpoint/validToken)",
      durationMs: Date.now() - start,
    }
  }

  const {
    issuer,
    audience,
    jwksEndpoint,
    validToken,
    rejectionCases = [],
    rotationTest,
    outageTest,
  } = fixture

  // --- Ticket 16 #1: Valid token admission ---
  const adapter = makeAdapter(issuer, audience, jwksEndpoint)
  const validReq = makeRequest(validToken)
  const validCtx = await adapter.resolve(validReq)

  const admitted = validCtx !== null
  const tenantId = validCtx?.tenantId ?? null
  const subjectId = validCtx?.subjectId ?? null
  const groups = validCtx?.groups ?? []
  const scopes = validCtx?.scopes ?? []

  // --- Ticket 16 #2: Rejection cases ---
  const rejectionResults: Array<{ name: string; rejected: boolean }> = []
  for (const c of rejectionCases) {
    // Fresh adapter per case to avoid JWKS cache pollution between cases
    // that might use different issuers.
    const caseAdapter = makeAdapter(issuer, audience, jwksEndpoint)
    const caseReq = makeRequest(c.token)
    const caseCtx = await caseAdapter.resolve(caseReq)
    const rejected = caseCtx === null
    rejectionResults.push({ name: c.name, rejected })
  }

  // --- Ticket 17 #1/#2: Rotation test ---
  const rotationResults: Array<{ phase: string; admitted: boolean }> = []
  if (rotationTest) {
    // Use the SAME adapter as the valid token path — this exercises
    // jose's cache + cooldown + re-fetch behavior without restart.
    const rotReq = makeRequest(rotationTest.token)
    const rotCtx = await adapter.resolve(rotReq)
    const rotAdmitted = rotCtx !== null
    rotationResults.push({ phase: rotationTest.phase, admitted: rotAdmitted })
  }

  // --- Ticket 17 #2: JWKS outage fail-closed ---
  let outageResult: { rejected: boolean } | undefined
  if (outageTest) {
    // Point the adapter at an unreachable JWKS endpoint — jose's fetch
    // will fail and jwtVerify will throw → adapter returns null → fail-closed.
    const outageAdapter = makeAdapter(
      issuer,
      audience,
      "http://127.0.0.1:1/.well-known/jwks.json",
    )
    const outageReq = makeRequest(outageTest.token)
    const outageCtx = await outageAdapter.resolve(outageReq)
    outageResult = { rejected: outageCtx === null }
  }

  // ---------------------------------------------------------------------------
  // Compute ok
  // ---------------------------------------------------------------------------

  // Ticket 16 #1: valid token must be admitted
  const validOk = admitted

  // Ticket 16 #2: all rejection cases must reject as expected
  const rejectionsOk = rejectionCases.every((c, i) => {
    const result = rejectionResults[i]
    return c.expectRejected ? result.rejected === true : result.rejected === false
  })

  // Ticket 17 #1/#2: rotation test must meet expectations
  const rotationOk = rotationTest
    ? rotationResults[0]?.admitted === rotationTest.expectAdmitted
    : true

  // Ticket 17 #2: outage must fail-closed
  const outageOk = outageTest
    ? outageResult?.rejected === outageTest.expectRejected
    : true

  const ok = validOk && rejectionsOk && rotationOk && outageOk

  // ---------------------------------------------------------------------------
  // Build outputs — only safe metadata, no token/key/auth material
  // ---------------------------------------------------------------------------

  const reason = ok
    ? undefined
    : `admitted=${admitted}, rejectionsOk=${rejectionsOk}, rotationOk=${rotationOk}, outageOk=${outageOk}`

  const outputs: Record<string, unknown> = {
    // Ticket 16 #1: admission outcome + extracted claims (claim values are
    // safe — they are tenant/subject identifiers, not secrets)
    admitted,
    tenantId,
    subjectId,
    groups,
    scopes,
    // Ticket 16 #3: issuer/audience are config metadata (not secrets)
    issuer,
    audience,
    // Ticket 16 #2: rejection outcomes (name + rejected flag only — no tokens)
    rejections: rejectionResults,
  }

  if (rotationResults.length > 0) {
    // Ticket 17 #3: rotation evidence — phase + admitted flag only
    outputs.rotation = rotationResults
  }

  if (outageResult) {
    // Ticket 17 #2: outage outcome
    outputs.outage = outageResult
  }

  return {
    ok,
    reason,
    outputs,
    durationMs: Date.now() - start,
  }
}
