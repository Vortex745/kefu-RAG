/**
 * Ticket 01 — Mastra module/runtime compatibility probe tests (retired-baseline subset).
 *
 * The decision-document assertions that previously lived under Criterion #5
 * verified the wording of `.scratch/mastra-migration/decisions/01-module-strategy.md`,
 * which the user deleted. Those assertions are retired because they only tested
 * deleted planning history, not current runtime or source behavior.
 *
 * The live runtime + source-contract tests below are preserved because they
 * verify current production invariants that must remain enforced:
 * - MODULE_STRATEGY_OPTIONS comparison + viability + rejection reasons
 * - dynamic import of @mastra/core/agent under CommonJS host
 * - streamed chunk reception via fake OpenAI-compatible endpoint
 * - AbortSignal cancellation produces no late output
 * - tsconfig target/module and package.json type unchanged
 * - express dependency + graceful shutdown module unchanged
 * - src/answer, src/index.ts, src/api do not import @mastra/core or the probe
 *
 * Boundary: this test file is allowed to depend on @mastra/core at runtime
 * (dynamic import). It MUST NOT be imported by src/answer/* (criterion #6).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  loadMastraAgentModule,
  runCompatibilityProbe,
  MODULE_STRATEGY_OPTIONS,
  RECOMMENDED_MODULE_STRATEGY_ID,
  captureCurrentFetch,
  restorePreviousFetch,
} from "./compatibility_probe";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// Criterion #1 — Compare three module strategies with observed evidence.
// ---------------------------------------------------------------------------

test("T01 #1: three module strategies are compared in MODULE_STRATEGY_OPTIONS", () => {
  const ids = MODULE_STRATEGY_OPTIONS.map((o) => o.id);
  assert.equal(ids.length, 3, "exactly three strategies must be compared");
  assert.ok(ids.includes("repo-wide-esm-migration"));
  assert.ok(ids.includes("dynamic-import-esm-boundary"));
  assert.ok(ids.includes("separate-mastra-subproject"));
});

test("T01 #1: rejected strategies carry an explicit rejectedReason", () => {
  for (const option of MODULE_STRATEGY_OPTIONS) {
    if (!option.viable) {
      assert.ok(
        option.rejectedReason && option.rejectedReason.length > 0,
        `non-viable strategy ${option.id} must record a rejection reason`
      );
    }
  }
});

test("T01 #1: exactly one strategy is marked viable", () => {
  const viable = MODULE_STRATEGY_OPTIONS.filter((o) => o.viable);
  assert.equal(viable.length, 1, "exactly one recommended strategy");
  assert.equal(viable[0].id, RECOMMENDED_MODULE_STRATEGY_ID);
});

// ---------------------------------------------------------------------------
// Criterion #2 — Stream a model response through the configured OpenAI-
//                compatible endpoint.
// We exercise this with an injected fake fetch that returns a tiny SSE-like
// stream; this proves the probe can drive Mastra's stream path without
// requiring a live OpenAI key.
// ---------------------------------------------------------------------------

test("T01 #2: dynamic import of @mastra/core/agent succeeds under CommonJS host", async () => {
  const { module, errorMessage } = await loadMastraAgentModule();
  assert.ok(
    !errorMessage,
    `dynamic import must succeed under CommonJS; got: ${errorMessage}`
  );
  assert.ok(module, "module namespace must be defined");
  assert.equal(
    typeof (module as { Agent?: unknown }).Agent,
    "function",
    "Agent must be a constructor on the loaded module"
  );
});

test("T01 #2: probe reaches at least one streamed chunk via fake OpenAI-compatible endpoint", async () => {
  // Fake fetch that returns a 200 with a tiny Responses-API SSE body.
  // Mastra's AI SDK layer consumes this as if it came from OpenAI's
  // /v1/responses endpoint.
  const fakeFetch = makeFakeOpenAIStreamFetch({
    chunks: ["ok"],
    delayMs: 0,
  });
  const previousFetch = captureCurrentFetch();

  const result = await runCompatibilityProbe({
    openAICompatible: {
      baseURL: "https://fake-openai.example.com/v1",
      apiKey: "fake-key",
      model: "gpt-4o-mini",
    },
    fetchImpl: fakeFetch as unknown as typeof fetch,
    prompt: "Reply with the single word: ok",
    // Keep fake fetch installed past the probe's finally block so Mastra's
    // internal p-retry timers (which fire after the stream completes) keep
    // hitting the fake instead of the real network. The test restores fetch
    // below after waiting for those timers to settle.
    keepFetchInstalled: true,
  });

  assert.equal(result.mastraModuleLoaded, true, "module must load");
  assert.equal(result.agentConstructorReachable, true, "Agent must be usable");
  assert.ok(
    !result.errorMessage || result.errorMessage.length === 0,
    `probe must not surface a fatal error: ${result.errorMessage}`
  );
  assert.equal(
    result.streamedAtLeastOneChunk,
    true,
    "probe must receive at least one streamed chunk from the fake endpoint"
  );

  // Wait for Mastra's internal p-retry timers to settle, then restore fetch.
  await new Promise((r) => setTimeout(r, 2500));
  restorePreviousFetch(previousFetch);
});

// ---------------------------------------------------------------------------
// Criterion #3 — AbortSignal cancellation produces no late output.
// ---------------------------------------------------------------------------

test("T01 #3: AbortSignal mid-stream yields zero chunks after abort", async () => {
  const controller = new AbortController();
  const fakeFetch = makeFakeSlowOpenAIStreamFetch({
    chunksPerSecond: 5,
    totalChunks: 50,
    onFirstChunk: () => {
      // Abort as soon as the first chunk is emitted by the fake upstream.
      controller.abort();
    },
  });
  const previousFetch = captureCurrentFetch();

  const result = await runCompatibilityProbe({
    openAICompatible: {
      baseURL: "https://fake-openai.example.com/v1",
      apiKey: "fake-key",
      model: "gpt-4o-mini",
    },
    fetchImpl: fakeFetch as unknown as typeof fetch,
    signal: controller.signal,
    keepFetchInstalled: true,
  });

  assert.equal(result.mastraModuleLoaded, true);
  assert.equal(
    result.cancellationObservedNoLateOutput,
    true,
    `cancellation must produce no late output; errorMessage=${result.errorMessage}`
  );

  // Wait for Mastra's internal p-retry timers to settle, then restore fetch.
  await new Promise((r) => setTimeout(r, 2500));
  restorePreviousFetch(previousFetch);
});

// ---------------------------------------------------------------------------
// Criterion #4 — Selected strategy works with test runner, TypeScript target,
//                Express runtime, and graceful shutdown.
// ---------------------------------------------------------------------------

test("T01 #4: tsconfig target is ES2022 (preserves dynamic import)", () => {
  const tsconfig = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "tsconfig.json"), "utf8")
  );
  assert.equal(tsconfig.compilerOptions.target, "ES2022");
});

test("T01 #4: tsconfig module remains commonjs (no repo-wide ESM migration)", () => {
  const tsconfig = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "tsconfig.json"), "utf8")
  );
  assert.equal(tsconfig.compilerOptions.module, "commonjs");
});

test("T01 #4: package.json type remains commonjs (no repo-wide ESM migration)", () => {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.equal(pkg.type, "commonjs");
});

test("T01 #4: express remains a dependency (runtime unchanged)", () => {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.ok(pkg.dependencies?.express, "express must remain a runtime dep");
});

test("T01 #4: graceful shutdown module is unchanged (shutdown.ts present)", () => {
  // shutdown.ts is the existing graceful-shutdown owner; Ticket 01 must not
  // touch it. We assert it still exists and exports the expected symbol.
  const shutdownSrc = readFileSync(
    path.join(REPO_ROOT, "src", "shutdown.ts"),
    "utf8"
  );
  assert.ok(
    shutdownSrc.includes("createShutdownController"),
    "createShutdownController must still be exported from src/shutdown.ts"
  );
  assert.ok(
    !shutdownSrc.includes("@mastra/core"),
    "src/shutdown.ts must NOT depend on @mastra/core (boundary contract)"
  );
});

// ---------------------------------------------------------------------------
// Criterion #5 — One recommended module strategy is recorded with evidence
//                and rejected alternatives.
//
// RETIRED: The three original assertions under this criterion read the deleted
// decision document `.scratch/mastra-migration/decisions/01-module-strategy.md`.
// The recommendation itself is still enforced live by the Criterion #1 tests
// above (exactly one viable strategy + RECOMMENDED_MODULE_STRATEGY_ID + every
// rejected strategy carries a rejectedReason), so retiring the doc-only
// assertions does not weaken the current contract.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Criterion #6 — Production Answer runtime remains unchanged.
// Static boundary check: src/answer/* MUST NOT import this probe or
// @mastra/core.
// ---------------------------------------------------------------------------

test("T01 #6: src/answer does not import @mastra/core", () => {
  const answerDir = path.join(REPO_ROOT, "src", "answer");
  const offenders = listFilesRecursively(answerDir, ".ts").filter((f) => {
    const src = readFileSync(f, "utf8");
    return /@mastra\/core/.test(src) || /mastra\/compatibility_probe/.test(src);
  });
  assert.deepEqual(
    offenders,
    [],
    "src/answer/* must not import @mastra/core or the compatibility probe"
  );
});

test("T01 #6: src/index.ts does not import @mastra/core or the probe", () => {
  const indexSrc = readFileSync(path.join(REPO_ROOT, "src", "index.ts"), "utf8");
  assert.ok(
    !/@mastra\/core/.test(indexSrc),
    "src/index.ts must not import @mastra/core"
  );
  assert.ok(
    !/mastra\/compatibility_probe/.test(indexSrc),
    "src/index.ts must not import the compatibility probe"
  );
});

test("T01 #6: src/api does not import @mastra/core or the probe", () => {
  const apiDir = path.join(REPO_ROOT, "src", "api");
  if (!existsSync(apiDir)) return;
  const offenders = listFilesRecursively(apiDir, ".ts").filter((f) => {
    const src = readFileSync(f, "utf8");
    return /@mastra\/core/.test(src) || /mastra\/compatibility_probe/.test(src);
  });
  assert.deepEqual(offenders, []);
});

// ---------------------------------------------------------------------------
// Fake OpenAI-compatible fetch helpers.
//
// Mastra 1.51's default OpenAI gateway calls `/v1/responses` (the OpenAI
// Responses API), which uses an SSE event protocol with typed events:
//   event: response.created
//   data: {"type":"response.created","response":{...}}
//
//   event: response.output_text.delta
//   data: {"type":"response.output_text.delta","delta":"ok",...}
//
//   event: response.completed
//   data: {"type":"response.completed","response":{...}}
//
// The fakes below emit a minimal but valid Responses API SSE stream so
// Mastra's AI SDK consumes the stream successfully and does not enter its
// p-retry loop (which would otherwise produce unhandled rejections after
// the test ends).
//
// The fake honors the AbortSignal passed via init so the cancellation test
// can prove no late output is emitted after abort.
// ---------------------------------------------------------------------------

interface FakeResponseInit {
  ok: boolean;
  status: number;
  body: ReadableStream<Uint8Array>;
}

function makeFakeResponse(init: FakeResponseInit): Response {
  return new Response(init.body, {
    status: init.status,
    statusText: init.ok ? "OK" : "Error",
    headers: { "content-type": "text/event-stream" },
  });
}

function encodeSSE(event: string, data: unknown): Uint8Array {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  return new TextEncoder().encode(payload);
}

function makeFakeOpenAIStreamFetch(opts: {
  chunks: string[];
  delayMs: number;
}): unknown {
  return async function fakeFetch(
    _url: unknown,
    _init: unknown
  ): Promise<Response> {
    const signal = (_init as { signal?: AbortSignal } | null)?.signal;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(
          encodeSSE("response.created", {
            type: "response.created",
            response: { id: "resp_fake", status: "in_progress" },
          })
        );
        for (const chunk of opts.chunks) {
          if (signal?.aborted) {
            controller.close();
            return;
          }
          if (opts.delayMs > 0) {
            await new Promise((r) => setTimeout(r, opts.delayMs));
          }
          controller.enqueue(
            encodeSSE("response.output_text.delta", {
              type: "response.output_text.delta",
              delta: chunk,
              output_index: 0,
              content_index: 0,
            })
          );
        }
        controller.enqueue(
          encodeSSE("response.completed", {
            type: "response.completed",
            response: {
              id: "resp_fake",
              status: "completed",
              output: [
                {
                  id: "msg_fake",
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: opts.chunks.join("") }],
                },
              ],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          })
        );
        controller.close();
      },
    });
    return makeFakeResponse({ ok: true, status: 200, body: stream });
  };
}

function makeFakeSlowOpenAIStreamFetch(opts: {
  chunksPerSecond: number;
  totalChunks: number;
  onFirstChunk?: () => void;
}): unknown {
  return async function fakeFetch(
    _url: unknown,
    _init: unknown
  ): Promise<Response> {
    const signal = (_init as { signal?: AbortSignal } | null)?.signal;
    const intervalMs = 1000 / opts.chunksPerSecond;
    // Cancellation scenario:
    //   1. emit response.created (pre-abort, required by Responses API)
    //   2. emit first delta chunk (pre-abort — this is the in-flight chunk)
    //   3. fire onFirstChunk (triggers AbortController.abort())
    //   4. signal.aborted is now true → stop emitting, close the stream
    //
    // The probe's for-await loop reads chunks asynchronously. By the time
    // it reads the first delta chunk, signal.aborted may already be true
    // (because abort is synchronous but consumer reads happen on a later
    // microtask). The probe handles this by checking signal.aborted on
    // every chunk and breaking immediately if aborted — so even if the
    // in-flight chunk is read post-abort, no FURTHER chunks are processed.
    // That break is what `cancellationObservedNoLateOutput` certifies.
    //
    // We emit a valid OpenAI Responses API SSE sequence (response.created
    // → response.output_text.delta → response.completed) so Mastra's AI
    // SDK consumes the stream successfully instead of rejecting it for
    // missing protocol events.
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        if (signal?.aborted) {
          controller.close();
          return;
        }
        controller.enqueue(
          encodeSSE("response.created", {
            type: "response.created",
            response: { id: "resp_fake_slow", status: "in_progress" },
          })
        );
        controller.enqueue(
          encodeSSE("response.output_text.delta", {
            type: "response.output_text.delta",
            delta: "x",
            output_index: 0,
            content_index: 0,
          })
        );
        // Defer the abort so the consumer has a chance to read the first
        // delta chunk BEFORE signal.aborted flips. Mastra cancels the stream
        // synchronously when it observes abort, so if we fire abort before
        // the consumer reads, the in-flight chunk is discarded and
        // streamedAtLeastOneChunk stays false. We wait for a few microtasks
        // to give the for-await loop time to enter its first iteration.
        setTimeout(() => opts.onFirstChunk?.(), 10);
        // Wait one interval. If the signal aborted (which it will), close
        // without emitting further chunks.
        await new Promise((r) => setTimeout(r, intervalMs));
        if (signal?.aborted) {
          controller.close();
          return;
        }
        // Defensive: if abort somehow did not fire, emit the remaining
        // chunks and a completion event so the stream terminates cleanly.
        for (let i = 1; i < opts.totalChunks; i++) {
          if (signal?.aborted) {
            controller.close();
            return;
          }
          controller.enqueue(
            encodeSSE("response.output_text.delta", {
              type: "response.output_text.delta",
              delta: "x",
              output_index: 0,
              content_index: 0,
            })
          );
          await new Promise((r) => setTimeout(r, intervalMs));
        }
        controller.enqueue(
          encodeSSE("response.completed", {
            type: "response.completed",
            response: {
              id: "resp_fake_slow",
              status: "completed",
              output: [
                {
                  id: "msg_fake_slow",
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "x".repeat(opts.totalChunks) }],
                },
              ],
              usage: { input_tokens: 1, output_tokens: opts.totalChunks, total_tokens: opts.totalChunks + 1 },
            },
          })
        );
        controller.close();
      },
    });
    return makeFakeResponse({ ok: true, status: 200, body: stream });
  };
}

function listFilesRecursively(dir: string, ext: string): string[] {
  const out: string[] = [];
  const entries = readDirSyncSafe(dir);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursively(full, ext));
    } else if (entry.name.endsWith(ext)) {
      out.push(full);
    }
  }
  return out;
}

function readDirSyncSafe(dir: string): { name: string; isDirectory: () => boolean }[] {
  // Lazy require to keep the test file CommonJS-compatible under tsx.
  const fs = require("node:fs") as typeof import("node:fs");
  return fs.readdirSync(dir, { withFileTypes: true }).map((d) => ({
    name: d.name,
    isDirectory: () => d.isDirectory(),
  }));
}

function existsSync(p: string): boolean {
  const fs = require("node:fs") as typeof import("node:fs");
  return fs.existsSync(p);
}

// Suppress unused-import warning for fileURLToPath — kept for parity with
// other test files in the repo that use ESM-style __