import * as crypto from "crypto"
import type { Session, SessionStatus } from "@kilocode/sdk/v2/client"
import type { KiloConnectionService } from "../services/cli-backend"
import { getErrorMessage } from "../kilo-provider-utils"
import { TelemetryProxy, TelemetryEventName } from "../services/telemetry"
import type { KiloClient } from "@kilocode/sdk/v2/client"

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
    // Capture the JSON-RPC id that will be used for this private request so a
    // timeout can explicitly release ownership at the natural private-peer
    // boundary (JsonRpcPeer pending map) or invalidate the epoch via the
    // owner (KiloConnectionService). This prevents accumulation of unresolved
    // entries after repeated hangs; after invalidation private parity remains
    // disabled until the next full backend connection/server reset, while
    // keeping the SDK result authoritative.
    const peekNextId = (connection as unknown as { peekPrivatePeerNextId?: () => number | null })?.peekPrivatePeerNextId?.bind(connection) ?? null
    const tryCancel = (connection as unknown as { tryCancelPrivatePending?: (id: number, msg?: string) => boolean })?.tryCancelPrivatePending?.bind(connection) ?? null
    const invalidate = (connection as unknown as { invalidatePrivatePeerOnObserverTimeout?: (r: string) => void })?.invalidatePrivatePeerOnObserverTimeout?.bind(connection) ?? null
    const getPending = (connection as unknown as { getPrivatePeerPendingCount?: () => number })?.getPrivatePeerPendingCount?.bind(connection) ?? null
    const nextIdBefore = peekNextId ? peekNextId() : null
    try {
      privRes = await withTimeout(connection.privateFork(privateReq as unknown as never) as Promise<unknown>, 3000).catch((e: unknown) => {
        const msg = String(e)
        const isTimeout = msg.includes("private parity timeout")
        if (isTimeout) {
          // Prefer explicit pending removal at the owned JsonRpcPeer boundary.
          let cleaned = false
          if (nextIdBefore !== null && tryCancel) {
            try {
              cleaned = tryCancel(nextIdBefore, `private parity timeout opId=${params.opId}`)
            } catch (err) {
              console.warn("[Kilo Fork] tryCancelPrivatePending failed:", String(err).slice(0, 200), { opId: params.opId })
            }
          }
          // Fallback: dispose/replace the private peer through its owner so
          // the timed-out pending cannot accumulate. The SDK result stays
          // authoritative; thereafter private parity remains disabled
          // (fail-closed) until the next full backend connection/server reset
          // (no automatic retry/reconnect, no detached work).
          if (!cleaned && invalidate) {
            try {
              invalidate(`fork observer timeout opId=${params.opId}`)
            } catch (err) {
              console.warn("[Kilo Fork] invalidatePrivatePeerOnObserverTimeout failed:", String(err).slice(0, 200), { opId: params.opId })
            }
          } else if (getPending && getPending() > 0 && invalidate) {
            // If explicit cancel did not clear (e.g. id drift), ensure epoch invalidation.
            try {
              invalidate(`fork observer timeout pending remaining opId=${params.opId}`)
            } catch (err) {
              console.warn("[Kilo Fork] invalidate pending remaining failed:", String(err).slice(0, 200), { opId: params.opId })
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
      if (isTimeout && nextIdBefore !== null && tryCancel) {
        try {
          const cleaned = tryCancel(nextIdBefore, `private parity timeout opId=${params.opId}`)
          if (!cleaned && invalidate) invalidate(`fork observer timeout opId=${params.opId}`)
        } catch (err) {
          console.warn("[Kilo Fork] timeout cancel failed:", String(err).slice(0, 200), { opId: params.opId })
        }
      } else if (isTimeout && invalidate) {
        try {
          invalidate(`fork observer timeout opId=${params.opId}`)
        } catch (err) {
          console.warn("[Kilo Fork] timeout invalidate failed:", String(err).slice(0, 200), { opId: params.opId })
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
  const identity = buildForkIdentity(sessionId)
  const params: DurableForkParams = { sessionId, directory, messageId, opId: identity.opId, idempotencyKey: identity.idempotencyKey, requestId: identity.requestId }
  let forked: Session | undefined
  let sdkResult: { data?: Session; error?: unknown; response?: unknown } | null = null
  let sdkThrew: unknown = null
  try {
    const res = await executeDurableFork(client, params)
    sdkResult = { data: res.data as Session | undefined, response: res.response, error: res.error }
    if (res.error) {
      const errMsg = getErrorMessage(res.error)
      ctx.post({ type: "error", message: `Failed to fork session: ${errMsg}` })
      TelemetryProxy.capture(TelemetryEventName.AGENT_MANAGER_SESSION_ERROR, {
        source: "kilo-provider",
        error: errMsg,
        context: "forkSession",
        sessionId,
      })
    } else if (res.data) {
      forked = res.data as Session
    }
  } catch (error) {
    sdkThrew = error
    const asRec = error as Record<string, unknown>
    const errObj = (asRec?.error as unknown) ?? error
    const respObj = (asRec?.response as unknown) ?? undefined
    sdkResult = { data: (asRec?.data as Session) ?? undefined, error: errObj, response: respObj }
    const errMsg = getErrorMessage(error)
    ctx.post({ type: "error", message: `Failed to fork session: ${errMsg}` })
    TelemetryProxy.capture(TelemetryEventName.AGENT_MANAGER_SESSION_ERROR, {
      source: "kilo-provider",
      error: errMsg,
      context: "forkSession",
      sessionId,
    })
  }

  if (sdkResult) {
    try {
      await observeForkParity(ctx.connection, sdkResult as { data?: unknown; error?: unknown; response?: unknown }, params)
    } catch (err) {
      console.warn("[Kilo Fork] observeForkParity failed:", String(err).slice(0, 200), { opId: params.opId, requestId: params.requestId })
    }
  }

  if (!forked) return

  ctx.register(forked)
  ctx.forked(forked, sessionId)
}
