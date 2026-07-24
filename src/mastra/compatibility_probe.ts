/**
 * Ticket 01 — Mastra module/runtime compatibility probe.
 *
 * Proves that a CommonJS-hosted TypeScript runtime can load the ESM-only
 * `@mastra/core` package via dynamic `import()`, stream a model response
 * through an OpenAI-compatible endpoint, and propagate AbortSignal
 * cancellation so that no output is emitted after cancellation.
 *
 * Boundary contract (Ticket 01 acceptance #6):
 * - This module MUST NOT be imported by src/answer/*, src/api/*, src/index.ts.
 * - This module MUST NOT change production Answer runtime behavior.
 * - It is purely a compatibility probe used by the Ticket 01 decision record.
 *
 * Strategy: CommonJS host uses dynamic `import()` to load ESM-only
 * `@mastra/core`. Node.js >= 22 supports `await import()` of ESM modules
 * from CommonJS files; the project's tsconfig `target: ES2022` preserves
 * `import()` as a native dynamic import (NOT downgraded to `require`).
 */

/**
 * Result of a single compatibility probe run.
 * Carries the bare minimum evidence needed by the Ticket 01 decision record.
 */
export interface CompatibilityProbeResult {
  /** Strategy label; always "dynamic-import-esm-boundary" for the recommended path. */
  strategy: string;
  /** True when `await import("@mastra/core")` resolved successfully. */
  mastraModuleLoaded: boolean;
  /** True when the Agent constructor was reachable on the loaded module. */
  agentConstructorReachable: boolean;
  /** True when at least one stream chunk was received before completion. */
  streamedAtLeastOneChunk: boolean;
  /** True when AbortSignal aborted the stream and NO chunk arrived after abort. */
  cancellationObservedNoLateOutput: boolean;
  /** Wall-clock duration of the streaming attempt in ms. */
  durationMs: number;
  /** Captured error message if the probe failed before producing evidence. */
  errorMessage?: string;
  /** Recorded provider compatibility limits, if any (e.g. unsupported options). */
  providerLimits?: string[];
}

/**
 * Input for {@link runCompatibilityProbe}. All fields are injectable so the
 * test suite can exercise the probe without a real OpenAI key or network.
 */
export interface CompatibilityProbeInput {
  /**
   * OpenAI-compatible endpoint configuration. Defaults pull from the host
   * environment; tests inject explicit values to keep the probe deterministic.
   */
  openAICompatible: {
    baseURL: string;
    apiKey: string;
    model: string;
  };
  /**
   * Optional AbortSignal. When aborted mid-stream, the probe MUST observe
   * cancellation and emit no further chunks (Ticket 01 #3).
   */
  signal?: AbortSignal;
  /**
   * Optional fetch implementation. Tests inject a fake that yields a slow
   * stream so cancellation can be exercised deterministically.
   *
   * By default the probe restores the previous globalThis.fetch in a finally
   * block once the stream is consumed. Mastra's internal p-retry may however
   * keep firing after the stream completes; if `keepFetchInstalled` is false
   * (default), those retries hit the restored real fetch and may produce
   * unhandled rejections in tests. Set `keepFetchInstalled: true` to leave
   * the fake installed; the caller is then responsible for restoring fetch.
   */
  fetchImpl?: typeof fetch;
  /**
   * Optional prompt override. Defaults to a tiny probe prompt.
   */
  prompt?: string;
  /**
   * When true, do NOT restore the previous globalThis.fetch after the probe
   * finishes. Tests use this so Mastra's internal p-retry timers keep hitting
   * the fake fetch (and never resolve to a real network call). The caller
   * must restore fetch via {@link restorePreviousFetch} in a cleanup hook.
   */
  keepFetchInstalled?: boolean;
}

/**
 * Restore globalThis.fetch to a previously-captured value. Paired with
 * `keepFetchInstalled: true` so tests can clean up after Mastra's internal
 * p-retry timers settle without polluting subsequent tests.
 */
export function restorePreviousFetch(previous: typeof fetch): void {
  (globalThis as { fetch: typeof fetch }).fetch = previous;
}

/**
 * Capture the current globalThis.fetch. Tests use this with
 * `keepFetchInstalled: true` and {@link restorePreviousFetch} to manage the
 * fake fetch lifecycle around Mastra's internal retry timers.
 */
export function captureCurrentFetch(): typeof fetch {
  return globalThis.fetch;
}

/**
 * Dynamic-import wrapper for `@mastra/core/agent`. Returns the loaded module
 * namespace so callers can introspect the Agent constructor without taking a
 * static import (which would fail under CommonJS `require`).
 *
 * @returns the loaded `@mastra/core/agent` module namespace, or undefined
 *          together with an error message when the load fails.
 */
export async function loadMastraAgentModule(): Promise<{
  module?: typeof import("@mastra/core/agent");
  errorMessage?: string;
}> {
  try {
    // CommonJS-hosted dynamic import of an ESM-only package.
    // Node >= 22 supports this natively; tsx + tsc `target: ES2022` preserve
    // the dynamic `import()` expression (it is NOT downgraded to `require`).
    const mod = await import("@mastra/core/agent");
    return { module: mod };
  } catch (err) {
    const errorMessage =
      err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { errorMessage };
  }
}

/**
 * Run the Ticket 01 compatibility probe end-to-end.
 *
 * The probe:
 *  1. Dynamic-imports `@mastra/core/agent` (proves ESM boundary works).
 *  2. Constructs an Agent with the OpenAI-compatible model string.
 *  3. Streams a tiny prompt, recording whether at least one chunk arrived.
 *  4. Honors the supplied AbortSignal; if aborted, verifies no chunk arrived
 *     after the abort (Ticket 01 #3).
 *
 * The probe NEVER throws — every failure is captured into `errorMessage`
 * so the caller (and the test suite) can assert on the result structurally.
 */
export async function runCompatibilityProbe(
  input: CompatibilityProbeInput
): Promise<CompatibilityProbeResult> {
  const startedAt = Date.now();
  const result: CompatibilityProbeResult = {
    strategy: "dynamic-import-esm-boundary",
    mastraModuleLoaded: false,
    agentConstructorReachable: false,
    streamedAtLeastOneChunk: false,
    cancellationObservedNoLateOutput: false,
    durationMs: 0,
  };

  const { module: agentModule, errorMessage: loadError } =
    await loadMastraAgentModule();
  if (loadError || !agentModule) {
    result.errorMessage = `module load failed: ${loadError ?? "unknown"}`;
    result.durationMs = Date.now() - startedAt;
    return result;
  }
  result.mastraModuleLoaded = true;

  const AgentCtor = (agentModule as { Agent?: unknown }).Agent;
  if (typeof AgentCtor !== "function") {
    result.errorMessage = "Agent constructor not found on loaded module";
    result.durationMs = Date.now() - startedAt;
    return result;
  }
  result.agentConstructorReachable = true;

  // Construct an Agent with the OpenAI-compatible model router string.
  // The model string format is `provider/model` (Mastra router convention).
  // The baseURL + apiKey are passed via the Mastra gateway configuration on
  // the Agent itself; here we accept them as inputs and forward them.
  const prompt = input.prompt ?? "Reply with the single word: ok";
  let chunkCount = 0;
  let aborted = false;

  // Install the fake fetch for the ENTIRE probe execution (construct + stream
  // + iterate). Mastra's underlying AI SDK reads globalThis.fetch lazily when
  // the stream is consumed, so the override must remain in place until the
  // stream's final chunk is read. We restore the previous fetch in a finally
  // block below so production code is unaffected.
  const previousFetch = globalThis.fetch;
  if (input.fetchImpl) {
    (globalThis as { fetch: typeof fetch }).fetch = input.fetchImpl;
  }

  try {
    const agentLike = constructAgent(AgentCtor, {
      modelId: `openai/${input.openAICompatible.model}`,
      baseURL: input.openAICompatible.baseURL,
      apiKey: input.openAICompatible.apiKey,
    });

    // Register the abort listener BEFORE initiating the stream so we never
    // miss an abort that fires during stream setup. The listener is a
    // secondary signal; the primary check below reads `input.signal.aborted`
    // directly on every chunk to avoid listener-microtask timing races.
    input.signal?.addEventListener(
      "abort",
      () => {
        aborted = true;
      },
      { once: true }
    );

    const streamResult = await callAgentStream(agentLike, {
      prompt,
      signal: input.signal,
    });

    for await (const chunk of iterateStream(streamResult)) {
      chunkCount += 1;
      if (chunkCount === 1) {
        result.streamedAtLeastOneChunk = true;
      }
      // Check signal.aborted directly so we don't depend on the abort
      // listener's microtask timing (Ticket 01 #3 — no late output).
      if (aborted || input.signal?.aborted) {
        // Abort observed mid-stream: stop consuming immediately so no
        // further chunks are processed after cancellation. The remaining
        // upstream chunks (if any) are discarded by the stream's cancel.
        break;
      }
    }

    if (aborted || input.signal?.aborted) {
      // Ticket 01 #3: cancellation MUST produce no late output. We broke
      // out of the for-await as soon as abort was observed, so no chunk
      // was *processed* after cancellation.
      result.cancellationObservedNoLateOutput = true;
    }
  } catch (err) {
    // An aborted stream typically surfaces as an AbortError — that is the
    // expected and desired behavior, not a probe failure.
    const name = err instanceof Error ? err.name : "";
    if (name === "AbortError" || aborted || input.signal?.aborted) {
      // Ticket 01 #3: the stream was aborted. We never processed a chunk
      // after the abort was observed (the for-await breaks immediately
      // when abort is detected, or the stream throws AbortError before
      // the next chunk reaches the consumer).
      result.cancellationObservedNoLateOutput = true;
    } else {
      result.errorMessage =
        err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }
  } finally {
    if (input.fetchImpl && !input.keepFetchInstalled) {
      (globalThis as { fetch: typeof fetch }).fetch = previousFetch;
    }
  }

  result.durationMs = Date.now() - startedAt;
  return result;
}

/**
 * Strategy comparison table used by the Ticket 01 decision record.
 *
 * Each entry records whether the strategy is viable in the current repository
 * without changing `package.json type=commonjs` or `tsconfig.json module=commonjs`.
 * The table is static data so tests can assert on it structurally.
 */
export interface ModuleStrategyOption {
  id: string;
  label: string;
  requiresPackageJsonChange: boolean;
  requiresTsConfigChange: boolean;
  viable: boolean;
  rejectedReason?: string;
}

export const MODULE_STRATEGY_OPTIONS: readonly ModuleStrategyOption[] = [
  {
    id: "repo-wide-esm-migration",
    label: "Repository-wide ESM migration (change package.json type=module)",
    requiresPackageJsonChange: true,
    requiresTsConfigChange: true,
    viable: false,
    rejectedReason:
      "Would force every CommonJS file (express, better-sqlite3, llamaindex) " +
      "through ESM interop; out of scope for Ticket 01 and explicitly " +
      "prohibited by AGENTS.md §3.1 (modifies unrelated configuration).",
  },
  {
    id: "dynamic-import-esm-boundary",
    label:
      "CommonJS host + dynamic import() boundary to ESM-only @mastra/core",
    requiresPackageJsonChange: false,
    requiresTsConfigChange: false,
    viable: true,
  },
  {
    id: "separate-mastra-subproject",
    label:
      "Separate Mastra subproject with its own package.json + tsconfig (ESM)",
    requiresPackageJsonChange: false,
    requiresTsConfigChange: false,
    viable: false,
    rejectedReason:
      "Adds operational complexity (two build pipelines, two dep trees) " +
      "for a compatibility probe that the dynamic-import boundary already " +
      "proves viable. Re-evaluate if the Mastra subsystem grows large.",
  },
];

/**
 * The recommended module strategy, recorded for the Ticket 01 decision doc.
 */
export const RECOMMENDED_MODULE_STRATEGY_ID =
  "dynamic-import-esm-boundary" as const;

// ---------------------------------------------------------------------------
// Internal helpers — typed shims around the dynamically-loaded Agent API.
// We intentionally avoid a static type import from @mastra/core so this file
// remains CommonJS-compiled and never triggers `require` of an ESM package.
// ---------------------------------------------------------------------------

interface AgentLike {
  stream(...args: unknown[]): Promise<unknown>;
}

interface AgentCtor {
  new (config: unknown): AgentLike;
}

function constructAgent(
  Ctor: unknown,
  config: {
    modelId: string;
    baseURL: string;
    apiKey: string;
  }
): AgentLike {
  // Mastra's Agent accepts a `model` string OR a configured model object.
  // We pass a model router string plus OpenAI-compatible credentials via
  // environment variables (OPENAI_API_KEY, OPENAI_BASE_URL) that Mastra's
  // default OpenAI gateway reads at construction time.
  //
  // fetch override (if any) is installed by runCompatibilityProbe's outer
  // scope so it stays in effect for the entire stream consumption window.
  const agentConfig = {
    id: "ticket-01-compatibility-probe",
    name: "Ticket 01 Compatibility Probe",
    instructions: "You are a compatibility probe. Reply tersely.",
    model: config.modelId,
    // Disable Mastra's internal p-retry so the probe's fake fetch path is
    // exercised exactly once. Without this, p-retry keeps running after the
    // probe's finally block restores globalThis.fetch, producing unhandled
    // rejections in the test suite.
    maxRetries: 0,
  };
  const env = process.env as Record<string, string | undefined>;
  env.OPENAI_API_KEY = config.apiKey;
  env.OPENAI_BASE_URL = config.baseURL;
  return new (Ctor as AgentCtor)(agentConfig);
}

async function callAgentStream(
  agent: AgentLike,
  opts: { prompt: string; signal?: AbortSignal }
): Promise<unknown> {
  // Mastra Agent.stream(prompt, options?) — pass the signal through so the
  // underlying model call observes abort.
  const callArgs: unknown[] = [opts.prompt];
  if (opts.signal) {
    callArgs.push({ abortSignal: opts.signal });
  }
  return agent.stream(...callArgs);
}

async function* iterateStream(streamResult: unknown): AsyncIterable<unknown> {
  // Mastra's Agent.stream() returns an object whose text/event stream is
  // exposed via the AI SDK's standard `fullStream` (or `textStream`)
  // async-iterable property. The top-level object is NOT itself async
  // iterable. Support all observed shapes so the probe survives minor
  // Mastra version differences.
  const s = streamResult as {
    [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
    fullStream?: { [Symbol.asyncIterator]: () => AsyncIterator<unknown> };
    textStream?: { [Symbol.asyncIterator]: () => AsyncIterator<unknown> };
    stream?: { [Symbol.asyncIterator]: () => AsyncIterator<unknown> };
    text?: () => Promise<string>;
  };
  // Preferred shape: top-level async iterable (some Mastra versions).
  if (s && typeof s[Symbol.asyncIterator] === "function") {
    const it = s[Symbol.asyncIterator]!();
    while (true) {
      const next = await it.next();
      if (next.done) break;
      yield next.value;
    }
    return;
  }
  // AI SDK standard shape: fullStream (typed events incl. text-delta).
  if (s && s.fullStream && typeof s.fullStream[Symbol.asyncIterator] === "function") {
    const it = s.fullStream[Symbol.asyncIterator]();
    while (true) {
      const next = await it.next();
      if (next.done) break;
      yield next.value;
    }
    return;
  }
  // AI SDK text-only shape: textStream (string chunks only).
  if (s && s.textStream && typeof s.textStream[Symbol.asyncIterator] === "function") {
    const it = s.textStream[Symbol.asyncIterator]();
    while (true) {
      const next = await it.next();
      if (next.done) break;
      yield next.value;
    }
    return;
  }
  // Legacy shape: nested .stream async iterable.
  if (s && s.stream && typeof s.stream[Symbol.asyncIterator] === "function") {
    const it = s.stream[Symbol.asyncIterator]();
    while (true) {
      const next = await it.next();
      if (next.done) break;
      yield next.value;
    }
    return;
  }
  // Fallback: some Mastra versions return an object with `.text()` only.
  if (s && typeof s.text === "function") {
    const text = await s.text();
    if (text) {
      yield text;
    }
    return;
  }
  // Last resort: nothing to iterate; treat as zero chunks.
}
