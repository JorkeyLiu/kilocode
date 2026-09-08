import * as crypto from "crypto"
import type { KiloConnectionService } from "../services/cli-backend"
import type { KiloClient } from "@kilocode/sdk/v2/client"
import { validateDeleteResult } from "../services/cli-backend/serve-private-peer"

export function buildDeleteIdentity(sessionId: string): { opId: string; idempotencyKey: string; requestId: string } {
  const token = crypto.randomUUID()
  const opId = `delete:${sessionId}:${token}`
  const idempotencyKey = `delete:${sessionId}:${token}`
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

function deleteTerminal(code: string, message: string): Error {
  const err = new Error(message) as Error & { code: string; terminal: boolean }
  err.code = code
  err.terminal = true
  return err
}

type PrivateAttempt = { kind: "succeeded" } | { kind: "terminal"; code: string; message: string } | { kind: "retryable"; code: string } | { kind: "unavailable" } | { kind: "unknown"; detail: string }

type PrivateReq = {
  v: 1
  requestId: string
  opId: string
  op: "session/delete"
  idempotencyKey: string
  context: { directory: string; sessionId: string; parentSessionId: string | null }
  payload: Record<string, never>
}

function handles(conn: KiloConnectionService) {
  const handleFactory = (
    conn as unknown as {
      privateDeleteWithHandle?: (r: PrivateReq) => { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean }
    }
  ).privateDeleteWithHandle?.bind(conn) ?? null
  const tryCancel = (
    conn as unknown as { tryCancelPrivatePending?: (id: number, msg?: string) => boolean }
  ).tryCancelPrivatePending?.bind(conn) ?? null
  const invalidate = (
    conn as unknown as { invalidatePrivatePeerOnObserverTimeout?: (r: string) => void }
  ).invalidatePrivatePeerOnObserverTimeout?.bind(conn) ?? null
  const peekNextId = (
    conn as unknown as { peekPrivatePeerNextId?: () => number | null }
  ).peekPrivatePeerNextId?.bind(conn) ?? null
  return { handleFactory, tryCancel, invalidate, peekNextId }
}

function unavailable(msg: string): boolean {
  return msg.includes("Private peer missing") || msg.includes("Private peer unavailable") || msg.includes("capability")
}

function closed(msg: string): boolean {
  return msg.includes("Peer closed") || msg.includes("Peer disposed") || msg.includes("-32603")
}

function acquire(conn: KiloConnectionService, req: PrivateReq, h: ReturnType<typeof handles>) {
  let handle: { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean } | null = null
  let exact: number | null = null
  let promise: Promise<unknown>
  if (h.handleFactory) {
    const got = h.handleFactory(req as unknown as never)
    handle = got
    exact = got.id
    promise = got.promise
  } else {
    exact = h.peekNextId ? h.peekNextId() : null
    promise = (conn as unknown as { privateDelete: (r: unknown) => Promise<unknown> }).privateDelete(req as unknown as never)
  }
  return { handle, exact, promise }
}

function classifySyncErr(err: unknown): PrivateAttempt {
  const msg = err instanceof Error ? err.message : String(err)
  if (unavailable(msg)) return { kind: "unavailable" }
  if (closed(msg)) return { kind: "unknown", detail: msg.slice(0, 200) }
  return { kind: "unknown", detail: msg.slice(0, 200) }
}

function cleanupTimeout(
  handle: { cancel?: (msg?: string) => boolean } | null,
  exact: number | null,
  h: ReturnType<typeof handles>,
  opId: string,
) {
  if (handle?.cancel) {
    try {
      handle.cancel(`private parity timeout opId=${opId}`)
    } catch {}
    return
  }
  if (exact !== null && h.tryCancel) {
    let cleaned = false
    try {
      cleaned = h.tryCancel(exact, `private parity timeout opId=${opId}`)
    } catch {}
    if (!cleaned && h.invalidate) {
      try {
        h.invalidate(`delete observer timeout opId=${opId}`)
      } catch {}
    }
    return
  }
  if (h.invalidate) {
    try {
      h.invalidate(`delete observer timeout opId=${opId}`)
    } catch {}
  }
}

function classifyAwaitErr(err: unknown, req: PrivateReq, h: ReturnType<typeof handles>, handle: { cancel?: (msg?: string) => boolean } | null, exact: number | null): PrivateAttempt {
  const raw = String(err)
  if (raw.includes("private parity timeout")) {
    cleanupTimeout(handle, exact, h, req.opId)
    return { kind: "unknown", detail: "private parity timeout" }
  }
  const msg = err instanceof Error ? err.message : raw
  if (closed(msg)) return { kind: "unknown", detail: msg.slice(0, 200) }
  if (msg.includes("Private peer missing") || msg.includes("capability")) return { kind: "unavailable" }
  return { kind: "unknown", detail: msg.slice(0, 200) }
}

function succeededBranch(result: unknown, req: PrivateReq): PrivateAttempt {
  try {
    validateDeleteResult(result as unknown, req as unknown as never)
  } catch (err) {
    return { kind: "unknown", detail: String(err).slice(0, 200) }
  }
  return { kind: "succeeded" }
}

function failedBranch(result: unknown, req: PrivateReq): PrivateAttempt {
  try {
    validateDeleteResult(result as unknown, req as unknown as never)
  } catch (err) {
    return { kind: "unknown", detail: String(err).slice(0, 200) }
  }
  const failure = (result as { failure?: { code?: unknown; message?: unknown; retryable?: unknown } }).failure
  if (failure?.retryable === true) {
    const code = typeof failure?.code === "string" && failure.code ? failure.code : "failed"
    return { kind: "retryable", code }
  }
  if (failure?.retryable === false) {
    const code = typeof failure?.code === "string" && failure.code ? failure.code : "failed"
    const message = typeof failure?.message === "string" && failure.message ? failure.message : code
    return { kind: "terminal", code, message }
  }
  return { kind: "unknown", detail: "failed without retryable" }
}

function parseResult(result: unknown, req: PrivateReq): PrivateAttempt {
  const typed = result as { status?: string; accepted?: boolean; transportUnknown?: unknown }
  if (typed.transportUnknown === true) return { kind: "unknown", detail: "transportUnknown" }
  if (typed.status === "succeeded" && typed.accepted === true) return succeededBranch(result, req)
  if (typed.status === "failed") return failedBranch(result, req)
  if (typed.status === "ambiguous") return { kind: "unknown", detail: "ambiguous" }
  return { kind: "unknown", detail: `private not succeeded: ${String(typed.status)}` }
}

async function attemptPrivateDelete(connection: KiloConnectionService, privateReq: PrivateReq): Promise<PrivateAttempt> {
  const h = handles(connection)
  let handle: { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean } | null = null
  let exact: number | null = null
  let promise: Promise<unknown>
  try {
    const got = acquire(connection, privateReq, h)
    handle = got.handle
    exact = got.exact
    promise = got.promise
  } catch (e) {
    return classifySyncErr(e)
  }
  let result: unknown
  try {
    result = await withTimeout(promise, 3000)
  } catch (e) {
    return classifyAwaitErr(e, privateReq, h, handle, exact)
  }
  return parseResult(result, privateReq)
}

async function durableRawDelete(opts: {
  connection: KiloConnectionService
  sessionId: string
  directory: string
  opId: string
  idempotencyKey: string
  requestId: string
}): Promise<void> {
  const { connection, sessionId, directory, opId, idempotencyKey, requestId } = opts
  const cfg = (connection as unknown as { getServerConfig?: () => { baseUrl: string; password: string } | null }).getServerConfig?.() ?? null
  if (cfg && cfg.baseUrl && cfg.password) {
    const url = `${cfg.baseUrl}/session/${encodeURIComponent(sessionId)}?directory=${encodeURIComponent(directory)}`
    const auth = `Basic ${Buffer.from(`kilo:${cfg.password}`).toString("base64")}`
    const body = JSON.stringify({ directory, opId, idempotencyKey, requestId, context: { directory, sessionId, parentSessionId: null } })
    const res = await fetch(url, { method: "DELETE", headers: { Authorization: auth, "Content-Type": "application/json" }, body })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      const err = new Error(`durable delete failed ${res.status}: ${text.slice(0, 200)}`) as Error & { code?: string }
      ;(err as unknown as { code?: string }).code = String(res.status)
      throw err
    }
    let data: unknown
    try {
      const text = await res.text()
      if (text.trim() === "") throw new Error("durable delete returned empty body")
      data = JSON.parse(text) as unknown
    } catch (e) {
      if (e instanceof Error && e.message.includes("durable delete")) throw e
      throw new Error(`durable delete returned malformed body: ${String(e).slice(0, 200)}`)
    }
    if (data !== true) throw new Error(`durable delete returned non-true: ${String(data).slice(0, 200)}`)
    return
  }
  const client = (opts as unknown as { client?: KiloClient }).client as KiloClient | undefined
  if (client) {
    const res = (await client.session.delete(
      {
        sessionID: sessionId,
        query_directory: directory,
        body_directory: directory,
        opId,
        idempotencyKey,
        requestId,
        context: { directory, sessionId, parentSessionId: null },
      },
      { throwOnError: false } as unknown as Parameters<KiloClient["session"]["delete"]>[1],
    )) as unknown as { data?: unknown; error?: unknown }
    if (res.error) throw res.error
    if ((res as { data?: unknown }).data !== true) throw new Error(`durable delete returned non-true: ${String((res as { data?: unknown }).data).slice(0, 200)}`)
    return
  }
  throw new Error("no durable delete transport available")
}

async function fallbackDurable(
  connection: KiloConnectionService,
  client: KiloClient,
  sessionId: string,
  directory: string,
  opId: string,
  idempotencyKey: string,
  requestId: string,
): Promise<void> {
  await durableRawDelete({ connection, sessionId, directory, opId, idempotencyKey, requestId, client } as unknown as never)
}

export async function deleteSessionPrivateFirst(opts: {
  client: KiloClient
  connection: KiloConnectionService
  sessionId: string
  directory: string
}): Promise<void> {
  const { client, connection, sessionId, directory } = opts
  const { opId, idempotencyKey, requestId } = buildDeleteIdentity(sessionId)
  const privateReq: PrivateReq = {
    v: 1 as const,
    requestId,
    opId,
    op: "session/delete" as const,
    idempotencyKey,
    context: { directory, sessionId, parentSessionId: null as string | null },
    payload: {} as Record<string, never>,
  }

  if (!connection.isPrivateAvailable()) {
    await fallbackDurable(connection, client, sessionId, directory, opId, idempotencyKey, requestId)
    return
  }

  const first = await attemptPrivateDelete(connection, privateReq)
  if (first.kind === "succeeded") return
  if (first.kind === "terminal") throw deleteTerminal(first.code, first.message)
  if (first.kind === "retryable" || first.kind === "unavailable") {
    console.warn("[Kilo Delete] private fallback to durable", { opId, reason: first.kind })
    await fallbackDurable(connection, client, sessionId, directory, opId, idempotencyKey, requestId)
    return
  }
  const firstDetail = (first as { kind: "unknown"; detail: string }).detail
  console.warn("[Kilo Delete] private unknown, reconciling", { opId, detail: firstDetail.slice(0, 120) })
  if (!connection.isPrivateAvailable()) throw deleteTerminal("unknown", `private delete result unknown after reconcile unavailable: ${firstDetail.slice(0, 120)}`)
  const second = await attemptPrivateDelete(connection, privateReq)
  if (second.kind === "succeeded") return
  if (second.kind === "terminal") throw deleteTerminal(second.code, second.message)
  if (second.kind === "retryable" || second.kind === "unavailable") {
    console.warn("[Kilo Delete] reconcile retryable fallback", { opId, reason: second.kind })
    await fallbackDurable(connection, client, sessionId, directory, opId, idempotencyKey, requestId)
    return
  }
  const secondDetail = (second as { kind: "unknown"; detail: string }).detail
  throw deleteTerminal("unknown", `private delete result unknown after reconcile: ${secondDetail.slice(0, 120)}`)
}
