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
import { Cause, Context, Duration, Effect, Fiber, Layer, Schema } from "effect"
import { ConfigSnapshotRef, CanonicalProviderSnapshotRef, PolicySnapshotRef } from "@/kilocode/session/config-snapshot" // kilocode_change
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { isCanonicalOnlyProviderV1, isCanonicalProviderCandidate } from "@opencode-ai/core/kilocode/canonical-provider" // kilocode_change - canonical provenance
import { isValidCanonicalProviderEntry, isValidModelsMap } from "@opencode-ai/core/kilocode/canonical-record" // kilocode_change - shared validation
import { parseOwnedCredentialRef } from "@opencode-ai/core/kilocode/credential-ref" // kilocode_change - scope/id checks
import type { CanonicalProvenance, CanonicalConflict, CanonicalProviderEntry } from "@/kilocode/provider/canonical-provenance" // kilocode_change
import { emptyProvenance } from "@/kilocode/provider/canonical-provenance" // kilocode_change
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
import { getE2EProviderFragment } from "@/kilocode/config/e2e-provider"
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

// kilocode_change start - restrictive agent tools floor across authored layers.
// Any explicit `tools:false` in any of the four authored layers (global/project
// JSONC, global/project markdown) survives into the effective config: a later
// `tools:true` from a different authored definition cannot reopen it. Within a
// single authored definition the existing explicit enable semantics are kept
// (specific enable punches through that same definition's wildcard/group
// disable; wildcard enable never clears specific disables). Single-layer and
// no-disable behavior is unchanged. Implemented as a derived in-memory
// synthesis of the effective `agent.<name>.tools` map only; persisted files
// keep their authored values (overlay read/write parity) and ordinary
// permission semantics are untouched. Mirrors
// `packages/opencode/src/agent/capability.ts` expansion without importing the
// agent layer (config cannot depend on agent).
const EDIT_GROUP = ["edit", "write", "apply_patch"] as const

function floorKey(key: string): string {
  return key === "build" ? "code" : key
}

function floorCanon(key: string): string {
  return key === "patch" ? "apply_patch" : key
}

function floorExpand(key: string): string[] {
  const canon = floorCanon(key)
  if (canon === "*") return ["*"]
  if ((EDIT_GROUP as readonly string[]).includes(canon)) return [...EDIT_GROUP]
  return [canon]
}

function floorSplit(tools: Record<string, boolean> | undefined): { disabled: Set<string>; enabled: Set<string> } {
  const disabled = new Set<string>()
  const enabled = new Set<string>()
  for (const [key, value] of Object.entries(tools ?? {})) {
    if (value === false) for (const id of floorExpand(key)) disabled.add(id)
    else if (value === true) for (const id of floorExpand(key)) enabled.add(id)
  }
  return { disabled, enabled }
}

function floorBlocks(disabled: Set<string>, enabled: Set<string>, tool: string): boolean {
  const id = floorCanon(tool)
  if (disabled.has(id)) return !enabled.has(id)
  if (disabled.has("*")) return !enabled.has(id)
  return false
}

function floorToolsFor(layers: Array<Record<string, boolean> | undefined>): Record<string, boolean> | undefined {
  const defined = layers.filter((tools) => tools !== undefined)
  // Single authored definition needs no synthesis: the effective map already
  // carries it and downstream capability expansion owns same-definition
  // wildcard/specific semantics. Skipping also avoids rewriting the visible
  // map (e.g. expanding `write:false` into the edit group) when there is no
  // cross-definition conflict to resolve. No new ledger or state.
  if (defined.length <= 1) return undefined
  const splits = defined.map((tools) => floorSplit(tools))
  const unionDisabled = new Set<string>()
  const unionEnabled = new Set<string>()
  for (const split of splits) {
    for (const id of split.disabled) unionDisabled.add(id)
    for (const id of split.enabled) unionEnabled.add(id)
  }
  if (unionDisabled.size === 0) return undefined
  const kept = new Set<string>()
  for (const id of unionEnabled) {
    // No wildcard short-circuit: a cross-layer `'*':false` blocks both a
    // wildcard and a specific `true` from another authored definition.
    // Same-definition `'*':false` + specific `true` stays enabled because
    // floorBlocks consults each definition's own enabled set.
    const blocked = splits.some((split) => floorBlocks(split.disabled, split.enabled, id))
    if (!blocked) kept.add(id)
  }
  const out: Record<string, boolean> = {}
  for (const id of unionDisabled) out[id] = false
  for (const id of kept) out[id] = true
  return out
}

function applyAgentToolsFloor(
  effective: Record<string, { tools?: Record<string, boolean> }>,
  layers: Array<Record<string, { tools?: Record<string, boolean> }>>,
): void {
  const names = new Set<string>()
  for (const map of [effective, ...layers]) {
    for (const key of Object.keys(map ?? {})) names.add(floorKey(key))
  }
  for (const name of names) {
    const raws = name === "code" ? [name, "build"] : [name]
    const per: Array<Record<string, boolean> | undefined> = []
    for (const map of layers) {
      for (const raw of raws) {
        const tools = (map as Record<string, { tools?: Record<string, boolean> }>)[raw]?.tools
        if (tools) per.push(tools)
      }
    }
    if (per.length <= 1) continue
    const next = floorToolsFor(per)
    if (!next) continue
    // Copy-on-write: `effective` nested entries may share references with the
    // cached global/project layer objects via mergeDeep. Replacing the entry
    // (and cloning the derived tools map per entry) leaves every input layer
    // object and shared map untouched so one project's floor cannot pollute
    // getGlobal or another project, and reloads can refresh.
    for (const raw of raws) {
      const hit = (effective as Record<string, { tools?: Record<string, boolean> }>)[raw]
      if (hit) (effective as Record<string, { tools?: Record<string, boolean> }>)[raw] = { ...hit, tools: { ...next } }
    }
  }
}
// kilocode_change end

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

export type AgentPermissionSourceKind = "global-jsonc" | "project-jsonc" | "global-md" | "project-md"
export type AgentPermissionSource = {
  agent: string
  kind: AgentPermissionSourceKind
  source: string
  permission: Record<string, unknown> | undefined
}

export type Info = ConfigV1.Info & {
  // kilocode_change - keep exported so existing Config.Info call sites don't need repo-wide migration to ConfigV1.Info
  // plugin_origins is derived state, not a persisted config field. It keeps each winning plugin spec together
  // with the file and scope it came from so later runtime code can make location-sensitive decisions.
  plugin_origins?: ConfigPlugin.Origin[]
  // kilocode_change start - derived provenance for markdown paths selected by config
  instruction_origins?: Record<string, KilocodeMarkdown.Source>
  skill_path_origins?: Record<string, KilocodeMarkdown.Source>
  // kilocode_change start - derived agent.permission provenance across the four
  // authored layers (global/project JSONC + global/project markdown). Runtime-only,
  // never persisted: `permission === undefined` means absent (non-applicable, no
  // evaluator layer); defined (even {}) means authored (empty {} is applicable ask).
  // Ordinary `agent.<name>.permission` readback keeps the merged effective map.
  agent_permission_sources?: AgentPermissionSource[]
  // kilocode_change end
  // kilocode_change end
}

// kilocode_change - value re-export for the call sites that pass Config.Info as a schema
export const Info = ConfigV1.Info

// kilocode_change start - prepared mutation artifact shared by the canonical
// transaction coordinator and the single-scope update APIs
export type PreparedConfig = KilocodeConfig.PreparedConfig
// kilocode_change end

export type RawPermissionPresence = {
  readonly present: boolean
  readonly raw: unknown
}

export type PolicySnapshot = {
  readonly version: string
  readonly info: Info
  readonly canonical: CanonicalProvenance
  readonly global: Info
  readonly globalSource: string
  readonly globalPermission: RawPermissionPresence
  readonly projectSource: string
  readonly projectFound: boolean
  readonly projectPermission: RawPermissionPresence
}

type State = {
  config: Info
  canonical: CanonicalProvenance // kilocode_change - scope-aware canonical provenance
  global: Info
  globalSource: string
  globalPermission: RawPermissionPresence
  project: Info
  projectSource: string
  projectFound: boolean
  projectPermission: RawPermissionPresence
  version: string
  snapshot: PolicySnapshot
  directories: string[]
  deps: Fiber.Fiber<void>[]
  warnings: Warning[] // kilocode_change
  consoleState: ConsoleState
}

export interface Interface {
  readonly get: () => Effect.Effect<Info>
  readonly getGlobal: () => Effect.Effect<Info>
  readonly getConsoleState: () => Effect.Effect<ConsoleState>
  readonly getPolicySnapshot: () => Effect.Effect<PolicySnapshot>
  readonly captureFreshPolicySnapshot: () => Effect.Effect<PolicySnapshot>
  readonly update: (config: Info, options?: { emit?: boolean }) => Effect.Effect<{ config: Info; changed: boolean }> // kilocode_change
  // kilocode_change start
  readonly updateGlobal: (
    config: Info,
    options?: { dispose?: boolean; emit?: boolean },
  ) => Effect.Effect<{ info: Info; changed: boolean }>
  // Prepared mutation split : prepare validates in memory
  // without writing/invalidating/disposing/emitting; commit writes the
  // prepared target atomically and invalidates caches; emitUpdated publishes
  // the ConfigUpdated event only after every target committed. The combined
  // transaction coordinator uses prepare/commit/emitUpdated under one shared
  // cross-process lock instead of nesting update/updateGlobal (which would
  // re-acquire the lock and deadlock). The optional resolved `file`
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
   * Strict fail-preserving variants for convergence hot paths (F-03). The
   * lenient `invalidate/invalidateProject/emitUpdated` swallow failures for
   * legacy callers; hot convergence must observe failures to fall back to a
   * cold commit instead of releasing-then-lying-hot.
   */
  readonly invalidateStrict: () => Effect.Effect<void>
  readonly invalidateProjectStrict: () => Effect.Effect<void>
  readonly emitUpdatedStrict: (directory: string, transaction?: string) => Effect.Effect<void>
  /**
   * Acquire the shared cross-process config lock for a target file .
   * Every global/project write path serializes through this key space. Lock
   * acquisition failures are mapped to defects so the lock never leaks into
   * an endpoint's declared error channel.
   */
  readonly withLock: <A, E, R>(key: string, body: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  // kilocode_change start - canonical provenance snapshot
  readonly getCanonicalProvenance: () => Effect.Effect<CanonicalProvenance>
  readonly getCanonicalProviders: () => Effect.Effect<CanonicalProvenance>
  readonly getWithCanonical: () => Effect.Effect<{ info: Info; canonical: CanonicalProvenance }>
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
    agent_permission_sources: _agent_permission_sources,
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

// kilocode_change start - canonical provenance helpers (scope-aware, closed validation)
function parseRawProviderMap(text: string | undefined, source: string): Record<string, unknown> {
  if (!text) return Object.create(null) as Record<string, unknown>
  try {
    const data = ConfigParse.jsonc(text, source) as Record<string, unknown>
    if (!isRecord(data)) return Object.create(null) as Record<string, unknown>
    const provider = data.provider
    if (!isRecord(provider)) return Object.create(null) as Record<string, unknown>
    // Return null-prototype map to avoid prototype pollution via __proto__/constructor keys
    const out: Record<string, unknown> = Object.create(null)
    for (const [k, v] of Object.entries(provider as Record<string, unknown>)) {
      // eslint-disable-next-line no-prototype-builtins
      if (!Object.prototype.hasOwnProperty.call(provider, k)) continue
      out[k] = v
    }
    return out
  } catch {
    return Object.create(null) as Record<string, unknown>
  }
}

// kilocode_change start - raw agent.permission provenance (disk truth, no schema normalization).
// Returns per-agent presence + raw permission value so authored empty {} (applicable
// ask) stays distinct from absent (non-applicable, no evaluator layer). Invalid or
// missing files yield an empty map, mirroring the loader skipping invalid files.
function parseRawAgentPermissions(
  text: string | undefined,
  source: string,
): Record<string, { present: boolean; raw: unknown }> {
  const out: Record<string, { present: boolean; raw: unknown }> = Object.create(null)
  if (!text) return out
  try {
    const data = ConfigParse.jsonc(text, source) as Record<string, unknown>
    if (!isRecord(data)) return out
    const agents = (data as Record<string, unknown>).agent
    if (!isRecord(agents)) return out
    for (const [name, entry] of Object.entries(agents as Record<string, unknown>)) {
      // eslint-disable-next-line no-prototype-builtins
      if (!Object.prototype.hasOwnProperty.call(agents, name)) continue
      if (!isRecord(entry as unknown)) continue
      const rec = entry as Record<string, unknown>
      // eslint-disable-next-line no-prototype-builtins
      if (!Object.prototype.hasOwnProperty.call(rec, "permission")) continue
      const raw = rec.permission
      if (raw === undefined || raw === null) continue
      if (!isRecord(raw as unknown)) continue
      out[name] = { present: true, raw }
    }
    return out
  } catch {
    return Object.create(null) as Record<string, { present: boolean; raw: unknown }>
  }
}

function parseRawPermissionPresence(
  text: string | undefined,
  source: string,
): RawPermissionPresence {
  if (!text) return { present: false, raw: undefined }
  try {
    const data = ConfigParse.jsonc(text, source) as Record<string, unknown>
    if (!isRecord(data)) return { present: false, raw: undefined }
    // eslint-disable-next-line no-prototype-builtins
    if (!Object.prototype.hasOwnProperty.call(data, "permission")) return { present: false, raw: undefined }
    return { present: true, raw: (data as Record<string, unknown>).permission }
  } catch {
    return { present: false, raw: undefined }
  }
}

function hashPolicyVersion(input: string): string {
  let first = 0x811c9dc5
  let second = 0x01000193
  for (let idx = 0; idx < input.length; idx++) {
    const code = input.charCodeAt(idx)
    first ^= code
    first = Math.imul(first, 0x01000193) >>> 0
    second ^= code + 0x9e3779b9
    second = Math.imul(second, 0x85ebca6b) >>> 0
  }
  const left = first.toString(16).padStart(8, "0")
  const right = second.toString(16).padStart(8, "0")
  return `${left}${right}`
}

function policyVersionFor(parts: { config: Info; global: Info; project: Info; canonical: CanonicalProvenance }): string {
  return hashPolicyVersion(stable({ config: parts.config, global: parts.global, project: parts.project, canonical: parts.canonical }))
}

// kilocode_change start - immutable per-version policy snapshot materialization.
// PolicySnapshot shares no mutable refs with live State: the authoritative
// materialization deep-clones once per State generation and deep-freezes, then
// the frozen instance is cached on State and returned by identity (no per-read
// duplication). Generation consumers only read, so frozen reads stay compatible
// while concurrent/admitted mutations cannot pollute siblings or the cache.
function cloneSnapshotValue<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== "object") return value
  if (value instanceof Date) return new Date(value.getTime()) as unknown as T
  if (Array.isArray(value)) {
    const known = seen.get(value)
    if (known !== undefined) return known as T
    const out: unknown[] = []
    seen.set(value, out)
    for (const item of value) out.push(cloneSnapshotValue(item, seen))
    return out as unknown as T
  }
  const known = seen.get(value as object)
  if (known !== undefined) return known as T
  const out: Record<string, unknown> = Object.create(Object.getPrototypeOf(value))
  seen.set(value as object, out)
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const next = cloneSnapshotValue((value as Record<string, unknown>)[key], seen)
    Object.defineProperty(out, key, { value: next, enumerable: true, writable: true, configurable: true })
  }
  return out as unknown as T
}

function freezeSnapshotValue(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== "object") return
  if (Object.isFrozen(value)) return
  if (seen.has(value as object)) return
  seen.add(value as object)
  if (Array.isArray(value)) {
    for (const item of value) freezeSnapshotValue(item, seen)
  } else {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      freezeSnapshotValue((value as Record<string, unknown>)[key], seen)
    }
  }
  Object.freeze(value)
}

function buildCanonicalProvenance(
  globalMap: Record<string, unknown>,
  projectMap: Record<string, unknown>,
  globalSource: string,
  projectSource: string,
): CanonicalProvenance {
  const conflicts: CanonicalConflict[] = []
  const globalEntries: Record<string, CanonicalProviderEntry> = Object.create(null)
  const projectEntries: Record<string, CanonicalProviderEntry> = Object.create(null)

  // Duplicate semantics: decisive cross-scope conflict for any canonical candidate ID present in both raw maps,
  // regardless of validity/malformed nested values. Only explicit legacy operational keys remove candidacy.
  // Uses isCanonicalProviderCandidate (not full validation) so malformed models/unknown keys remain decisive.
  const globalIds = new Set<string>()
  const projectIds = new Set<string>()
  for (const [id, raw] of Object.entries(globalMap)) {
    if (!isCanonicalProviderCandidate(raw)) continue
    globalIds.add(id)
  }
  for (const [id, raw] of Object.entries(projectMap)) {
    if (!isCanonicalProviderCandidate(raw)) continue
    projectIds.add(id)
  }
  const duplicateIds = new Set<string>()
  for (const id of globalIds) if (projectIds.has(id)) duplicateIds.add(id)
  for (const id of duplicateIds) {
    conflicts.push({
      id,
      reason: "duplicate",
      message: "duplicate canonical provider across scopes",
      scopes: ["global", "project"],
      sources: [globalSource, projectSource],
    })
  }

  const processScope = (
    map: Record<string, unknown>,
    scope: "global" | "project",
    source: string,
    target: Record<string, CanonicalProviderEntry>,
  ) => {
    for (const [id, raw] of Object.entries(map)) {
      if (duplicateIds.has(id)) continue
      if (raw === null) continue
      if (!isRecord(raw as unknown)) {
        conflicts.push({
          id,
          reason: "invalid-record",
          message: "canonical provider record invalid",
          scopes: [scope],
          sources: [source],
        })
        continue
      }
      const rec = raw as Record<string, unknown>
      if (!isCanonicalOnlyProviderV1(rec)) continue
      // Shared validator with explicit context for provider-kind + id/scope when supplied
      const valid = isValidCanonicalProviderEntry(rec, { providerId: id, scope })
      if (!valid) {
        const endpoint = rec.endpoint
        const protocol = rec.protocol
        const models = rec.models
        const cred = rec.credential
        // Credential-specific reasons take precedence over invalid-record; never leak credential value
        if (cred !== undefined && typeof cred !== "string") {
          conflicts.push({
            id,
            reason: "malformed-credential",
            message: "canonical credential malformed",
            scopes: [scope],
            sources: [source],
          })
          continue
        }
        if (typeof cred === "string") {
          const parsed = parseOwnedCredentialRef(cred)
          if (!parsed || parsed.kind !== "provider") {
            conflicts.push({
              id,
              reason: "malformed-credential",
              message: "canonical credential malformed",
              scopes: [scope],
              sources: [source],
            })
            continue
          }
          if (parsed.scope !== scope) {
            conflicts.push({
              id,
              reason: "scope-mismatch",
              message: "canonical credential scope mismatch",
              scopes: [scope],
              sources: [source],
            })
            continue
          }
          if (parsed.id !== id) {
            conflicts.push({
              id,
              reason: "id-mismatch",
              message: "canonical credential id mismatch",
              scopes: [scope],
              sources: [source],
            })
            continue
          }
        }
        const endpointInvalid =
          endpoint !== undefined && (typeof endpoint !== "string" || !/^https?:\/\//.test(endpoint))
        if (endpointInvalid) {
          conflicts.push({
            id,
            reason: "invalid-endpoint",
            message: "canonical provider has invalid endpoint",
            scopes: [scope],
            sources: [source],
          })
        } else if (
          protocol !== undefined &&
          (typeof protocol !== "string" || !["openai/completions", "openai/responses", "anthropic/messages"].includes(protocol))
        ) {
          conflicts.push({
            id,
            reason: "unknown-protocol",
            message: "canonical provider has unknown protocol",
            scopes: [scope],
            sources: [source],
          })
        } else if (
          models !== undefined &&
          (!isValidModelsMap(models) || Object.keys(models as Record<string, unknown>).length === 0)
        ) {
          conflicts.push({
            id,
            reason: "invalid-models",
            message: "canonical provider has invalid models",
            scopes: [scope],
            sources: [source],
          })
        } else {
          conflicts.push({
            id,
            reason: "invalid-record",
            message: "canonical provider record invalid",
            scopes: [scope],
            sources: [source],
          })
        }
        continue
      }
      const cred = rec.credential
      if (cred === undefined) {
        conflicts.push({
          id,
          reason: "missing-credential",
          message: "canonical provider missing credential",
          scopes: [scope],
          sources: [source],
        })
        continue
      }
      if (typeof cred !== "string") {
        conflicts.push({
          id,
          reason: "malformed-credential",
          message: "canonical credential malformed",
          scopes: [scope],
          sources: [source],
        })
        continue
      }
      const parsed = parseOwnedCredentialRef(cred)
      if (!parsed) {
        conflicts.push({
          id,
          reason: "malformed-credential",
          message: "canonical credential malformed",
          scopes: [scope],
          sources: [source],
        })
        continue
      }
      if (parsed.kind !== "provider") {
        conflicts.push({
          id,
          reason: "malformed-credential",
          message: "canonical credential malformed",
          scopes: [scope],
          sources: [source],
        })
        continue
      }
      if (parsed.scope !== scope) {
        conflicts.push({
          id,
          reason: "scope-mismatch",
          message: "canonical credential scope mismatch",
          scopes: [scope],
          sources: [source],
        })
        continue
      }
      if (parsed.id !== id) {
        conflicts.push({
          id,
          reason: "id-mismatch",
          message: "canonical credential id mismatch",
          scopes: [scope],
          sources: [source],
        })
        continue
      }
      target[id] = { id, scope, source, record: rec as unknown as CanonicalProviderEntry["record"] }
    }
  }

  processScope(globalMap, "global", globalSource, globalEntries)
  processScope(projectMap, "project", projectSource, projectEntries)

  // Duplicate entries already omitted via duplicateIds; no additional valid-entry duplicate check needed.
  // Build providers with null prototype to avoid prototype pollution.
  const providers: Record<string, CanonicalProviderEntry> = Object.create(null)
  for (const [k, v] of Object.entries(globalEntries)) providers[k] = v
  for (const [k, v] of Object.entries(projectEntries)) providers[k] = v
  // Return providers/conflicts with safe prototypes; conflict list already safe.
  return { providers, conflicts }
}
// kilocode_change end

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

    // kilocode_change start - single-pass raw+decoded capture for provenance (no second I/O)
    // Raw map survives decode failure so per-provider provenance conflicts are
    // preserved even when the whole file fails schema validation (recoverable).
    const loadFileSinglePass = Effect.fnUntraced(function* (
      filepath: string,
      env?: Record<string, string>,
      trusted?: boolean,
      fileScope?: ConfigVariable.FileScope,
    ) {
      log.info("loading", { path: filepath })
      const text = yield* readConfigFile(filepath)
      if (!text)
        return {
          info: {} as Info,
          rawMap: Object.create(null) as Record<string, unknown>,
          rawAgentMap: Object.create(null) as Record<string, { present: boolean; raw: unknown }>,
          rawPermission: { present: false, raw: undefined } as RawPermissionPresence,
        }
      const rawMap = parseRawProviderMap(text, filepath)
      const rawAgentMap = parseRawAgentPermissions(text, filepath)
      const rawPermission = parseRawPermissionPresence(text, filepath)
      const exit = yield* Effect.exit(loadConfig(text, { path: filepath }, env, trusted, fileScope))
      if (exit._tag === "Success") return { info: exit.value as Info, rawMap, rawAgentMap, rawPermission }
      // Squash Cause to the original Config Json/Invalid error so existing
      // recoverable warning behavior (toWarning/caught) recognizes it.
      const failure = Cause.squash(exit.cause)
      return { info: {} as Info, rawMap, rawAgentMap, rawPermission, error: failure }
    })

    const loadFile = Effect.fnUntraced(function* (
      filepath: string,
      env?: Record<string, string>,
      trusted?: boolean, // kilocode_change
      fileScope?: ConfigVariable.FileScope, // kilocode_change
    ) {
      const single = yield* loadFileSinglePass(filepath, env, trusted, fileScope)
      return single.info
    })
    // kilocode_change end

    let globalStamp = "" // kilocode_change

    const loadGlobal = Effect.fnUntraced(function* (env?: Record<string, string>) {
      globalStamp = yield* KilocodeGlobalConfigStamp.read(fs, Global.Path.config)
      const file = globalConfigFile()
      // P4.3 canonical-only: no loader-side seeding outside lock+atomic (audit finding 1).
      // Single-pass: one file read yields both decoded Info and raw provider map for provenance
      const single = yield* loadFileSinglePass(file, env, true)
      if (single.error !== undefined) {
        log.error("failed to load global config, using defaults", { error: String(single.error) })
      }
      globalStamp = yield* KilocodeGlobalConfigStamp.read(fs, Global.Path.config)
      return {
        info: single.info,
        rawMap: single.rawMap,
        rawAgentMap: single.rawAgentMap,
        rawPermission: single.rawPermission,
        error: single.error,
      }
    })

    const [cachedGlobal, invalidateGlobal] = yield* Effect.cachedInvalidateWithTTL(
      loadGlobal().pipe(
        Effect.tapError((error) =>
          Effect.sync(() => log.error("failed to load global config, using defaults", { error: String(error) })),
        ),
        Effect.orElseSucceed(
          (): {
            info: Info
            rawMap: Record<string, unknown>
            rawAgentMap: Record<string, { present: boolean; raw: unknown }>
            rawPermission: RawPermissionPresence
            error?: unknown
          } => ({
            info: {} as Info,
            rawMap: Object.create(null) as Record<string, unknown>,
            rawAgentMap: Object.create(null) as Record<string, { present: boolean; raw: unknown }>,
            rawPermission: { present: false, raw: undefined },
          }),
        ),
      ),
      Duration.infinity,
    )

    // kilocode_change start - detect global config edits made by other Kilo processes.
    // Cache-only refresh for the instance load path: invalidates the shared
    // global cache but never touches instance state (the loader is building it).
    const refreshGlobalCache = Effect.fnUntraced(function* () {
      const stamp = yield* KilocodeGlobalConfigStamp.read(fs, Global.Path.config)
      if (!globalStamp || stamp === globalStamp) return false
      globalStamp = stamp
      yield* invalidateGlobal
      return true
    })
    // kilocode_change end

    const getGlobalWithRaw = Effect.fn("Config.getGlobalWithRaw")(function* () {
      yield* refreshGlobalCache()
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
        // kilocode_change start — narrowly validated E2E seam: synthetic
        // lowest-priority global fragment (fixed provider/model, loopback /v1,
        // fixture apiKey) gated on KILO_E2E_FIXTURE=1 + absolute
        // KILO_E2E_SCRATCH + KILO_E2E_PROVIDER_BASE_URL. Project canonical
        // metadata merges over it so small_model/provider baseURL are pinned
        // without plaintext in project file. Fail-closed when gates absent.
        const e2eFragment = getE2EProviderFragment()
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

        if (e2eFragment) {
          yield* merge("e2e-fixture", e2eFragment, "global")
        }

        const globalWithRaw = yield* getGlobalWithRaw().pipe(
          Effect.catchDefect((err: unknown) => {
            caughtWarning(warnings, "global config", err)
            return Effect.succeed({
              info: {} as Info,
              rawMap: Object.create(null) as Record<string, unknown>,
              rawAgentMap: Object.create(null) as Record<string, { present: boolean; raw: unknown }>,
              rawPermission: { present: false, raw: undefined } as RawPermissionPresence,
              error: undefined as unknown,
            })
          }),
        )
        if ((globalWithRaw as { error?: unknown }).error !== undefined) {
          caughtWarning(warnings, "global config", (globalWithRaw as { error?: unknown }).error)
        }

        yield* merge(Global.Path.config, globalWithRaw.info, "global")

        const projectFile = path.join(projectRoot, ".kilo", "kilo.jsonc")
        const projectSingle = yield* loadFileSinglePass(projectFile, undefined, false, {
          root: projectRoot,
          source: projectFile,
        }).pipe(
          Effect.catchDefect((err: unknown) => {
            caughtWarning(warnings, projectFile, err)
            return Effect.succeed({
              info: {} as Info,
              rawMap: Object.create(null) as Record<string, unknown>,
              rawAgentMap: Object.create(null) as Record<string, { present: boolean; raw: unknown }>,
              rawPermission: { present: false, raw: undefined } as RawPermissionPresence,
              error: undefined as unknown,
            })
          }),
        )
        if ((projectSingle as { error?: unknown }).error !== undefined) {
          caughtWarning(warnings, projectFile, (projectSingle as { error?: unknown }).error)
        }
        if (Object.keys(projectSingle.info).length > 0 || existsSync(projectFile)) {
          yield* merge(projectFile, projectSingle.info, "local")
        }

        result.agent = result.agent || {}
        result.plugin = result.plugin || []

        const globalDir = Global.Path.config
        const projectDir = path.join(projectRoot, ".kilo")
        const directories = existsSync(projectDir) ? [globalDir, projectDir] : [globalDir]

        const deps: Fiber.Fiber<void>[] = []

        // kilocode_change start - keep per-layer markdown agents for the tools floor
        let globalMd: Record<string, { tools?: Record<string, boolean> }> = {}
        let projectMd: Record<string, { tools?: Record<string, boolean> }> = {}
        let globalMdSources: Array<{ agent: string; file: string; present: boolean; raw: unknown }> = []
        let projectMdSources: Array<{ agent: string; file: string; present: boolean; raw: unknown }> = []
        // kilocode_change end
        for (const dir of directories) {
          const dirTrusted = dir === globalDir
          const dirFileScope = dirTrusted ? undefined : { root: projectRoot, source: dir }
          const dirSourceScope = dirTrusted ? undefined : { root: projectRoot, source: dir }
          const dirScope = dirTrusted ? ("global" as const) : ("local" as const)

          result.command = mergeDeep(
            result.command ?? {},
            yield* Effect.promise(() => ConfigCommand.load(dir, warnings, dirTrusted, dirFileScope, dirSourceScope)),
          )
          const loaded = yield* Effect.promise(() =>
            ConfigAgent.loadWithSources(dir, warnings, dirTrusted, dirFileScope, dirSourceScope),
          )
          const md = loaded.agents
          // kilocode_change start
          if (dir === globalDir) {
            globalMd = md as Record<string, { tools?: Record<string, boolean> }>
            globalMdSources = loaded.sources
          } else {
            projectMd = md as Record<string, { tools?: Record<string, boolean> }>
            projectMdSources = loaded.sources
          }
          // kilocode_change end
          result.agent = mergeDeep(
            result.agent ?? {},
            md,
          )
          const list = yield* Effect.promise(() => ConfigPlugin.load(dir))
          yield* mergePluginOrigins(dir, list, dirScope)
        }
        // kilocode_change start - restrictive tools floor: any explicit false in
        // global/project JSONC or markdown survives later trues from another
        // authored definition; same-definition explicit enables stay intact.
        applyAgentToolsFloor(
          result.agent as Record<string, { tools?: Record<string, boolean> }>,
          [
            (globalWithRaw.info.agent ?? {}) as Record<string, { tools?: Record<string, boolean> }>,
            (projectSingle.info.agent ?? {}) as Record<string, { tools?: Record<string, boolean> }>,
            globalMd,
            projectMd,
          ],
        )
        // kilocode_change start - derived agent.permission provenance across the four
        // authored layers. Raw JSONC maps preserve authored empty {} vs absent;
        // markdown sources preserve raw frontmatter presence for successfully decoded
        // agents only. Effective `agent.<name>.permission` readback keeps the merged
        // map; this array is runtime-only for Permission.ask/evaluateForDebug dual
        // assembly (deny > ask > allow across sources, same-document specific/order
        // via winningRule per source). Never persisted (see writable()).
        {
          const derived: AgentPermissionSource[] = []
          const globalRawAgent =
            ((globalWithRaw as { rawAgentMap?: Record<string, { present: boolean; raw: unknown }> }).rawAgentMap ??
              {}) as Record<string, { present: boolean; raw: unknown }>
          const projectRawAgent =
            ((projectSingle as { rawAgentMap?: Record<string, { present: boolean; raw: unknown }> }).rawAgentMap ??
              {}) as Record<string, { present: boolean; raw: unknown }>
          const globalFilePath = globalConfigFile()
          for (const [name, entry] of Object.entries(globalRawAgent)) {
            if (!entry?.present) continue
            if (!isRecord(entry.raw as unknown)) continue
            derived.push({
              agent: name,
              kind: "global-jsonc",
              source: globalFilePath,
              permission: entry.raw as Record<string, unknown>,
            })
          }
          for (const [name, entry] of Object.entries(projectRawAgent)) {
            if (!entry?.present) continue
            if (!isRecord(entry.raw as unknown)) continue
            derived.push({ agent: name, kind: "project-jsonc", source: projectFile, permission: entry.raw as Record<string, unknown> })
          }
          for (const src of globalMdSources) {
            if (!src.present) continue
            if (!isRecord(src.raw as unknown)) continue
            derived.push({ agent: src.agent, kind: "global-md", source: src.file, permission: src.raw as Record<string, unknown> })
          }
          for (const src of projectMdSources) {
            if (!src.present) continue
            if (!isRecord(src.raw as unknown)) continue
            derived.push({ agent: src.agent, kind: "project-md", source: src.file, permission: src.raw as Record<string, unknown> })
          }
          if (derived.length > 0) result.agent_permission_sources = derived
        }
        // kilocode_change end

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

        // kilocode_change start - scope-aware canonical provenance (single pass, same-read capture)
        const globalFilePath = globalConfigFile()
        const canonical = buildCanonicalProvenance(globalWithRaw.rawMap, projectSingle.rawMap, globalFilePath, projectFile)
        for (const c of canonical.conflicts) {
          warnings.push({ path: c.sources?.[0] ?? c.id, message: `canonical provider ${c.id}: ${c.message}` })
        }
        // kilocode_change end

        const globalPermission = (globalWithRaw as { rawPermission?: RawPermissionPresence }).rawPermission ?? {
          present: false,
          raw: undefined,
        }
        const projectPermission = (projectSingle as { rawPermission?: RawPermissionPresence }).rawPermission ?? {
          present: false,
          raw: undefined,
        }
        const version = policyVersionFor({
          config: result,
          global: globalWithRaw.info,
          project: projectSingle.info,
          canonical,
        })
        // kilocode_change start - authoritative frozen materialization cached once
        // per State generation. Deep-cloned so admitted mutations cannot pollute
        // the live cache or siblings; deep-frozen so pinned reads stay stable.
        const snapshot: PolicySnapshot = {
          version,
          info: cloneSnapshotValue(result),
          canonical: cloneSnapshotValue(canonical),
          global: cloneSnapshotValue(globalWithRaw.info),
          globalSource: globalFilePath,
          globalPermission: cloneSnapshotValue(globalPermission),
          projectSource: projectFile,
          projectFound: projectPermission.present,
          projectPermission: cloneSnapshotValue(projectPermission),
        }
        freezeSnapshotValue(snapshot)
        // kilocode_change end

        timer.end() // kilocode_change - P0 instrumentation
        return {
          config: result,
          canonical,
          global: globalWithRaw.info,
          globalSource: globalFilePath,
          globalPermission,
          project: projectSingle.info,
          projectSource: projectFile,
          projectFound: projectPermission.present,
          projectPermission,
          version,
          snapshot,
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

    // kilocode_change start - single authoritative refresh boundary. An external
    // global edit consumed by getGlobal must not leave the instance cache stale
    // for a later getPolicySnapshot: the first reader to observe the stamp
    // invalidates both the shared global cache and the current instance, so the
    // exact order getGlobal then getPolicySnapshot still materializes the latest
    // version and floors. No background invalidation job or second owner.
    const ensureFresh = Effect.fnUntraced(function* () {
      const changed = yield* refreshGlobalCache()
      if (!changed) return false
      yield* Effect.ignore(InstanceState.invalidate(state))
      return true
    })
    // kilocode_change end

    const getGlobal = Effect.fn("Config.getGlobal")(function* () {
      yield* ensureFresh() // kilocode_change
      const cached = yield* cachedGlobal
      return cached.info
    })

    const get = Effect.fn("Config.get")(function* () {
      // kilocode_change start - pin Config.get for admitted generations
      const snapshot = yield* ConfigSnapshotRef
      if (snapshot) return snapshot
      // kilocode_change end
      yield* ensureFresh() // kilocode_change - single boundary owns instance invalidation
      return yield* InstanceState.use(state, (s) => s.config)
    })

    // kilocode_change start - canonical provenance (pinned together with Config.Info)
    const getCanonicalProvenance = Effect.fn("Config.getCanonicalProvenance")(function* () {
      const snap = yield* CanonicalProviderSnapshotRef
      if (snap) return snap
      yield* ensureFresh()
      return yield* InstanceState.use(state, (s) => s.canonical)
    })

    const getCanonicalProviders = getCanonicalProvenance

    const getWithCanonical = Effect.fn("Config.getWithCanonical")(function* () {
      const snapInfo = yield* ConfigSnapshotRef
      const snapProv = yield* CanonicalProviderSnapshotRef
      if (snapInfo !== undefined && snapProv !== undefined) {
        return { info: snapInfo, canonical: snapProv }
      }
      yield* ensureFresh()
      return yield* InstanceState.use(state, (s) => ({ info: s.config, canonical: s.canonical }))
    })

    const toPolicySnapshot = (s: State): PolicySnapshot => s.snapshot

    const getPolicySnapshot = Effect.fn("Config.getPolicySnapshot")(function* () {
      const pinned = yield* PolicySnapshotRef
      if (pinned) return pinned
      yield* ensureFresh()
      return yield* InstanceState.use(state, toPolicySnapshot)
    })

    const captureFreshPolicySnapshot = Effect.fn("Config.captureFreshPolicySnapshot")(function* () {
      yield* ensureFresh()
      return yield* InstanceState.use(state, toPolicySnapshot)
    })
    // kilocode_change end

    const directories = Effect.fn("Config.directories")(function* () {
      yield* ensureFresh() // kilocode_change - single boundary keeps floors fresh
      return yield* InstanceState.use(state, (s) => s.directories)
    })

    const getConsoleState = Effect.fn("Config.getConsoleState")(function* () {
      yield* ensureFresh() // kilocode_change - single boundary keeps floors fresh
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

    /** Prepare a project-scope mutation in memory  — no writes/events. */
    const prepare = Effect.fn("Config.prepare")(function* (config: Info, options?: { file?: string }) {
      const ctx = yield* InstanceState.context
      return yield* KilocodeConfig.prepareProjectConfig({
        fs,
        directory: ctx.directory,
        worktree: ctx.worktree,
        config,
        file: options?.file, // kilocode_change - resolved target wins over rediscovery
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
     * . No lock is taken here — the caller holds the shared lock.
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
      // kilocode_change - the project-domain discovery lock is
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
          // kilocode_change - prepare uses the exact resolved target
          // resolved under the discovery lock — never rediscovered, so the
          // locked key is always the written path.
          const prepared = yield* prepare(config, { file: target })
          if (!prepared.changed) return { config: prepared.info, changed: false }
          // kilocode_change - emit:false defers the ConfigUpdated publish to
          // the caller's deferred final event ; the default emits
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

    /**
     * Strict variants (F-03): same operations without failure swallowing.
     * Used only by config-file convergence hot paths so an invalidation or
     * event failure is observable and falls back to a cold commit.
     */
    const invalidateProjectStrict = Effect.fn("Config.invalidateProjectStrict")(function* () {
      yield* InstanceState.invalidate(state)
    })
    const invalidateStrict = Effect.fn("Config.invalidateStrict")(function* () {
      yield* invalidateGlobal
    })
    const emitUpdatedStrict = Effect.fn("Config.emitUpdatedStrict")(function* (directory: string, transaction?: string) {
      yield* Effect.sync(() =>
        GlobalBus.emit("event", {
          directory,
          transaction,
          payload: {
            type: Event.ConfigUpdated.type,
            properties: {},
          },
        }),
      )
    })

    /** Prepare a global-scope mutation in memory  — no writes/events. */
    const prepareGlobal = Effect.fn("Config.prepareGlobal")(function* (config: Info, options?: { file?: string }) {
      const file = options?.file ?? globalConfigFile() // kilocode_change - resolved target wins
      const source = yield* readConfigFile(file)
      const before = source ?? "{}"
      const patch = writableGlobal(config)

      if (!file.endsWith(".jsonc")) {
        const existing = ConfigParse.schema(ConfigV1.Info, ConfigParse.jsonc(before, file), file)
        const next = KilocodeConfig.mergeConfig(writable(existing), patch)
        const serialized = JSON.stringify(next, null, 2)
        // Validate the merged result before persisting : an invalid
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
     * . No lock is taken here — the caller holds the shared lock.
     */
    const commitGlobal = Effect.fn("Config.commitGlobal")(function* (
      prepared: PreparedConfig,
      options?: { dispose?: boolean; emit?: boolean },
    ) {
      const next = prepared.info
      const changed = prepared.changed
      if (changed) yield* KilocodeAtomicWrite.write(fs, prepared.path, prepared.next)
      if (!changed) return { info: next, changed }
      yield* invalidateGlobal
      yield* InstanceState.invalidate(state).pipe(Effect.catchCause(() => Effect.void))
      if (options?.emit !== false) yield* emitConfigUpdated("global")
      return { info: next, changed }
    })

    const updateGlobal = Effect.fn("Config.updateGlobal")(function* (
      config: Info,
      options?: { dispose?: boolean; emit?: boolean },
    ) {
      // The dispose flag is preserved for API compatibility; instance disposal
      // is owned by the caller's rebuild registration , and both
      // flag values invalidate + emit identically after a successful commit.
      void options?.dispose
      // kilocode_change - the global-domain discovery lock is
      // acquired BEFORE target resolution so discovery and the write are one
      // stable cross-process decision.
      return yield* withConfigLock(
        KilocodeConfig.configDiscoveryGlobalKey(),
        Effect.gen(function* () {
          const file = globalConfigFile()
          // kilocode_change - prepareGlobal uses the exact resolved
          // target resolved under the discovery lock — never rediscovered, so
          // the locked key is always the written path.
          const prepared = yield* prepareGlobal(config, { file })
          if (!prepared.changed) return { info: prepared.info, changed: false }
          // kilocode_change - emit:false defers the ConfigUpdated publish to
          // the caller's deferred final event ; the default emits
          // immediately (hot semantics).
          yield* commitGlobal(prepared, options)
          return { info: prepared.info, changed: true }
        }),
      )
    })

    const warnings = Effect.fn("Config.warnings")(function* () {
      yield* ensureFresh() // kilocode_change - single boundary keeps floors fresh
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
      getPolicySnapshot,
      captureFreshPolicySnapshot,
      update,
      updateGlobal,
      prepareGlobal, // kilocode_change
      prepare, // kilocode_change
      commitGlobal, // kilocode_change
      commit, // kilocode_change
      emitUpdated, // kilocode_change
      invalidateProject, // kilocode_change
      invalidateStrict, // kilocode_change - strict hot-path variant
      invalidateProjectStrict, // kilocode_change - strict hot-path variant
      emitUpdatedStrict, // kilocode_change - strict hot-path variant
      withLock: withConfigLock, // kilocode_change
      getCanonicalProvenance, // kilocode_change
      getCanonicalProviders, // kilocode_change
      getWithCanonical, // kilocode_change
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
