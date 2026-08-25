import * as Log from "@opencode-ai/core/util/log"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import path from "path"
import os from "os"
import { mergeDeep } from "remeda"
import { Global } from "@opencode-ai/core/global"
import { Flag } from "@opencode-ai/core/flag/flag"
import { applyEdits, findNodeAtLocation, modify, parseTree } from "jsonc-parser" // kilocode_change - parseTree/findNodeAtLocation used in patchJsonc
import { existsSync } from "fs"
// kilocode_change start
import { GlobalBus } from "@/bus/global"
import { Event } from "../server/event"
// kilocode_change end
import { isRecord } from "@/util/record"
import type { ConsoleState } from "@opencode-ai/core/v1/config/console-state"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { Context, Duration, Effect, Fiber, Layer, Schema } from "effect"
import { ConfigSnapshotRef } from "@/kilocode/session/config-snapshot" // kilocode_change
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { canonicalRoot, containsPath, type InstanceContext } from "../project/instance-context"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { ConfigPluginV1 } from "@opencode-ai/core/v1/config/plugin"
import { Auth } from "../auth"
import { Env } from "../env"
import { Account } from "@/account/account"
import { FetchHttpClient } from "effect/unstable/http"
import { ConfigAgent } from "./agent"
import { ConfigCommand } from "./command"
import { ConfigParse } from "./parse"
import { ConfigPlugin } from "./plugin"
import { ConfigVariable } from "./variable"
import z from "zod" // kilocode_change - Kilo config compatibility schemas
// kilocode_change start
import { KilocodeConfig } from "../kilocode/config/config"
import { KilocodeAtomicWrite } from "@/kilocode/config/atomic-write"
import { Git } from "@/git"
import { KilocodeDefaultPlugins } from "@/kilocode/config/default-plugins"
import { KilocodeGlobalConfigStamp } from "@/kilocode/config/global-stamp"
import { SandboxConfig } from "@/kilocode/sandbox/config"
import type { KilocodeMarkdown } from "@/kilocode/config/markdown"
// kilocode_change end
import * as P0Perf from "@/kilocode/perf/instrument" // kilocode_change - P0 instrumentation

const log = Log.create({ service: "config" })

// Custom merge function that concatenates array fields instead of replacing them
// Keep remeda's deep conditional merge type out of hot config-loading paths; TS profiling showed it dominates here.
function mergeConfig(target: Info, source: Info): Info {
  return mergeDeep(target, source) as Info
}

function mergeConfigConcatArrays(target: Info, source: Info): Info {
  const merged = mergeConfig(target, source)
  if (target.instructions && source.instructions) {
    merged.instructions = Array.from(new Set([...target.instructions, ...source.instructions]))
  }
  return merged
}

function normalizeLoadedConfig(data: unknown, source: string) {
  if (!isRecord(data)) return data
  const copy = { ...data } // kilocode_change
  // Retired product config keys are ignored so existing configs keep loading.
  // Automatic overflow recovery and codebase indexing are no longer configurable.
  if ("compaction" in copy) {
    delete copy.compaction
    log.warn("compaction config is retired; automatic overflow recovery is always on", { path: source })
  }
  if ("indexing" in copy) {
    delete copy.indexing
    log.warn("indexing config is retired; codebase indexing was removed", { path: source })
  }
  const hadLegacy = "theme" in copy || "keybinds" in copy || "tui" in copy
  if (!hadLegacy) return copy
  delete copy.theme
  delete copy.keybinds
  delete copy.tui
  log.warn("tui keys in opencode config are deprecated; move them to tui.json", { path: source })
  return copy
}

// kilocode_change start
export const Warning = z.object({
  path: z.string(),
  message: z.string(),
  detail: z.string().optional(),
})
export type Warning = z.infer<typeof Warning>

const { caught: caughtWarning } = KilocodeConfig
// kilocode_change end

// substituteWellKnownRemoteConfig removed - cloud/org remote config deleted (P4.3)

async function resolveLoadedPlugins<T extends { plugin?: ConfigPluginV1.Spec[] }>(config: T, filepath: string) {
  if (!config.plugin) return config
  for (let i = 0; i < config.plugin.length; i++) {
    // Normalize path-like plugin specs while we still know which config file declared them.
    // This prevents `./plugin.ts` from being reinterpreted relative to some later merge location.
    config.plugin[i] = await ConfigPlugin.resolvePluginSpec(config.plugin[i], filepath)
  }
  return config
}

export type Info = ConfigV1.Info & {
  // kilocode_change - keep exported so existing Config.Info call sites don't need repo-wide migration to ConfigV1.Info
  // plugin_origins is derived state, not a persisted config field. It keeps each winning plugin spec together
  // with the file and scope it came from so later runtime code can make location-sensitive decisions.
  plugin_origins?: ConfigPlugin.Origin[]
  // kilocode_change start - derived provenance for markdown paths selected by config
  instruction_origins?: Record<string, KilocodeMarkdown.Source>
  skill_path_origins?: Record<string, KilocodeMarkdown.Source>
  // kilocode_change end
}

// kilocode_change - value re-export for the call sites that pass Config.Info as a schema
export const Info = ConfigV1.Info

// kilocode_change start - prepared mutation artifact shared by the canonical
// transaction coordinator and the single-scope update APIs (LOCK-002)
export type PreparedConfig = KilocodeConfig.PreparedConfig
// kilocode_change end

type State = {
  config: Info
  directories: string[]
  deps: Fiber.Fiber<void>[]
  warnings: Warning[] // kilocode_change
  consoleState: ConsoleState
}

export interface Interface {
  readonly get: () => Effect.Effect<Info>
  readonly getGlobal: () => Effect.Effect<Info>
  readonly getConsoleState: () => Effect.Effect<ConsoleState>
  readonly update: (config: Info, options?: { emit?: boolean }) => Effect.Effect<{ config: Info; changed: boolean }> // kilocode_change
  // kilocode_change start
  readonly updateGlobal: (
    config: Info,
    options?: { dispose?: boolean; emit?: boolean },
  ) => Effect.Effect<{ info: Info; changed: boolean }>
  // Prepared mutation split (LOCK-002/003): prepare validates in memory
  // without writing/invalidating/disposing/emitting; commit writes the
  // prepared target atomically and invalidates caches; emitUpdated publishes
  // the ConfigUpdated event only after every target committed. The combined
  // transaction coordinator uses prepare/commit/emitUpdated under one shared
  // cross-process lock instead of nesting update/updateGlobal (which would
  // re-acquire the lock and deadlock). The optional resolved `file` (LOCK-002)
  // lets a caller that already resolved + locked the target prepare/commit that
  // exact path instead of rediscovering it under a different lock.
  readonly prepareGlobal: (config: Info, options?: { file?: string }) => Effect.Effect<PreparedConfig>
  readonly prepare: (config: Info, options?: { file?: string }) => Effect.Effect<PreparedConfig>
  readonly commitGlobal: (
    prepared: PreparedConfig,
    options?: { dispose?: boolean; emit?: boolean },
  ) => Effect.Effect<{ info: Info; changed: boolean }>
  readonly commit: (
    prepared: PreparedConfig,
    options?: { emit?: boolean },
  ) => Effect.Effect<{ config: Info; changed: boolean }>
  readonly emitUpdated: (directory: string, transaction?: string) => Effect.Effect<void>
  readonly invalidateProject: () => Effect.Effect<void>
  /**
   * Acquire the shared cross-process config lock for a target file (LOCK-001).
   * Every global/project write path serializes through this key space. Lock
   * acquisition failures are mapped to defects so the lock never leaks into
   * an endpoint's declared error channel.
   */
  readonly withLock: <A, E, R>(key: string, body: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  // kilocode_change end
  readonly invalidate: () => Effect.Effect<void>
  readonly directories: () => Effect.Effect<string[]>
  readonly waitForDependencies: () => Effect.Effect<void>
  readonly warnings: () => Effect.Effect<Warning[]> // kilocode_change
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Config") {}

export const use = serviceUse(Service)

function globalConfigFile() {
  return path.join(Global.Path.config, "kilo.jsonc")
}

function patchJsonc(input: string, patch: unknown, path: string[] = []): string {
  if (!isRecord(patch)) {
    const edits = modify(input, path, patch === null ? undefined : patch, {
      // kilocode_change
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
      },
    })
    return applyEdits(input, edits)
  }

  // kilocode_change start — when the existing JSONC node at this path is a
  // scalar (e.g. permission.bash is "ask" as a string), jsonc-parser cannot
  // add child keys to it. Detect this case and replace the whole node with
  // the patch object in a single modify() call instead of recursing.
  // For permission keys, promote the scalar to { "*": scalarValue } so the
  // wildcard default is preserved. For other keys, replace directly.
  if (path.length > 0) {
    const tree = parseTree(input)
    const node = tree && findNodeAtLocation(tree, path)
    if (node && node.type !== "object") {
      const isPermissionKey = path[0] === "permission" && path.length === 2
      const replacement = isPermissionKey ? { "*": node.value, ...patch } : patch
      const edits = modify(input, path, replacement, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      })
      return applyEdits(input, edits)
    }
  }
  // kilocode_change end

  return Object.entries(patch).reduce((result, [key, value]) => patchJsonc(result, value, [...path, key]), input)
}

function writable(info: Info) {
  // kilocode_change start - derived provenance is runtime-only and must never be persisted
  const {
    plugin_origins: _plugin_origins,
    instruction_origins: _instruction_origins,
    skill_path_origins: _skill_path_origins,
    ...next
  } = info
  // kilocode_change end
  return next
}

function writableGlobal(info: Info) {
  const next = writable(info)
  // When a user changes config from a value back to default in the Desktop app, we don't want to leave a blank `"shell": "",` key
  if ("shell" in next && next.shell === "") return { ...next, shell: undefined }
  return next
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (isRecord(value)) {
    // kilocode_change start - undefined object values serialize to nothing in
    // JSON, so omit them here too: an omitted key and an explicitly undefined
    // value must compare equal (the global shell sentinel maps "" → undefined).
    // Arrays are JSON-typed and can never contain undefined; such values are
    // rejected by the throw below instead of being treated as JSON null.
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`
    // kilocode_change end
  }
  if (value === null) return "null"
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  throw new TypeError(`Unsupported config value in semantic comparison: ${typeof value}`) // kilocode_change
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const git = yield* Git.Service // kilocode_change
    const flock = yield* EffectFlock.Service // kilocode_change - serialize global config read-merge-write updates

    const readConfigFile = (filepath: string) => fs.readFileStringSafe(filepath).pipe(Effect.orDie)

    const loadConfig = Effect.fnUntraced(function* (
      text: string,
      options: { path: string } | { dir: string; source: string },
      env?: Record<string, string>,
      // kilocode_change start - trusted allows {env:}; fileScope confines untrusted {file:} reads to a root
      trusted?: boolean,
      fileScope?: ConfigVariable.FileScope,
      // kilocode_change end
    ) {
      const source = "path" in options ? options.path : options.source
      const expanded = yield* Effect.promise(() =>
        ConfigVariable.substitute(
          "path" in options
            ? { text, type: "path", path: options.path, env, trusted, fileScope } // kilocode_change
            : { text, type: "virtual", ...options, env, trusted, fileScope }, // kilocode_change
        ),
      )
      const parsed = ConfigParse.jsonc(expanded, source)
      const data = ConfigParse.schema(ConfigV1.Info, normalizeLoadedConfig(parsed, source), source)
      if (!("path" in options)) return data

      yield* Effect.promise(() => resolveLoadedPlugins(data, options.path))
      if (!data.$schema) {
        // kilocode_change - P4.3 canonical-only: in-memory normalization only; no loader-side persistence
        // outside discovery lock + atomic writer (audit finding 1). $schema is set in memory for
        // effective config; persistence occurs only through explicit prepare/commit via
        // KilocodeAtomicWrite under the shared discovery lock.
        data.$schema = "https://app.kilo.ai/config.json"
      }
      return data
    })

    const loadFile = Effect.fnUntraced(function* (
      filepath: string,
      env?: Record<string, string>,
      trusted?: boolean, // kilocode_change
      fileScope?: ConfigVariable.FileScope, // kilocode_change
    ) {
      log.info("loading", { path: filepath })
      const text = yield* readConfigFile(filepath)
      if (!text) return {} as Info
      return yield* loadConfig(text, { path: filepath }, env, trusted, fileScope) // kilocode_change
    })

    let globalStamp = "" // kilocode_change

    const loadGlobal = Effect.fnUntraced(function* (env?: Record<string, string>) {
      globalStamp = yield* KilocodeGlobalConfigStamp.read(fs, Global.Path.config)
      let result: Info = {}
      const file = globalConfigFile()
      // P4.3 canonical-only: no loader-side seeding outside lock+atomic (audit finding 1).
      // Missing global file is treated as empty config; creation/persistence is owned
      // exclusively by prepare/commit via KilocodeAtomicWrite under
      // configDiscoveryGlobalKey. This avoids load/update races and partial JSONC exposure.
      result = mergeConfig(result, yield* loadFile(file, env, true))
      globalStamp = yield* KilocodeGlobalConfigStamp.read(fs, Global.Path.config)
      return result
    })

    const [cachedGlobal, invalidateGlobal] = yield* Effect.cachedInvalidateWithTTL(
      loadGlobal().pipe(
        Effect.tapError((error) =>
          Effect.sync(() => log.error("failed to load global config, using defaults", { error: String(error) })),
        ),
        Effect.orElseSucceed((): Info => ({})),
      ),
      Duration.infinity,
    )

    // kilocode_change start - detect global config edits made by other Kilo processes
    const refreshGlobal = Effect.fnUntraced(function* () {
      const stamp = yield* KilocodeGlobalConfigStamp.read(fs, Global.Path.config)
      if (!globalStamp || stamp === globalStamp) return false
      globalStamp = stamp
      yield* invalidateGlobal
      return true
    })
    // kilocode_change end

    const getGlobal = Effect.fn("Config.getGlobal")(function* () {
      yield* refreshGlobal() // kilocode_change
      return yield* cachedGlobal
    })

    const loadInstanceState = Effect.fn("Config.loadInstanceState")(
      function* (ctx: InstanceContext) {
        // kilocode_change - P0 instrumentation: per-instance config load start/end
        const timer = P0Perf.span("config_load", { dir: ctx.directory })
        // kilocode_change start - warning accumulator and legacy Kilo config
        const warnings: Warning[] = []
        // Untrusted project config may only read files inside this root (worktree, or directory for non-git projects).
        const projectRoot = canonicalRoot(ctx.directory, ctx.worktree)

        let result: Info = {}
        const consoleManagedProviders = new Set<string>()
        let activeOrgName: string | undefined

        const pluginScopeForSource = Effect.fnUntraced(function* (source: string) {
          if (containsPath(source, ctx)) return "local"
          return "global"
        })

        const mergePluginOrigins = Effect.fnUntraced(function* (
          source: string,
          // mergePluginOrigins receives raw Specs from one config source, before provenance for this merge step
          // is attached.
          list: ConfigPluginV1.Spec[] | undefined,
          // Scope can be inferred from the source path, but some callers already know whether the config should
          // behave as global or local and can pass that explicitly.
          kind?: ConfigPlugin.Scope,
        ) {
          if (!list?.length) return
          const hit = kind ?? (yield* pluginScopeForSource(source))
          // Merge newly seen plugin origins with previously collected ones, then dedupe by plugin identity while
          // keeping the winning source/scope metadata for downstream installs, writes, and diagnostics.
          const plugins = ConfigPlugin.deduplicatePluginOrigins([
            ...(result.plugin_origins ?? []),
            ...list.map((spec) => ({ spec, source, scope: hit })),
          ])
          result.plugin = plugins.map((item) => item.spec)
          result.plugin_origins = plugins
        })

        // kilocode_change start
        const origins = (
          prev: Record<string, KilocodeMarkdown.Source> | undefined,
          values: readonly string[],
          trusted: boolean,
          source: string,
        ) => {
          const result = { ...prev }
          for (const value of values) {
            if (result[value]?.trusted) continue
            result[value] = { trusted, source, root: trusted ? undefined : projectRoot }
          }
          return result
        }

        const merge = Effect.fnUntraced(function* (
          source: string,
          next: Info,
          kind?: ConfigPlugin.Scope,
          sourceTrusted?: boolean,
        ) {
          const scope = kind ?? (yield* pluginScopeForSource(source))
          const trusted = sourceTrusted ?? scope === "global"
          const scoped = SandboxConfig.scope(next, scope)
          result = mergeConfigConcatArrays(result, scoped)
          if (next.instructions?.length) {
            result.instruction_origins = origins(result.instruction_origins, next.instructions, trusted, source)
          }
          if (next.skills?.paths?.length) {
            result.skill_path_origins = origins(result.skill_path_origins, next.skills.paths, trusted, source)
          }
          return yield* mergePluginOrigins(source, scoped.plugin, scope)
        })
        // kilocode_change end

        const global = yield* getGlobal().pipe(
          Effect.catchDefect((err: unknown) => {
            caughtWarning(warnings, "global config", err)
            return Effect.succeed({} as Info)
          }),
        )

        yield* merge(Global.Path.config, global, "global")

        const projectFile = path.join(projectRoot, ".kilo", "kilo.jsonc")
        const projectConfig = yield* loadFile(projectFile, undefined, false, { root: projectRoot, source: projectFile }).pipe(
          Effect.catchDefect((err: unknown) => {
            caughtWarning(warnings, projectFile, err)
            return Effect.succeed({} as Info)
          }),
        )
        if (Object.keys(projectConfig).length > 0 || existsSync(projectFile)) {
          yield* merge(projectFile, projectConfig, "local")
        }

        result.agent = result.agent || {}
        result.plugin = result.plugin || []

        const globalDir = Global.Path.config
        const projectDir = path.join(projectRoot, ".kilo")
        const directories = existsSync(projectDir) ? [globalDir, projectDir] : [globalDir]

        const deps: Fiber.Fiber<void>[] = []

        for (const dir of directories) {
          const dirTrusted = dir === globalDir
          const dirFileScope = dirTrusted ? undefined : { root: projectRoot, source: dir }
          const dirSourceScope = dirTrusted ? undefined : { root: projectRoot, source: dir }
          const dirScope = dirTrusted ? ("global" as const) : ("local" as const)

          result.command = mergeDeep(
            result.command ?? {},
            yield* Effect.promise(() => ConfigCommand.load(dir, warnings, dirTrusted, dirFileScope, dirSourceScope)),
          )
          result.agent = mergeDeep(
            result.agent ?? {},
            yield* Effect.promise(() => ConfigAgent.load(dir, warnings, dirTrusted, dirFileScope, dirSourceScope)),
          )
          const list = yield* Effect.promise(() => ConfigPlugin.load(dir))
          yield* mergePluginOrigins(dir, list, dirScope)
        }

        if (!result.username) {
          try {
            result.username = os.userInfo().username || "user"
          } catch (err) {
            log.warn("failed to read system username, using fallback", { err })
            result.username = "user"
          }
        }

        if (result.autoshare === true && !result.share) {
          result.share = "auto"
        }

        // kilocode_change start — inject Kilo default plugins into both plugin list and origins
        KilocodeDefaultPlugins.apply(result, { disabled: Flag.KILO_DISABLE_DEFAULT_PLUGINS, log })
        // kilocode_change end

        timer.end() // kilocode_change - P0 instrumentation
        return {
          config: result,
          directories,
          deps,
          warnings, // kilocode_change
          consoleState: {
            consoleManagedProviders: Array.from(consoleManagedProviders),
            activeOrgName,
            switchableOrgCount: 0,
          },
        }
      },
      Effect.provideService(FSUtil.Service, fs),
    )

    const state = yield* InstanceState.make<State>(
      Effect.fn("Config.state")(function* (ctx) {
        return yield* loadInstanceState(ctx).pipe(Effect.provideService(Git.Service, git), Effect.orDie) // kilocode_change
      }),
    )

    const get = Effect.fn("Config.get")(function* () {
      // kilocode_change start - pin Config.get for admitted generations
      const snapshot = yield* ConfigSnapshotRef
      if (snapshot) return snapshot
      // kilocode_change end
      // kilocode_change start - reload instance config when global config changed elsewhere
      if (yield* refreshGlobal()) {
        yield* InstanceState.invalidate(state).pipe(Effect.catchCause(() => Effect.void))
      }
      // kilocode_change end
      return yield* InstanceState.use(state, (s) => s.config)
    })

    const directories = Effect.fn("Config.directories")(function* () {
      return yield* InstanceState.use(state, (s) => s.directories)
    })

    const getConsoleState = Effect.fn("Config.getConsoleState")(function* () {
      return yield* InstanceState.use(state, (s) => s.consoleState)
    })

    const waitForDependencies = Effect.fn("Config.waitForDependencies")(function* () {
      yield* InstanceState.useEffect(state, (s) =>
        Effect.forEach(s.deps, Fiber.join, { concurrency: "unbounded" }).pipe(Effect.asVoid),
      )
    })

    // kilocode_change start - canonical prepared mutation split shared by the
    // combined transaction coordinator and the single-scope update APIs
    const emitConfigUpdated = (directory: string, transaction?: string) =>
      Effect.sync(() =>
        GlobalBus.emit("event", {
          directory,
          transaction,
          payload: {
            type: Event.ConfigUpdated.type,
            properties: {},
          },
        }),
      ).pipe(Effect.catchCause((cause) => Effect.sync(() => log.error("config update listener failed", { cause }))))

    /** Prepare a project-scope mutation in memory (LOCK-002) — no writes/events. */
    const prepare = Effect.fn("Config.prepare")(function* (config: Info, options?: { file?: string }) {
      const ctx = yield* InstanceState.context
      return yield* KilocodeConfig.prepareProjectConfig({
        fs,
        directory: ctx.directory,
        worktree: ctx.worktree,
        config,
        file: options?.file, // kilocode_change - LOCK-002: resolved target wins over rediscovery
        read: readConfigFile,
        parse: (input, file) => ConfigParse.schema(ConfigV1.Info, ConfigParse.jsonc(input, file), file),
        patch: (input, patch) => patchJsonc(input, patch),
        writable,
      })
    })

    /**
     * Commit a prepared project artifact: atomically persist, then invalidate
     * the instance config cache. Event emission is deferred to emitUpdated so
     * multi-target transactions publish only after every target committed
     * (LOCK-004). No lock is taken here — the caller holds the shared lock.
     */
    const commit = Effect.fn("Config.commit")(function* (prepared: PreparedConfig, options?: { emit?: boolean }) {
      if (prepared.changed) yield* KilocodeAtomicWrite.write(fs, prepared.path, prepared.next)
      if (!prepared.changed) return { config: prepared.info, changed: false }
      yield* InstanceState.invalidate(state).pipe(Effect.catchCause(() => Effect.void))
      if (options?.emit !== false) {
        const ctx = yield* InstanceState.context
        yield* emitConfigUpdated(ctx.directory)
      }
      return { config: prepared.info, changed: true }
    })

    const update = Effect.fn("Config.update")(function* (config: Info, options?: { emit?: boolean }) {
      const ctx = yield* InstanceState.context
      // kilocode_change - LOCK-001: the project-domain discovery lock is
      // acquired BEFORE target resolution so discovery and the write are one
      // stable cross-process decision; a concurrent higher-precedence file
      // creation can never land this save in a shadowed target.
      return yield* withConfigLock(
        KilocodeConfig.configDiscoveryProjectKey(ctx.directory, ctx.worktree),
        Effect.gen(function* () {
          const target = yield* KilocodeConfig.projectConfigUpdateTarget({
            fs,
            directory: ctx.directory,
            worktree: ctx.worktree,
          })
          // kilocode_change - LOCK-001: prepare uses the exact resolved target
          // resolved under the discovery lock — never rediscovered, so the
          // locked key is always the written path.
          const prepared = yield* prepare(config, { file: target })
          if (!prepared.changed) return { config: prepared.info, changed: false }
          // kilocode_change - emit:false defers the ConfigUpdated publish to
          // the caller's deferred final event (LOCK-002); the default emits
          // immediately (hot semantics).
          yield* commit(prepared, options)
          return { config: prepared.info, changed: true }
        }),
      )
    })

    /** Invalidate the current directory's instance config cache (rollback). */
    const invalidateProject = Effect.fn("Config.invalidateProject")(function* () {
      yield* InstanceState.invalidate(state).pipe(Effect.catchCause(() => Effect.void))
    })

    /** Prepare a global-scope mutation in memory (LOCK-002) — no writes/events. */
    const prepareGlobal = Effect.fn("Config.prepareGlobal")(function* (config: Info, options?: { file?: string }) {
      const file = options?.file ?? globalConfigFile() // kilocode_change - LOCK-002: resolved target wins
      const source = yield* readConfigFile(file)
      const before = source ?? "{}"
      const patch = writableGlobal(config)

      if (!file.endsWith(".jsonc")) {
        const existing = ConfigParse.schema(ConfigV1.Info, ConfigParse.jsonc(before, file), file)
        const next = KilocodeConfig.mergeConfig(writable(existing), patch)
        const serialized = JSON.stringify(next, null, 2)
        // Validate the merged result before persisting (LOCK-007): an invalid
        // patch surfaces as a typed ConfigInvalidError defect and writes
        // nothing instead of persisting bad values.
        ConfigParse.schema(ConfigV1.Info, ConfigParse.jsonc(serialized, file), file)
        const changed = stable(next) !== stable(ConfigParse.jsonc(before, file))
        return {
          path: file,
          existed: source !== undefined,
          original: source,
          next: serialized,
          info: next,
          changed,
        }
      }

      const updated = patchJsonc(before, patch)
      const next = ConfigParse.schema(ConfigV1.Info, ConfigParse.jsonc(updated, file), file)
      const changed = stable(next) !== stable(ConfigParse.jsonc(before, file))
      return { path: file, existed: source !== undefined, original: source, next: updated, info: next, changed }
    })

    /**
     * Commit a prepared global artifact: atomically persist, invalidate the
     * global and instance caches. Event emission is deferred to emitUpdated
     * (LOCK-004). No lock is taken here — the caller holds the shared lock.
     */
    const commitGlobal = Effect.fn("Config.commitGlobal")(
      function* (prepared: PreparedConfig, options?: { dispose?: boolean; emit?: boolean }) {
        const next = prepared.info
        const changed = prepared.changed
        if (changed) yield* KilocodeAtomicWrite.write(fs, prepared.path, prepared.next)
        if (!changed) return { info: next, changed }
        yield* invalidateGlobal
        yield* InstanceState.invalidate(state).pipe(Effect.catchCause(() => Effect.void))
        if (options?.emit !== false) yield* emitConfigUpdated("global")
        return { info: next, changed }
      },
    )

    const updateGlobal = Effect.fn("Config.updateGlobal")(
      function* (config: Info, options?: { dispose?: boolean; emit?: boolean }) {
        // The dispose flag is preserved for API compatibility; instance disposal
        // is owned by the caller's rebuild registration (LOCK-003), and both
        // flag values invalidate + emit identically after a successful commit.
        void options?.dispose
        // kilocode_change - LOCK-001: the global-domain discovery lock is
        // acquired BEFORE target resolution so discovery and the write are one
        // stable cross-process decision.
        return yield* withConfigLock(
          KilocodeConfig.configDiscoveryGlobalKey(),
          Effect.gen(function* () {
            const file = globalConfigFile()
            // kilocode_change - LOCK-001: prepareGlobal uses the exact resolved
            // target resolved under the discovery lock — never rediscovered, so
            // the locked key is always the written path.
            const prepared = yield* prepareGlobal(config, { file })
            if (!prepared.changed) return { info: prepared.info, changed: false }
            // kilocode_change - emit:false defers the ConfigUpdated publish to
            // the caller's deferred final event (LOCK-002); the default emits
            // immediately (hot semantics).
            yield* commitGlobal(prepared, options)
            return { info: prepared.info, changed: true }
          }),
        )
      },
    )

    const warnings = Effect.fn("Config.warnings")(function* () {
      return yield* InstanceState.use(state, (s) => s.warnings)
    })

    const invalidate = Effect.fn("Config.invalidate")(function* () {
      yield* invalidateGlobal
    })

    const emitUpdated = Effect.fn("Config.emitUpdated")(function* (directory: string, transaction?: string) {
      yield* emitConfigUpdated(directory, transaction)
    })

    const withConfigLock = <A, E, R>(key: string, body: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      flock.withLock(body, key).pipe(
        Effect.catchTag("LockTimeoutError", (error) => Effect.die(error)),
        Effect.catchTag("LockCompromisedError", (error) => Effect.die(error)),
      )
    // kilocode_change end

    return Service.of({
      get,
      getGlobal,
      getConsoleState,
      update,
      updateGlobal,
      prepareGlobal, // kilocode_change
      prepare, // kilocode_change
      commitGlobal, // kilocode_change
      commit, // kilocode_change
      emitUpdated, // kilocode_change
      invalidateProject, // kilocode_change
      withLock: withConfigLock, // kilocode_change
      invalidate,
      directories,
      waitForDependencies,
      warnings, // kilocode_change
    })
  }),
).pipe(Layer.provide(EffectFlock.defaultLayer)) // kilocode_change - serialize global config updates in every layer

export const defaultLayer = layer.pipe(
  Layer.provide(Git.defaultLayer), // kilocode_change
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Env.defaultLayer),
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Account.defaultLayer),
  Layer.provide(FetchHttpClient.layer),
)

export * as Config from "./config"
