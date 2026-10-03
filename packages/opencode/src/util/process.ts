import { type ChildProcess } from "child_process"
import launch from "cross-spawn"
import { buffer } from "node:stream/consumers"
import { errorMessage } from "./error"
import { drainOwnedAfterExit, forceOwned, isOwned, registerOwned, termOwned } from "@/kilocode/process-resource/owned-termination"
import { shouldWrap, spawnWrapped } from "@/kilocode/process-resource/supervise"

export type Stdio = "inherit" | "pipe" | "ignore"
export type Shell = boolean | string

export interface Options {
  cwd?: string
  env?: NodeJS.ProcessEnv | null
  stdin?: Stdio
  stdout?: Stdio
  stderr?: Stdio
  shell?: Shell
  abort?: AbortSignal
  kill?: NodeJS.Signals | number
  timeout?: number
  /**
   * kilocode_change - guardian sidecar for nonpersistent children. Defaults
   * to supervised when a runtime token is present; pass false for explicit
   * persistent/daemon bypass (never supervised).
   */
  supervise?: boolean
}

export interface RunOptions extends Omit<Options, "stdout" | "stderr"> {
  nothrow?: boolean
}

export interface Result {
  code: number
  stdout: Buffer
  stderr: Buffer
}

export interface TextResult extends Result {
  text: string
}

export class RunFailedError extends Error {
  readonly cmd: string[]
  readonly code: number
  readonly stdout: Buffer
  readonly stderr: Buffer

  constructor(cmd: string[], code: number, stdout: Buffer, stderr: Buffer) {
    const text = stderr.toString().trim()
    super(
      text
        ? `Command failed with code ${code}: ${cmd.join(" ")}\n${text}`
        : `Command failed with code ${code}: ${cmd.join(" ")}`,
    )
    this.name = "ProcessRunFailedError"
    this.cmd = [...cmd]
    this.code = code
    this.stdout = stdout
    this.stderr = stderr
  }
}

export type Child = ChildProcess & { exited: Promise<number> }

export function spawn(cmd: string[], opts: Options = {}): Child {
  if (cmd.length === 0) throw new Error("Command is required")
  opts.abort?.throwIfAborted()

  // kilocode_change - prelaunch guardian ownership: when wrapping is
  // required the guardian is launched INSTEAD of the target (fail
  // closed: install absent/invalid throws with no target side effect).
  // proc.pid is then the owned group leader (real pgid); stdio/env/cwd
  // proxy through inherit so behavior is preserved. No delayed attach.
  if (shouldWrap({ supervise: opts.supervise })) {
    const targetEnv = opts.env === null ? {} : opts.env ? { ...process.env, ...opts.env } : { ...process.env }
    const guardian = spawnWrapped(
      { cmd: cmd[0]!, args: cmd.slice(1), shell: opts.shell ?? false },
      {
        cwd: opts.cwd,
        env: targetEnv,
        stdio: [opts.stdin ?? "ignore", opts.stdout ?? "ignore", opts.stderr ?? "ignore"],
        detached: process.platform !== "win32",
      },
    )
    registerOwned(guardian)
    return watch(guardian, opts)
  }

  const proc = launch(cmd[0], cmd.slice(1), {
    cwd: opts.cwd,
    shell: opts.shell,
    env: opts.env === null ? {} : opts.env ? { ...process.env, ...opts.env } : undefined,
    stdio: [opts.stdin ?? "ignore", opts.stdout ?? "ignore", opts.stderr ?? "ignore"],
    windowsHide: process.platform === "win32",
  })

  return watch(proc, opts)
}

function watch(proc: ChildProcess, opts: Options): Child {
  const child = proc as Child
  const owned = isOwned(proc)

  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let forceError: Error | undefined
  let forceDone: Promise<void> | undefined
  let forceStarted = false

  const force = async (): Promise<void> => {
    if (!isOwned(proc)) {
      proc.kill("SIGKILL")
      return
    }
    await forceOwned(proc)
  }

  const abort = () => {
    if (closed) return
    if (proc.exitCode !== null || proc.signalCode !== null) return
    closed = true

    if (owned) {
      const sig = opts.kill ?? "SIGTERM"
      if (typeof sig === "string") {
        try {
          termOwned(proc, sig)
        } catch (err) {
          forceError = err instanceof Error ? err : new Error(String(err))
        }
      } else {
        proc.kill(sig)
      }
    } else {
      proc.kill(opts.kill ?? "SIGTERM")
    }

    const ms = opts.timeout ?? 5_000
    if (ms <= 0) return
    timer = setTimeout(() => {
      forceStarted = true
      forceDone = force().catch((err: unknown) => {
        forceError = err instanceof Error ? err : new Error(String(err))
      })
    }, ms)
  }

  const exited = new Promise<number>((resolve, reject) => {
    const done = () => {
      opts.abort?.removeEventListener("abort", abort)
      if (timer) clearTimeout(timer)
    }

    proc.once("exit", (code, signal) => {
      if (owned && process.platform !== "win32") {
        if (forceStarted && forceDone) {
          void forceDone.then(() => {
            done()
            if (forceError) {
              reject(forceError)
              return
            }
            resolve(code ?? (signal ? 1 : 0))
          })
          return
        }
        void drainOwnedAfterExit(proc, 3000).then(
          () => {
            done()
            if (forceError) {
              reject(forceError)
              return
            }
            resolve(code ?? (signal ? 1 : 0))
          },
          (err: unknown) => {
            done()
            reject(err instanceof Error ? err : new Error(String(err)))
          },
        )
        return
      }
      done()
      resolve(code ?? (signal ? 1 : 0))
    })

    proc.once("error", (error) => {
      done()
      reject(error)
    })
  })
  void exited.catch(() => undefined)

  if (opts.abort) {
    opts.abort.addEventListener("abort", abort, { once: true })
    if (opts.abort.aborted) abort()
  }

  child.exited = exited
  return child
}

export async function run(cmd: string[], opts: RunOptions = {}): Promise<Result> {
  const proc = spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: opts.stdin,
    shell: opts.shell,
    abort: opts.abort,
    kill: opts.kill,
    timeout: opts.timeout,
    supervise: opts.supervise,
    stdout: "pipe",
    stderr: "pipe",
  })

  if (!proc.stdout || !proc.stderr) throw new Error("Process output not available")

  const out = await Promise.all([proc.exited, buffer(proc.stdout), buffer(proc.stderr)])
    .then(([code, stdout, stderr]) => ({
      code,
      stdout,
      stderr,
    }))
    .catch((err: unknown) => {
      if (!opts.nothrow) throw err
      return {
        code: 1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from(errorMessage(err)),
      }
    })
  if (out.code === 0 || opts.nothrow) return out
  throw new RunFailedError(cmd, out.code, out.stdout, out.stderr)
}

export async function stop(proc: ChildProcess) {
  if (proc.exitCode !== null || proc.signalCode !== null) return

  if (process.platform !== "win32" || !proc.pid) {
    proc.kill()
    return
  }

  const out = await run(["taskkill", "/pid", String(proc.pid), "/T", "/F"], {
    nothrow: true,
  })

  if (out.code === 0) return
  proc.kill()
}

export async function text(cmd: string[], opts: RunOptions = {}): Promise<TextResult> {
  const out = await run(cmd, opts)
  return {
    ...out,
    text: out.stdout.toString(),
  }
}

export async function lines(cmd: string[], opts: RunOptions = {}): Promise<string[]> {
  return (await text(cmd, opts)).text.split(/\r?\n/).filter(Boolean)
}

export * as Process from "./process"
