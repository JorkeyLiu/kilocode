import * as crypto from "crypto"
import type { KiloClient, Session } from "@kilocode/sdk/v2/client"
import type { KiloConnectionService } from "../services/cli-backend"
import { validateRevertResult, validateUnrevertResult } from "../services/cli-backend/serve-private-revert-contract"
import { tryPrivateOperationExact } from "./session-operation-private"
import { observationSessionToDetail, validatePrivateGetResult, type SessionDetail } from "./session-detail"
import type { PrivateSessionReader } from "./options"

export function buildRevertIdentity(sessionId: string): { opId: string; idempotencyKey: string; requestId: string } {
  const token = crypto.randomUUID()
  const opId = `revert:${sessionId}:${token}`
  const idempotencyKey = `revert:${sessionId}:${token}`
  const requestId = crypto.randomUUID()
  return { opId, idempotencyKey, requestId }
}

export function buildUnrevertIdentity(sessionId: string): { opId: string; idempotencyKey: string; requestId: string } {
  const token = crypto.randomUUID()
  const opId = `unrevert:${sessionId}:${token}`
  const idempotencyKey = `unrevert:${sessionId}:${token}`
  const requestId = crypto.randomUUID()
  return { opId, idempotencyKey, requestId }
}

export type RevertOutcome =
  | { kind: "session"; session: Session }
  | { kind: "detail"; detail: SessionDetail }
  | { kind: "refreshNeeded"; opId: string }

export type UnrevertOutcome = RevertOutcome

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

function terminal(code: string, message: string): Error {
  const err = new Error(message) as Error & { code: string; terminal: boolean }
  err.code = code
  err.terminal = true
  return err
}

function isTerminal(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { terminal?: unknown }).terminal === true
}

function unresolvedRevert(opId: string): Error {
  return terminal("revert.unresolved", `Revert status could not be confirmed (opId=${opId}). No retry was issued.`)
}

function unresolvedUnrevert(opId: string): Error {
  return terminal("unrevert.unresolved", `Unrevert status could not be confirmed (opId=${opId}). No retry was issued.`)
}

type AttemptOk = { kind: "ok"; session: Session }
type AttemptTerminal = { kind: "terminal"; code: string; message: string }
type AttemptRetryable = { kind: "retryable"; reason: string }
type AttemptUncertain = { kind: "uncertain"; reason: string }

function sessionOf(result: unknown): Session | undefined {
  const data = (result as { data?: unknown }).data as Record<string, unknown> | undefined
  const cand = data && typeof data === "object" ? ((data.session as unknown) ?? data) : undefined
  if (!cand || typeof cand !== "object" || Array.isArray(cand)) return undefined
  const rec = cand as Record<string, unknown>
  if (typeof rec.id !== "string" || !rec.id.startsWith("ses")) return undefined
  return cand as Session
}

function parseRevertResult(result: unknown, req: unknown): AttemptOk | AttemptTerminal | AttemptRetryable | AttemptUncertain {
  const typed = result as { status?: string; accepted?: boolean; transportUnknown?: unknown }
  if (typed.transportUnknown === true) return { kind: "uncertain", reason: "transportUnknown" }
  if (typed.status === "succeeded" && typed.accepted === true) {
    try {
      validateRevertResult(result as never, req as never)
    } catch (e) {
      return { kind: "uncertain", reason: `invalid: ${String(e).slice(0, 120)}` }
    }
    const sess = sessionOf(result)
    if (!sess) return { kind: "uncertain", reason: "invalid private session" }
    return { kind: "ok", session: sess }
  }
  if (typed.status === "failed") {
    try {
      validateRevertResult(result as never, req as never)
    } catch (e) {
      return { kind: "uncertain", reason: `invalid: ${String(e).slice(0, 120)}` }
    }
    const failure = (result as { failure?: { code?: unknown; message?: unknown; retryable?: unknown } }).failure
    if (failure?.retryable === true) return { kind: "retryable", reason: String(typeof failure?.code === "string" ? failure.code : "retryable") }
    if (failure?.retryable === false) {
      const code = typeof failure?.code === "string" && failure.code ? failure.code : "failed"
      const message = typeof failure?.message === "string" && failure.message ? failure.message : code
      return { kind: "terminal", code, message }
    }
    return { kind: "uncertain", reason: "failed without retryable" }
  }
  return { kind: "uncertain", reason: `private not succeeded: ${String(typed.status)}` }
}

function parseUnrevertResult(result: unknown, req: unknown): AttemptOk | AttemptTerminal | AttemptRetryable | AttemptUncertain {
  const typed = result as { status?: string; accepted?: boolean; transportUnknown?: unknown }
  if (typed.transportUnknown === true) return { kind: "uncertain", reason: "transportUnknown" }
  if (typed.status === "succeeded" && typed.accepted === true) {
    try {
      validateUnrevertResult(result as never, req as never)
    } catch (e) {
      return { kind: "uncertain", reason: `invalid: ${String(e).slice(0, 120)}` }
    }
    const sess = sessionOf(result)
    if (!sess) return { kind: "uncertain", reason: "invalid private session" }
    return { kind: "ok", session: sess }
  }
  if (typed.status === "failed") {
    try {
      validateUnrevertResult(result as never, req as never)
    } catch (e) {
      return { kind: "uncertain", reason: `invalid: ${String(e).slice(0, 120)}` }
    }
    const failure = (result as { failure?: { code?: unknown; message?: unknown; retryable?: unknown } }).failure
    if (failure?.retryable === true) return { kind: "retryable", reason: String(typeof failure?.code === "string" ? failure.code : "retryable") }
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
            canceller.invalidate(`revert observer timeout opId=${opId}`)
          } catch {}
        }
      } else if (canceller?.invalidate) {
        try {
          canceller.invalidate(`revert observer timeout opId=${opId}`)
        } catch {}
      }
    }
    throw e
  }
}

function cancellerOf(connection: KiloConnectionService): { tryCancel?: (id: number, msg?: string) => boolean; invalidate?: (r: string) => void } | null {
  const c = connection as unknown as {
    tryCancelPrivatePending?: (id: number, msg?: string) => boolean
    invalidatePrivatePeerOnObserverTimeout?: (r: string) => void
  }
  if (!c.tryCancelPrivatePending && !c.invalidatePrivatePeerOnObserverTimeout) return null
  return { tryCancel: c.tryCancelPrivatePending?.bind(connection), invalidate: c.invalidatePrivatePeerOnObserverTimeout?.bind(connection) }
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

async function reobserveRevert(
  reader: PrivateSessionReader | null | undefined,
  input: { directory: string; sessionId: string; opId: string },
  unresolved: (opId: string) => Error,
): Promise<RevertOutcome> {
  console.warn("[Kilo Revert] private uncertain, re-observe exact op", { opId: input.opId })
  let seen: Awaited<ReturnType<typeof tryPrivateOperationExact>>
  try {
    seen = await tryPrivateOperationExact(reader ?? null, input)
  } catch {
    throw unresolved(input.opId)
  }
  if (seen.kind === "found") {
    const entry = seen.operation
    if (entry.opId !== input.opId) throw unresolved(input.opId)
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
    throw unresolved(input.opId)
  }
  throw unresolved(input.opId)
}

export async function revertSessionPrivateFirst(opts: {
  client: KiloClient
  connection: KiloConnectionService
  sessionId: string
  directory: string
  messageId: string
  partId?: string
  privateReader?: PrivateSessionReader | null
}): Promise<RevertOutcome> {
  const { client, connection, sessionId, directory, messageId, partId, privateReader } = opts
  const { opId, idempotencyKey, requestId } = buildRevertIdentity(sessionId)
  const req = {
    v: 1 as const, requestId, opId, op: "session/revert" as const, idempotencyKey,
    context: { directory, sessionId, parentSessionId: null as string | null },
    payload: { ...(messageId ? { messageId } : {}), ...(partId ? { partId } : {}) },
  }
  const sdkFallback = async (): Promise<RevertOutcome> => {
    const res = (await client.session.revert(
      { sessionID: sessionId, messageID: messageId, partID: partId, directory },
      { throwOnError: false } as never,
    )) as unknown as { data?: Session; error?: unknown }
    if (res.error) throw res.error
    if (!res.data) throw new Error("Revert returned no session")
    return { kind: "session", session: res.data }
  }
  if (!connection.isPrivateAvailable()) return sdkFallback()
  const peer = connection as unknown as {
    privateRevertWithHandle?: (r: typeof req) => { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean }
    privateRevert?: (r: unknown) => Promise<unknown>
    peekPrivatePeerNextId?: () => number | null
  }
  if (typeof peer.privateRevertWithHandle !== "function" && typeof peer.privateRevert !== "function") return sdkFallback()
  try {
    const canceller = cancellerOf(connection)
    const factory = () => {
      if (peer.privateRevertWithHandle) return peer.privateRevertWithHandle(req as never)
      return { id: peer.peekPrivatePeerNextId?.() ?? -1, promise: peer.privateRevert!(req as never) }
    }
    const result = await attempt(factory, canceller, opId)
    const parsed = parseRevertResult(result, req)
    if (parsed.kind === "ok") return { kind: "session", session: parsed.session }
    if (parsed.kind === "terminal") throw terminal(parsed.code, parsed.message)
    if (parsed.kind === "retryable") {
      console.warn("[Kilo Revert] private fallback", { opId, reason: parsed.reason.slice(0, 120) })
      return sdkFallback()
    }
    return reobserveRevert(privateReader ?? null, { directory, sessionId, opId }, unresolvedRevert)
  } catch (e) {
    if (isTerminal(e)) throw e
    return reobserveRevert(privateReader ?? null, { directory, sessionId, opId }, unresolvedRevert)
  }
}

export async function unrevertSessionPrivateFirst(opts: {
  client: KiloClient
  connection: KiloConnectionService
  sessionId: string
  directory: string
  privateReader?: PrivateSessionReader | null
}): Promise<UnrevertOutcome> {
  const { client, connection, sessionId, directory, privateReader } = opts
  const { opId, idempotencyKey, requestId } = buildUnrevertIdentity(sessionId)
  const req = {
    v: 1 as const, requestId, opId, op: "session/unrevert" as const, idempotencyKey,
    context: { directory, sessionId, parentSessionId: null as string | null },
    payload: {},
  }
  const sdkFallback = async (): Promise<UnrevertOutcome> => {
    const res = (await client.session.unrevert(
      { sessionID: sessionId, directory },
      { throwOnError: false } as never,
    )) as unknown as { data?: Session; error?: unknown }
    if (res.error) throw res.error
    if (!res.data) throw new Error("Redo returned no session")
    return { kind: "session", session: res.data }
  }
  if (!connection.isPrivateAvailable()) return sdkFallback()
  const peer = connection as unknown as {
    privateUnrevertWithHandle?: (r: typeof req) => { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean }
    privateUnrevert?: (r: unknown) => Promise<unknown>
    peekPrivatePeerNextId?: () => number | null
  }
  if (typeof peer.privateUnrevertWithHandle !== "function" && typeof peer.privateUnrevert !== "function") return sdkFallback()
  try {
    const canceller = cancellerOf(connection)
    const factory = () => {
      if (peer.privateUnrevertWithHandle) return peer.privateUnrevertWithHandle(req as never)
      return { id: peer.peekPrivatePeerNextId?.() ?? -1, promise: peer.privateUnrevert!(req as never) }
    }
    const result = await attempt(factory, canceller, opId)
    const parsed = parseUnrevertResult(result, req)
    if (parsed.kind === "ok") return { kind: "session", session: parsed.session }
    if (parsed.kind === "terminal") throw terminal(parsed.code, parsed.message)
    if (parsed.kind === "retryable") {
      console.warn("[Kilo Unrevert] private fallback", { opId, reason: parsed.reason.slice(0, 120) })
      return sdkFallback()
    }
    return reobserveRevert(privateReader ?? null, { directory, sessionId, opId }, unresolvedUnrevert)
  } catch (e) {
    if (isTerminal(e)) throw e
    return reobserveRevert(privateReader ?? null, { directory, sessionId, opId }, unresolvedUnrevert)
  }
}
