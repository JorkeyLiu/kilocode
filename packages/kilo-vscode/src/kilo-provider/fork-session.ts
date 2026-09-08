import * as crypto from "crypto"
import type { Session, SessionStatus } from "@kilocode/sdk/v2/client"
import type { KiloConnectionService } from "../services/cli-backend"
import { getErrorMessage } from "../kilo-provider-utils"
import { TelemetryProxy, TelemetryEventName } from "../services/telemetry"
import type { KiloClient } from "@kilocode/sdk/v2/client"
import { validateForkResult } from "../services/cli-backend/serve-private-peer"

export interface ForkContext {
  connection: KiloConnectionService
  post: (message: { type: "error"; message: string }) => void
  register: (session: Session) => void
  forked: (session: Session, sourceID: string) => void
  status: (sessionID: string) => SessionStatus["type"] | undefined
  directory: (sessionID: string) => string
}

export function buildForkIdentity(sessionId: string): { opId: string; idempotencyKey: string; requestId: string } {
  const token = crypto.randomUUID()
  const opId = `fork:${sessionId}:${token}`
  const idempotencyKey = `fork:${sessionId}:${token}`
  const requestId = crypto.randomUUID()
  return { opId, idempotencyKey, requestId }
}

export interface DurableForkParams {
  sessionId: string
  directory: string
  messageId?: string
  opId: string
  idempotencyKey: string
  requestId: string
}

export async function executeDurableFork(
  client: KiloClient,
  params: DurableForkParams,
): Promise<{ data?: Session; response?: unknown; error?: unknown; raw: unknown }> {
  const durableContext = { directory: params.directory, sessionId: params.sessionId, parentSessionId: null as string | null }
  const input = {
    sessionID: params.sessionId,
    directory: params.directory,
    ...(params.messageId ? { messageID: params.messageId } : {}),
    opId: params.opId,
    idempotencyKey: params.idempotencyKey,
    requestId: params.requestId,
    context: durableContext,
  }
  const res = (await client.session.fork(input, { throwOnError: false } as unknown as { throwOnError: false })) as unknown as {
    data?: Session
    response?: unknown
    error?: unknown
  }
  return {
    data: res.data as Session | undefined,
    response: (res as unknown as { response?: unknown }).response,
    error: (res as unknown as { error?: unknown }).error,
    raw: res,
  }
}

// eslint-disable-next-line complexity
function sdkHasTerminal(sdkResult: { data?: unknown; error?: unknown; response?: unknown }): boolean {
  const resp = (sdkResult as { response?: { status?: unknown } })?.response
  const respStatus =
    resp && typeof resp.status === "number" && Number.isInteger(resp.status)
      ? (resp.status as number)
      : resp && typeof resp.status === "string"
        ? Number(resp.status)
        : null
  if (respStatus !== null && Number.isInteger(respStatus) && respStatus >= 100 && respStatus < 600) {
    if ([400, 404, 409, 500].includes(respStatus)) return true
    if (sdkResult.error) return false
    return true
  }
  if (!sdkResult.error) return true
  const err = sdkResult.error as Record<string, unknown>
  const candidates: unknown[] = [err.status, err.statusCode, err.code, err.httpStatus]
  for (const c of candidates) {
    if (typeof c === "number" && [400, 404, 409, 500].includes(c)) return true
    if (typeof c === "string" && ["400", "404", "409", "500"].includes(c)) return true
    const n = typeof c === "string" ? Number(c) : null
    if (n !== null && [400, 404, 409, 500].includes(n)) return true
  }
  if (typeof err.message === "string" && /\b(400|404|409|500)\b/.test(err.message)) return true
  const tag = typeof err._tag === "string" ? String(err._tag).toLowerCase() : ""
  if (tag.includes("badrequest") || tag.includes("notfound") || tag.includes("conflict") || tag.includes("internal")) return true
  if (typeof err.status === "undefined" && typeof err.code === "undefined" && typeof err._tag === "undefined") return false
  return false
}

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

// eslint-disable-next-line complexity
export async function observeForkParity(
  connection: KiloConnectionService,
  sdkResult: { data?: unknown; error?: unknown; response?: unknown },
  params: DurableForkParams,
): Promise<void> {
  if (!connection.isPrivateAvailable()) return
  if (!sdkHasTerminal(sdkResult)) return
  try {
    const privateReq = {
      v: 1 as const,
      requestId: params.requestId,
      opId: params.opId,
      op: "session/fork" as const,
      idempotencyKey: params.idempotencyKey,
      context: { directory: params.directory, sessionId: params.sessionId, parentSessionId: null as string | null },
      payload: { ...(params.messageId ? { messageId: params.messageId } : {}) },
    }
    let privRes: unknown
    const tryCancel = (connection as unknown as { tryCancelPrivatePending?: (id: number, msg?: string) => boolean })?.tryCancelPrivatePending?.bind(connection) ?? null
    const invalidate = (connection as unknown as { invalidatePrivatePeerOnObserverTimeout?: (r: string) => void })?.invalidatePrivatePeerOnObserverTimeout?.bind(connection) ?? null
    const handleFactory = (connection as unknown as { privateForkWithHandle?: (r: typeof privateReq) => { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean } })?.privateForkWithHandle?.bind(connection) ?? null
    const peekNextId = (connection as unknown as { peekPrivatePeerNextId?: () => number | null })?.peekPrivatePeerNextId?.bind(connection) ?? null
    let handle: { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean } | null = null
    let exactId: number | null = null
    let privPromise: Promise<unknown>
    if (handleFactory) {
      try {
        const h = handleFactory(privateReq as unknown as never) as { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean }
        handle = h
        exactId = h.id
        privPromise = h.promise
      } catch (e) {
        privPromise = Promise.reject(e)
      }
    } else {
      exactId = peekNextId ? peekNextId() : null
      privPromise = connection.privateFork(privateReq as unknown as never) as Promise<unknown>
    }
    try {
      privRes = await withTimeout(privPromise, 3000).catch((e: unknown) => {
        const msg = String(e)
        const isTimeout = msg.includes("private parity timeout")
        if (isTimeout) {
          let cleaned = false
          if (handle?.cancel) {
            try {
              cleaned = handle.cancel(`private parity timeout opId=${params.opId}`)
            } catch (err) {
              console.warn("[Kilo Fork] handle.cancel failed:", String(err).slice(0, 200), { opId: params.opId })
            }
          } else if (exactId !== null && tryCancel) {
            try {
              cleaned = tryCancel(exactId, `private parity timeout opId=${params.opId}`)
            } catch (err) {
              console.warn("[Kilo Fork] tryCancelPrivatePending failed:", String(err).slice(0, 200), { opId: params.opId })
            }
            if (!cleaned && invalidate) {
              try {
                invalidate(`fork observer timeout opId=${params.opId}`)
              } catch (err) {
                console.warn("[Kilo Fork] invalidatePrivatePeerOnObserverTimeout failed:", String(err).slice(0, 200), { opId: params.opId })
              }
            }
          } else if (invalidate) {
            try {
              invalidate(`fork observer timeout opId=${params.opId}`)
            } catch (err) {
              console.warn("[Kilo Fork] invalidatePrivatePeerOnObserverTimeout failed:", String(err).slice(0, 200), { opId: params.opId })
            }
          }
          console.warn("[Kilo Fork] private parity timeout after 3000ms:", { opId: params.opId, requestId: params.requestId })
        }
        return {
          v: 1,
          requestId: params.requestId,
          opId: params.opId,
          op: "session/fork",
          idempotencyKey: params.idempotencyKey,
          status: "ambiguous",
          outcome: { type: "ambiguous", time: Date.now() },
          accepted: false,
          transportUnknown: true,
          _error: String(e),
        }
      })
    } catch (e) {
      const msg = String(e)
      const isTimeout = msg.includes("private parity timeout")
      if (isTimeout) {
        if (handle?.cancel) {
          try {
            handle.cancel(`private parity timeout opId=${params.opId}`)
          } catch (err) {
            console.warn("[Kilo Fork] timeout handle.cancel failed:", String(err).slice(0, 200), { opId: params.opId })
          }
        } else if (exactId !== null && tryCancel) {
          try {
            const cleaned = tryCancel(exactId, `private parity timeout opId=${params.opId}`)
            if (!cleaned && invalidate) invalidate(`fork observer timeout opId=${params.opId}`)
          } catch (err) {
            console.warn("[Kilo Fork] timeout cancel failed:", String(err).slice(0, 200), { opId: params.opId })
          }
        } else if (invalidate) {
          try {
            invalidate(`fork observer timeout opId=${params.opId}`)
          } catch (err) {
            console.warn("[Kilo Fork] timeout invalidate failed:", String(err).slice(0, 200), { opId: params.opId })
          }
        }
      }
      privRes = {
        v: 1,
        requestId: params.requestId,
        opId: params.opId,
        op: "session/fork",
        idempotencyKey: params.idempotencyKey,
        status: "ambiguous",
        outcome: { type: "ambiguous", time: Date.now() },
        accepted: false,
        transportUnknown: true,
        _error: String(e),
      }
    }
    const { compareForkParity, validateForkResult } = await import("../services/cli-backend/serve-private-peer")
    try {
      validateForkResult(privRes as unknown, privateReq as unknown as never)
    } catch (err) {
      console.warn("[Kilo Fork] private validateForkResult failed:", String(err).slice(0, 200))
    }
    const parity = compareForkParity(privRes as unknown as never, sdkResult as unknown as never)
    if (parity.divergence) console.warn("[Kilo Fork] parity divergence:", parity.divergence, parity.details)
    else if ((privRes as Record<string, unknown>).transportUnknown) console.warn("[Kilo Fork] transport-unknown parity:", params.opId)
  } catch (e) {
    console.warn("[Kilo Fork] private parity observation failed (fail-closed):", String(e).slice(0, 200))
  }
}

function resolveForkSession(raw: unknown, sourceId: string, directory: string): Session | undefined {
  const data = (raw as { data?: unknown }).data as Record<string, unknown> | undefined
  if (!data || typeof data !== "object") return undefined
  const cand = (data.session as unknown) ?? data
  if (!cand || typeof cand !== "object" || Array.isArray(cand)) return undefined
  const rec = cand as Record<string, unknown>
  if (typeof rec.id !== "string" || !rec.id.startsWith("ses")) return undefined
  if (rec.parentID !== sourceId) return undefined
  if (typeof rec.directory === "string" && rec.directory.length > 0 && rec.directory !== directory) return undefined
  return cand as Session
}

function isForkTerminal(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { terminal?: unknown }).terminal === true
}

function forkTerminal(code: string, message: string): Error {
  const err = new Error(message) as Error & { code: string; terminal: boolean }
  err.code = code
  err.terminal = true
  return err
}

// eslint-disable-next-line complexity
export async function forkSessionPrivateFirst(opts: {
  client: KiloClient
  connection: KiloConnectionService
  sessionId: string
  directory: string
  messageId?: string
}): Promise<Session> {
  const { client, connection, sessionId, directory } = opts
  const { opId, idempotencyKey, requestId } = buildForkIdentity(sessionId)
  const privateReq = {
    v: 1 as const,
    requestId,
    opId,
    op: "session/fork" as const,
    idempotencyKey,
    context: { directory, sessionId, parentSessionId: null as string | null },
    payload: { ...(opts.messageId ? { messageId: opts.messageId } : {}) },
  }

  if (connection.isPrivateAvailable()) {
    try {
      const handleFactory = (connection as unknown as { privateForkWithHandle?: (r: typeof privateReq) => { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean } })?.privateForkWithHandle?.bind(connection) ?? null
      const tryCancel = (connection as unknown as { tryCancelPrivatePending?: (id: number, msg?: string) => boolean })?.tryCancelPrivatePending?.bind(connection) ?? null
      const invalidate = (connection as unknown as { invalidatePrivatePeerOnObserverTimeout?: (r: string) => void })?.invalidatePrivatePeerOnObserverTimeout?.bind(connection) ?? null
      const peekNextId = (connection as unknown as { peekPrivatePeerNextId?: () => number | null })?.peekPrivatePeerNextId?.bind(connection) ?? null
      let handle: { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean } | null = null
      let exactId: number | null = null
      let promise: Promise<unknown>
      if (handleFactory) {
        try {
          const h = handleFactory(privateReq as unknown as never)
          handle = h
          exactId = h.id
          promise = h.promise
        } catch (e) {
          promise = Promise.reject(e)
        }
      } else {
        exactId = peekNextId ? peekNextId() : null
        promise = (connection as unknown as { privateFork: (r: unknown) => Promise<unknown> }).privateFork(privateReq as unknown as never)
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
          } else if (exactId !== null && tryCancel) {
            let cleaned = false
            try {
              cleaned = tryCancel(exactId, `private parity timeout opId=${opId}`)
            } catch {}
            if (!cleaned && invalidate) {
              try {
                invalidate(`fork observer timeout opId=${opId}`)
              } catch {}
            }
          } else if (invalidate) {
            try {
              invalidate(`fork observer timeout opId=${opId}`)
            } catch {}
          }
        }
        throw e
      }

      const typed = result as { status?: string; accepted?: boolean; transportUnknown?: unknown }
      if (typed.status === "succeeded" && typed.accepted === true) {
        if (typed.transportUnknown === true) throw new Error("invalid private result")
        try {
          validateForkResult(result as unknown, privateReq as unknown as never)
        } catch {
          throw new Error("invalid private result")
        }
        const sess = resolveForkSession(result, sessionId, directory)
        if (!sess) throw new Error("invalid private result")
        return sess
      }
      if (typed.status === "failed") {
        try {
          validateForkResult(result as unknown, privateReq as unknown as never)
        } catch {
          throw new Error("invalid private result")
        }
        const failure = (result as { failure?: { code?: unknown; message?: unknown; retryable?: unknown } }).failure
        if (failure?.retryable !== false) {
          throw new Error(`private failed retryable: ${String(typeof failure?.code === "string" && failure.code ? failure.code : "failed")}`)
        }
        const code = typeof failure?.code === "string" && failure.code ? failure.code : "failed"
        const message = typeof failure?.message === "string" && failure.message ? failure.message : code
        throw forkTerminal(code, message)
      }
      throw new Error(`private not succeeded: ${String(typed.status)}`)
    } catch (e) {
      if (isForkTerminal(e)) throw e
      const msg = e instanceof Error ? e.message : String(e)
      const reason = msg.includes("private parity timeout") ? "private timeout" : msg.slice(0, 120)
      console.warn("[Kilo Fork] private fallback", { opId, reason: reason.slice(0, 120) })
    }
  }

  const params: DurableForkParams = { sessionId, directory, messageId: opts.messageId, opId, idempotencyKey, requestId }
  const res = await executeDurableFork(client, params)
  if (res.error) throw res.error
  if (!res.data) throw new Error("SDK fork returned no data")
  return res.data as Session
}

export async function handleForkSession(ctx: ForkContext, sessionId: string, messageId?: string): Promise<void> {
  const status =
    ctx.status(sessionId) ??
    (await Promise.resolve()
      .then(() =>
        ctx.connection.getClient().session.status({ directory: ctx.directory(sessionId) }, { throwOnError: true }),
      )
      .then((result) => result.data?.[sessionId]?.type ?? "idle")
      .catch((e) => {
        console.error("[Kilo New] refreshForkStatus failed:", e)
        return "busy" as SessionStatus["type"]
      }))
  if (status !== "idle") {
    ctx.post({ type: "error", message: "Wait for the session to finish before forking it." })
    return
  }

  const client = ctx.connection.getClient()
  const directory = ctx.directory(sessionId)
  try {
    const forked = await forkSessionPrivateFirst({ client, connection: ctx.connection, sessionId, directory, messageId })
    ctx.register(forked)
    ctx.forked(forked, sessionId)
  } catch (error) {
    const errMsg = getErrorMessage(error)
    ctx.post({ type: "error", message: `Failed to fork session: ${errMsg}` })
    TelemetryProxy.capture(TelemetryEventName.AGENT_MANAGER_SESSION_ERROR, {
      source: "kilo-provider",
      error: errMsg,
      context: "forkSession",
      sessionId,
    })
  }
}
