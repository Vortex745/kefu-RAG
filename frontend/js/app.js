import {
  ConversationImpl,
  LocalStorageConversationStorage,
  formatReferenceLocation,
  assetUrl,
  projectTraceEvents,
} from "./conversation.js"

const API_BASE = "http://localhost:3001/api"
const MAX_ATTACHMENT_BYTES = 128 * 1024
const MAX_ATTACHMENTS = 4
const STATUS_REFRESH_MS = 30_000
const INSIGHT_PATH_STEPS = [
  { stage: "route", label: "理解问题" },
  { stage: "retrieval", label: "查找资料" },
  { stage: "context", label: "整理证据" },
  { stage: "validation", label: "核对答案" },
  { stage: "done", label: "完成回答" },
]
const RAGAS_METRICS = [
  { key: "meanFaithfulness", label: "回答是否有依据" },
  { key: "meanAnswerRelevancy", label: "回答是否切题" },
  { key: "meanContextPrecision", label: "找到的资料是否精准" },
  { key: "meanContextRecall", label: "重要资料是否找全" },
]
const CHANNEL_LABELS = {
  elasticsearch: { name: "Elasticsearch", short: "ES" },
  neo4j: { name: "Neo4j 知识图谱", short: "Neo4j" },
  openai: { name: "OpenAI 兼容接口", short: "LLM" },
}
const STATUS_LABELS = {
  connected: { text: "已连接", dot: "green" },
  degraded: { text: "部分降级", dot: "amber" },
  disconnected: { text: "未连接", dot: "red" },
  unconfigured: { text: "未配置", dot: "gray" },
}
const UI_CLASSES = {
  threadListEmpty: "px-2.5 py-2 text-xs text-neutral-400 whitespace-nowrap",
  threadItem: "group/thread relative flex h-[34px] w-full items-center rounded-[7px] bg-transparent",
  threadItemActive: "group/thread relative flex h-[34px] w-full items-center rounded-[7px] bg-surface-hover",
  threadSelect: "h-full min-w-0 flex-1 cursor-pointer overflow-hidden bg-transparent pl-2.5 pr-[34px] text-left text-[13px] text-ellipsis whitespace-nowrap",
  threadDelete: "absolute right-1 grid size-[26px] cursor-pointer place-items-center rounded-[5px] bg-transparent text-neutral-500 opacity-0 transition-[opacity,background-color,color] duration-[120ms] hover:bg-[#e4e4e4] hover:text-red-600 focus-visible:opacity-100 group-hover/thread:opacity-100 max-md:opacity-100 [&_svg]:size-3.5",
  messageUser: "group/message flex w-full max-w-[720px] flex-col items-end",
  messageAssistant: "group/message flex w-full max-w-[720px] flex-col items-start",
  messageContentUser: "max-w-[min(82%,620px)] [overflow-wrap:anywhere] whitespace-pre-wrap rounded-[16px_16px_4px_16px] bg-surface-muted px-3.5 py-2.5 text-[15px] leading-[1.65] max-md:max-w-[88%]",
  messageContentAssistant: "w-full max-w-full [overflow-wrap:anywhere] whitespace-pre-wrap text-[15px] leading-[1.65] max-md:max-w-[88%]",
  thinking: "flex h-7 items-center gap-[5px]",
  thinkingDot: "size-1.5 animate-thinking rounded-full bg-neutral-500",
  messageActions: "mt-[5px] flex min-h-7 items-center gap-0.5 opacity-0 transition-opacity duration-[120ms] focus-within:opacity-100 group-hover/message:opacity-100 max-md:opacity-100",
  messageAction: "grid size-7 cursor-pointer place-items-center rounded-md bg-transparent text-neutral-500 hover:bg-surface-muted hover:text-neutral-900 [&_svg]:size-[15px]",
  referencesPanel: "mt-3 w-full border-t border-neutral-200 text-neutral-500",
  referencesSummary: "flex min-h-9 cursor-pointer list-none select-none items-center gap-[7px] text-xs font-semibold",
  referenceList: "mb-2.5 list-none",
  referenceItem: "border-t border-neutral-200 py-2 data-[highlighted=true]:bg-green-50",
  referenceHeading: "text-xs font-semibold text-neutral-900",
  referenceExcerpt: "mt-[3px] line-clamp-3 overflow-hidden text-xs leading-[1.45] text-neutral-500",
  referenceImageLink: "mt-2 inline-block text-xs text-blue-600 underline underline-offset-2",
  citationLink: "mx-px inline cursor-pointer rounded-[3px] bg-transparent px-0.5 align-super text-[0.78em] font-semibold text-blue-600 hover:bg-blue-50 focus-visible:bg-blue-50",
  insightEmpty: "px-4 py-12 text-center text-[13px] text-neutral-500",
  insightPathStep: "relative grid min-h-[86px] grid-cols-[28px_minmax(0,1fr)] gap-3.5 after:absolute after:bottom-0 after:left-[13px] after:top-6 after:w-0.5 after:bg-neutral-200 after:content-[''] last:after:hidden max-md:min-h-[82px]",
  insightPathMarker: {
    pending: "relative z-[1] size-7 rounded-full border-2 border-neutral-300 bg-white",
    completed: "relative z-[1] size-7 rounded-full border-2 border-neutral-900 bg-neutral-900",
    running: "relative z-[1] size-7 rounded-full border-2 border-neutral-900 bg-neutral-900 shadow-[inset_0_0_0_6px_#fff]",
    degraded: "relative z-[1] size-7 rounded-full border-2 border-neutral-500 bg-surface-muted",
    failed: "relative z-[1] size-7 rounded-full border-2 border-red-600 bg-red-100",
    cancelled: "relative z-[1] size-7 rounded-full border-2 border-red-600 bg-red-100",
  },
  insightPathLabel: "mt-0.5 block text-sm font-semibold",
  insightPathDetail: "mt-1 block text-[13px] leading-[1.45] text-neutral-500",
  ragasMetricHeading: "mb-[9px] flex items-center justify-between gap-4 text-[13px]",
  ragasMetricValue: "flex-none text-[13px] font-semibold",
  ragasTrack: "h-2 w-full overflow-hidden rounded bg-surface-hover",
  ragasMeta: "mt-[3px] border-t border-neutral-200 pt-1 text-xs text-neutral-500",
  attachmentChip: "flex min-w-0 max-w-60 flex-none items-center gap-[7px] rounded-[7px] border border-neutral-200 bg-white py-1.5 pl-2.5 pr-[7px] text-xs [&>span]:overflow-hidden [&>span]:text-ellipsis [&>span]:whitespace-nowrap",
  attachmentRemove: "grid size-[22px] flex-none cursor-pointer place-items-center rounded-[5px] bg-transparent text-neutral-500 hover:bg-surface-muted hover:text-neutral-900 [&_svg]:size-[13px]",
  channelRow: "rounded-md border border-neutral-200 p-2.5",
  channelHeader: "mb-1 flex items-center justify-between gap-2",
  channelName: "text-[12px] font-semibold text-neutral-900",
  channelStatus: "text-[10px] font-semibold uppercase",
  channelMeta: "text-[11px] text-neutral-500",
  channelError: "mt-1 text-[11px] text-red-600",
}

const elements = {
  appShell: document.getElementById("app-shell"),
  sidebar: document.getElementById("sidebar"),
  sidebarBackdrop: document.getElementById("sidebar-backdrop"),
  sidebarToggle: document.getElementById("sidebar-toggle"),
  newThreadButton: document.getElementById("new-thread-btn"),
  threadList: document.getElementById("thread-list"),
  threadHeading: document.getElementById("thread-heading"),
  threadBody: document.getElementById("thread-body"),
  chat: document.getElementById("chat"),
  emptyState: document.getElementById("empty-state"),
  form: document.getElementById("input-form"),
  input: document.getElementById("message-input"),
  sendButton: document.getElementById("send-btn"),
  shareButton: document.getElementById("share-btn"),
  suggestions: document.getElementById("suggestions"),
  attachmentButton: document.getElementById("attachment-btn"),
  attachmentInput: document.getElementById("attachment-input"),
  attachmentList: document.getElementById("attachment-list"),
  statusTrigger: document.getElementById("status-trigger"),
  statusPopover: document.getElementById("status-popover"),
  statusRefresh: document.getElementById("status-refresh"),
  statusCheckedAt: document.getElementById("status-checked-at"),
  statusChannels: document.getElementById("status-channels"),
  statusSummary: document.getElementById("connection-summary"),
  connectionDot: document.getElementById("connection-dot"),
  connectionLabel: document.getElementById("connection-label"),
  insightOpen: document.getElementById("insight-open"),
  insightDialog: document.getElementById("insight-dialog"),
  insightClose: document.getElementById("insight-close"),
  insightTabs: document.getElementById("insight-tabs"),
  insightPathPanel: document.getElementById("insight-path-panel"),
  insightPathChain: document.getElementById("insight-path-chain"),
  insightEvaluationPanel: document.getElementById("insight-evaluation-panel"),
  ragasRefresh: document.getElementById("ragas-refresh"),
  ragasContent: document.getElementById("ragas-content"),
  traceToggle: document.getElementById("trace-toggle"),
  tracePanel: document.getElementById("trace-panel"),
  traceClose: document.getElementById("trace-close"),
  traceEmpty: document.getElementById("trace-empty"),
  traceChain: document.getElementById("trace-chain"),
  importOpen: document.getElementById("import-open"),
  importDialog: document.getElementById("import-dialog"),
  importClose: document.getElementById("import-close"),
  importTabs: document.getElementById("import-tabs"),
  importFolderTab: document.getElementById("import-folder-tab"),
  importUrlTab: document.getElementById("import-url-tab"),
  importFolderPanel: document.getElementById("import-folder-panel"),
  importUrlPanel: document.getElementById("import-url-panel"),
  importFolderInput: document.getElementById("import-folder-input"),
  importItemsList: document.getElementById("import-items-list"),
  importUrlContent: document.getElementById("import-url-content"),
  toast: document.getElementById("toast"),
}

// T57: thread state and persistence are owned by Conversation. UI-only
// state (attachments, sidebar, abortController) stays here.
// T58: run race state (running flag) also moved to Conversation; app.js
// only keeps the AbortController for fetch cancellation.
const conversation = new ConversationImpl({
  storage: new LocalStorageConversationStorage(),
})

const state = {
  attachments: [],
  attachmentGeneration: 0,
  abortController: null,
  insightMessageId: null,
  toastTimer: null,
  // Tracks which message ids have already been mounted to the DOM at
  // least once. Drives whether a render plays an entrance animation
  // (first mount) or updates in place (subsequent stream chunks).
  mountedMessageIds: new Set(),
  // Flip animation for the composer on the empty→messages transition.
  composerFlip: null,
  reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)"),
  // Live connection status state.
  statusPayload: null,
  statusError: null,
  statusPopoverOpen: false,
  statusRefreshTimer: null,
  traceOpen: false,
  traceMessageId: null,
  // 导入中心状态
  importTab: "folder", // "folder" | "url"
  importQueue: [], // [{ id, fileName, size, status, docId, error }]
  importRunning: false,
  importPollTimer: null,
  importUrlMode: "single", // "single" | "sitemap" — Phase 3 用
}

const IMPORT_FILE_EXTENSIONS = new Set([
  ".pdf", ".doc", ".docx", ".md", ".txt", ".html", ".htm",
  ".xls", ".xlsx", ".ppt", ".pptx",
])
const IMPORT_CONCURRENCY = 3
const IMPORT_POLL_MS = 1500
const IMPORT_MAX_FILES_HINT = 500

renderApp()
bindEvents()
restoreTraceHistories()
fetchStatus()

function createId(prefix) {
  const randomId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}-${randomId}`
}

function renderApp() {
  elements.appShell.dataset.sidebarCollapsed = String(conversation.getSidebarCollapsed?.() ?? false)
  elements.sidebarToggle.setAttribute("aria-label", (conversation.getSidebarCollapsed?.() ?? false) ? "展开侧栏" : "收起侧栏")
  elements.sidebarToggle.title = (conversation.getSidebarCollapsed?.() ?? false) ? "展开侧栏" : "收起侧栏"
  renderThreadList()
  renderActiveThread()
  renderAttachments()
  updateComposerState()
  syncSidebarAccessibility()
}

function renderThreadList() {
  elements.threadList.replaceChildren()
  const activeThread = conversation.getActiveThread()
  const visibleThreads = conversation
    .listThreads()
    .filter((thread) => thread.messages.length > 0)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))

  if (visibleThreads.length === 0) {
    const empty = document.createElement("p")
    empty.className = UI_CLASSES.threadListEmpty
    empty.textContent = "暂无历史对话"
    elements.threadList.appendChild(empty)
    return
  }

  for (const thread of visibleThreads) {
    const item = document.createElement("div")
    item.className = thread.id === activeThread?.id ? UI_CLASSES.threadItemActive : UI_CLASSES.threadItem

    const selectButton = document.createElement("button")
    selectButton.type = "button"
    selectButton.className = UI_CLASSES.threadSelect
    selectButton.dataset.threadId = thread.id
    selectButton.textContent = thread.title
    selectButton.title = thread.title
    selectButton.setAttribute("aria-current", thread.id === activeThread?.id ? "page" : "false")

    const deleteButton = document.createElement("button")
    deleteButton.type = "button"
    deleteButton.className = UI_CLASSES.threadDelete
    deleteButton.dataset.deleteThreadId = thread.id
    deleteButton.setAttribute("aria-label", `删除对话：${thread.title}`)
    deleteButton.title = "删除对话"
    deleteButton.appendChild(createIcon("icon-trash"))

    item.append(selectButton, deleteButton)
    elements.threadList.appendChild(item)
  }
}

function renderActiveThread() {
  const thread = conversation.getActiveThread()
  if (!thread) return

  elements.threadHeading.textContent = thread.title
  elements.threadBody.dataset.hasMessages = String(thread.messages.length > 0)
  elements.chat.querySelectorAll("[data-message-id]").forEach((message) => message.remove())

  for (const message of thread.messages) {
    // History renders never play entrance animations — they're already
    // "there" from the user's perspective. Mark them mounted up front.
    state.mountedMessageIds.add(message.id)
    const el = createMessageElement(message, thread)
    el.classList.remove("animate-message-in", "animate-message-send")
    elements.chat.appendChild(el)
  }

  if (elements.insightDialog.open) renderInsightPath(findInsightMessage())
  // 切换对话时清理追踪面板的绑定，避免显示旧对话的步骤
  if (state.traceOpen) {
    state.traceMessageId = null
    renderTracePanel(null)
  }

  scrollToBottom(false)
}

function createMessageElement(message, thread) {
  const article = document.createElement("article")
  const isFirstMount = !state.mountedMessageIds.has(message.id)
  let entranceClass = ""
  if (isFirstMount) {
    if (message.role === "user") entranceClass = "animate-message-send"
    else if (message.status !== "running") entranceClass = "animate-message-in"
    // Assistant "running" placeholders get no entrance: the thinking
    // dots themselves are the feedback, and sliding them in reads as
    // a jarring re-mount on every stream chunk.
  }
  const baseClass = message.role === "user" ? UI_CLASSES.messageUser : UI_CLASSES.messageAssistant
  article.className = entranceClass
    ? [baseClass, entranceClass].join(" ")
    : baseClass
  article.dataset.messageId = message.id
  article.dataset.messageRole = message.role

  const content = document.createElement("div")
  content.className = message.role === "user" ? UI_CLASSES.messageContentUser : UI_CLASSES.messageContentAssistant
  content.classList.toggle("text-red-600", message.status === "error")
  content.dataset.content = ""

  if (message.role === "assistant" && message.status === "running" && !message.content) {
    const thinking = document.createElement("div")
    thinking.className = UI_CLASSES.thinking
    thinking.setAttribute("aria-label", "正在生成回答")
    for (let index = 0; index < 3; index += 1) {
      const dot = document.createElement("span")
      dot.className = UI_CLASSES.thinkingDot
      if (index === 1) dot.classList.add("[animation-delay:130ms]")
      if (index === 2) dot.classList.add("[animation-delay:260ms]")
      thinking.appendChild(dot)
    }
    content.appendChild(thinking)
  } else if (message.role === "assistant") {
    renderAnswerContent(content, message)
  } else {
    content.textContent = message.content
  }

  article.appendChild(content)

  if (message.role === "assistant" && message.references?.length) {
    article.appendChild(createReferencesElement(message))
  }

  if (message.role === "assistant" && message.status !== "running" && message.content) {
    const actions = document.createElement("div")
    actions.className = UI_CLASSES.messageActions

    const copyButton = createMessageAction("复制回答", "copy", message.id, "icon-copy")
    actions.appendChild(copyButton)

    if (message.traceEvents?.length) {
      actions.appendChild(createMessageAction("查看回答路径", "insight", message.id, "icon-chart"))
    }

    const isLastAssistant = thread.messages.findLast?.((item) => item.role === "assistant")?.id === message.id
      || [...thread.messages].reverse().find((item) => item.role === "assistant")?.id === message.id
    if (isLastAssistant) {
      actions.appendChild(createMessageAction("重新生成", "regenerate", message.id, "icon-refresh"))
    }

    article.appendChild(actions)
  }

  return article
}

function createReferencesElement(message) {
  const { references } = message
  const details = document.createElement("details")
  details.className = UI_CLASSES.referencesPanel
  details.dataset.referencesFor = message.id
  const summary = document.createElement("summary")
  summary.className = UI_CLASSES.referencesSummary
  summary.textContent = `参考来源 ${references.length}`
  const list = document.createElement("ol")
  list.className = UI_CLASSES.referenceList

  references.forEach((reference) => {
    const item = document.createElement("li")
    item.className = UI_CLASSES.referenceItem
    item.dataset.highlighted = "false"
    item.dataset.referenceItem = reference.id
    const heading = document.createElement("div")
    heading.className = UI_CLASSES.referenceHeading
    const location = formatReferenceLocation(reference)
    heading.textContent = [
      reference.title || reference.source || "未命名来源",
      location,
    ].filter(Boolean).join(" · ")
    const excerpt = document.createElement("p")
    excerpt.className = UI_CLASSES.referenceExcerpt
    excerpt.textContent = reference.excerpt || ""
    item.append(heading, excerpt)
    const url = assetUrl(reference, API_BASE)
    if (url) {
      const imageLink = document.createElement("a")
      imageLink.className = UI_CLASSES.referenceImageLink
      imageLink.href = url
      imageLink.target = "_blank"
      imageLink.rel = "noopener noreferrer"
      imageLink.textContent = reference.image?.captions?.[0] || "查看图片证据"
      item.appendChild(imageLink)
    }
    list.appendChild(item)
  })

  details.append(summary, list)
  return details
}

function renderAnswerContent(container, message) {
  const references = new Map((message.references || []).map((reference, index) => [
    reference.id,
    { reference, index },
  ]))
  const pattern = /\[cite:([^\]]+)\]/g
  let cursor = 0
  for (const match of message.content.matchAll(pattern)) {
    if (match.index > cursor) {
      container.appendChild(document.createTextNode(message.content.slice(cursor, match.index)))
    }
    const found = references.get(match[1])
    if (found) {
      const button = document.createElement("button")
      button.type = "button"
      button.className = UI_CLASSES.citationLink
      button.dataset.referenceId = found.reference.id
      button.dataset.messageId = message.id
      button.textContent = `[${found.index + 1}]`
      button.setAttribute("aria-label", `查看参考来源 ${found.index + 1}`)
      button.title = found.reference.title || found.reference.source || "查看参考来源"
      container.appendChild(button)
    } else {
      container.appendChild(document.createTextNode(match[0]))
    }
    cursor = match.index + match[0].length
  }
  if (cursor < message.content.length) {
    container.appendChild(document.createTextNode(message.content.slice(cursor)))
  }
}

// T58: SSE stream merge, trace merge, run-history restore, and status
// policy are now owned by Conversation (processSseEvent, applyRunHistory,
// applyCompleteReply, finalizeStreamRun, finalizeAbortedRun,
// finalizeConnectionError). app.js only keeps transport (fetch + SSE
// line parsing) and DOM rendering concerns.
function traceEventLabel(event) {
  const data = event.data || {}
  if (event.stage === "route") {
    if (data.decision === "complex") return "识别为复杂问题"
    if (data.decision === "ambiguous") return "需要补充问题信息"
    return "识别为直接问答"
  }
  if (event.stage === "retrieval") {
    const prefix = data.correction ? "补充检索" : "检索知识库"
    const count = Number.isInteger(data.resultCount) ? ` · ${data.resultCount} 条结果` : ""
    const degraded = Array.isArray(data.degradedReasons) && data.degradedReasons.length
      ? ` · ${data.degradedReasons.length} 个通道降级`
      : ""
    return `${prefix}${count}${degraded}`
  }
  if (event.stage === "context") return `整理 ${data.evidenceCount || 0} 条证据`
  if (event.stage === "validation") return data.passed ? "证据校验通过" : "检查证据缺口"
  if (event.stage === "done") return traceStatusLabel(event.result?.status)
  return "处理回答"
}

function traceStatusLabel(status) {
  const labels = {
    completed: "已完成",
    clarification_required: "等待补充",
    insufficient_retrieval: "检索不足",
    insufficient_evidence: "证据不足",
    invalid_citation: "引用无效",
    provider_error: "运行失败",
    cancelled: "已取消",
  }
  return labels[status] || "已记录"
}

function findInsightMessage(messageId = state.insightMessageId) {
  const thread = conversation.getActiveThread()
  if (!thread) return null
  const selected = thread.messages.find((message) => message.id === messageId && message.role === "assistant")
  if (selected) return selected
  return [...thread.messages].reverse().find((message) => message.role === "assistant" && message.traceEvents?.length)
    || [...thread.messages].reverse().find((message) => message.role === "assistant")
    || null
}

function openInsight(messageId) {
  const message = findInsightMessage(messageId)
  state.insightMessageId = message?.id || null
  setInsightTab("path")
  renderInsightPath(message)
  if (!elements.insightDialog.open) elements.insightDialog.showModal()
}

function setInsightTab(tab) {
  const showPath = tab === "path"
  elements.insightTabs.querySelectorAll("[data-insight-tab]").forEach((button) => {
    const active = button.dataset.insightTab === tab
    button.dataset.active = String(active)
    button.setAttribute("aria-selected", String(active))
  })
  elements.insightPathPanel.hidden = !showPath
  elements.insightEvaluationPanel.hidden = showPath
  if (!showPath) loadRagasEvaluation()
}

function renderInsightPath(message) {
  elements.insightPathChain.replaceChildren()
  if (!message?.traceEvents?.length) {
    const empty = document.createElement("li")
    empty.className = UI_CLASSES.insightEmpty
    empty.textContent = "当前还没有可查看的回答路径"
    elements.insightPathChain.appendChild(empty)
    return
  }

  const events = projectTraceEvents(message.traceEvents)
  for (const step of INSIGHT_PATH_STEPS) {
    const event = [...events].reverse().find((item) => item.stage === step.stage)
    const item = document.createElement("li")
    item.className = UI_CLASSES.insightPathStep
    const marker = document.createElement("span")
    marker.className = UI_CLASSES.insightPathMarker[event?.status] || UI_CLASSES.insightPathMarker.pending
    marker.setAttribute("aria-hidden", "true")
    const content = document.createElement("div")
    const label = document.createElement("strong")
    label.className = UI_CLASSES.insightPathLabel
    label.textContent = step.label
    const detail = document.createElement("span")
    detail.className = UI_CLASSES.insightPathDetail
    detail.textContent = event ? traceEventLabel(event) : "等待处理"
    content.append(label, detail)
    item.append(marker, content)
    elements.insightPathChain.appendChild(item)
  }
}

// === 实时回答追踪面板 ===
// 与 insight-dialog 的回答路径共享 INSIGHT_PATH_STEPS 与 projectTraceEvents，
// 但状态由当前运行中的 assistantMessage 实时驱动。打开面板时若已有消息，
// 默认绑定最后一条 assistant 消息；新提问时自动切到新的 assistantMessage。
function openTracePanel(messageId) {
  state.traceOpen = true
  elements.tracePanel.dataset.open = "true"
  elements.traceToggle.dataset.active = "true"
  elements.traceToggle.setAttribute("aria-pressed", "true")
  const message = findTraceMessage(messageId)
  state.traceMessageId = message?.id || null
  renderTracePanel(message)
}

function closeTracePanel() {
  state.traceOpen = false
  elements.tracePanel.dataset.open = "false"
  elements.traceToggle.dataset.active = "false"
  elements.traceToggle.setAttribute("aria-pressed", "false")
}

function toggleTracePanel() {
  if (state.traceOpen) closeTracePanel()
  else openTracePanel()
}

function findTraceMessage(messageId = state.traceMessageId) {
  const thread = conversation.getActiveThread()
  if (!thread) return null
  const selected = thread.messages.find((m) => m.id === messageId && m.role === "assistant")
  if (selected) return selected
  // 默认绑定最后一条 assistant 消息（含 running 状态）
  return [...thread.messages].reverse().find((m) => m.role === "assistant") || null
}

function renderTracePanel(message) {
  if (!state.traceOpen) return
  elements.traceChain.replaceChildren()
  if (!message?.traceEvents?.length) {
    elements.traceEmpty.classList.remove("hidden")
    elements.traceChain.classList.add("hidden")
    elements.traceEmpty.textContent = message?.status === "running"
      ? "正在准备回答步骤…"
      : "发起提问后将实时展示回答步骤"
    return
  }
  elements.traceEmpty.classList.add("hidden")
  elements.traceChain.classList.remove("hidden")

  const events = projectTraceEvents(message.traceEvents)
  for (const step of INSIGHT_PATH_STEPS) {
    const event = [...events].reverse().find((item) => item.stage === step.stage)
    const item = document.createElement("li")
    item.className = "relative grid min-h-[68px] grid-cols-[22px_minmax(0,1fr)] gap-2.5 after:absolute after:bottom-0 after:left-[10px] after:top-5 after:w-0.5 after:bg-neutral-200 after:content-[''] last:after:hidden"
    const marker = document.createElement("span")
    marker.className = UI_CLASSES.insightPathMarker[event?.status] || UI_CLASSES.insightPathMarker.pending
    marker.setAttribute("aria-hidden", "true")
    const content = document.createElement("div")
    const label = document.createElement("strong")
    label.className = "mt-0.5 block text-[13px] font-semibold"
    label.textContent = step.label
    const detail = document.createElement("span")
    detail.className = "mt-0.5 block text-[11px] leading-[1.45] text-neutral-500"
    detail.textContent = event ? traceEventLabel(event) : "等待处理"
    content.append(label, detail)
    item.append(marker, content)
    elements.traceChain.appendChild(item)
  }
}

async function loadRagasEvaluation() {
  elements.ragasRefresh.disabled = true
  elements.ragasContent.replaceChildren(createRagasMessage("正在读取评估结果…"))
  try {
    const response = await fetch(`${API_BASE}/observability/ragas`)
    if (!response.ok) throw new Error(`RAGAS request failed (${response.status})`)
    renderRagasEvaluation(await response.json())
  } catch {
    elements.ragasContent.replaceChildren(createRagasMessage("评估结果暂时无法读取"))
  } finally {
    elements.ragasRefresh.disabled = false
  }
}

function renderRagasEvaluation(result) {
  elements.ragasContent.replaceChildren()
  if (!result?.available) {
    const message = result?.reason === "ragas_not_present"
      ? "当前评估文件中没有 RAGAS 结果"
      : "暂时没有评估结果"
    elements.ragasContent.appendChild(createRagasMessage(message))
    return
  }

  const animatedBars = []
  for (const metric of RAGAS_METRICS) {
    const score = result.aggregate?.[metric.key]
    if (!Number.isFinite(score)) continue
    const percent = Math.round(score * 100)
    const item = document.createElement("div")
    const heading = document.createElement("div")
    heading.className = UI_CLASSES.ragasMetricHeading
    const label = document.createElement("span")
    label.textContent = metric.label
    const value = document.createElement("strong")
    value.className = UI_CLASSES.ragasMetricValue
    value.textContent = state.reducedMotion.matches ? `${percent}%` : "0%"
    heading.append(label, value)
    const track = document.createElement("div")
    track.className = UI_CLASSES.ragasTrack
    track.setAttribute("role", "progressbar")
    track.setAttribute("aria-label", metric.label)
    track.setAttribute("aria-valuemin", "0")
    track.setAttribute("aria-valuemax", "100")
    track.setAttribute("aria-valuenow", String(percent))
    const bar = document.createElement("span")
    bar.className = "ragas-bar-fill"
    track.appendChild(bar)
    item.append(heading, track)
    elements.ragasContent.appendChild(item)
    animatedBars.push({ bar, value, percent })
  }

  // Kick the bars to their targets on the next frame so the CSS
  // transition runs; count the numbers up alongside.
  if (!state.reducedMotion.matches) {
    requestAnimationFrame(() => {
      for (const { bar, percent } of animatedBars) {
        bar.style.width = `${percent}%`
      }
      const start = performance.now()
      const duration = 650
      const tick = (now) => {
        const t = Math.min(1, (now - start) / duration)
        const eased = 1 - Math.pow(1 - t, 3)
        for (const { value, percent } of animatedBars) {
          value.textContent = `${Math.round(percent * eased)}%`
        }
        if (t < 1) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  } else {
    for (const { bar, percent } of animatedBars) {
      bar.style.width = `${percent}%`
    }
  }

  const sampleSize = result.aggregate?.sampleSize
  if (Number.isInteger(sampleSize)) {
    const meta = document.createElement("p")
    meta.className = UI_CLASSES.ragasMeta
    meta.textContent = `评估样本：${sampleSize} 条`
    elements.ragasContent.appendChild(meta)
  }
}

function createRagasMessage(text) {
  const message = document.createElement("p")
  message.className = UI_CLASSES.insightEmpty
  message.textContent = text
  return message
}

function createMessageAction(label, action, messageId, iconId) {
  const button = document.createElement("button")
  button.type = "button"
  button.className = UI_CLASSES.messageAction
  button.dataset.action = action
  button.dataset.messageId = messageId
  button.setAttribute("aria-label", label)
  button.title = label
  button.appendChild(createIcon(iconId))
  return button
}

function createIcon(iconId) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.setAttribute("aria-hidden", "true")
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use")
  use.setAttribute("href", `#${iconId}`)
  svg.appendChild(use)
  return svg
}

function addMessage(thread, role, content, extra = {}) {
  const message = {
    id: createId("message"),
    role,
    content,
    status: extra.status || "complete",
    createdAt: new Date().toISOString(),
  }
  if (extra.prompt) message.prompt = extra.prompt

  thread.messages.push(message)
  thread.updatedAt = message.createdAt
  // Persist immediately so a refresh doesn't lose the new message.
  conversation.save()
  return message
}

function replaceMessageElement(message, thread) {
  if (thread.id !== conversation.getActiveThread()?.id) return
  const current = elements.chat.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`)
  const isFirstMount = !state.mountedMessageIds.has(message.id)

  if (!current || isFirstMount) {
    // First mount: insert fresh and play the entrance animation.
    const next = createMessageElement(message, thread)
    if (current) current.replaceWith(next)
    else elements.chat.appendChild(next)
    state.mountedMessageIds.add(message.id)
    if (elements.insightDialog.open && state.insightMessageId === message.id) renderInsightPath(message)
    // 新的 assistant 消息一挂载就自动绑定为追踪目标
    if (message.role === "assistant" && state.traceOpen) {
      state.traceMessageId = message.id
      renderTracePanel(message)
    }
    scrollToBottom(true)
    return
  }

  // Subsequent renders of an already-mounted message (typical during
  // streaming): update in place so no entrance animation replays.
  updateMessageInPlace(current, message, thread)
  if (elements.insightDialog.open && state.insightMessageId === message.id) renderInsightPath(message)
  // SSE 流式更新时实时刷新追踪面板
  if (state.traceOpen && state.traceMessageId === message.id) renderTracePanel(message)
  scrollToBottom(true)
}

// Swap only the inner content of an existing article node. When the
// previous frame showed thinking dots and the new one has real answer
// text, hand off with a brief fade so the transition reads as one
// continuous moment instead of a hard cut.
function updateMessageInPlace(article, message, thread) {
  const wasThinking = Boolean(article.querySelector(`.${UI_CLASSES.thinking.split(" ")[0]}`))
  const nowHasAnswer = message.role === "assistant" && Boolean(message.content)

  const commit = () => {
    const fresh = createMessageElement(message, thread)
    // Strip any entrance animation — this node is already on screen.
    fresh.classList.remove("animate-message-in", "animate-message-send")
    article.replaceChildren(...fresh.childNodes)
  }

  if (wasThinking && nowHasAnswer && !state.reducedMotion.matches) {
    const thinking = article.querySelector(`.${UI_CLASSES.thinking.split(" ")[0]}`)
    thinking?.classList.add("thinking-leaving")
    const content = article.querySelector("[data-content]")
    window.setTimeout(() => {
      commit()
      const answer = article.querySelector("[data-content]")
      answer?.classList.add("answer-entering")
    }, 140)
    return
  }

  commit()
}

function updateThreadTitle(thread, content) {
  if (thread.messages.filter((message) => message.role === "user").length !== 1) return
  const normalized = content.replace(/\s+/g, " ").trim()
  thread.title = normalized.length > 28 ? `${normalized.slice(0, 28)}…` : normalized || "新对话"
  elements.threadHeading.textContent = thread.title
}

function bindEvents() {
  elements.input.addEventListener("input", handleInput)
  elements.input.addEventListener("keydown", handleInputKeydown)
  elements.form.addEventListener("submit", handleSubmit)
  elements.newThreadButton.addEventListener("click", startNewThread)
  elements.sidebarToggle.addEventListener("click", toggleSidebar)
  elements.sidebarBackdrop.addEventListener("click", () => closeMobileSidebar(true))
  elements.threadList.addEventListener("click", handleThreadListClick)
  elements.suggestions.addEventListener("click", handleSuggestionClick)
  elements.attachmentButton.addEventListener("click", () => elements.attachmentInput.click())
  elements.attachmentInput.addEventListener("change", handleAttachments)
  elements.attachmentList.addEventListener("click", handleAttachmentRemoval)
  elements.statusTrigger.addEventListener("click", toggleStatusPopover)
  elements.statusRefresh.addEventListener("click", () => {
    fetchStatus()
  })
  elements.insightOpen.addEventListener("click", () => openInsight())
  elements.insightClose.addEventListener("click", () => elements.insightDialog.close())
  elements.insightTabs.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-insight-tab]")
    if (tab) setInsightTab(tab.dataset.insightTab)
  })
  elements.traceToggle.addEventListener("click", toggleTracePanel)
  elements.traceClose.addEventListener("click", closeTracePanel)
  elements.ragasRefresh.addEventListener("click", loadRagasEvaluation)
  // 导入中心事件
  elements.importOpen.addEventListener("click", openImportDialog)
  elements.importClose.addEventListener("click", () => elements.importDialog.close())
  elements.importTabs.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-import-tab]")
    if (tab) setImportTab(tab.dataset.importTab)
  })
  elements.importFolderInput.addEventListener("change", handleFolderSelect)
  elements.importDialog.addEventListener("click", (event) => {
    if (event.target === elements.importDialog) elements.importDialog.close()
  })
  elements.insightDialog.addEventListener("click", (event) => {
    if (event.target === elements.insightDialog) elements.insightDialog.close()
  })
  elements.shareButton.addEventListener("click", shareCurrentThread)
  elements.chat.addEventListener("click", handleMessageAction)
  document.addEventListener("click", handleDocumentClick)
  document.addEventListener("keydown", handleGlobalKeydown)
  window.addEventListener("resize", handleResize)
  if (state.statusRefreshTimer) clearInterval(state.statusRefreshTimer)
  state.statusRefreshTimer = setInterval(fetchStatus, STATUS_REFRESH_MS)
}

function handleInput() {
  resizeTextarea()
  updateComposerState()
}

function resizeTextarea() {
  elements.input.style.height = "auto"
  elements.input.style.height = `${Math.min(elements.input.scrollHeight, 180)}px`
}

function handleInputKeydown(event) {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    elements.form.requestSubmit()
  }
}

async function handleSubmit(event) {
  event.preventDefault()
  if (conversation.isRunning()) {
    cancelRun()
    return
  }

  const text = elements.input.value.trim()
  if (!text && state.attachments.length === 0) return
  await submitPrompt(text)
}

async function submitPrompt(displayText, options = {}) {
  if (conversation.isRunning()) return

  const thread = conversation.getActiveThread()
  if (!thread) return

  const attachmentContext = state.attachments
    .map((file) => `\n\n[附件：${file.name}]\n${file.content}`)
    .join("")
  const prompt = options.prompt || `${displayText}${attachmentContext}`.trim()

  if (options.addUser !== false) {
    const visibleText = displayText || state.attachments.map((file) => `附件：${file.name}`).join("、")
    addMessage(thread, "user", visibleText, { prompt })
    updateThreadTitle(thread, visibleText)
  }

  state.attachments = []
  state.attachmentGeneration += 1
  elements.attachmentInput.value = ""
  elements.input.value = ""
  elements.input.style.height = "auto"
  const assistantMessage = addMessage(thread, "assistant", "", { status: "running" })
  assistantMessage.runId = createId("run")

  // FLIP: capture the composer's current (centered) position before
  // the layout flips it to the bottom of the thread.
  const wasEmpty = elements.threadBody.dataset.hasMessages === "false"
  const composerRectBefore = wasEmpty && !state.reducedMotion.matches
    ? elements.form.getBoundingClientRect()
    : null

  elements.threadBody.dataset.hasMessages = "true"
  renderThreadList()
  renderAttachments()
  renderActiveThread()

  if (composerRectBefore) {
    const composerRectAfter = elements.form.getBoundingClientRect()
    const dy = composerRectBefore.top - composerRectAfter.top
    if (Math.abs(dy) > 1) {
      state.composerFlip?.cancel()
      state.composerFlip = elements.form.animate(
        [
          { transform: `translateY(${dy}px)` },
          { transform: "translateY(0)" },
        ],
        {
          duration: 280,
          easing: "cubic-bezier(0.23, 1, 0.32, 1)",
          fill: "both",
        },
      )
      state.composerFlip.finished.catch(() => {}).finally(() => {
        state.composerFlip = null
      })
    }
  }

  // T58: race state owned by Conversation. AbortController stays here
  // because it is a transport-layer handle for fetch cancellation.
  state.abortController = new AbortController()
  conversation.startRun()
  updateComposerState()

  try {
    // Streaming is the only answer mode now. The server's POST /api/chat
    // defaults `stream` to true, so we don't pass it explicitly here.
    await requestStreamingReply(prompt, thread, assistantMessage)
    markConnection(true)
  } catch (error) {
    if (error.name === "AbortError") {
      // T58: abort status policy owned by Conversation.
      conversation.finalizeAbortedRun(assistantMessage)
    } else if (error.handled) {
      markConnection(true)
    } else {
      // T58: network-error status policy owned by Conversation.
      conversation.finalizeConnectionError(assistantMessage)
      markConnection(false)
    }
    replaceMessageElement(assistantMessage, thread)
  } finally {
    conversation.completeRun()
    state.abortController = null
    if (assistantMessage.status === "running") conversation.finalizeRun(assistantMessage, "complete")
    thread.updatedAt = new Date().toISOString()
    // Persist the completed/aborted/errored message content and thread state.
    conversation.save()
    replaceMessageElement(assistantMessage, thread)
    renderThreadList()
    updateComposerState()
    elements.input.focus()
  }
}

async function requestStreamingReply(prompt, thread, assistantMessage) {
  const body = { message: prompt, runId: assistantMessage.runId }

  const response = await fetch(`${API_BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: state.abortController.signal,
  })

  if (!response.ok) throw new Error(`服务器错误 (${response.status})`)
  if (!response.body) throw new Error("浏览器不支持流式响应")

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let streamDone = false

  // T58: SSE line parsing stays here (transport concern); per-chunk merge
  // and done detection are delegated to Conversation.processSseEvent.
  const processLine = (rawLine) => {
    const line = rawLine.trimEnd()
    if (!line.startsWith("data:")) return
    const payload = line.slice(5).trim()
    if (!payload || payload === "[DONE]") {
      streamDone = payload === "[DONE]"
      return
    }

    try {
      const data = JSON.parse(payload)
      const result = conversation.processSseEvent(assistantMessage, data)
      if (result.done) streamDone = true
      replaceMessageElement(assistantMessage, thread)
    } catch {
      // Ignore non-JSON SSE keepalive lines.
    }
  }

  while (!streamDone) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() || ""
    lines.forEach(processLine)
    if (done) break
  }

  if (buffer.trim()) processLine(buffer)
  // T58: stream completion status policy owned by Conversation.
  conversation.finalizeStreamRun(assistantMessage)
}

// Retained so app.contract.test.ts's applyCompleteReply reference stays
// satisfied and so non-streaming clients keep a working code path. The
// composer no longer surfaces a toggle; streaming is the default mode.
async function requestCompleteReply(prompt, thread, assistantMessage) {
  const body = { message: prompt, stream: false, runId: assistantMessage.runId }

  const response = await fetch(`${API_BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: state.abortController.signal,
  })

  const data = await response.json()
  // T58: complete-reply merge and status policy owned by Conversation.
  const result = conversation.applyCompleteReply(assistantMessage, data, response.ok)
  replaceMessageElement(assistantMessage, thread)
  if (!result.ok) {
    const error = new Error(`服务器错误 (${response.status})`)
    error.handled = true
    throw error
  }
}

async function restoreTraceHistories() {
  const runs = []
  for (const thread of conversation.listThreads()) {
    for (const message of thread.messages) {
      if (message.role === "assistant" && message.runId) runs.push({ thread, message })
    }
  }

  await Promise.all(runs.map(async ({ thread, message }) => {
    try {
      const response = await fetch(`${API_BASE}/chat/runs/${encodeURIComponent(message.runId)}`)
      if (!response.ok) return
      const history = await response.json()
      // T58: run-history restore owned by Conversation.
      conversation.applyRunHistory(message, history)
      replaceMessageElement(message, thread)
    } catch {
      // Keep the last locally persisted projection when history is unavailable.
    }
  }))
}

function cancelRun() {
  // T58: race state is owned by Conversation; the abort signal travels
  // through fetch and the finally block in submitPrompt calls completeRun.
  state.abortController?.abort()
}

function updateComposerState() {
  const hasContent = elements.input.value.trim().length > 0 || state.attachments.length > 0
  const running = conversation.isRunning()
  elements.sendButton.disabled = !running && !hasContent
  elements.sendButton.dataset.running = String(running)
  elements.sendButton.setAttribute("aria-label", running ? "停止生成" : "发送消息")
  elements.sendButton.title = running ? "停止生成" : "发送消息"
}

function startNewThread() {
  if (conversation.isRunning()) cancelRun()
  const current = conversation.getActiveThread()
  if (current?.messages.length === 0) {
    elements.input.focus()
    closeMobileSidebar()
    return
  }

  conversation.createThread()
  state.attachments = []
  state.attachmentGeneration += 1
  renderApp()
  closeMobileSidebar()
  elements.input.focus()
}

function handleThreadListClick(event) {
  const deleteButton = event.target.closest("[data-delete-thread-id]")
  if (deleteButton) {
    deleteThread(deleteButton.dataset.deleteThreadId)
    return
  }

  const selectButton = event.target.closest("[data-thread-id]")
  const activeThreadId = conversation.getActiveThread()?.id
  if (!selectButton || selectButton.dataset.threadId === activeThreadId) {
    closeMobileSidebar()
    return
  }

  if (conversation.isRunning()) cancelRun()
  conversation.setActiveThread(selectButton.dataset.threadId)
  state.attachments = []
  state.attachmentGeneration += 1
  renderApp()
  closeMobileSidebar()
}

function deleteThread(threadId) {
  const thread = conversation.listThreads().find((item) => item.id === threadId)
  if (!thread) return
  if (!window.confirm(`删除“${thread.title}”？此操作无法撤销。`)) return

  if (conversation.isRunning() && threadId === conversation.getActiveThread()?.id) cancelRun()

  const commit = () => {
    conversation.deleteThread(threadId)
    state.attachments = []
    state.attachmentGeneration += 1
    renderApp()
    showToast("对话已删除")
  }

  // Animate the row collapsing before mutating state so the removal
  // reads as cause-and-effect instead of a sudden disappearance.
  const row = elements.threadList
    .querySelector(`[data-thread-id="${CSS.escape(threadId)}"]`)
    ?.closest(".group\\/thread")
  if (row && !state.reducedMotion.matches) {
    row.style.height = `${row.offsetHeight}px`
    // Force reflow so the explicit height is the transition's start.
    void row.offsetHeight
    row.classList.add("thread-leaving")
    window.setTimeout(commit, 190)
    return
  }

  commit()
}

function toggleSidebar() {
  if (window.matchMedia("(max-width: 767px)").matches) {
    const isOpen = elements.appShell.dataset.sidebarOpen !== "true"
    elements.appShell.dataset.sidebarOpen = String(isOpen)
    elements.sidebarToggle.setAttribute("aria-expanded", String(isOpen))
    syncSidebarAccessibility()
    if (isOpen) requestAnimationFrame(() => elements.newThreadButton.focus())
    return
  }

  const next = !(conversation.getSidebarCollapsed?.() ?? false)
  if (conversation.setSidebarCollapsed) conversation.setSidebarCollapsed(next)
  elements.appShell.dataset.sidebarCollapsed = String(next)
  elements.sidebarToggle.setAttribute("aria-label", next ? "展开侧栏" : "收起侧栏")
  elements.sidebarToggle.title = next ? "展开侧栏" : "收起侧栏"
  syncSidebarAccessibility()
}

function closeMobileSidebar(restoreFocus = false) {
  const wasOpen = elements.appShell.dataset.sidebarOpen === "true"
  elements.appShell.dataset.sidebarOpen = "false"
  elements.sidebarToggle.setAttribute("aria-expanded", "false")
  syncSidebarAccessibility()
  if (restoreFocus && wasOpen) elements.sidebarToggle.focus()
}

function handleResize() {
  if (!window.matchMedia("(max-width: 767px)").matches) closeMobileSidebar()
  syncSidebarAccessibility()
}

function syncSidebarAccessibility() {
  const isMobile = window.matchMedia("(max-width: 767px)").matches
  const isVisible = isMobile
    ? elements.appShell.dataset.sidebarOpen === "true"
    : !(conversation.getSidebarCollapsed?.() ?? false)
  elements.sidebar.toggleAttribute("inert", !isVisible)
  elements.sidebar.setAttribute("aria-hidden", String(!isVisible))
}

function handleSuggestionClick(event) {
  const button = event.target.closest("[data-prompt]")
  if (!button) return
  elements.input.value = button.dataset.prompt
  resizeTextarea()
  updateComposerState()
  elements.input.focus()
  elements.input.setSelectionRange(elements.input.value.length, elements.input.value.length)
}

function toggleStatusPopover(event) {
  event.stopPropagation()
  if (elements.statusPopover.hidden) openStatusPopover()
  else closeStatusPopover()
}

function openStatusPopover() {
  elements.statusPopover.hidden = false
  elements.statusTrigger.setAttribute("aria-expanded", "true")
  state.statusPopoverOpen = true
  // Always refresh on open so the user sees the latest probe results.
  fetchStatus()
}

function closeStatusPopover() {
  if (elements.statusPopover.hidden) return
  elements.statusPopover.hidden = true
  elements.statusTrigger.setAttribute("aria-expanded", "false")
  state.statusPopoverOpen = false
}

async function fetchStatus() {
  try {
    const response = await fetch(`${API_BASE}/status`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    state.statusPayload = await response.json()
    state.statusError = null
  } catch (err) {
    state.statusPayload = null
    state.statusError = err instanceof Error ? err.message : String(err)
  }
  renderStatus()
}

function renderStatus() {
  const payload = state.statusPayload
  if (state.statusError && !payload) {
    elements.connectionDot.dataset.offline = "true"
    elements.connectionDot.dataset.degraded = "false"
    elements.connectionLabel.textContent = "服务连接异常"
    elements.statusSummary.textContent = "无法探测"
    elements.statusCheckedAt.textContent = "检查失败："
      + (state.statusError.length > 80 ? `${state.statusError.slice(0, 80)}…` : state.statusError)
    elements.statusChannels.replaceChildren()
    return
  }

  if (!payload) {
    elements.connectionDot.dataset.offline = "false"
    elements.connectionDot.dataset.degraded = "false"
    elements.connectionLabel.textContent = "知识库检测中…"
    elements.statusSummary.textContent = "检查中…"
    elements.statusCheckedAt.textContent = "正在连接…"
    elements.statusChannels.replaceChildren()
    return
  }

  const { elasticsearch, neo4j, openai } = payload.channels
  const hasContent = payload.hasKnowledgeBaseContent === true
  const allOk = elasticsearch.status === "connected" && neo4j.status === "connected" && openai.status !== "disconnected"
  const anyDown = [elasticsearch, neo4j].some((c) => c.status === "disconnected")

  // 主色：有内容绿，无内容红。连接异常叠加 degraded/amber 仅作辅助
  elements.connectionDot.dataset.offline = String(!hasContent)
  elements.connectionDot.dataset.degraded = String(hasContent && !allOk && !anyDown)
  if (!hasContent) {
    elements.connectionLabel.textContent = "知识库暂无内容"
  } else if (anyDown) {
    elements.connectionLabel.textContent = "知识库部分离线"
  } else if (!allOk) {
    elements.connectionLabel.textContent = "知识库降级运行"
  } else {
    elements.connectionLabel.textContent = "知识库已就绪"
  }
  const summary = []
  if (elasticsearch.status === "connected") summary.push(CHANNEL_LABELS.elasticsearch.short)
  if (neo4j.status === "connected") summary.push(CHANNEL_LABELS.neo4j.short)
  if (openai.status === "connected") summary.push(CHANNEL_LABELS.openai.short)
  elements.statusSummary.textContent = summary.length ? summary.join(" · ") : "降级运行"

  const checkedAt = new Date(payload.checkedAt)
  elements.statusCheckedAt.textContent = `检查时间：${checkedAt.toLocaleTimeString()}`

  elements.statusChannels.replaceChildren()
  const channelMap = { elasticsearch, neo4j, openai }
  for (const [key, channel] of Object.entries(channelMap)) {
    elements.statusChannels.appendChild(renderStatusChannel(key, channel, payload.config))
  }
}

function renderStatusChannel(key, channel, config) {
  const meta = CHANNEL_LABELS[key] || { name: key, short: key }
  const urlKey = key === "elasticsearch" ? "esNode" : key === "neo4j" ? "neo4jUri" : "openaiBaseUrl"
  const url = config?.[urlKey] || ""
  const status = STATUS_LABELS[channel.status] || { text: channel.status, dot: "gray" }
  const dotColor = status.dot === "green" ? "bg-green-500"
    : status.dot === "amber" ? "bg-amber-500"
    : status.dot === "red" ? "bg-red-500"
    : "bg-neutral-300"

  const row = document.createElement("div")
  row.className = UI_CLASSES.channelRow
  const header = document.createElement("div")
  header.className = UI_CLASSES.channelHeader
  const left = document.createElement("div")
  left.className = "flex items-center gap-2"
  const dot = document.createElement("span")
  dot.className = ["size-[6px]", "flex-none", "rounded-full", dotColor].join(" ")
  dot.setAttribute("aria-hidden", "true")
  const name = document.createElement("span")
  name.className = UI_CLASSES.channelName
  name.textContent = meta.name
  left.append(dot, name)
  const right = document.createElement("span")
  right.className = UI_CLASSES.channelStatus
  right.textContent = status.text
  if (status.dot === "green") right.classList.add("text-green-700")
  else if (status.dot === "amber") right.classList.add("text-amber-700")
  else if (status.dot === "red") right.classList.add("text-red-600")
  else right.classList.add("text-neutral-400")
  header.append(left, right)
  row.appendChild(header)

  const metaLine = document.createElement("p")
  metaLine.className = UI_CLASSES.channelMeta
  const parts = []
  if (url) parts.push(url)
  if (typeof channel.responseTimeMs === "number") parts.push(`${channel.responseTimeMs} ms`)
  if (key === "openai" && config?.openaiChatModel) parts.push(`默认 ${config.openaiChatModel}`)
  metaLine.textContent = parts.join(" · ") || "—"
  row.appendChild(metaLine)

  if (channel.error) {
    const error = document.createElement("p")
    error.className = UI_CLASSES.channelError
    error.textContent = channel.error.length > 160 ? `${channel.error.slice(0, 160)}…` : channel.error
    row.appendChild(error)
  }
  return row
}

async function handleAttachments() {
  const files = [...elements.attachmentInput.files]
  const threadId = conversation.getActiveThread()?.id
  const generation = state.attachmentGeneration + 1
  state.attachmentGeneration = generation
  for (const file of files) {
    if (state.attachments.length >= MAX_ATTACHMENTS) {
      showToast(`最多添加 ${MAX_ATTACHMENTS} 个文本附件`)
      break
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      showToast(`${file.name} 超过 128 KB，未添加`)
      continue
    }

    try {
      const content = await file.text()
      if (generation !== state.attachmentGeneration || threadId !== conversation.getActiveThread()?.id) return
      state.attachments.push({ id: createId("attachment"), name: file.name, content })
    } catch {
      showToast(`${file.name} 读取失败`)
    }
  }

  elements.attachmentInput.value = ""
  renderAttachments()
  updateComposerState()
}

function renderAttachments() {
  elements.attachmentList.replaceChildren()
  for (const attachment of state.attachments) {
    const chip = document.createElement("div")
    chip.className = UI_CLASSES.attachmentChip
    const name = document.createElement("span")
    name.textContent = attachment.name
    name.title = attachment.name
    const remove = document.createElement("button")
    remove.type = "button"
    remove.className = UI_CLASSES.attachmentRemove
    remove.dataset.attachmentId = attachment.id
    remove.setAttribute("aria-label", `移除附件：${attachment.name}`)
    remove.appendChild(createIcon("icon-x"))
    chip.append(name, remove)
    elements.attachmentList.appendChild(chip)
  }
}

function handleAttachmentRemoval(event) {
  const button = event.target.closest("[data-attachment-id]")
  if (!button) return
  state.attachments = state.attachments.filter((attachment) => attachment.id !== button.dataset.attachmentId)
  renderAttachments()
  updateComposerState()
}

async function shareCurrentThread() {
  const thread = conversation.getActiveThread()
  if (!thread || thread.messages.length === 0) {
    showToast("当前对话还没有可分享的内容")
    return
  }

  const transcript = thread.messages
    .map((message) => `${message.role === "user" ? "我" : "kefu-RAG"}：${message.content}`)
    .join("\n\n")
  const text = `${thread.title}\n\n${transcript}`

  try {
    await copyText(text)
    showToast("对话内容已复制")
  } catch {
    showToast("复制失败，请检查浏览器权限")
  }
}

async function handleMessageAction(event) {
  const citation = event.target.closest("[data-reference-id]")
  if (citation) {
    navigateToReference(citation)
    return
  }
  const button = event.target.closest("[data-action]")
  if (!button) return
  const thread = conversation.getActiveThread()
  const message = thread?.messages.find((item) => item.id === button.dataset.messageId)
  if (!thread || !message) return

  if (button.dataset.action === "insight") {
    openInsight(message.id)
    return
  }

  if (button.dataset.action === "copy") {
    try {
      await copyText(message.content)
      showToast("回答已复制")
    } catch {
      showToast("复制失败，请检查浏览器权限")
    }
    return
  }

  if (button.dataset.action === "regenerate" && !conversation.isRunning()) {
    const messageIndex = thread.messages.findIndex((item) => item.id === message.id)
    const previousUser = [...thread.messages.slice(0, messageIndex)].reverse().find((item) => item.role === "user")
    if (!previousUser) return
    thread.messages.splice(messageIndex)
    renderActiveThread()
    await submitPrompt("", { addUser: false, prompt: previousUser.prompt || previousUser.content })
  }
}

function navigateToReference(button) {
  const article = button.closest("article[data-message-id]")
  const panel = article?.querySelector("[data-references-for]")
  const item = panel?.querySelector(
    `[data-reference-item="${CSS.escape(button.dataset.referenceId)}"]`
  )
  if (!panel || !item) return
  panel.open = true
  item.dataset.highlighted = "false"
  requestAnimationFrame(() => {
    item.dataset.highlighted = "true"
    item.scrollIntoView({ behavior: "smooth", block: "nearest" })
    setTimeout(() => { item.dataset.highlighted = "false" }, 1600)
  })
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement("textarea")
  textarea.value = text
  textarea.className = "fixed left-[-9999px] top-0 opacity-0"
  document.body.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand("copy")
  textarea.remove()
  if (!copied) throw new Error("Copy failed")
}

function handleDocumentClick(event) {
  if (!event.target.closest("#status-trigger, #status-popover")) closeStatusPopover()
}

function handleGlobalKeydown(event) {
  if (event.key !== "Escape") return
  if (state.statusPopoverOpen) closeStatusPopover()
  else if (elements.appShell.dataset.sidebarOpen === "true") closeMobileSidebar(true)
  else if (conversation.isRunning()) cancelRun()
}

function markConnection(connected) {
  // The sidebar indicator reflects the deep status payload fetched from
  // /api/status. Here we only nudge it if no payload is loaded yet so the
  // dot doesn't lie while the probe is in flight.
  if (state.statusPayload) return
  elements.connectionDot.dataset.offline = String(!connected)
  elements.connectionDot.dataset.degraded = "false"
  elements.connectionLabel.textContent = connected ? "知识库已连接" : "服务连接异常"
}

function scrollToBottom(smooth) {
  requestAnimationFrame(() => {
    elements.chat.scrollTo({
      top: elements.chat.scrollHeight,
      behavior: smooth ? "smooth" : "auto",
    })
  })
}

function openImportDialog() {
  // 打开导入中心时刷新 URL tab 内容（Phase 2/3 会动态渲染）
  renderImportUrlTab()
  elements.importDialog.showModal()
}

function setImportTab(tab) {
  if (state.importTab === tab) return
  state.importTab = tab
  if (tab === "folder") {
    elements.importFolderTab.dataset.active = "true"
    elements.importFolderTab.setAttribute("aria-selected", "true")
    elements.importUrlTab.dataset.active = "false"
    elements.importUrlTab.setAttribute("aria-selected", "false")
    elements.importFolderPanel.hidden = false
    elements.importUrlPanel.hidden = true
  } else {
    elements.importUrlTab.dataset.active = "true"
    elements.importUrlTab.setAttribute("aria-selected", "true")
    elements.importFolderTab.dataset.active = "false"
    elements.importFolderTab.setAttribute("aria-selected", "false")
    elements.importUrlPanel.hidden = false
    elements.importFolderPanel.hidden = true
    renderImportUrlTab()
  }
}

function renderImportUrlTab() {
  elements.importUrlContent.replaceChildren()

  const container = document.createElement("div")
  container.className = "flex flex-col rounded-[12px] border border-neutral-200 bg-white p-5 shadow-sm"

  const modeWrap = document.createElement("div")
  modeWrap.className = "mb-5 inline-flex w-fit items-center rounded-[8px] bg-neutral-100 p-1"

  const singleBtn = document.createElement("button")
  singleBtn.type = "button"
  singleBtn.className = "relative flex h-8 items-center justify-center rounded-[6px] px-4 text-[13px] font-medium transition-all duration-200 " +
    (state.importUrlMode === "single" ? "bg-white text-neutral-900 shadow-sm" : "bg-transparent text-neutral-500 hover:text-neutral-700 hover:bg-neutral-200/50")
  singleBtn.textContent = "单个网页"
  singleBtn.dataset.urlMode = "single"

  const sitemapBtn = document.createElement("button")
  sitemapBtn.type = "button"
  sitemapBtn.className = "relative flex h-8 items-center justify-center rounded-[6px] px-4 text-[13px] font-medium transition-all duration-200 " +
    (state.importUrlMode === "sitemap" ? "bg-white text-neutral-900 shadow-sm" : "bg-transparent text-neutral-500 hover:text-neutral-700 hover:bg-neutral-200/50")
  sitemapBtn.dataset.urlMode = "sitemap"
  sitemapBtn.textContent = "网站抓取 (Sitemap)"

  modeWrap.appendChild(singleBtn)
  modeWrap.appendChild(sitemapBtn)
  modeWrap.addEventListener("click", (event) => {
    const target = event.target.closest("[data-url-mode]")
    if (!target || target.dataset.urlMode === state.importUrlMode) return
    state.importUrlMode = target.dataset.urlMode
    renderImportUrlTab()
  })

  const form = document.createElement("div")
  form.className = "flex flex-col gap-4"

  const inputWrap = document.createElement("div")
  inputWrap.className = "flex flex-col gap-1.5"

  const inputLabel = document.createElement("label")
  inputLabel.className = "text-[13px] font-medium text-neutral-700"
  inputLabel.textContent = state.importUrlMode === "single" ? "网页链接" : "Sitemap 链接"

  const urlInput = document.createElement("input")
  urlInput.type = "url"
  urlInput.placeholder = state.importUrlMode === "single"
    ? "https://example.com/article"
    : "https://example.com/sitemap.xml"
  urlInput.className = "h-10 w-full rounded-[8px] border border-neutral-200 bg-neutral-50/50 px-3.5 text-[14px] text-neutral-900 outline-none transition-colors focus:border-neutral-400 focus:bg-white placeholder:text-neutral-400"
  urlInput.id = "import-url-input"

  inputWrap.appendChild(inputLabel)
  inputWrap.appendChild(urlInput)
  form.appendChild(inputWrap)

  if (state.importUrlMode === "sitemap") {
    const maxWrap = document.createElement("div")
    maxWrap.className = "flex flex-col gap-1.5"

    const maxLabel = document.createElement("label")
    maxLabel.className = "text-[13px] font-medium text-neutral-700"
    maxLabel.textContent = "最大抓取页数"

    const maxInput = document.createElement("input")
    maxInput.type = "number"
    maxInput.min = "1"
    maxInput.max = "200"
    maxInput.value = "50"
    maxInput.className = "h-10 w-full rounded-[8px] border border-neutral-200 bg-neutral-50/50 px-3.5 text-[14px] text-neutral-900 outline-none transition-colors focus:border-neutral-400 focus:bg-white"
    maxInput.id = "import-url-max-pages"

    maxWrap.appendChild(maxLabel)
    maxWrap.appendChild(maxInput)
    form.appendChild(maxWrap)
  }

  const submitBtn = document.createElement("button")
  submitBtn.type = "button"
  submitBtn.className = "mt-2 inline-flex h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-[8px] bg-neutral-900 px-4 text-[14px] font-medium text-white shadow-sm transition-all duration-[160ms] ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-neutral-800 hover:shadow-md active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100"
  submitBtn.textContent = state.importUrlMode === "single" ? "导入该网页" : "批量导入"
  submitBtn.id = "import-url-submit"
  submitBtn.addEventListener("click", handleUrlImport)

  form.appendChild(submitBtn)

  container.appendChild(modeWrap)
  container.appendChild(form)
  elements.importUrlContent.appendChild(container)
}

async function handleUrlImport() {
  const urlInput = document.getElementById("import-url-input")
  const submitBtn = document.getElementById("import-url-submit")
  if (!urlInput || !submitBtn) return
  const url = urlInput.value.trim()
  if (!url) {
    showToast("请输入 URL")
    return
  }
  let maxPages = 50
  if (state.importUrlMode === "sitemap") {
    const maxInput = document.getElementById("import-url-max-pages")
    if (maxInput) {
      const v = parseInt(maxInput.value, 10)
      if (!Number.isFinite(v) || v < 1 || v > 200) {
        showToast("maxPages 必须在 1-200 之间")
        return
      }
      maxPages = v
    }
  }
  submitBtn.disabled = true
  submitBtn.textContent = "导入中…"
  try {
    const body = state.importUrlMode === "sitemap"
      ? { url, mode: "sitemap", maxPages }
      : { url, mode: "single" }
    const resp = await fetch(`${API_BASE}/ingest/url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}))
      throw new Error(err.error || `HTTP ${resp.status}`)
    }
    const data = await resp.json()
    if (state.importUrlMode === "single") {
      const item = {
        id: createId("imp"),
        fileName: data.docId,
        filePath: url,
        size: 0,
        status: "pending",
        docId: data.docId,
        error: null,
      }
      state.importQueue = [item]
      renderImportItems()
      startImportPollingIfNeeded()
      showToast("已提交，正在处理…")
    } else {
      // sitemap：批量入队
      const items = (data.items || []).map((it) => ({
        id: createId("imp"),
        fileName: it.url,
        filePath: it.url,
        size: 0,
        status: it.docId ? "pending" : "failed",
        docId: it.docId || null,
        error: it.docId ? null : (it.status || "提交失败"),
      }))
      state.importQueue = items
      renderImportItems()
      startImportPollingIfNeeded()
      showToast(`已提交 ${data.submitted} 个页面`)
    }
  } catch (err) {
    showToast(`提交失败：${err?.message || String(err)}`)
  } finally {
    submitBtn.disabled = false
    submitBtn.textContent = "导入"
  }
}

async function handleFolderSelect(event) {
  const fileList = event.target.files
  if (!fileList || fileList.length === 0) return
  const accepted = []
  for (const file of fileList) {
    const dotIdx = file.name.lastIndexOf(".")
    const ext = dotIdx >= 0 ? file.name.slice(dotIdx).toLowerCase() : ""
    if (IMPORT_FILE_EXTENSIONS.has(ext)) {
      accepted.push(file)
    }
  }
  if (accepted.length === 0) {
    showToast("所选文件夹中没有支持的文档类型")
    state.importQueue = []
    renderImportItems()
    return
  }
  if (accepted.length > IMPORT_MAX_FILES_HINT) {
    showToast(`共 ${accepted.length} 个文件，建议分批导入（单次 ≤ ${IMPORT_MAX_FILES_HINT}）`)
  }
  // 重置队列并自动开始
  state.importQueue = accepted.map((file) => ({
    id: createId("imp"),
    fileName: file.name,
    filePath: file.webkitRelativePath || file.name,
    size: file.size,
    status: "queued", // queued | uploading | pending | processing | completed | failed
    docId: null,
    error: null,
    file,
  }))
  renderImportItems()
  await startFolderImport()
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

async function startFolderImport() {
  if (state.importRunning || state.importQueue.length === 0) return
  state.importRunning = true
  elements.importFolderInput.disabled = true
  const workers = Array.from({ length: Math.min(IMPORT_CONCURRENCY, state.importQueue.length) }, () =>
    importWorkerLoop()
  )
  await Promise.all(workers)
  state.importRunning = false
  elements.importFolderInput.disabled = false
  const failedCount = state.importQueue.filter((it) => it.status === "failed").length
  const completedCount = state.importQueue.filter((it) => it.status === "completed").length
  if (failedCount === 0) {
    showToast(`导入完成：${completedCount} 个文件已入知识库`)
  } else {
    showToast(`导入结束：${completedCount} 成功，${failedCount} 失败`)
  }
  fetchStatus()
}

async function importWorkerLoop() {
  while (true) {
    const item = state.importQueue.find((it) => it.status === "queued")
    if (!item) break
    item.status = "uploading"
    renderImportItems()
    try {
      const docId = await uploadFileToIngest(item.file)
      item.docId = docId
      item.status = "pending"
    } catch (err) {
      item.status = "failed"
      item.error = err?.message || String(err)
      renderImportItems()
      continue
    }
    renderImportItems()
    startImportPollingIfNeeded()
  }
}

function uploadFileToIngest(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = async () => {
      try {
        const bytes = new Uint8Array(reader.result)
        const mime = file.type || guessMimeFromExt(file.name)
        const resp = await fetch(`${API_BASE}/ingest/file`, {
          method: "POST",
          headers: {
            "content-type": "application/octet-stream",
            "x-file-name": file.name,
            "x-file-mime-type": mime,
            "x-source-kind": "file",
            "x-source-id": file.webkitRelativePath || file.name,
            "x-source-namespace": "local-folder",
          },
          body: bytes,
        })
        if (!resp.ok) {
          const text = await resp.text().catch(() => "")
          throw new Error(`HTTP ${resp.status}${text ? `: ${text.slice(0, 200)}` : ""}`)
        }
        const data = await resp.json()
        resolve(data.docId)
      } catch (err) {
        reject(err)
      }
    }
    reader.onerror = () => reject(reader.error || new Error("文件读取失败"))
    reader.readAsArrayBuffer(file)
  })
}

function guessMimeFromExt(fileName) {
  const dotIdx = fileName.lastIndexOf(".")
  const ext = dotIdx >= 0 ? fileName.slice(dotIdx).toLowerCase() : ""
  const map = {
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".html": "text/html",
    ".htm": "text/html",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  }
  return map[ext] || "application/octet-stream"
}

function startImportPollingIfNeeded() {
  if (state.importPollTimer) return
  state.importPollTimer = setInterval(pollImportItems, IMPORT_POLL_MS)
  pollImportItems() // 立即跑一次
}

function stopImportPollingIfDone() {
  const pending = state.importQueue.some(
    (it) => it.status === "pending" || it.status === "processing"
  )
  if (!pending && state.importPollTimer) {
    clearInterval(state.importPollTimer)
    state.importPollTimer = null
  }
}

async function pollImportItems() {
  const pending = state.importQueue.filter(
    (it) => it.status === "pending" || it.status === "processing"
  )
  if (pending.length === 0) {
    stopImportPollingIfDone()
    return
  }
  await Promise.all(pending.map((it) => pollSingleImportItem(it)))
  renderImportItems()
  stopImportPollingIfDone()
}

async function pollSingleImportItem(item) {
  if (!item.docId) return
  try {
    const resp = await fetch(`${API_BASE}/ingest/${item.docId}/status`)
    if (!resp.ok) {
      item.status = "failed"
      item.error = `状态查询失败 HTTP ${resp.status}`
      return
    }
    const data = await resp.json()
    const stage = data.stage || data.status || ""
    // 任务完成判定：stage 为 done/completed/succeeded
    if (stage === "done" || stage === "completed" || stage === "succeeded") {
      item.status = "completed"
      item.error = null
    } else if (stage === "failed" || stage === "error") {
      item.status = "failed"
      item.error = data.error || data.message || "处理失败"
    } else {
      item.status = "processing"
      item.stage = stage
    }
  } catch (err) {
    // 网络错误不立即标失败，下一轮再试
    item.error = err?.message || String(err)
  }
}

function renderImportItems() {
  const progressSection = document.getElementById("import-progress-section")
  if (state.importQueue.length === 0) {
    elements.importItemsList.replaceChildren()
    elements.importItemsList.classList.add("hidden")
    if (progressSection) progressSection.classList.add("hidden")
    return
  }
  elements.importItemsList.classList.remove("hidden")
  if (progressSection) progressSection.classList.remove("hidden")
  elements.importItemsList.replaceChildren(
    ...state.importQueue.map((item) => createImportItemNode(item))
  )
}

function createImportItemNode(item) {
  const row = document.createElement("div")
  row.className = "flex items-center gap-2 rounded-md border border-neutral-200 px-2.5 py-1.5 text-xs"
  const icon = document.createElement("span")
  icon.className = "grid size-4 flex-none place-items-center"
  const ICONS = {
    queued: `<svg class="size-3.5 text-neutral-400" aria-hidden="true"><circle cx="12" cy="12" r="6" fill="currentColor"/></svg>`,
    uploading: `<svg class="size-3.5 text-amber-500" aria-hidden="true"><circle cx="12" cy="12" r="6" fill="currentColor"/></svg>`,
    pending: `<svg class="size-3.5 text-amber-500" aria-hidden="true"><circle cx="12" cy="12" r="6" fill="currentColor"/></svg>`,
    processing: `<svg class="size-3.5 text-blue-500 animate-spin" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="3" fill="none" stroke-dasharray="40 20"/></svg>`,
    completed: `<svg class="size-3.5 text-green-600" aria-hidden="true"><use href="#icon-check"/></svg>`,
    failed: `<svg class="size-3.5 text-red-600" aria-hidden="true"><use href="#icon-x"/></svg>`,
  }
  icon.innerHTML = ICONS[item.status] || ICONS.queued
  const name = document.createElement("span")
  name.className = "min-w-0 flex-1 truncate text-neutral-900"
  name.textContent = item.filePath || item.fileName
  name.title = item.filePath || item.fileName
  const statusText = document.createElement("span")
  statusText.className = "flex-none text-neutral-500"
  const STATUS_TEXT = {
    queued: "排队中",
    uploading: "上传中",
    pending: "等待处理",
    processing: item.stage ? `处理中·${item.stage}` : "处理中",
    completed: "完成",
    failed: item.error ? `失败：${item.error}` : "失败",
  }
  statusText.textContent = STATUS_TEXT[item.status] || item.status
  row.appendChild(icon)
  row.appendChild(name)
  row.appendChild(statusText)
  return row
}

function showToast(message) {
  clearTimeout(state.toastTimer)
  const toast = elements.toast
  const isVisible = toast.dataset.visible === "true"
  const textChanged = toast.textContent !== message

  if (isVisible && textChanged && !state.reducedMotion.matches) {
    // Crossfade the label: old text fades out, new text fades in on
    // the same toast — no layout shift, no double toast.
    toast.animate(
      [{ opacity: 1 }, { opacity: 0 }],
      { duration: 120, easing: "ease-out", fill: "forwards" },
    ).finished.then(() => {
      toast.textContent = message
      return toast.animate(
        [{ opacity: 0 }, { opacity: 1 }],
        { duration: 140, easing: "ease-out", fill: "forwards" },
      ).finished
    }).catch(() => {})
  } else {
    toast.textContent = message
  }

  toast.dataset.visible = "true"
  state.toastTimer = setTimeout(() => { toast.dataset.visible = "false" }, 2200)
}
