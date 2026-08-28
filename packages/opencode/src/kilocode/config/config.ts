import path from "path"
import { Effect, Option } from "effect"
import { mergeDeep } from "remeda"
import * as Log from "@opencode-ai/core/util/log"
import { Global } from "@opencode-ai/core/global"
import { NamedError } from "@opencode-ai/core/util/error"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Hash } from "@opencode-ai/core/util/hash"
import { KilocodeAtomicWrite } from "./atomic-write"
import type { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceRef } from "@/effect/instance-ref"
import { isRecord } from "@/util/record"
import { ConfigErrorV1 as ConfigError } from "@opencode-ai/core/v1/config/error"
import type { Config } from "../../config/config"
import { canonicalRoot } from "@/project/instance-context"

export namespace KilocodeConfig {
  const log = Log.create({ service: "kilocode.config" })

  // ── Prepared mutation artifacts (LOCK-002) ───────────────────────────

  /**
   * A fully validated, in-memory config mutation. Produced by the canonical
   * prepare APIs (no write, no cache invalidation, no events), consumed by the
   * commit APIs. `original` is the exact persisted content before the mutation
   * (undefined when the target did not exist) so a later failure can restore
   * the target exactly — including deleting a newly created target.
   */
  export type PreparedConfig = {
    readonly path: string
    readonly existed: boolean
    readonly original: string | undefined
    readonly next: string
    readonly info: Config.Info
    readonly changed: boolean
  }

  /**
   * Canonical discovery lock key for the global config domain (LOCK-001).
   * Independent of the eventual target file, so target discovery and the write
   * are one stable decision across processes: every global writer acquires
   * this key BEFORE resolving the target, then holds it through prepare+commit.
   *
   * The key derives deterministically from the canonical global config domain
   * (the resolved Global.Path.config) rather than a process-independent
   * constant, mirroring `configDiscoveryProjectKey`: processes sharing the same
   * config root hash to the same key and serialize, while isolated roots (e.g.
   * XDG-sandboxed or test config domains) hash to distinct keys and never
   * contend on each other's locks.
   */
  export const configDiscoveryGlobalKey = () =>
    `config:discover:global:${Hash.fast(path.resolve(Global.Path.config))}`

  /**
   * Canonical discovery lock key for a project config domain (LOCK-001/005).
   * Keyed on the canonical project root (canonicalRoot(directory, worktree))
   * — the same domain that projectConfigUpdateTarget and projectTarget use to
   * derive the canonical `.kilo/kilo.jsonc` target — so every writer of that
   * single canonical file serializes through one identical key, even when
   * callers present the same workspace via different directory/worktree pairs
   * (e.g. workspace root vs nested child, or non-git instances reporting "/").
   * The key is deterministic across processes and independent of the eventual
   * candidate file.
   */
  export const configDiscoveryProjectKey = (directory: string, worktree?: string) =>
    `config:discover:project:${Hash.fast(path.resolve(canonicalRoot(directory, worktree)))}`

  /** Global config target file (canonical only). */
  export function globalConfigTarget(): string {
    return path.join(Global.Path.config, "kilo.jsonc")
  }

  // ── Config file constants ────────────────────────────────────────────

  /** Kilo-specific config file names (canonical only). */
  export const KILO_CONFIG_FILES = ["kilo.jsonc"] as const

  /** All config file names (canonical only). */
  export const ALL_CONFIG_FILES = ["kilo.jsonc"] as const

  /** Config directory suffix (canonical only). */
  export const KILO_DIR_SUFFIXES = [".kilo"] as const

  /** Path patterns for resolving kilo agent names from file paths (canonical only). */
  export const AGENT_PATTERNS = ["/.kilo/agent/", "/.kilo/agents/"] as const

  /** Path patterns for resolving kilo command names from file paths (canonical only). */
  export const COMMAND_PATTERNS = ["/.kilo/command/", "/.kilo/commands/"] as const

  /**
   * Choose the project config file that Config.update should patch.
   *
   * Deterministic canonical workspace/worktree-root target with no
   * discovery/legacy fallback: always `path.join(canonicalRoot(directory,
   * worktree), ".kilo", "kilo.jsonc")`. No ancestor scanning, no
   * candidate preference, no legacy source.
   */
  export const projectConfigUpdateTarget = Effect.fn("KilocodeConfig.projectConfigUpdateTarget")(function* (input: {
    fs: FSUtil.Interface
    directory: string
    worktree?: string
  }) {
    void input.fs
    const root = canonicalRoot(input.directory, input.worktree)
    return path.join(root, ".kilo", "kilo.jsonc")
  })

  /**
   * Prepare a project config mutation in memory: discover the target file,
   * read its exact current content, apply the JSONC/merge/writable/schema
   * behavior, and validate the result — without writing, invalidating,
   * disposing, or emitting (LOCK-002). The returned artifact carries the
   * exact original content and the exact next content for atomic commit and
   * compensating rollback.
   */
  export const prepareProjectConfig = Effect.fn("KilocodeConfig.prepareProjectConfig")(function* (input: {
    fs: FSUtil.Interface
    directory: string
    worktree?: string
    config: Config.Info
    file?: string // kilocode_change - LOCK-002: pre-resolved target; do not rediscover under the lock
    read: (file: string) => Effect.Effect<string | undefined>
    parse: (input: string, file: string) => Config.Info
    patch: (input: string, config: Config.Info) => string
    writable: (config: Config.Info) => Config.Info
  }) {
    const file = input.file ?? (yield* projectConfigUpdateTarget(input))
    const source = yield* input.read(file)
    const before = source ?? "{}"
    const patch = input.writable(input.config)

    if (file.endsWith(".jsonc")) {
      if (source === undefined && Object.keys(mergeConfig({}, patch)).length === 0)
        return { path: file, existed: false, original: undefined, next: before, info: {} as Config.Info, changed: false }
      const updated = input.patch(before, patch)
      const next = input.parse(updated, file)
      const previous = input.parse(before, file)
      const changed = stable(next) !== stable(previous)
      return { path: file, existed: source !== undefined, original: source, next: updated, info: next, changed }
    }

    const existing = input.parse(before, file)
    const merged = mergeConfig(input.writable(existing), patch)
    if (source === undefined && Object.keys(merged).length === 0)
      return { path: file, existed: false, original: undefined, next: before, info: merged, changed: false }
    const serialized = JSON.stringify(merged, null, 2)
    input.parse(serialized, file)
    const changed = stable(merged) !== stable(existing)
    return { path: file, existed: source !== undefined, original: source, next: serialized, info: merged, changed }
  })

  /**
   * Legacy project config update: prepare + persist under the canonical
   * project target lock (LOCK-002). Used by callers that own their own
   * serialization (snapshot tracking) and must NOT dispose the active
   * instance or emit ConfigUpdated events for the live stream.
   *
   * The canonical cross-process discovery lock for the project directory is
   * acquired BEFORE resolving the target (LOCK-001): target discovery and the
   * write are one stable decision, and every writer of any target in the
   * directory serializes through the same key. The target is resolved exactly
   * once under the lock, then prepare/commit use that exact resolved path.
   * Commit goes through `KilocodeAtomicWrite` (temp-file + rename), never a
   * partial write. The lock is reentrant per fiber (EffectFlock depth
   * tracking), so a caller that already holds the discovery lock cannot
   * self-deadlock. When the EffectFlock service is absent (bare FSUtil
   * runtimes), the write still commits atomically without the lock, preserving
   * prior callers.
   */
  export const updateProjectConfig = Effect.fn("KilocodeConfig.updateProjectConfig")(function* (input: {
    fs: FSUtil.Interface
    directory: string
    worktree?: string
    config: Config.Info
    read: (file: string) => Effect.Effect<string | undefined>
    parse: (input: string, file: string) => Config.Info
    patch: (input: string, config: Config.Info) => string
    writable: (config: Config.Info) => Config.Info
  }) {
    const write = Effect.gen(function* () {
      // LOCK-001: target discovery happens under the discovery lock — never
      // before it — so a concurrent higher-precedence file creation can never
      // make this save land in a shadowed target.
      const file = yield* projectConfigUpdateTarget(input)
      const prepared = yield* prepareProjectConfig({ ...input, file })
      if (!prepared.changed) return { config: prepared.info, changed: false }
      yield* KilocodeAtomicWrite.write(input.fs, prepared.path, prepared.next)
      return { config: prepared.info, changed: true }
    })
    const flock = yield* Effect.serviceOption(EffectFlock.Service)
    if (Option.isSome(flock)) {
      return yield* flock.value
        .withLock(write, configDiscoveryProjectKey(input.directory, input.worktree))
        .pipe(
          Effect.catchTag("LockTimeoutError", (error) => Effect.die(error)),
          Effect.catchTag("LockCompromisedError", (error) => Effect.die(error)),
        )
    }
    return yield* write
  })

  function stable(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
    if (isRecord(value)) {
      // kilocode_change - omit undefined object values (JSON semantics); the
      // global shell sentinel maps "" → undefined, so an omitted key and an
      // explicitly undefined value must compare equal. Arrays cannot contain
      // undefined in JSON config; such values are rejected by the throw below.
      return `{${Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
        .join(",")}}`
    }
    if (value === null) return "null"
    if (typeof value === "string") return JSON.stringify(value)
    if (typeof value === "number" || typeof value === "boolean") return String(value)
    throw new TypeError(`Unsupported config value in semantic comparison: ${typeof value}`)
  }

  // ── Warning helpers ──────────────────────────────────────────────────

  /** Convert known config-loading error types into a Warning.  Returns undefined for unknown errors. */
  export function toWarning(err: unknown): Config.Warning | undefined {
    if (ConfigError.JsonError.isInstance(err))
      return {
        path: err.data.path,
        message: `Config file at ${err.data.path} is not valid JSON(C)`,
        detail: err.data.message || undefined,
      }
    if (ConfigError.InvalidError.isInstance(err)) {
      const text = err.data.issues ? formatIssues(err.data.issues) : err.data.message
      return {
        path: err.data.path,
        message: text
          ? `Configuration is invalid at ${err.data.path}: ${text}`
          : `Configuration is invalid at ${err.data.path}`,
      }
    }
    return undefined
  }

  type Issue = { readonly message: string; readonly path: readonly string[]; readonly [key: string]: unknown }

  /** Format schema issues into a human-readable string. */
  export function formatIssues(issues: readonly Issue[]) {
    return issues
      .map((issue) => {
        const loc = issue.path.map(String).join(".")
        if (!loc) return issue.message
        return `${loc}: ${issue.message}`
      })
      .join("\n")
  }

  /** Handle an invalid agent/command config: log, publish session error, collect warning. */
  export async function handleInvalid(
    kind: "agent" | "command",
    item: string,
    issues: readonly Issue[],
    cause: Error,
    warnings?: Config.Warning[],
  ) {
    const text = formatIssues(issues)
    const message = text ? `Config file at ${item} is invalid: ${text}` : `Config file at ${item} is invalid`
    const err = new ConfigError.InvalidError({ path: item, issues }, { cause })
    if (warnings) warnings.push({ path: item, message, detail: text || undefined })
    try {
      const [{ Session }, { capture }, { AppRuntime }, { EventV2Bridge }] = await Promise.all([
        import("@/session/session"),
        import("@/kilocode/instance"),
        import("@/effect/app-runtime"),
        import("@/event-v2-bridge"),
      ])
      const ctx = capture()
      if (ctx)
        await AppRuntime.runPromise(
          EventV2Bridge.Service.use((events) =>
            events.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() }),
          ).pipe(Effect.provideService(InstanceRef, ctx)),
        )
    } catch (e) {
      log.warn("could not publish session error", { message, err: e })
    }
    if (kind === "command") {
      log.error("failed to load command", { command: item, err, message })
      return
    }
    log.error("failed to load agent", { agent: item, err, message })
  }

  /**
   * Try running a callback. If it throws a known config error, convert to a
   * warning and push it into the array. Unknown errors are re-thrown.
   */
  export function caught(warnings: Config.Warning[], source: string, err: unknown) {
    const w = toWarning(err)
    if (w) {
      warnings.push(w)
      log.warn("skipped config due to error", { source, err })
      return
    }
    throw err
  }

  // ── Config merge utilities ───────────────────────────────────────────

  /** Recursively remove null values and drop objects left empty after removal. */
  export function stripNulls(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj)) {
      if (value === null) continue
      if (isRecord(value)) {
        const stripped = stripNulls(value)
        if (Object.keys(stripped).length > 0) result[key] = stripped
      } else {
        result[key] = value
      }
    }
    return result
  }

  /**
   * Merge a patch into an existing config:
   * 1. Normalize permission scalars → objects when the patch has an object
   *    (e.g. existing `"bash": "ask"` + patch `"bash": { "npm *": "allow" }`
   *    → promotes existing to `"bash": { "*": "ask" }` so mergeDeep works)
   * 2. Deep-merge
   * 3. Strip null delete sentinels
   */
  export function mergeConfig(existing: Config.Info, patch: Config.Info): Config.Info {
    const e = { ...existing } as Record<string, unknown>
    const p = patch as Record<string, unknown>

    // Normalize permission scalars before merge
    const existingPerm = e.permission
    const patchPerm = p.permission
    if (isRecord(existingPerm) && isRecord(patchPerm)) {
      const cloned = { ...existingPerm }
      for (const [key, value] of Object.entries(patchPerm)) {
        const existing = cloned[key]
        if (typeof existing === "string" && isRecord(value)) {
          cloned[key] = { "*": existing }
        }
      }
      e.permission = cloned
    }

    return stripNulls(mergeDeep(e, p) as Record<string, unknown>) as Config.Info
  }

  // ── Directory check helper ───────────────────────────────────────────

  /** Check whether a directory path should be treated as a config directory (canonical only). */
  export function isConfigDir(dir: string): boolean {
    return dir.endsWith(".kilo")
  }
}
