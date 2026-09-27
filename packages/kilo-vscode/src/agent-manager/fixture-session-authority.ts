import { canonicalDirectory } from "../private-worker/canonical-directory"
import { validatePrivateGetResult } from "../kilo-provider/session-detail"
import type { PrivateSessionReader } from "../kilo-provider/options"

/**
 * Fixture-only private-authoritative session authority read (KILO_E2E_FIXTURE).
 * Private-only: one `observation/list` + one `observation/get` + one
 * `observation/messages` page, zero SDK fallback, zero retry, no partial mix.
 * Any gate-off/not-started/transport/malformed branch returns a structured
 * `{ ok: false }` failure for the harness to record as reproducible evidence
 * instead of falling back to SDK or fabricating authority.
 *
 * `dirProbe` replicates the production catalog read with the unresolved
 * workspace spelling (what KiloProvider passes) alongside the resolved root,
 * so a reopen divergence between the two spellings is reproducible evidence
 * rather than speculation.
 */

export interface AuthorityDeps {
  root: string
  rawRoot?: string
  reader: PrivateSessionReader | null | undefined
  log: (...args: unknown[]) => void
}

export interface RawListProbe {
  ok: boolean
  entries: number
  firstDir: string | null
  error: string | null
}

export interface AuthorityResult {
  ok: boolean
  via: "private"
  directory: string
  sessionId: string
  enabled: boolean
  started: boolean
  list: { entries: number; hasSid: boolean }
  get: { status: string }
  messages: { items: number; userMarkers: number; hasMarker: boolean }
  dirProbe: {
    rawRoot: string
    realRoot: string
    rawCanonical: string | null
    realCanonical: string | null
    rawList: RawListProbe
    realList: RawListProbe
  }
  reason?: string
  error?: string
}

function canon(dir: string): string | null {
  try {
    return canonicalDirectory(dir)
  } catch {
    return null
  }
}

function cut(dir: string): string {
  return dir.slice(0, 160)
}

async function rawListProbe(reader: PrivateSessionReader | null, dir: string): Promise<RawListProbe> {
  if (!reader) return { ok: false, entries: -1, firstDir: null, error: "no reader" }
  try {
    const raw = (await reader.list({ directory: dir, archived: false, limit: 500 })) as {
      v?: unknown
      entries?: unknown
    }
    if (!raw || typeof raw !== "object" || raw.v !== "1.0" || !Array.isArray(raw.entries)) {
      return { ok: false, entries: -1, firstDir: null, error: "invalid private list shape" }
    }
    const first = (raw.entries as Array<{ directory?: unknown }>)[0]
    return {
      ok: true,
      entries: (raw.entries as unknown[]).length,
      firstDir: typeof first?.directory === "string" ? cut(first.directory) : null,
      error: null,
    }
  } catch (err) {
    return {
      ok: false,
      entries: -1,
      firstDir: null,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
    }
  }
}

async function probeDirs(deps: AuthorityDeps, reader: PrivateSessionReader | null): Promise<AuthorityResult["dirProbe"]> {
  const rawRoot = deps.rawRoot ?? deps.root
  const [rawList, realList] = await Promise.all([rawListProbe(reader, rawRoot), rawListProbe(reader, deps.root)])
  return {
    rawRoot: cut(rawRoot),
    realRoot: cut(deps.root),
    rawCanonical: canon(rawRoot),
    realCanonical: canon(deps.root),
    rawList,
    realList,
  }
}

async function fail(
  deps: AuthorityDeps,
  sessionId: string,
  enabled: boolean,
  started: boolean,
  reason: string,
  error: unknown,
): Promise<AuthorityResult> {
  const msg = error instanceof Error ? error.message.slice(0, 300) : String(error ?? reason).slice(0, 300)
  deps.log(`fixture sessionAuthority(${sessionId}) ${reason}:`, msg)
  return {
    ok: false,
    via: "private",
    directory: deps.root,
    sessionId,
    enabled,
    started,
    list: { entries: -1, hasSid: false },
    get: { status: reason },
    messages: { items: -1, userMarkers: 0, hasMarker: false },
    dirProbe: await probeDirs(deps, deps.reader ?? null),
    reason,
    error: msg,
  }
}

function idsOf(raw: unknown): string[] | null {
  if (!raw || typeof raw !== "object") return null
  const rec = raw as { v?: unknown; entries?: unknown }
  if (rec.v !== "1.0" || !Array.isArray(rec.entries)) return null
  return (rec.entries as Array<{ id?: unknown }>)
    .map((e) => (typeof e?.id === "string" ? e.id : ""))
    .filter((id) => id.length > 0)
}

function pageOf(raw: unknown): unknown[] | null {
  if (!raw || typeof raw !== "object") return null
  const rec = raw as { items?: unknown; messages?: unknown; entries?: unknown }
  if (Array.isArray(rec.items)) return rec.items as unknown[]
  if (Array.isArray(rec.messages)) return rec.messages as unknown[]
  if (Array.isArray(rec.entries)) return rec.entries as unknown[]
  return null
}

function countMarkers(rows: unknown[]): number {
  let n = 0
  for (const m of rows) {
    if (JSON.stringify(m ?? {}).includes("E2E_STREAM_OBS")) n += 1
  }
  return n
}

async function readList(reader: PrivateSessionReader, root: string): Promise<string[]> {
  const ids = idsOf(await reader.list({ directory: root, archived: false, limit: 500 }))
  if (!ids) throw new Error("invalid private list shape")
  return ids
}

async function readGet(reader: PrivateSessionReader, root: string, sid: string): Promise<void> {
  const res = validatePrivateGetResult(await reader.get({ directory: root, sessionId: sid }), root, sid)
  if (res.status !== "found") throw new Error(`private get status=${res.status}`)
}

async function readMessages(reader: PrivateSessionReader, root: string, sid: string): Promise<{ items: number; markers: number }> {
  if (typeof reader.messages !== "function") return { items: 0, markers: 0 }
  const rows = pageOf(await reader.messages({ directory: root, sessionId: sid, limit: 100 }))
  if (!rows) throw new Error("invalid private messages shape")
  return { items: rows.length, markers: countMarkers(rows) }
}

export async function privateSessionAuthorityForFixture(
  deps: AuthorityDeps,
  sessionId: string,
): Promise<AuthorityResult> {
  const reader = deps.reader
  const enabled = !!reader && reader.isEnabled()
  const started = !!reader && reader.isStarted()
  if (!reader || !enabled || !started) return fail(deps, sessionId, enabled, started, "private-unavailable", "gate off or not started")
  try {
    const ids = await readList(reader, deps.root)
    if (!ids.includes(sessionId)) return fail(deps, sessionId, enabled, started, "list-missing-sid", `sid absent in ${ids.length} private entries`)
    try {
      await readGet(reader, deps.root, sessionId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const reason = msg.includes("private get status=") ? msg.replace("private get status=", "get-") : "get-error"
      return fail(deps, sessionId, enabled, started, reason, err)
    }
    const msg = await readMessages(reader, deps.root, sessionId).catch((err: unknown) => fail(deps, sessionId, enabled, started, "messages-error", err))
    if ("ok" in msg && msg.ok === false) return msg as AuthorityResult
    const { items, markers } = msg as { items: number; markers: number }
    return {
      ok: true,
      via: "private",
      directory: deps.root,
      sessionId,
      enabled,
      started,
      list: { entries: ids.length, hasSid: true },
      get: { status: "found" },
      messages: { items, userMarkers: markers, hasMarker: markers > 0 },
      dirProbe: await probeDirs(deps, reader),
    }
  } catch (err) {
    return fail(deps, sessionId, enabled, started, "private-error", err)
  }
}
