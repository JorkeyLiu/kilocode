import type { KiloClient, Session } from "@kilocode/sdk/v2/client"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"
import { validateSessionUpdateResult } from "../services/cli-backend/serve-private-peer"
import { buildSessionUpdateIdentity } from "./rename-session"
import { parseSessionTitle } from "../shared/session-title"
import { observationSessionToDetail, sdkSessionToDetail, validatePrivateGetResult, type SessionDetail } from "./session-detail"
import { tryPrivateOperationExact } from "./session-operation-private"
import type { PrivateSessionReader } from "./options"

export type RenameOutcome =
  | { kind: "session"; session: Session }
  | { kind: "detail"; detail: SessionDetail }
  | { kind: "refreshNeeded"; opId: string }

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`private parity timeout after ${ms}ms`)), ms)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

function resolveSession(raw: unknown): Session | undefined {
  const data = (raw as { data?: unknown }).data as Record<string, unknown> | undefined
  if (!data || typeof data !== "object") return undefined
  const cand = (data.session as unknown) ?? data
  if (!cand || typeof cand !== "object" || Array.isArray(cand)) return undefined
  const rec = cand as Record<string, unknown>
  if (typeof rec.id !== "string" || !rec.id.startsWith("ses")) return undefined
  if (typeof rec.title !== "string" || !rec.title) return undefined
  return cand as Session
}

// Smallest explicit guard for the complete canonical Session.Info required
// shape (generated SDK ships types only, no runtime decoder): every required
// field as currently defined. Optional fields stay unchecked.
// eslint-disable-next-line complexity
function isCanonicalSession(sess: unknown): sess is Session {
  if (!sess || typeof sess !== "object" || Array.isArray(sess)) return false
  const rec = sess as Record<string, unknown>
  if (typeof rec.id !== "string" || !rec.id) return false
  if (typeof rec.slug !== "string" || !rec.slug) return false
  if (typeof rec.projectID !== "string" || !rec.projectID) return false
  if (typeof rec.directory !== "string" || !rec.directory) return false
  if (typeof rec.title !== "string" || !rec.title) return false
  if (typeof rec.version !== "string" || !rec.version) return false
  const time = rec.time as Record<string, unknown> | undefined
  if (!time || typeof time !== "object" || Array.isArray(time)) return false
  if (typeof time.created !== "number" || !Number.isFinite(time.created)) return false
  if (typeof time.updated !== "number" || !Number.isFinite(time.updated)) return false
  return true
}

function terminal(code: string, message: string): Error {
  const err = new Error(message) as Error & { code: string; terminal: boolean }
  err.code = code
  err.terminal = true
  return err
}

function isTerminal(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { terminal?: unknown }).terminal === true
}

function unresolvedRename(opId: string): Error {
  return terminal("rename.unresolved", `Rename status could not be confirmed (opId=${opId}). No retry was issued.`)
}

type AttemptOk = { kind: "ok"; session: Session }
type AttemptTerminal = { kind: "terminal"; code: string; message: string }
type AttemptRetryable = { kind: "retryable"; reason: string }
type AttemptUncertain = { kind: "uncertain"; reason: string }

// eslint-disable-next-line complexity
function parseUpdateResult(
  result: unknown,
  req: unknown,
  sessionID: string,
  value: string,
): AttemptOk | AttemptTerminal | AttemptRetryable | AttemptUncertain {
  const typed = result as { status?: string; accepted?: boolean; transportUnknown?: unknown }
  if (typed.transportUnknown === true) return { kind: "uncertain", reason: "transportUnknown" }
  if (typed.status === "succeeded" && typed.accepted === true) {
    try {
      validateSessionUpdateResult(result as never, req as never)
    } catch (e) {
      return { kind: "uncertain", reason: `invalid: ${String(e).slice(0, 120)}` }
    }
    const sess = resolveSession(result)
    if (!sess) return { kind: "uncertain", reason: "invalid private session" }
    if (sess.id !== sessionID) return { kind: "uncertain", reason: "invalid private session binding" }
    const returned = parseSessionTitle(sess.title)
    if ("error" in returned || returned.value !== value) return { kind: "uncertain", reason: "invalid private title" }
    const rawData = (result as { data?: Record<string, unknown> }).data
    const topTitle = rawData?.title
    if (topTitle !== undefined) {
      const topParsed = parseSessionTitle(topTitle)
      if ("error" in topParsed || topParsed.value !== value) return { kind: "uncertain", reason: "invalid private title" }
    }
    if (!isCanonicalSession(sess)) return { kind: "uncertain", reason: "invalid private session shape" }
    try {
      sdkSessionToDetail(sess)
    } catch (e) {
      return { kind: "uncertain", reason: `invalid: ${String(e).slice(0, 120)}` }
    }
    return { kind: "ok", session: sess }
  }
  if (typed.status === "failed") {
    try {
      validateSessionUpdateResult(result as never, req as never)
    } catch (e) {
      return { kind: "uncertain", reason: `invalid: ${String(e).slice(0, 120)}` }
    }
    const failure = (result as { failure?: { code?: unknown; message?: unknown; retryable?: unknown } }).failure
    if (failure?.retryable === true)
      return { kind: "retryable", reason: String(typeof failure?.code === "string" ? failure.code : "retryable") }
    if (failure?.retryable === false) {
      const code = typeof failure?.code === "string" && failure.code ? failure.code : "failed"
      const message = typeof failure?.message === "string" && failure.message ? failure.message : code
      return { kind: "terminal", code, message }
    }
    return { kind: "uncertain", reason: "failed without retryable" }
  }
  return { kind: "uncertain", reason: `private not succeeded: ${String(typed.status)}` }
}

async function attempt(
  factory: () => { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean },
  canceller: { tryCancel?: (id: number, msg?: string) => boolean; invalidate?: (r: string) => void } | null,
  opId: string,
  ms = 3000,
): Promise<unknown> {
  let handle: { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean } | null = null
  let promise: Promise<unknown>
  try {
    handle = factory()
    promise = handle.promise
  } catch (e) {
    throw e
  }
  try {
    return await withTimeout(promise, ms)
  } catch (e) {
    const msg = String(e)
    if (msg.includes("private parity timeout") && handle) {
      if (handle.cancel) {
        try {
          handle.cancel(`private parity timeout opId=${opId}`)
        } catch {}
      } else if (canceller?.tryCancel) {
        let cleaned = false
        try {
          cleaned = canceller.tryCancel(handle.id, `private parity timeout opId=${opId}`)
        } catch {}
        if (!cleaned && canceller.invalidate) {
          try {
            canceller.invalidate(`session/update observer timeout opId=${opId}`)
          } catch {}
        }
      } else if (canceller?.invalidate) {
        try {
          canceller.invalidate(`session/update observer timeout opId=${opId}`)
        } catch {}
      }
    }
    throw e
  }
}

function cancellerOf(connection: KiloConnectionService): {
  tryCancel?: (id: number, msg?: string) => boolean
  invalidate?: (r: string) => void
} | null {
  const c = connection as unknown as {
    tryCancelPrivatePending?: (id: number, msg?: string) => boolean
    invalidatePrivatePeerOnObserverTimeout?: (r: string) => void
  }
  if (!c.tryCancelPrivatePending && !c.invalidatePrivatePeerOnObserverTimeout) return null
  return {
    tryCancel: c.tryCancelPrivatePending?.bind(connection),
    invalidate: c.invalidatePrivatePeerOnObserverTimeout?.bind(connection),
  }
}

async function getDetailForCompleted(
  reader: PrivateSessionReader | null | undefined,
  directory: string,
  sessionId: string,
): Promise<SessionDetail | undefined> {
  if (!reader || typeof reader.get !== "function" || !reader.isEnabled() || !reader.isStarted()) return undefined
  let raw: unknown
  try {
    raw = await reader.get({ directory, sessionId })
  } catch {
    return undefined
  }
  let validated: ReturnType<typeof validatePrivateGetResult>
  try {
    validated = validatePrivateGetResult(raw, directory, sessionId)
  } catch {
    return undefined
  }
  if (validated.status !== "found") return undefined
  try {
    return observationSessionToDetail(validated.session)
  } catch {
    return undefined
  }
}

async function reobserveRename(
  reader: PrivateSessionReader | null | undefined,
  input: { directory: string; sessionId: string; opId: string },
): Promise<RenameOutcome> {
  console.warn("[Kilo Rename] private uncertain, re-observe exact op", { opId: input.opId })
  let seen: Awaited<ReturnType<typeof tryPrivateOperationExact>>
  try {
    seen = await tryPrivateOperationExact(reader ?? null, input)
  } catch {
    throw unresolvedRename(input.opId)
  }
  if (seen.kind === "found") {
    const entry = seen.operation
    if (entry.opId !== input.opId) throw unresolvedRename(input.opId)
    if (entry.outcome === "succeeded") {
      const detail = await getDetailForCompleted(reader, input.directory, input.sessionId)
      if (detail) return { kind: "detail", detail }
      return { kind: "refreshNeeded", opId: input.opId }
    }
    if (entry.outcome === "failed" || entry.outcome === "abandoned") {
      const code = typeof entry.code === "string" && entry.code ? entry.code : "failed"
      const message = typeof entry.message === "string" && entry.message ? entry.message : code
      throw terminal(code, message)
    }
    throw unresolvedRename(input.opId)
  }
  throw unresolvedRename(input.opId)
}

// Accepted-only private-first title rename: exactly one private attempt with
// the durable tuple (opId/idempotencyKey/requestId/directory/title). A valid
// `succeeded` + `accepted` private session/title returns with zero SDK
// mutation; a validated terminal `failed` (`retryable === false`) throws with
// zero SDK; a validated pre-accept retryable fence takes exactly one SDK
// commit with the identical tuple; pre-send unavailable also takes exactly
// one SDK commit. Transport uncertainty (timeout/ambiguous/transportUnknown/
// peerClosed/invalid/throw) never dispatches SDK: it re-observes the exact
// `sessionUpdate:<sessionId>:<token>` op once via the injected
// `privateSessionReader.operation` (panel-safe, zero SDK). Found `succeeded`
// maps the authoritative `reader.get` detail; absent/unavailable/invalid maps
// to explicit `rename.unresolved` with no retry and no fabricated update.
export async function renameSessionPrivateFirst(opts: {
  client: KiloClient
  connection: KiloConnectionService
  sessionID: string
  title: unknown
  directory: string
  privateReader?: PrivateSessionReader | null
}): Promise<RenameOutcome> {
  const parsed = parseSessionTitle(opts.title)
  if ("error" in parsed) throw new Error("Invalid session title")
  const { client, connection, sessionID, directory, privateReader } = opts
  const value = parsed.value
  const { opId, idempotencyKey, requestId } = buildSessionUpdateIdentity(sessionID)
  const ctx = { directory, sessionId: sessionID, parentSessionId: null as null }
  const privateReq = {
    v: 1 as const,
    requestId,
    opId,
    op: "session/update" as const,
    idempotencyKey,
    context: ctx,
    payload: { title: value },
  }

  const sdkFallback = async (): Promise<RenameOutcome> => {
    const res = (await client.session.update(
      {
        sessionID,
        directory,
        title: value,
        opId,
        idempotencyKey,
        requestId,
        context: ctx,
      },
      { throwOnError: false } as unknown as never,
    )) as unknown as { data?: Session; error?: unknown }
    if (res.error) throw res.error
    if (!res.data) throw new Error("SDK update returned no data")
    return { kind: "session", session: res.data }
  }

  if (!connection.isPrivateAvailable()) return sdkFallback()
  const peer = connection as unknown as {
    privateSessionUpdateWithHandle?: (r: typeof privateReq) => {
      id: number
      promise: Promise<unknown>
      cancel?: (msg?: string) => boolean
    }
    privateSessionUpdate?: (r: unknown) => Promise<unknown>
    peekPrivatePeerNextId?: () => number | null
  }
  if (typeof peer.privateSessionUpdateWithHandle !== "function" && typeof peer.privateSessionUpdate !== "function")
    return sdkFallback()
  try {
    const canceller = cancellerOf(connection)
    const factory = () => {
      if (peer.privateSessionUpdateWithHandle) return peer.privateSessionUpdateWithHandle(privateReq as never)
      return { id: peer.peekPrivatePeerNextId?.() ?? -1, promise: peer.privateSessionUpdate!(privateReq as never) }
    }
    const result = await attempt(factory, canceller, opId)
    const outcome = parseUpdateResult(result, privateReq, sessionID, value)
    if (outcome.kind === "ok") return { kind: "session", session: outcome.session }
    if (outcome.kind === "terminal") throw terminal(outcome.code, outcome.message)
    if (outcome.kind === "retryable") {
      console.warn("[Kilo Rename] private fallback", { opId, reason: outcome.reason.slice(0, 120) })
      return sdkFallback()
    }
    return reobserveRename(privateReader ?? null, { directory, sessionId: sessionID, opId })
  } catch (e) {
    if (isTerminal(e)) throw e
    return reobserveRename(privateReader ?? null, { directory, sessionId: sessionID, opId })
  }
}
