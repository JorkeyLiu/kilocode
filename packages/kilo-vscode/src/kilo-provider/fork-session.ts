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
): Promise<{ data: Session; response?: unknown; error?: unknown; raw: unknown }> {
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
  const res = (await client.session.fork(input, { throwOnError: true })) as unknown as { data: Session; response?: unknown; error?: unknown }
  return { data: res.data, response: (res as unknown as { response?: unknown }).response, error: (res as unknown as { error?: unknown }).error, raw: res }
}

export async function observeForkParity(
  connection: KiloConnectionService,
  sdkResult: { data?: unknown; error?: unknown; response?: unknown },
  params: DurableForkParams,
): Promise<void> {
  if (!connection.isPrivateAvailable()) return
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
    const privRes = await connection.privateFork(privateReq as unknown as never)
    const { compareForkParity, validateForkResult } = await import("../services/cli-backend/serve-private-peer")
    // Validate through real ServePrivatePeer validator (throws on mismatch)
    try {
      validateForkResult(privRes as unknown, privateReq as unknown as never)
    } catch (err) {
      console.warn("[Kilo Fork] private validateForkResult failed:", String(err).slice(0, 200))
    }
    const parity = compareForkParity(privRes as unknown as never, sdkResult as unknown as never)
    if (parity.divergence) console.warn("[Kilo Fork] parity divergence:", parity.divergence, parity.details)
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
  let forked: Session
  let sdkResult: { data?: Session; error?: unknown; response?: unknown } | null = null
  try {
    const res = await executeDurableFork(client, params)
    sdkResult = { data: res.data, response: res.response, error: res.error }
    forked = res.data
  } catch (error) {
    const err = getErrorMessage(error)
    ctx.post({ type: "error", message: `Failed to fork session: ${err}` })
    TelemetryProxy.capture(TelemetryEventName.AGENT_MANAGER_SESSION_ERROR, {
      source: "kilo-provider",
      error: err,
      context: "forkSession",
      sessionId,
    })
    return
  }

  if (sdkResult) await observeForkParity(ctx.connection, sdkResult, params)

  ctx.register(forked)
  ctx.forked(forked, sessionId)
}
