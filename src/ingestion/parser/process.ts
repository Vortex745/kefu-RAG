import { spawn } from "node:child_process"
import { readdir, stat } from "node:fs/promises"

export interface BoundedProcessInput {
  command: string
  args: string[]
  cwd?: string
  timeoutMs: number
  outputLimitBytes: number
  artifactLimit?: {
    root: string
    bytes: number
  }
  signal?: AbortSignal
}

async function boundedDirectorySize(root: string, limit: number): Promise<number> {
  const pending = [root]
  let total = 0
  while (pending.length > 0) {
    const directory = pending.shift()!
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw error
    }
    for (const entry of entries) {
      const path = `${directory}/${entry.name}`
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile()) {
        total += (await stat(path)).size
        if (total > limit) return total
      }
    }
  }
  return total
}

function safeSummary(
  head: Buffer,
  tail: Buffer,
  totalBytes: number,
  workspace?: string
): string {
  const captured = totalBytes <= tail.length
    ? tail
    : Buffer.concat([head, Buffer.from("\n...\n"), tail])
  const summary = captured
    .toString("utf8")
    .replace(/\s+/g, " ")
    .trim()
  const normalized = workspace
    ? summary.replaceAll(workspace, "<workspace>")
    : summary
  if (normalized.length <= 512) return normalized
  return `${normalized.slice(0, 160)} ... ${normalized.slice(-347)}`
}

export function runBoundedProcess(input: BoundedProcessInput): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    let stopError: Error | null = null
    let outputBytes = 0
    let stderrBytes = 0
    let stderrHead = Buffer.alloc(0)
    let stderrTail = Buffer.alloc(0)
    let artifactCheckRunning = false
    let artifactTimer: ReturnType<typeof setInterval> | undefined
    const stdout: Buffer[] = []

    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })

    const finish = (error?: Error, output?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (artifactTimer) clearInterval(artifactTimer)
      input.signal?.removeEventListener("abort", cancel)
      if (error) reject(error)
      else resolve(output ?? "")
    }
    const stop = (error: Error): void => {
      if (settled || stopError) return
      stopError = error
      try {
        child.kill("SIGKILL")
      } catch {
        finish(error)
      }
    }
    const cancel = (): void => stop(new Error("Parser process was cancelled"))
    const timer = setTimeout(
      () => stop(new Error(`Parser process timed out after ${input.timeoutMs}ms`)),
      input.timeoutMs
    )
    const checkArtifacts = async (): Promise<void> => {
      if (!input.artifactLimit || artifactCheckRunning || settled) return
      artifactCheckRunning = true
      try {
        const bytes = await boundedDirectorySize(
          input.artifactLimit.root,
          input.artifactLimit.bytes
        )
        if (bytes > input.artifactLimit.bytes) {
          stop(new Error(`Parser artifacts exceeded ${input.artifactLimit.bytes} bytes`))
        }
      } catch (error) {
        stop(new Error(
          `Parser artifact limit check failed: ${error instanceof Error ? error.message : String(error)}`
        ))
      } finally {
        artifactCheckRunning = false
      }
    }
    if (input.artifactLimit) {
      artifactTimer = setInterval(() => void checkArtifacts(), 25)
      void checkArtifacts()
    }

    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes > input.outputLimitBytes) {
        stop(new Error(`Parser output exceeded ${input.outputLimitBytes} bytes`))
        return
      }
      stdout.push(chunk)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length
      if (stderrHead.length < 2_048) {
        const remaining = 2_048 - stderrHead.length
        stderrHead = Buffer.concat([stderrHead, chunk.subarray(0, remaining)])
      }
      stderrTail = Buffer.concat([stderrTail, chunk])
      if (stderrTail.length > 4_096) {
        stderrTail = stderrTail.subarray(stderrTail.length - 4_096)
      }
    })
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (stopError) {
        finish(stopError)
        return
      }
      if (error.code === "ENOENT") {
        finish(new Error(`Parser executable is unavailable: ${input.command}`))
      } else {
        finish(new Error(`Parser process could not start: ${error.message}`))
      }
    })
    child.on("close", async (code) => {
      if (settled) return
      await checkArtifacts()
      if (stopError) {
        finish(stopError)
        return
      }
      if (code !== 0) {
        const summary = safeSummary(
          stderrHead,
          stderrTail,
          stderrBytes,
          input.cwd
        )
        finish(
          new Error(
            `Parser process exited with code ${code}${summary ? `: ${summary}` : ""}`
          )
        )
        return
      }
      finish(undefined, Buffer.concat(stdout).toString("utf8"))
    })

    input.signal?.addEventListener("abort", cancel, { once: true })
    if (input.signal?.aborted) cancel()
  })
}
