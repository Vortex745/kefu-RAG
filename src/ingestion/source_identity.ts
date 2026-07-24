import { createHash } from "node:crypto"
import * as path from "node:path"

export interface SourceIdentityInput {
  kind: string
  uriOrExternalId: string
  namespace?: string
  // Ticket 05 P2: access context attributes propagated from the caller.
  // tenantId defaults to "default" when not provided (single-tenant mode).
  tenantId?: string
  // allowedGroups defaults to [] meaning tenant-wide visibility (never cross-tenant public).
  allowedGroups?: string[]
}

export interface CanonicalSourceIdentity {
  kind: string
  uri: string
  namespace: string
  // Ticket 05 P2: tenantId is an ATTRIBUTE on the source, not part of the identity key.
  // Kept out of sourceIdentityKey to keep the schema migration additive.
  tenantId: string
  allowedGroups: string[]
}

function canonicalize(kind: string, value: string): string {
  if (kind === "file") {
    const resolved = path.resolve(value)
    return process.platform === "win32" ? resolved.toLowerCase() : resolved
  }
  if (kind === "url") return new URL(value).toString()
  return value
}

export function resolveStoredSourceIdentity(
  source: string,
  fallbackId: string
): CanonicalSourceIdentity {
  const storedSource = source.trim()
  const isAbsoluteFilePath = path.isAbsolute(storedSource) ||
    /^[a-z]:[\\/]/i.test(storedSource) ||
    /^\\\\/.test(storedSource)
  if (storedSource !== "api" && isAbsoluteFilePath) {
    return resolveSourceIdentity(
      { kind: "file", uriOrExternalId: storedSource, namespace: "local" },
      undefined,
      fallbackId
    )
  }
  return resolveSourceIdentity(undefined, source, fallbackId)
}

export function resolveSourceIdentity(
  identity: SourceIdentityInput | undefined,
  legacySource: string | undefined,
  fallbackId: string
): CanonicalSourceIdentity {
  if (identity) {
    const kind = identity.kind.trim().toLowerCase()
    const value = identity.uriOrExternalId.trim()
    const namespace = identity.namespace?.trim() || "default"
    if (!kind || !value) {
      throw new Error("source identity kind and URI or external ID are required")
    }
    // Ticket 05 P2: propagate access attributes with defaults (additive — key unchanged).
    const tenantId = identity.tenantId?.trim() || "default"
    const allowedGroups = identity.allowedGroups ?? []
    return { kind, uri: canonicalize(kind, value), namespace, tenantId, allowedGroups }
  }

  // Legacy paths default to single-tenant identity (backward compat for existing callers).
  const source = legacySource?.trim()
  if (!source || source === "api") {
    return { kind: "submission", uri: fallbackId, namespace: fallbackId, tenantId: "default", allowedGroups: [] }
  }
  if (/^https?:\/\//i.test(source)) {
    try {
      return { kind: "url", uri: canonicalize("url", source), namespace: "default", tenantId: "default", allowedGroups: [] }
    } catch {
      return { kind: "legacy", uri: source, namespace: "default", tenantId: "default", allowedGroups: [] }
    }
  }
  return { kind: "legacy", uri: source, namespace: "default", tenantId: "default", allowedGroups: [] }
}

export function sourceIdentityKey(identity: CanonicalSourceIdentity): string {
  return createHash("sha256")
    .update(JSON.stringify([identity.kind, identity.uri, identity.namespace]))
    .digest("hex")
}
