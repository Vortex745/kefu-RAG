import type OpenAI from "openai"
import {
  getCurrentRunContext,
  recordModelUsage,
  reserveModelCall,
  runBudgetRequiresUsage,
  type ModelUsage,
} from "./run_context"

type UnknownRecord = Record<string, unknown>
type CreateMethod = (...args: unknown[]) => Promise<unknown>

/**
 * Instrument the two OpenAI SDK model-call surfaces used by this process.
 * Outside an active Answer Run the proxy is a transparent pass-through.
 */
export function createRunBudgetedOpenAIClient(client: OpenAI): OpenAI {
  const chat = client.chat?.completions
    ? proxyResource(client.chat, "completions", (create) =>
      async function budgetedChatCreate(...args: unknown[]): Promise<unknown> {
        const ctx = getCurrentRunContext()
        if (!ctx) return create(...args)

        const request = asRecord(args[0])
        const reservation = reserveModelCall(ctx, {
          kind: "chat",
          model: stringField(request, "model"),
        })
        const forwardedArgs = [...args]
        if (request.stream === true && runBudgetRequiresUsage(ctx)) {
          forwardedArgs[0] = {
            ...request,
            stream_options: {
              ...asRecord(request.stream_options),
              include_usage: true,
            },
          }
        }

        const result = await create(...forwardedArgs)
        if (isAsyncIterable(result)) {
          return settleStream(result, ctx, reservation)
        }
        recordModelUsage(ctx, reservation, extractUsage(result))
        return result
      }
    )
    : client.chat

  const embeddingResource = (client as unknown as {
    embeddings?: { create?: unknown }
  }).embeddings
  const embeddings = embeddingResource && typeof embeddingResource.create === "function"
    ? new Proxy(client.embeddings, {
      get(target, property, receiver) {
        if (property !== "create") return Reflect.get(target, property, receiver)
        const create = target.create.bind(target) as CreateMethod
        return async (...args: unknown[]): Promise<unknown> => {
          const ctx = getCurrentRunContext()
          if (!ctx) return create(...args)
          const request = asRecord(args[0])
          const reservation = reserveModelCall(ctx, {
            kind: "embedding",
            model: stringField(request, "model"),
          })
          const result = await create(...args)
          recordModelUsage(ctx, reservation, extractUsage(result))
          return result
        }
      },
    })
    : client.embeddings

  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === "chat") return chat
      if (property === "embeddings") return embeddings
      return Reflect.get(target, property, receiver)
    },
  })
}

function proxyResource<T extends object>(
  resource: T,
  childKey: keyof T,
  wrapCreate: (create: CreateMethod) => CreateMethod
): T {
  const child = resource[childKey] as object & { create: CreateMethod }
  const proxiedChild = new Proxy(child, {
    get(target, property, receiver) {
      if (property === "create") {
        return wrapCreate(target.create.bind(target))
      }
      return Reflect.get(target, property, receiver)
    },
  })
  return new Proxy(resource, {
    get(target, property, receiver) {
      if (property === childKey) return proxiedChild
      return Reflect.get(target, property, receiver)
    },
  })
}

async function* settleStream(
  stream: AsyncIterable<unknown>,
  ctx: NonNullable<ReturnType<typeof getCurrentRunContext>>,
  reservation: ReturnType<typeof reserveModelCall>
): AsyncIterable<unknown> {
  let usage: ModelUsage | undefined
  let completed = false
  try {
    for await (const chunk of stream) {
      usage = extractUsage(chunk) ?? usage
      yield chunk
    }
    completed = true
  } finally {
    if (completed || (runBudgetRequiresUsage(ctx) && !ctx.signal.aborted)) {
      recordModelUsage(ctx, reservation, usage)
    }
  }
}

function extractUsage(value: unknown): ModelUsage | undefined {
  const usage = asRecord(asRecord(value).usage)
  const promptTokens = numberField(usage, "prompt_tokens")
  const totalTokens = numberField(usage, "total_tokens")
  if (promptTokens === undefined || totalTokens === undefined) return undefined
  return {
    promptTokens,
    completionTokens: numberField(usage, "completion_tokens") ?? 0,
    totalTokens,
  }
}

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object"
    ? value as UnknownRecord
    : {}
}

function stringField(record: UnknownRecord, field: string): string {
  return typeof record[field] === "string" ? record[field] as string : "unknown"
}

function numberField(record: UnknownRecord, field: string): number | undefined {
  return typeof record[field] === "number" ? record[field] as number : undefined
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return value !== null &&
    typeof value === "object" &&
    Symbol.asyncIterator in value
}
