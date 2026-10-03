/**
 * kilocode_change - guardian-owned MCP stdio transport (F-A).
 *
 * The third-party StdioClientTransport spawns via cross-spawn WITHOUT
 * detached (no owned group), so a wrapped guardian would not be the group
 * leader and descendants would leak. This transport mirrors the SDK
 * framing exactly (ReadBuffer/serializeMessage seam, stdin/stdout pipes,
 * stderr pipe/inherit, cwd/env passthrough, same start/close/send
 * semantics) but spawns the guardian DETACHED on POSIX, so the guardian
 * is the real group leader (pgid === pid) before the server executes.
 * No shell relay, no new packages: node:child_process + the SDK's own
 * shared stdio seam only. Windows uses the job-object path in the
 * guardian (no detached group); close() signals the exact guardian PID.
 */
import { spawn, type ChildProcess } from "node:child_process"
import { PassThrough } from "node:stream"
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js"
import { forceOwned, isOwned, registerOwned, termOwned } from "@/kilocode/process-resource/owned-termination"

export type GuardianServerParams = {
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  stderr?: "pipe" | "overlapped" | "inherit" | "ignore"
}

type Message = Parameters<typeof serializeMessage>[0]

export class GuardianStdioTransport {
  readonly isGuardian = true
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: Message, extra?: unknown) => void
  sessionId?: string | undefined

  private readonly params: GuardianServerParams
  private proc?: ChildProcess
  private readonly buf = new ReadBuffer()
  private readonly errStream: PassThrough | null

  constructor(params: GuardianServerParams) {
    this.params = params
    this.errStream = params.stderr === "pipe" || params.stderr === "overlapped" ? new PassThrough() : null
  }

  get stderr(): PassThrough | ChildProcess["stderr"] {
    if (this.errStream) return this.errStream
    return this.proc?.stderr ?? null
  }

  get pid(): number | null {
    return this.proc?.pid ?? null
  }

  async start(): Promise<void> {
    if (this.proc) throw new Error("GuardianStdioTransport already started")
    return new Promise<void>((resolve, reject) => {
      this.proc = spawn(this.params.command, this.params.args ?? [], {
        env: { ...this.params.env } as NodeJS.ProcessEnv,
        stdio: ["pipe", "pipe", this.params.stderr ?? "inherit"],
        shell: false,
        // Owned group BEFORE the server executes (POSIX). The guardian
        // verifies leadership at launch and refuses otherwise.
        detached: process.platform !== "win32",
        windowsHide: process.platform === "win32",
        cwd: this.params.cwd,
      })
      registerOwned(this.proc)
      this.proc.on("error", (error) => {
        reject(error)
        this.onerror?.(error)
      })
      this.proc.on("spawn", () => resolve())
      this.proc.on("close", () => {
        this.proc = undefined
        this.onclose?.()
      })
      this.proc.stdin?.on("error", (error) => {
        this.onerror?.(error)
      })
      this.proc.stdout?.on("data", (chunk: Buffer) => {
        this.buf.append(chunk)
        while (true) {
          try {
            const message = this.buf.readMessage()
            if (message === null) break
            this.onmessage?.(message as Message)
          } catch (error) {
            this.onerror?.(error instanceof Error ? error : new Error(String(error)))
          }
        }
      })
      this.proc.stdout?.on("error", (error) => {
        this.onerror?.(error)
      })
      if (this.errStream && this.proc.stderr) this.proc.stderr.pipe(this.errStream)
    })
  }

  async close(): Promise<void> {
    if (this.proc) {
      const target = this.proc
      this.proc = undefined
      const done = new Promise<void>((resolve) => {
        target.once("close", () => resolve())
      })
      const wait = (ms: number): Promise<void> =>
        new Promise((resolve) => {
          setTimeout(resolve, ms).unref()
        })
      const out = (): boolean => target.exitCode !== null || target.signalCode !== null
      try {
        target.stdin?.end()
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        this.onerror?.(error)
      }
      await Promise.race([done, wait(2000)])
      if (!out()) {
        if (isOwned(target)) {
          try {
            termOwned(target, "SIGTERM")
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err))
            this.onerror?.(error)
          }
        } else {
          try {
            target.kill("SIGTERM")
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err))
            this.onerror?.(error)
          }
        }
        await Promise.race([done, wait(2000)])
      }
      if (!out()) {
        if (isOwned(target)) {
          try {
            await forceOwned(target, { groupMs: 3000, exitMs: 5000 })
          } catch (err) {
            this.buf.clear()
            throw err instanceof Error ? err : new Error(String(err))
          }
          const shut = await Promise.race([done.then(() => true), wait(5000).then(() => false)])
          this.buf.clear()
          if (!shut) throw new Error("Owned guardian stdio did not close after verified SIGKILL; retaining authority, tree may survive")
          return
        }
        try {
          target.kill("SIGKILL")
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err))
          this.onerror?.(error)
        }
      }
    }
    this.buf.clear()
  }

  async send(message: Message): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.proc?.stdin) {
        reject(new Error("Not connected"))
        return
      }
      const json = serializeMessage(message)
      if (this.proc.stdin.write(json)) resolve()
      else this.proc.stdin.once("drain", () => resolve())
    })
  }
}
