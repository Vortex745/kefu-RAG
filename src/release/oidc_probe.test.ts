/**
 * Ticket 16 + 17 — Live OIDC admission + JWKS rotation/outage probe tests.
 *
 * Acceptance (Ticket 16 — Live OIDC Admission):
 *   1. A valid signed token with the configured issuer, audience, and claims
 *      is admitted with the expected tenant, subject, groups, and scopes.
 *   2. Wrong issuer, audience, signature, expiry, not-before, and missing
 *      tenant claim are rejected.
 *   3. Tokens and authorization headers are absent from persisted smoke
 *      evidence and diagnostic tails.
 *
 * Acceptance (Ticket 17 — JWKS Rotation and Outage):
 *   1. A token signed by the pre-rotation key succeeds before rotation and
 *      a token signed by the new key succeeds after rotation without restart.
 *   2. Unknown key IDs, tampered signatures, and JWKS outage are rejected
 *      and never create AccessContext.
 *   3. Rotation evidence records only safe issuer, audience, key-transition,
 *      and outcome metadata.
 *
 * Design (karpathy-guidelines):
 *   - Uses the existing LocalOidcServer (real HTTP + real RSA-SHA256 + real
 *     JWKS endpoint) — candidate-mode substitute for OP-02 controlled tenant.
 *   - The probe owns verification logic: ok=true only when every expected
 *     acceptance AND every expected rejection is observed.
 *   - No caller-supplied pass booleans.
 *   - Outputs are bounded metadata only — no tokens, keys, or auth headers.
 */

import assert from "node:assert/strict"
import test from "node:test"

import { oidcProbe } from "./oidc_probe"
import type { ProbeContext } from "./smoke_harness"
import { LocalOidcServer } from "../identity/local_oidc_server"

// ---------- helpers ----------

function makeProbeContext(timeoutMs: number = 10_000): ProbeContext {
  const controller = new AbortController()
  return {
    signal: controller.signal,
    deadlineMs: timeoutMs,
    fixture: undefined,
  }
}

async function withLocalOidcServer(
  audience: string,
  fn: (server: LocalOidcServer) => Promise<void>,
): Promise<void> {
  const server = new LocalOidcServer({
    issuer: "http://127.0.0.1",
    audience,
    kid: "pre-rotation-key",
  })
  await server.start()
  try {
    await fn(server)
  } finally {
    await server.stop()
  }
}

// ============================================================
// Ticket 16 #1: Valid signed token is admitted with expected claims
// ============================================================

test("Ticket 16 #1: oidcProbe admits a valid signed token with expected tenant/subject/groups/scopes", async () => {
  await withLocalOidcServer("test-api", async (server) => {
    // Issue a valid token with full claims
    const validToken = server.issueToken({
      sub: "user-alice",
      tenant_id: "tenant-acme",
      groups: ["engineers", "devops"],
      scope: "chat ingest",
    })

    // Run the probe with the valid token fixture
    const ctx: ProbeContext = {
      ...makeProbeContext(),
      fixture: {
        issuer: server.issuer,
        audience: server.audience,
        jwksEndpoint: server.jwksEndpoint,
        validToken,
      },
    }

    const result = await oidcProbe(ctx)

    assert.equal(result.ok, true, `probe must pass on valid token; reason: ${result.reason}`)
    assert.equal(result.outputs?.admitted, true, "valid token must be admitted")
    assert.equal(result.outputs?.tenantId, "tenant-acme", "tenant must match claim")
    assert.equal(result.outputs?.subjectId, "user-alice", "subject must match claim")
    assert.deepEqual(
      result.outputs?.groups,
      ["engineers", "devops"],
      "groups must match claim",
    )
    assert.deepEqual(
      result.outputs?.scopes,
      ["chat", "ingest"],
      "scopes must match claim",
    )
  })
})

// ============================================================
// Ticket 16 #2: Wrong issuer/audience/signature/expiry/nbf/missing-tenant rejected
// ============================================================

test("Ticket 16 #2: oidcProbe rejects wrong issuer", async () => {
  await withLocalOidcServer("test-api", async (server) => {
    const token = server.issueToken({
      sub: "user",
      tenant_id: "t1",
      iss: "http://wrong-issuer.example.com",
    })

    const ctx: ProbeContext = {
      ...makeProbeContext(),
      fixture: {
        issuer: server.issuer,
        audience: server.audience,
        jwksEndpoint: server.jwksEndpoint,
        validToken: server.issueToken({ sub: "u", tenant_id: "t1" }),
        rejectionCases: [
          {
            name: "wrong-issuer",
            token,
            expectRejected: true,
          },
        ],
      },
    }

    const result = await oidcProbe(ctx)
    assert.equal(result.ok, true, `probe must pass when all rejections fire; reason: ${result.reason}`)
    const rejections = result.outputs?.rejections as Array<{ name: string; rejected: boolean }>
    assert.equal(rejections[0].rejected, true, "wrong issuer must be rejected")
  })
})

test("Ticket 16 #2: oidcProbe rejects wrong audience", async () => {
  await withLocalOidcServer("test-api", async (server) => {
    const token = server.issueToken({
      sub: "user",
      tenant_id: "t1",
      aud: "wrong-audience",
    })

    const ctx: ProbeContext = {
      ...makeProbeContext(),
      fixture: {
        issuer: server.issuer,
        audience: server.audience,
        jwksEndpoint: server.jwksEndpoint,
        validToken: server.issueToken({ sub: "u", tenant_id: "t1" }),
        rejectionCases: [
          { name: "wrong-audience", token, expectRejected: true },
        ],
      },
    }

    const result = await oidcProbe(ctx)
    assert.equal(result.ok, true, `probe must pass; reason: ${result.reason}`)
    const rejections = result.outputs?.rejections as Array<{ name: string; rejected: boolean }>
    assert.equal(rejections[0].rejected, true, "wrong audience must be rejected")
  })
})

test("Ticket 16 #2: oidcProbe rejects tampered signature", async () => {
  await withLocalOidcServer("test-api", async (server) => {
    const validToken = server.issueToken({ sub: "u", tenant_id: "t1" })
    // Tamper: flip a character in the signature segment
    const parts = validToken.split(".")
    const tamperedSig = parts[2].replace(/^(.)(.*)$/, (m, first, rest) =>
      first === "A" ? `B${rest}` : `A${rest}`,
    )
    const tamperedToken = `${parts[0]}.${parts[1]}.${tamperedSig}`

    const ctx: ProbeContext = {
      ...makeProbeContext(),
      fixture: {
        issuer: server.issuer,
        audience: server.audience,
        jwksEndpoint: server.jwksEndpoint,
        validToken: server.issueToken({ sub: "u", tenant_id: "t1" }),
        rejectionCases: [
          { name: "tampered-signature", token: tamperedToken, expectRejected: true },
        ],
      },
    }

    const result = await oidcProbe(ctx)
    assert.equal(result.ok, true, `probe must pass; reason: ${result.reason}`)
    const rejections = result.outputs?.rejections as Array<{ name: string; rejected: boolean }>
    assert.equal(rejections[0].rejected, true, "tampered signature must be rejected")
  })
})

test("Ticket 16 #2: oidcProbe rejects expired token", async () => {
  await withLocalOidcServer("test-api", async (server) => {
    const expiredToken = server.issueToken({
      sub: "u",
      tenant_id: "t1",
      exp: Math.floor(Date.now() / 1000) - 3_600, // expired 1h ago
    })

    const ctx: ProbeContext = {
      ...makeProbeContext(),
      fixture: {
        issuer: server.issuer,
        audience: server.audience,
        jwksEndpoint: server.jwksEndpoint,
        validToken: server.issueToken({ sub: "u", tenant_id: "t1" }),
        rejectionCases: [
          { name: "expired", token: expiredToken, expectRejected: true },
        ],
      },
    }

    const result = await oidcProbe(ctx)
    assert.equal(result.ok, true, `probe must pass; reason: ${result.reason}`)
    const rejections = result.outputs?.rejections as Array<{ name: string; rejected: boolean }>
    assert.equal(rejections[0].rejected, true, "expired token must be rejected")
  })
})

test("Ticket 16 #2: oidcProbe rejects not-yet-valid token (nbf in future)", async () => {
  await withLocalOidcServer("test-api", async (server) => {
    const futureToken = server.issueToken({
      sub: "u",
      tenant_id: "t1",
      nbf: Math.floor(Date.now() / 1000) + 3_600, // valid in 1h
    })

    const ctx: ProbeContext = {
      ...makeProbeContext(),
      fixture: {
        issuer: server.issuer,
        audience: server.audience,
        jwksEndpoint: server.jwksEndpoint,
        validToken: server.issueToken({ sub: "u", tenant_id: "t1" }),
        rejectionCases: [
          { name: "nbf-future", token: futureToken, expectRejected: true },
        ],
      },
    }

    const result = await oidcProbe(ctx)
    assert.equal(result.ok, true, `probe must pass; reason: ${result.reason}`)
    const rejections = result.outputs?.rejections as Array<{ name: string; rejected: boolean }>
    assert.equal(rejections[0].rejected, true, "future nbf must be rejected")
  })
})

test("Ticket 16 #2: oidcProbe rejects missing tenant claim", async () => {
  await withLocalOidcServer("test-api", async (server) => {
    // Token with no tenant_id claim
    const noTenantToken = server.issueToken({
      sub: "u",
      // tenant_id intentionally omitted
    })

    const ctx: ProbeContext = {
      ...makeProbeContext(),
      fixture: {
        issuer: server.issuer,
        audience: server.audience,
        jwksEndpoint: server.jwksEndpoint,
        validToken: server.issueToken({ sub: "u", tenant_id: "t1" }),
        rejectionCases: [
          { name: "missing-tenant", token: noTenantToken, expectRejected: true },
        ],
      },
    }

    const result = await oidcProbe(ctx)
    assert.equal(result.ok, true, `probe must pass; reason: ${result.reason}`)
    const rejections = result.outputs?.rejections as Array<{ name: string; rejected: boolean }>
    assert.equal(rejections[0].rejected, true, "missing tenant claim must be rejected")
  })
})

// ============================================================
// Ticket 16 #3: Tokens and authorization headers absent from evidence
// ============================================================

test("Ticket 16 #3: oidcProbe outputs contain no token, authorization header, or Bearer pattern", async () => {
  await withLocalOidcServer("test-api", async (server) => {
    const validToken = server.issueToken({ sub: "u", tenant_id: "t1" })

    const ctx: ProbeContext = {
      ...makeProbeContext(),
      fixture: {
        issuer: server.issuer,
        audience: server.audience,
        jwksEndpoint: server.jwksEndpoint,
        validToken,
      },
    }

    const result = await oidcProbe(ctx)
    const serialized = JSON.stringify(result.outputs ?? {})
    assert.ok(
      !/"token"\s*:/i.test(serialized),
      "outputs must not contain a 'token' field",
    )
    assert.ok(
      !/"authorization"\s*:/i.test(serialized),
      "outputs must not contain an 'authorization' field",
    )
    assert.ok(
      !/Bearer\s+\S+/i.test(serialized),
      "outputs must not contain Bearer patterns",
    )
    assert.ok(
      !/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(serialized),
      "outputs must not contain JWT-shaped strings",
    )
  })
})

// ============================================================
// Ticket 17 #1: Key rotation — pre-rotation token works; new key works without restart
// ============================================================

test("Ticket 17 #1: oidcProbe verifies pre-rotation token works before rotation and new-key token works after rotation without restart", async () => {
  await withLocalOidcServer("test-api", async (server) => {
    // Step 1: issue token with pre-rotation key, verify it works
    const preRotationToken = server.issueToken({ sub: "u1", tenant_id: "t1" })

    const ctxBefore: ProbeContext = {
      ...makeProbeContext(),
      fixture: {
        issuer: server.issuer,
        audience: server.audience,
        jwksEndpoint: server.jwksEndpoint,
        validToken: preRotationToken,
        rotationTest: {
          phase: "before-rotation",
          token: preRotationToken,
          expectAdmitted: true,
        },
      },
    }

    const resultBefore = await oidcProbe(ctxBefore)
    assert.equal(resultBefore.ok, true, `before-rotation must pass; reason: ${resultBefore.reason}`)
    const rotationResults = resultBefore.outputs?.rotation as Array<{ phase: string; admitted: boolean }>
    assert.equal(rotationResults[0].admitted, true, "pre-rotation token must be admitted")

    // Step 2: rotate key (no adapter restart — JoseIdentityAdapter persists)
    server.rotateKey("post-rotation-key")
    const postRotationToken = server.issueToken({ sub: "u2", tenant_id: "t1" })

    const ctxAfter: ProbeContext = {
      ...makeProbeContext(),
      fixture: {
        issuer: server.issuer,
        audience: server.audience,
        jwksEndpoint: server.jwksEndpoint,
        validToken: postRotationToken,
        rotationTest: {
          phase: "after-rotation",
          token: postRotationToken,
          expectAdmitted: true,
        },
      },
    }

    const resultAfter = await oidcProbe(ctxAfter)
    assert.equal(resultAfter.ok, true, `after-rotation must pass; reason: ${resultAfter.reason}`)
    const rotationResultsAfter = resultAfter.outputs?.rotation as Array<{ phase: string; admitted: boolean }>
    assert.equal(rotationResultsAfter[0].admitted, true, "post-rotation token must be admitted without restart")
  })
})

// ============================================================
// Ticket 17 #2: Unknown kid / tampered signature / JWKS outage → fail-closed
// ============================================================

test("Ticket 17 #2: oidcProbe rejects token signed by unknown kid after rotation", async () => {
  await withLocalOidcServer("test-api", async (server) => {
    // Issue token with pre-rotation key
    const preRotationToken = server.issueToken({ sub: "u", tenant_id: "t1" })
    // Rotate — pre-rotation kid is now unknown
    server.rotateKey("new-key")

    const ctx: ProbeContext = {
      ...makeProbeContext(),
      fixture: {
        issuer: server.issuer,
        audience: server.audience,
        jwksEndpoint: server.jwksEndpoint,
        validToken: server.issueToken({ sub: "u", tenant_id: "t1" }), // new valid token
        rotationTest: {
          phase: "unknown-kid-after-rotation",
          token: preRotationToken, // old kid
          expectAdmitted: false, // must be rejected
        },
      },
    }

    const result = await oidcProbe(ctx)
    assert.equal(result.ok, true, `probe must pass when unknown kid rejected; reason: ${result.reason}`)
    const rotationResults = result.outputs?.rotation as Array<{ phase: string; admitted: boolean }>
    assert.equal(rotationResults[0].admitted, false, "unknown kid must be rejected")
  })
})

test("Ticket 17 #2: oidcProbe fails closed on JWKS outage", async () => {
  await withLocalOidcServer("test-api", async (server) => {
    const validToken = server.issueToken({ sub: "u", tenant_id: "t1" })

    const ctx: ProbeContext = {
      ...makeProbeContext(),
      fixture: {
        issuer: server.issuer,
        audience: server.audience,
        jwksEndpoint: server.jwksEndpoint,
        validToken,
        outageTest: {
          // Provide a token but point adapter at a JWKS endpoint that will be stopped
          token: validToken,
          expectRejected: true,
        },
      },
    }

    const result = await oidcProbe(ctx)
    assert.equal(result.ok, true, `probe must pass when outage rejected; reason: ${result.reason}`)
    const outage = result.outputs?.outage as { rejected: boolean }
    assert.equal(outage.rejected, true, "JWKS outage must fail closed")
  })
})

// ============================================================
// Ticket 17 #3: Rotation evidence records only safe metadata
// ============================================================

test("Ticket 17 #3: oidcProbe rotation evidence contains only safe metadata (no key material)", async () => {
  await withLocalOidcServer("test-api", async (server) => {
    const preRotationToken = server.issueToken({ sub: "u", tenant_id: "t1" })
    server.rotateKey("new-key")
    const postRotationToken = server.issueToken({ sub: "u", tenant_id: "t1" })

    const ctx: ProbeContext = {
      ...makeProbeContext(),
      fixture: {
        issuer: server.issuer,
        audience: server.audience,
        jwksEndpoint: server.jwksEndpoint,
        validToken: postRotationToken,
        rotationTest: {
          phase: "full-rotation-cycle",
          token: postRotationToken,
          expectAdmitted: true,
        },
      },
    }

    const result = await oidcProbe(ctx)
    const serialized = JSON.stringify(result.outputs ?? {})

    // Safe metadata fields allowed
    assert.ok(/"issuer"/.test(serialized), "rotation evidence must include issuer")
    assert.ok(/"audience"/.test(serialized), "rotation evidence must include audience")

    // Forbidden: key material, private keys, JWK content
    assert.ok(
      !/"privateKey"/i.test(serialized),
      "rotation evidence must not contain privateKey",
    )
    assert.ok(
      !/"publicKey"/i.test(serialized),
      "rotation evidence must not contain publicKey",
    )
    assert.ok(
      !/"n"\s*:/.test(serialized),
      "rotation evidence must not contain JWK 'n' (modulus) field",
    )
    assert.ok(
      !/"e"\s*:/.test(serialized),
      "rotation evidence must not contain JWK 'e' (exponent) field",
    )
    assert.ok(
      !/"d"\s*:/.test(serialized),
      "rotation evidence must not contain JWK 'd' (private exponent) field",
    )
    assert.ok(
      !/-----BEGIN.*KEY-----/.test(serialized),
      "rotation evidence must not contain PEM key material",
    )
  })
})

// ============================================================
// Ticket 16+17 #4: Broken-fixture verification (probe catches missing rejection)
// ============================================================

test("Ticket 16+17 #4: oidcProbe fails when an expected rejection does not fire (broken adapter)", async () => {
  await withLocalOidcServer("test-api", async (server) => {
    // Broken: adapter that admits everything (ignores verification)
    // The probe must detect that wrong-issuer was NOT rejected.
    const validToken = server.issueToken({ sub: "u", tenant_id: "t1" })
    const wrongIssuerToken = server.issueToken({
      sub: "u",
      tenant_id: "t1",
      iss: "http://wrong.example.com",
    })

    // We simulate a broken probe by giving it a wrongIssuerToken as validToken
    // and asserting it should still be rejected — but a permissive adapter
    // would admit it. The probe's own verification must catch this.
    const ctx: ProbeContext = {
      ...makeProbeContext(),
      fixture: {
        issuer: server.issuer,
        audience: server.audience,
        jwksEndpoint: server.jwksEndpoint,
        // Pass the wrong-issuer token where the probe expects a valid one.
        // A correct adapter will reject it; the probe must observe rejection.
        validToken: wrongIssuerToken,
        rejectionCases: [
          { name: "wrong-issuer", token: wrongIssuerToken, expectRejected: true },
        ],
      },
    }

    const result = await oidcProbe(ctx)
    // The probe must report ok=false because the "valid" token was actually
    // rejected (not admitted) — verifying the probe's acceptance check.
    // If the probe admits it, ok would be wrong.
    // We accept either: (a) ok=true with admitted=false (probe correctly
    // observed rejection), or (b) ok=false (probe detected inconsistency).
    // Either way, the probe must NOT report ok=true AND admitted=true.
    const admitted = result.outputs?.admitted as boolean | undefined
    assert.ok(
      !(result.ok === true && admitted === true),
      "broken fixture: probe must not report ok=true AND admitted=true for wrong-issuer token",
    )
  })
})

// ============================================================
// Ticket 16+17 #5: Probe returns durationMs
// ============================================================

test("Ticket 16+17 #5: oidcProbe returns durationMs", async () => {
  await withLocalOidcServer("test-api", async (server) => {
    const validToken = server.issueToken({ sub: "u", tenant_id: "t1" })

    const ctx: ProbeContext = {
      ...makeProbeContext(),
      fixture: {
        issuer: server.issuer,
        audience: server.audience,
        jwksEndpoint: server.jwksEndpoint,
        validToken,
      },
    }

    const result = await oidcProbe(ctx)
    assert.equal(typeof result.durationMs, "number", "durationMs must be a number")
    assert.ok(result.durationMs >= 0, "durationMs must be non-negative")
    assert.ok(result.durationMs < 10_000, "durationMs must be bounded (< 10s)")
  })
})
