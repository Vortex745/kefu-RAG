import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"

export async function findBoundedArtifact(
  root: string,
  outputLimitBytes: number,
  parserName: string,
  isCandidate: (path: string) => boolean,
  isPreferred?: (path: string) => boolean
): Promise<string> {
  const pending = [root]
  const artifacts: string[] = []
  let inspected = 0
  let totalBytes = 0

  while (pending.length > 0) {
    const directory = pending.shift()!
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw error
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      inspected += 1
      if (inspected > 128) {
        throw new Error(`malformed ${parserName} output: too many output artifacts`)
      }
      const path = join(directory, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isSymbolicLink()) {
        throw new Error(`malformed ${parserName} output: symbolic links are not allowed`)
      } else if (entry.isFile()) {
        totalBytes += (await stat(path)).size
        if (totalBytes > outputLimitBytes) {
          throw new Error(`${parserName} output exceeded ${outputLimitBytes} bytes`)
        }
        if (isCandidate(path)) artifacts.push(path)
      }
    }
  }

  const preferred = isPreferred ? artifacts.filter(isPreferred) : []
  const selected = preferred.length === 1
    ? preferred[0]
    : artifacts.length === 1
      ? artifacts[0]
      : undefined
  if (!selected) {
    throw new Error(`malformed ${parserName} output: expected one result artifact`)
  }
  return selected
}
