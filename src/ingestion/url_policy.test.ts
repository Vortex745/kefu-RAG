import assert from "node:assert/strict"
import test from "node:test"
import {
  URL_POLICY_VERSION,
  URL_SCHEME_ALLOWLIST,
  DNS_RESOLUTION_POLICY,
  REDIRECT_POLICY,
  parseIpv4ToUint32,
  parseIpv6,
  extractEmbeddedIpv4,
  classifyIpv4Address,
  classifyIpv6Address,
  classifyIpAddress,
  classifyHost,
  checkUrl,
  UNRESOLVED_HOST,
  type HostResolver,
  type UrlPolicyDecision,
} from "./url_policy"

// --- 测试辅助 ---

const PUBLIC_RESOLVER: HostResolver = async (host) => {
  // 测试用的合成解析器：把已知公网域名映射到公网 IP，其他返回空。
  if (host === "example.com") return { addresses: ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"] }
  if (host === "public.test") return { addresses: ["8.8.8.8"] }
  return { addresses: [] }
}

function assertDeny(d: UrlPolicyDecision, reason?: string): asserts d is Extract<UrlPolicyDecision, { decision: "deny" }> {
  assert.equal(d.decision, "deny")
  if (reason !== undefined) assert.equal(d.reason, reason)
}

function assertAllow(d: UrlPolicyDecision): asserts d is Extract<UrlPolicyDecision, { decision: "allow" }> {
  assert.equal(d.decision, "allow")
  assert.equal(d.reason, "public")
}

// ============================================================
// 1. 模块元数据与契约常量
// ============================================================

test("URL_POLICY_VERSION is defined and dated for P4.1", () => {
  assert.ok(typeof URL_POLICY_VERSION === "string" && URL_POLICY_VERSION.length > 0)
  assert.match(URL_POLICY_VERSION, /P4\.1/)
})

test("URL_SCHEME_ALLOWLIST only contains http: and https:", () => {
  assert.ok(URL_SCHEME_ALLOWLIST.has("http:"))
  assert.ok(URL_SCHEME_ALLOWLIST.has("https:"))
  assert.equal(URL_SCHEME_ALLOWLIST.size, 2)
  assert.ok(!URL_SCHEME_ALLOWLIST.has("ftp:"))
  assert.ok(!URL_SCHEME_ALLOWLIST.has("file:"))
  assert.ok(!URL_SCHEME_ALLOWLIST.has("gopher:"))
})

test("DNS_RESOLUTION_POLICY requires fail-closed on denied IP and empty resolution", () => {
  assert.equal(DNS_RESOLUTION_POLICY.resolveAllAddresses, true)
  assert.equal(DNS_RESOLUTION_POLICY.failClosedOnAnyDeniedIp, true)
  assert.equal(DNS_RESOLUTION_POLICY.denyEmptyResolution, true)
  assert.equal(DNS_RESOLUTION_POLICY.denyResolverThrow, true)
})

test("REDIRECT_POLICY requires revalidation on every hop with bounded maxRedirects", () => {
  assert.equal(REDIRECT_POLICY.revalidateOnRedirect, true)
  assert.equal(REDIRECT_POLICY.requireReResolutionEvenIfSameHost, true)
  assert.equal(REDIRECT_POLICY.denyRedirectToPrivateOrLoopback, true)
  assert.ok(typeof REDIRECT_POLICY.maxRedirects === "number" && REDIRECT_POLICY.maxRedirects > 0 && REDIRECT_POLICY.maxRedirects <= 10)
})

// ============================================================
// 2. IPv4 拒绝清单——loopback
// ============================================================

test("classifyIpv4Address denies 127.0.0.0/8 loopback range", () => {
  for (const ip of ["127.0.0.1", "127.0.0.0", "127.255.255.254", "127.1.2.3", "127.127.127.127"]) {
    const d = classifyIpv4Address(ip)
    assertDeny(d, "ip_denied_loopback")
    assert.match(d.detail, /127\.0\.0\.0\/8/)
  }
})

// ============================================================
// 3. IPv4 拒绝清单——private (RFC 1918)
// ============================================================

test("classifyIpv4Address denies 10.0.0.0/8 private range", () => {
  for (const ip of ["10.0.0.1", "10.1.2.3", "10.255.255.255", "10.0.0.0"]) {
    const d = classifyIpv4Address(ip)
    assertDeny(d, "ip_denied_private")
    assert.match(d.detail, /10\.0\.0\.0\/8/)
  }
})

test("classifyIpv4Address denies 172.16.0.0/12 private range (boundary inclusive)", () => {
  // 边界：172.16.0.0 与 172.31.255.255 都属于 172.16/12
  for (const ip of ["172.16.0.0", "172.16.0.1", "172.20.30.40", "172.31.255.254", "172.31.255.255"]) {
    const d = classifyIpv4Address(ip)
    assertDeny(d, "ip_denied_private")
    assert.match(d.detail, /172\.16\.0\.0\/12/)
  }
})

test("classifyIpv4Address allows 172.32.0.1 (just outside 172.16/12 — public)", () => {
  // 172.32.0.0/11 是公网；确认边界正确，不误拒
  const d = classifyIpv4Address("172.32.0.1")
  assertAllow(d)
})

test("classifyIpv4Address denies 192.168.0.0/16 private range", () => {
  for (const ip of ["192.168.0.0", "192.168.1.1", "192.168.0.1", "192.168.255.255"]) {
    const d = classifyIpv4Address(ip)
    assertDeny(d, "ip_denied_private")
    assert.match(d.detail, /192\.168\.0\.0\/16/)
  }
})

// ============================================================
// 4. IPv4 拒绝清单——link-local（含 AWS metadata IP）
// ============================================================

test("classifyIpv4Address denies 169.254.0.0/16 link-local range (including AWS metadata 169.254.169.254)", () => {
  for (const ip of ["169.254.0.1", "169.254.169.254", "169.254.255.255"]) {
    const d = classifyIpv4Address(ip)
    assertDeny(d, "ip_denied_link_local")
    assert.match(d.detail, /169\.254\.0\.0\/16/)
  }
  // 显式验证 AWS metadata IP（经典 SSRF 目标）被拒绝
  const aws = classifyIpv4Address("169.254.169.254")
  assertDeny(aws, "ip_denied_link_local")
})

// ============================================================
// 5. IPv4 拒绝清单——multicast、unspecified、reserved
// ============================================================

test("classifyIpv4Address denies 224.0.0.0/4 multicast range", () => {
  for (const ip of ["224.0.0.1", "224.0.0.251", "239.255.255.255"]) {
    const d = classifyIpv4Address(ip)
    assertDeny(d, "ip_denied_multicast")
    assert.match(d.detail, /224\.0\.0\.0\/4/)
  }
})

test("classifyIpv4Address denies 0.0.0.0/8 unspecified range (including 0.0.0.0)", () => {
  for (const ip of ["0.0.0.0", "0.0.0.1", "0.1.2.3", "0.255.255.255"]) {
    const d = classifyIpv4Address(ip)
    assertDeny(d, "ip_denied_unspecified")
    assert.match(d.detail, /0\.0\.0\.0\/8/)
  }
})

test("classifyIpv4Address denies 240.0.0.0/4 reserved range (including 255.255.255.255)", () => {
  for (const ip of ["240.0.0.1", "255.255.255.255", "255.0.0.1"]) {
    const d = classifyIpv4Address(ip)
    assertDeny(d, "ip_denied_reserved")
    assert.match(d.detail, /240\.0\.0\.0\/4/)
  }
})

test("classifyIpv4Address denies 192.0.0.0/24 IETF protocol assignments", () => {
  for (const ip of ["192.0.0.1", "192.0.0.255"]) {
    const d = classifyIpv4Address(ip)
    assertDeny(d, "ip_denied_reserved")
    assert.match(d.detail, /192\.0\.0\.0\/24/)
  }
})

test("classifyIpv4Address denies 100.64.0.0/10 CGNAT shared transition range", () => {
  for (const ip of ["100.64.0.1", "100.64.0.0", "100.127.255.255"]) {
    const d = classifyIpv4Address(ip)
    assertDeny(d, "ip_denied_reserved")
    assert.match(d.detail, /100\.64\.0\.0\/10/)
  }
})

test("classifyIpv4Address denies RFC 5737 documentation ranges (TEST-NET-1/2/3)", () => {
  for (const [ip, cidr] of [
    ["192.0.2.1", "192.0.2.0/24"],
    ["198.51.100.1", "198.51.100.0/24"],
    ["203.0.113.1", "203.0.113.0/24"],
  ] as const) {
    const d = classifyIpv4Address(ip)
    assertDeny(d, "ip_denied_documentation")
    assert.match(d.detail, new RegExp(cidr.replace(/\./g, "\\.")))
  }
})

test("classifyIpv4Address denies 198.18.0.0/15 benchmarking range", () => {
  for (const ip of ["198.18.0.1", "198.18.0.0", "198.19.255.255"]) {
    const d = classifyIpv4Address(ip)
    assertDeny(d, "ip_denied_benchmarking")
    assert.match(d.detail, /198\.18\.0\.0\/15/)
  }
})

// ============================================================
// 6. IPv4 允许——公网
// ============================================================

test("classifyIpv4Address allows public IPv4 addresses", () => {
  for (const ip of ["8.8.8.8", "8.8.4.4", "1.1.1.1", "1.0.0.1", "172.32.0.1", "172.215.0.1", "11.0.0.1"]) {
    const d = classifyIpv4Address(ip)
    assertAllow(d)
  }
})

// ============================================================
// 7. IPv6 拒绝清单
// ============================================================

test("classifyIpv6Address denies ::1/128 loopback", () => {
  const d = classifyIpv6Address("::1")
  assertDeny(d, "ip_denied_loopback")
  assert.match(d.detail, /::1\/128/)
})

test("classifyIpv6Address denies ::/128 unspecified", () => {
  const d = classifyIpv6Address("::")
  assertDeny(d, "ip_denied_unspecified")
  assert.match(d.detail, /::\/128/)
})

test("classifyIpv6Address denies fc00::/7 ULA private (covers fc00 and fd00)", () => {
  for (const ip of ["fc00::1", "fc00::", "fd00::1", "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"]) {
    const d = classifyIpv6Address(ip)
    assertDeny(d, "ip_denied_private")
    assert.match(d.detail, /fc00::\/7/)
  }
})

test("classifyIpv6Address denies fe80::/10 link-local (covers fe80, fe90, fea0, feb0)", () => {
  for (const ip of ["fe80::1", "fe80::", "fe90::1", "fea0::1", "feb0::1", "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff"]) {
    const d = classifyIpv6Address(ip)
    assertDeny(d, "ip_denied_link_local")
    assert.match(d.detail, /fe80::\/10/)
  }
})

test("classifyIpv6Address does NOT deny fe00:: (just outside fe80::/10)", () => {
  // fe00::/10 是 fe00-fe7f，不在 fe80::/10 内；保留为公网
  const d = classifyIpv6Address("fe00::1")
  assertAllow(d)
})

test("classifyIpv6Address denies ff00::/8 multicast", () => {
  for (const ip of ["ff00::1", "ff02::1", "ff02::fb", "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"]) {
    const d = classifyIpv6Address(ip)
    assertDeny(d, "ip_denied_multicast")
    assert.match(d.detail, /ff00::\/8/)
  }
})

test("classifyIpv6Address denies 2001:db8::/32 documentation", () => {
  for (const ip of ["2001:db8::1", "2001:db8::", "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff"]) {
    const d = classifyIpv6Address(ip)
    assertDeny(d, "ip_denied_documentation")
    assert.match(d.detail, /2001:db8::\/32/)
  }
})

test("classifyIpv6Address denies 100::/64 discard prefix", () => {
  for (const ip of ["100::", "100::1", "100::ffff:ffff:ffff:ffff"]) {
    const d = classifyIpv6Address(ip)
    assertDeny(d, "ip_denied_reserved")
    assert.match(d.detail, /100::\/64/)
  }
})

// ============================================================
// 8. IPv6 允许——公网
// ============================================================

test("classifyIpv6Address allows public IPv6 addresses", () => {
  for (const ip of [
    "2606:4700:4700::1111", // Cloudflare DNS
    "2001:4860:4860::8888", // Google DNS
    "fe00::1", // 不在 fe80::/10
    "2001:db9::1", // 不在 2001:db8::/32
  ]) {
    const d = classifyIpv6Address(ip)
    assertAllow(d)
  }
})

// ============================================================
// 9. IPv4-mapped IPv6 与 IPv4-compatible
// ============================================================

test("classifyIpv6Address denies ::ffff:127.0.0.1 (IPv4-mapped loopback)", () => {
  const d = classifyIpv6Address("::ffff:127.0.0.1")
  assertDeny(d, "ip_denied_loopback")
  assert.match(d.detail, /embeds 127\.0\.0\.1/)
})

test("classifyIpv6Address denies ::ffff:169.254.169.254 (IPv4-mapped AWS metadata)", () => {
  const d = classifyIpv6Address("::ffff:169.254.169.254")
  assertDeny(d, "ip_denied_link_local")
  assert.match(d.detail, /embeds 169\.254\.169\.254/)
})

test("classifyIpv6Address denies ::ffff:192.168.1.1 (IPv4-mapped private)", () => {
  const d = classifyIpv6Address("::ffff:192.168.1.1")
  assertDeny(d, "ip_denied_private")
})

test("classifyIpv6Address allows ::ffff:8.8.8.8 (IPv4-mapped public)", () => {
  const d = classifyIpv6Address("::ffff:8.8.8.8")
  assertAllow(d)
})

test("classifyIpv6Address denies ::127.0.0.1 (IPv4-compatible loopback, deprecated form)", () => {
  const d = classifyIpv6Address("::127.0.0.1")
  assertDeny(d, "ip_denied_loopback")
  assert.match(d.detail, /embeds 127\.0\.0\.1/)
})

test("classifyIpv6Address allows ::8.8.8.8 (IPv4-compatible public, deprecated form)", () => {
  const d = classifyIpv6Address("::8.8.8.8")
  assertAllow(d)
})

test("extractEmbeddedIpv4 returns null for ::1 and :: (already covered by IPv6 deny list)", () => {
  const loopback = parseIpv6("::1")!
  assert.ok(loopback)
  assert.equal(extractEmbeddedIpv4(loopback), null)
  const unspec = parseIpv6("::")!
  assert.ok(unspec)
  assert.equal(extractEmbeddedIpv4(unspec), null)
})

// ============================================================
// 10. parseIpv4ToUint32 / parseIpv6 单元
// ============================================================

test("parseIpv4ToUint32 returns null for non-decimal or malformed IPv4 forms", () => {
  // 防御性：八进制、十六进制、单整数形式应被拒绝（fail closed）
  assert.equal(parseIpv4ToUint32("0177.0.0.1"), null) // 八进制八位组
  assert.equal(parseIpv4ToUint32("0x7f.0.0.1"), null) // 十六进制八位组
  assert.equal(parseIpv4ToUint32("2130706433"), null) // 单整数（非 dotted-quad）
  assert.equal(parseIpv4ToUint32("0x7f000001"), null) // 单十六进制
  assert.equal(parseIpv4ToUint32("127.0.0.1.5"), null) // 五段
  assert.equal(parseIpv4ToUint32("127.0.0"), null) // 三段
  assert.equal(parseIpv4ToUint32("127.0.0.256"), null) // 越界
  assert.equal(parseIpv4ToUint32(""), null)
})

test("parseIpv4ToUint32 parses valid dotted-quad correctly", () => {
  assert.equal(parseIpv4ToUint32("0.0.0.0"), 0)
  assert.equal(parseIpv4ToUint32("127.0.0.1"), 0x7f000001 >>> 0)
  assert.equal(parseIpv4ToUint32("255.255.255.255"), 0xffffffff >>> 0)
  assert.equal(parseIpv4ToUint32("8.8.8.8"), 0x08080808 >>> 0)
})

test("parseIpv6 accepts bracket and bare forms, returns null for invalid", () => {
  assert.ok(parseIpv6("::1"))
  assert.ok(parseIpv6("[::1]"))
  assert.ok(parseIpv6("::ffff:127.0.0.1"))
  assert.ok(parseIpv6("[::ffff:127.0.0.1]"))
  assert.ok(parseIpv6("2001:db8::1"))
  assert.ok(parseIpv6("fe80::1"))
  assert.equal(parseIpv6("not-an-ip"), null)
  assert.equal(parseIpv6(":::1"), null)
  assert.equal(parseIpv6("::1::2"), null) // 双 :: 非法
})

// ============================================================
// 11. classifyIpAddress 派发
// ============================================================

test("classifyIpAddress strips brackets and dispatches to v4/v6", () => {
  assertDeny(classifyIpAddress("127.0.0.1"), "ip_denied_loopback")
  assertDeny(classifyIpAddress("[::1]"), "ip_denied_loopback")
  assertDeny(classifyIpAddress("::1"), "ip_denied_loopback")
  assertDeny(classifyIpAddress("[::ffff:127.0.0.1]"), "ip_denied_loopback")
  assertAllow(classifyIpAddress("8.8.8.8"))
  assertAllow(classifyIpAddress("[2606:4700:4700::1111]"))
})

test("classifyIpAddress denies non-IP literals (fail closed)", () => {
  const d = classifyIpAddress("example.com")
  assertDeny(d, "ip_denied_reserved")
})

// ============================================================
// 12. classifyHost——IP 字面量快速路径
// ============================================================

test("classifyHost classifies IPv4 literal without calling resolver", async () => {
  let resolverCalled = false
  const resolver: HostResolver = async () => {
    resolverCalled = true
    return { addresses: [] }
  }
  const d = await classifyHost("127.0.0.1", resolver)
  assertDeny(d, "ip_denied_loopback")
  assert.equal(resolverCalled, false)
})

test("classifyHost classifies bracketed IPv6 literal without calling resolver", async () => {
  let resolverCalled = false
  const resolver: HostResolver = async () => {
    resolverCalled = true
    return { addresses: [] }
  }
  const d = await classifyHost("[::1]", resolver)
  assertDeny(d, "ip_denied_loopback")
  assert.equal(resolverCalled, false)
})

// ============================================================
// 13. classifyHost——域名解析与 DNS rebinding 防御
// ============================================================

test("classifyHost allows domain that resolves to public IPs", async () => {
  const d = await classifyHost("example.com", PUBLIC_RESOLVER)
  assertAllow(d)
})

test("classifyHost denies domain that resolves to empty (host_unresolvable)", async () => {
  const d = await classifyHost("nonexistent.test", PUBLIC_RESOLVER)
  assertDeny(d, "host_unresolvable")
})

test("classifyHost denies domain that resolves to a single denied IP", async () => {
  const resolver: HostResolver = async () => ({ addresses: ["127.0.0.1"] })
  const d = await classifyHost("rebinding.test", resolver)
  assertDeny(d, "host_resolves_to_denied_ip")
  assert.match(d.detail, /127\.0\.0\.1/)
})

test("classifyHost denies domain that resolves to a mix of public and denied IPs (DNS rebinding defense)", async () => {
  // 关键 DNS rebinding 场景：攻击者让 DNS 同时返回公网与内网地址
  // fail-closed：只要任一地址被拒，整个 host 拒绝
  const resolver: HostResolver = async () => ({ addresses: ["8.8.8.8", "127.0.0.1"] })
  const d = await classifyHost("rebinding-mix.test", resolver)
  assertDeny(d, "host_resolves_to_denied_ip")
  assert.match(d.detail, /127\.0\.0\.1/)
})

test("classifyHost denies domain that resolves to AWS metadata IP", async () => {
  const resolver: HostResolver = async () => ({ addresses: ["169.254.169.254"] })
  const d = await classifyHost("metadata-attack.test", resolver)
  assertDeny(d, "host_resolves_to_denied_ip")
})

test("classifyHost denies domain when resolver throws", async () => {
  const resolver: HostResolver = async () => {
    throw new Error("ENOTFOUND")
  }
  const d = await classifyHost("throws.test", resolver)
  assertDeny(d, "host_unresolvable")
  assert.match(d.detail, /ENOTFOUND/)
})

test("classifyHost allows domain resolving to multiple public addresses (mixed v4+v6)", async () => {
  const resolver: HostResolver = async () => ({
    addresses: ["8.8.8.8", "2606:4700:4700::1111"],
  })
  const d = await classifyHost("dualstack.test", resolver)
  assertAllow(d)
})

// ============================================================
// 14. checkUrl——scheme、userinfo、host 顶层校验
// ============================================================

test("checkUrl denies ftp: scheme", async () => {
  const d = await checkUrl(new URL("ftp://example.com/"), PUBLIC_RESOLVER)
  assertDeny(d, "scheme_not_http")
})

test("checkUrl denies file: scheme", async () => {
  const d = await checkUrl(new URL("file:///etc/passwd"), PUBLIC_RESOLVER)
  assertDeny(d, "scheme_not_http")
})

test("checkUrl denies gopher: scheme", async () => {
  const d = await checkUrl(new URL("gopher://example.com/"), PUBLIC_RESOLVER)
  assertDeny(d, "scheme_not_http")
})

test("checkUrl denies URL with userinfo", async () => {
  const d = await checkUrl(new URL("http://user:pass@example.com/"), PUBLIC_RESOLVER)
  assertDeny(d, "url_has_userinfo")
})

test("checkUrl denies URL with username only (no password)", async () => {
  const d = await checkUrl(new URL("http://user@example.com/"), PUBLIC_RESOLVER)
  assertDeny(d, "url_has_userinfo")
})

test("checkUrl allows http: and https: schemes for public host", async () => {
  const dHttp = await checkUrl(new URL("http://example.com/"), PUBLIC_RESOLVER)
  assertAllow(dHttp)
  const dHttps = await checkUrl(new URL("https://example.com/"), PUBLIC_RESOLVER)
  assertAllow(dHttps)
})

test("checkUrl denies http://127.0.0.1/ without calling resolver (IP literal fast-path)", async () => {
  let resolverCalled = false
  const resolver: HostResolver = async () => {
    resolverCalled = true
    return { addresses: [] }
  }
  const d = await checkUrl(new URL("http://127.0.0.1/"), resolver)
  assertDeny(d, "ip_denied_loopback")
  assert.equal(resolverCalled, false)
})

test("checkUrl denies http://[::1]/ without calling resolver", async () => {
  let resolverCalled = false
  const resolver: HostResolver = async () => {
    resolverCalled = true
    return { addresses: [] }
  }
  const d = await checkUrl(new URL("http://[::1]/"), resolver)
  assertDeny(d, "ip_denied_loopback")
  assert.equal(resolverCalled, false)
})

test("checkUrl denies http://[::ffff:127.0.0.1]/ (IPv4-mapped via URL hostname)", async () => {
  const d = await checkUrl(new URL("http://[::ffff:127.0.0.1]/"), UNRESOLVED_HOST)
  assertDeny(d, "ip_denied_loopback")
})

test("checkUrl denies http://0.0.0.0/ (unspecified)", async () => {
  const d = await checkUrl(new URL("http://0.0.0.0/"), UNRESOLVED_HOST)
  assertDeny(d, "ip_denied_unspecified")
})

test("checkUrl denies http://[::]/ (unspecified IPv6)", async () => {
  const d = await checkUrl(new URL("http://[::]/"), UNRESOLVED_HOST)
  assertDeny(d, "ip_denied_unspecified")
})

test("checkUrl allows http://8.8.8.8/ (public IP literal, no resolver call)", async () => {
  let resolverCalled = false
  const resolver: HostResolver = async () => {
    resolverCalled = true
    return { addresses: [] }
  }
  const d = await checkUrl(new URL("http://8.8.8.8/"), resolver)
  assertAllow(d)
  assert.equal(resolverCalled, false)
})

// ============================================================
// 15. WHATWG URL parser 规避形式——策略必须 fail closed
// ============================================================

test("WHATWG URL parser normalizes decimal single-int IPv4 (2130706433 → 127.0.0.1)", () => {
  // 文档化 WHATWG 行为：单整数十进制 → 规范化为 dotted-quad
  const u = new URL("http://2130706433/")
  assert.equal(u.hostname, "127.0.0.1")
})

test("WHATWG URL parser normalizes hex single-int IPv4 (0x7f000001 → 127.0.0.1)", () => {
  const u = new URL("http://0x7f000001/")
  assert.equal(u.hostname, "127.0.0.1")
})

test("URL policy denies decimal-form loopback via WHATWG normalization (2130706433)", async () => {
  // WHATWG 已规范化为 127.0.0.1，策略直接拒绝，无需 resolver
  const url = new URL("http://2130706433/")
  const d = await checkUrl(url, UNRESOLVED_HOST)
  assertDeny(d, "ip_denied_loopback")
})

test("URL policy denies hex-form loopback via WHATWG normalization (0x7f000001)", async () => {
  const url = new URL("http://0x7f000001/")
  const d = await checkUrl(url, UNRESOLVED_HOST)
  assertDeny(d, "ip_denied_loopback")
})

test("URL policy denies octal-form loopback (0177.0.0.1) regardless of WHATWG behavior", async () => {
  // WHATWG 对带前导零的 dotted 形式处理依 Node 版本而定：
  //   - 若规范化为 127.0.0.1，直接拒绝（IP 字面量路径）
  //   - 若保留为域名 "0177.0.0.1"，resolver 返回 127.0.0.1，仍拒绝
  // 两种情况都必须 fail closed。
  const url = new URL("http://0177.0.0.1/")
  const resolver: HostResolver = async (host) => {
    if (host === "0177.0.0.1") return { addresses: ["127.0.0.1"] }
    return { addresses: [] }
  }
  const d = await checkUrl(url, resolver)
  assertDeny(d)
})

test("URL policy denies hex-dotted-form loopback (0x7f.0.0.1) regardless of WHATWG behavior", async () => {
  const url = new URL("http://0x7f.0.0.1/")
  const resolver: HostResolver = async (host) => {
    if (host === "0x7f.0.0.1") return { addresses: ["127.0.0.1"] }
    return { addresses: [] }
  }
  const d = await checkUrl(url, resolver)
  assertDeny(d)
})

// ============================================================
// 16. 重定向场景模拟（P4.1 契约验证，P4.2 强制）
// ============================================================

test("Redirect contract: redirect from public host to loopback IP must be denied by revalidation", async () => {
  // 模拟 P4.2 的重定向重新校验流程：
  //   1. 初始 URL http://public.test/ → 允许
  //   2. 服务器返回 302 → http://127.0.0.1/
  //   3. P4.2 必须对 http://127.0.0.1/ 重新调用 checkUrl → 拒绝
  const initial = await checkUrl(new URL("http://public.test/"), PUBLIC_RESOLVER)
  assertAllow(initial)

  const redirectTarget = new URL("http://127.0.0.1/")
  const revalidated = await checkUrl(redirectTarget, PUBLIC_RESOLVER)
  assertDeny(revalidated, "ip_denied_loopback")
})

test("Redirect contract: same-host redirect must still re-resolve (DNS rebinding defense)", async () => {
  // 模拟 DNS rebinding：
  //   1. 首次解析 rebinding.test → [8.8.8.8]（公网，允许）
  //   2. 服务器返回 302 → http://rebinding.test/admin
  //   3. 二次解析 rebinding.test → [127.0.0.1]（内网，必须拒绝）
  let callCount = 0
  const resolver: HostResolver = async () => {
    callCount += 1
    if (callCount === 1) return { addresses: ["8.8.8.8"] }
    return { addresses: ["127.0.0.1"] }
  }

  const initial = await checkUrl(new URL("http://rebinding.test/"), resolver)
  assertAllow(initial)

  const afterRedirect = await checkUrl(new URL("http://rebinding.test/admin"), resolver)
  assertDeny(afterRedirect, "host_resolves_to_denied_ip")
  assert.equal(callCount, 2, "resolver must be called again on redirect (no caching)")
})

test("Redirect contract: maxRedirects is bounded (no infinite redirect chain)", () => {
  assert.ok(REDIRECT_POLICY.maxRedirects <= 10, "maxRedirects must be bounded to prevent redirect loops")
  assert.ok(REDIRECT_POLICY.maxRedirects >= 1, "maxRedirects must allow at least one redirect")
})

// ============================================================
// 17. 蓝军自检——覆盖所有 PUA 列出的规避形式
// ============================================================

test("蓝军自检: 0.0.0.0 denied as unspecified", () => {
  assertDeny(classifyIpAddress("0.0.0.0"), "ip_denied_unspecified")
})

test("蓝军自检: [::] denied as unspecified", () => {
  assertDeny(classifyIpAddress("[::]"), "ip_denied_unspecified")
})

test("蓝军自检: 0177.0.0.1 (octal) denied via WHATWG normalization or fail-closed resolver", async () => {
  const url = new URL("http://0177.0.0.1/")
  const resolver: HostResolver = async (host) => {
    if (host === "0177.0.0.1") return { addresses: ["127.0.0.1"] }
    return { addresses: [] }
  }
  const d = await checkUrl(url, resolver)
  assertDeny(d)
})

test("蓝军自检: 2130706433 (decimal single-int) denied via WHATWG normalization", async () => {
  const d = await checkUrl(new URL("http://2130706433/"), UNRESOLVED_HOST)
  assertDeny(d, "ip_denied_loopback")
})

test("蓝军自检: AWS metadata IP 169.254.169.254 denied (link-local)", () => {
  assertDeny(classifyIpAddress("169.254.169.254"), "ip_denied_link_local")
})

test("蓝军自检: IPv4-mapped IPv6 ::ffff:127.0.0.1 denied (loopback via embedded extraction)", () => {
  assertDeny(classifyIpAddress("::ffff:127.0.0.1"), "ip_denied_loopback")
})

test("蓝军自检: DNS rebinding — domain returning [public, private] is fail-closed denied", async () => {
  const resolver: HostResolver = async () => ({ addresses: ["8.8.8.8", "10.0.0.1"] })
  const d = await classifyHost("rebinding-mixed.test", resolver)
  assertDeny(d, "host_resolves_to_denied_ip")
})

test("蓝军自检: all IPv4 deny ranges covered — loopback/private/link-local/multicast/unspecified/reserved", () => {
  // 显式覆盖 P4.1 gate: "deny loopback/private/link-local + allow public"
  assertDeny(classifyIpv4Address("127.0.0.1"), "ip_denied_loopback")
  assertDeny(classifyIpv4Address("10.0.0.1"), "ip_denied_private")
  assertDeny(classifyIpv4Address("172.16.0.1"), "ip_denied_private")
  assertDeny(classifyIpv4Address("192.168.1.1"), "ip_denied_private")
  assertDeny(classifyIpv4Address("169.254.1.1"), "ip_denied_link_local")
  assertDeny(classifyIpv4Address("224.0.0.1"), "ip_denied_multicast")
  assertDeny(classifyIpv4Address("0.0.0.0"), "ip_denied_unspecified")
  assertDeny(classifyIpv4Address("240.0.0.1"), "ip_denied_reserved")
})

test("蓝军自检: all IPv6 deny ranges covered — loopback/private/link-local/multicast/unspecified", () => {
  assertDeny(classifyIpv6Address("::1"), "ip_denied_loopback")
  assertDeny(classifyIpv6Address("fc00::1"), "ip_denied_private")
  assertDeny(classifyIpv6Address("fe80::1"), "ip_denied_link_local")
  assertDeny(classifyIpv6Address("ff00::1"), "ip_denied_multicast")
  assertDeny(classifyIpv6Address("::"), "ip_denied_unspecified")
})

test("蓝军自检: public IPs allowed (IPv4 + IPv6)", () => {
  assertAllow(classifyIpv4Address("8.8.8.8"))
  assertAllow(classifyIpv6Address("2606:4700:4700::1111"))
})

// ============================================================
// 18. 策略模块独立可测——不需要真实 DNS
// ============================================================

test("UNRESOLVED_HOST placeholder returns empty addresses (fail closed for domains)", async () => {
  const resolution = await UNRESOLVED_HOST("any.host")
  assert.deepEqual(resolution.addresses, [])
})
