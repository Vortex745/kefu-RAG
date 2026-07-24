// Ticket 10 Phase D P2 — Golden set fixtures (60 synthetic versioned cases).
//
// Spec §9 L1556-1557:
//   - At least 60 versioned cases across 6 categories
//     (10 direct + 15 simple + 10 complex + 10 ambiguous + 10 insufficient + 5 correction)
//   - Each knowledge case declares expected Source identities or acceptable
//     Evidence IDs, required coverage criteria, and whether handoff is
//     acceptable.
//   - Bounded, synthetic, committed without private data (spec L1568).
//
// All userMessage strings are SYNTHETIC — no production conversations, no
// real user identifiers, no secrets. Source/Evidence IDs are stable
// identifiers scoped to this dataset ("source-onboarding-v2", etc.) so P3-P5
// evaluators can compare retrieved IDs against expected IDs without coupling
// to production data.
//
// Dataset version follows the spec L1556 "versioned cases" requirement and is
// bumped when any case shape changes (added/removed/edited userMessage,
// expectedSourceIds, acceptableEvidenceIds, requiredCoverageCriteria, or
// handoffAcceptable).

import type { GoldenCase, GoldenCaseCategory, GoldenSet, ToolLoopScenario } from "../types"
import type { RouterDecision } from "../../types/agent"

const DATASET_VERSION = "2026.07.t10"

/**
 * Build a GoldenCase with common defaults (version=1, empty arrays for
 * optional source/evidence lists). Caller inlines userMessage and per-case
 * opts so reviewers can read every case in the array literal.
 */
function mkCase(
  id: string,
  category: GoldenCaseCategory,
  userMessage: string,
  opts: {
    route?: RouterDecision
    sources?: string[]
    evidence?: string[]
    criteria?: string[]
    handoff?: boolean
    notes?: string
    scenario?: ToolLoopScenario
    expectedMaxIterations?: number
    expectedMaxToolCalls?: number
    expectedFallback?: boolean
    compressed?: boolean
  } = {},
): GoldenCase {
  const result: GoldenCase = {
    id,
    version: 1,
    category,
    userMessage,
    expectedSourceIds: opts.sources ?? [],
    acceptableEvidenceIds: opts.evidence ?? [],
  }
  if (opts.route !== undefined) result.expectedRoute = opts.route
  if (opts.criteria !== undefined) result.requiredCoverageCriteria = opts.criteria
  if (opts.handoff !== undefined) result.handoffAcceptable = opts.handoff
  if (opts.notes !== undefined) result.notes = opts.notes
  if (opts.scenario !== undefined) result.scenario = opts.scenario
  if (opts.expectedMaxIterations !== undefined) result.expectedMaxIterations = opts.expectedMaxIterations
  if (opts.expectedMaxToolCalls !== undefined) result.expectedMaxToolCalls = opts.expectedMaxToolCalls
  if (opts.expectedFallback !== undefined) result.expectedFallback = opts.expectedFallback
  if (opts.compressed !== undefined) result.compressed = opts.compressed
  return result
}

// ---------------------------------------------------------------------------
// Direct (10) — greetings / common sense / system meta-questions.
// No Retrieval needed; Router must return `direct`. Spec L1556 requires >=10.
// expectedRoute=direct; expectedSourceIds/acceptableEvidenceIds intentionally [].
// ---------------------------------------------------------------------------

const directCases: GoldenCase[] = [
  mkCase("direct-01", "direct", "你好", { route: "direct", notes: "Greeting — no knowledge needed" }),
  mkCase("direct-02", "direct", "你是谁？", { route: "direct", notes: "Identity question" }),
  mkCase("direct-03", "direct", "今天星期几？", { route: "direct", notes: "Time question — runtime clock" }),
  mkCase("direct-04", "direct", "1+1等于几？", { route: "direct", notes: "Arithmetic" }),
  mkCase("direct-05", "direct", "请解释什么是 RAG 系统。", { route: "direct", notes: "Common-knowledge concept" }),
  mkCase("direct-06", "direct", "你能用什么语言回答？", { route: "direct", notes: "Capability self-description" }),
  mkCase("direct-07", "direct", "如何重置密码？", { route: "direct", notes: "Generic guidance — not tenant-specific policy" }),
  mkCase("direct-08", "direct", "什么是 embedding？", { route: "direct", notes: "Conceptual ML question" }),
  mkCase("direct-09", "direct", "感谢你的帮助！", { route: "direct", notes: "Thanks — no answer needed" }),
  mkCase("direct-10", "direct", "再见", { route: "direct", notes: "Farewell — no answer needed" }),
]

// ---------------------------------------------------------------------------
// Simple (15) — single-source knowledge questions with 1 expected Source.
// Spec L1556 requires >=15. Knowledge route → must declare source/evidence.
// ---------------------------------------------------------------------------

const simpleCases: GoldenCase[] = [
  mkCase("simple-01", "simple", "请说明 onboarding-v2 的核心步骤。", {
    route: "simple",
    sources: ["source-onboarding-v2"],
    evidence: ["evidence-onboarding-v2-01"],
    criteria: ["核心步骤", "完成条件"],
    notes: "Single-source policy lookup",
  }),
  mkCase("simple-02", "simple", "API 限流策略是什么？", {
    route: "simple",
    sources: ["source-api-limits"],
    evidence: ["evidence-api-limits-01"],
    criteria: ["限流阈值", "限流算法"],
  }),
  mkCase("simple-03", "simple", "产品 X 的退款流程？", {
    route: "simple",
    sources: ["source-refund-policy"],
    evidence: ["evidence-refund-policy-01"],
    criteria: ["退款条件", "处理时长"],
  }),
  mkCase("simple-04", "simple", "如何配置 SSO？", {
    route: "simple",
    sources: ["source-sso-config"],
    evidence: ["evidence-sso-config-01"],
    criteria: ["配置步骤", "验证方法"],
  }),
  mkCase("simple-05", "simple", "差旅报销标准？", {
    route: "simple",
    sources: ["source-travel-policy"],
    evidence: ["evidence-travel-policy-01"],
    criteria: ["报销上限", "审批流程"],
  }),
  mkCase("simple-06", "simple", "假期政策是什么？", {
    route: "simple",
    sources: ["source-leave-policy"],
    evidence: ["evidence-leave-policy-01"],
    criteria: ["假期类型", "申请流程"],
  }),
  mkCase("simple-07", "simple", "代码提交规范？", {
    route: "simple",
    sources: ["source-code-standards"],
    evidence: ["evidence-code-standards-01"],
    criteria: ["提交格式", "评审要求"],
  }),
  mkCase("simple-08", "simple", "新员工入职流程？", {
    route: "simple",
    sources: ["source-onboarding-checklist"],
    evidence: ["evidence-onboarding-checklist-01"],
    criteria: ["首日任务", "首周任务"],
  }),
  mkCase("simple-09", "simple", "数据中心地址？", {
    route: "simple",
    sources: ["source-datacenter-locations"],
    evidence: ["evidence-datacenter-locations-01"],
    criteria: ["地址列表", "区域分布"],
  }),
  mkCase("simple-10", "simple", "VPN 配置步骤？", {
    route: "simple",
    sources: ["source-vpn-setup"],
    evidence: ["evidence-vpn-setup-01"],
    criteria: ["客户端配置", "认证方式"],
  }),
  mkCase("simple-11", "simple", "安全合规要求？", {
    route: "simple",
    sources: ["source-security-compliance"],
    evidence: ["evidence-security-compliance-01"],
    criteria: ["合规标准", "审计要求"],
  }),
  mkCase("simple-12", "simple", "客户支持 SLA？", {
    route: "simple",
    sources: ["source-support-sla"],
    evidence: ["evidence-support-sla-01"],
    criteria: ["响应时间", "升级路径"],
  }),
  mkCase("simple-13", "simple", "薪资发放日期？", {
    route: "simple",
    sources: ["source-payroll-schedule"],
    evidence: ["evidence-payroll-schedule-01"],
    criteria: ["发放日", "异常处理"],
  }),
  mkCase("simple-14", "simple", "服务器维护窗口？", {
    route: "simple",
    sources: ["source-maintenance-window"],
    evidence: ["evidence-maintenance-window-01"],
    criteria: ["维护时间", "影响范围"],
  }),
  mkCase("simple-15", "simple", "数据备份策略？", {
    route: "simple",
    sources: ["source-backup-policy"],
    evidence: ["evidence-backup-policy-01"],
    criteria: ["备份频率", "恢复点目标"],
  }),
]

// ---------------------------------------------------------------------------
// Complex (10) — multi-Source cross-policy analysis with graph provenance.
// Spec L1556 requires >=10. handoffAcceptable=true (complex may legitimately
// hand off to human reviewer when evidence is incomplete).
// ---------------------------------------------------------------------------

const complexCases: GoldenCase[] = [
  mkCase("complex-01", "complex", "对比 onboarding-v1 和 onboarding-v2 的差异，并指出 v2 的改进点。", {
    route: "complex",
    sources: ["source-onboarding-v1", "source-onboarding-v2"],
    evidence: ["evidence-onboarding-v1-01", "evidence-onboarding-v2-01"],
    criteria: ["版本差异", "v2 改进点", "兼容性"],
    handoff: true,
  }),
  mkCase("complex-02", "complex", "分析 API 限流策略与客户支持 SLA 之间的关系。", {
    route: "complex",
    sources: ["source-api-limits", "source-support-sla"],
    evidence: ["evidence-api-limits-01", "evidence-support-sla-01"],
    criteria: ["限流影响 SLA", "协调机制"],
    handoff: true,
  }),
  mkCase("complex-03", "complex", "退款流程如何影响客户满意度？请结合 SLA 分析。", {
    route: "complex",
    sources: ["source-refund-policy", "source-support-sla"],
    evidence: ["evidence-refund-policy-01", "evidence-support-sla-01"],
    criteria: ["退款时长", "SLA 影响", "满意度指标"],
    handoff: true,
  }),
  mkCase("complex-04", "complex", "SSO 配置与安全合规的关系？给出对接点。", {
    route: "complex",
    sources: ["source-sso-config", "source-security-compliance"],
    evidence: ["evidence-sso-config-01", "evidence-security-compliance-01"],
    criteria: ["SSO 安全考量", "合规对接点"],
    handoff: true,
  }),
  mkCase("complex-05", "complex", "差旅与假期政策的重叠场景如何处理？", {
    route: "complex",
    sources: ["source-travel-policy", "source-leave-policy"],
    evidence: ["evidence-travel-policy-01", "evidence-leave-policy-01"],
    criteria: ["政策优先级", "边界场景"],
    handoff: true,
  }),
  mkCase("complex-06", "complex", "代码规范与 onboarding 流程的衔接点是什么？", {
    route: "complex",
    sources: ["source-code-standards", "source-onboarding-checklist"],
    evidence: ["evidence-code-standards-01", "evidence-onboarding-checklist-01"],
    criteria: ["规范融入 onboarding", "新人指导"],
    handoff: true,
  }),
  mkCase("complex-07", "complex", "数据中心与 VPN 的安全考量有哪些？", {
    route: "complex",
    sources: ["source-datacenter-locations", "source-vpn-setup"],
    evidence: ["evidence-datacenter-locations-01", "evidence-vpn-setup-01"],
    criteria: ["数据中心访问", "VPN 安全策略"],
    handoff: true,
  }),
  mkCase("complex-08", "complex", "维护窗口与备份策略如何协调？", {
    route: "complex",
    sources: ["source-maintenance-window", "source-backup-policy"],
    evidence: ["evidence-maintenance-window-01", "evidence-backup-policy-01"],
    criteria: ["窗口协调", "备份触发时机"],
    handoff: true,
  }),
  mkCase("complex-09", "complex", "薪资发放与假期政策的交互边界？", {
    route: "complex",
    sources: ["source-payroll-schedule", "source-leave-policy"],
    evidence: ["evidence-payroll-schedule-01", "evidence-leave-policy-01"],
    criteria: ["假期扣薪规则", "发放日顺延规则"],
    handoff: true,
  }),
  mkCase("complex-10", "complex", "全栈 onboarding（人事 + IT + 安全）流程如何串起来？", {
    route: "complex",
    sources: ["source-onboarding-checklist", "source-vpn-setup", "source-security-compliance"],
    evidence: ["evidence-onboarding-checklist-01", "evidence-vpn-setup-01", "evidence-security-compliance-01"],
    criteria: ["人事流程", "IT 配置", "安全培训", "串联节点"],
    handoff: true,
  }),
]

// ---------------------------------------------------------------------------
// Ambiguous (10) — clarification-required queries with no Retrieval until
// the user clarifies. Spec L1556 requires >=10. expectedRoute=ambiguous;
// expectedSourceIds/acceptableEvidenceIds intentionally [] (KNOWLEDGE_ROUTE
// invariant excludes ambiguous). handoffAcceptable=true (terminal status
// `clarification_required` is the expected outcome).
// ---------------------------------------------------------------------------

const ambiguousCases: GoldenCase[] = [
  mkCase("ambiguous-01", "ambiguous", "我有个问题。", { route: "ambiguous", handoff: true, notes: "No topic — must clarify" }),
  mkCase("ambiguous-02", "ambiguous", "帮助", { route: "ambiguous", handoff: true, notes: "Too short to act" }),
  mkCase("ambiguous-03", "ambiguous", "如何使用？", { route: "ambiguous", handoff: true, notes: "Missing object" }),
  mkCase("ambiguous-04", "ambiguous", "策略是什么？", { route: "ambiguous", handoff: true, notes: "Missing policy name" }),
  mkCase("ambiguous-05", "ambiguous", "流程怎么走？", { route: "ambiguous", handoff: true, notes: "Missing flow name" }),
  mkCase("ambiguous-06", "ambiguous", "配置一下。", { route: "ambiguous", handoff: true, notes: "Missing target system" }),
  mkCase("ambiguous-07", "ambiguous", "有问题想问。", { route: "ambiguous", handoff: true, notes: "No content" }),
  mkCase("ambiguous-08", "ambiguous", "请说明。", { route: "ambiguous", handoff: true, notes: "Missing subject" }),
  mkCase("ambiguous-09", "ambiguous", "怎么回事？", { route: "ambiguous", handoff: true, notes: "Missing object" }),
  mkCase("ambiguous-10", "ambiguous", "出错了吗？", { route: "ambiguous", handoff: true, notes: "Missing error context" }),
]

// ---------------------------------------------------------------------------
// Insufficient (10) — knowledge route where available Sources/Evidence are
// incomplete. Spec L1556 requires >=10. expectedRoute is simple/complex (the
// Router still attempts knowledge routing); handoffAcceptable=true (terminal
// status `insufficient_evidence` or `handoff_required` is acceptable).
// KNOWLEDGE_ROUTE invariant includes `insufficient` → must declare source/evidence.
// ---------------------------------------------------------------------------

const insufficientCases: GoldenCase[] = [
  mkCase("insufficient-01", "insufficient", "请说明 legacy-system-v3 的迁移路径。", {
    route: "simple",
    sources: ["source-legacy-system-v3"],
    evidence: ["evidence-legacy-system-v3-01"],
    criteria: ["迁移步骤", "回滚方案"],
    handoff: true,
    notes: "Source exists but migration path is documented as TODO",
  }),
  mkCase("insufficient-02", "insufficient", "告诉我 discontinued-product 的退货政策。", {
    route: "simple",
    sources: ["source-discontinued-product"],
    evidence: ["evidence-discontinued-product-01"],
    criteria: ["退货条件", "处理时长"],
    handoff: true,
    notes: "Product discontinued — refund policy stale",
  }),
  mkCase("insufficient-03", "insufficient", "查找 deprecated-api 的使用方法。", {
    route: "simple",
    sources: ["source-deprecated-api"],
    evidence: ["evidence-deprecated-api-01"],
    criteria: ["替代 API", "迁移指南"],
    handoff: true,
    notes: "API deprecated — usage docs partial",
  }),
  mkCase("insufficient-04", "insufficient", "解释 pending-policy 的具体规则。", {
    route: "simple",
    sources: ["source-pending-policy"],
    evidence: ["evidence-pending-policy-01"],
    criteria: ["规则详情", "生效日期"],
    handoff: true,
    notes: "Policy still in review — rules TBD",
  }),
  mkCase("insufficient-05", "insufficient", "分析 draft-spec 的实施细节。", {
    route: "simple",
    sources: ["source-draft-spec"],
    evidence: ["evidence-draft-spec-01"],
    criteria: ["实施步骤", "验收标准"],
    handoff: true,
    notes: "Spec in draft — details incomplete",
  }),
  mkCase("insufficient-06", "insufficient", "列出 historical-data 的格式。", {
    route: "simple",
    sources: ["source-historical-data"],
    evidence: ["evidence-historical-data-01"],
    criteria: ["数据格式", "字段说明"],
    handoff: true,
    notes: "Historical data — format partially documented",
  }),
  mkCase("insufficient-07", "insufficient", "提供 future-roadmap 的优先级。", {
    route: "simple",
    sources: ["source-future-roadmap"],
    evidence: ["evidence-future-roadmap-01"],
    criteria: ["优先级排序", "里程碑"],
    handoff: true,
    notes: "Roadmap not yet finalized",
  }),
  mkCase("insufficient-08", "insufficient", "总结 partial-doc 的核心结论。", {
    route: "simple",
    sources: ["source-partial-doc"],
    evidence: ["evidence-partial-doc-01"],
    criteria: ["核心结论", "数据支撑"],
    handoff: true,
    notes: "Doc partial — conclusions incomplete",
  }),
  mkCase("insufficient-09", "insufficient", "回顾 deleted-feature 的迁移指南。", {
    route: "simple",
    sources: ["source-deleted-feature"],
    evidence: ["evidence-deleted-feature-01"],
    criteria: ["迁移路径", "替代方案"],
    handoff: true,
    notes: "Feature deleted — migration guide sparse",
  }),
  mkCase("insufficient-10", "insufficient", "评估 incomplete-spec 的可行性。", {
    route: "simple",
    sources: ["source-incomplete-spec"],
    evidence: ["evidence-incomplete-spec-01"],
    criteria: ["可行性分析", "风险评估"],
    handoff: true,
    notes: "Spec incomplete — feasibility uncertain",
  }),
]

// ---------------------------------------------------------------------------
// Correction (5) — multi-turn bounded correction cases. Spec L1556 requires
// >=5. expectedRoute=complex (multi-source reasoning required). Each case
// must complete within bounded correction rounds (spec L1559 threshold >=70%).
// handoffAcceptable=true (correction may legitimately fail → handoff).
// ---------------------------------------------------------------------------

const correctionCases: GoldenCase[] = [
  mkCase("correction-01", "correction", "请说明 onboarding-v2 的核心步骤，特别是新员工需要完成的所有任务，包括 IT 配置和安全培训。", {
    route: "complex",
    sources: ["source-onboarding-v2", "source-onboarding-checklist", "source-vpn-setup", "source-security-compliance"],
    evidence: ["evidence-onboarding-v2-01", "evidence-onboarding-checklist-01", "evidence-vpn-setup-01", "evidence-security-compliance-01"],
    criteria: ["核心步骤", "IT 配置任务", "安全培训要求", "完成条件", "验收清单"],
    handoff: true,
    notes: "Multi-turn correction — first answer usually incomplete on training tasks",
  }),
  mkCase("correction-02", "correction", "对比 onboarding-v1 和 v2，重点说明 v2 的改进点、兼容性和迁移成本。", {
    route: "complex",
    sources: ["source-onboarding-v1", "source-onboarding-v2"],
    evidence: ["evidence-onboarding-v1-01", "evidence-onboarding-v2-01"],
    criteria: ["版本差异", "v2 改进点", "兼容性", "迁移成本", "回滚方案"],
    handoff: true,
    notes: "Multi-turn correction — migration cost often missed in first answer",
  }),
  mkCase("correction-03", "correction", "API 限流策略如何与客户支持 SLA 协调？请给出具体的协调机制和升级路径。", {
    route: "complex",
    sources: ["source-api-limits", "source-support-sla"],
    evidence: ["evidence-api-limits-01", "evidence-support-sla-01"],
    criteria: ["限流阈值", "SLA 响应时间", "协调机制", "升级路径", "客户通知策略"],
    handoff: true,
    notes: "Multi-turn correction — escalation path usually missing initially",
  }),
  mkCase("correction-04", "correction", "退款流程的完整步骤是什么？包括客户需要提交的材料、处理时长、各阶段的责任人。", {
    route: "complex",
    sources: ["source-refund-policy", "source-support-sla"],
    evidence: ["evidence-refund-policy-01", "evidence-support-sla-01"],
    criteria: ["客户提交材料", "处理时长", "各阶段责任人", "状态查询方式", "异常处理"],
    handoff: true,
    notes: "Multi-turn correction — responsible parties often vague initially",
  }),
  mkCase("correction-05", "correction", "SSO 配置的完整流程，包括与安全合规的对接点、验证步骤和故障排查方法。", {
    route: "complex",
    sources: ["source-sso-config", "source-security-compliance"],
    evidence: ["evidence-sso-config-01", "evidence-security-compliance-01"],
    criteria: ["配置步骤", "合规对接点", "验证步骤", "故障排查", "回滚方案"],
    handoff: true,
    notes: "Multi-turn correction — troubleshooting usually missed initially",
  }),
]

// ---------------------------------------------------------------------------
// Ticket 10 — Tool-loop evaluation gates (criterion #1).
// 8 versioned cases covering 6 tool-loop scenarios + 2 compressed variants
// (criterion #6: compressed and uncompressed cases use the same expected
// Evidence and completion requirements). These cases exercise the bounded
// retrieval tool loop (T08/T09) and verify the hard invariants
// `tool_loop_budget_termination` and `unauthorized_tool_rejection`, plus the
// quality metric `tool_loop_fallback_rate`.
// ---------------------------------------------------------------------------

const toolLoopCases: GoldenCase[] = [
  // Scenario 1: single-tool — simple route, LLM picks one read-only tool.
  mkCase("simple-tool-01", "simple", "请说明 onboarding-v2 的核心步骤。", {
    route: "simple",
    sources: ["source-onboarding-v2"],
    evidence: ["evidence-onboarding-v2-01"],
    criteria: ["核心步骤"],
    scenario: "single-tool",
    expectedMaxIterations: 1,
    expectedMaxToolCalls: 1,
    notes: "Simple route — LLM selects semantic_lexical_hybrid for a single-source policy lookup",
  }),

  // Scenario 2: multi-tool — complex route, LLM alternates ≥2 different tools.
  mkCase("complex-tool-01", "complex", "全栈 onboarding 流程中，人事步骤、IT 配置和安全培训如何串联？", {
    route: "complex",
    sources: ["source-onboarding-checklist", "source-vpn-setup", "source-security-compliance"],
    evidence: ["evidence-onboarding-checklist-01", "evidence-vpn-setup-01", "evidence-security-compliance-01"],
    criteria: ["人事流程", "IT 配置", "安全培训", "串联节点"],
    handoff: true,
    scenario: "multi-tool",
    expectedMaxIterations: 3,
    expectedMaxToolCalls: 3,
    notes: "Complex route — LLM alternates semantic_lexical_hybrid + graph_navigation + pageindex_hierarchy",
  }),

  // Scenario 2 compressed variant (criterion #6 — same expected Evidence + completion).
  mkCase("complex-tool-01c", "complex", "全栈 onboarding 流程中，人事步骤、IT 配置和安全培训如何串联？", {
    route: "complex",
    sources: ["source-onboarding-checklist", "source-vpn-setup", "source-security-compliance"],
    evidence: ["evidence-onboarding-checklist-01", "evidence-vpn-setup-01", "evidence-security-compliance-01"],
    criteria: ["人事流程", "IT 配置", "安全培训", "串联节点"],
    handoff: true,
    scenario: "multi-tool",
    expectedMaxIterations: 3,
    expectedMaxToolCalls: 3,
    compressed: true,
    notes: "Compressed variant of complex-tool-01 — same expected Evidence, semantic Context compression active",
  }),

  // Scenario 3: duplicate-call — complex route, duplicate tool call pressure.
  mkCase("complex-tool-02", "complex", "VPN 配置步骤和 onboarding 清单的交叉点是什么？", {
    route: "complex",
    sources: ["source-vpn-setup", "source-onboarding-checklist"],
    evidence: ["evidence-vpn-setup-01", "evidence-onboarding-checklist-01"],
    criteria: ["VPN 配置", "onboarding 清单", "交叉点"],
    handoff: true,
    scenario: "duplicate-call",
    expectedMaxIterations: 3,
    expectedMaxToolCalls: 2,
    notes: "Complex route — LLM retries same tool+query, dedup must skip without backend execution",
  }),

  // Scenario 4: budget-exhaustion — complex route, iteration budget exhausted.
  mkCase("complex-tool-03", "complex", "数据中心、VPN、备份策略和维护窗口之间的安全依赖关系？", {
    route: "complex",
    sources: ["source-datacenter-locations", "source-vpn-setup", "source-backup-policy", "source-maintenance-window"],
    evidence: ["evidence-datacenter-locations-01", "evidence-vpn-setup-01", "evidence-backup-policy-01", "evidence-maintenance-window-01"],
    criteria: ["数据中心访问", "VPN 安全", "备份策略", "维护窗口"],
    handoff: true,
    scenario: "budget-exhaustion",
    expectedMaxIterations: 3,
    expectedMaxToolCalls: 4,
    notes: "Complex route — 4-source question exhausts iteration budget (3) before full coverage",
  }),

  // Scenario 5: cancellation — user cancels during tool-loop decision or retrieval.
  mkCase("complex-tool-04", "complex", "详细对比所有产品的退款政策、SLA 和安全合规要求。", {
    route: "complex",
    sources: ["source-refund-policy", "source-support-sla", "source-security-compliance"],
    evidence: ["evidence-refund-policy-01", "evidence-support-sla-01", "evidence-security-compliance-01"],
    criteria: ["退款政策", "SLA", "安全合规"],
    handoff: true,
    scenario: "cancellation",
    expectedMaxIterations: 3,
    expectedMaxToolCalls: 4,
    notes: "Complex route — user cancels mid-loop; terminal status must be 'cancelled' with no late answer",
  }),

  // Scenario 6: deterministic-fallback — correction round, 0 loop results → searcher fallback.
  mkCase("correction-tool-01", "correction", "API 限流策略与客户支持 SLA 的协调机制和升级路径，包括异常处理。", {
    route: "complex",
    sources: ["source-api-limits", "source-support-sla"],
    evidence: ["evidence-api-limits-01", "evidence-support-sla-01"],
    criteria: ["限流阈值", "SLA 响应时间", "协调机制", "升级路径", "异常处理"],
    handoff: true,
    scenario: "deterministic-fallback",
    expectedMaxIterations: 3,
    expectedMaxToolCalls: 4,
    expectedFallback: true,
    notes: "Correction round — loop produces 0 usable results, deterministic searcher.search fallback fires",
  }),

  // Scenario 6 compressed variant (criterion #6 — same expected Evidence + completion).
  mkCase("correction-tool-01c", "correction", "API 限流策略与客户支持 SLA 的协调机制和升级路径，包括异常处理。", {
    route: "complex",
    sources: ["source-api-limits", "source-support-sla"],
    evidence: ["evidence-api-limits-01", "evidence-support-sla-01"],
    criteria: ["限流阈值", "SLA 响应时间", "协调机制", "升级路径", "异常处理"],
    handoff: true,
    scenario: "deterministic-fallback",
    expectedMaxIterations: 3,
    expectedMaxToolCalls: 4,
    expectedFallback: true,
    compressed: true,
    notes: "Compressed variant of correction-tool-01 — same expected Evidence, semantic Context compression active",
  }),
]

// ---------------------------------------------------------------------------
// Exported GoldenSet
// ---------------------------------------------------------------------------

export const GOLDEN_SET: GoldenSet = {
  version: DATASET_VERSION,
  cases: [
    ...directCases,
    ...simpleCases,
    ...complexCases,
    ...ambiguousCases,
    ...insufficientCases,
    ...correctionCases,
    ...toolLoopCases,
  ],
}

// Re-export counts for downstream tests / CLI tooling. Includes toolLoopCases
// per category so the fixture-count test stays accurate.
export const FIXTURE_COUNTS: Record<GoldenCaseCategory, number> = {
  direct: directCases.length,
  simple: simpleCases.length + toolLoopCases.filter((c) => c.category === "simple").length,
  complex: complexCases.length + toolLoopCases.filter((c) => c.category === "complex").length,
  ambiguous: ambiguousCases.length,
  insufficient: insufficientCases.length,
  correction: correctionCases.length + toolLoopCases.filter((c) => c.category === "correction").length,
}
