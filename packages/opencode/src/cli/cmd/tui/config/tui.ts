export * as TuiConfig from "./tui"

import path from "path"
import { createBindingLookup } from "@opentui/keymap/extras"
import { mergeDeep, unique } from "remeda"
import { Cause, Context, Effect, Fiber, Layer, Schema } from "effect"
import { ConfigParse } from "@/config/parse"
import * as ConfigPaths from "@/config/paths"
import { KeymapLeaderTimeoutDefault, resolveAttentionSoundPaths, TuiInfo } from "./tui-schema"
import { Flag } from "@opencode-ai/core/flag/flag"
import { isRecord } from "@/util/record"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CurrentWorkingDirectory } from "./cwd"
import { ConfigPlugin } from "@/config/plugin"
import { TuiKeybind } from "./keybind"
import { InstallationLocal, InstallationVersion } from "@opencode-ai/core/installation/version"
import { makeRuntime } from "@opencode-ai/core/effect/runtime"
import { Filesystem } from "@/util/filesystem"
import { canonicalRoot, resolveWorktree } from "@/project/instance-context"
import * as Log from "@opencode-ai/core/util/log"
import { ConfigVariable } from "@/config/variable"
import { Npm } from "@opencode-ai/core/npm"
import { KilocodeDefaultPlugins } from "@/kilocode/config/default-plugins" // kilocode_change
import type { DeepMutable } from "@opencode-ai/core/schema"
import type { TuiAttentionSoundName } from "@kilocode/plugin/tui"
import { FormatError, FormatUnknownError } from "@/cli/error"

const log = Log.create({ service: "tui.config" })

export const Info = TuiInfo
export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>

type Acc = {
  result: Info
  plugin_origins: ConfigPlugin.Origin[]
}

export type Resolved = Omit<Info, "attention" | "keybinds" | "leader_timeout"> & {
  attention: {
    enabled: boolean
    notifications: boolean
    sound: boolean
    volume: number
    sound_pack: string
    sounds: Partial<Record<TuiAttentionSoundName, string>>
  }
  keybinds: TuiKeybind.BindingLookupView
  leader_timeout: number
  // Internal resolved plugin list used by runtime loading.
  plugin_origins?: ConfigPlugin.Origin[]
}

export interface Interface {
  readonly get: () => Effect.Effect<Resolved>
  readonly info: () => Effect.Effect<Info>
  readonly waitForDependencies: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/TuiConfig") {}

function pluginScope(file: string, ctx: { directory: string }): ConfigPlugin.Scope {
  // LOCK-SOURCE: global config retains global scope even when physically located under the worktree.
  // Explicit source identity is preferred at merge time (see mergeFile explicit scope param); this
  // path heuristic remains as fallback for local inference and correctly classifies global-under-root.
  if (Filesystem.contains(Global.Path.config, file)) return "global"
  if (Filesystem.contains(ctx.directory, file)) return "local"
  // if (ctx.worktree !== "/" && Filesystem.contains(ctx.worktree, file)) return "local"
  return "global"
}

function normalize(raw: Record<string, unknown>) {
  const data = { ...raw }
  if (!("tui" in data)) return data
  if (!isRecord(data.tui)) {
    delete data.tui
    return data
  }

  const tui = data.tui
  delete data.tui
  return {
    ...tui,
    ...data,
  }
}

function dropUnknownKeybinds(input: Record<string, unknown>, configFilepath: string) {
  if (!isRecord(input.keybinds)) return input

  const invalid = TuiKeybind.unknownKeys(input.keybinds)
  if (!invalid.length) return input

  log.warn("ignored unknown tui keybinds", {
    path: configFilepath,
    keybinds: invalid,
    hint: "Remove these entries or rename them to keys from the tui.json schema.",
  })
  return {
    ...input,
    keybinds: Object.fromEntries(Object.entries(input.keybinds).filter(([key]) => !invalid.includes(key))),
  }
}

const loadState = Effect.fn("TuiConfig.loadState")(function* (ctx: { directory: string }) {
  const afs = yield* FSUtil.Service
  // Resolve trusted canonical Git worktree root (LOCK-SOURCE): nested CLI invocation must use workspace root.
  const worktree = yield* Effect.promise(() => resolveWorktree(ctx.directory))
  const root = canonicalRoot(ctx.directory, worktree)
  const canonicalCtx = { directory: root }
  let appliedOrder = 0

  const resolvePlugins = (config: Info, configFilepath: string): Effect.Effect<Info> =>
    Effect.gen(function* () {
      const plugins = config.plugin
      if (!plugins) return config
      for (let i = 0; i < plugins.length; i++) {
        plugins[i] = yield* Effect.promise(() => ConfigPlugin.resolvePluginSpec(plugins[i], configFilepath))
      }
      return config
    })

  // kilocode_change start - trusted gates {env:}; fileScope confines untrusted {file:} reads
  const load = (
    text: string,
    configFilepath: string,
    trusted: boolean,
    fileScope?: ConfigVariable.FileScope,
  ): Effect.Effect<Info> =>
    // kilocode_change end
    Effect.gen(function* () {
      // kilocode_change start - only trusted tui config resolves {env:}; untrusted {file:} confined to fileScope
      const expanded = yield* Effect.promise(() =>
        ConfigVariable.substitute({ text, type: "path", path: configFilepath, missing: "empty", trusted, fileScope }),
      )
      // kilocode_change end
      const data = ConfigParse.jsonc(expanded, configFilepath)
      if (!isRecord(data)) return {} as Info
      // Flatten a nested "tui" key so users who wrote `{ "tui": { ... } }` inside tui.json
      // (mirroring the old opencode.json shape) still get their settings applied.
      const normalized = dropUnknownKeybinds(normalize(data), configFilepath)
      const parsed = ConfigParse.schema(Info, normalized, configFilepath)
      const validated = parsed.attention?.sounds
        ? {
            ...parsed,
            attention: {
              ...parsed.attention,
              sounds: resolveAttentionSoundPaths(path.dirname(configFilepath), parsed.attention.sounds),
            },
          }
        : parsed
      return yield* resolvePlugins(validated, configFilepath)
    }).pipe(
      // catchCause (not tapErrorCause + orElseSucceed) because JSONC parsing and validation
      // can sync-throw — those become defects, which orElseSucceed wouldn't catch.
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          const error = Cause.squash(cause)
          const reason = FormatError(error) ?? FormatUnknownError(error)
          log.warn("skipping invalid tui config", {
            path: configFilepath,
            reason,
          })
          return {} as Info
        }),
      ),
    )

  // kilocode_change start - trusted + fileScope threaded to load
  const loadFile = (filepath: string, trusted: boolean, fileScope?: ConfigVariable.FileScope): Effect.Effect<Info> =>
    // kilocode_change end
    Effect.gen(function* () {
      // Silent-swallow non-NotFound read errors (perms, EISDIR, IO) → log + skip.
      // Matches how parse/schema/plugin failures in load() are handled — every
      // broken-config path degrades gracefully rather than crashing TUI startup.
      const text = yield* afs.readFileStringSafe(filepath).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            const error = Cause.squash(cause)
            const reason = FormatError(error) ?? FormatUnknownError(error)
            log.warn("failed to read tui config", {
              path: filepath,
              reason,
            })
            return undefined
          }),
        ),
      )
      if (!text) return {} as Info
      log.info("loading tui config", { path: filepath })
      return yield* load(text, filepath, trusted, fileScope) // kilocode_change
    })

  // kilocode_change start - trusted + fileScope threaded to loadFile
  // LOCK-SOURCE/LOCK-R6: explicit source identity at merge time — global files are always global scope
  // regardless of physical containment under worktree; direct/.kilo remain local. Preserves source path,
  // plugin directory derivation, dedup/overrides and precedence.
  const mergeFile = (
    acc: Acc,
    file: string,
    scope: ConfigPlugin.Scope,
    trusted: boolean,
    fileScope?: ConfigVariable.FileScope,
  ) =>
    // kilocode_change end
    Effect.gen(function* () {
      const data = yield* loadFile(file, trusted, fileScope) // kilocode_change
      if (Object.keys(data).length) {
        appliedOrder += 1
        log.info("applying tui config", { path: file, order: appliedOrder })
      }
      acc.result = mergeDeep(acc.result, data)
      if (!data.plugin?.length) return

      const plugins = ConfigPlugin.deduplicatePluginOrigins([
        ...acc.plugin_origins,
        ...data.plugin.map((spec) => ({ spec, scope, source: file })),
      ])
      acc.result.plugin = plugins.map((item) => item.spec)
      acc.plugin_origins = plugins
    })

  // Canonical TUI config sources: global root and workspace .kilo only (LOCK-SOURCE, LOCK-R6).
  // No ancestor walk, no legacy dirs, no legacy env overrides, no legacy migration import.
  // Uses canonical root so nested Git invocation cannot load nested tui.json/.kilo as effective config.
  const workspaceKiloDir = path.join(root, ".kilo")
  const workspaceDirs = Flag.KILO_DISABLE_PROJECT_CONFIG ? [] : [workspaceKiloDir]

  const acc: Acc = {
    result: {},
    plugin_origins: [],
  }

  // 1. Global tui config (lowest precedence) — explicit global scope (LOCK-SOURCE).
  for (const file of ConfigPaths.fileInDirectory(Global.Path.config, "tui")) {
    yield* mergeFile(acc, file, "global", true) // kilocode_change - global config is trusted
  }

  // 2. Workspace root tui.json (no ancestor walk, direct only — canonical file authority) — explicit local.
  if (!Flag.KILO_DISABLE_PROJECT_CONFIG) {
    for (const file of ConfigPaths.fileInDirectory(root, "tui")) {
      yield* mergeFile(acc, file, "local", false, { root, source: file })
    }
  }

  // 3. Canonical workspace .kilo/tui.json (workspace root only, no ancestor walk) — explicit local.
  for (const dir of workspaceDirs) {
    const trusted = false
    const fileScope: ConfigVariable.FileScope = { root, source: dir }
    for (const file of ConfigPaths.fileInDirectory(dir, "tui")) {
      yield* mergeFile(acc, file, "local", trusted, fileScope)
    }
  }

  const keybinds = { ...acc.result.keybinds }
  if (process.platform === "win32") {
    // Native Windows terminals do not support POSIX suspend, so prefer prompt undo.
    keybinds.terminal_suspend = "none"
    const inputUndo = TuiKeybind.defaultValue("input_undo")
    keybinds.input_undo ??= unique(["ctrl+z", ...(typeof inputUndo === "string" ? inputUndo.split(",") : [])]).join(",")
  }
  const parsedKeybinds = TuiKeybind.parse(keybinds)
  const info = acc.result
  const result: Resolved = {
    ...info,
    attention: {
      enabled: acc.result.attention?.enabled ?? false,
      notifications: acc.result.attention?.notifications ?? true,
      sound: acc.result.attention?.sound ?? true,
      volume: acc.result.attention?.volume ?? 0.4,
      sound_pack: acc.result.attention?.sound_pack ?? "kilo.default", // kilocode_change
      sounds: acc.result.attention?.sounds ?? {},
    },
    keybinds: createBindingLookup(TuiKeybind.toBindingConfig(parsedKeybinds), {
      commandMap: TuiKeybind.CommandMap,
      bindingDefaults: TuiKeybind.bindingDefaults(),
    }),
    leader_timeout: acc.result.leader_timeout ?? KeymapLeaderTimeoutDefault,
    plugin_origins: acc.plugin_origins.length ? acc.plugin_origins : undefined,
  }

  // kilocode_change start - inject Kilo default plugins to keep TUI aligned with server config
  KilocodeDefaultPlugins.apply(result, { disabled: Flag.KILO_DISABLE_DEFAULT_PLUGINS, log })
  info.plugin = result.plugin
  // kilocode_change end

  // Derive plugin dependency dirs from actual canonical sources that contributed winning plugins.
  // Only final effective plugin entries (after deduplication/precedence) determine dirs; overridden
  // sources do not create dirs. Uses existing source metadata, not duplicate parsing. Unique order
  // preserves first appearance in plugin_origins (consistent with merge precedence).
  const dirs = (() => {
    if (!result.plugin?.length) return [] as string[]
    const origins = result.plugin_origins ?? []
    if (!origins.length) return [] as string[]
    const seen = new Set<string>()
    const out: string[] = []
    for (const origin of origins) {
      if (origin.source === "builtin") continue
      const dir = path.dirname(origin.source)
      if (!seen.has(dir)) {
        seen.add(dir)
        out.push(dir)
      }
    }
    return out
  })()

  return {
    config: result,
    info,
    dirs,
  }
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const directory = yield* CurrentWorkingDirectory
    const npm = yield* Npm.Service
    const data = yield* loadState({ directory })
    const deps = yield* Effect.forEach(
      data.dirs,
      (dir) =>
        npm
          .install(dir, {
            add: [
              {
                name: "@kilocode/plugin",
                version: InstallationLocal ? undefined : InstallationVersion,
              },
            ],
          })
          .pipe(Effect.forkScoped),
      {
        concurrency: "unbounded",
      },
    )

    const get = Effect.fn("TuiConfig.get")(() => Effect.succeed(data.config))
    const info = Effect.fn("TuiConfig.info")(() => Effect.succeed(data.info))

    const waitForDependencies = Effect.fn("TuiConfig.waitForDependencies")(() =>
      Effect.forEach(deps, Fiber.join, { concurrency: "unbounded" }).pipe(Effect.ignore(), Effect.asVoid),
    )
    return Service.of({ get, info, waitForDependencies })
  }).pipe(Effect.withSpan("TuiConfig.layer")),
)

export const defaultLayer = layer.pipe(Layer.provide(Npm.defaultLayer), Layer.provide(FSUtil.defaultLayer))

const { runPromise } = makeRuntime(Service, defaultLayer)

export async function waitForDependencies() {
  await runPromise((svc) => svc.waitForDependencies())
}

export async function get() {
  return runPromise((svc) => svc.get())
}
