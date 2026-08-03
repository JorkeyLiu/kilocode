import type { Config } from "../types/messages"

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/**
 * Globally unique save identity (LOCK-001). UUIDs survive webview reloads and
 * never collide across windows, unlike provider-local counters.
 */
export function newSaveID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `save-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/** Structural equality — used to compare current draft values against sent snapshots. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a)
    if (keys.length !== Object.keys(b).length) return false
    return keys.every((key) => deepEqual(a[key], b[key]))
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((item, index) => deepEqual(item, b[index]))
  }
  return false
}

/** Deep merge two objects, with source values overriding target values. */
export function deepMerge(target: Config, source: Partial<Config>): Config {
  const result: Record<string, unknown> = { ...target }
  for (const [key, value] of Object.entries(source)) {
    if (isRecord(value) && isRecord(result[key])) {
      result[key] = deepMerge(result[key] as Config, value as Partial<Config>)
    } else {
      result[key] = value
    }
  }
  return result as Config
}

function stripUndefined(value: unknown): unknown {
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      if (item === undefined) return []
      return [[key, stripUndefined(item)]]
    }),
  )
}

/** Merge raw scoped config while preserving schema-valid indexing null overrides. */
export function mergeScopedConfig(target: Config, source: Partial<Config>): Config {
  const merged = deepMerge(target, source)
  const result = stripNulls(merged)
  if (isRecord(merged.indexing)) result.indexing = stripUndefined(merged.indexing) as Config["indexing"]
  return result
}

function indexingNull(path: readonly string[]) {
  return path.length === 2 && path[0] === "indexing" && (path[1] === "model" || path[1] === "dimension")
}

export function configUnsetPaths(value: unknown, prefix: string[] = []): string[][] {
  if (!isRecord(value)) return []
  return Object.entries(value).flatMap(([key, item]) => {
    const path = [...prefix, key]
    if (item === undefined || (item === null && !indexingNull(path))) return [path]
    return configUnsetPaths(item, path)
  })
}

/** Prepare an overlay set payload while preserving schema-valid indexing null overrides. */
export function pruneConfigSet(value: unknown, prefix: string[] = []): unknown {
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      const path = [...prefix, key]
      if (item === undefined || (item === null && !indexingNull(path))) return []
      const next = pruneConfigSet(item, path)
      if (path[0] === "indexing" && isRecord(next) && Object.keys(next).length === 0) return []
      return [[key, next]]
    }),
  )
}

/** Recursively remove keys whose value is null (null = "deleted"). */
export function stripNulls(obj: Config): Config {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue
    if (isRecord(value)) {
      result[key] = stripNulls(value as Config)
    } else {
      result[key] = value
    }
  }
  return result as Config
}

/**
 * Remove from `current` every leaf path that `sent` wrote and whose value has
 * not changed since the save was sent (LOCK-002). Same-field edits made after
 * the save (the current value differs from the sent value) stay in the draft,
 * and paths belonging to newer, still-registered saves are preserved because
 * they only vanish when their own matching ack subtracts them. Empty parents
 * are pruned so isDirty stays accurate.
 */
export function subtractSentDraft(current: Partial<Config>, sent: Partial<Config>): Partial<Config> {
  const out = deepClone(current) as Record<string, unknown>
  const sentPaths: Array<{ path: string[]; value: unknown }> = []
  collectPaths(sent, [], sentPaths)
  for (const { path, value } of sentPaths) {
    if (path.length === 0) continue
    if (deepEqual(getAt(out, path), value)) {
      deleteAt(out, path)
    }
  }
  return out as Partial<Config>
}

function deepClone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepClone)
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = deepClone(item)
    return out
  }
  return value
}

function collectPaths(value: unknown, prefix: string[], out: Array<{ path: string[]; value: unknown }>): void {
  if (!isRecord(value)) {
    out.push({ path: prefix, value })
    return
  }
  for (const [key, item] of Object.entries(value)) {
    collectPaths(item, [...prefix, key], out)
  }
}

function getAt(value: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = value
  for (const key of path) {
    if (!isRecord(current)) return undefined
    current = current[key]
  }
  return current
}

function deleteAt(value: Record<string, unknown>, path: string[]): void {
  const [head, ...rest] = path
  if (head === undefined) return
  if (rest.length === 0) {
    delete value[head]
    return
  }
  const next = value[head]
  if (!isRecord(next)) return
  deleteAt(next, rest)
  if (Object.keys(next).length === 0) delete value[head]
}

/**
 * Resolve the visible config when a configLoaded/configUpdated message arrives.
 * If the user has pending draft changes, re-apply the draft on top of the
 * incoming server config so pending toggles don't snap back.
 */
export function resolveConfig(server: Config, draft: Partial<Config>, dirty: boolean): Config {
  if (dirty) return stripNulls(deepMerge(server, draft))
  return server
}

/**
 * Plain-object config state machine — mirrors the SolidJS ConfigProvider
 * logic without signals so the message-handling behavior is unit-testable.
 */
export class ConfigState {
  config: Config = {}
  saved: Config = {}
  draft: Partial<Config> = {}
  dirty = false
  saving = false
  loading = true
  /** Save identity whose ack/failure we are currently waiting for. */
  pendingSaveID: string | null = null
  /** Save identity of the last successfully confirmed save. */
  lastSavedID: string | null = null
  /** Draft snapshots sent with each in-flight save, keyed by save identity (LOCK-002). */
  private sentByID = new Map<string, Partial<Config>>()

  /** Accumulate a partial change (same as the toggle click path). */
  updateConfig(partial: Partial<Config>) {
    this.config = stripNulls(deepMerge(this.config, partial))
    this.draft = deepMerge(this.draft as Config, partial)
    this.dirty = true
  }

  /** Handle an incoming configLoaded push from the extension. */
  handleConfigLoaded(server: Config) {
    if (this.saving) return
    this.config = resolveConfig(server, this.draft, this.dirty)
    this.saved = server
    this.loading = false
  }

  /**
   * Handle an incoming configUpdated push from the extension.
   * Only the matching ack (or an echo of the last confirmed save) clears the
   * draft; stale data from an older save is dropped (LOCK-005). On the
   * matching ack, only paths whose current draft value still equals the value
   * that save sent are removed — same-field edits made after send survive.
   */
  handleConfigUpdated(server: Config, id?: string) {
    const pending = this.pendingSaveID
    const last = this.lastSavedID
    const confirmed = id !== undefined && id === pending
    const echo = id !== undefined && id !== pending && id === last
    if (id !== undefined && !confirmed && !echo) {
      // LOCK-001: a stale ack for a superseded save releases only that save's
      // bookkeeping — it never subtracts current draft paths. The still-pending
      // newer save owns the draft, and only its matching ack subtracts sent
      // values (preserving same-field re-edits made after send). Subtracting
      // here could clear a path the newer save re-sent with the same value
      // before its own ack confirms it.
      this.sentByID.delete(id)
      return
    }
    if (confirmed) {
      this.saving = false
      this.pendingSaveID = null
      this.lastSavedID = id
      const sent = this.sentByID.get(id)
      if (sent !== undefined) {
        this.draft = subtractSentDraft(this.draft, sent)
        this.sentByID.delete(id)
      }
      this.dirty = Object.keys(this.draft).length > 0
      this.config = resolveConfig(server, this.draft, this.dirty)
    } else {
      this.config = resolveConfig(server, this.draft, this.dirty)
    }
    this.saved = server
  }

  /** Handle a confirmed save when merged config refresh is still pending. */
  handleConfigSaved() {
    if (!this.saving) return
    this.saving = false
    this.draft = {}
    this.dirty = false
    this.saved = this.config
  }

  /**
   * Handle an explicit save failure from the extension. Failures for a save
   * that is no longer pending (an older, superseded attempt) are ignored; the
   * matching failure releases the sent snapshot but keeps the draft so the
   * user can correct and retry.
   */
  handleConfigSaveFailed(server: Config, id?: string) {
    if (id !== undefined && id !== this.pendingSaveID) {
      // Stale failure for a superseded save: release its snapshot, keep the
      // draft so the user can correct and retry.
      this.sentByID.delete(id)
      return
    }
    if (!this.saving) return
    this.saving = false
    this.pendingSaveID = null
    if (id !== undefined) this.sentByID.delete(id)
    this.saved = server
    this.config = resolveConfig(server, this.draft, this.dirty)
  }

  /**
   * Send the draft to the backend. Repeated calls while saving replace the
   * pending identity (mirrors the provider, which allows a new save once new
   * edits accumulate). `sent` records the snapshot actually written under the
   * save identity so the matching ack can preserve same-field edits made while
   * the save was in flight (LOCK-002).
   */
  saveConfig(id?: string, sent?: Partial<Config>) {
    if (Object.keys(this.draft).length === 0) return
    this.saving = true
    const saveID = id ?? newSaveID()
    this.pendingSaveID = saveID
    if (sent !== undefined) this.sentByID.set(saveID, sent)
  }

  /** Discard pending changes. */
  discardConfig() {
    this.config = this.saved
    this.draft = {}
    this.dirty = false
  }
}
