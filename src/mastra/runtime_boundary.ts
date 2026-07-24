import type { AnswerRunEvent } from "../types"
import type { AnswerRunOptions } from "../answer/generation"
import type { MastraChatEventSource } from "./chat_event_adapter"
import {
  readMastraRuntimeMode,
  type MastraRuntimeMode,
} from "./runtime_mode"

export type ModeAwareEventsSource = (
  message: string,
  options: AnswerRunOptions
) => AsyncIterable<AnswerRunEvent>

export interface ModeAwareEventsSourceOptions {
  mastraSource: MastraChatEventSource
  modeReader?: () => MastraRuntimeMode
}

function validateOptions(options: ModeAwareEventsSourceOptions): void {
  if (typeof options.mastraSource !== "function") {
    throw new Error(
      "createModeAwareEventsSource: mastraSource must be a function. Got: " +
      typeof options.mastraSource
    )
  }
  if (
    options.modeReader !== undefined &&
    typeof options.modeReader !== "function"
  ) {
    throw new Error(
      "createModeAwareEventsSource: modeReader must be a function or undefined. " +
      "Got: " + typeof options.modeReader
    )
  }
}

export function createModeAwareEventsSource(
  options: ModeAwareEventsSourceOptions
): ModeAwareEventsSource {
  validateOptions(options)
  const { mastraSource, modeReader = readMastraRuntimeMode } = options

  return async function* modeAwareEventsSource(
    message: string,
    runOptions: AnswerRunOptions
  ): AsyncGenerator<AnswerRunEvent> {
    modeReader()
    yield* mastraSource(message, runOptions)
  }
}

export interface MastraRuntimeBoundary {
  eventsSource: ModeAwareEventsSource
  close: () => Promise<void>
  mode: () => MastraRuntimeMode
  hasMastraSource: true
}

export function createMastraRuntimeBoundary(
  options: ModeAwareEventsSourceOptions
): MastraRuntimeBoundary {
  const eventsSource = createModeAwareEventsSource(options)
  const modeReader = options.modeReader ?? readMastraRuntimeMode

  return {
    eventsSource,
    mode: modeReader,
    hasMastraSource: true,
    close: async () => Promise.resolve(),
  }
}
