import * as crypto from "crypto"
import type { KiloClient, Session } from "@kilocode/sdk/v2/client"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"
import { validateCreateResult } from "../services/cli-backend/serve-private-peer"

export function buildCreateIdentity(): { opId: string; idempotencyKey: string; requestId: string } {
  const token = crypto.randomUUID()
  const opId = `create:${token}`
  const idempotencyKey = `create:${token}`
  const requestId = crypto.randomUUID()
  return { opId, idempotencyKey, requestId }
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
export async function createSessionPrivateFirst(opts: {
  client: KiloClient
  connection: KiloConnectionService
  directory: string
  platform?: string
  metadata?: Record<string, unknown>
  title?: string
  parentID?: string
  sandboxInheritanceToken?: string
}): Promise<Session> {
  const { client, connection, directory } = opts
  if (opts.sandboxInheritanceToken) {
    const res = (await client.session.create(
      {
        directory,
        platform: opts.platform,
        metadata: opts.metadata,
        sandboxInheritanceToken: opts.sandboxInheritanceToken,
        ...(opts.title ? { title: opts.title } : {}),
        ...(opts.parentID ? { parentID: opts.parentID } : {}),
      } as unknown as Record<string, unknown>,
      { throwOnError: false } as unknown as { throwOnError: false },
    )) as unknown as { data?: Session; error?: unknown }
    if (res.error) throw res.error
    if (!res.data) throw new Error("SDK create returned no data")
    return res.data
  }

  const { opId, idempotencyKey, requestId } = buildCreateIdentity()
  const ctx = { directory, parentSessionId: null as string | null }
  const payload: Record<string, unknown> = {}
  if (opts.title) payload.title = opts.title
  if (opts.parentID) payload.parentID = opts.parentID
  if (opts.platform) payload.platform = opts.platform
  if (opts.metadata) payload.metadata = opts.metadata
  const privateReq = {
    v: 1 as const,
    requestId,
    opId,
    op: "session/create" as const,
    idempotencyKey,
    context: ctx,
    payload,
  }

  let privateSucceeded = false
  let privateSession: Session | undefined

  try {
    if (!connection.isPrivateAvailable()) throw new Error("Private peer unavailable")
    const handleFactory = (connection as unknown as { privateCreateWithHandle?: (r: typeof privateReq) => { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean } }).privateCreateWithHandle?.bind(connection)
    const tryCancel = (connection as unknown as { tryCancelPrivatePending?: (id: number, msg?: string) => boolean }).tryCancelPrivatePending?.bind(connection) ?? null
    const invalidate = (connection as unknown as { invalidatePrivatePeerOnObserverTimeout?: (r: string) => void }).invalidatePrivatePeerOnObserverTimeout?.bind(connection) ?? null
    const peekNextId = (connection as unknown as { peekPrivatePeerNextId?: () => number | null }).peekPrivatePeerNextId?.bind(connection) ?? null

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
      promise = (connection as unknown as { privateCreate: (r: unknown) => Promise<unknown> }).privateCreate(privateReq as unknown as never)
    }

    let result: unknown
    try {
      result = await withTimeout(promise, 3000)
    } catch (e) {
      const msg = String(e)
      const isTimeout = msg.includes("private parity timeout")
      if (isTimeout) {
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
              invalidate(`create observer timeout opId=${opId}`)
            } catch {}
          }
        } else if (invalidate) {
          try {
            invalidate(`create observer timeout opId=${opId}`)
          } catch {}
        }
      }
      throw e
    }

    const typed = result as { status?: string; accepted?: boolean; data?: { session?: unknown }; outcome?: unknown }
    if (typed.status === "succeeded" && typed.accepted === true && typed.data?.session) {
      try {
        validateCreateResult(result as unknown, privateReq as unknown as never)
      } catch {
        throw new Error("invalid private result")
      }
      privateSucceeded = true
      privateSession = typed.data.session as Session
    } else {
      throw new Error(`private not succeeded: ${String(typed.status)}`)
    }
  } catch {
    // fallback to SDK exactly once with SAME tuple
  }

  if (privateSucceeded && privateSession) return privateSession

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
  }
  const res = (await client.session.create(sdkInput as unknown as never, { throwOnError: false } as unknown as never)) as unknown as { data?: Session; error?: unknown }
  if (res.error) throw res.error
  if (!res.data) throw new Error("SDK create returned no data")
  return res.data
}
