/**
 * URL 抓取工具：支持单 URL 抓取和 sitemap.xml 批量解析。
 *
 * P4.2 强制执行 P4.1 URL 安全策略：
 * - 每次 fetch 前调用 checkUrl() 校验 scheme/userinfo/host/IP。
 * - 每次重定向（3xx）重新解析、重新校验目标（DNS rebinding 防御）。
 *   同 host 重定向不豁免——REDIRECT_POLICY.requireReResolutionEvenIfSameHost。
 * - 重定向次数上限：REDIRECT_POLICY.maxRedirects（默认 5）。
 * - 超时上限：默认 30s（可通过 timeoutMs 覆盖），per-hop。
 * - 响应字节上限：默认 20MB（可通过 maxBytes 覆盖），流式校验，超限即中止。
 *
 * P4.3 ingestion lifecycle integration：
 * - UrlPolicyDenyError 携带 decision/stage/hop，供 API 层区分 non-retryable
 *   SSRF 拒绝 (422) 与 transient fetch error (502)。
 * - body-read 阶段同样受 per-hop timeout 保护（D-007 debt #1 修复）：
 *   AbortController timer 不再在 fetch 返回时立即清除，而是延续到
 *   readWithByteQuota 完成后。同时 readWithByteQuota 内有 elapsed-time
 *   检查作为二级防御（slowloris：服务器发一个 chunk 后挂起）。
 *
 * 设计要点：
 * - 单 URL：fetch HTML/文本 → Buffer，复用现有 parser pipeline
 * - Sitemap：fetch sitemap.xml → 解析 <loc> → 截断到 maxPages → 返回 URL 列表
 * - User-Agent：声明身份，便于站点识别
 *
 * 不做的事：
 * - 不遵守 robots.txt（MVP 简化；单 URL 无风险，sitemap 顺序抓取自带礼貌性）
 * - 不做 JS 渲染（如需 SPA 抓取，未来引入 puppeteer）
 * - 不做增量同步（每次调用都是一次性快照）
 *
 * 已知限制（P4.2 不修复，登记为 debt）：
 * - DNS rebinding between check and fetch：checkUrl 解析 DNS 后，fetch 内部
 *   会再次解析 DNS。攻击者可在两次解析之间切换 IP（公网 → 内网）。
 *   完整防御需要 IP pinning + 自建 socket + TLS SNI 锁定，超出 P4.2 范围。
 *   P4.2 实现的策略层 re-resolution 是 best-effort 防御，与 P4.1 契约一致。
 */

import { lookup as dnsLookup } from "node:dns/promises"
import {
  checkUrl,
  REDIRECT_POLICY,
  type HostResolver,
  type UrlPolicyDeny,
} from "./url_policy"

export const SITEMAP_DEFAULT_MAX_PAGES = 50
export const SITEMAP_HARD_MAX_PAGES = 200
const DEFAULT_USER_AGENT = "kefu-RAG-ingestion/1.0 (+https://github.com/kefu-rag)"

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024

export interface FetchedUrl {
  url: URL
  buffer: Buffer
  mimeType: string
  fileName: string
  title?: string
}

export interface FetchOptions {
  timeoutMs?: number
  maxBytes?: number
  userAgent?: string
  /**
   * Host resolver；默认使用 node:dns/promises.lookup({ all: true })。
   * 测试可注入合成 resolver 模拟 DNS rebinding、公网/内网解析等场景。
   */
  resolver?: HostResolver
  /**
   * Fetch 实现；默认使用 global fetch。测试可注入合成 fetch 模拟
   * 重定向链、超时、流式响应等场景，避免真实网络依赖。
   */
  fetchImpl?: typeof fetch
  /** 重定向上限；默认 REDIRECT_POLICY.maxRedirects (5)。 */
  maxRedirects?: number
}

export interface SitemapFetchOptions extends FetchOptions {
  maxPages: number
}

/**
 * 默认 host resolver，基于 node:dns/promises.lookup({ all: true })。
 * 返回所有 A/AAAA 地址。DNS 失败时抛错（由 classifyHost 转为 host_unresolvable）。
 */
export const DEFAULT_RESOLVER: HostResolver = async (hostname) => {
  const records = await dnsLookup(hostname, { all: true })
  return { addresses: records.map((r) => r.address) }
}

// --- 测试专用覆盖（生产代码从不调用） ---
// 允许 API 端到端测试注入合成 resolver + fetchImpl，无需修改 ingest.ts 路由签名。
// 生产路径 options.resolver / options.fetchImpl 优先；其次测试覆盖；最后默认值。
let _testResolverOverride: HostResolver | null = null
let _testFetchOverride: typeof fetch | null = null

export function _setTestDefaults(opts: {
  resolver?: HostResolver | null
  fetchImpl?: typeof fetch | null
}): void {
  _testResolverOverride = opts.resolver ?? null
  _testFetchOverride = opts.fetchImpl ?? null
}

/**
 * URL 策略拒绝错误。携带 P4.1 决策、阶段（initial/redirect）和 hop 序号。
 * P4.3 ingestion lifecycle 可根据 decision.reason 决定是否重试或进入 dead-letter。
 */
export class UrlPolicyDenyError extends Error {
  readonly decision: UrlPolicyDeny
  readonly stage: "initial" | "redirect"
  readonly hop: number

  constructor(decision: UrlPolicyDeny, stage: "initial" | "redirect", hop: number) {
    super(
      `url policy denied at ${stage} hop ${hop}: ${decision.reason} — ${decision.detail}`,
    )
    this.name = "UrlPolicyDenyError"
    this.decision = decision
    this.stage = stage
    this.hop = hop
  }
}

/**
 * 抓取单个 URL，返回 Buffer + 元数据。
 *
 * 强制执行 P4.1 URL 策略：
 * 1. 初始 URL 通过 checkUrl() 校验后才 fetch。
 * 2. 每个 3xx 重定向重新解析、重新校验目标 URL（DNS rebinding 防御）。
 * 3. 重定向次数超过 maxRedirects 时 fail closed。
 * 4. 每个 hop 有独立超时（AbortController + setTimeout）。
 * 5. 响应体流式读取，超过 maxBytes 即中止。
 *
 * 抛出错误：UrlPolicyDenyError（策略拒绝）、fetch failed（网络/超时）、
 * http status（非 2xx）、response size exceeds max（字节超限）、
 * redirect chain exceeds max（重定向超限）。
 */
export async function fetchSingleUrl(
  url: URL,
  options: FetchOptions = {},
): Promise<FetchedUrl> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT
  const resolver = options.resolver ?? _testResolverOverride ?? DEFAULT_RESOLVER
  const fetchImpl = options.fetchImpl ?? _testFetchOverride ?? fetch
  const maxRedirects = options.maxRedirects ?? REDIRECT_POLICY.maxRedirects

  let currentUrl = url
  let hop = 0

  // 初始 URL 策略校验——任何 fetch 之前。
  const initialDecision = await checkUrl(currentUrl, resolver)
  if (initialDecision.decision === "deny") {
    throw new UrlPolicyDenyError(initialDecision, "initial", 0)
  }

  // 手动重定向循环——每个 3xx 都重新校验目标。
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await fetchImpl(currentUrl, {
        signal: controller.signal,
        redirect: "manual",
        headers: {
          "user-agent": userAgent,
          accept: "text/html,application/xhtml+xml,text/plain,application/xml,*/*;q=0.8",
        },
      })
    } catch (err) {
      clearTimeout(timer)
      const msg =
        err instanceof Error
          ? err.name === "AbortError"
            ? `timeout after ${timeoutMs}ms`
            : err.message
          : String(err)
      throw new Error(`fetch failed: ${msg}`)
    }
    // P4.3 (D-007 debt #1): 不在此处 clearTimeout — body-read 阶段同样受
    // per-hop timeout 保护。timer 在 readWithByteQuota 完成、redirect drain、
    // 或错误路径中清除。slowloris 防御：服务器发 headers 后挂起，abort 信号
    // 会让 reader.read() 抛错，readWithByteQuota 内捕获并转为 body_read_timeout。

    // 3xx 重定向——重新校验目标。
    if (response.status >= 300 && response.status < 400) {
      hop++
      if (hop > maxRedirects) {
        await drainBody(response)
        clearTimeout(timer)
        throw new Error(`redirect chain exceeds max ${maxRedirects}`)
      }
      const location = response.headers.get("location")
      if (!location) {
        await drainBody(response)
        clearTimeout(timer)
        throw new Error(`redirect status ${response.status} without Location header`)
      }
      let nextUrl: URL
      try {
        nextUrl = new URL(location, currentUrl)
      } catch {
        await drainBody(response)
        clearTimeout(timer)
        throw new Error(`invalid redirect Location: ${location}`)
      }
      // 重定向目标重新解析、重新校验——DNS rebinding 防御。
      // 即使同 host 也重新解析（REDIRECT_POLICY.requireReResolutionEvenIfSameHost）。
      const redirectDecision = await checkUrl(nextUrl, resolver)
      if (redirectDecision.decision === "deny") {
        await drainBody(response)
        clearTimeout(timer)
        throw new UrlPolicyDenyError(redirectDecision, "redirect", hop)
      }
      await drainBody(response)
      clearTimeout(timer)
      currentUrl = nextUrl
      continue
    }

    if (!response.ok) {
      await drainBody(response)
      clearTimeout(timer)
      throw new Error(`http ${response.status} ${response.statusText}`)
    }

    // 流式读取响应体，超 maxBytes 即中止。
    // P4.3: body-read 受同一 per-hop timeout 保护（timer 尚未清除）。
    let buffer: Buffer
    try {
      buffer = await readWithByteQuota(response, maxBytes, timeoutMs)
    } catch (err) {
      clearTimeout(timer)
      throw err
    }
    clearTimeout(timer)
    const mimeType =
      response.headers.get("content-type")?.split(";")[0]?.trim() ||
      guessMimeFromUrl(currentUrl)
    const fileName = deriveFileName(currentUrl, mimeType)
    const title = extractHtmlTitle(buffer, mimeType)
    return { url: currentUrl, buffer, mimeType, fileName, title }
  }
}

/**
 * 流式读取响应体，超过 maxBytes 即中止。
 * - 先检查 content-length（如果有），超限立即拒绝。
 * - 逐 chunk 累计，超限即 cancel reader 并抛错（防御 chunked 编码中途超限）。
 *
 * P4.3 (D-007 debt #1): body-read 阶段受 timeoutMs 保护：
 * - 一级防御：调用方保留 AbortController timer，超时触发 abort → reader.read() 抛错。
 * - 二级防御：本函数内 elapsed-time 检查，每个 chunk 到达后校验总耗时。
 * - 两级防御覆盖两种 slowloris 形态：服务器挂起（一级）和慢速滴 chunk（二级）。
 */
async function readWithByteQuota(
  response: Response,
  maxBytes: number,
  bodyReadTimeoutMs: number,
): Promise<Buffer> {
  const contentLength = response.headers.get("content-length")
  if (contentLength && parseInt(contentLength, 10) > maxBytes) {
    await drainBody(response)
    throw new Error(`content-length ${contentLength} exceeds max ${maxBytes}`)
  }
  if (!response.body) {
    return Buffer.alloc(0)
  }
  const startedAt = Date.now()
  const chunks: Buffer[] = []
  let total = 0
  const reader = response.body.getReader()
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let result
      try {
        result = await reader.read()
      } catch {
        // 一级防御触发：AbortController timer 超时，abort 信号让 reader 抛错。
        // 这是 slowloris 主防御——服务器发 headers 后挂起，reader.read() 永不返回，
        // timer 触发 abort 后 reader 抛错。转换为清晰的 body_read_timeout 错误。
        throw new Error(`body_read_timeout after ${bodyReadTimeoutMs}ms`)
      }
      if (result.done) break
      const chunk = result.value
      total += chunk.byteLength
      if (total > maxBytes) {
        try {
          await reader.cancel()
        } catch {
          /* ignore */
        }
        throw new Error(
          `response size exceeds max ${maxBytes} (at ${total} bytes)`,
        )
      }
      // 二级防御：elapsed-time 检查。覆盖慢速滴 chunk 场景
      // （服务器持续发小 chunk 但速率极低，一级防御的 reader.read() 不抛错）。
      if (Date.now() - startedAt > bodyReadTimeoutMs) {
        try {
          await reader.cancel()
        } catch {
          /* ignore */
        }
        throw new Error(`body_read_timeout after ${bodyReadTimeoutMs}ms`)
      }
      chunks.push(Buffer.from(chunk))
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* ignore */
    }
  }
  return Buffer.concat(chunks, total)
}

/** 排空响应体，避免资源泄漏。 */
async function drainBody(response: Response): Promise<void> {
  if (response.body) {
    try {
      await response.body.cancel()
    } catch {
      /* ignore */
    }
  }
}

/**
 * 抓取 sitemap.xml，解析所有 <loc>，截断到 maxPages 后返回 URL 列表。
 * 不抓取页面内容——页面抓取留给调用方（避免在此函数做 N 次网络请求）。
 *
 * 注意：sitemap.xml 本身的 fetch 受 P4.1 策略强制（通过 fetchSingleUrl）。
 * 返回的 URL 列表未校验——调用方在逐个 fetchSingleUrl 时会校验。
 */
export async function fetchSitemapUrls(
  sitemapUrl: URL,
  options: SitemapFetchOptions,
): Promise<{ url: URL; fileName: string }[]> {
  const fetched = await fetchSingleUrl(sitemapUrl, options)
  const xml = fetched.buffer.toString("utf8")
  const urls = parseSitemapXml(xml)
  const capped = urls.slice(0, options.maxPages)
  return capped
    .map((u) => {
      let parsed: URL
      try {
        parsed = new URL(u)
      } catch {
        // 跳过无效 URL，避免整个 sitemap 失败
        return null
      }
      return {
        url: parsed,
        fileName: deriveFileName(parsed, guessMimeFromUrl(parsed)),
      }
    })
    .filter((x): x is { url: URL; fileName: string } => x !== null)
}

/**
 * 解析 sitemap.xml，返回所有 <loc> 文本内容。
 * 支持普通 sitemap 和 sitemap index（递归一层）。
 * 不依赖外部 XML 库，用正则提取（sitemap 格式简单，正则足够）。
 */
export function parseSitemapXml(xml: string): string[] {
  const urls: string[] = []
  // 普通sitemap: <url><loc>...</loc></url>
  const urlRegex = /<url>\s*<loc>([^<]+)<\/loc>/gi
  let match: RegExpExecArray | null
  while ((match = urlRegex.exec(xml)) !== null) {
    urls.push(match[1].trim())
  }
  // sitemap index: <sitemap><loc>...</loc></sitemap>
  // 此处简化：只取 <sitemap><loc> 里的内容作为子 sitemap URL，但不递归（避免无限抓取）
  // 如果检测到 sitemap index，返回空列表并提示调用方——MVP 阶段不展开
  if (urls.length === 0) {
    const sitemapIndexRegex = /<sitemap>\s*<loc>([^<]+)<\/loc>/gi
    const indexUrls: string[] = []
    while ((match = sitemapIndexRegex.exec(xml)) !== null) {
      indexUrls.push(match[1].trim())
    }
    if (indexUrls.length > 0) {
      throw new Error(
        `sitemap index detected with ${indexUrls.length} child sitemaps; nested sitemap indexes are not supported in MVP. Please provide a leaf sitemap URL directly.`,
      )
    }
  }
  return urls
}

function deriveFileName(url: URL, mimeType: string): string {
  const pathname = url.pathname
  const lastSegment = pathname.split("/").filter(Boolean).pop()
  if (lastSegment && /\.[a-z0-9]{1,8}$/i.test(lastSegment)) {
    return decodeURIComponent(lastSegment)
  }
  // 无扩展名或路径为空，按 mime 推扩展名
  const ext = mimeToExtension(mimeType)
  return lastSegment ? `${decodeURIComponent(lastSegment)}.${ext}` : `index.${ext}`
}

function guessMimeFromUrl(url: URL): string {
  const lastSegment = url.pathname.split("/").filter(Boolean).pop() || ""
  const dotIdx = lastSegment.lastIndexOf(".")
  if (dotIdx < 0) return "text/html"
  const ext = lastSegment.slice(dotIdx).toLowerCase()
  const map: Record<string, string> = {
    ".html": "text/html",
    ".htm": "text/html",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".pdf": "application/pdf",
    ".xml": "application/xml",
  }
  return map[ext] || "text/html"
}

function mimeToExtension(mimeType: string): string {
  const base = mimeType.split(";")[0].trim().toLowerCase()
  const map: Record<string, string> = {
    "text/html": "html",
    "text/plain": "txt",
    "text/markdown": "md",
    "application/pdf": "pdf",
    "application/xml": "xml",
  }
  return map[base] || "html"
}

function extractHtmlTitle(buffer: Buffer, mimeType: string): string | undefined {
  if (!mimeType.includes("html")) return undefined
  const text = buffer.toString("utf8").slice(0, 8192) // 只看前 8KB，title 通常在 head
  const match = /<title[^>]*>([^<]*)<\/title>/i.exec(text)
  if (!match) return undefined
  const title = match[1].trim()
  return title || undefined
}
