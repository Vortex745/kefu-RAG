import assert from "node:assert/strict"
import test from "node:test"
import {
  RunBudgetAccountingError,
  RunBudgetExceededError,
  createModelCostEstimator,
  createRunContext,
  getCurrentRunContext,
  getRunResourceBudgetSnapshot,
  recordModelUsage,
  reserveModelCall,
  runBudgetRequiresUsage,
  runWithRunContext,
} from "./run_context"

test("run resource budget defaults to unlimited and preserves existing behavior", () => {
  const ctx = createRunContext()
  const reservation = reserveModelCall(ctx, { kind: "chat", model: "test-model" })

  recordModelUsage(ctx, reservation, {
    promptTokens: 3,
    completionTokens: 2,
    totalTokens: 5,
  })

  assert.deepEqual(getRunResourceBudgetSnapshot(ctx), {
    modelCalls: 1,
    promptTokens: 3,
    completionTokens: 2,
    totalTokens: 5,
    costMicros: 0,
    limits: {},
  })
  assert.equal(ctx.signal.aborted, false)
})

test("model calls are reserved atomically before invocation", () => {
  const ctx = createRunContext({
    resourceBudget: { limits: { maxModelCalls: 1 } },
  })

  reserveModelCall(ctx, { kind: "chat", model: "test-model" })
  assert.throws(
    () => reserveModelCall(ctx, { kind: "embedding", model: "embed-model" }),
    (error: unknown) => {
      assert.ok(error instanceof RunBudgetExceededError)
      assert.equal(error.dimension, "model_calls")
      assert.equal(error.code, "RUN_BUDGET_EXCEEDED")
      assert.equal(error.name, "AbortError")
      return true
    }
  )

  assert.equal(getRunResourceBudgetSnapshot(ctx).modelCalls, 1)
  assert.equal(ctx.signal.aborted, true)
})

test("zero model-call budget rejects the first provider call", () => {
  const ctx = createRunContext({
    resourceBudget: { limits: { maxModelCalls: 0 } },
  })

  assert.throws(
    () => reserveModelCall(ctx, { kind: "chat", model: "test-model" }),
    RunBudgetExceededError
  )
  assert.equal(getRunResourceBudgetSnapshot(ctx).modelCalls, 0)
})

test("aggregate tokens abort the shared run when post-call usage exceeds the limit", () => {
  const ctx = createRunContext({
    resourceBudget: { limits: { maxTokens: 10 } },
  })
  const first = reserveModelCall(ctx, { kind: "chat", model: "test-model" })
  const second = reserveModelCall(ctx, { kind: "chat", model: "test-model" })

  recordModelUsage(ctx, first, {
    promptTokens: 4,
    completionTokens: 2,
    totalTokens: 6,
  })
  assert.throws(
    () => recordModelUsage(ctx, second, {
      promptTokens: 3,
      completionTokens: 2,
      totalTokens: 5,
    }),
    (error: unknown) => {
      assert.ok(error instanceof RunBudgetExceededError)
      assert.equal(error.dimension, "tokens")
      assert.equal(error.actual, 11)
      assert.equal(error.limit, 10)
      return true
    }
  )

  assert.equal(getRunResourceBudgetSnapshot(ctx).totalTokens, 11)
  assert.equal(ctx.signal.aborted, true)
})

test("aggregate cost uses caller-supplied pricing and enforces the whole-run limit", () => {
  const ctx = createRunContext({
    resourceBudget: {
      limits: { maxCostMicros: 10 },
      estimateCostMicros: (_call, usage) => usage.totalTokens * 2,
    },
  })
  const reservation = reserveModelCall(ctx, { kind: "chat", model: "priced-model" })

  assert.throws(
    () => recordModelUsage(ctx, reservation, {
      promptTokens: 4,
      completionTokens: 2,
      totalTokens: 6,
    }),
    (error: unknown) => {
      assert.ok(error instanceof RunBudgetExceededError)
      assert.equal(error.dimension, "cost_micros")
      assert.equal(error.actual, 12)
      return true
    }
  )
  assert.equal(getRunResourceBudgetSnapshot(ctx).costMicros, 12)
})

test("duplicate usage settlement is idempotent but conflicting settlement is rejected", () => {
  const ctx = createRunContext()
  const reservation = reserveModelCall(ctx, { kind: "chat", model: "test-model" })
  const usage = { promptTokens: 2, completionTokens: 1, totalTokens: 3 }

  recordModelUsage(ctx, reservation, usage)
  recordModelUsage(ctx, reservation, usage)
  assert.equal(getRunResourceBudgetSnapshot(ctx).totalTokens, 3)

  assert.throws(
    () => recordModelUsage(ctx, reservation, {
      promptTokens: 3,
      completionTokens: 1,
      totalTokens: 4,
    }),
    RunBudgetAccountingError
  )
})

test("a configured token or cost limit fails closed when provider usage is unavailable", () => {
  const ctx = createRunContext({
    resourceBudget: { limits: { maxTokens: 10 } },
  })
  const reservation = reserveModelCall(ctx, { kind: "chat", model: "test-model" })

  assert.throws(
    () => recordModelUsage(ctx, reservation),
    (error: unknown) => {
      assert.ok(error instanceof RunBudgetAccountingError)
      assert.equal(error.code, "RUN_BUDGET_ACCOUNTING_ERROR")
      return true
    }
  )
  assert.equal(ctx.signal.aborted, true)
})

test("run context storage shares one authority within a run and isolates concurrent runs", async () => {
  const first = createRunContext()
  const second = createRunContext()

  await Promise.all([
    runWithRunContext(first, async () => {
      await Promise.resolve()
      assert.equal(getCurrentRunContext(), first)
      reserveModelCall(getCurrentRunContext()!, { kind: "chat", model: "first" })
    }),
    runWithRunContext(second, async () => {
      await Promise.resolve()
      assert.equal(getCurrentRunContext(), second)
      reserveModelCall(getCurrentRunContext()!, { kind: "chat", model: "second" })
    }),
  ])

  assert.equal(getCurrentRunContext(), undefined)
  assert.equal(getRunResourceBudgetSnapshot(first).modelCalls, 1)
  assert.equal(getRunResourceBudgetSnapshot(second).modelCalls, 1)
})

test("model pricing is exact-model, integer-microcurrency, and enables stream usage", () => {
  const estimator = createModelCostEstimator({
    "priced-model": {
      inputCostMicrosPerMillionTokens: 100_000,
      outputCostMicrosPerMillionTokens: 300_000,
    },
  })
  const ctx = createRunContext({
    resourceBudget: { estimateCostMicros: estimator },
  })

  assert.equal(runBudgetRequiresUsage(ctx), true)
  assert.equal(
    estimator(
      { kind: "chat", model: "priced-model" },
      { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
    ),
    3
  )
  assert.equal(
    estimator(
      { kind: "chat", model: "unknown-model" },
      { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
    ),
    undefined
  )
})
