import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import test from "node:test"
import { createApp } from "./server"
import { closeDb, openDb } from "../ingestion/tracking"
import { DocumentRepo } from "../ingestion/tracking/doc_repo"
import { _setTestDefaults } from "../ingestion/url_fetcher"
import type { HostResolver } from "../ingestion/url_policy"
import type { AnswerEventsSource } from "./chat"
import type { RequestHandler } from "express"

const eventsSource: AnswerEventsSource = async function* () {}

const PUBLIC_IP = "93.184.216.34"

const tenantAccessMiddleware: RequestHandler = (_req, res, next) => {
  res.locals.accessContext = {
    tenantId: "tenant-a",
    subjectId: "support-user",
    groups: ["support"],
    scopes: ["ingest"],
  }
  next()
}

/** 合成 resolver：将 public.test 解析为公网 IP，绕过 SSRF 策略的 IP 校验。 */
const PUBLIC_TEST_RESOLVER: HostResolver = async (hostname) => {
  if (hostname === "public.test" || hostname === "error.test") {
    return { addresses: [PUBLIC_IP] }
  }
  throw new Error(`no synthetic resolution for ${hostname}`)
}

test("raw file ingestion accepts bounded bytes and file metadata before JSON parsing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kefu-rag-api-"))
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
  process.env.SQLITE_PATH = join(directory, "ingestion.db")
  const server = createApp({ eventsSource, ingestAccessMiddleware: tenantAccessMiddleware }).listen(0)

  try {
    await new Promise<void>((resolve) => server.once("listening", resolve))
    const address = server.address()
    assert.ok(address && typeof address === "object")
    const response = await fetch(`http://127.0.0.1:${address.port}/api/ingest/file`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-file-name": "policy.docx",
        "x-file-mime-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "x-parser": "markitdown",
        "x-source-kind": "file",
        "x-source-id": "C:/knowledge/policy.docx",
        "x-source-namespace": "local",
        "x-tenant-id": "attacker-tenant",
      },
      body: Buffer.from([0x00, 0xff, 0x41]),
    })

    assert.equal(response.status, 200)
    const submitted = await response.json() as { docId: string; status: string }
    assert.equal(submitted.status, "pending")
    const document = new DocumentRepo(openDb()).get(submitted.docId)
    assert.equal(document?.fileName, "policy.docx")
    assert.equal(
      document?.mimeType,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    )
    assert.equal(document?.parserOverride, "markitdown")
    assert.deepEqual(document?.rawContent, Buffer.from([0x00, 0xff, 0x41]))
    assert.equal(document?.tenantId, "tenant-a")
    assert.deepEqual(document?.allowedGroups, ["support"])
    const source = openDb().prepare(
      "SELECT tenant_id, allowed_groups FROM sources WHERE source_id = ?"
    ).get(document!.sourceId) as { tenant_id: string; allowed_groups: string }
    assert.equal(source.tenant_id, "tenant-a")
    assert.deepEqual(JSON.parse(source.allowed_groups), ["support"])
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    closeDb()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("JSON ingestion replaces caller-supplied ACL metadata with trusted access context", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kefu-rag-api-acl-"))
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
  process.env.SQLITE_PATH = join(directory, "ingestion.db")
  const server = createApp({
    eventsSource,
    ingestAccessMiddleware: tenantAccessMiddleware,
  }).listen(0)
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve))
    const address = server.address()
    assert.ok(address && typeof address === "object")
    const response = await fetch(`http://127.0.0.1:${address.port}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Policy",
        content: "Trusted ACL",
        sourceIdentity: {
          kind: "file",
          uriOrExternalId: "C:/knowledge/policy.txt",
          namespace: "upload",
          tenantId: "attacker-tenant",
          allowedGroups: ["attacker-group"],
        },
      }),
    })
    assert.equal(response.status, 200)
    const submitted = await response.json() as { docId: string }
    const document = new DocumentRepo(openDb()).get(submitted.docId)
    assert.equal(document?.tenantId, "tenant-a")
    assert.deepEqual(document?.allowedGroups, ["support"])
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    closeDb()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("/ingest/url single mode fetches a URL and submits raw bytes to the lifecycle", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kefu-rag-url-"))
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
  process.env.SQLITE_PATH = join(directory, "ingestion.db")

  // 准备一个本地 HTTP 服务器，返回一段 HTML
  const html = `<!DOCTYPE html><html><head><title>测试文档</title></head><body><h1>hello</h1></body></html>`
  const upstream = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    res.end(html)
  })
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  const upstreamAddr = upstream.address()
  assert.ok(upstreamAddr && typeof upstreamAddr === "object")
  const upstreamPort = upstreamAddr.port

  // P4.2: 注入合成 resolver + fetchImpl，使策略校验通过（public.test → 公网 IP），
  // 同时将实际 HTTP 请求重定向到本地测试服务器。
  const fetchImpl: typeof fetch = (input, init) => {
    const url = input instanceof URL ? input : new URL(String(input))
    const localUrl = `http://127.0.0.1:${upstreamPort}${url.pathname}${url.search}`
    return fetch(localUrl, init)
  }
  _setTestDefaults({ resolver: PUBLIC_TEST_RESOLVER, fetchImpl })

  const server = createApp({ eventsSource, ingestAccessMiddleware: tenantAccessMiddleware }).listen(0)
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve))
    const address = server.address()
    assert.ok(address && typeof address === "object")

    const response = await fetch(`http://127.0.0.1:${address.port}/api/ingest/url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: `http://public.test/article`,
      }),
    })
    assert.equal(response.status, 200)
    const submitted = await response.json() as { docId: string; status: string }
    assert.equal(submitted.status, "pending")

    const document = new DocumentRepo(openDb()).get(submitted.docId)
    assert.equal(document?.fileName, "article.html")
    assert.equal(document?.mimeType, "text/html")
    assert.equal(document?.title, "测试文档")
    assert.deepEqual(document?.rawContent, Buffer.from(html, "utf8"))
    assert.equal(document?.tenantId, "tenant-a")
    assert.deepEqual(document?.allowedGroups, ["support"])
  } finally {
    _setTestDefaults({})
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
    closeDb()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("/ingest/url rejects invalid url with 400", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kefu-rag-url-invalid-"))
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
  process.env.SQLITE_PATH = join(directory, "ingestion.db")
  const server = createApp({ eventsSource }).listen(0)
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve))
    const address = server.address()
    assert.ok(address && typeof address === "object")
    const response = await fetch(`http://127.0.0.1:${address.port}/api/ingest/url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "not-a-url" }),
    })
    assert.equal(response.status, 400)
    const body = await response.json() as { error: string }
    assert.match(body.error, /valid absolute URL/i)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    closeDb()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("/ingest/url rejects non-http protocols with 400", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kefu-rag-url-proto-"))
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
  process.env.SQLITE_PATH = join(directory, "ingestion.db")
  const server = createApp({ eventsSource }).listen(0)
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve))
    const address = server.address()
    assert.ok(address && typeof address === "object")
    const response = await fetch(`http://127.0.0.1:${address.port}/api/ingest/url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "file:///etc/passwd" }),
    })
    assert.equal(response.status, 400)
    const body = await response.json() as { error: string }
    assert.match(body.error, /http or https/i)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    closeDb()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("/ingest/url returns 502 when upstream fetch fails", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kefu-rag-url-502-"))
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
  process.env.SQLITE_PATH = join(directory, "ingestion.db")

  // P4.2: 注入合成 fetchImpl 模拟连接失败（策略校验通过后 fetch 抛错）。
  const fetchImpl: typeof fetch = () =>
    Promise.reject(new Error("ECONNREFUSED synthetic"))
  _setTestDefaults({ resolver: PUBLIC_TEST_RESOLVER, fetchImpl })

  const server = createApp({ eventsSource }).listen(0)
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve))
    const address = server.address()
    assert.ok(address && typeof address === "object")
    const response = await fetch(`http://127.0.0.1:${address.port}/api/ingest/url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://error.test/nope" }),
    })
    assert.equal(response.status, 502)
    const body = await response.json() as { error: string; detail: string }
    assert.match(body.error, /failed to fetch url/i)
    assert.match(body.detail, /fetch failed/i)
  } finally {
    _setTestDefaults({})
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    closeDb()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("/ingest/url sitemap mode parses sitemap and submits each page", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kefu-rag-sitemap-"))
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
  process.env.SQLITE_PATH = join(directory, "ingestion.db")

  // P4.2: 使用单个本地服务器同时提供 sitemap.xml 和页面内容。
  // sitemap.xml 中的 URL 使用 public.test，通过合成 resolver 解析为公网 IP。
  const pageHtml = `<!DOCTYPE html><html><head><title>页面</title></head><body><p>内容</p></body></html>`
  const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>http://public.test/p1</loc></url>
  <url><loc>http://public.test/p2</loc></url>
</urlset>`

  const upstream = createServer((req, res) => {
    if (req.url === "/sitemap.xml") {
      res.writeHead(200, { "content-type": "application/xml" })
      res.end(sitemapXml)
    } else {
      res.writeHead(200, { "content-type": "text/html" })
      res.end(pageHtml)
    }
  })
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  const upstreamAddr = upstream.address()
  assert.ok(upstreamAddr && typeof upstreamAddr === "object")
  const upstreamPort = upstreamAddr.port

  // P4.2: 注入合成 resolver + fetchImpl，使策略校验通过，
  // 同时将实际 HTTP 请求重定向到本地测试服务器。
  const fetchImpl: typeof fetch = (input, init) => {
    const url = input instanceof URL ? input : new URL(String(input))
    const localUrl = `http://127.0.0.1:${upstreamPort}${url.pathname}${url.search}`
    return fetch(localUrl, init)
  }
  _setTestDefaults({ resolver: PUBLIC_TEST_RESOLVER, fetchImpl })

  const server = createApp({ eventsSource, ingestAccessMiddleware: tenantAccessMiddleware }).listen(0)
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve))
    const address = server.address()
    assert.ok(address && typeof address === "object")

    const response = await fetch(`http://127.0.0.1:${address.port}/api/ingest/url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: `http://public.test/sitemap.xml`,
        mode: "sitemap",
        maxPages: 5,
      }),
    })
    assert.equal(response.status, 200)
    const result = await response.json() as {
      batchId: string
      mode: string
      total: number
      submitted: number
      failed: number
      items: { url: string; docId: string; status: string }[]
    }
    assert.equal(result.mode, "sitemap")
    assert.equal(result.total, 2)
    assert.equal(result.submitted, 2)
    assert.equal(result.failed, 0)
    assert.match(result.batchId, /^sitemap-/)
    assert.equal(result.items.length, 2)
    for (const item of result.items) {
      assert.ok(item.docId, "每个成功项应有 docId")
      assert.equal(item.status, "pending")
      const document = new DocumentRepo(openDb()).get(item.docId)
      assert.equal(document?.tenantId, "tenant-a")
      assert.deepEqual(document?.allowedGroups, ["support"])
    }
  } finally {
    _setTestDefaults({})
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
    closeDb()
    rmSync(directory, { recursive: true, force: true })
  }
})

// --- P4.3 ingestion lifecycle integration 测试 ---
// SSRF 拒绝 (UrlPolicyDenyError) 必须可 inspectable 且 retry-safe（non-retryable）。
// Transient fetch error 必须 retryable。两者通过 HTTP 状态码 (422 vs 502) 和
// 响应体 retryable 字段区分。

test("P4.3: SSRF rejection returns 422 with inspectable decision reason (non-retryable)", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kefu-rag-ssrf-422-"))
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
  process.env.SQLITE_PATH = join(directory, "ingestion.db")

  // 不注入合成 resolver — 让真实策略拒绝 loopback URL (127.0.0.1)。
  // fetchImpl 即使被调用也不应到达（策略校验在 fetch 之前）。
  let fetchCalled = false
  const fetchImpl: typeof fetch = () => {
    fetchCalled = true
    return Promise.resolve(new Response("should not reach", { status: 200 }))
  }
  _setTestDefaults({ fetchImpl })

  const server = createApp({ eventsSource }).listen(0)
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve))
    const address = server.address()
    assert.ok(address && typeof address === "object")

    const response = await fetch(`http://127.0.0.1:${address.port}/api/ingest/url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://127.0.0.1/secret" }),
    })
    assert.equal(response.status, 422)
    const body = await response.json() as {
      error: string
      reason: string
      detail: string
      stage: string
      hop: number
      retryable: boolean
    }
    assert.equal(body.error, "url policy denied")
    assert.equal(body.reason, "ip_denied_loopback")
    assert.ok(body.detail.includes("127.0.0.1"), "detail should contain the denied IP")
    assert.equal(body.stage, "initial")
    assert.equal(body.hop, 0)
    assert.equal(body.retryable, false, "SSRF rejection must be non-retryable")
    assert.equal(fetchCalled, false, "fetch must NOT be called for SSRF-denied URL")
  } finally {
    _setTestDefaults({})
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    closeDb()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("P4.3: transient fetch error returns 502 with retryable=true", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kefu-rag-502-retry-"))
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
  process.env.SQLITE_PATH = join(directory, "ingestion.db")

  // 注入合成 resolver 使策略校验通过，但 fetchImpl 抛 ECONNREFUSED（transient）。
  const fetchImpl: typeof fetch = () =>
    Promise.reject(new Error("ECONNREFUSED synthetic"))
  _setTestDefaults({ resolver: PUBLIC_TEST_RESOLVER, fetchImpl })

  const server = createApp({ eventsSource }).listen(0)
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve))
    const address = server.address()
    assert.ok(address && typeof address === "object")

    const response = await fetch(`http://127.0.0.1:${address.port}/api/ingest/url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://error.test/nope" }),
    })
    assert.equal(response.status, 502)
    const body = await response.json() as {
      error: string
      detail: string
      retryable: boolean
    }
    assert.match(body.error, /failed to fetch url/i)
    assert.match(body.detail, /fetch failed/i)
    assert.equal(body.retryable, true, "transient fetch error must be retryable")
  } finally {
    _setTestDefaults({})
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    closeDb()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("P4.3: SSRF rejection at redirect stage carries stage=redirect in 422 response", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kefu-rag-ssrf-redirect-"))
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
  process.env.SQLITE_PATH = join(directory, "ingestion.db")

  // 合成 fetch：首次返回 301 重定向到 127.0.0.1（loopback）。
  // 策略校验在重定向阶段拒绝 → UrlPolicyDenyError(stage=redirect, hop=1)。
  const fetchImpl: typeof fetch = () =>
    Promise.resolve(
      new Response(null, {
        status: 301,
        headers: { location: "http://127.0.0.1/secret" },
      }),
    )
  _setTestDefaults({ resolver: PUBLIC_TEST_RESOLVER, fetchImpl })

  const server = createApp({ eventsSource }).listen(0)
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve))
    const address = server.address()
    assert.ok(address && typeof address === "object")

    const response = await fetch(`http://127.0.0.1:${address.port}/api/ingest/url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://public.test/article" }),
    })
    assert.equal(response.status, 422)
    const body = await response.json() as {
      error: string
      reason: string
      stage: string
      hop: number
      retryable: boolean
    }
    assert.equal(body.error, "url policy denied")
    assert.equal(body.reason, "ip_denied_loopback")
    assert.equal(body.stage, "redirect", "stage must be redirect for redirect-stage denial")
    assert.equal(body.hop, 1)
    assert.equal(body.retryable, false)
  } finally {
    _setTestDefaults({})
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    closeDb()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("P4.3: sitemap mode marks SSRF-denied pages as ssrf_denied with retryable=false", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kefu-rag-sitemap-ssrf-"))
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key"
  process.env.SQLITE_PATH = join(directory, "ingestion.db")

  // sitemap.xml 包含两个 URL：一个 public（成功），一个 loopback（SSRF 拒绝）。
  const pageHtml = `<!DOCTYPE html><html><head><title>页面</title></head><body><p>内容</p></body></html>`
  const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>http://public.test/p1</loc></url>
  <url><loc>http://127.0.0.1/secret</loc></url>
</urlset>`

  const upstream = createServer((req, res) => {
    if (req.url === "/sitemap.xml") {
      res.writeHead(200, { "content-type": "application/xml" })
      res.end(sitemapXml)
    } else {
      res.writeHead(200, { "content-type": "text/html" })
      res.end(pageHtml)
    }
  })
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  const upstreamAddr = upstream.address()
  assert.ok(upstreamAddr && typeof upstreamAddr === "object")
  const upstreamPort = upstreamAddr.port

  // 合成 fetchImpl：将 public.test 的请求重定向到本地服务器。
  // 127.0.0.1 的请求不会被调用（策略在 fetch 前拒绝）。
  const fetchImpl: typeof fetch = (input, init) => {
    const url = input instanceof URL ? input : new URL(String(input))
    const localUrl = `http://127.0.0.1:${upstreamPort}${url.pathname}${url.search}`
    return fetch(localUrl, init)
  }
  _setTestDefaults({ resolver: PUBLIC_TEST_RESOLVER, fetchImpl })

  const server = createApp({ eventsSource }).listen(0)
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve))
    const address = server.address()
    assert.ok(address && typeof address === "object")

    const response = await fetch(`http://127.0.0.1:${address.port}/api/ingest/url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: `http://public.test/sitemap.xml`,
        mode: "sitemap",
        maxPages: 5,
      }),
    })
    assert.equal(response.status, 200)
    const result = await response.json() as {
      batchId: string
      mode: string
      total: number
      submitted: number
      failed: number
      items: { url: string; docId: string; status: string; retryable: boolean }[]
    }
    assert.equal(result.total, 2)
    assert.equal(result.submitted, 1, "only the public URL should be submitted")
    assert.equal(result.failed, 1, "the SSRF-denied URL should be counted as failed")

    const ssrfItem = result.items.find((i) => i.url === "http://127.0.0.1/secret")
    assert.ok(ssrfItem, "SSRF-denied item should be in the result")
    assert.equal(ssrfItem!.docId, "", "SSRF-denied item should have empty docId")
    assert.match(ssrfItem!.status, /ssrf_denied: ip_denied_loopback/)
    assert.equal(ssrfItem!.retryable, false, "SSRF-denied item must be non-retryable")

    const okItem = result.items.find((i) => i.url === "http://public.test/p1")
    assert.ok(okItem, "successful item should be in the result")
    assert.ok(okItem!.docId, "successful item should have docId")
    assert.equal(okItem!.retryable, false, "successful item is not retryable (already submitted)")
  } finally {
    _setTestDefaults({})
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
    closeDb()
    rmSync(directory, { recursive: true, force: true })
  }
})
