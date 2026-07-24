export type MastraRuntimeMode = "limited" | "default"

export const MASTRA_RUNTIME_MODES: readonly MastraRuntimeMode[] = [
  "limited",
  "default",
] as const

export function parseMastraRuntimeMode(
  raw: string | undefined
): MastraRuntimeMode {
  const normalized = raw?.trim().toLowerCase()
  return normalized === "limited" ? "limited" : "default"
}

export function readMastraRuntimeMode(): MastraRuntimeMode {
  return parseMastraRuntimeMode(process.env.MASTRA_RUNTIME_MODE)
}
