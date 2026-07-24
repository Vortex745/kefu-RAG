# HINTS — Service Configuration & Environment Conventions

> **Audience:** Operators and agents starting a new session.
> **Purpose:** One-stop reference for environment variables, commands, and runtime conventions.
> **Related:** `AGENTS.md` §1.1 (Session startup loads this file first).

---

## 1. Runtime Environment

| Property | Value |
|----------|-------|
| Node.js | ≥ 20 (uses native `node:test` runner, `AbortController`, `DOMException`) |
| Package manager | npm (lockfile: `package-lock.json`) |
| TypeScript | strict mode (`tsconfig.json`); frontend build: `tsconfig.frontend.json` |
| Module system | CommonJS (`"type": "commonjs"`) |
| OS | Windows (PowerShell); cross-platform compatible |
| Test runner | `node --import tsx --test src/**/*.test.ts` |

---

## 2. Environment Variables

Copy `.env.example` to `.env` and fill in values. All variables are optional unless marked **required**.

### 2.1 Elasticsearch

| Variable | Default | Required? | Notes |
|----------|---------|-----------|-------|
| `ES_NODE` | `http://localhost:9200` | Required for production | Elasticsearch node URL |
| `ES_API_KEY` | (empty) | Optional | API key for authenticated ES clusters |

### 2.2 OpenAI (Chat)

| Variable | Default | Required? | Notes |
|----------|---------|-----------|-------|
| `OPENAI_API_KEY` | — | Required | OpenAI-compatible API key |
| `OPENAI_BASE_URL` | (empty) | Optional | Override for DeepSeek/ModelScope/etc. |
| `OPENAI_CHAT_MODEL` | `gpt-4o-mini` | Required | Chat model ID (deployment-configured; request-level override removed in Ticket 02) |

### 2.3 Embeddings

| Variable | Default | Required? | Notes |
|----------|---------|-----------|-------|
| `EMBEDDING_API_KEY` | (falls back to `OPENAI_API_KEY`) | Optional | Separate embedding provider key |
| `EMBEDDING_BASE_URL` | (falls back to `OPENAI_BASE_URL`) | Optional | Separate embedding provider URL |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | Required | Embedding model ID |
| `EMBEDDING_DIMENSIONS` | `1536` | Required | Embedding vector dimensions |

### 2.4 Answer Run Resource Budgets

| Variable | Default | Required? | Notes |
|----------|---------|-----------|-------|
| `ANSWER_RUN_MAX_MODEL_CALLS` | Unlimited | Optional | Maximum chat + embedding provider calls in one Answer run; `0` rejects the first call |
| `ANSWER_RUN_MAX_TOKENS` | Unlimited | Optional | Maximum aggregate provider-reported tokens in one Answer run |
| `ANSWER_RUN_MAX_COST_MICROS` | Unlimited | Optional | Maximum aggregate cost in integer micro-USD |
| `ANSWER_RUN_MODEL_PRICING_JSON` | — | Required with a cost limit | Exact-model JSON map with `inputCostMicrosPerMillionTokens` and `outputCostMicrosPerMillionTokens`; no prices are built in |

All limits are opt-in. A configured token or cost limit fails closed if the provider does not report usage. A cost limit also fails closed when the exact model is absent from the pricing table.

### 2.5 Neo4j

| Variable | Default | Required? | Notes |
|----------|---------|-----------|-------|
| `NEO4J_URI` | `bolt://localhost:7687` | Required for production | Neo4j bolt URL |
| `NEO4J_USER` | `neo4j` | Required for production | Neo4j username |
| `NEO4J_PASSWORD` | — | Required for production | Neo4j password |

### 2.6 OIDC / Identity (Ticket 05)

| Variable | Default | Required? | Notes |
|----------|---------|-----------|-------|
| `OIDC_ISSUER` | — | Required for `enforced` mode | OIDC issuer URL |
| `OIDC_AUDIENCE` | — | Required for `enforced` mode | Expected token audience |
| `OIDC_JWKS_ENDPOINT` | — | Required for `enforced` mode | JWKS endpoint URL |
| `OIDC_TENANT_CLAIM` | `tenant_id` | Optional | Claim name for tenant ID |
| `OIDC_SUBJECT_CLAIM` | `sub` | Optional | Claim name for subject ID |
| `OIDC_GROUPS_CLAIM` | `groups` | Optional | Claim name for group list |
| `OIDC_SCOPES_CLAIM` | `scope` | Optional | Claim name for scope list |
| `ACCESS_MODE` | `single_tenant` | Optional | `single_tenant` or `enforced` |

When `ACCESS_MODE=single_tenant`, no token is required (backward compat). When `ACCESS_MODE=enforced`, all `/api/chat` and `/api/ingest` requests require a valid RS256 JWT verified by `jose.jwtVerify` against the remote JWKS.

### 2.7 Langfuse (Optional Observability)

| Variable | Default | Required? | Notes |
|----------|---------|-----------|-------|
| `LANGFUSE_PUBLIC_KEY` | — | Optional | When absent, `NoopLangfuseExporter` is used (disabled mode) |
| `LANGFUSE_SECRET_KEY` | — | Optional | When absent, disabled mode |
| `LANGFUSE_BASE_URL` | — | Optional | Self-hosted Langfuse URL |

Langfuse is a DI-seam — the `langfuse` npm package is NOT a hard dependency. Callers must install it and inject a `RealLangfuseClient`.

### 2.8 Mastra Promotion

| Variable | Default | Required? | Notes |
|----------|---------|-----------|-------|
| `MASTRA_PROMOTION_ARTIFACT` | — | Optional | Path to a release verification artifact JSON. When present, the Mastra runtime starts in `live` mode; otherwise `shadow` mode. |

---

## 3. Common Commands

```bash
# Development
npm run dev                    # Start backend in dev mode (tsx watch)
npm run frontend               # Serve frontend on localhost:3000
npm run ingest                 # Run ingestion CLI

# Build
npm run build                  # TypeScript compile (tsc)
npm run build:frontend         # Frontend TS + Tailwind CSS build
npm run build:css              # Tailwind CSS build only

# Test
npm test                       # Full test suite (node:test + tsx)
node --import tsx --test <file># Focused test file

# Release verification (Tickets 03-04)
npm run release:verify:local   # Run 6 local release gates
npm run release:verify:production  # Run production release gates
npm run release:promotion-check    # Validate release artifact promotion contract
```

---

## 4. Database

- **Engine:** SQLite (`better-sqlite3`)
- **Files:** `data/kefu-rag.db` (main), `data/kefu-rag-acceptance.db` (acceptance tests)
- **Schema:** `src/ingestion/tracking/db.ts` — idempotent `CREATE TABLE IF NOT EXISTS` statements
- **Migrations:** Additive only; follow the `key without new attributes + DEFAULT fallback + ALTER idempotency` pattern (see `MEMORY.md`)

---

## 5. External Services

| Service | Purpose | When Required |
|---------|---------|---------------|
| Elasticsearch | Vector + BM25 retrieval, PageIndex | Production, acceptance tests |
| Neo4j | GraphRAG provenance | Production, acceptance tests |
| OpenAI-compatible API | Chat + embeddings | Always (dev + prod) |
| MarkItDown | Document ingestion (raw file → normalized blocks) | Ingestion; Ticket 09 will repair ABI |
| Marker | Paper ingestion (PDF → structured) | Ingestion; Ticket 09 will install |
| MinerU | Chinese OCR ingestion | Ingestion; Ticket 09 will install |
| Langfuse | Observability / trace export | Optional (disabled by default) |

---

## 6. Known Gotchas

- **Windows PowerShell:** `*>` captures all streams; `2>&1 > file` does NOT work (different from bash). Use `*> file` or `| Out-String`.
- **Node test runner:** `node --import tsx --test` outputs to TTY; PowerShell pipe `| Select-String` may miss lines. Use `| Out-String` first.
- **Elasticsearch client:** Multiple construction sites exist (`process_runtime.ts`, `ingestion/storage/index.ts`, `ingestion/storage/store.ts`) — known architectural debt (the historical `docs/dormant-surface-audit.md` audit was deleted; the debt is documented inline here and in `src/runtime/p8_3_runtime_integration.test.ts` for ProcessRuntime).
- **ProcessRuntime:** Two production construction sites (`api/server.ts`, `answer/runtime.ts`) — documented in `src/runtime/p8_3_runtime_integration.test.ts`.
- **CRLF warnings:** `git diff --check` on Windows emits CRLF warnings; these are NOT errors (exit code 0).
