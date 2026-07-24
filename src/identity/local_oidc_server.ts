/**
 * P5.3: Local OIDC test server for integration testing.
 *
 * This is a TEST HELPER, not production code. It provides a real HTTP server
 * that serves JWKS and signs JWTs with an RSA key pair, allowing end-to-end
 * testing of the OIDC identity flow (JWKS fetch → signature verification →
 * claim validation → AccessContext extraction) without an external OIDC provider.
 *
 * The server uses real HTTP, real JWKS, and real RSA-SHA256 signatures —
 * it is "real" in every sense except that it runs on localhost and generates
 * its own keys. This proves the integration works end-to-end.
 *
 * Usage in tests:
 *   const server = new LocalOidcServer({ issuer: "http://localhost:0", audience: "test-api" });
 *   await server.start();
 *   const token = server.issueToken({ sub: "user1", tenant_id: "t1", groups: ["g1"] });
 *   // ... wire adapter with server.jwksEndpoint, server.getJwksFetcher() ...
 *   await server.stop();
 */

import { createServer, type Server } from "node:http"
import {
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto"
import { createJwksFetcher } from "./signature_verify"

export interface LocalOidcServerOptions {
  /** The issuer URL (e.g., "http://localhost:PORT"). */
  issuer: string
  /** The expected audience claim. */
  audience: string
  /** Key ID for the signing key (default: "local-test-key"). */
  kid?: string
  /** Port to listen on (0 = random free port, assigned by OS). */
  port?: number
}

export interface IssueTokenClaims {
  sub?: string
  tenant_id?: string
  groups?: string[]
  scope?: string
  iss?: string
  aud?: string | string[]
  exp?: number // seconds since epoch
  nbf?: number // seconds since epoch
  iat?: number // seconds since epoch
  [key: string]: unknown
}

/**
 * Local OIDC test server that serves JWKS and signs JWTs.
 *
 * Generates an RSA-2048 key pair on construction. The public key is served
 * as JWKS at `/.well-known/jwks.json`. JWTs are signed with RS256.
 */
export class LocalOidcServer {
  private readonly privateKey: KeyObject
  private readonly publicKey: KeyObject
  private readonly jwk: Record<string, unknown>
  private server: Server | null = null
  private actualPort: number = 0

  readonly kid: string
  readonly audience: string
  readonly issuerBase: string

  constructor(options: LocalOidcServerOptions) {
    this.audience = options.audience
    this.kid = options.kid ?? "local-test-key"
    this.issuerBase = options.issuer.replace(/:\d+$/, "") // strip port if present

    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    })
    this.privateKey = privateKey
    this.publicKey = publicKey

    // Export public key as JWK for the JWKS endpoint
    this.jwk = this.publicKey.export({ format: "jwk" })
    this.jwk.kid = this.kid
    this.jwk.use = "sig"
    this.jwk.alg = "RS256"
  }

  /** The actual port the server is listening on (available after start()). */
  get port(): number {
    return this.actualPort
  }

  /** The actual issuer URL (includes the assigned port). */
  get issuer(): string {
    return `${this.issuerBase}:${this.actualPort}`
  }

  /** The JWKS endpoint URL. */
  get jwksEndpoint(): string {
    return `${this.issuer}/.well-known/jwks.json`
  }

  /** Start the HTTP server. */
  async start(): Promise<void> {
    if (this.server) throw new Error("Server already started")

    return new Promise((resolve) => {
      this.server = createServer((req, res) => {
        const url = req.url ?? ""

        if (url === "/.well-known/jwks.json") {
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ keys: [this.jwk] }))
          return
        }

        if (url === "/token") {
          // Simple token endpoint — in a real OIDC provider, this would
          // require client authentication. For testing, it just signs
          // whatever claims are in the request body.
          let body = ""
          req.on("data", (chunk) => { body += chunk })
          req.on("end", () => {
            try {
              const claims = JSON.parse(body) as IssueTokenClaims
              const token = this.issueToken(claims)
              res.writeHead(200, { "Content-Type": "application/json" })
              res.end(JSON.stringify({ access_token: token, token_type: "Bearer" }))
            } catch {
              res.writeHead(400, { "Content-Type": "application/json" })
              res.end(JSON.stringify({ error: "invalid_request" }))
            }
          })
          return
        }

        res.writeHead(404, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "not_found" }))
      })

      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server!.address()
        if (addr && typeof addr === "object") {
          this.actualPort = addr.port
        }
        resolve()
      })
    })
  }

  /** Stop the HTTP server. */
  async stop(): Promise<void> {
    if (!this.server) return
    return new Promise((resolve) => {
      this.server!.close(() => {
        this.server = null
        resolve()
      })
    })
  }

  /**
   * Issue a signed JWT with the given claims.
   *
   * Defaults: iss = this.issuer, aud = this.audience, exp = now + 1h, iat = now.
   * Override any of these by passing them in `claims`.
   */
  issueToken(claims: IssueTokenClaims): string {
    const now = Math.floor(Date.now() / 1000)
    const fullClaims: IssueTokenClaims = {
      iss: this.issuer,
      aud: this.audience,
      iat: now,
      exp: now + 3600, // 1 hour
      ...claims,
    }

    const header = this.b64url({ alg: "RS256", typ: "JWT", kid: this.kid })
    const payload = this.b64url(fullClaims)
    const signingInput = `${header}.${payload}`

    const signature = cryptoSign(
      "RSA-SHA256",
      Buffer.from(signingInput, "utf8"),
      this.privateKey
    )

    return `${signingInput}.${this.bufferToB64url(signature)}`
  }

  /**
   * Create a JWKS fetcher function that fetches from this server.
   * Suitable for passing to `getSigningKey(kid, cache, fetcher)`.
   * Delegates to `signature_verify.createJwksFetcher` — single implementation.
   */
  getJwksFetcher(): (kid: string) => Promise<string | null> {
    return createJwksFetcher(this.jwksEndpoint)
  }

  /** Get the public key in PEM format (for direct testing without HTTP). */
  getPublicKeyPem(): string {
    return this.publicKey.export({ type: "spki", format: "pem" }).toString("utf8")
  }

  /**
   * Rotate the signing key to a new RSA-2048 key pair with a new kid.
   * The JWKS endpoint will serve the new public key after this call.
   * Tokens issued before rotation (with the old kid) will fail signature
   * verification; tokens issued after (with the new kid) will verify.
   *
   * This is for testing key rotation recovery (Ticket 05).
   */
  rotateKey(newKid?: string): void {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    })
    // Replace keys via Object.defineProperty (they're readonly)
    Object.defineProperty(this, "privateKey", { value: privateKey })
    Object.defineProperty(this, "publicKey", { value: publicKey })
    // Update kid and JWK
    const kid = newKid ?? `local-test-key-${Date.now()}`
    Object.defineProperty(this, "kid", { value: kid })
    const jwk = publicKey.export({ format: "jwk" })
    jwk.kid = kid
    jwk.use = "sig"
    jwk.alg = "RS256"
    Object.defineProperty(this, "jwk", { value: jwk })
  }

  // ---------- internal helpers ----------

  private b64url(obj: unknown): string {
    const json = JSON.stringify(obj)
    return Buffer.from(json, "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
  }

  private bufferToB64url(buf: Buffer): string {
    return buf
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
  }
}
