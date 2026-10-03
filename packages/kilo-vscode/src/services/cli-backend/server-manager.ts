import { type ChildProcess } from "child_process"
import { spawn } from "../../util/process"
import * as crypto from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"
import { resolveLocalBwrapEnv, resolveTreeSitterEnv } from "./cli-resources"
import { t } from "./i18n"
import { parseServerPort } from "./server-utils"
import { StderrTail } from "./stderr-tail"
import {
  RUNTIME_TOKEN_ENV,
  cleanupOwnedProcesses,
  createRuntimeToken,
  isValidRuntimeToken,
} from "./server-resource-cleanup"
import { LlmRequestCollector, type LlmRequestRecord } from "./llm-request-collector"
import { p0Stage, isP0PerfEnabled } from "../../perf/perf-instrument"
import { resolveCanonicalDbPath } from "../../private-worker/canonical-db-path"
import { isE2EFixtureEnabled, isValidE2EScratch, isValidE2EProviderEnv } from "../../util/e2e-fixture"

export interface ServerInstance {
  port: number
  password: string
  process: ChildProcess
  privateReader: NodeJS.ReadableStream | null
  privateWriter: NodeJS.WritableStream | null
  pid: number | undefined
  epoch: number
  spawnCwd: string
  /** Cryptographically unique ownership token inherited by runtime children. */
  token: string
}

/** Crashed-instance identity retained for token-verified cleanup before replacement. */
export interface CrashedInstanceIdentity {
  epoch: number
  token: string
  pid: number | undefined
}

const STARTUP_TIMEOUT_SECONDS = 30
const CUTOVER_TIMEOUT_MS = 30_000
const HIDDEN_SIGKILL_DELAY_MS = 5_000

type WorkspaceFolderLike = { uri: { fsPath: string } }

/**
 * Resolve the CLI binary for hidden storage commands.
 * Production prefers the lightweight serve-only `bin/kilo-serve` backend
 * when staged, falling back to the full `bin/kilo` binary during the
 * transition window where kilo-serve may be absent (dev wrapper / older
 * bundle). Both entries accept the same `__internal-storage-cutover`
 * hidden command, so args remain unchanged — only the path varies. The
 * hidden child never receives `KILO_PRIVATE_RUNTIME`; serve children do
 * via `buildServeChildEnvAugment`. Prefer the same resolved serve binary
 * that `resolveCliPath` would pick so storage cutover and serve run from
 * the same artifact.
 */
export function resolveHiddenCliPath(extensionPath: string, env?: NodeJS.ProcessEnv): string {
  const override = env?.KILO_P0_BACKEND_CLI
  if (override && override.trim() !== "") return override
  const serve = path.join(extensionPath, "bin", resolveServeBinaryName())
  try {
    if (fs.existsSync(serve)) return serve
  } catch {
    // fail-closed to full CLI fallback
  }
  return path.join(extensionPath, "bin", resolveFullBinaryName())
}

function parseCutoverJson(stdout: string): Record<string, unknown> {
  const lines = stdout
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    try {
      const obj = JSON.parse(line) as Record<string, unknown>
      if (obj && obj.ok === true) return obj
    } catch {
      continue
    }
  }
  throw new Error(`hidden cutover output missing ok JSON: ${stdout.slice(0, 2000)}`)
}
type ServerExitListener = (code: number | null) => void

type ChildLike = Pick<ChildProcess, "exitCode" | "signalCode">

/**
 * Signal-aware liveness: Node keeps `exitCode === null` both while running
 * AND after signal termination (`signalCode !== null`). Only
 * `exitCode === null && signalCode == null` means still running.
 * Hidden `detached:false` children and serve `detached:true` children share
 * this predicate; the kill path still differs (killDirect vs killGroup).
 */
export function isChildAlive(proc: ChildLike | null | undefined): boolean {
  if (!proc) return false
  return proc.exitCode === null && (proc.signalCode === null || proc.signalCode === undefined)
}

/** Signal-aware death: numeric exit OR signal termination. Never cached as live, never re-killed. */
export function isChildDead(proc: ChildLike | null | undefined): boolean {
  if (!proc) return false
  return proc.exitCode !== null || (proc.signalCode !== null && proc.signalCode !== undefined)
}

function describeChildExit(proc: ChildLike): string {
  return `code ${String(proc.exitCode ?? "null")} signal ${String(proc.signalCode ?? "null")}`
}

export function isValidE2EBaseURLForServerManager(value: string | undefined): boolean {
  if (!value) return false
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") return false
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return false
    if (url.username || url.password) return false
    if (url.search || url.hash) return false
    if (url.pathname !== "/v1") return false
    return true
  } catch {
    return false
  }
}

export function validatedE2EProviderEnv(): Record<string, string | undefined> {
  // Exact run-bound gate: fixture=="1" plus scratch shape + marker + loopback /v1
  // Marker proves scratch belongs to current harness run (not any absolute path).
  // Uses static import; loader failure is fail-closed (no env forwarded).
  const baseURL = process.env.KILO_E2E_PROVIDER_BASE_URL
  if (!isE2EFixtureEnabled()) return { KILO_E2E_PROVIDER_BASE_URL: undefined }
  try {
    if (!isValidE2EProviderEnv(process.env)) return { KILO_E2E_PROVIDER_BASE_URL: undefined }
  } catch {
    return { KILO_E2E_PROVIDER_BASE_URL: undefined }
  }
  if (!isValidE2EBaseURLForServerManager(baseURL)) return { KILO_E2E_PROVIDER_BASE_URL: undefined }
  return { KILO_E2E_PROVIDER_BASE_URL: baseURL }
}

function isFixtureScratchGateValid(): boolean {
  if (!isE2EFixtureEnabled()) return false
  try {
    return isValidE2EScratch(process.env.KILO_E2E_SCRATCH)
  } catch {
    return false
  }
}

function resolveE2EFixtureChildEnv(): Record<string, string> {
  if (!isE2EFixtureEnabled()) return {}
  const out: Record<string, string> = {}
  if (isFixtureScratchGateValid() && process.env.KILO_E2E_SCRATCH) out.KILO_E2E_SCRATCH = process.env.KILO_E2E_SCRATCH
  if (process.env.KILO_E2E_FIXTURE) out.KILO_E2E_FIXTURE = process.env.KILO_E2E_FIXTURE
  if (process.env.KILO_E2E_FIXTURE_ID) out.KILO_E2E_FIXTURE_ID = process.env.KILO_E2E_FIXTURE_ID
  return out
}

export function resolveServerCwd(folders: readonly WorkspaceFolderLike[] | undefined, storage: string): string {
  return folders?.[0]?.uri.fsPath ?? storage
}

export function resolveManagedServerEnv(env: NodeJS.ProcessEnv, canonicalOverride?: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, KILO_DISABLE_CHANNEL_DB: "true" }
  let canonical: string | undefined
  if (canonicalOverride !== undefined) {
    if (canonicalOverride.trim() === "") canonical = undefined
    else if (path.isAbsolute(canonicalOverride)) canonical = canonicalOverride
    else canonical = undefined
  } else {
    try {
      const resolved = resolveCanonicalDbPath({ env, homedir: os.homedir() })
      if (path.isAbsolute(resolved)) canonical = resolved
    } catch {
      canonical = undefined
    }
  }
  if (canonical && path.isAbsolute(canonical)) {
    out.KILO_DB = canonical
  } else {
    delete out.KILO_DB
  }
  return out
}

/**
 * Hidden cutover child must never see the internal private marker even when
 * the extension host env has KILO_PRIVATE_RUNTIME=1. Cleanly omit the key
 * (delete) rather than setting `undefined` which would become string "undefined".
 */
export function buildHiddenChildEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NODE_USE_SYSTEM_CA: "1",
    ...resolveManagedServerEnv(baseEnv),
    ...buildProxyEnv(),
    MIMALLOC_PURGE_DELAY: "0",
  }
  // Private runtime is for the serve child only, never the hidden storage helper.
  delete env.KILO_PRIVATE_RUNTIME
  return env
}

/**
 * Serve child is the sole owner of the internal private marker; always set
 * exactly "1" (extension invariant). Callers spread host env then override.
 * Never mutates `process.env`: the returned record is per-spawn only.
 */
export function buildServeChildEnvAugment(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Strict === '1' at flag read ensures invalid values never activate; extension always sets "1".
  return { ...baseEnv, KILO_PRIVATE_RUNTIME: "1" }
}

/**
 * Per-spawn serve env with the crash-cleanup ownership token. The token is
 * cryptographically unique per serve child and inherited by every
 * runtime-dependent grandchild; `persistent` BackgroundProcess runners strip
 * it. Never mutates `process.env`. Throws fail-closed on malformed tokens.
 * Internal to this module (sole production use is the serve spawn below).
 */
function buildServeChildEnvWithToken(baseEnv: NodeJS.ProcessEnv, token: string): NodeJS.ProcessEnv {
  if (!isValidRuntimeToken(token)) throw new Error("invalid runtime ownership token")
  return { ...baseEnv, KILO_PRIVATE_RUNTIME: "1", [RUNTIME_TOKEN_ENV]: token }
}

/**
 * Resolve the CLI binary path to spawn.
 *
 * Production prefers the lightweight serve-only `bin/kilo-serve` backend and
 * falls back to the full `bin/kilo` binary when the serve entry is absent
 * (dev source-wrapper mode, older bundles). Both entries accept the same
 * `serve --port 0` contract, so spawn args are unchanged — only the binary
 * path varies. The benchmark-only `KILO_P0_BACKEND_CLI` env override (opt-in
 * KILO_P0_* flag, same trust level as KILO_P0_PERF; never set in production)
 * is honored ONLY when explicitly set: the P0 harness copies the backend to
 * a run-owned temp snapshot path before the campaign and pins it here so the
 * non-owned dev watcher (script/watch-cli.ts) cannot change the measured
 * binary mid-campaign. When the override is absent or empty the bundled
 * fallback is unchanged — disabled product behavior is identical.
 */
export function resolveServeBinaryName(platform: string = process.platform): string {
  return platform === "win32" ? "kilo-serve.exe" : "kilo-serve"
}

export function resolveFullBinaryName(platform: string = process.platform): string {
  return platform === "win32" ? "kilo.exe" : "kilo"
}

export function resolveCliPath(extensionPath: string, env?: NodeJS.ProcessEnv): string {
  const override = env?.KILO_P0_BACKEND_CLI
  if (override && override.trim() !== "") {
    console.log("[Kilo New] ServerManager: 📦 Using benchmark CLI snapshot:", override)
    return override
  }
  const serve = path.join(extensionPath, "bin", resolveServeBinaryName())
  try {
    if (fs.existsSync(serve)) {
      console.log("[Kilo New] ServerManager: 📦 Using serve-only CLI:", serve)
      return serve
    }
  } catch {
    // fail-closed to the full CLI fallback below
  }
  const binName = resolveFullBinaryName()
  return path.join(extensionPath, "bin", binName)
}

export class ServerManager {
  private instance: ServerInstance | null = null
  private startupPromise: Promise<ServerInstance> | null = null
  private epochCounter = 0
  private disposed = false
  private startupGeneration = 0
  private startingProc: ChildProcess | null = null
  private canonicalStorageGeneration = 0
  private canonicalStoragePromise: Promise<void> | null = null
  private canonicalStorageDone = false
  private canonicalStorageError: ServerStartupError | Error | null = null

  /**
   * E2E fixture generation-request collector (KILO_E2E_FIXTURE only): sees
   * every backend `service=llm ... providerID=... modelID=...` line through
   * the stderr relay BEFORE provider/network resolution and persists typed
   * records to the run-owned scratch store (see llm-request-collector.ts).
   * Null in production — no collector is created and no line is parsed.
   */
  private llmStore: LlmRequestCollector | null = null
  private llmInstance = 0
  /**
   * Last crashed-instance identity for token-verified cleanup. Set on
   * unexpected exit (or when a dead instance is observed in `getServer`),
   * retained through startup failures and dispose, cleared only when its
   * cleanup completes clean. The replacement backend never spawns until that
   * cleanup completes; cleanup failure fails closed with no restart.
   */
  private crashed: CrashedInstanceIdentity | null = null
  /** Singleflight crash cleanup keyed by `epoch:token`. */
  private cleanupFlight: { key: string; promise: Promise<void> } | null = null

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onExit?: ServerExitListener,
  ) {}

  /**
   * Get or start the server instance
   */
  async getServer(): Promise<ServerInstance> {
    console.log("[Kilo New] ServerManager: 🔍 getServer called")
    if (this.disposed) throw new Error("ServerManager disposed")
    if (this.instance) {
      if (isChildDead(this.instance.process)) {
        // Dead process (numeric exit OR signal termination) cannot be cached — retain exact
        // epoch/token for crash cleanup, then fall through to the cleanup gate below.
        const dying = this.instance
        this.instance = null
        ServerManager.releasePrivateStreams(dying)
        this.rememberCrashed(dying)
      } else {
        console.log("[Kilo New] ServerManager: ♻️ Returning existing instance:", { port: this.instance.port })
        return this.instance
      }
    }

    if (this.startupPromise) {
      console.log("[Kilo New] ServerManager: ⏳ Startup already in progress, waiting...")
      return this.startupPromise
    }

    console.log("[Kilo New] ServerManager: 🚀 Starting new server instance...")
    const genAtStart = ++this.startupGeneration
    this.startupPromise = this.startServerWithCrashGate(genAtStart)
    try {
      const started = await this.startupPromise
      if (this.disposed || this.startupGeneration !== genAtStart) {
        // Startup outlived dispose or was superseded — kill exact owned child only when still alive.
        // Retain its token so the next startup sweeps detached grandchildren first.
        this.rememberCrashed(started)
        if (isChildAlive(started.process)) ServerManager.killProcess(started.process, "SIGTERM")
        ServerManager.releasePrivateStreams(started)
        throw new Error("Server startup superseded by dispose")
      }
      if (isChildDead(started.process)) {
        ServerManager.releasePrivateStreams(started)
        this.rememberCrashed(started)
        throw new ServerStartupError("CLI background process exited after port detection", `pid ${started.pid ?? "?"} exited with ${describeChildExit(started.process)}`)
      }
      this.instance = started
      console.log("[Kilo New] ServerManager: ✅ Server started successfully:", { port: this.instance.port })
      return this.instance
    } finally {
      if (this.startupGeneration === genAtStart) {
        this.startupPromise = null
        // Retain exact child handle until exit; avoid race clearing newer startingProc.
        // Hidden commands own their handle until exit; main server's handle transitions to instance ownership.
        if (this.startingProc && isChildDead(this.startingProc)) {
          this.startingProc = null
        } else if (this.instance && this.startingProc === this.instance.process) {
          this.startingProc = null
        } else if (!this.startingProc) {
          // already cleared
        } else if (this.startingProc && this.instance === null && this.startupPromise === null) {
          // Startup failed without instance; if no live hidden child retained, allow clear on next tick via exit handler.
          // Do not blindly null a live hidden child; its exit handler will clear when it exits.
          if (isChildDead(this.startingProc)) this.startingProc = null
        }
      }
    }
  }

  /**
   * Retain a crashed identity for the pre-replacement cleanup gate. Newest
   * epoch wins; a missing/invalid token still records the epoch so the gate
   * fails closed instead of silently spawning over unknown ownership.
   */
  private rememberCrashed(id: { epoch: number; token?: string; pid?: number }): void {
    const cur = this.crashed
    if (cur && cur.epoch > id.epoch) return
    this.crashed = { epoch: id.epoch, token: typeof id.token === "string" ? id.token : "", pid: id.pid }
  }

  /**
   * Crash gate: when a previous instance died, its token-verified orphans
   * (detached shell/background/PTY/LSP/MCP children in separate groups) must
   * be reaped BEFORE the replacement spawns. Singleflight per epoch:token so
   * concurrent getServer calls share one sweep. Cleanup failure or unsupported
   * ownership fails closed with a visible ServerStartupError and no spawn.
   */
  private async startServerWithCrashGate(generation: number): Promise<ServerInstance> {
    const dead = this.crashed
    if (dead) await this.runCrashCleanupSingleflight(dead, generation)
    if (this.disposed || this.startupGeneration !== generation) {
      throw new ServerStartupError("Server startup superseded by dispose", `generation ${generation} cancelled during crash cleanup gate`)
    }
    return this.startServer(generation)
  }

  private runCrashCleanupSingleflight(dead: CrashedInstanceIdentity, generation: number): Promise<void> {
    const key = `${dead.epoch}:${dead.token}`
    if (this.cleanupFlight && this.cleanupFlight.key === key) return this.cleanupFlight.promise
    const promise = (async () => {
      if (!isValidRuntimeToken(dead.token)) {
        throw new ServerStartupError(
          "Backend crash cleanup refused: unknown ownership",
          `epoch ${dead.epoch} pid ${String(dead.pid ?? "?")} carries no valid ownership token — refusing replacement to avoid orphaned or PID-reused kills`,
        )
      }
      console.log("[Kilo New] ServerManager: 🧹 Crash cleanup for epoch", dead.epoch, "pid", dead.pid)
      const out = await cleanupOwnedProcesses(dead.token)
      if (out.status === "clean") {
        console.log("[Kilo New] ServerManager: 🧹 Crash cleanup clean", { epoch: dead.epoch, killed: out.killed })
        if (this.crashed && this.crashed.epoch === dead.epoch && this.crashed.token === dead.token) this.crashed = null
        return
      }
      const reason = out.status === "unsupported" ? out.reason : out.reason
      const remaining = out.status === "unsupported" ? "" : ` remaining [${out.remaining.join(",")}]`
      const stable =
        out.status === "unsupported" ? " (stable platform limit — retry cannot recover; manual cleanup required)" : ""
      throw new ServerStartupError(
        "Backend crash cleanup failed: replacement withheld",
        `epoch ${dead.epoch} token-owned sweep ${out.status}${stable}: ${reason}${remaining} — resolve manually, then retry`,
      )
    })()
    this.cleanupFlight = { key, promise }
    const clear = () => {
      if (this.cleanupFlight && this.cleanupFlight.promise === promise) this.cleanupFlight = null
    }
    promise.then(clear, clear)
    // Cancellation races the sweep but never skips it: a superseded generation
    // still awaited the shared sweep above before throwing.
    void generation
    return promise
  }

  /**
   * Minimal shared singleflight canonical storage pre-serve cutover gate.
   * Accessible via KiloConnectionService.ensureCanonicalStorage and reused by
   * startServer. No standalone no-lease worker may open DB before this
   * completes. Singleflight within this extension host; failure is cached
   * fail-closed (no retry) and prevents worker open. Across multiple windows,
   * live serve lease in another window makes status fail closed without killing
   * the other process. Uses owned XDG-derived dataRoot, never user DB in tests
   * when caller injects temp XDG.
   */
  async ensureCanonicalStorage(): Promise<void> {
    if (this.disposed) throw new Error("ServerManager disposed")
    if (this.canonicalStorageDone) return
    if (this.canonicalStorageError) throw this.canonicalStorageError
    if (this.canonicalStoragePromise) return this.canonicalStoragePromise
    const gen = ++this.canonicalStorageGeneration
    const p = this.ensureCanonicalStorageInternal(gen)
    this.canonicalStoragePromise = p
    try {
      await p
      this.canonicalStorageDone = true
      this.canonicalStorageError = null
    } catch (e) {
      this.canonicalStorageError = e as Error
      throw e
    } finally {
      if (this.canonicalStoragePromise === p) this.canonicalStoragePromise = null
    }
  }

  // eslint-disable-next-line complexity
  private async ensureCanonicalStorageInternal(generation: number): Promise<void> {
    let dataRoot: string
    try {
      const dbPath = resolveCanonicalDbPath({ env: process.env, homedir: os.homedir() })
      if (!path.isAbsolute(dbPath)) throw new Error(`canonical DB path not absolute: ${dbPath}`)
      dataRoot = path.dirname(path.resolve(dbPath))
    } catch (e) {
      throw new ServerStartupError("Failed to resolve canonical storage path", String((e as Error)?.message ?? e))
    }
    if (!path.isAbsolute(dataRoot)) {
      throw new ServerStartupError("Canonical data root not absolute", dataRoot)
    }
    const hiddenCli = resolveHiddenCliPath(this.context.extensionPath, process.env)
    if (!fs.existsSync(hiddenCli)) {
      throw new ServerStartupError(
        "CLI binary not found for storage cutover",
        `hidden CLI missing at ${hiddenCli} — failing closed, not spawning legacy`,
      )
    }
    let statusRes: { stdout: string; stderr: string }
    try {
      statusRes = await this.runHiddenCutoverCommand(hiddenCli, ["__internal-storage-cutover", "status", "--data-root", dataRoot], generation, CUTOVER_TIMEOUT_MS)
    } catch (e) {
      if (e instanceof ServerStartupError) throw e
      throw new ServerStartupError("Storage status check failed", String((e as Error)?.message ?? e))
    }
    let status: Record<string, unknown>
    try {
      status = parseCutoverJson(statusRes.stdout)
    } catch (e) {
      const tail = statusRes.stderr || statusRes.stdout
      const { userMessage, userDetails } = toErrorMessage(String((e as Error)?.message ?? e), tail.split("\n"), hiddenCli)
      throw new ServerStartupError(userMessage, userDetails)
    }
    if (status.canonical === true) {
      console.log("[Kilo New] ServerManager: canonical storage already active, skipping cutover", { dataRoot, archiveID: String(status.archiveID ?? "") })
      return
    }
    // Non-canonical: legacy DB present (hasDb true) or fresh (hasDb false) — run offline cutover under lease before serve
    console.log("[Kilo New] ServerManager: non-canonical storage detected, running offline cutover", status)
    try {
      const cutRes = await this.runHiddenCutoverCommand(hiddenCli, ["__internal-storage-cutover", "cutover", "--data-root", dataRoot], generation, CUTOVER_TIMEOUT_MS)
      const out = parseCutoverJson(cutRes.stdout)
      console.log("[Kilo New] ServerManager: cutover succeeded", out)
    } catch (e: unknown) {
      const msg = String((e as Error)?.message ?? e) + " " + String((e as ServerStartupError)?.userDetails ?? "")
      if (msg.includes("fresh canonical DB already active") || msg.includes("rerun blocked") || msg.includes("already active")) {
        console.log("[Kilo New] ServerManager: cutover raced to canonical, continuing", msg.slice(0, 500))
        return
      }
      if (e instanceof ServerStartupError) throw e
      throw new ServerStartupError("Storage cutover failed", msg.slice(0, 4000))
    }
  }

  private runHiddenCutoverCommand(cliPath: string, args: string[], generation: number, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      if (this.disposed || this.canonicalStorageGeneration !== generation) {
        reject(new ServerStartupError("Server startup superseded by dispose", `generation ${generation} superseded before hidden command ${args.join(" ")}`))
        return
      }
      console.log("[Kilo New] ServerManager: spawning hidden CLI:", cliPath, args.join(" "))
      const child = spawn(cliPath, args, {
        env: buildHiddenChildEnv(process.env),
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      })
      ;(child as unknown as { __kiloHidden?: boolean }).__kiloHidden = true
      // Retain exact child handle until exit; avoid race clearing newer startingProc.
      this.startingProc = child
      let stdout = ""
      let stderr = ""
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        if (settled) return
        settled = true
        console.error(`[Kilo New] ServerManager: hidden command timeout after ${timeoutMs}ms`, args.join(" "))
        if (isChildAlive(child)) ServerManager.killDirect(child, "SIGTERM")
        // SIGKILL fallback 5s after timeout; retained until child exit. Only when still alive — never re-kill signal-dead.
        let killTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
          if (isChildAlive(child)) ServerManager.killDirect(child, "SIGKILL")
        }, HIDDEN_SIGKILL_DELAY_MS)
        ;(killTimer as unknown as { unref?: () => void })?.unref?.()
        const clearKill = () => {
          if (killTimer) {
            clearTimeout(killTimer)
            killTimer = null
          }
        }
        child.on("exit", clearKill)
        timer = null
        const tail = stderr || stdout
        const { userMessage, userDetails } = toErrorMessage(
          `Storage cutover timeout after ${timeoutMs / 1000}s`,
          tail.split("\n"),
          cliPath,
        )
        // Do not clear this.startingProc here; retain until exit.
        reject(new ServerStartupError(userMessage, userDetails))
      }, timeoutMs)
      ;(timer as unknown as { unref?: () => void })?.unref?.()
      const clearTimer = () => {
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
      }
      const clearIfOurs = () => {
        if (this.startingProc === child) this.startingProc = null
      }
      child.stdout?.on("data", (d: Buffer) => {
        stdout += d.toString()
      })
      child.stderr?.on("data", (d: Buffer) => {
        stderr += d.toString()
      })
      child.on("error", (err: Error) => {
        if (settled) return
        settled = true
        clearTimer()
        clearIfOurs()
        reject(new ServerStartupError("Failed to spawn hidden storage command", `${String(err.message ?? err)} ${stderr.slice(0, 2000)}`))
      })
      child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
        clearTimer()
        clearIfOurs()
        if (settled) return
        settled = true
        if (this.disposed || this.canonicalStorageGeneration !== generation) {
          if (isChildAlive(child)) ServerManager.killDirect(child, "SIGTERM")
          reject(new ServerStartupError("Server startup superseded by dispose", `generation ${generation} superseded during hidden command ${args.join(" ")} code ${String(code ?? signal ?? "null")}`))
          return
        }
        if (code === 0) {
          resolve({ stdout, stderr })
          return
        }
        const combined = stderr || stdout
        const { userMessage, userDetails } = toErrorMessage(
          `Storage cutover command failed with code ${String(code ?? signal ?? "null")}`,
          combined.split("\n"),
          cliPath,
        )
        reject(new ServerStartupError(userMessage, userDetails))
      })
    })
  }

  private async startServer(generation: number): Promise<ServerInstance> {
    const password = crypto.randomBytes(32).toString("hex")
    // Crash-cleanup ownership token: unique per serve child, inherited by all
    // runtime-dependent grandchildren. Minted here (never in process.env),
    // passed per-spawn only. Persistent BackgroundProcess runners strip it and
    // are never wrapped. Every nonpersistent child IS a `__process-guardian`
    // prelaunch wrapper (real group/job ownership across serve death, env
    // -i safe, no SIGKILL/install gap); the sweep reaps guardians by
    // exact-PID signals and guardians reap their trees, with Windows
    // attested via the guardian CIM oracle (unsupported only when the
    // oracle itself fails; Windows job hold is a structural code claim).
    const token = createRuntimeToken()
    const cliPath = this.getCliPath()
    console.log("[Kilo New] ServerManager: 📍 CLI path:", cliPath)
    console.log("[Kilo New] ServerManager: 🔐 Generated password (length):", password.length)

    // One-time canonical storage cutover: must complete before serve spawn.
    // Uses the bundled full CLI hidden command (Bun context) under lease, same
    // canonical dataRoot as KILO_DB, read-only identity existence check, fail
    // closed on lease/marked/corruption/CLI missing, never silently spawn legacy.
    await this.ensureCanonicalStorage()
    if (this.disposed || this.startupGeneration !== generation) {
      throw new ServerStartupError("Server startup superseded by dispose", `generation ${generation} cancelled after cutover gate`)
    }

    // E2E fixture generation-request collection (KILO_E2E_FIXTURE only): the
    // run-owned scratch store is created lazily on the first spawn so every
    // `service=llm` line of every server instance lands in the same
    // append-only file. `instance` counts each spawn so records are
    // attributable across worker restarts/launches (real-restart Phase B/C).
    this.llmInstance += 1
    if (!this.llmStore && isE2EFixtureEnabled() && process.env.KILO_E2E_SCRATCH) {
      try {
        if (isValidE2EScratch(process.env.KILO_E2E_SCRATCH)) {
          this.llmStore = new LlmRequestCollector(path.join(process.env.KILO_E2E_SCRATCH, "llm-requests.jsonl"))
        }
      } catch {
        // fail-closed: do not create collector on validation error
      }
    }
    const llmInstance = this.llmInstance
    const llmStore = this.llmStore

    // Verify the CLI binary exists
    if (!fs.existsSync(cliPath)) {
      throw new Error(
        `CLI binary not found at expected path: ${cliPath}. Please ensure the CLI is built and bundled with the extension.`,
      )
    }

    const stat = fs.statSync(cliPath)
    console.log("[Kilo New] ServerManager: 📄 CLI isFile:", stat.isFile())
    console.log("[Kilo New] ServerManager: 📄 CLI mode (octal):", (stat.mode & 0o777).toString(8))

    return new Promise((resolve, reject) => {
      console.log("[Kilo New] ServerManager: 🎬 Spawning CLI process:", cliPath, ["serve", "--port", "0"])
      p0Stage("spawn.start")
      const cfg = vscode.workspace.getConfiguration("kilo-code.new")
      const claudeCompat = cfg.get<boolean>("claudeCodeCompat", false)
      // Pin cwd so the CLI doesn't inherit the extension host's cwd ("/" under F5 debug)
      // or "$HOME" in empty VS Code windows.
      const folders = vscode.workspace.workspaceFolders
      const spawnCwd = resolveServerCwd(folders, this.context.globalStorageUri.fsPath)
      fs.mkdirSync(spawnCwd, { recursive: true })
      const localCli =
        this.context.extensionMode ===
          (vscode as unknown as { ExtensionMode?: { Development: number } }).ExtensionMode?.Development ||
        fs.existsSync(path.join(this.context.extensionPath, "bin", ".cli-version"))
      const bwrapEnv = process.env.KILO_BWRAP_PATH ? {} : resolveLocalBwrapEnv(this.context.extensionPath, localCli)
      // TLS / corporate-proxy support:
      //   - Default NODE_USE_SYSTEM_CA=1 so the bundled Bun CLI trusts the OS
      //     trust store (Windows cert store, macOS keychain, Linux /etc/ssl).
      //     Mirrors VS Code's `http.systemCertificates` default (true).
      //   - Allow users behind MITM proxies to point at a custom CA bundle via
      //     `kilo-code.new.extraCaCerts` (NODE_EXTRA_CA_CERTS).
      //   - Honor VS Code's `http.proxyStrictSSL=false` as an explicit opt-out
      //     from verification, matching what VS Code already does for its own
      //     requests. Users explicitly set that; we don't flip it ourselves.
      // All three are overridable by the user's environment.
      const extraCaCerts = cfg.get<string>("extraCaCerts", "").trim()
      const proxyStrictSSL = vscode.workspace.getConfiguration("http").get<boolean>("proxyStrictSSL", true)
      // P0 benchmark capture (opt-in KILO_P0_PERF only, test harness flag —
      // never set in production): ask the CLI to print logs to stderr so the
      // backend's `service=p0-perf` records stream through this process's
      // stderr relay and are captured by the P0 harness. Default behavior
      // (logs to the scratch XDG file) is unchanged when the flag is off.
      // The E2E fixture flag (KILO_E2E_FIXTURE, also test-only) enables the
      // same print path so the fixture-gated generation-request collector
      // below sees every `service=llm` line through the stderr relay.
      const p0LogArgs = isP0PerfEnabled() || isE2EFixtureEnabled() ? ["--print-logs"] : []
      const serverProcess = spawn(cliPath, ["serve", "--port", "0", ...p0LogArgs], {
        cwd: spawnCwd,
        env: {
          NODE_USE_SYSTEM_CA: "1",
          ...(extraCaCerts && { NODE_EXTRA_CA_CERTS: extraCaCerts }),
          ...(!proxyStrictSSL && { NODE_TLS_REJECT_UNAUTHORIZED: "0" }),
          ...resolveManagedServerEnv(process.env),
          // VS Code's http.proxy / http.noProxy settings are not reflected in
          // process.env, so spawned children bypass the user's configured proxy
          // and fail behind corporate firewalls. Forward them as the standard
          // HTTP_PROXY / HTTPS_PROXY / NO_PROXY env vars that Bun's fetch and
          // most HTTP clients already respect.
          ...buildProxyEnv(),
          // Force mimalloc (the allocator Bun ships with) to return freed pages
          // to the OS immediately instead of retaining them in its arenas.
          // Without this, Bun.spawn's piped stdio accumulates ~2 MB of native
          // RSS per call on Windows, causing the Agent Manager (which polls git
          // once per second per session directory) to reach multi-GB RSS in minutes.
          // See oven-sh/bun#18265 and Jarred's workaround note in #21560.
          MIMALLOC_PURGE_DELAY: "0",
          KILO_SERVER_PASSWORD: password,
          // Sole private-runtime marker + crash-cleanup ownership token.
          // Per-spawn only; never mutates process.env. The token is inherited
          // by runtime-dependent grandchildren and stripped by persistent
          // runners (see buildServeChildEnvWithToken).
          ...buildServeChildEnvWithToken({}, token),
          // The CLI watches this PID and exits if the extension host is hard-killed without a
          // chance to run dispose(), so it is never orphaned. See parent-watchdog.ts.
          KILO_PARENT_PID: String(process.pid),
          KILO_CLIENT: "vscode",
          KILO_ENABLE_QUESTION_TOOL: "true",
          KILOCODE_FEATURE: "vscode-extension",
          KILO_TELEMETRY_LEVEL: vscode.env.isTelemetryEnabled ? "all" : "off",
          KILO_APP_NAME: "kilo-code",
          KILO_EDITOR_NAME: vscode.env.appName,
          KILO_PLATFORM: "vscode",
          KILO_MACHINE_ID: vscode.env.machineId,
          KILO_APP_VERSION: this.context.extension.packageJSON.version,
          KILO_VSCODE_VERSION: vscode.version,
          KILOCODE_VERSION: this.context.extension.packageJSON.version,
          KILOCODE_EDITOR_NAME: `${vscode.env.appName} ${vscode.version}`,
          ...(!claudeCompat && { KILO_DISABLE_CLAUDE_CODE: "true" }),
          ...resolveTreeSitterEnv(this.context.extensionPath),
          ...bwrapEnv,
          ...resolveE2EFixtureChildEnv(),
          // Narrowly validated E2E seam: only forward the run-owned loopback
          // baseURL when all gates pass (fixture, absolute scratch, loopback
          // /v1). Invalid or arbitrary payload is not forwarded.
          ...validatedE2EProviderEnv(),
        },
        stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
        detached: true,
      })
      ;(serverProcess as unknown as { __kiloHidden?: boolean }).__kiloHidden = false
      console.log("[Kilo New] ServerManager: 📦 Process spawned with PID:", serverProcess.pid)
      this.startingProc = serverProcess
      this.epochCounter += 1
      const epoch = this.epochCounter
      const pid = serverProcess.pid
      const privateWriter = (serverProcess.stdio[3] as unknown as NodeJS.WritableStream) ?? null
      const privateReader = (serverProcess.stdio[4] as unknown as NodeJS.ReadableStream) ?? null
      p0Stage("spawn.done", { pid: serverProcess.pid })

      let resolved = false
      let startupTimeout: ReturnType<typeof setTimeout> | null = null
      let startupSigkill: ReturnType<typeof setTimeout> | null = null
      const clearStartupWatchdog = () => {
        if (startupTimeout) {
          clearTimeout(startupTimeout)
          startupTimeout = null
        }
      }
      const clearSigkillWatchdog = () => {
        if (startupSigkill) {
          clearTimeout(startupSigkill)
          startupSigkill = null
        }
      }
      const scheduleStartupSigkill = () => {
        clearSigkillWatchdog()
        startupSigkill = setTimeout(() => {
          if (isChildAlive(serverProcess)) ServerManager.killProcess(serverProcess, "SIGKILL")
        }, 5000)
        ;(startupSigkill as unknown as { unref?: () => void })?.unref?.()
        serverProcess.on("exit", () => clearSigkillWatchdog())
      }
      // Bounded stderr relay: chunks are reassembled into complete
      // newline-delimited lines before logging, so a backend log record split
      // across pipe chunks is still relayed (and parsed by the P0 harness) as
      // one complete line. Only a bounded tail of the most recent lines is
      // retained for startup-failure diagnostics (see stderr-tail.ts); the
      // trailing partial line is flushed at exit/error.
      const stderrTail = new StderrTail({
        onLine: (line) => {
          console.error("[Kilo New] ServerManager: ⚠️ CLI Server stderr:", line)
          // Fixture-gated generation-request collection (LOCK-006/LOCK-008):
          // every backend line reaches the collector; only `service=llm`
          // records with providerID/modelID produce a persisted record. The
          // line is emitted before provider/network resolution, so a failed
          // or aborted non-run-owned attempt is still recorded.
          llmStore?.feed(line, serverProcess.pid ?? 0, llmInstance)
        },
      })

      serverProcess.stdout?.on("data", (data: Buffer) => {
        const output = data.toString()
        console.log("[Kilo New] ServerManager: 📥 CLI Server stdout:", output)

        const port = parseServerPort(output)
        if (port !== null && !resolved) {
          if (this.disposed || this.startupGeneration !== generation) {
            console.warn("[Kilo New] ServerManager: port detected but startup superseded by dispose — discarding")
            ServerManager.releasePrivateStreams({ privateReader, privateWriter } as unknown as ServerInstance)
            if (isChildAlive(serverProcess)) {
              ServerManager.killProcess(serverProcess, "SIGTERM")
              scheduleStartupSigkill()
            }
            if (!resolved) {
              clearStartupWatchdog()
              clearSigkillWatchdog()
              stderrTail.flush()
              reject(new ServerStartupError("Server startup superseded by dispose", `pid ${String(pid ?? "?")} port ${String(port)} generation ${String(generation)}`))
              resolved = true
            }
            return
          }
          if (isChildDead(serverProcess)) {
            console.warn("[Kilo New] ServerManager: port detected but process already exited — not caching", describeChildExit(serverProcess))
            ServerManager.releasePrivateStreams({ privateReader, privateWriter } as unknown as ServerInstance)
            if (!resolved) {
              clearStartupWatchdog()
              clearSigkillWatchdog()
              stderrTail.flush()
              const { userMessage, userDetails } = toErrorMessage(
                t("server.processExited", { code: String(serverProcess.exitCode ?? serverProcess.signalCode ?? "null") }),
                stderrTail.tail(),
                cliPath,
              )
              reject(new ServerStartupError(userMessage, userDetails))
              resolved = true
            }
            return
          }
          resolved = true
          clearStartupWatchdog()
          clearSigkillWatchdog()
          console.log("[Kilo New] ServerManager: 🎯 Port detected:", port)
          p0Stage("port.detected", { port })
          // Defer install until next tick so an immediate exit after port log is observed.
          // Signal death keeps exitCode null, so check both fields — never cache signal-dead.
          setImmediate(() => {
            if (isChildDead(serverProcess)) {
              console.warn("[Kilo New] ServerManager: process exited immediately after port detection — not caching", describeChildExit(serverProcess))
              ServerManager.releasePrivateStreams({ privateReader, privateWriter } as unknown as ServerInstance)
              // If already resolved, getServer's post-install check will handle; here we already resolved so rely on that check
              return
            }
          })
          resolve({ port, password, process: serverProcess, privateReader, privateWriter, pid, epoch, spawnCwd, token })
        }
      })

      serverProcess.stderr?.on("data", (data: Buffer) => {
        stderrTail.write(data)
      })

      serverProcess.on("error", (error) => {
        console.error("[Kilo New] ServerManager: ❌ Process error:", error)
        if (!resolved) {
          resolved = true
          clearStartupWatchdog()
          clearSigkillWatchdog()
          stderrTail.flush()
          reject(error)
        }
      })

      serverProcess.on("exit", (code, signal) => {
        console.log("[Kilo New] ServerManager: 🛑 Process exited with code:", code, "signal:", signal ?? "null")
        clearStartupWatchdog()
        clearSigkillWatchdog()
        if (this.instance?.process === serverProcess) {
          const dying = this.instance
          this.instance = null
          ServerManager.releasePrivateStreams(dying)
          // Retain exact epoch/token: the next getServer must clean token-verified
          // orphans before a replacement accepts work. Never cleared implicitly.
          this.rememberCrashed(dying)
          this.onExit?.(code)
        } else {
          ServerManager.releasePrivateStreams({ privateReader, privateWriter } as unknown as ServerInstance)
          // A startup-failure child may still have spawned token-carrying
          // descendants before dying; retain its identity so the next startup
          // cleans it before replacing. Keyed by epoch so a newer crash wins.
          this.rememberCrashed({ epoch, token, pid })
        }
        if (!resolved) {
          resolved = true
          stderrTail.flush()
          const { userMessage, userDetails } = toErrorMessage(
            t("server.processExited", { code: String(code ?? signal ?? "null") }),
            stderrTail.tail(),
            cliPath,
          )
          reject(new ServerStartupError(userMessage, userDetails))
        }
      })

      startupTimeout = setTimeout(() => {
        if (!resolved) {
          resolved = true
          console.error(`[Kilo New] ServerManager: ⏰ Server startup timeout (${STARTUP_TIMEOUT_SECONDS}s)`)
          ServerManager.killProcess(serverProcess, "SIGTERM")
          scheduleStartupSigkill()
          clearStartupWatchdog()
          stderrTail.flush()
          const { userMessage, userDetails } = toErrorMessage(
            t("server.startupTimeout", { seconds: STARTUP_TIMEOUT_SECONDS }),
            stderrTail.tail(),
            cliPath,
          )
          reject(new ServerStartupError(userMessage, userDetails))
        }
      }, STARTUP_TIMEOUT_SECONDS * 1000)
      ;(startupTimeout as unknown as { unref?: () => void })?.unref?.()
    })
  }

  /**
   * Exact spawn-time backend working directory of the CURRENT active server
   * instance (the `spawnCwd` passed to the child spawn). Read-only; returns
   * null when no live instance exists (never started, dead, exited, or
   * disposed). The sole `path/get` routing identity — callers fail closed
   * when null instead of guessing a mutable directory.
   */
  public getActiveSpawnCwd(): string | null {
    const inst = this.instance
    if (!inst) return null
    if (this.disposed) return null
    if (isChildDead(inst.process)) return null
    return typeof inst.spawnCwd === "string" && inst.spawnCwd.length > 0 ? inst.spawnCwd : null
  }

  /**
   * E2E fixture bridge (KILO_E2E_FIXTURE only, registered by extension.ts):
   * exact PID + port of the CURRENT server instance. Read-only; returns null
   * when no server is running or the fixture env is absent. No production
   * effect — the caller (the connection service's fixture command) is itself
   * env-gated.
   */
  public getServerPidForFixture(): { pid: number; port: number } | null {
    if (!isE2EFixtureEnabled()) return null
    const instance = this.instance
    if (!instance?.process.pid) return null
    if (isChildDead(instance.process)) return null
    return { pid: instance.process.pid, port: instance.port }
  }

  /**
   * E2E fixture bridge (KILO_E2E_FIXTURE only): exact epoch of the CURRENT
   * server instance. Read-only; returns null when no server is running or the
   * fixture env is absent. No production effect.
   */
  public getServerEpochForFixture(): number | null {
    if (!isE2EFixtureEnabled()) return null
    const instance = this.instance
    if (!instance) return null
    if (isChildDead(instance.process)) return null
    return instance.epoch
  }

  /**
   * E2E fixture bridge (KILO_E2E_FIXTURE only): full server identity.
   * Read-only; returns null when no server is running or the fixture env is
   * absent. No production effect.
   */
  public getServerInfoForFixture(): { pid: number; port: number; epoch: number } | null {
    if (!isE2EFixtureEnabled()) return null
    const instance = this.instance
    if (!instance?.process.pid) return null
    if (isChildDead(instance.process)) return null
    return { pid: instance.process.pid, port: instance.port, epoch: instance.epoch }
  }

  /**
   * E2E fixture bridge (KILO_E2E_FIXTURE only): terminate ONLY the exact
   * current server process group through the same owner-equivalent path
   * `dispose()` uses (ServerManager.killProcess → `process.kill(-pid,
   * SIGTERM)`), WITHOUT touching `this.instance` — the child's own exit event
   * nulls the instance and fires the production onExit → connection-service
   * reset, so the replacement server comes up through the unmodified
   * production lifecycle. Returns the killed PID + port. No production effect
   * when the fixture env is absent.
   */
  public killServerForFixture(): { pid: number; port: number } | null {
    if (!isE2EFixtureEnabled()) return null
    const instance = this.instance
    if (!instance?.process.pid) return null
    if (!isChildAlive(instance.process)) return null
    console.log(
      "[Kilo New] ServerManager: fixture kill — SIGTERM to exact owned process group, PID:",
      instance.process.pid,
    )
    ServerManager.killProcess(instance.process, "SIGTERM")
    return { pid: instance.process.pid, port: instance.port }
  }

  /**
   * E2E fixture bridge (KILO_E2E_FIXTURE only): hard-crash ONLY the exact
   * current server process group via detached SIGKILL (`process.kill(-pid,
   * SIGKILL)`), WITHOUT touching `this.instance` — the child's own exit event
   * still clears the instance and fires the production onExit reset, so the
   * replacement comes up through the unmodified production lifecycle. No
   * global name kill, no production dispose change (dispose keeps SIGTERM).
   * Returns the killed PID + port. No production effect when absent.
   */
  public killServerHardForFixture(): { pid: number; port: number } | null {
    if (!isE2EFixtureEnabled()) return null
    const instance = this.instance
    if (!instance?.process.pid) return null
    if (!isChildAlive(instance.process)) return null
    console.log(
      "[Kilo New] ServerManager: fixture hard kill — SIGKILL to exact owned process group, PID:",
      instance.process.pid,
    )
    ServerManager.killProcess(instance.process, "SIGKILL")
    return { pid: instance.process.pid, port: instance.port }
  }

  /**
   * E2E fixture bridge (KILO_E2E_FIXTURE only): true-close ONLY the exact
   * active instance's private pipes (stdio[3]/stdio[4]) through the existing
   * `releasePrivateStreams` owner path. No child kill, no instance nulling —
   * the backend observes EOF/EPIPE and its own peer transitions to closed
   * while the host child stays alive (same pid/port). Exact epoch+pid match
   * only: a stale or foreign epoch/pid never touches another generation's
   * streams. Idempotent: already-destroyed pipes report `alreadyClosed`
   * without re-destroy. Returns null when the fixture env is absent.
   */
  public closePrivatePipesForFixture(
    expectedEpoch: number | null,
    expectedPid: number | undefined,
  ): { closed: boolean; alreadyClosed: boolean; pid: number | undefined; port: number | null; epoch: number | null } | null {
    if (!isE2EFixtureEnabled()) return null
    const inst = this.instance
    if (!inst) return { closed: false, alreadyClosed: false, pid: undefined, port: null, epoch: null }
    if (expectedEpoch !== null && expectedEpoch !== undefined && inst.epoch !== expectedEpoch) {
      return { closed: false, alreadyClosed: false, pid: inst.process.pid, port: inst.port, epoch: inst.epoch }
    }
    if (expectedPid !== undefined && inst.process.pid !== expectedPid) {
      return { closed: false, alreadyClosed: false, pid: inst.process.pid, port: inst.port, epoch: inst.epoch }
    }
    if (isChildDead(inst.process)) {
      return { closed: false, alreadyClosed: false, pid: inst.process.pid, port: inst.port, epoch: inst.epoch }
    }
    const streams = [inst.privateReader, inst.privateWriter].filter(Boolean) as unknown as Array<{
      destroyed?: boolean
    }>
    if (streams.length === 0 || streams.every((s) => s.destroyed === true)) {
      return { closed: false, alreadyClosed: true, pid: inst.process.pid, port: inst.port, epoch: inst.epoch }
    }
    console.log(
      "[Kilo New] ServerManager: fixture close — destroying exact owned private pipes, PID:",
      inst.process.pid,
      "epoch:",
      inst.epoch,
    )
    ServerManager.releasePrivateStreams(inst)
    return { closed: true, alreadyClosed: false, pid: inst.process.pid, port: inst.port, epoch: inst.epoch }
  }

  /**
   * E2E fixture bridge (KILO_E2E_FIXTURE only): aggregate generation-request
   * records from the run-owned store — every `service=llm` line observed
   * across ALL server instances and extension-host launches of this run
   * (worker restart + reloadWindow relaunch included), with the per-class
   * matrix. Returns null when the fixture env is absent or no server ever
   * spawned. No production effect.
   */
  public getLlmRequestsForFixture(): { records: LlmRequestRecord[]; file: string } | null {
    if (!isE2EFixtureEnabled()) return null
    if (!this.llmStore) return null
    return { records: this.llmStore.read(), file: this.llmStoreFile() }
  }

  /**
   * E2E fixture bridge (KILO_E2E_FIXTURE only): clear the generation-request
   * store. Called once at the start of a real-* scenario run (never between
   * real-restart launches — the persisted evidence must aggregate across
   * them). Validates the complete scratch marker contract before constructing
   * LlmRequestCollector or mutating files; invalid gate/scratch/marker fails
   * closed without filesystem mutation. No production effect.
   */
  public resetLlmRequestsForFixture(): boolean {
    if (!isE2EFixtureEnabled()) return false
    const scratch = process.env.KILO_E2E_SCRATCH
    if (!scratch || !isValidE2EScratch(scratch)) return false
    if (!this.llmStore) {
      this.llmStore = new LlmRequestCollector(path.join(scratch, "llm-requests.jsonl"))
    }
    this.llmStore.reset()
    return true
  }

  private llmStoreFile(): string {
    return path.join(process.env.KILO_E2E_SCRATCH ?? ".", "llm-requests.jsonl")
  }

  private getCliPath(): string {
    // Always use the bundled binary from the extension directory, unless the
    // benchmark-only KILO_P0_BACKEND_CLI override is explicitly set (see
    // resolveCliPath — P0 harness CLI snapshot pinning).
    const cliPath = resolveCliPath(this.context.extensionPath, process.env)
    console.log("[Kilo New] ServerManager: 📦 Using CLI path:", cliPath)
    return cliPath
  }

  /**
   * Kill hidden `detached:false` child directly via child.kill — never group -pid,
   * which would target the parent group for non-detached children.
   */
  private static killDirect(proc: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
    if (proc.pid === undefined) return
    try {
      proc.kill(signal)
    } catch (err) {
      console.warn("[Kilo ServerManager] killDirect failed (already gone?):", String(err))
    }
  }

  /**
   * Kill a process and its entire process group.
   * On Unix, we send the signal to -pid (negative) to reach the whole group.
   * On Windows, process.kill() on the child handle is sufficient.
   * Used only for serve `detached:true` children.
   */
  private static killGroup(proc: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
    if (proc.pid === undefined) {
      return
    }
    try {
      if (process.platform !== "win32") {
        // Negative PID targets the entire process group
        process.kill(-proc.pid, signal)
      } else {
        proc.kill(signal)
      }
    } catch (err) {
      console.warn("[Kilo ServerManager] killGroup failed (already gone?):", String(err))
    }
  }

  private static killProcess(proc: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
    // Backward-compat alias for serve detached:true paths; hidden paths must use killDirect.
    ServerManager.killGroup(proc, signal)
  }

  private static killForStartingProc(proc: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
    const isHidden = (proc as unknown as { __kiloHidden?: boolean }).__kiloHidden === true
    if (isHidden) ServerManager.killDirect(proc, signal)
    else ServerManager.killGroup(proc, signal)
  }

  private static releasePrivateStreams(inst: Pick<ServerInstance, "privateReader" | "privateWriter"> | null): void {
    if (!inst) return
    for (const s of [inst.privateReader, inst.privateWriter]) {
      if (!s) continue
      try {
        const c = s as unknown as { destroy?: () => void; close?: () => void; end?: () => void; destroyed?: boolean }
        if (c.destroyed) continue
        if (typeof c.destroy === "function") c.destroy()
        else if (typeof c.close === "function") c.close()
        else if (typeof c.end === "function") c.end()
      } catch (err) {
        console.warn("[Kilo ServerManager] releasePrivateStreams cleanup failed:", String(err))
      }
    }
  }

  /**
   * Awaited shutdown convergence: kills the exact owned children, waits for
   * their exit (bounded), then awaits the token-verified sweep for detached
   * grandchildren the group-kill cannot reach. Callers must await this —
   * authority is relinquished only after convergence settles (clean or
   * logged-incomplete, never silent fire-and-forget). The already-disposed
   * path converges identically for any in-flight startup child.
   */
  async dispose(): Promise<void> {
    if (this.disposed) {
      const cur = this.startingProc
      if (cur && isChildAlive(cur)) {
        ServerManager.killForStartingProc(cur, "SIGTERM")
        ServerManager.releasePrivateStreams({
          privateReader: (cur.stdio[4] as unknown as NodeJS.ReadableStream) ?? null,
          privateWriter: (cur.stdio[3] as unknown as NodeJS.WritableStream) ?? null,
        } as unknown as ServerInstance)
        await ServerManager.waitForChildExit(cur, 5000, ServerManager.killForStartingProc)
        if (this.startingProc === cur) this.startingProc = null
      } else if (cur && this.startingProc === cur) {
        this.startingProc = null
      }
      return
    }
    this.disposed = true
    this.startupGeneration += 1
    this.canonicalStorageGeneration += 1
    this.canonicalStoragePromise = null
    this.canonicalStorageDone = false
    this.canonicalStorageError = null
    const starting = this.startingProc
    if (starting && isChildAlive(starting)) {
      console.log("[Kilo New] ServerManager: 🔴 Disposing — killing in-flight startup PID:", starting.pid)
      ServerManager.releasePrivateStreams({
        privateReader: (starting.stdio[4] as unknown as NodeJS.ReadableStream) ?? null,
        privateWriter: (starting.stdio[3] as unknown as NodeJS.WritableStream) ?? null,
      } as unknown as ServerInstance)
      ServerManager.killForStartingProc(starting, "SIGTERM")
      await ServerManager.waitForChildExit(starting, 5000, ServerManager.killForStartingProc)
      if (this.startingProc === starting) this.startingProc = null
    } else if (starting && this.startingProc === starting) {
      this.startingProc = null
    }
    if (!this.instance) {
      await this.sweepTokenAfterDispose()
      return
    }
    const inst = this.instance
    const proc = inst.process
    this.instance = null
    ServerManager.releasePrivateStreams(inst)
    // Retain exact epoch/token through dispose: detached token-carrying
    // grandchildren live in separate groups the serve group-kill cannot reach.
    this.rememberCrashed(inst)

    // Dispose kills the exact owned serve child only when still alive. A signal-dead
    // child (exitCode null + signalCode set) is already gone: no SIGTERM and no
    // post-crash kill(-pid) group guess, so a reused PGID is never signalled.
    // No name-based kill: foreign/persistent background processes are never touched.
    if (isChildAlive(proc)) {
      console.log("[Kilo New] ServerManager: 🔴 Disposing — sending SIGTERM to process group, PID:", proc.pid)
      ServerManager.killProcess(proc, "SIGTERM")
    } else {
      console.log("[Kilo New] ServerManager: 🔴 Disposing — owned child already dead, no kill", describeChildExit(proc))
    }

    await ServerManager.waitForChildExit(proc, 5000, ServerManager.killProcess)
    await this.sweepTokenAfterDispose()
  }

  private static waitForChildExit(
    proc: ChildProcess,
    ms: number,
    kill: (proc: ChildProcess, signal: NodeJS.Signals) => void,
  ): Promise<void> {
    if (!isChildAlive(proc)) return Promise.resolve()
    return new Promise((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      const off = () => {
        try {
          const p = proc as unknown as { off?: unknown; removeListener?: unknown }
          if (typeof p.off === "function") (p.off as (e: string, l: () => void) => void).call(proc, "exit", done)
          else if (typeof p.removeListener === "function")
            (p.removeListener as (e: string, l: () => void) => void).call(proc, "exit", done)
        } catch {}
      }
      const onExit = (fn: () => void) => {
        try {
          const p = proc as unknown as { once?: unknown; on?: unknown }
          if (typeof p.once === "function") (p.once as (e: string, l: () => void) => void).call(proc, "exit", fn)
          else if (typeof p.on === "function") (p.on as (e: string, l: () => void) => void).call(proc, "exit", fn)
        } catch {}
      }
      const timer = setTimeout(() => {
        if (isChildAlive(proc)) {
          console.warn("[Kilo New] ServerManager: ⚠️ Process did not exit after SIGTERM, sending SIGKILL")
          try {
            kill(proc, "SIGKILL")
          } catch {}
        }
        // Bounded SIGKILL grace before relinquishing (no indefinite hang).
        const grace = setTimeout(() => {
          off()
          done()
        }, 2000)
        ;(grace as unknown as { unref?: () => void })?.unref?.()
        onExit(() => {
          clearTimeout(grace)
          done()
        })
      }, ms)
      ;(timer as unknown as { unref?: () => void })?.unref?.()
      onExit(done)
    })
  }

  /**
   * Awaited post-dispose token sweep for detached grandchildren the serve
   * group-kill cannot reach. Exact-PID only, never group/pattern; failure only
   * logs because dispose owns no replacement to withhold, but the caller has
   * awaited the outcome — nothing is silently abandoned.
   */
  private async sweepTokenAfterDispose(): Promise<void> {
    const dead = this.crashed
    if (!dead || !isValidRuntimeToken(dead.token)) return
    try {
      const out = await cleanupOwnedProcesses(dead.token)
      if (out.status === "clean") {
        if (this.crashed && this.crashed.epoch === dead.epoch) this.crashed = null
        console.log("[Kilo New] ServerManager: 🧹 Dispose sweep clean", { epoch: dead.epoch, killed: out.killed })
      } else {
        console.warn("[Kilo New] ServerManager: 🧹 Dispose sweep incomplete:", out.status, out.reason)
      }
    } catch (err) {
      console.warn("[Kilo New] ServerManager: 🧹 Dispose sweep error:", String(err))
    }
  }

  /** Test-only read of the retained crash identity (epoch/token, never secrets). */
  public getCrashedForTest(): CrashedInstanceIdentity | null {
    return this.crashed ? { ...this.crashed } : null
  }
}

export class ServerStartupError extends Error {
  readonly userMessage: string
  readonly userDetails: string
  constructor(userMessage: string, userDetails: string) {
    super(userDetails)
    this.name = "ServerStartupError"
    this.userMessage = userMessage
    this.userDetails = userDetails
  }
}

function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\([AB0]/g, "")
}

/**
 * Explicit backend failure signal. A stderr line is only eligible for the
 * concise `userMessage` when it carries one of these markers. Routine
 * INFO/DEBUG/TRACE-style records never match, so an INFO-only tail falls
 * through to the lifecycle `error` argument instead of promoting routine
 * output to the red banner.
 */
const EXPLICIT_FAILURE_RE =
  /\bERROR\b|\bWARN(ING)?\b|\bFATAL\b|\bfailed\b|\bfailure\b|\bexited?\b|\btimeout\b|\btimed?\s*out\b|\bEADDRINUSE\b|\bENOENT\b|\bEACCES\b|\bpanic\b|\bexception\b|\bcannot\b|\bcould not\b|\bunable to\b/i

/**
 * Translate VS Code's `http.proxy` / `http.noProxy` / `http.proxySupport`
 * settings into the standard proxy env vars, so the spawned CLI honors the
 * user's proxy configuration. Returns an empty object when no override is
 * needed, so callers can spread unconditionally.
 *
 * `http.proxySupport: "off"` is VS Code's opt-in way to disable proxy support
 * entirely; when set, we explicitly clear the env vars so ambient shell
 * HTTP_PROXY/http_proxy doesn't leak into the spawned child.
 */
export function buildProxyEnv(): Record<string, string> {
  const httpConfig = vscode.workspace.getConfiguration("http")
  const proxyInfo = httpConfig.inspect<string>("proxy")
  const noProxyInfo = httpConfig.inspect<string[]>("noProxy")
  const proxySupport = httpConfig.get<string>("proxySupport")

  if (proxySupport === "off") {
    return { HTTP_PROXY: "", HTTPS_PROXY: "", NO_PROXY: "", http_proxy: "", https_proxy: "", no_proxy: "" }
  }

  const proxy = httpConfig.get<string>("proxy")
  const noProxy = httpConfig.get<string[]>("noProxy")
  const proxySet =
    proxyInfo !== undefined &&
    [
      proxyInfo.globalValue,
      proxyInfo.workspaceValue,
      proxyInfo.workspaceFolderValue,
      proxyInfo.globalLanguageValue,
      proxyInfo.workspaceLanguageValue,
      proxyInfo.workspaceFolderLanguageValue,
    ].some((value) => value !== undefined)
  const noProxySet =
    noProxyInfo !== undefined &&
    [
      noProxyInfo.globalValue,
      noProxyInfo.workspaceValue,
      noProxyInfo.workspaceFolderValue,
      noProxyInfo.globalLanguageValue,
      noProxyInfo.workspaceLanguageValue,
      noProxyInfo.workspaceFolderLanguageValue,
    ].some((value) => value !== undefined)
  const env: Record<string, string> = {}
  if (proxy && proxy.trim() !== "") {
    env.HTTP_PROXY = proxy
    env.HTTPS_PROXY = proxy
    env.http_proxy = proxy
    env.https_proxy = proxy
  }
  if (proxySet && proxy !== undefined && proxy.trim() === "") {
    env.HTTP_PROXY = ""
    env.HTTPS_PROXY = ""
    env.http_proxy = ""
    env.https_proxy = ""
  }
  if (Array.isArray(noProxy) && noProxy.length > 0) {
    env.NO_PROXY = noProxy.join(",")
    env.no_proxy = noProxy.join(",")
  }
  if (noProxySet && Array.isArray(noProxy) && noProxy.length === 0) {
    env.NO_PROXY = ""
    env.no_proxy = ""
  }
  return env
}

export function toErrorMessage(
  error: string,
  stderrLines: string[],
  cliPath?: string,
): {
  userMessage: string
  userDetails: string
  error: string
} {
  const rawLines = stderrLines.flatMap((line) => line.split("\n"))
  const cleaned = rawLines.map(stripAnsi)

  // First causal failure wins: the earliest explicit `Error:` record, else
  // the earliest explicit failure marker (ERROR/WARN/fatal/failed/exited/
  // timeout and equivalents). Pure routine output never qualifies, so an
  // INFO-only tail falls through to the lifecycle `error` argument below.
  const errorLine = cleaned.find((line) => /Error:\s+/.test(line))
  let userMessage: string
  if (errorLine) {
    userMessage = (errorLine.match(/Error:\s+(.+)/)?.[1] ?? errorLine).trim()
    if (userMessage === "") userMessage = stripAnsi(error).trim() || "Failed to start CLI backend"
  } else {
    const failureLine = cleaned.find((line) => line.trim() !== "" && EXPLICIT_FAILURE_RE.test(line))
    userMessage = failureLine ? failureLine.trim() : stripAnsi(error).trim() || "Failed to start CLI backend"
  }

  let lines = [error, ...rawLines]
  if (cliPath && cliPath.trim() !== "") {
    lines = [`CLI path: ${cliPath}`, ...lines]
  }

  const detailsText = lines.map(stripAnsi).join("\n").trim()

  return {
    userMessage,
    userDetails: detailsText,
    error,
  }
}
