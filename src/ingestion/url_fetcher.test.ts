import assert from "node:assert/strict"
import test from "node:test"
import {
  parseSitemapXml,
  fetchSitemapUrls,
  fetchSingleUrl,
  SITEMAP_DEFAULT_MAX_PAGES,
  SITEMAP_HARD_MAX_PAGES,
  UrlPolicyDenyError,
} from "./url_fetcher"
import type { HostResolver } from "./url_policy"

// --- 测试辅助 ---

const PUBLIC_IP = "93.184.216.34"

/** 合成 resolver：按 hostname 映射到地址列表。未映射的 hostname 抛错。 */
function createResolver(map: Record<string, string[]>): HostResolver {
  return async (hostname) => {
    const addresses = map[hostname]
    if (!addresses) throw new Error(`no synthetic resolution for ${hostname}`)
    return { addresses }
  }
}

/** 合成 resolver：按调用顺序返回地址列表（模拟 DNS rebinding）。 */
function createSequentialResolver(sequence: string[][]): HostResolver {
  let i = 0
  return async () => {
    if (i >= sequence.length) throw new Error("no more synthetic resolutions")
    return { addresses: sequence[i++] }
  }
}

/** 合成 fetch：始终返回同一 Response。 */
function createStaticFetch(response: Response): typeof fetch {
  return () => Promise.resolve(response)
}

/** 合成 fetch：按调用顺序返回 Response 序列。 */
function createSequentialFetch(responses: Response[]): typeof fetch {
  let i = 0
  return () => {
    if (i >= responses.length) {
      return Promise.reject(new Error("no more synthetic responses"))
    }
    return Promise.resolve(responses[i++])
  }
}

/** 合成 fetch：返回重定向链，最后一跳为 finalResponse。 */
function createRedirectChainFetch(
  locations: string[],
  finalResponse: Response,
): typeof fetch {
  let i = 0
  return () => {
    if (i < locations.length) {
      const loc = locations[i++]
      return Promise.resolve(
        new Response(null, { status: 301, headers: { location: loc } }),
      )
    }
    return Promise.resolve(finalResponse)
  }
}

/** 合成 fetch：永不解析（模拟慢响应），尊重 signal 中止。 */
function createSlowFetch(delayMs: number): typeof fetch {
  return (_input, init) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init?.signal
      const timer = setTimeout(
        () => resolve(new Response("ok", { status: 200 })),
        delayMs,
      )
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer)
          const err = new Error("aborted")
          err.name = "AbortError"
          reject(err)
          return
        }
        signal.addEventListener("abort", () => {
          clearTimeout(timer)
          const err = new Error("aborted")
          err.name = "AbortError"
          reject(err)
        })
      }
    })
}

/** 合成 fetch：返回流式响应体，总字节数 totalBytes，每块 chunkSize。 */
function createStreamingResponse(
  totalBytes: number,
  chunkSize: number,
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let remaining = totalBytes
      while (remaining > 0) {
        const size = Math.min(chunkSize, remaining)
        controller.enqueue(new Uint8Array(size))
        remaining -= size
      }
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/plain" },
  })
}

/**
 * 合成 fetch：立即返回 headers，但 body 流在发完第一个 chunk 后
 * 延迟 delayMs 才发下一个 chunk（slowloris 模拟）。
 * 尊重 abort signal — signal 触发时 error 流，让 reader.read() 抛错。
 */
function createSlowBodyFetch(delayMs: number, body: string): typeof fetch {
  return (_input, init) => {
    const signal = init?.signal
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // 第一个 chunk 立即发送
        controller.enqueue(encoder.encode(body.slice(0, 1)))
        // 后续 chunk 延迟发送（slowloris）
        const timer = setTimeout(() => {
          controller.enqueue(encoder.encode(body.slice(1)))
          controller.close()
        }, delayMs)
        if (signal) {
          if (signal.aborted) {
            clearTimeout(timer)
            controller.error(new Error("aborted"))
            return
          }
          signal.addEventListener("abort", () => {
            clearTimeout(timer)
            controller.error(new Error("aborted"))
          })
        }
      },
    })
    return Promise.resolve(
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    )
  }
}

/** 公网 resolver：所有 hostname 解析为公网 IP。 */
const PUBLIC_RESOLVER = createResolver({
  "public.test": [PUBLIC_IP],
  "public-a.test": [PUBLIC_IP],
  "public-b.test": [PUBLIC_IP],
  "public-c.test": [PUBLIC_IP],
  "public-d.test": [PUBLIC_IP],
  "rebind.test": [PUBLIC_IP],
})

// --- 现有 parseSitemapXml 测试（保持不变） ---

test("parseSitemapXml extracts all <loc> entries from a standard sitemap", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/page-1</loc></url>
  <url><loc>https://example.com/page-2</loc></url>
  <url><loc>https://example.com/page-3</loc></url>
</urlset>`
  const urls = parseSitemapXml(xml)
  assert.deepEqual(urls, [
    "https://example.com/page-1",
    "https://example.com/page-2",
    "https://example.com/page-3",
  ])
})

test("parseSitemapXml returns empty array for xml without <url> entries", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>`
  const urls = parseSitemapXml(xml)
  assert.deepEqual(urls, [])
})

test("parseSitemapXml throws on sitemap index (nested sitemaps not supported)", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/sitemap-1.xml</loc></sitemap>
  <sitemap><loc>https://example.com/sitemap-2.xml</loc></sitemap>
</sitemapindex>`
  assert.throws(
    () => parseSitemapXml(xml),
    /sitemap index detected with 2 child sitemaps/,
  )
})

test("parseSitemapXml is case-insensitive and tolerates whitespace", () => {
  const xml = `<URLSET>
    <URL>  <LOC>https://example.com/a</LOC>  </URL>
    <Url><Loc>https://example.com/b</Loc></Url>
  </URLSET>`
  const urls = parseSitemapXml(xml)
  assert.deepEqual(urls, ["https://example.com/a", "https://example.com/b"])
})

test("SITEMAP_DEFAULT_MAX_PAGES is 50 and HARD_MAX_PAGES is 200", () => {
  assert.equal(SITEMAP_DEFAULT_MAX_PAGES, 50)
  assert.equal(SITEMAP_HARD_MAX_PAGES, 200)
})

// --- 现有 fetch 测试（更新为使用合成 resolver + fetchImpl） ---

test("fetchSingleUrl returns buffer + metadata for a synthetic public response", async () => {
  const html = `<!DOCTYPE html><html><head><title>测试页面</title></head><body><p>hello</p></body></html>`
  const fetchImpl = createStaticFetch(
    new Response(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
  )
  const fetched = await fetchSingleUrl(new URL("http://public.test/article"), {
    resolver: PUBLIC_RESOLVER,
    fetchImpl,
    timeoutMs: 3000,
  })
  assert.equal(fetched.mimeType, "text/html")
  assert.equal(fetched.fileName, "article.html")
  assert.equal(fetched.title, "测试页面")
  assert.deepEqual(fetched.buffer, Buffer.from(html, "utf8"))
})

test("fetchSitemapUrls respects maxPages cap with synthetic fetch", async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/p1</loc></url>
  <url><loc>https://example.com/p2</loc></url>
  <url><loc>https://example.com/p3</loc></url>
  <url><loc>https://example.com/p4</loc></url>
  <url><loc>https://example.com/p5</loc></url>
</urlset>`
  const fetchImpl = createStaticFetch(
    new Response(xml, {
      status: 200,
      headers: { "content-type": "application/xml" },
    }),
  )
  const urls = await fetchSitemapUrls(
    new URL("http://public.test/sitemap.xml"),
    {
      maxPages: 2,
      timeoutMs: 3000,
      resolver: PUBLIC_RESOLVER,
      fetchImpl,
    },
  )
  assert.equal(urls.length, 2)
  assert.equal(urls[0].url.toString(), "https://example.com/p1")
  assert.equal(urls[1].url.toString(), "https://example.com/p2")
  assert.equal(urls[0].fileName, "p1.html")
})

// --- P4.2 强制执行测试 ---

test("P4.2: public URL is allowed and fetched", async () => {
  let fetchCalled = false
  const fetchImpl: typeof fetch = (_input, _init) => {
    fetchCalled = true
    return Promise.resolve(
      new Response("hello", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    )
  }
  const fetched = await fetchSingleUrl(new URL("http://public.test/"), {
    resolver: PUBLIC_RESOLVER,
    fetchImpl,
    timeoutMs: 3000,
  })
  assert.equal(fetchCalled, true)
  assert.equal(fetched.buffer.toString("utf8"), "hello")
})

test("P4.2: loopback URL is denied before fetch (no fetch call)", async () => {
  let fetchCalled = false
  const fetchImpl: typeof fetch = () => {
    fetchCalled = true
    return Promise.resolve(new Response("should not reach", { status: 200 }))
  }
  await assert.rejects(
    () =>
      fetchSingleUrl(new URL("http://127.0.0.1/"), {
        resolver: PUBLIC_RESOLVER,
        fetchImpl,
        timeoutMs: 3000,
      }),
    (err: unknown) => {
      assert.ok(err instanceof UrlPolicyDenyError, "should be UrlPolicyDenyError")
      assert.equal(err.stage, "initial")
      assert.equal(err.hop, 0)
      assert.equal(err.decision.decision, "deny")
      assert.equal(err.decision.reason, "ip_denied_loopback")
      return true
    },
  )
  assert.equal(fetchCalled, false, "fetch must NOT be called for denied URL")
})

test("P4.2: private URL is denied before fetch", async () => {
  let fetchCalled = false
  const fetchImpl: typeof fetch = () => {
    fetchCalled = true
    return Promise.resolve(new Response("nope", { status: 200 }))
  }
  await assert.rejects(
    () =>
      fetchSingleUrl(new URL("http://10.0.0.1/"), {
        resolver: PUBLIC_RESOLVER,
        fetchImpl,
        timeoutMs: 3000,
      }),
    (err: unknown) => {
      assert.ok(err instanceof UrlPolicyDenyError)
      assert.equal(err.decision.reason, "ip_denied_private")
      return true
    },
  )
  assert.equal(fetchCalled, false)
})

test("P4.2: link-local URL (AWS metadata) is denied before fetch", async () => {
  let fetchCalled = false
  const fetchImpl: typeof fetch = () => {
    fetchCalled = true
    return Promise.resolve(new Response("nope", { status: 200 }))
  }
  await assert.rejects(
    () =>
      fetchSingleUrl(new URL("http://169.254.169.254/latest/meta-data/"), {
        resolver: PUBLIC_RESOLVER,
        fetchImpl,
        timeoutMs: 3000,
      }),
    (err: unknown) => {
      assert.ok(err instanceof UrlPolicyDenyError)
      assert.equal(err.decision.reason, "ip_denied_link_local")
      return true
    },
  )
  assert.equal(fetchCalled, false)
})

test("P4.2: IPv6 loopback is denied before fetch", async () => {
  let fetchCalled = false
  const fetchImpl: typeof fetch = () => {
    fetchCalled = true
    return Promise.resolve(new Response("nope", { status: 200 }))
  }
  await assert.rejects(
    () =>
      fetchSingleUrl(new URL("http://[::1]/"), {
        resolver: PUBLIC_RESOLVER,
        fetchImpl,
        timeoutMs: 3000,
      }),
    (err: unknown) => {
      assert.ok(err instanceof UrlPolicyDenyError)
      assert.equal(err.decision.reason, "ip_denied_loopback")
      return true
    },
  )
  assert.equal(fetchCalled, false)
})

test("P4.2: non-HTTP scheme is denied before fetch", async () => {
  let fetchCalled = false
  const fetchImpl: typeof fetch = () => {
    fetchCalled = true
    return Promise.resolve(new Response("nope", { status: 200 }))
  }
  await assert.rejects(
    () =>
      fetchSingleUrl(new URL("ftp://public.test/file"), {
        resolver: PUBLIC_RESOLVER,
        fetchImpl,
        timeoutMs: 3000,
      }),
    (err: unknown) => {
      assert.ok(err instanceof UrlPolicyDenyError)
      assert.equal(err.decision.reason, "scheme_not_http")
      return true
    },
  )
  assert.equal(fetchCalled, false)
})

test("P4.2: URL with userinfo is denied before fetch", async () => {
  let fetchCalled = false
  const fetchImpl: typeof fetch = () => {
    fetchCalled = true
    return Promise.resolve(new Response("nope", { status: 200 }))
  }
  await assert.rejects(
    () =>
      fetchSingleUrl(new URL("http://user:pass@public.test/"), {
        resolver: PUBLIC_RESOLVER,
        fetchImpl,
        timeoutMs: 3000,
      }),
    (err: unknown) => {
      assert.ok(err instanceof UrlPolicyDenyError)
      assert.equal(err.decision.reason, "url_has_userinfo")
      return true
    },
  )
  assert.equal(fetchCalled, false)
})

test("P4.2: hostname resolving to private IP is denied (DNS rebinding at initial)", async () => {
  let fetchCalled = false
  const fetchImpl: typeof fetch = () => {
    fetchCalled = true
    return Promise.resolve(new Response("nope", { status: 200 }))
  }
  const resolver = createResolver({
    "evil.test": ["93.184.216.34", "10.0.0.1"], // 混合公网+私网 → fail closed
  })
  await assert.rejects(
    () =>
      fetchSingleUrl(new URL("http://evil.test/"), {
        resolver,
        fetchImpl,
        timeoutMs: 3000,
      }),
    (err: unknown) => {
      assert.ok(err instanceof UrlPolicyDenyError)
      assert.equal(err.decision.reason, "host_resolves_to_denied_ip")
      return true
    },
  )
  assert.equal(fetchCalled, false)
})

test("P4.2: redirect to loopback IP is denied", async () => {
  let fetchCount = 0
  const fetchImpl: typeof fetch = () => {
    fetchCount++
    return Promise.resolve(
      new Response(null, {
        status: 301,
        headers: { location: "http://127.0.0.1/secret" },
      }),
    )
  }
  await assert.rejects(
    () =>
      fetchSingleUrl(new URL("http://public.test/"), {
        resolver: PUBLIC_RESOLVER,
        fetchImpl,
        timeoutMs: 3000,
      }),
    (err: unknown) => {
      assert.ok(err instanceof UrlPolicyDenyError)
      assert.equal(err.stage, "redirect")
      assert.equal(err.hop, 1)
      assert.equal(err.decision.reason, "ip_denied_loopback")
      return true
    },
  )
  assert.equal(fetchCount, 1, "initial fetch happens, redirect target denied before fetch")
})

test("P4.2: redirect to hostname resolving to private IP is denied", async () => {
  const resolver = createResolver({
    "public.test": [PUBLIC_IP],
    "internal.test": ["10.0.0.1"],
  })
  let fetchCount = 0
  const fetchImpl: typeof fetch = () => {
    fetchCount++
    if (fetchCount === 1) {
      return Promise.resolve(
        new Response(null, {
          status: 301,
          headers: { location: "http://internal.test/" },
        }),
      )
    }
    return Promise.resolve(new Response("nope", { status: 200 }))
  }
  await assert.rejects(
    () =>
      fetchSingleUrl(new URL("http://public.test/"), {
        resolver,
        fetchImpl,
        timeoutMs: 3000,
      }),
    (err: unknown) => {
      assert.ok(err instanceof UrlPolicyDenyError)
      assert.equal(err.stage, "redirect")
      assert.equal(err.decision.reason, "host_resolves_to_denied_ip")
      return true
    },
  )
  assert.equal(fetchCount, 1, "only initial fetch; redirect target denied before fetch")
})

test("P4.2: redirect to non-HTTP scheme is denied", async () => {
  const fetchImpl = createStaticFetch(
    new Response(null, {
      status: 301,
      headers: { location: "file:///etc/passwd" },
    }),
  )
  await assert.rejects(
    () =>
      fetchSingleUrl(new URL("http://public.test/"), {
        resolver: PUBLIC_RESOLVER,
        fetchImpl,
        timeoutMs: 3000,
      }),
    (err: unknown) => {
      assert.ok(err instanceof UrlPolicyDenyError)
      assert.equal(err.decision.reason, "scheme_not_http")
      assert.equal(err.stage, "redirect")
      return true
    },
  )
})

test("P4.2: same-host redirect re-resolves DNS (DNS rebinding defense)", async () => {
  // 第一次解析返回公网 IP（允许），重定向后第二次解析返回 loopback（拒绝）。
  const resolver = createSequentialResolver([
    [PUBLIC_IP],
    ["127.0.0.1"],
  ])
  const fetchImpl = createStaticFetch(
    new Response(null, {
      status: 301,
      headers: { location: "http://rebind.test/" },
    }),
  )
  await assert.rejects(
    () =>
      fetchSingleUrl(new URL("http://rebind.test/"), {
        resolver,
        fetchImpl,
        timeoutMs: 3000,
      }),
    (err: unknown) => {
      assert.ok(err instanceof UrlPolicyDenyError)
      assert.equal(err.stage, "redirect")
      assert.equal(err.decision.reason, "host_resolves_to_denied_ip")
      return true
    },
  )
})

test("P4.2: redirect chain within maxRedirects is followed", async () => {
  const finalResponse = new Response("final", {
    status: 200,
    headers: { "content-type": "text/plain" },
  })
  const fetchImpl = createRedirectChainFetch(
    [
      "http://public-b.test/",
      "http://public-c.test/",
      "http://public-d.test/",
    ],
    finalResponse,
  )
  const fetched = await fetchSingleUrl(new URL("http://public-a.test/"), {
    resolver: PUBLIC_RESOLVER,
    fetchImpl,
    timeoutMs: 3000,
  })
  assert.equal(fetched.buffer.toString("utf8"), "final")
  assert.equal(fetched.url.toString(), "http://public-d.test/")
})

test("P4.2: redirect chain exceeding maxRedirects is denied", async () => {
  // maxRedirects=3，但链有 5 跳（6 次 fetch：1 初始 + 5 重定向）。
  const fetchImpl = createRedirectChainFetch(
    [
      "http://public-b.test/",
      "http://public-c.test/",
      "http://public-d.test/",
      "http://public-a.test/",
      "http://public-b.test/",
    ],
    new Response("never", { status: 200 }),
  )
  await assert.rejects(
    () =>
      fetchSingleUrl(new URL("http://public-a.test/"), {
        resolver: PUBLIC_RESOLVER,
        fetchImpl,
        timeoutMs: 3000,
        maxRedirects: 3,
      }),
    /redirect chain exceeds max 3/,
  )
})

test("P4.2: redirect with missing Location header throws", async () => {
  const fetchImpl = createStaticFetch(
    new Response(null, { status: 302 }),
  )
  await assert.rejects(
    () =>
      fetchSingleUrl(new URL("http://public.test/"), {
        resolver: PUBLIC_RESOLVER,
        fetchImpl,
        timeoutMs: 3000,
      }),
    /redirect status 302 without Location header/,
  )
})

test("P4.2: non-2xx non-3xx response throws http status", async () => {
  const fetchImpl = createStaticFetch(
    new Response("not found", { status: 404, statusText: "Not Found" }),
  )
  await assert.rejects(
    () =>
      fetchSingleUrl(new URL("http://public.test/missing"), {
        resolver: PUBLIC_RESOLVER,
        fetchImpl,
        timeoutMs: 3000,
      }),
    /http 404/,
  )
})

test("P4.2: timeout fires and aborts fetch", async () => {
  const fetchImpl = createSlowFetch(10_000) // 10s delay
  await assert.rejects(
    () =>
      fetchSingleUrl(new URL("http://public.test/"), {
        resolver: PUBLIC_RESOLVER,
        fetchImpl,
        timeoutMs: 200, // 200ms timeout
      }),
    /fetch failed: timeout after 200ms/,
  )
})

test("P4.2: byte quota enforced via content-length", async () => {
  const fetchImpl = createStaticFetch(
    new Response("x".repeat(100), {
      status: 200,
      headers: { "content-type": "text/plain", "content-length": "100" },
    }),
  )
  await assert.rejects(
    () =>
      fetchSingleUrl(new URL("http://public.test/"), {
        resolver: PUBLIC_RESOLVER,
        fetchImpl,
        timeoutMs: 3000,
        maxBytes: 50,
      }),
    /content-length 100 exceeds max 50/,
  )
})

test("P4.2: byte quota enforced mid-stream on chunked response", async () => {
  // 无 content-length，流式响应总大小 200 字节，每块 50 字节。
  // maxBytes=120 → 第 3 块（150 字节累计）时超限中止。
  const response = createStreamingResponse(200, 50)
  const fetchImpl = createStaticFetch(response)
  await assert.rejects(
    () =>
      fetchSingleUrl(new URL("http://public.test/"), {
        resolver: PUBLIC_RESOLVER,
        fetchImpl,
        timeoutMs: 3000,
        maxBytes: 120,
      }),
    /response size exceeds max 120/,
  )
})

test("P4.2: byte quota allows response under limit", async () => {
  const response = createStreamingResponse(100, 30)
  const fetchImpl = createStaticFetch(response)
  const fetched = await fetchSingleUrl(new URL("http://public.test/"), {
    resolver: PUBLIC_RESOLVER,
    fetchImpl,
    timeoutMs: 3000,
    maxBytes: 200,
  })
  assert.equal(fetched.buffer.length, 100)
})

test("P4.2: UrlPolicyDenyError carries decision for P4.3 lifecycle inspection", async () => {
  const fetchImpl = createStaticFetch(new Response("nope", { status: 200 }))
  try {
    await fetchSingleUrl(new URL("http://10.0.0.1/"), {
      resolver: PUBLIC_RESOLVER,
      fetchImpl,
      timeoutMs: 3000,
    })
    assert.fail("should have thrown")
  } catch (err) {
    assert.ok(err instanceof UrlPolicyDenyError)
    const deny = err.decision
    assert.equal(deny.decision, "deny")
    assert.equal(deny.reason, "ip_denied_private")
    assert.ok(deny.detail.includes("10.0.0.1"))
    assert.equal(err.stage, "initial")
    assert.equal(err.hop, 0)
  }
})

test("P4.2: redirect chain to public targets with maxRedirects=0 denied on first 3xx", async () => {
  const fetchImpl = createStaticFetch(
    new Response(null, {
      status: 301,
      headers: { location: "http://public-b.test/" },
    }),
  )
  await assert.rejects(
    () =>
      fetchSingleUrl(new URL("http://public-a.test/"), {
        resolver: PUBLIC_RESOLVER,
        fetchImpl,
        timeoutMs: 3000,
        maxRedirects: 0,
      }),
    /redirect chain exceeds max 0/,
  )
})

// --- P4.3 body-read 超时保护测试（D-007 debt #1 修复验证） ---

test("P4.3: body-read timeout fires when server sends headers then hangs (slowloris)", async () => {
  // 服务器立即返回 headers + 1 字节 body，然后延迟 10s 才发剩余 body。
  // timeoutMs=200 → abort 信号在 200ms 后触发，reader.read() 抛错，
  // readWithByteQuota 捕获并转为 body_read_timeout。
  const fetchImpl = createSlowBodyFetch(10_000, "hello world this is a long body")
  await assert.rejects(
    () =>
      fetchSingleUrl(new URL("http://public.test/"), {
        resolver: PUBLIC_RESOLVER,
        fetchImpl,
        timeoutMs: 200,
      }),
    /body_read_timeout after 200ms/,
  )
})

test("P4.3: body-read completes normally when response arrives within timeout", async () => {
  // 服务器延迟 50ms 发送 body，timeoutMs=3000 → 应在超时前完成。
  const fetchImpl = createSlowBodyFetch(50, "hi")
  const fetched = await fetchSingleUrl(new URL("http://public.test/"), {
    resolver: PUBLIC_RESOLVER,
    fetchImpl,
    timeoutMs: 3000,
  })
  assert.equal(fetched.buffer.toString("utf8"), "hi")
})

test("P4.3: body-read timeout does not interfere with byte quota enforcement", async () => {
  // 字节超限应先于 body-read timeout 触发（quota 检查在每个 chunk 到达时先执行）。
  // 使用同步流式响应（所有 chunk 立即到达），maxBytes=5 → 第一个 chunk 后即超限。
  const response = createStreamingResponse(200, 50)
  const fetchImpl = createStaticFetch(response)
  await assert.rejects(
    () =>
      fetchSingleUrl(new URL("http://public.test/"), {
        resolver: PUBLIC_RESOLVER,
        fetchImpl,
        timeoutMs: 3000,
        maxBytes: 5,
      }),
    /response size exceeds max 5/,
  )
})
