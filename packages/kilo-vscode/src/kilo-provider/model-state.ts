/**
 * Per-mode model selection persistence via the CLI's model.json.
 *
 * Reads/writes ~/.local/state/kilo/model.json (same file the CLI TUI uses)
 * so per-mode model choices are shared between CLI and extension. The same
 * file is also the canonical cross-process boundary for thinking-strength
 * usage memory: the `variant` map carries both agent+model keys
 * (`agent/{agent}/{provider}/{model}`) and model-only legacy keys
 * (`{provider}/{model}`). VS Code globalState `variantSelections` entries
 * are migration input or a synchronized compatibility cache only — never a
 * higher-priority independent source, and never a rehydration target for
 * ephemeral `session/` keys.
 *
 * Concurrency contract:
 * - Every read-modify-write of the canonical file and the migration cache
 *   inside this process runs as one module-level queued critical section, so
 *   concurrent messages cannot overwrite each other's keys from stale
 *   snapshots (in-process lost updates are impossible).
 * - Every file write is atomic (same-directory temp file + rename), so
 *   readers never observe partial JSON; a malformed/partial file read is
 *   reported and never silently treated as an empty document that a
 *   read-modify-write would destructively replace.
 * - Cross-process key-level last-writer-wins remains a documented residual:
 *   the CLI TUI and the extension can edit the same keys concurrently and
 *   the last atomic rename wins for the whole document.
 */

import * as fs from "fs"
import * as path from "path"
import type { KiloClient } from "@kilocode/sdk/v2/client"
import { validateModelSelections } from "../provider-actions"
import { observePathParityDetached, type PathParityConnection } from "./path-parity"

type PostMessage = (msg: unknown) => void

/** Persistence-skip diagnostics. Injected so tests stay deterministic. */
type Log = (msg: string) => void

const defaultLog: Log = (msg) => console.error(msg)

/** Synchronized compatibility cache / migration source for variant memory. */
export interface VariantCache {
  read: () => Record<string, string>
  write: (value: Record<string, string>) => Promise<void> | void
}

let cached: string | undefined
let queue: Promise<void> = Promise.resolve()

/**
 * Detached SDK-first `path/get` parity boundary. SDK stays the sole
 * authority; the observer is non-blocking, warn-only, and never mutates the
 * SDK return or cached model.json path. Null detaches. Set by the owner that
 * holds the current `KiloConnectionService`.
 */
let parityConn: PathParityConnection | null = null

export function setPathParityConnection(c: PathParityConnection | null): void {
  parityConn = c
}

function observePathParity(sdk: { data?: unknown; error?: unknown; response?: unknown }, dir: string | undefined): void {
  const conn = parityConn
  if (!conn) return
  // Same authoritative routing identity as the SDK read (existing owner
  // context via `getPathRoutingDirectory`). No `process.cwd()` fallback:
  // absent/empty stays detached-fail-closed without touching the transport.
  if (typeof dir !== "string" || dir.length === 0) return
  try {
    observePathParityDetached(conn, sdk, dir)
  } catch {
    console.warn("[Kilo Path] private parity observation failed (fail-closed):", {
      op: "path/get",
      observationFailed: true,
    })
  }
}

/**
 * Authoritative routing directory for the `path/get` pair: the exact active
 * backend spawn identity from the existing owner
 * (`ServerManager.getActiveSpawnCwd`). Never a mutable tracked directory or
 * `process.cwd()` — the extension host cwd and the backend cwd are
 * separately resolved and must not route the two reads to different
 * instances. Absent stays fail-closed.
 */
function routingDir(): string | undefined {
  try {
    const dir = parityConn?.getPathRoutingDirectory?.()
    return typeof dir === "string" && dir.length > 0 ? dir : undefined
  } catch {
    return undefined
  }
}

/** Serialize all model-state operations in one module-level critical section. */
function enqueue<T>(op: () => Promise<T>): Promise<T> {
  const run = queue.then(op)
  queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

async function resolve(client: KiloClient | null): Promise<string | undefined> {
  if (cached) return cached
  // Bind SDK and private reads to the same authoritative routing identity.
  const dir = routingDir()
  try {
    const resp = dir ? await client?.path.get({ directory: dir }) : await client?.path.get()
    // SDK-first detached parity: observes after the authoritative SDK read
    // settles without touching the SDK return or cache. Warn-only,
    // non-blocking, fail-closed. Terminal SDK error/response pass through
    // so terminal failures gate the observer; SDK state/returns unchanged.
    if (resp)
      observePathParity(
        {
          data: (resp as { data?: unknown }).data,
          error: (resp as { error?: unknown }).error,
          response: (resp as { response?: unknown }).response,
        },
        dir,
      )
    if (!resp?.data?.state) return undefined
    cached = path.join(resp.data.state, "model.json")
    return cached
  } catch (err) {
    observePathParity({ error: err }, dir)
    return undefined
  }
}

/**
 * Atomic same-directory temp-file + rename write. The temp file lives next
 * to the target so the rename never crosses filesystems, and it is removed
 * on any failure (owned cleanup). On success the rename moves it away.
 */
function atomicWrite(file: string, content: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  return fs.promises
    .writeFile(tmp, content)
    .then(() => fs.promises.rename(tmp, file))
    .catch((err) => {
      void fs.promises.rm(tmp, { force: true }).catch(() => undefined)
      throw err
    })
}

type Doc = { ok: boolean; data: Record<string, unknown> }

/**
 * Read the canonical document. Only a missing file is a fresh document (ok).
 * A file that exists but cannot be read (EACCES/EMFILE/EISDIR...) or cannot
 * be parsed as a JSON object is not ok and must never be replaced from a
 * synthesized empty snapshot — a read-modify-write would destructively
 * overwrite canonical state that is merely unreadable or corrupt. Non-ENOENT
 * and malformed reads are logged visibly (LOCK-003). Only call inside a
 * queued critical section.
 */
async function readDoc(client: KiloClient | null, log: Log = defaultLog): Promise<Doc> {
  const p = await resolve(client)
  if (!p) return { ok: true, data: {} }
  let raw: string
  try {
    raw = await fs.promises.readFile(p, "utf-8")
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code !== "ENOENT") {
      log(`[Kilo New] model.json read failed (${code ?? "unknown"}): skipping persistence`)
      return { ok: false, data: {} }
    }
    return { ok: true, data: {} }
  }
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? { ok: true, data: parsed as Record<string, unknown> }
      : { ok: false, data: {} }
  } catch {
    log("[Kilo New] model.json is malformed: skipping persistence")
    return { ok: false, data: {} }
  }
}

/** Persist the document atomically. Only call inside a queued critical section. */
async function commit(client: KiloClient | null, data: Record<string, unknown>): Promise<void> {
  const p = await resolve(client)
  if (!p) return
  await atomicWrite(p, JSON.stringify(data, null, 2))
}

/** Clean the canonical variant map: string values, session keys excluded. */
function variants(data: Record<string, unknown>): Record<string, string> {
  const raw = data.variant
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") continue
    if (key.startsWith("session/")) continue
    out[key] = value
  }
  return out
}

/** Cache entries eligible for migration/sync: non-session string values. */
function cacheMemory(cache?: VariantCache): Record<string, string> {
  if (!cache) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(cache.read())) {
    if (key.startsWith("session/")) continue
    if (typeof value === "string") out[key] = value
  }
  return out
}

/**
 * One-way non-destructive migration: legacy cache entries fill only gaps in
 * the canonical file. Existing canonical entries always win, and nothing is
 * cleared from the cache (it stays a synchronized compatibility cache).
 */
function migrateVariants(canonical: Record<string, string>, legacy: Record<string, string>) {
  const merged = { ...canonical }
  let added = false
  for (const [key, value] of Object.entries(legacy)) {
    if (key.startsWith("session/")) continue
    if (typeof value !== "string") continue
    if (key in merged) continue
    merged[key] = value
    added = true
  }
  return { merged, added }
}

/**
 * Handle a model-state webview message. Returns true if handled.
 *
 * @param cache - Optional VS Code globalState variantSelections adapter. When
 *   present, `persistVariant` keeps it synchronized and `requestVariants`
 *   migrates its entries into the canonical file (one-way, non-destructive).
 *   Session-scoped keys are never written to or preserved in the cache.
 * @param log - Optional persistence-skip diagnostics (defaults to
 *   console.error). Injected so tests can capture logs deterministically.
 */
export async function handleMessage(
  type: string,
  message: Record<string, unknown>,
  client: KiloClient | null,
  post: PostMessage,
  cache?: VariantCache,
  log: Log = defaultLog,
  canonicalMode: boolean = false,
): Promise<boolean> {
  // P4.1: when canonical config service is attached, legacy model.json
  // mutations and reads are rejected/answered with empty state. Canonical
  // authority derives from config/index APIs, not model.json.
  if (canonicalMode) {
    if (type === "persistModelSelection" || type === "clearModelSelection") return true
    if (type === "requestModelSelections") {
      post({ type: "modelSelectionsLoaded", selections: {} })
      return true
    }
    if (type === "persistVariant") return true
    if (type === "requestVariants") {
      post({ type: "variantsLoaded", variants: {} })
      return true
    }
  }
  if (type === "persistModelSelection") {
    await enqueue(async () => {
      const doc = await readDoc(client, log)
      if (!doc.ok) return
      const model = validateModelSelections(doc.data.model)
      model[message.agent as string] = {
        providerID: message.providerID as string,
        modelID: message.modelID as string,
      }
      await commit(client, { ...doc.data, model })
    })
    return true
  }
  if (type === "clearModelSelection") {
    await enqueue(async () => {
      const doc = await readDoc(client, log)
      if (!doc.ok) return
      const model = validateModelSelections(doc.data.model)
      delete model[message.agent as string]
      await commit(client, { ...doc.data, model })
    })
    return true
  }
  if (type === "requestModelSelections") {
    await enqueue(async () => {
      const doc = await readDoc(client, log)
      const selections = validateModelSelections(doc.data.model)
      post({ type: "modelSelectionsLoaded", selections })
    })
    return true
  }
  if (type === "persistVariant") {
    const key = message.key as string
    const value = message.value as string
    if (typeof key !== "string" || typeof value !== "string") return true
    const session = key.startsWith("session/")
    await enqueue(async () => {
      if (!session) {
        const doc = await readDoc(client, log)
        if (doc.ok) {
          const variant = variants(doc.data)
          variant[key] = value
          await commit(client, { ...doc.data, variant })
        }
      }
      // Ephemeral session-scoped keys stay out of the cache entirely.
      if (cache && !session) {
        const stored = cache.read()
        stored[key] = value
        await cache.write(stored)
      }
    })
    return true
  }
  if (type === "requestVariants") {
    await enqueue(async () => {
      const doc = await readDoc(client, log)
      const canonical = variants(doc.data)
      const legacy = cacheMemory(cache)
      const { merged, added } = migrateVariants(canonical, legacy)
      // Sync the cache to the canonical-first merged map, pruning every
      // session-scoped key (ephemeral local state is never rehydrated cache
      // data), so stale session keys cannot accumulate in globalState.
      if (cache) await cache.write(merged)
      // Migrate into the canonical file only when the file was readable; a
      // malformed/partial file must never be overwritten from a snapshot.
      if (added && doc.ok) await commit(client, { ...doc.data, variant: merged })
      post({ type: "variantsLoaded", variants: merged })
    })
    return true
  }
  return false
}

export async function reset(
  client: KiloClient | null,
  post: PostMessage,
  cache?: VariantCache,
  log: Log = defaultLog,
  canonicalMode: boolean = false,
): Promise<void> {
  // P4.1: when canonical mode is active, model.json is not the authority.
  // Skip file writes; only send empty state to the webview.
  if (!canonicalMode) {
    await enqueue(async () => {
      const doc = await readDoc(client, log)
      // Reset is explicit user intent to clear: when the canonical file reads
      // successfully (ENOENT is a fresh document) replace the model/variant maps
      // with fresh empty ones while leaving unrelated top-level sections
      // untouched. An existing file that is unreadable or malformed (doc.ok
      // false) is never overwritten — the read already logged the skip and the
      // file is preserved for recovery/diagnosis; only live/cache state clears.
      if (doc.ok) await commit(client, { ...doc.data, model: {}, variant: {} })
      // Clear the migration cache so a later requestVariants cannot resurrect
      // reset values from globalState.
      await cache?.write({})
    })
  }
  post({ type: "modelSelectionsLoaded", selections: {} })
  post({ type: "variantsLoaded", variants: {} })
}
