# kefu-RAG

智能客服 RAG 系统。基于 Agentic RAG 架构（三阶段七层），实现多路检索、查询路由、规划分解、上下文组装和自校正循环。

## 架构

```
用户输入 → Router ──→ simple ──→ Searcher ──→ ContextAssembler ──→ LLM → Critic → 输出
                    │              (vector + BM25 + graph)
                    ├──→ ambiguous → 追问
                    └──→ complex  → Planner ──→ decompose → 多路 Searcher → merge → ...
                                    (sub-queries)

Critic 失败 → RePlanner → 补充检索 → 再回答 (≤3 轮)
```

## 技术栈

- TypeScript + Node.js (CommonJS)
- Express 5 (API + SSE 流式)
- Elasticsearch (向量 + BM25 检索)
- Neo4j (实体图谱 + Wikilink 扩散)
- OpenAI (embedding / GPT-4o-mini)
- 前端 (vanilla JS, Apple Design 风格)

## 快速开始

```bash
# 1. 安装
npm install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env 填入 OPENAI_API_KEY，可选 ES/Neo4j 配置

# 3. 构建
npm run build

# 4. 启动 API 服务
npm run dev

# 5. 前端 (另一个终端)
npm run frontend
```

## 数据接入

```bash
npm run ingest -- ./docs/sample.txt
```

管道：文件 → RecursiveChunker → LLMWikifier (实体提取 + Wikilink) → ES (含 embedding) + Neo4j

## 项目结构

```
src/
├── api/          # Express 服务器、SSE /api/chat 端点
├── config/       # 配置加载 (ES / Neo4j / OpenAI)
├── graph/        # Neo4j 驱动
├── types/        # Document / Chunk / Entity / Wikilink / Agent 类型
├── ingestion/    # 接入管道 (chunker / wikifier / storage)
├── retrieval/    # 检索层 (searcher / router / planner / context)
├── critic/       # 自校正 (validator / replanner)
└── index.ts      # 入口
frontend/         # 聊天 UI (glassmorphism, dark mode, SSE 流式)
```

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `OPENAI_API_KEY` | 是 | — | OpenAI API Key |
| `ES_NODE` | 否 | `http://localhost:9200` | Elasticsearch 节点 |
| `ES_API_KEY` | 否 | — | ES API Key (base64) |
| `NEO4J_URI` | 否 | `bolt://localhost:7687` | Neo4j URI |
| `NEO4J_USER` | 否 | `neo4j` | Neo4j 用户名 |
| `NEO4J_PASSWORD` | 否 | — | Neo4j 密码 |

ES/Neo4j 不可用时自动降级运行。
