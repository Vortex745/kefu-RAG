import express, { Request, Response, Router } from "express"
import { randomUUID } from "node:crypto"
import { singleTenantAccessContext, type AccessContext } from "../access/context"
import { createIngestionLifecycle } from "../ingestion/pipeline"
import type { SourceIdentityInput } from "../ingestion/source_identity"
import { openDb } from "../ingestion/tracking"
import {
  fetchSingleUrl,
  fetchSitemapUrls,
  SITEMAP_DEFAULT_MAX_PAGES,
  SITEMAP_HARD_MAX_PAGES,
  UrlPolicyDenyError,
} from "../ingestion/url_fetcher"

interface IngestRequestBody {
  title?: string
  content?: string
  source?: string
  sourceIdentity?: {
    kind: string
    uriOrExternalId: string
    namespace?: string
  }
}

interface IngestUrlRequestBody {
  url?: string
  mode?: "single" | "sitemap"
  title?: string
  parserOverride?: "markitdown" | "marker" | "mineru"
  maxPages?: number
}

const router = Router()
export const rawIngestRouter = Router()

const RAW_FILE_LIMIT = "20mb"
const PARSER_TYPES = new Set(["markitdown", "marker", "mineru"])
const URL_FETCH_TIMEOUT_MS = 30_000
const URL_FETCH_MAX_BYTES = 20 * 1024 * 1024 // 20MB，与单文件上传上限一致

function trustedSourceIdentity(
  res: Response,
  sourceIdentity: Omit<SourceIdentityInput, "tenantId" | "allowedGroups">
): SourceIdentityInput {
  const accessContext =
    (res.locals.accessContext as AccessContext | undefined) ?? singleTenantAccessContext()
  return {
    ...sourceIdentity,
    tenantId: accessContext.tenantId,
    allowedGroups: [...accessContext.groups],
  }
}

function requestSourceIdentity(body: IngestRequestBody): Omit<SourceIdentityInput, "tenantId" | "allowedGroups"> {
  if (body.sourceIdentity) return body.sourceIdentity
  const source = body.source?.trim()
  if (!source || source === "api") {
    const id = randomUUID()
    return { kind: "submission", uriOrExternalId: id, namespace: id }
  }
  return /^https?:\/\//i.test(source)
    ? { kind: "url", uriOrExternalId: source }
    : { kind: "legacy", uriOrExternalId: source }
}

rawIngestRouter.post(
  "/ingest/file",
  express.raw({ type: "application/octet-stream", limit: RAW_FILE_LIMIT }),
  (req: Request, res: Response) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: "a non-empty application/octet-stream body is required" })
    }
    const fileName = req.get("x-file-name")?.trim()
    if (!fileName) {
      return res.status(400).json({ error: "x-file-name is required" })
    }
    const parserOverride = req.get("x-parser")?.trim().toLowerCase()
    if (parserOverride && !PARSER_TYPES.has(parserOverride)) {
      return res.status(400).json({
        error: "x-parser must be markitdown, marker, or mineru",
      })
    }

    const sourceExternalId = req.get("x-source-id")?.trim() || fileName
    const lifecycle = createIngestionLifecycle(openDb())
    return res.json(lifecycle.submit({
      title: req.get("x-document-title")?.trim() || fileName,
      content: "",
      rawContent: req.body,
      fileName,
      mimeType: req.get("x-file-mime-type")?.trim() || "application/octet-stream",
      parserOverride,
      sourceIdentity: trustedSourceIdentity(res, {
        kind: req.get("x-source-kind")?.trim() || "file",
        uriOrExternalId: sourceExternalId,
        namespace: req.get("x-source-namespace")?.trim() || "upload",
      }),
    }))
  }
)

router.post("/ingest", (req: Request, res: Response) => {
  const body = req.body as IngestRequestBody
  if (!body.title || !body.content) {
    return res.status(400).json({ error: "title and content are required" })
  }

  const lifecycle = createIngestionLifecycle(openDb())
  return res.json(
    lifecycle.submit({
      title: body.title,
      content: body.content,
      source: body.source,
      sourceIdentity: trustedSourceIdentity(res, requestSourceIdentity(body)),
    })
  )
})

router.post("/ingest/url", async (req: Request, res: Response) => {
  const body = req.body as IngestUrlRequestBody
  const url = body.url?.trim()
  if (!url) {
    return res.status(400).json({ error: "url is required" })
  }
  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    return res.status(400).json({ error: "url must be a valid absolute URL" })
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return res.status(400).json({ error: "url protocol must be http or https" })
  }

  const mode = body.mode === "sitemap" ? "sitemap" : "single"
  const parserOverride = body.parserOverride
  if (parserOverride && !PARSER_TYPES.has(parserOverride)) {
    return res.status(400).json({ error: "parserOverride must be markitdown, marker, or mineru" })
  }

  const lifecycle = createIngestionLifecycle(openDb())

  if (mode === "single") {
    let fetched
    try {
      fetched = await fetchSingleUrl(parsedUrl, {
        timeoutMs: URL_FETCH_TIMEOUT_MS,
        maxBytes: URL_FETCH_MAX_BYTES,
      })
    } catch (err) {
      // P4.3: SSRF 拒绝 (UrlPolicyDenyError) 是 non-retryable — 策略层判定目标不可达。
      // 与 transient fetch error (502) 区分，让调用方不会重试被策略拒绝的 URL。
      if (err instanceof UrlPolicyDenyError) {
        return res.status(422).json({
          error: "url policy denied",
          reason: err.decision.reason,
          detail: err.decision.detail,
          stage: err.stage,
          hop: err.hop,
          retryable: false,
        })
      }
      return res.status(502).json({
        error: "failed to fetch url",
        detail: err instanceof Error ? err.message : String(err),
        retryable: true,
      })
    }
    const submission = lifecycle.submit({
      title: body.title?.trim() || fetched.title || fetched.fileName,
      content: "",
      rawContent: fetched.buffer,
      fileName: fetched.fileName,
      mimeType: fetched.mimeType,
      parserOverride,
      sourceIdentity: trustedSourceIdentity(res, {
        kind: "web",
        uriOrExternalId: url,
        namespace: "web",
      }),
    })
    return res.json(submission)
  }

  // sitemap 模式（Phase 3）
  const requestedMax = body.maxPages
  const maxPages = Math.min(
    Math.max(1, Math.floor(requestedMax ?? SITEMAP_DEFAULT_MAX_PAGES)),
    SITEMAP_HARD_MAX_PAGES,
  )
  let pages: { url: URL; fileName: string }[]
  try {
    pages = await fetchSitemapUrls(parsedUrl, {
      timeoutMs: URL_FETCH_TIMEOUT_MS,
      maxPages,
    })
  } catch (err) {
    // P4.3: sitemap.xml 本身的 SSRF 拒绝也走 422 non-retryable 路径。
    if (err instanceof UrlPolicyDenyError) {
      return res.status(422).json({
        error: "url policy denied",
        reason: err.decision.reason,
        detail: err.decision.detail,
        stage: err.stage,
        hop: err.hop,
        retryable: false,
      })
    }
    return res.status(502).json({
      error: "failed to fetch sitemap",
      detail: err instanceof Error ? err.message : String(err),
      retryable: true,
    })
  }
  const batchId = `sitemap-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  const submissions: { url: string; docId: string; status: string; retryable: boolean }[] = []
  for (const page of pages) {
    let pageFetched
    try {
      pageFetched = await fetchSingleUrl(page.url, {
        timeoutMs: URL_FETCH_TIMEOUT_MS,
        maxBytes: URL_FETCH_MAX_BYTES,
      })
    } catch (err) {
      // P4.3: SSRF 拒绝 (non-retryable) 与 transient fetch error (retryable) 分别标记，
      // 让批量调用方可 inspect 每页的 retryability 而不重试被策略拒绝的 URL。
      if (err instanceof UrlPolicyDenyError) {
        submissions.push({
          url: page.url.toString(),
          docId: "",
          status: `ssrf_denied: ${err.decision.reason}`,
          retryable: false,
        })
      } else {
        submissions.push({
          url: page.url.toString(),
          docId: "",
          status: `failed: ${err instanceof Error ? err.message : String(err)}`,
          retryable: true,
        })
      }
      continue
    }
    const submission = lifecycle.submit({
      title: pageFetched.title || pageFetched.fileName,
      content: "",
      rawContent: pageFetched.buffer,
      fileName: pageFetched.fileName,
      mimeType: pageFetched.mimeType,
      parserOverride,
      sourceIdentity: trustedSourceIdentity(res, {
        kind: "web",
        uriOrExternalId: page.url.toString(),
        namespace: "web-sitemap",
      }),
    })
    submissions.push({
      url: page.url.toString(),
      docId: submission.docId,
      status: submission.status,
      retryable: false,
    })
  }
  return res.json({
    batchId,
    mode: "sitemap",
    total: pages.length,
    submitted: submissions.filter((s) => s.docId).length,
    failed: submissions.filter((s) => !s.docId).length,
    items: submissions,
  })
})

router.get("/ingest/:docId/status", (req: Request, res: Response) => {
  const lifecycle = createIngestionLifecycle(openDb())
  const status = lifecycle.getStatus(String(req.params.docId))

  if (!status) {
    return res.status(404).json({ error: "document not found" })
  }

  return res.json(status)
})

router.post("/ingest/:docId/cancel", (req: Request, res: Response) => {
  const lifecycle = createIngestionLifecycle(openDb())
  const result = lifecycle.cancel(String(req.params.docId))

  if (!result) {
    return res.status(404).json({ error: "document not found" })
  }

  return res.json(result)
})

export default router
