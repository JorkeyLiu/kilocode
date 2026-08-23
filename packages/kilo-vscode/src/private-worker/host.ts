import type { ChildProcess } from "child_process"
import { spawn } from "../util/process"
import { JsonRpcPeer, type PeerState } from "./peer"
import { StderrTail } from "../services/cli-backend/stderr-tail"
import * as path from "path"
import * as fs from "fs"
import { isAbsolute } from "path"

export function isStandaloneEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KILO_PRIVATE_WORKER_STANDALONE === "1" && typeof env.KILO_DB === "string" && isAbsolute(env.KILO_DB)
}

// Local resolver helper for testability (bounded)
export function resolveWorkerArtifact(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!isStandaloneEnabled(env)) return undefined
  const candidates = [
    path.join(__dirname, "private-worker/standalone-worker.mjs"),
    path.join(__dirname, "standalone-worker.mjs"),
  ]
  for (const p of candidates) if (fs.existsSync(p)) return p
  return undefined
}

/**
 * Extension-owned private worker host for R1 scaffold.
 * Spawns one headless worker child over stdio, performs initialize handshake
 * replacing port detection/health, and owns lifecycle via EOF/exit.
 * Requests are commands, notifications are event envelopes (scaffold).
 * Stderr is bounded via StderrTail (16 KiB / 100 lines). Does NOT interrupt
 * generations or introduce process-global config convergence (LOCK-011).
 */

export interface HostOptions {
  // Override for tests: custom spawn command and args. Defaults to the
  // bundled private worker artifact at dist/private-worker/worker.js.
  command?: string
  args?: string[]
  env?: NodeJS.ProcessEnv
  initializeTimeoutMs?: number
  onNotification?: (method: string, params: unknown) => void
}

export class PrivateWorkerHost {
  private proc: ChildProcess | null = null
  private peer: JsonRpcPeer | null = null
  private readonly stderrTail: StderrTail
  private state: PeerState = "open"
  private stderrHandler: ((chunk: Buffer) => void) | null = null
  private stderrTarget: NodeJS.ReadableStream | null = null
  private exitHandler: (() => void) | null = null
  private closeHandler: (() => void) | null = null

  constructor(private readonly opts: HostOptions = {}) {
    this.stderrTail = new StderrTail({
      onLine: (line) => {
        // Bounded diagnostics — relay to extension console without unbounded retention.
        console.error("[Kilo PrivateWorker] stderr:", line)
      },
    })
  }

  /**
   * Spawn the worker child and perform initialize handshake. Returns the
   * versioned identity. Rejects if handshake fails or child exits.
   */
  async start(): Promise<unknown> {
    if (this.proc) throw new Error("Already started")
    const { command, args } = this.resolveCommand()
    this.proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.opts.env },
    })
    if (!this.proc.stdout || !this.proc.stdin || !this.proc.stderr) {
      throw new Error("Worker stdio not available")
    }
    const onData = (chunk: Buffer) => this.stderrTail.write(chunk)
    const onExit = () => {
      this.stderrTail.flush()
      this.state = "closed"
    }
    const onClose = () => {
      this.stderrTail.flush()
      this.state = "closed"
    }
    this.stderrHandler = onData
    this.stderrTarget = this.proc.stderr
    this.exitHandler = onExit
    this.closeHandler = onClose
    this.proc.stderr.on("data", onData as unknown as (c: unknown) => void)
    this.proc.on("exit", onExit as unknown as () => void)
    this.proc.on("close", onClose as unknown as () => void)
    this.peer = new JsonRpcPeer({
      reader: this.proc.stdout,
      writer: this.proc.stdin,
      child: this.proc,
      onNotification: this.opts.onNotification,
    })
    // Initialize handshake replaces port detection/health (R1) with bounded timeout.
    const timeoutMs = this.opts.initializeTimeoutMs ?? 5000
    const init = this.peer.request("initialize", {
      clientInfo: { name: "kilo-vscode", version: "7.4.11" },
      protocolVersion: "1.0",
    })
    // Attach rejection handler to losing promise to avoid unhandled rejection when timeout wins.
    void init.catch(() => {})
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`initialize timed out after ${timeoutMs}ms`)), timeoutMs)
    })
    try {
      const result = await Promise.race([init, timeout])
      if (timer) clearTimeout(timer)
      return result
    } catch (e) {
      if (timer) clearTimeout(timer)
      // Ensure pending initialize is rejected and child is torn down.
      this.dispose()
      throw e
    }
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (!this.peer) throw new Error("Not started")
    return this.peer.request(method, params)
  }

  notify(method: string, params?: unknown): void {
    this.peer?.notify(method, params)
  }

  getState(): PeerState {
    if (this.peer) return this.peer.getState()
    return this.state
  }

  getStderrTail(): string[] {
    return this.stderrTail.tail()
  }

  getPendingStderr(): string {
    return this.stderrTail.pending()
  }

  /**
   * Bounded awaitable shutdown for reconnect lease-release races.
   * Captures exact child ownership (single PID), kills the exact child,
   * and waits boundedly for exit/close without global kills or unbounded waits.
   * Exact listener cleanup — only the awaited PID's listeners are touched.
   * Returns true if the child exited within timeout, false if timeout expired.
   */
  async shutdown(timeoutMs = 2000): Promise<boolean> {
    const proc = this.proc
    if (!proc) {
      this.dispose()
      return true
    }
    if (proc.exitCode !== null || proc.signalCode !== null) {
      this.dispose()
      return true
    }
    // Attach exact listeners before dispose kills the PID
    let timer: ReturnType<typeof setTimeout> | null = null
    let done = false
    const exited = new Promise<boolean>((resolve) => {
      const onExit = () => {
        if (done) return
        done = true
        if (timer) clearTimeout(timer)
        try {
          proc.off?.("exit", onExit as unknown as () => void)
        } catch {}
        try {
          proc.removeListener?.("exit", onExit as unknown as () => void)
        } catch {}
        try {
          proc.off?.("close", onExit as unknown as () => void)
        } catch {}
        try {
          proc.removeListener?.("close", onExit as unknown as () => void)
        } catch {}
        resolve(true)
      }
      try {
        proc.on("exit", onExit as unknown as () => void)
      } catch {}
      try {
        proc.on("close", onExit as unknown as () => void)
      } catch {}
      timer = setTimeout(() => {
        if (done) return
        done = true
        try {
          proc.off?.("exit", onExit as unknown as () => void)
        } catch {}
        try {
          proc.removeListener?.("exit", onExit as unknown as () => void)
        } catch {}
        try {
          proc.off?.("close", onExit as unknown as () => void)
        } catch {}
        try {
          proc.removeListener?.("close", onExit as unknown as () => void)
        } catch {}
        resolve(false)
      }, timeoutMs)
      if ((timer as unknown as { unref?: () => void })?.unref) (timer as unknown as { unref: () => void }).unref()
    })
    // Dispose kills the exact PID synchronously and cleans internal handlers
    this.dispose()
    return exited
  }

  dispose(): void {
    this.peer?.dispose()
    this.peer = null
    if (this.proc) {
      if (this.stderrHandler && this.stderrTarget) {
        try {
          const t = this.stderrTarget as unknown as { off?: (e: string, h: unknown) => void; removeListener?: (e: string, h: unknown) => void }
          const off = t.off ?? t.removeListener
          off?.call(t, "data", this.stderrHandler as unknown as never)
        } catch {
          // ignore
        }
      }
      if (this.exitHandler) {
        try {
          const c = this.proc as unknown as { off?: (e: string, h: unknown) => void; removeListener?: (e: string, h: unknown) => void }
          const off = c.off ?? c.removeListener
          off?.call(c, "exit", this.exitHandler as unknown as never)
        } catch {
          // ignore
        }
      }
      if (this.closeHandler) {
        try {
          const c = this.proc as unknown as { off?: (e: string, h: unknown) => void; removeListener?: (e: string, h: unknown) => void }
          const off = c.off ?? c.removeListener
          off?.call(c, "close", this.closeHandler as unknown as never)
        } catch {
          // ignore
        }
      }
      try {
        this.proc.kill()
      } catch {
        // ignore
      }
      this.proc = null
    }
    this.stderrHandler = null
    this.stderrTarget = null
    this.exitHandler = null
    this.closeHandler = null
    this.stderrTail.flush()
    this.state = "closed"
  }

  private resolveCommand(): { command: string; args: string[] } {
    if (this.opts.command) {
      return { command: this.opts.command, args: this.opts.args ?? [] }
    }
    const effectiveEnv = { ...process.env, ...this.opts.env } as NodeJS.ProcessEnv
    const standalone = resolveWorkerArtifact(effectiveEnv)
    if (standalone) return { command: process.execPath, args: [standalone] }
    // Resolvable packaged worker artifact emitted by esbuild (dist/private-worker/worker.js).
    const candidates = [
      path.join(__dirname, "private-worker/worker.js"),
      path.join(__dirname, "worker.js"),
    ]
    for (const p of candidates) {
      if (fs.existsSync(p)) return { command: process.execPath, args: [p] }
    }
    throw new Error("No worker entrypoint found — build the private worker (run esbuild) or provide host command override")
  }
}
