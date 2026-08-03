import path from "path"
import { pathToFileURL } from "url"
import { existsSync } from "fs"
import { Effect, Option, Schema } from "effect"
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser"
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
import type { ConfigAgentV1 } from "@opencode-ai/core/v1/config/agent"
import { ModesMigrator } from "../modes-migrator"
import { fetchOrganizationModes } from "@kilocode/kilo-gateway"
import { RulesMigrator } from "../rules-migrator"
import { WorkflowsMigrator } from "../workflows-migrator"
import { McpMigrator } from "../mcp-migrator"
import { IgnoreMigrator } from "../ignore-migrator"

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
   * Canonical discovery lock key for a project config domain (LOCK-001).
   * Keyed on the canonical normalized directory only — never on a config
   * candidate and never on a caller-derived worktree (the worktree is a
   * derived property of the directory and callers do not derive it
   * identically, e.g. non-git instances report "/" while direct callers pass
   * nothing) — so it is deterministic across processes and every writer of
   * any target inside the directory serializes through the same single key.
   */
  export const configDiscoveryProjectKey = (directory: string) =>
    `config:discover:project:${Hash.fast(path.resolve(directory))}`

  /** Global config target file (mirror of the Config module's discovery). */
  export function globalConfigTarget(): string {
    const candidates = ["kilo.jsonc", "kilo.json", "opencode.jsonc", "opencode.json", "config.json"].map((file) =>
      path.join(Global.Path.config, file),
    )
    return candidates.find((file) => existsSync(file)) ?? candidates[0]!
  }

  // ── Config schema extensions ─────────────────────────────────────────

  /** Schema for AI-generated commit message configuration. */
  export const CommitMessageSchema = Schema.optional(
    Schema.Struct({
      prompt: Schema.optional(Schema.String).annotate({
        description:
          "Custom system prompt for AI commit message generation. When set, replaces the default conventional commits prompt entirely.",
      }),
    }),
  ).annotate({ description: "Configuration for AI-generated commit messages" })

  // ── Config file constants ────────────────────────────────────────────

  /** Kilo-specific config file names (highest-to-lowest precedence within kilo). */
  export const KILO_CONFIG_FILES = ["kilo.jsonc", "kilo.json"] as const

  /** All config file names in precedence order (kilo + opencode). */
  export const ALL_CONFIG_FILES = ["kilo.jsonc", "kilo.json", "opencode.jsonc", "opencode.json"] as const

  /** Config directory suffixes in update-target preference order. */
  export const KILO_DIR_SUFFIXES = [".kilo", ".kilocode"] as const

  /** Path patterns for resolving kilo agent names from file paths. */
  export const AGENT_PATTERNS = ["/.kilo/agent/", "/.kilo/agents/", "/.kilocode/agent/", "/.kilocode/agents/"] as const

  /** Path patterns for resolving kilo command names from file paths. */
  export const COMMAND_PATTERNS = [
    "/.kilo/command/",
    "/.kilo/commands/",
    "/.kilocode/command/",
    "/.kilocode/commands/",
  ] as const

  /**
   * Choose the project config file that Config.update should patch.
   *
   * This mirrors the Kilo project-config load chain: prefer existing config files
   * in ancestor config directories, then existing root config files, and create
   * `.kilo/kilo.jsonc` when no project config exists yet.
   */
  export const projectConfigUpdateTarget = Effect.fn("KilocodeConfig.projectConfigUpdateTarget")(function* (input: {
    fs: FSUtil.Interface
    directory: string
    worktree?: string
  }) {
    const dirs = yield* input.fs
      .up({ targets: [...KILO_DIR_SUFFIXES], start: input.directory, stop: input.worktree })
      .pipe(Effect.orDie)
    const roots = yield* input.fs
      .up({ targets: [...ALL_CONFIG_FILES], start: input.directory, stop: input.worktree })
      .pipe(Effect.orDie)
    const files = [...dirs.flatMap((dir) => ALL_CONFIG_FILES.map((file) => path.join(dir, file))), ...roots]
    return files.find((file) => existsSync(file)) ?? path.join(input.directory, ".kilo", "kilo.jsonc")
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
        .withLock(write, configDiscoveryProjectKey(input.directory))
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

  export function scopeIndexing(info: Config.Info, scope: "global" | "local"): Config.Info {
    if (scope !== "global") return info
    return stripGlobalIndexing(info)
  }

  export function retireIndexingFlag(info: Record<string, unknown>, source: string) {
    if (!isRecord(info.experimental) || !("semantic_indexing" in info.experimental)) return info
    const experimental = { ...info.experimental }
    delete experimental.semantic_indexing
    log.warn("ignored retired experimental.semantic_indexing config; use indexing.enabled instead", { path: source })
    return { ...info, experimental }
  }

  function stripGlobalIndexing(info: Config.Info): Config.Info {
    // Indexing provider/storage settings can be global, but enablement is exposed separately from project enablement.
    if (info.indexing?.enabled === undefined) return info
    const indexing = Object.fromEntries(Object.entries(info.indexing).filter(([key]) => key !== "enabled"))
    if (Object.keys(indexing).length > 0) return { ...info, indexing }
    const copy = { ...info }
    delete copy.indexing
    return copy
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

  // ── Legacy config loading ────────────────────────────────────────────

  type MergeFn = (target: Config.Info, source: Config.Info) => Config.Info

  /**
   * Load all Kilocode legacy configs (modes, workflows, rules, MCP, ignore).
   * These have the lowest precedence in the config chain.
   */
  export async function loadLegacyConfigs(input: {
    projectDir: string
    merge: MergeFn
  }): Promise<{ config: Config.Info; warnings: Config.Warning[] }> {
    const warnings: Config.Warning[] = []
    let result: Config.Info = {}

    // Load Kilocode custom modes
    try {
      const migration = await ModesMigrator.migrate({ projectDir: input.projectDir })
      if (Object.keys(migration.agents).length > 0) {
        result = input.merge(result, { agent: migration.agents })
        log.debug("loaded kilocode custom modes", {
          count: Object.keys(migration.agents).length,
          modes: Object.keys(migration.agents),
        })
      }
      for (const skipped of migration.skipped) {
        log.debug("skipped kilocode mode", { slug: skipped.slug, reason: skipped.reason })
      }
    } catch (err) {
      log.warn("failed to load kilocode modes", { error: err })
    }

    // Load Kilocode workflows as commands
    try {
      const migration = await WorkflowsMigrator.migrate({ projectDir: input.projectDir })
      if (Object.keys(migration.commands).length > 0) {
        result = input.merge(result, { command: migration.commands })
        log.debug("loaded kilocode workflows as commands", {
          count: Object.keys(migration.commands).length,
          commands: Object.keys(migration.commands),
        })
      }
    } catch (err) {
      log.warn("failed to load kilocode workflows", { error: err })
    }

    // Load Kilocode rules
    try {
      const migration = await RulesMigrator.migrate({ projectDir: input.projectDir })
      if (migration.instructions.length > 0) {
        result = input.merge(result, { instructions: migration.instructions })
        log.debug("loaded kilocode rules", {
          count: migration.instructions.length,
          files: migration.instructions,
        })
      }
      for (const warning of migration.warnings) {
        log.debug("kilocode rules warning", { warning })
      }
    } catch (err) {
      log.warn("failed to load kilocode rules", { error: err })
    }

    // Load Kilocode MCP servers (skip global VSCode extension paths unless running in an editor or Console daemon)
    const skipGlobal = process.env["KILO_PLATFORM"] !== "vscode" && process.env["KILOCODE_FEATURE"] !== "daemon"
    const mcp = await McpMigrator.loadMcpConfig(input.projectDir, skipGlobal)
    if (Object.keys(mcp).length > 0) {
      result = input.merge(result, { mcp })
    }

    // Load .kilocodeignore patterns
    try {
      const permission = await IgnoreMigrator.loadIgnoreConfig(input.projectDir)
      if (Object.keys(permission).length > 0) {
        result = input.merge(result, { permission })
        log.debug("loaded kilocode ignore patterns", {
          hasRead: !!(permission as Record<string, unknown>).read,
          hasEdit: !!(permission as Record<string, unknown>).edit,
        })
      }
    } catch (err) {
      log.warn("failed to load kilocode ignore patterns", { error: err })
    }

    return { config: result, warnings }
  }

  // ── Organization modes ───────────────────────────────────────────────

  /**
   * Load organization custom modes from the Kilo Cloud API.
   * Returns empty agents + warnings if the user is not authenticated.
   */
  export async function loadOrganizationModes(
    auth: Record<string, any>,
  ): Promise<{ agents: Record<string, ConfigAgentV1.Info>; warnings: Config.Warning[] }> {
    const warnings: Config.Warning[] = []
    try {
      const kilo = auth["kilo"]
      if (kilo?.type === "oauth" && kilo.access && kilo.accountId) {
        const modes = await fetchOrganizationModes(kilo.access, kilo.accountId)
        if (modes.length > 0) {
          const agents = ModesMigrator.convertOrganizationModes(modes)
          log.debug("loaded organization custom modes", {
            count: modes.length,
            modes: modes.map((m: any) => m.slug),
          })
          return { agents, warnings }
        }
      }
    } catch (err) {
      log.warn("failed to load organization custom modes", { error: err })
    }
    return { agents: {}, warnings }
  }

  // ── Bash permission migration ────────────────────────────────────────

  const GLOBAL_CONFIG_FILES = ["config.json", "kilo.json", "kilo.jsonc", "opencode.json", "opencode.jsonc"]

  /**
   * Migrate bash permission for existing users before config is consumed.
   *
   * Existing users (those with at least one global config file or the legacy TOML
   * config) who have no explicit `permission.bash` setting get `bash: "allow"`
   * written to their highest-precedence config file. This preserves their current
   * behavior now that the new default is `bash: "ask"`.
   */
  export async function migrateBashPermission() {
    const files = GLOBAL_CONFIG_FILES.map((f) => path.join(Global.Path.config, f))
    const legacy = path.join(Global.Path.config, "config")
    const existing = files.filter((f) => existsSync(f))
    const hasLegacy = existsSync(legacy)

    // no global config → new user, they'll get the new bash:ask default
    if (existing.length === 0 && !hasLegacy) return

    const configs: Array<{ file: string; data: Record<string, unknown> }> = []
    // check if any config file already has an explicit bash permission
    for (const file of existing) {
      const text = await Bun.file(file)
        .text()
        .catch(() => "")
      const data = parseJsonc(text) ?? {}
      configs.push({ file, data })
      if (typeof data.permission === "string" || (isRecord(data.permission) && data.permission.bash)) return
    }

    // A schema-only file is generated for editor completion. It does not mean
    // the user predates the bash permission default.
    if (!hasLegacy && configs.every((item) => Object.keys(item.data).every((key) => key === "$schema"))) return

    // also check legacy TOML config for bash permission
    if (hasLegacy) {
      const toml = await import(pathToFileURL(legacy).href, { with: { type: "toml" } }).catch(() => undefined)
      if (toml?.default?.permission?.bash) return
    }

    // existing user without bash permission → write bash:allow to highest-precedence file
    const target = existing.length > 0 ? existing[existing.length - 1] : path.join(Global.Path.config, "config.json")
    const text = await Bun.file(target)
      .text()
      .catch(() => "{}")

    if (target.endsWith(".jsonc")) {
      const edits = modify(text, ["permission", "bash"], "allow", {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      })
      await Bun.write(target, applyEdits(text, edits))
      log.info("migrated bash permission to allow for existing user", { path: target })
      return
    }

    const data = parseJsonc(text) ?? {}
    const merged = { ...data, permission: { ...data.permission, bash: "allow" } }
    await Bun.write(target, JSON.stringify(merged, null, 2))
    log.info("migrated bash permission to allow for existing user", { path: target })
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

  /** Check whether a directory path should be treated as a config directory (for loading config files). */
  export function isConfigDir(dir: string, flagDir?: string): boolean {
    return dir.endsWith(".kilo") || dir.endsWith(".kilocode") || dir === flagDir
  }

  // ── Opencode config migration notice ─────────────────────────────────

  /** Client-neutral docs page describing where Kilo reads configuration from. */
  export const CONFIG_DOCS_URL = "https://kilo.ai/docs/getting-started/settings"

  /** Stable id for the synthetic "move your opencode config" notification (used for client-side dismissal). */
  export const OPENCODE_NOTIFICATION_ID = "kilo.local.opencode-config-detected"

  /**
   * Detect leftover opencode config directories. Kilo used to fall back to
   * opencode configuration but no longer reads `.opencode` directories.
   * Returns the existing `.opencode` locations (global + project), highest first.
   */
  export function detectOpencodeConfig(input: {
    directory: string
    worktree?: string
    scanProject: boolean
  }): string[] {
    const found: string[] = []

    // Global opencode config dir (sibling of the kilo global config dir, e.g. ~/.config/opencode).
    const globalDir = path.join(path.dirname(Global.Path.config), "opencode")
    if (existsSync(globalDir)) found.push(globalDir)

    // Project `.opencode` directories, walked from the working directory up to the worktree root.
    if (input.scanProject) {
      let current = input.directory
      while (true) {
        const candidate = path.join(current, ".opencode")
        if (existsSync(candidate) && !found.includes(candidate)) found.push(candidate)
        if (input.worktree === current) break
        const parent = path.dirname(current)
        if (parent === current) break
        current = parent
      }
    }

    return found
  }

  /**
   * Build the synthetic notification shown when a leftover `.opencode` config
   * directory is found. Returns undefined when nothing needs migrating.
   * The shape matches the gateway `Notification` schema so it can be appended
   * to the cloud notifications list and reuse each client's dismissal path.
   */
  export function opencodeConfigNotification(input: { directory: string; worktree?: string; scanProject: boolean }) {
    const found = detectOpencodeConfig(input)
    if (found.length === 0) return undefined
    const suffix = found.length > 1 ? ` (and ${found.length - 1} more)` : ""
    return {
      id: OPENCODE_NOTIFICATION_ID,
      title: "Move your opencode configuration",
      message:
        `Kilo no longer falls back to opencode configuration. ` +
        `Found opencode config at ${found[0]}${suffix}. ` +
        `Move it into a .kilo directory (project) or ${Global.Path.config} (global).`,
      action: { actionText: "Learn more", actionURL: CONFIG_DOCS_URL },
      showIn: ["cli", "extension"],
    }
  }
}
