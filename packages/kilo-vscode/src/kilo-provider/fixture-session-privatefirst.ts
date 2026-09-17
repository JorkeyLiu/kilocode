import type { Session } from "@kilocode/sdk/v2/client"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { canonicalDirectory } from "../private-worker/canonical-directory"
import { decodeGlobalListCursor } from "../private-worker/session-cursor"
import { normalizeSessionListNextCursor } from "../kilo-provider-utils"
import type { ObservationGetSession } from "../private-worker/observation"
import type { PrivateSessionReader } from "./options"
import { validatePrivateGetResult } from "./session-detail"
import { tryPrivateMessagesPage } from "./session-messages-private"

/**
 * Fixture-only private-first session list + transcript reads for the
 * KILO_E2E_FIXTURE `backendSnapshotForFixture` snapshot
 * (`AgentManagerProvider`). Same `observation/list` + `observation/get` +
 * `observation/messages` sources as production (`PrivateSessionReader` via
 * the shared `PrivateObservationService`, `sessionRefreshContext.listSessions`
 * validation, `validatePrivateGetResult` hydration,
 * `tryPrivateMessagesPage` + full-history collect bounds). List stays slim;
 * full session truth comes from per-session get hydration before
 * `summarizeSession`.
 *
 * One private list plus one private get per entry (or one private messages
 * walk) plus at most one same-directory/session SDK fallback per read, never
 * retried inside the helper. Valid private list + all valid private get
 * hydrations return with zero SDK; validated terminal messages
 * (`not_found`/`scope_mismatch`) close with zero SDK; list
 * gate-off/malformed/transport/truncation or any hydration miss (including a
 * list/get `not_found`/`scope_mismatch` race) takes exactly one
 * same-directory/session SDK fallback with no retry and no partial mix. SDK
 * failure/malformed returns `unavailable` for the caller to fail soft to the
 * existing empty snapshot shape. No cache, no owner, no state, no transport.
 */

const LIST_LIMIT = 500
const PAGE_LIMIT = 100
const PAGE_BOUND = 100

export type FixtureListOutcome =
  | { kind: "ok"; sessions: Session[]; via: "private" | "sdk" }
  | { kind: "unavailable"; cause?: unknown }

export type FixtureMessagesOutcome =
  | { kind: "ok"; items: SessionV1.WithParts[]; via: "private" | "sdk" }
  | { kind: "terminal"; code: string }
  | { kind: "unavailable"; cause?: unknown }

type ListClient = {
  session: {
    list: (params: { directory: string }) => Promise<{ data?: unknown }>
  }
}

type MsgClient = {
  session: {
    messages: (params: { sessionID: string; directory: string }) => Promise<{ data?: unknown }>
  }
}

function isId(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.startsWith("ses") && !v.includes("\0")
}

function isStamp(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v) && Number.isSafeInteger(v) && v >= 0 && v <= 8640000000000000
}

interface ListEntry {
  id: string
  parentID: string | null
  title: string
  directory: string
  projectID: string
  createdAt: number
  updatedAt: number
}

// Shared with production `sessionRefreshContext.listSessions`: strict
// directory binding plus opaque cursor grammar. Throws on any invalid shape
// so the caller falls back to exactly one SDK read.
function checkEntry(e: unknown, want: string): asserts e is ListEntry {
  if (!e || typeof e !== "object" || Array.isArray(e)) throw new Error("invalid entry shape")
  const r = e as Record<string, unknown>
  if (!isId(r.id) || typeof r.title !== "string") throw new Error("invalid entry shape")
  if (r.parentID !== null && !isId(r.parentID)) throw new Error("invalid entry shape")
  if (typeof r.directory !== "string" || (r.directory as string) !== want) throw new Error("invalid entry shape")
  try {
    if (canonicalDirectory(r.directory as string) !== (r.directory as string)) throw new Error("invalid entry shape")
  } catch {
    throw new Error("invalid entry shape")
  }
  if (
    typeof r.projectID !== "string" ||
    (r.projectID as string).length === 0 ||
    (r.projectID as string).includes("\0")
  ) {
    throw new Error("invalid entry shape")
  }
  if (!isStamp(r.createdAt) || !isStamp(r.updatedAt)) throw new Error("invalid entry shape")
}

function checkCursor(next: unknown): void {
  if (typeof next !== "string") throw new Error("invalid nextCursor shape")
  const decoded = decodeGlobalListCursor(next)
  if (!isStamp(decoded.updated) || !isId(decoded.id)) throw new Error("invalid nextCursor content")
  if (normalizeSessionListNextCursor(next) === null) throw new Error("invalid nextCursor")
}

function parseListResult(raw: unknown, directory: string): { entries: ListEntry[]; truncated: boolean } {
  const rec = raw as Record<string, unknown> | null
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) throw new Error("invalid private shape")
  if (rec.v !== "1.0") throw new Error("invalid private version")
  if (!Array.isArray(rec.entries)) throw new Error("invalid private entries")
  const want = canonicalDirectory(directory)
  const entries = rec.entries as unknown[]
  for (const e of entries) checkEntry(e, want)
  const next = rec.nextCursor as unknown
  if (next === undefined) return { entries: entries as ListEntry[], truncated: false }
  checkCursor(next)
  return { entries: entries as ListEntry[], truncated: true }
}

function toSessionFromGet(found: ObservationGetSession): Session {
  return {
    id: found.id,
    parentID: found.parentID,
    title: found.title,
    directory: found.directory,
    projectID: found.projectID,
    time: { created: found.createdAt, updated: found.updatedAt },
    ...(typeof found.agent === "string" ? { agent: found.agent } : {}),
    ...(found.model !== undefined
      ? {
          model: {
            providerID: found.model.providerID,
            id: found.model.id,
            ...(found.model.variant !== undefined ? { variant: found.model.variant } : {}),
          },
        }
      : {}),
    ...(found.summary !== undefined ? { summary: found.summary } : {}),
    ...(found.revert !== undefined ? { revert: found.revert } : {}),
  } as unknown as Session
}

function usable(reader: PrivateSessionReader | null | undefined): reader is PrivateSessionReader {
  return !!reader && reader.isEnabled() && reader.isStarted()
}

async function hydrateList(reader: PrivateSessionReader, entries: ListEntry[], directory: string): Promise<Session[]> {
  const out: Session[] = []
  for (const e of entries) {
    const raw = await reader.get({ directory, sessionId: e.id })
    const res = validatePrivateGetResult(raw, directory, e.id)
    if (res.status !== "found") throw new Error(`hydration race: ${res.status}`)
    out.push(toSessionFromGet(res.session))
  }
  return out
}

// Shared private-first fixture list read: slim single-page private list plus
// per-session `observation/get` hydration is authoritative with zero SDK;
// list gate-off/malformed/truncated or any hydration miss (throw, malformed,
// not_found/scope_mismatch race, transport) fails the whole snapshot over to
// exactly one same-directory SDK `client.session.list` with no partial mix
// and no private retry; SDK failure/malformed returns `unavailable`.
// Truncation falls back (rather than draining) so one fixture read issues at
// most one private list, one private get per entry, plus at most one SDK read.
export async function fetchFixtureSessionListPrivateFirst(opts: {
  reader: PrivateSessionReader | null | undefined
  client: ListClient | null | undefined
  directory: string
}): Promise<FixtureListOutcome> {
  if (usable(opts.reader)) {
    try {
      const raw = await opts.reader.list({ directory: opts.directory, archived: false, limit: LIST_LIMIT })
      const parsed = parseListResult(raw, opts.directory)
      if (!parsed.truncated) {
        const sessions = await hydrateList(opts.reader, parsed.entries, opts.directory)
        return { kind: "ok", sessions, via: "private" }
      }
    } catch {
      // Fall through to exactly one SDK read below.
    }
  }
  const client = opts.client
  if (!client?.session?.list) return { kind: "unavailable" }
  try {
    const res = await client.session.list({ directory: opts.directory })
    const data = (res as { data?: unknown }).data ?? []
    if (!Array.isArray(data)) return { kind: "unavailable" }
    return { kind: "ok", sessions: data as Session[], via: "sdk" }
  } catch (e) {
    return { kind: "unavailable", cause: e }
  }
}

// Shared private-first fixture transcript read: full private page iteration
// (wire limit 100, newest-first, reversed to ASC like production collect) is
// authoritative with zero SDK; `not_found`/`scope_mismatch` close terminal
// with zero SDK; gate-off/malformed/cycle/bound-overflow take exactly one
// same-session/directory SDK `client.session.messages` fallback with no
// retry; SDK failure/malformed returns `unavailable`.
export async function fetchFixtureSessionMessagesPrivateFirst(opts: {
  reader: PrivateSessionReader | null | undefined
  client: MsgClient | null | undefined
  directory: string
  sessionId: string
}): Promise<FixtureMessagesOutcome> {
  const reader = opts.reader
  if (usable(reader) && typeof reader.messages === "function") {
    const pages: SessionV1.WithParts[][] = []
    let cursor: string | undefined = undefined
    const seen = new Set<string>()
    for (let n = 0; n < PAGE_BOUND; n++) {
      if (cursor !== undefined) {
        if (seen.has(cursor)) break
        seen.add(cursor)
      }
      let attempt: Awaited<ReturnType<typeof tryPrivateMessagesPage>>
      try {
        attempt = await tryPrivateMessagesPage(reader, {
          directory: opts.directory,
          sessionId: opts.sessionId,
          limit: PAGE_LIMIT,
          ...(cursor !== undefined ? { cursor } : {}),
        })
      } catch {
        break
      }
      if (attempt.kind === "terminal") {
        const code = attempt.error.name === "SessionNotFoundError" ? "session.not_found" : "scope_mismatch"
        return { kind: "terminal", code }
      }
      if (attempt.kind !== "found") break
      if (attempt.items.length === 0) {
        if (attempt.cursor) break
        return { kind: "ok", items: pages.reverse().flat(), via: "private" }
      }
      pages.push(attempt.items)
      if (!attempt.cursor) return { kind: "ok", items: pages.reverse().flat(), via: "private" }
      cursor = attempt.cursor
    }
  }
  const client = opts.client
  if (!client?.session?.messages) return { kind: "unavailable" }
  try {
    const res = await client.session.messages({ sessionID: opts.sessionId, directory: opts.directory })
    const data = (res as { data?: unknown }).data ?? []
    if (!Array.isArray(data)) return { kind: "unavailable" }
    return { kind: "ok", items: data as SessionV1.WithParts[], via: "sdk" }
  } catch (e) {
    return { kind: "unavailable", cause: e }
  }
}
