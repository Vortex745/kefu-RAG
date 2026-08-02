# kefu-RAG

智能客服 RAG 系统。把文档喂进去，机器人就能按文档内容回答客户问题，答案带出处，答错了会自动重试。

## 项目介绍

kefu-RAG 是一个 Agentic RAG 实现的客服问答服务。文档接入后自动切块、向量化、抽取实体建图谱；客户提问时，系统先判断问题类型，再走对应的检索与生成流程，最后给出带引用来源的答案。

几个特点：

- 四种路由分派：寒暄直接答、说不清先追问、简单问题检索答、复杂问题拆开答
- 自校正：答案生成后经过 Critic 检查，引用缺失或答非所问就补检索再答
- 流式输出：SSE 逐字返回，前端边收边渲染
- 服务可降级：ES、Neo4j 不在线时自动跳过对应检索，只有 OpenAI 是硬依赖
- 带会话记忆，支持转人工与用户反馈

技术栈：TypeScript + Node.js（CommonJS）、Express 5、Elasticsearch、Neo4j、SQLite、OpenAI（gpt-4o-mini）、Mastra、可选 Langfuse。前端为原生 JS，Apple Design 风格。

## RAG 执行链路

一次提问从 `POST /api/chat` 进入，走完整条链路：

**1. 路由分派（Router）**

LLM 先把问题归成四类，决定后续走哪条路：

- `direct`：问候、寒暄，不涉及知识库，直接回复
- `ambiguous`：问题没说清，先追问澄清，不生成答案
- `simple`：单点事实问题，检索后回答
- `complex`：多步骤问题，需要拆解

**2. 检索与生成**

- `simple`：Searcher 同时跑向量检索（ES）、BM25 全文检索（ES）和实体图谱扩散（Neo4j），结果交给 ContextAssembler 组装上下文，LLM 基于上下文生成答案草稿
- `complex`：Planner 把问题拆成多个子查询，或走检索工具循环（最多 3 轮迭代、4 次工具调用），多路结果合并后走同样的生成流程

**3. Critic 自校正**

Validator 检查草稿：有没有答到点上、引用是否站得住。不合格就把问题交回 RePlanner，补充检索后再答，最多 3 轮。

**4. 输出与收尾**

答案连同引用证据经 SSE 流式返回。每轮问答的轨迹都会写入 trace，可选导出到 Langfuse；会话记录在回答后保存，30 天无活动的会话会被定时清理。

```
POST /api/chat
   │
   ▼
 Router ──→ direct ──→ 直接回复
   │
   ├──→ ambiguous ──→ 追问澄清
   │
   ├──→ simple ──→ Searcher(向量 + BM25 + 图谱) → 上下文组装 → LLM 草稿
   │
   └──→ complex ──→ Planner 拆子查询 / 检索循环(≤3轮) → 多路合并 → LLM 草稿
                                                            │
                                                            ▼
                                                   Critic 校验 ──通过──→ 流式输出（带引用）
                                                            │
                                                          失败
                                                            │
                                                            ▼
                                             RePlanner 补充检索 → 再答（≤3 轮）
```

## 启动配置

启动前需要准备一个 OpenAI API Key，这是唯一的硬依赖。其余服务都是可选的，缺了会自动降级。

### 快速开始

```bash
npm install
cp .env.example .env    # 填 OPENAI_API_KEY
npm run dev             # API 服务，端口 3001
npm run frontend        # 前端页面，另一个终端
```

### 环境变量

必填：

| 变量 | 说明 |
|------|------|
| OPENAI_API_KEY | OpenAI API Key |

常用可选：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| OPENAI_CHAT_MODEL | gpt-4o-mini | 对话模型 |
| ES_NODE | http://localhost:9200 | Elasticsearch 地址，不在线则跳过向量/BM25 检索 |
| NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD | bolt://localhost:7687 / neo4j / 空 | 实体图谱，不在线则跳过图谱扩散 |
| EMBEDDING_MODEL | text-embedding-3-small | 向量模型，可单独配 key 和 base URL |
| OPENAI_REQUEST_TIMEOUT_MS | 200000 | LLM 单次调用超时 |
| OPENAI_MAX_RETRIES | 1 | LLM 调用重试次数 |
| ACCESS_MODE | single_tenant | 设为 enforced 时启用 OIDC 鉴权 |
| ACTIVATION_MODE | auto | 设为 review 时接入内容需人工审核后生效 |
| LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY | 无 | 两个都配齐才导出 trace 到 Langfuse |

完整的变量清单见 `.env.example`。

### 数据接入

```bash
npm run ingest -- ./docs/sample.txt
```

管道：文件 → 切块 → 实体提取（Wikifier）→ 写入 ES（含 embedding）与 Neo4j。PDF 和图片走 markitdown / marker / mineru 解析。

HTTP 方式：`POST /api/ingest`（文件）或 `POST /api/ingest/url`（URL）。

## API 一览

- `POST /api/chat`：SSE 流式对话
- `GET /api/chat/runs/:runId`：单次回答的 trace
- `POST /api/ingest`、`POST /api/ingest/url`：触发接入
- `GET /api/ingest/:docId/status`：接入进度
- `PUT /api/chat/runs/:runId/feedback`：提交反馈
- `POST /api/chat/runs/:runId/handoff`：转人工
- `GET /status`、`GET /models`：健康检查与模型列表

## 项目结构

```
src/
├── api/         Express 路由（chat、ingest、feedback、handoff…）
├── answer/      回答组装：上下文、摘要、压缩、会话
├── retrieval/   searcher / router / planner / context
├── critic/      validator / replanner，自校正
├── ingestion/   接入管道（切块、wikify、存储、任务跟踪）
├── identity/    OIDC 鉴权适配（enforced 模式）
├── mastra/      路由 runner 与事件适配
├── runtime/     运行预算与资源管理
└── index.ts     入口

frontend/        聊天 UI（SSE 流式、暗色模式）
```
