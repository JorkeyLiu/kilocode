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
import { LlmRequestCollector, type LlmRequestRecord } from "./llm-request-collector"
import { p0Stage, isP0PerfEnabled } from "../../perf/perf-instrument"
import { resolveCanonicalDbPath } from "../../private-worker/canonical-db-path"

export interface ServerInstance {
  port: number
  password: string
  process: ChildProcess
  privateReader: NodeJS.ReadableStream | null
  privateWriter: NodeJS.WritableStream | null
  pid: number | undefined
  epoch: number
}

const STARTUP_TIMEOUT_SECONDS = 30

type WorkspaceFolderLike = { uri: { fsPath: string } }
type ServerExitListener = (code: number | null) => void

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
 * Resolve the CLI binary path to spawn.
 *
 * Production always returns the bundled binary under the extension dir. The
 * benchmark-only `KILO_P0_BACKEND_CLI` env override (opt-in KILO_P0_* flag,
 * same trust level as KILO_P0_PERF; never set in production) is honored ONLY
 * when explicitly set: the P0 harness copies `bin/kilo` to a run-owned temp
 * snapshot path before the campaign and pins it here so the non-owned dev
 * watcher (script/watch-cli.ts) cannot change the measured binary
 * mid-campaign. When the override is absent or empty the bundled fallback is
 * unchanged — disabled product behavior is identical.
 */
export function resolveCliPath(extensionPath: string, env?: NodeJS.ProcessEnv): string {
  const override = env?.KILO_P0_BACKEND_CLI
  if (override && override.trim() !== "") {
    console.log("[Kilo New] ServerManager: 📦 Using benchmark CLI snapshot:", override)
    return override
  }
  const binName = process.platform === "win32" ? "kilo.exe" : "kilo"
  return path.join(extensionPath, "bin", binName)
}

export class ServerManager {
  private instance: ServerInstance | null = null
  private startupPromise: Promise<ServerInstance> | null = null
  private epochCounter = 0

  /**
   * E2E fixture generation-request collector (KILO_E2E_FIXTURE only): sees
   * every backend `service=llm ... providerID=... modelID=...` line through
   * the stderr relay BEFORE provider/network resolution and persists typed
   * records to the run-owned scratch store (see llm-request-collector.ts).
   * Null in production — no collector is created and no line is parsed.
   */
  private llmStore: LlmRequestCollector | null = null
  private llmInstance = 0

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onExit?: ServerExitListener,
  ) {}

  /**
   * Get or start the server instance
   */
  async getServer(): Promise<ServerInstance> {
    console.log("[Kilo New] ServerManager: 🔍 getServer called")
    if (this.instance) {
      console.log("[Kilo New] ServerManager: ♻️ Returning existing instance:", { port: this.instance.port })
      return this.instance
    }

    if (this.startupPromise) {
      console.log("[Kilo New] ServerManager: ⏳ Startup already in progress, waiting...")
      return this.startupPromise
    }

    console.log("[Kilo New] ServerManager: 🚀 Starting new server instance...")
    this.startupPromise = this.startServer()
    try {
      this.instance = await this.startupPromise
      console.log("[Kilo New] ServerManager: ✅ Server started successfully:", { port: this.instance.port })
      return this.instance
    } finally {
      this.startupPromise = null
    }
  }

  private async startServer(): Promise<ServerInstance> {
    const password = crypto.randomBytes(32).toString("hex")
    const cliPath = this.getCliPath()
    console.log("[Kilo New] ServerManager: 📍 CLI path:", cliPath)
    console.log("[Kilo New] ServerManager: 🔐 Generated password (length):", password.length)

    // E2E fixture generation-request collection (KILO_E2E_FIXTURE only): the
    // run-owned scratch store is created lazily on the first spawn so every
    // `service=llm` line of every server instance lands in the same
    // append-only file. `instance` counts each spawn so records are
    // attributable across worker restarts/launches (real-restart Phase B/C).
    this.llmInstance += 1
    if (!this.llmStore && process.env.KILO_E2E_FIXTURE && process.env.KILO_E2E_SCRATCH) {
      this.llmStore = new LlmRequestCollector(path.join(process.env.KILO_E2E_SCRATCH, "llm-requests.jsonl"))
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
        this.context.extensionMode === (vscode as unknown as { ExtensionMode?: { Development: number } }).ExtensionMode?.Development ||
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
      const p0LogArgs = isP0PerfEnabled() || !!process.env.KILO_E2E_FIXTURE ? ["--print-logs"] : []
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
        },
        stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
        detached: true,
      })
      console.log("[Kilo New] ServerManager: 📦 Process spawned with PID:", serverProcess.pid)
      this.epochCounter += 1
      const epoch = this.epochCounter
      const pid = serverProcess.pid
      const privateWriter = (serverProcess.stdio[3] as unknown as NodeJS.WritableStream) ?? null
      const privateReader = (serverProcess.stdio[4] as unknown as NodeJS.ReadableStream) ?? null
      p0Stage("spawn.done", { pid: serverProcess.pid })

      let resolved = false
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
          resolved = true
          console.log("[Kilo New] ServerManager: 🎯 Port detected:", port)
          p0Stage("port.detected", { port })
          resolve({ port, password, process: serverProcess, privateReader, privateWriter, pid, epoch })
        }
      })

      serverProcess.stderr?.on("data", (data: Buffer) => {
        stderrTail.write(data)
      })

      serverProcess.on("error", (error) => {
        console.error("[Kilo New] ServerManager: ❌ Process error:", error)
        if (!resolved) {
          stderrTail.flush()
          reject(error)
        }
      })

      serverProcess.on("exit", (code) => {
        console.log("[Kilo New] ServerManager: 🛑 Process exited with code:", code)
        if (this.instance?.process === serverProcess) {
          const dying = this.instance
          this.instance = null
          ServerManager.releasePrivateStreams(dying)
          this.onExit?.(code)
        } else {
          ServerManager.releasePrivateStreams({ privateReader, privateWriter } as unknown as ServerInstance)
        }
        if (!resolved) {
          stderrTail.flush()
          const { userMessage, userDetails } = toErrorMessage(
            t("server.processExited", { code: code ?? "null" }),
            stderrTail.tail(),
            cliPath,
          )
          reject(new ServerStartupError(userMessage, userDetails))
        }
      })

      setTimeout(() => {
        if (!resolved) {
          console.error(`[Kilo New] ServerManager: ⏰ Server startup timeout (${STARTUP_TIMEOUT_SECONDS}s)`)
          ServerManager.killProcess(serverProcess)
          stderrTail.flush()
          const { userMessage, userDetails } = toErrorMessage(
            t("server.startupTimeout", { seconds: STARTUP_TIMEOUT_SECONDS }),
            stderrTail.tail(),
            cliPath,
          )
          reject(new ServerStartupError(userMessage, userDetails))
        }
      }, STARTUP_TIMEOUT_SECONDS * 1000)
    })
  }

  /**
   * E2E fixture bridge (KILO_E2E_FIXTURE only, registered by extension.ts):
   * exact PID + port of the CURRENT server instance. Read-only; returns null
   * when no server is running or the fixture env is absent. No production
   * effect — the caller (the connection service's fixture command) is itself
   * env-gated.
   */
  public getServerPidForFixture(): { pid: number; port: number } | null {
    if (!process.env.KILO_E2E_FIXTURE) return null
    const instance = this.instance
    if (!instance?.process.pid) return null
    return { pid: instance.process.pid, port: instance.port }
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
    if (!process.env.KILO_E2E_FIXTURE) return null
    const instance = this.instance
    if (!instance?.process.pid) return null
    console.log(
      "[Kilo New] ServerManager: fixture kill — SIGTERM to exact owned process group, PID:",
      instance.process.pid,
    )
    ServerManager.killProcess(instance.process, "SIGTERM")
    return { pid: instance.process.pid, port: instance.port }
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
    if (!process.env.KILO_E2E_FIXTURE) return null
    if (!this.llmStore) return null
    return { records: this.llmStore.read(), file: this.llmStoreFile() }
  }

  /**
   * E2E fixture bridge (KILO_E2E_FIXTURE only): clear the generation-request
   * store. Called once at the start of a real-* scenario run (never between
   * real-restart launches — the persisted evidence must aggregate across
   * them). No production effect.
   */
  public resetLlmRequestsForFixture(): boolean {
    if (!process.env.KILO_E2E_FIXTURE) return false
    if (!this.llmStore) {
      if (!process.env.KILO_E2E_SCRATCH) return false
      this.llmStore = new LlmRequestCollector(this.llmStoreFile())
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
   * Kill a process and its entire process group.
   * On Unix, we send the signal to -pid (negative) to reach the whole group.
   * On Windows, process.kill() on the child handle is sufficient.
   */
  private static killProcess(proc: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
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
      console.warn("[Kilo ServerManager] killProcess failed (already gone?):", String(err))
    }
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

  dispose(): void {
    if (!this.instance) {
      return
    }
    const inst = this.instance
    const proc = inst.process
    this.instance = null
    ServerManager.releasePrivateStreams(inst)

    console.log("[Kilo New] ServerManager: 🔴 Disposing — sending SIGTERM to process group, PID:", proc.pid)
    ServerManager.killProcess(proc, "SIGTERM")

    // SIGKILL fallback after 5s. Ensures the process tree dies even if SIGTERM is ignored
    // or Instance.disposeAll() hangs past the serve.ts shutdown timeout.
    const timer = setTimeout(() => {
      if (proc.exitCode === null) {
        console.warn("[Kilo New] ServerManager: ⚠️ Process did not exit after SIGTERM, sending SIGKILL")
        ServerManager.killProcess(proc, "SIGKILL")
      }
    }, 5000)
    // unref so this timer doesn't prevent the extension host from exiting
    timer.unref()
    proc.on("exit", () => clearTimeout(timer))
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
  return str.replace(/\x1b\[[0-9;]*m/g, "")
}

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
  let lines = stderrLines.flatMap((line) => line.split("\n"))

  const errorLine = lines.map(stripAnsi).find((line) => /Error:\s+/.test(line))
  const userMessage = errorLine
    ? errorLine.match(/Error:\s+(.+)/)![1].trim()
    : stripAnsi([...lines].reverse().find((line) => line.trim() !== "") ?? error).trim()

  lines = [error, ...lines]
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
