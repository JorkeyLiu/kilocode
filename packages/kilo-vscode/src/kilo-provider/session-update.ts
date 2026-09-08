import type { KiloClient, Session } from "@kilocode/sdk/v2/client"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"
import { validateSessionUpdateResult } from "../services/cli-backend/serve-private-peer"
import { buildSessionUpdateIdentity } from "./rename-session"
import { parseSessionTitle } from "../shared/session-title"
import { sdkSessionToDetail } from "./session-detail"

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

// eslint-disable-next-line complexity
export async function renameSessionPrivateFirst(opts: {
  client: KiloClient
  connection: KiloConnectionService
  sessionID: string
  title: unknown
  directory: string
}): Promise<Session> {
  const parsed = parseSessionTitle(opts.title)
  if ("error" in parsed) throw new Error("Invalid session title")
  const { client, connection, sessionID, directory } = opts
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

  let failed = false
  let reason = ""

  if (connection.isPrivateAvailable()) {
    try {
      const handleFactory = (
        connection as unknown as {
          privateSessionUpdateWithHandle?: (r: typeof privateReq) => {
            id: number
            promise: Promise<unknown>
            cancel?: (msg?: string) => boolean
          }
        }
      ).privateSessionUpdateWithHandle?.bind(connection)
      const tryCancel =
        (
          connection as unknown as { tryCancelPrivatePending?: (id: number, msg?: string) => boolean }
        ).tryCancelPrivatePending?.bind(connection) ?? null
      const invalidate =
        (
          connection as unknown as { invalidatePrivatePeerOnObserverTimeout?: (r: string) => void }
        ).invalidatePrivatePeerOnObserverTimeout?.bind(connection) ?? null
      const peekNextId =
        (connection as unknown as { peekPrivatePeerNextId?: () => number | null }).peekPrivatePeerNextId?.bind(
          connection,
        ) ?? null

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
        promise = (
          connection as unknown as { privateSessionUpdate: (r: unknown) => Promise<unknown> }
        ).privateSessionUpdate(privateReq as unknown as never)
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
                invalidate(`session/update observer timeout opId=${opId}`)
              } catch {}
            }
          } else if (invalidate) {
            try {
              invalidate(`session/update observer timeout opId=${opId}`)
            } catch {}
          }
        }
        throw e
      }

      const typed = result as { status?: string; accepted?: boolean; transportUnknown?: unknown }
      if (typed.status === "succeeded" && typed.accepted === true) {
        // Contradictory transport metadata on success is never authoritative.
        if (typed.transportUnknown === true) throw new Error("invalid private result")
        try {
          validateSessionUpdateResult(result as unknown, privateReq as unknown as never)
        } catch {
          throw new Error("invalid private result")
        }
        const sess = resolveSession(result)
        if (!sess) throw new Error("invalid private result")
        if (sess.id !== sessionID) throw new Error("invalid private result")
        const returned = parseSessionTitle(sess.title)
        if ("error" in returned || returned.value !== value) throw new Error("invalid private result")
        const rawData = (result as { data?: Record<string, unknown> }).data
        const topTitle = rawData?.title
        if (topTitle !== undefined) {
          const topParsed = parseSessionTitle(topTitle)
          if ("error" in topParsed || topParsed.value !== value) throw new Error("invalid private result")
        }
        // Complete canonical Session.Info required before accepting; incomplete shapes fall back.
        if (!isCanonicalSession(sess)) throw new Error("invalid private result")
        try {
          sdkSessionToDetail(sess)
        } catch {
          throw new Error("invalid private result")
        }
        return sess
      }
      failed = true
      reason = `private not succeeded: ${String(typed.status)}`
    } catch (e) {
      failed = true
      const msg = e instanceof Error ? e.message : String(e)
      reason = msg.includes("private parity timeout") ? "private timeout" : msg.slice(0, 120)
    }
    if (failed) console.warn("[Kilo PrivateRename] private fallback", { opId, reason: reason.slice(0, 120) })
  }

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
  return res.data
}
