/**
 * URL 安全策略（P4.1）——定义 URL ingestion 的允许/拒绝契约。
 *
 * 本模块只定义策略与契约，不执行任何网络 I/O 或抓取强制。
 * 抓取强制（fetch enforcement）属于 P4.2 范围；P4.2 会在每次 fetch、
 * 每次重定向、每个解析地址处调用本模块的契约函数。
 *
 * 防御模型：
 * 1. URL scheme 必须在 HTTP(S) allowlist 内。
 * 2. URL 不得携带 userinfo（RFC 3986 §3.2.1）——防御 `http://user:pass@internal/`。
 * 3. URL 必须有 host。
 * 4. 如果 host 是 IP 字面量，直接分类。
 * 5. 如果 host 是域名，解析为所有地址，逐个分类。
 *    DNS rebinding 防御：只要任一解析地址被拒绝，整个请求 fail closed。
 * 6. 每个重定向目标在跟随之前必须用同一策略重新解析、重新检查。
 *    同 host 重定向不豁免（DNS rebinding 防御）。
 *
 * 拒绝清单（P4.1 权威）：
 * - IPv4 loopback 127.0.0.0/8
 * - IPv4 private 10.0.0.0/8、172.16.0.0/12、192.168.0.0/16（RFC 1918）
 * - IPv4 link-local 169.254.0.0/16（RFC 3927，含 AWS metadata 169.254.169.254）
 * - IPv4 multicast 224.0.0.0/4（RFC 5771）
 * - IPv4 unspecified 0.0.0.0/8（RFC 5735）
 * - IPv4 reserved 240.0.0.0/4、192.0.0.0/24、100.64.0.0/10（CGNAT）
 * - IPv4 documentation 192.0.2.0/24、198.51.100.0/24、203.0.113.0/24（RFC 5737）
 * - IPv4 benchmarking 198.18.0.0/15（RFC 2544）
 * - IPv6 loopback ::1/128
 * - IPv6 unspecified ::/128
 * - IPv6 unique-local fc00::/7（RFC 4193）
 * - IPv6 link-local fe80::/10
 * - IPv6 multicast ff00::/8
 * - IPv6 documentation 2001:db8::/32（RFC 3849）
 * - IPv6 discard 100::/64（RFC 6666）
 * - IPv4-mapped IPv6（::ffff:a.b.c.d/96）与 IPv4-compatible（::a.b.c.d/96，已废弃）：
 *   抽取内嵌 IPv4，按 IPv4 拒绝清单分类。
 *
 * WHATWG URL parser 已规范化的规避形式：
 * - 八进制 `http://0177.0.0.1/` → hostname 规范化为 `127.0.0.1`（或保留为域名，由 Node 版本决定）
 * - 十进制 `http://2130706433/` → hostname 规范化为 `127.0.0.1`
 * - 十六进制 `http://0x7f000001/` → hostname 规范化为 `127.0.0.1`
 * - IPv6 bracket `[::1]` → hostname 为 `[::1]`（策略在分类前剥除括号）
 *
 * 本模块不引入任何外部依赖，仅使用 node:net 的格式校验。
 */

import { isIPv4, isIPv6 } from "node:net"

export const URL_POLICY_VERSION = "P4.1-2026-07-22"

export type DenyReason =
  | "scheme_not_http"
  | "url_has_userinfo"
  | "url_missing_host"
  | "host_unresolvable"
  | "host_resolves_to_denied_ip"
  | "ip_denied_loopback"
  | "ip_denied_private"
  | "ip_denied_link_local"
  | "ip_denied_multicast"
  | "ip_denied_unspecified"
  | "ip_denied_reserved"
  | "ip_denied_documentation"
  | "ip_denied_benchmarking"

export interface UrlPolicyAllow {
  decision: "allow"
  reason: "public"
  detail: string
}

export interface UrlPolicyDeny {
  decision: "deny"
  reason: DenyReason
  detail: string
}

export type UrlPolicyDecision = UrlPolicyAllow | UrlPolicyDeny

export interface HostResolution {
  /** 解析返回的所有 IP 地址字符串（IPv4 或 IPv6 形式）。 */
  addresses: string[]
}

/**
 * Host resolver：将域名解析为 IP 地址列表。
 * P4.1 仅定义契约；P4.2 注入真实 `dns.lookup` 实现。
 * 测试可注入合成解析器以模拟 DNS rebinding 等场景。
 */
export type HostResolver = (hostname: string) => Promise<HostResolution>

interface DenyRange {
  cidr: string
  reason: DenyReason
  description: string
}

const IPV4_DENY_RANGES: ReadonlyArray<DenyRange> = [
  { cidr: "0.0.0.0/8", reason: "ip_denied_unspecified", description: "unspecified (RFC 5735)" },
  { cidr: "10.0.0.0/8", reason: "ip_denied_private", description: "private (RFC 1918)" },
  { cidr: "100.64.0.0/10", reason: "ip_denied_reserved", description: "shared transition / CGNAT (RFC 6598)" },
  { cidr: "127.0.0.0/8", reason: "ip_denied_loopback", description: "loopback" },
  { cidr: "169.254.0.0/16", reason: "ip_denied_link_local", description: "link-local (RFC 3927, includes AWS metadata)" },
  { cidr: "172.16.0.0/12", reason: "ip_denied_private", description: "private (RFC 1918)" },
  { cidr: "192.0.0.0/24", reason: "ip_denied_reserved", description: "IETF protocol assignments (RFC 6890)" },
  { cidr: "192.0.2.0/24", reason: "ip_denied_documentation", description: "TEST-NET-1 (RFC 5737)" },
  { cidr: "192.168.0.0/16", reason: "ip_denied_private", description: "private (RFC 1918)" },
  { cidr: "198.18.0.0/15", reason: "ip_denied_benchmarking", description: "benchmarking (RFC 2544)" },
  { cidr: "198.51.100.0/24", reason: "ip_denied_documentation", description: "TEST-NET-2 (RFC 5737)" },
  { cidr: "203.0.113.0/24", reason: "ip_denied_documentation", description: "TEST-NET-3 (RFC 5737)" },
  { cidr: "224.0.0.0/4", reason: "ip_denied_multicast", description: "multicast (RFC 5771)" },
  { cidr: "240.0.0.0/4", reason: "ip_denied_reserved", description: "reserved (RFC 5735)" },
]

const IPV6_DENY_RANGES: ReadonlyArray<DenyRange> = [
  { cidr: "::/128", reason: "ip_denied_unspecified", description: "unspecified" },
  { cidr: "::1/128", reason: "ip_denied_loopback", description: "loopback" },
  { cidr: "fc00::/7", reason: "ip_denied_private", description: "ULA private (RFC 4193)" },
  { cidr: "fe80::/10", reason: "ip_denied_link_local", description: "link-local" },
  { cidr: "ff00::/8", reason: "ip_denied_multicast", description: "multicast" },
  { cidr: "2001:db8::/32", reason: "ip_denied_documentation", description: "documentation (RFC 3849)" },
  { cidr: "100::/64", reason: "ip_denied_reserved", description: "discard prefix (RFC 6666)" },
]

export const URL_SCHEME_ALLOWLIST: ReadonlySet<string> = new Set(["http:", "https:"])

/**
 * DNS 解析契约——P4.1 定义，P4.2 强制。
 *
 * - 解析必须返回所有 A/AAAA 地址（不能只取第一个）。
 * - 任一地址被拒绝 → 整个请求 fail closed（DNS rebinding 防御）。
 * - 解析返回空 → 拒绝（host_unresolvable）。
 * - 解析抛错 → 拒绝（host_unresolvable）。
 */
export interface DnsResolutionContract {
  readonly resolveAllAddresses: true
  readonly failClosedOnAnyDeniedIp: true
  readonly denyEmptyResolution: true
  readonly denyResolverThrow: true
}

export const DNS_RESOLUTION_POLICY: DnsResolutionContract = {
  resolveAllAddresses: true,
  failClosedOnAnyDeniedIp: true,
  denyEmptyResolution: true,
  denyResolverThrow: true,
}

/**
 * 重定向重新校验契约——P4.1 定义，P4.2 强制。
 *
 * 每个重定向响应（3xx）必须视为全新请求：
 * - 重新解析目标 URL（scheme/userinfo/host 校验）。
 * - 重新解析 host（即使与原 host 相同，也要重新解析——DNS rebinding 防御）。
 * - 逐个校验每个解析地址。
 *
 * 同 host 重定向不豁免：攻击者可以让首次解析返回公网 IP、重定向时返回内网 IP。
 * 重定向次数必须有上限，超过即 fail closed。
 */
export interface RedirectRevalidationContract {
  readonly revalidateOnRedirect: true
  readonly maxRedirects: number
  readonly requireReResolutionEvenIfSameHost: true
  readonly denyRedirectToPrivateOrLoopback: true
}

export const REDIRECT_POLICY: RedirectRevalidationContract = {
  revalidateOnRedirect: true,
  maxRedirects: 5,
  requireReResolutionEvenIfSameHost: true,
  denyRedirectToPrivateOrLoopback: true,
}

// --- IPv4 解析 ---

/**
 * 将 dotted-quad 字符串解析为无符号 32 位整数。
 * 仅接受纯十进制 0-255 八位组，且禁止前导零（防御八进制规避如 "0177.0.0.1"）。
 * 单整数 / 十六进制 / 八进制形式由 WHATWG URL parser 提前规范化；此处防御性二次校验。
 * 返回 null 表示无法解析（fail closed 由调用方处理）。
 */
export function parseIpv4ToUint32(input: string): number | null {
  const parts = input.split(".")
  if (parts.length !== 4) return null
  const octets: number[] = []
  for (const p of parts) {
    // 接受 "0" 或非零开头的纯十进制；拒绝 "0177"、"00"、"0x7f" 等前导零/非十进制形式。
    if (!/^(0|[1-9]\d*)$/.test(p)) return null
    const n = Number(p)
    if (n > 255) return null
    octets.push(n)
  }
  return (
    (octets[0] * 0x1000000 + octets[1] * 0x10000 + octets[2] * 0x100 + octets[3]) >>> 0
  )
}

function parseIpv4CidrPrefix(cidr: string): { base: number; prefix: number } | null {
  const [baseStr, prefixStr] = cidr.split("/")
  if (!baseStr || prefixStr === undefined) return null
  const prefix = Number(prefixStr)
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null
  const base = parseIpv4ToUint32(baseStr)
  if (base === null) return null
  return { base: base >>> 0, prefix }
}

function ipv4InCidr(ip: number, cidrBase: number, cidrPrefix: number): boolean {
  if (cidrPrefix === 0) return true
  if (cidrPrefix >= 32) return (ip >>> 0) === (cidrBase >>> 0)
  const mask = (0xffffffff << (32 - cidrPrefix)) >>> 0
  return ((ip & mask) >>> 0) === ((cidrBase & mask) >>> 0)
}

// --- IPv6 解析 ---

export interface Ipv6Address {
  /** 8 个 16 位组。 */
  groups: Uint16Array
}

/**
 * 将 IPv6 字符串解析为 8 个 16 位组。
 * 接受 bracket 形式 `[::1]`（URL hostname）与裸形式 `::1`。
 * 处理 `::` 简写、IPv4-mapped（`::ffff:a.b.c.d`）与 IPv4-compatible（`::a.b.c.d`）尾部。
 * 返回 null 表示无法解析。
 */
export function parseIpv6(input: string): Ipv6Address | null {
  let str = input
  if (str.startsWith("[") && str.endsWith("]")) {
    str = str.slice(1, -1)
  }
  if (!isIPv6(str)) return null

  // 先按 `::` 切分（最多允许一个），保留简写标记以便后续正确展开。
  // 这样在处理 IPv4-mapped/compatible 尾部时不会破坏 `::` 标记。
  // 例如 `::127.0.0.1`：doubleColon=0, leftPart="", rightPart="127.0.0.1"。
  const doubleColon = str.indexOf("::")
  let leftPart: string
  let rightPart: string
  let hasDoubleColon: boolean

  if (doubleColon !== -1) {
    if (str.indexOf("::", doubleColon + 1) !== -1) return null
    hasDoubleColon = true
    leftPart = str.slice(0, doubleColon)
    rightPart = str.slice(doubleColon + 2)
  } else {
    hasDoubleColon = false
    leftPart = str
    rightPart = ""
  }

  const leftSegs = leftPart === "" ? [] : leftPart.split(":")
  const rightSegs = rightPart === "" ? [] : rightPart.split(":")
  if (leftSegs.some((g) => g === "")) return null
  if (rightSegs.some((g) => g === "")) return null

  // 检查尾部是否为 IPv4-mapped/compatible 段（如 "127.0.0.1"）。
  const allSegs = [...leftSegs, ...rightSegs]
  let v4Tail: number | null = null
  if (allSegs.length > 0) {
    const lastIdx = allSegs.length - 1
    if (allSegs[lastIdx].includes(".")) {
      v4Tail = parseIpv4ToUint32(allSegs[lastIdx])
      if (v4Tail === null) return null
      allSegs.pop()
    }
  }

  // 解析剩余段为 16 位组。
  const hexGroups: number[] = []
  for (const g of allSegs) {
    const v = parseHexGroup(g)
    if (v === null) return null
    hexGroups.push(v)
  }

  const totalGroups = hexGroups.length + (v4Tail !== null ? 2 : 0)
  if (hasDoubleColon) {
    if (totalGroups > 8) return null
  } else {
    if (totalGroups !== 8) return null
  }

  // 组装 8 个 16 位组：左侧 hex → 中间零填充 → 右侧 hex → IPv4 尾部（2 组）。
  const groups = new Uint16Array(8)
  let idx = 0
  // 左侧 hex 段放在开头。
  const leftHexCount = leftSegs.length
  for (let i = 0; i < leftHexCount; i++) {
    groups[idx++] = hexGroups[i]
  }
  // 中间零填充（:: 展开部分）。
  const zeroFill = 8 - hexGroups.length - (v4Tail !== null ? 2 : 0)
  for (let i = 0; i < zeroFill; i++) {
    groups[idx++] = 0
  }
  // 右侧 hex 段放在零填充之后。
  for (let i = leftHexCount; i < hexGroups.length; i++) {
    groups[idx++] = hexGroups[i]
  }
  // IPv4 尾部（2 个 16 位组）放在末尾。
  if (v4Tail !== null) {
    groups[idx++] = (v4Tail >>> 16) & 0xffff
    groups[idx++] = v4Tail & 0xffff
  }
  if (idx !== 8) return null

  return { groups }
}

function parseHexGroup(g: string): number | null {
  if (g.length === 0 || g.length > 4) return null
  if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null
  return parseInt(g, 16)
}

function parseIpv6CidrPrefix(cidr: string): { base: Ipv6Address; prefix: number } | null {
  const [baseStr, prefixStr] = cidr.split("/")
  if (!baseStr || prefixStr === undefined) return null
  const prefix = Number(prefixStr)
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return null
  const base = parseIpv6(baseStr)
  if (base === null) return null
  return { base, prefix }
}

function ipv6InCidr(ip: Ipv6Address, cidrBase: Ipv6Address, cidrPrefix: number): boolean {
  if (cidrPrefix === 0) return true
  const fullGroups = Math.floor(cidrPrefix / 16)
  const remainderBits = cidrPrefix % 16
  for (let i = 0; i < fullGroups; i++) {
    if (ip.groups[i] !== cidrBase.groups[i]) return false
  }
  if (remainderBits === 0) return true
  if (fullGroups >= 8) return true
  const mask = (0xffff << (16 - remainderBits)) & 0xffff
  return (ip.groups[fullGroups] & mask) === (cidrBase.groups[fullGroups] & mask)
}

// --- IPv4-mapped IPv6 抽取 ---

/**
 * 若 IPv6 地址为 IPv4-mapped（`::ffff:a.b.c.d/96`）或 IPv4-compatible（`::a.b.c.d/96`，已废弃），
 * 返回内嵌 IPv4 的无符号 32 位整数。否则返回 null。
 *
 * `::1` 与 `::` 虽形式上属于 compatible 范围，但已被 IPv6 拒绝清单覆盖，
 * 本函数显式排除二者，避免重复分类。
 */
export function extractEmbeddedIpv4(ip: Ipv6Address): number | null {
  // IPv4-mapped: ::ffff:a.b.c.d → groups[0..4]=0, groups[5]=0xffff, groups[6..7]=IPv4
  const isMapped =
    ip.groups[0] === 0 &&
    ip.groups[1] === 0 &&
    ip.groups[2] === 0 &&
    ip.groups[3] === 0 &&
    ip.groups[4] === 0 &&
    ip.groups[5] === 0xffff
  if (isMapped) {
    return (((ip.groups[6] << 16) >>> 0) + ip.groups[7]) >>> 0
  }
  // IPv4-compatible: ::a.b.c.d → groups[0..5]=0, groups[6..7]=IPv4
  // 排除 ::1（loopback，已被 IPv6 清单拒绝）与 ::（unspecified，已被 IPv6 清单拒绝）。
  const isCompatible =
    ip.groups[0] === 0 &&
    ip.groups[1] === 0 &&
    ip.groups[2] === 0 &&
    ip.groups[3] === 0 &&
    ip.groups[4] === 0 &&
    ip.groups[5] === 0 &&
    !(ip.groups[6] === 0 && ip.groups[7] === 1) &&
    !(ip.groups[6] === 0 && ip.groups[7] === 0)
  if (isCompatible) {
    return (((ip.groups[6] << 16) >>> 0) + ip.groups[7]) >>> 0
  }
  return null
}

// --- 模块加载时一次性预解析拒绝清单 ---

const IPV4_PARSED_RANGES = IPV4_DENY_RANGES.map((r) => {
  const parsed = parseIpv4CidrPrefix(r.cidr)
  if (!parsed) throw new Error(`invalid IPv4 deny CIDR: ${r.cidr}`)
  return { ...r, ...parsed }
})

const IPV6_PARSED_RANGES = IPV6_DENY_RANGES.map((r) => {
  const parsed = parseIpv6CidrPrefix(r.cidr)
  if (!parsed) throw new Error(`invalid IPv6 deny CIDR: ${r.cidr}`)
  return { ...r, ...parsed }
})

// --- 分类函数 ---

export function classifyIpv4Address(ipStr: string): UrlPolicyDecision {
  const ip = parseIpv4ToUint32(ipStr)
  if (ip === null) {
    return { decision: "deny", reason: "ip_denied_reserved", detail: `unparseable IPv4: ${ipStr}` }
  }
  for (const r of IPV4_PARSED_RANGES) {
    if (ipv4InCidr(ip, r.base, r.prefix)) {
      return { decision: "deny", reason: r.reason, detail: `${ipStr} matches ${r.cidr} (${r.description})` }
    }
  }
  return { decision: "allow", reason: "public", detail: `${ipStr} is public IPv4` }
}

export function classifyIpv6Address(ipStr: string): UrlPolicyDecision {
  const ip = parseIpv6(ipStr)
  if (ip === null) {
    return { decision: "deny", reason: "ip_denied_reserved", detail: `unparseable IPv6: ${ipStr}` }
  }
  for (const r of IPV6_PARSED_RANGES) {
    if (ipv6InCidr(ip, r.base, r.prefix)) {
      return { decision: "deny", reason: r.reason, detail: `${ipStr} matches ${r.cidr} (${r.description})` }
    }
  }
  // 检查 IPv4-mapped / compatible 内嵌地址。
  const embedded = extractEmbeddedIpv4(ip)
  if (embedded !== null) {
    const embeddedStr = `${(embedded >>> 24) & 0xff}.${(embedded >>> 16) & 0xff}.${(embedded >>> 8) & 0xff}.${embedded & 0xff}`
    for (const r of IPV4_PARSED_RANGES) {
      if (ipv4InCidr(embedded, r.base, r.prefix)) {
        return {
          decision: "deny",
          reason: r.reason,
          detail: `${ipStr} embeds ${embeddedStr} matching ${r.cidr} (${r.description})`,
        }
      }
    }
  }
  return { decision: "allow", reason: "public", detail: `${ipStr} is public IPv6` }
}

/**
 * 对单个 IP 字面量分类。自动剥除 IPv6 bracket。
 */
export function classifyIpAddress(ipStr: string): UrlPolicyDecision {
  const cleaned = ipStr.startsWith("[") && ipStr.endsWith("]") ? ipStr.slice(1, -1) : ipStr
  if (isIPv4(cleaned)) return classifyIpv4Address(cleaned)
  if (isIPv6(cleaned)) return classifyIpv6Address(cleaned)
  return { decision: "deny", reason: "ip_denied_reserved", detail: `not an IP literal: ${ipStr}` }
}

/**
 * 对 hostname（IP 字面量或域名）分类。
 *
 * - 若为 IP 字面量，直接分类。
 * - 若为域名，调用 resolver 获取所有地址，逐个分类。
 * - DNS rebinding 防御：任一解析地址被拒 → 整个 host 拒绝。
 * - 解析返回空 → 拒绝（host_unresolvable）。
 * - 解析抛错 → 拒绝（host_unresolvable）。
 */
export async function classifyHost(
  hostname: string,
  resolver: HostResolver,
): Promise<UrlPolicyDecision> {
  // IP 字面量快速路径。
  if (isIPv4(hostname)) return classifyIpv4Address(hostname)
  const stripped = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname
  if (isIPv6(stripped)) return classifyIpv6Address(stripped)

  // 域名：解析并 fail closed。
  let resolution: HostResolution
  try {
    resolution = await resolver(hostname)
  } catch (err) {
    return {
      decision: "deny",
      reason: "host_unresolvable",
      detail: `resolver threw: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (!resolution || !resolution.addresses || resolution.addresses.length === 0) {
    return {
      decision: "deny",
      reason: "host_unresolvable",
      detail: `no addresses returned for ${hostname}`,
    }
  }
  for (const addr of resolution.addresses) {
    const sub = classifyIpAddress(addr)
    if (sub.decision === "deny") {
      return {
        decision: "deny",
        reason: "host_resolves_to_denied_ip",
        detail: `${hostname} resolves to ${addr} → ${sub.reason}: ${sub.detail}`,
      }
    }
  }
  return {
    decision: "allow",
    reason: "public",
    detail: `${hostname} resolves to ${resolution.addresses.length} public address(es): ${resolution.addresses.join(", ")}`,
  }
}

/**
 * 顶层 URL 策略检查。校验 scheme、userinfo、host、IP 分类。
 * 返回决策；调用方（P4.2）负责根据决策执行或拒绝 fetch。
 */
export async function checkUrl(
  url: URL,
  resolver: HostResolver,
): Promise<UrlPolicyDecision> {
  if (!URL_SCHEME_ALLOWLIST.has(url.protocol)) {
    return {
      decision: "deny",
      reason: "scheme_not_http",
      detail: `scheme ${url.protocol} not in allowlist [http:, https:]`,
    }
  }
  if (url.username !== "" || url.password !== "") {
    return {
      decision: "deny",
      reason: "url_has_userinfo",
      detail: "URL contains userinfo (username/password); not permitted",
    }
  }
  const host = url.hostname
  if (!host) {
    return {
      decision: "deny",
      reason: "url_missing_host",
      detail: "URL has no hostname",
    }
  }
  return classifyHost(host, resolver)
}

/**
 * 默认 unresolving 占位 resolver。P4.2 必须注入真实 `dns.lookup`。
 * 此处仅用于保证策略模块可独立测试，不依赖 DNS。
 */
export const UNRESOLVED_HOST: HostResolver = async () => ({ addresses: [] })
