import * as crypto from "crypto"
import type { KiloClient, Session } from "@kilocode/sdk/v2/client"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"
import { validateCreateResult } from "../services/cli-backend/serve-private-peer"
import { tryPrivateCreateExact } from "./session-operation-private"
import { observationSessionToDetail, validatePrivateGetResult, type SessionDetail } from "./session-detail"
import type { PrivateSessionReader } from "./options"

export function buildCreateIdentity(): { opId: string; idempotencyKey: string; requestId: string } {
  const token = crypto.randomUUID()
  const opId = `create:${token}`
  const idempotencyKey = `create:${token}`
  const requestId = crypto.randomUUID()
  return { opId, idempotencyKey, requestId }
}

export type CreateOutcome =
  | { kind: "session"; session: Session }
  | { kind: "detail"; detail: SessionDetail }
  | { kind: "pending"; opId: string; childId?: string }

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

function unresolvedCreate(opId: string): Error {
  return terminal("create.unresolved", `Session create status could not be confirmed (opId=${opId}). No retry was issued.`)
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

// eslint-disable-next-line complexity
function parseCreateResult(result: unknown, req: unknown): AttemptOk | AttemptTerminal | AttemptRetryable | AttemptUncertain {
  const typed = result as { status?: string; accepted?: boolean; transportUnknown?: unknown }
  if (typed.transportUnknown === true) return { kind: "uncertain", reason: "transportUnknown" }
  if (typed.status === "succeeded" && typed.accepted === true) {
    try {
      validateCreateResult(result as never, req as never)
    } catch (e) {
      return { kind: "uncertain", reason: `invalid: ${String(e).slice(0, 120)}` }
    }
    const sess = sessionOf(result)
    if (!sess) return { kind: "uncertain", reason: "invalid private session" }
    return { kind: "ok", session: sess }
  }
  if (typed.status === "failed") {
    try {
      validateCreateResult(result as never, req as never)
    } catch (e) {
      return { kind: "uncertain", reason: `invalid: ${String(e).slice(0, 120)}` }
    }
    const failure = (result as { failure?: { code?: unknown; message?: unknown; retryable?: unknown } }).failure
    const accepted = (result as { accepted?: unknown }).accepted
    if (failure?.retryable === true && accepted === false) {
      return { kind: "retryable", reason: String(typeof failure?.code === "string" ? failure.code : "retryable") }
    }
    if (failure?.retryable === false) {
      const code = typeof failure?.code === "string" && failure.code ? failure.code : "failed"
      const message = typeof failure?.message === "string" && failure.message ? failure.message : code
      return { kind: "terminal", code, message }
    }
    return { kind: "uncertain", reason: "failed without single-SDK retryable" }
  }
  return { kind: "uncertain", reason: `private not succeeded: ${String(typed.status)}` }
}

async function getDetailForCreated(
  reader: PrivateSessionReader | null | undefined,
  directory: string,
  childId: string,
): Promise<SessionDetail | undefined> {
  if (!reader || typeof reader.get !== "function" || !reader.isEnabled() || !reader.isStarted()) return undefined
  let raw: unknown
  try {
    raw = await reader.get({ directory, sessionId: childId })
  } catch {
    return undefined
  }
  let validated: ReturnType<typeof validatePrivateGetResult>
  try {
    validated = validatePrivateGetResult(raw, directory, childId)
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

async function reobserveCreate(
  reader: PrivateSessionReader | null | undefined,
  input: { directory: string; opId: string },
): Promise<CreateOutcome> {
  console.warn("[Kilo Create] private uncertain, re-observe exact op", { opId: input.opId })
  let seen: Awaited<ReturnType<typeof tryPrivateCreateExact>>
  try {
    seen = await tryPrivateCreateExact(reader ?? null, input)
  } catch {
    throw unresolvedCreate(input.opId)
  }
  if (seen.kind === "found") {
    const childId = seen.createdSessionId
    const detail = await getDetailForCreated(reader, input.directory, childId)
    if (detail) return { kind: "detail", detail }
    return { kind: "pending", opId: input.opId, childId }
  }
  throw unresolvedCreate(input.opId)
}

// Accepted-only private-first create: exactly one private attempt with the
// durable tuple (create:<uuid> opId/idempotencyKey + requestId + directory).
// A valid `succeeded` + `accepted` private session returns with zero SDK; a
// validated terminal `failed` (`retryable === false`) throws with zero SDK; a
// validated pre-accept retryable fence (`accepted === false`,
// `retryable === true`) takes exactly one SDK commit with the identical tuple;
// pre-send unavailable also takes exactly one SDK commit. Transport
// uncertainty (timeout/ambiguous/transportUnknown/peerClosed/invalid/throw)
// never dispatches SDK: it re-observes the exact `create:<uuid>` op once via
// the INTERNAL `observation/create-operation` minimal-ID projection (opId +
// authoritative directory only, no sessionId, no snapshot/token/secret) then
// reads the authoritative Session via `reader.get(childId)`. Found + get
// returns the detail; found without get returns pending with the known child
// ID for ID-only adoption; absent/scope/unavailable throws explicit
// `create.unresolved` with no retry and no fabricated Session. No second
// create is ever issued (direction 74-76).
// eslint-disable-next-line complexity
export async function createSessionPrivateFirst(opts: {
  client: KiloClient
  connection: KiloConnectionService
  directory: string
  platform?: string
  metadata?: Record<string, unknown>
  title?: string
  parentID?: string
  sandboxInheritanceToken?: string
  privateReader?: PrivateSessionReader | null
}): Promise<CreateOutcome> {
  const { client, connection, directory, privateReader } = opts
  const { opId, idempotencyKey, requestId } = buildCreateIdentity()
  const ctx = { directory, parentSessionId: null as string | null }
  const payload: Record<string, unknown> = {}
  if (opts.title) payload.title = opts.title
  if (opts.parentID) payload.parentID = opts.parentID
  if (opts.platform) payload.platform = opts.platform
  if (opts.metadata) payload.metadata = opts.metadata
  if (opts.sandboxInheritanceToken) payload.sandboxInheritanceToken = opts.sandboxInheritanceToken
  const privateReq = {
    v: 1 as const,
    requestId,
    opId,
    op: "session/create" as const,
    idempotencyKey,
    context: ctx,
    payload,
  }

  const sdkOnce = async (): Promise<CreateOutcome> => {
    const sdkInput: Record<string, unknown> = {
      directory,
      platform: opts.platform,
      metadata: opts.metadata,
      opId,
      idempotencyKey,
      requestId,
      context: ctx,
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.parentID ? { parentID: opts.parentID } : {}),
      ...(opts.sandboxInheritanceToken ? { sandboxInheritanceToken: opts.sandboxInheritanceToken } : {}),
    }
    const res = (await client.session.create(sdkInput as unknown as never, { throwOnError: false } as unknown as never)) as unknown as { data?: Session; error?: unknown }
    if (res.error) throw res.error
    if (!res.data) throw new Error("SDK create returned no data")
    return { kind: "session", session: res.data }
  }

  if (!connection.isPrivateAvailable()) return sdkOnce()
  const peer = connection as unknown as {
    privateCreateWithHandle?: (r: typeof privateReq) => { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean }
    privateCreate?: (r: unknown) => Promise<unknown>
    peekPrivatePeerNextId?: () => number | null
    tryCancelPrivatePending?: (id: number, msg?: string) => boolean
    invalidatePrivatePeerOnObserverTimeout?: (r: string) => void
  }
  if (typeof peer.privateCreateWithHandle !== "function" && typeof peer.privateCreate !== "function") return sdkOnce()
  const canceller = {
    tryCancel: peer.tryCancelPrivatePending?.bind(connection),
    invalidate: peer.invalidatePrivatePeerOnObserverTimeout?.bind(connection),
  }
  try {
    let handle: { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean } | null = null
    let exactId: number | null = null
    let promise: Promise<unknown>
    if (peer.privateCreateWithHandle) {
      try {
        const h = peer.privateCreateWithHandle(privateReq as never)
        handle = h
        exactId = h.id
        promise = h.promise
      } catch (e) {
        promise = Promise.reject(e)
      }
    } else {
      exactId = peer.peekPrivatePeerNextId?.() ?? null
      promise = peer.privateCreate!(privateReq as never)
    }
    let result: unknown
    try {
      result = await withTimeout(promise, 3000)
    } catch (e) {
      const msg = String(e)
      if (msg.includes("private parity timeout")) {
        if (handle?.cancel) {
          try {
            handle.cancel(`private parity timeout opId=${opId}`)
          } catch {}
        } else if (exactId !== null && canceller.tryCancel) {
          let cleaned = false
          try {
            cleaned = canceller.tryCancel(exactId, `private parity timeout opId=${opId}`)
          } catch {}
          if (!cleaned && canceller.invalidate) {
            try {
              canceller.invalidate(`create observer timeout opId=${opId}`)
            } catch {}
          }
        } else if (canceller.invalidate) {
          try {
            canceller.invalidate(`create observer timeout opId=${opId}`)
          } catch {}
        }
      }
      throw e
    }
    const parsed = parseCreateResult(result, privateReq)
    if (parsed.kind === "ok") return { kind: "session", session: parsed.session }
    if (parsed.kind === "terminal") throw terminal(parsed.code, parsed.message)
    if (parsed.kind === "retryable") {
      console.warn("[Kilo Create] private fallback", { opId })
      return sdkOnce()
    }
    return reobserveCreate(privateReader ?? null, { directory, opId })
  } catch (e) {
    if (isTerminal(e)) throw e
    return reobserveCreate(privateReader ?? null, { directory, opId })
  }
}
