import type { Argv } from "yargs"
import * as Log from "@opencode-ai/core/util/log"
import { Global } from "@opencode-ai/core/global"
import { InstallationBuildKind, InstallationVersion } from "@opencode-ai/core/installation/version"
import { Telemetry } from "@kilocode/kilo-telemetry"
import { migrateLegacyKiloAuth, ENV_FEATURE, ENV_VERSION } from "@kilocode/kilo-gateway"
import { AppRuntime } from "@/effect/app-runtime"
import { Config } from "@/config/config"
import { Auth } from "@/auth"
import { InstanceRuntime } from "@/project/instance-runtime"
import { SessionExport } from "@/kilocode/session-export"
import { KiloShutdown } from "@/kilocode/cli/shutdown"
import { createHelpCommand } from "@/kilocode/help-command"
import { RollCallCommand } from "@/kilocode/cli/cmd/roll-call"
import { ProfileCommand } from "@/kilocode/cli/cmd/profile"
import { DaemonCommand } from "@/kilocode/cli/cmd/daemon"
import { DevSetupCommand, DevAliasCommand } from "@/kilocode/cli/dev-setup"
import { RemoteCommand } from "@/cli/cmd/remote"
import { ConfigCommand as ConfigCLICommand } from "@/cli/cmd/config"
import { JsonMigration } from "@/kilocode/storage/json-migration"
import * as P0Perf from "@/kilocode/perf/instrument" // kilocode_change - P0 instrumentation

const log = Log.create({ service: "kilocode.cli" })

// KiloCli-owned bootstrap identity background task. Single owner for the
// process: an AbortController plus the retained promise. The promise is never
// lost and never detached — shutdown aborts it and waits for
// settle before CLI_EXIT / SessionExport / Telemetry.shutdown.
let ctrl: AbortController | undefined
let pending: Promise<void> | undefined
let settled = true
let started = false
let closing = false
let gen = 0

const SETTLE_TIMEOUT_MS = 1500

// All Kilo-specific CLI customization lives here so the shared entrypoint
// (src/index.ts) stays thin and only hosts Kilo call-sites.
export namespace KiloCli {
  export type AuthRef = { token: string; account?: string }

  export type BootstrapDeps = {
    getGlobalConfig?: () => Promise<{ experimental?: { openTelemetry?: boolean } }>
    getKiloAuth?: () => Promise<AuthRef | undefined>
    migrateLegacy?: () => Promise<void>
    initTelemetry?: (opts: { dataPath: string; version: string; enabled: boolean }) => Promise<void>
    updateIdentity?: (token: string, account?: string, opts?: { signal?: AbortSignal }) => Promise<void>
    trackStart?: () => void
    jsonBootstrap?: () => Promise<void>
  }

  export type ShutdownDeps = {
    trackExit?: (code?: number) => void
    exportShutdown?: () => Promise<void>
    telemetryShutdown?: (timeoutMs?: number) => Promise<void>
    dispose?: () => Promise<void>
    settleTimeoutMs?: number
  }

  export function isExplicitTelemetryLevel(value: string | undefined): boolean {
    return value === "all" || value === "off"
  }

  export function __stateForTests(): {
    hasTask: boolean
    started: boolean
    closing: boolean
    gen: number
  } {
    return { hasTask: pending !== undefined && !settled, started, closing, gen }
  }

  export function waitForIdentityForTests(): Promise<void> {
    if (!pending) return Promise.resolve()
    return pending.then(
      () => undefined,
      () => undefined,
    )
  }

  export async function __resetForTests(): Promise<void> {
    const prior = pending
    const priorCtrl = ctrl
    gen += 1
    ctrl = undefined
    pending = undefined
    settled = true
    started = false
    closing = false
    if (priorCtrl && prior && priorCtrl.signal.aborted === false) {
      try {
        priorCtrl.abort()
      } catch (err) {
        log.warn("identity reset abort failed", { err })
      }
    }
    if (prior) {
      await prior.then(
        () => undefined,
        () => undefined,
      )
    }
  }

  // Register only the Kilo-specific commands. Shared commands stay in index.ts's chain,
  // so this module only owns Kilo command registration.
  export function register<T>(cli: Argv<T>): Argv<T> {
    cli
      .command(RollCallCommand)
      .command(ProfileCommand)
      .command(RemoteCommand)
      .command(DaemonCommand)
      .command(ConfigCLICommand)
    if (InstallationBuildKind !== "release") cli.command(DevSetupCommand).command(DevAliasCommand)
    // Safe self-reference: `cli` is a typed parameter and yargs `.command()` returns the same
    // instance, so the help command can resolve the fully-built root at handler time. This also
    // sidesteps the self-referential type error the old inline registration hit in index.ts.
    cli.command(createHelpCommand(() => cli))
    return cli
  }

  export async function runner() {
    const timer = P0Perf.span("cli_runner") // kilocode_change - P0 instrumentation
    if (!process.argv.includes("__background-process-runner")) {
      timer.end()
      return false
    }
    const out = await (await import("@/kilocode/background-process/runner")).BackgroundProcessRunner.maybe()
    timer.end()
    return out
  }

  // Runs from the shared `.middleware` hook, before any command handler. Env tagging is
  // additive so the shared entrypoint's env assignments are left untouched.
  export async function bootstrap(deps?: BootstrapDeps): Promise<void> {
    // Supersede any prior pending identity work (repeated bootstrap/test):
    // abort the previous owner so its fetch settles fast, then transfer
    // ownership to the new generation. The old continuation checks `gen` and
    // never records CLI_START.
    const priorCtrl = ctrl
    if (priorCtrl && !settled) {
      try {
        priorCtrl.abort()
      } catch (err) {
        log.warn("identity supersede abort failed", { err })
      }
    }
    ctrl = undefined
    pending = undefined
    settled = true
    closing = false
    gen += 1
    const id = gen

    if (!process.env[ENV_FEATURE]) process.env[ENV_FEATURE] = process.argv.includes("serve") ? "unknown" : "cli"
    if (!process.env[ENV_VERSION]) process.env[ENV_VERSION] = InstallationVersion
    process.env.KILO = "1"

    // Must run before AppRuntime initializes the SQLite database, or the marker
    // exists before legacy JSON can be imported.
    const jsonTimer = P0Perf.span("json_migration_bootstrap") // kilocode_change - P0 instrumentation
    await (deps?.jsonBootstrap ?? (() => JsonMigration.bootstrap()))()
    jsonTimer.end()

    // Extension-owned local serve always injects KILO_TELEMETRY_LEVEL=all|off
    // with env priority inside Telemetry.init. When explicit, skip the ~0.8s
    // global config read entirely — it only feeds the telemetry switch.
    // Unset/illegal values keep the existing config fallback semantics.
    const level = process.env.KILO_TELEMETRY_LEVEL
    const explicit = isExplicitTelemetryLevel(level)
    const enabled = explicit
      ? level === "all"
      : await (async () => {
          const cfgTimer = P0Perf.span("config_get_global") // kilocode_change - P0 instrumentation
          try {
            const cfg = await (deps?.getGlobalConfig ??
              (() => AppRuntime.runPromise(Config.Service.use((c) => c.getGlobal()))))()
            return cfg.experimental?.openTelemetry !== false
          } finally {
            cfgTimer.end()
          }
        })()
    if (explicit) P0Perf.mark("config_get_global_skip", { meta: { level } })

    const telemetryTimer = P0Perf.span("telemetry_init") // kilocode_change - P0 instrumentation
    await (deps?.initTelemetry ??
      ((opts) =>
        Telemetry.init({
          dataPath: Global.Path.data,
          version: InstallationVersion,
          enabled: opts.enabled,
        })))({ dataPath: Global.Path.data, version: InstallationVersion, enabled })
    telemetryTimer.end()

    // Migrate legacy Kilo CLI auth (~/.kilocode/cli/config.json) into auth.json if present.
    const legacyTimer = P0Perf.span("legacy_auth_migration") // kilocode_change - P0 instrumentation
    await (deps?.migrateLegacy ??
      (() =>
        migrateLegacyKiloAuth(
          async () => {
            const hasTimer = P0Perf.span("auth_has_check") // kilocode_change - P0 instrumentation
            const has = (await AppRuntime.runPromise(Auth.Service.use((s) => s.get("kilo")))) !== undefined
            hasTimer.end()
            return has
          },
          async (auth) => {
            const saveTimer = P0Perf.span("legacy_auth_save") // kilocode_change - P0 instrumentation
            await AppRuntime.runPromise(Auth.Service.use((s) => s.set("kilo", auth)))
            saveTimer.end()
          },
        )))()
    legacyTimer.end()

    const authTimer = P0Perf.span("auth_get") // kilocode_change - P0 instrumentation
    const found = await (deps?.getKiloAuth ??
      (async (): Promise<AuthRef | undefined> => {
        const auth = await AppRuntime.runPromise(Auth.Service.use((s) => s.get("kilo")))
        if (!auth) return undefined
        return {
          token: auth.type === "oauth" ? auth.access : auth.key,
          account: auth.type === "oauth" ? auth.accountId : undefined,
        }
      }))()
    authTimer.end()

    const track = deps?.trackStart ?? (() => Telemetry.trackCliStart())
    if (!found) {
      if (id === gen) markStarted(track)
      return
    }

    // Auth present: do not await the 1-3s identity network fetch before the
    // command handler (listener). Dispatch in the background under KiloCli
    // ownership; CLI_START follows settle so enrichment order is preserved.
    // The span measures dispatch only — it ends right after start, never
    // claiming network completion.
    const update = deps?.updateIdentity ?? ((token, account, opts) => Telemetry.updateIdentity(token, account, opts))
    const dispatchTimer = P0Perf.span("telemetry_identity_update") // kilocode_change - P0 instrumentation
    const owner = new AbortController()
    ctrl = owner
    settled = false
    const run: Promise<void> = (async () => {
      try {
        await update(found.token, found.account, { signal: owner.signal })
      } catch (err) {
        if (owner.signal.aborted) log.info("telemetry identity background aborted", { gen: id })
        if (!owner.signal.aborted) log.warn("telemetry identity background failed", { err })
      } finally {
        settleMark(id)
        if (id === gen && !closing && !owner.signal.aborted) markStarted(track)
        if (id === gen) settled = true
      }
    })()
    pending = run
    dispatchTimer.end()
    run.then(
      () => undefined,
      () => undefined,
    )
  }

  function markStarted(track: () => void): void {
    if (started) return
    started = true
    const timer = P0Perf.span("telemetry_track_cli_start") // kilocode_change - P0 instrumentation
    try {
      track()
    } finally {
      timer.end()
    }
  }

  function settleMark(id: number): void {
    if (process.env.KILO_P0_IDENTITY_SETTLE !== "1") return
    P0Perf.mark("telemetry_identity_settle", { meta: { gen: id } })
  }

  async function settleOwned(timeoutMs: number): Promise<void> {
    const task = pending
    const owner = ctrl
    if (!owner || !task || settled) return
    try {
      owner.abort()
    } catch (err) {
      log.warn("identity abort failed", { err })
    }
    await Promise.race([
      task.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs)
        if (typeof timer.unref === "function") timer.unref()
      }),
    ])
    ctrl = undefined
    pending = undefined
    settled = true
  }

  // Runs from the `finally` block on every exit path.
  export async function shutdown(deps?: ShutdownDeps): Promise<void> {
    closing = true
    await settleOwned(deps?.settleTimeoutMs ?? SETTLE_TIMEOUT_MS)
    const code = typeof process.exitCode === "number" ? process.exitCode : undefined
    ;(deps?.trackExit ?? ((c) => Telemetry.trackCliExit(c)))(code)
    try {
      await (deps?.exportShutdown ?? (() => SessionExport.shutdown()))()
      // Bound telemetry shutdown so an unreachable endpoint (offline, firewall,
      // DNS adblock resolving the host to 0.0.0.0) cannot block process exit on
      // short-lived commands like `kilo --help` / `kilo --version` (#9788).
      try {
        await (deps?.telemetryShutdown ?? ((t) => Telemetry.shutdown(t)))(2000)
      } catch (err) {
        log.warn("telemetry shutdown failed", { err })
      }
    } finally {
      await KiloShutdown.run()
      await (deps?.dispose ?? (() => InstanceRuntime.disposeAllInstances()))() // safety net (no-op if already disposed)
    }
  }
}
