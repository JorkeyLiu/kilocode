import * as crypto from "crypto"
import {
  canonicalNotebookListOpId,
  canonicalNotebookOpId,
  validateNotebookListContractRequest,
  validateNotebookRejectContractRequest,
  validateNotebookReplyContractRequest,
  validateNotebookRejectResult,
  validateNotebookReplyResult,
  validateNotebookTerminalFailure,
} from "../services/cli-backend/serve-private-notebook-contract"
import type {
  NotebookListContractRequest,
  NotebookRejectContractRequest,
  NotebookReplyContractRequest,
} from "../services/cli-backend/serve-private-notebook-contract"
import {
  validateNotebookListEntries,
  validateNotebookListResult,
  type NotebookListEntry,
} from "../services/cli-backend/serve-private-notebook-list-contract"
import { notebookListHandle } from "../services/cli-backend/serve-private-notebook-connection"
import type { ServePrivatePeer } from "../services/cli-backend/serve-private-peer"
import type { KiloConnectionService } from "../services/cli-backend"
import type { NotebookFailure, NotebookResult } from "@kilocode/sdk/v2/client"

export type NotebookSettleOutcome = { kind: "settled"; stale: boolean } | { kind: "retry"; code?: string }

export type NotebookListPrivateOutcome = { kind: "ok"; items: NotebookListEntry[] } | { kind: "unknown" }

type Handle = { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean }

export function buildNotebookReplyIdentity(requestID: string): {
  opId: string
  idempotencyKey: string
  requestId: string
} {
  const token = crypto.randomUUID()
  const opId = canonicalNotebookOpId(requestID, token)
  return { opId, idempotencyKey: opId, requestId: crypto.randomUUID() }
}

export function buildNotebookRejectIdentity(requestID: string): {
  opId: string
  idempotencyKey: string
  requestId: string
} {
  const token = crypto.randomUUID()
  const opId = canonicalNotebookOpId(requestID, token)
  return { opId, idempotencyKey: opId, requestId: crypto.randomUUID() }
}

export function buildNotebookListIdentity(): { opId: string; idempotencyKey: string; requestId: string } {
  const token = crypto.randomUUID()
  const opId = canonicalNotebookListOpId(token)
  return { opId, idempotencyKey: opId, requestId: crypto.randomUUID() }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`private notebook timeout after ${ms}ms`)), ms)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

function buildReplyReq(directory: string, requestID: string, result: NotebookResult): NotebookReplyContractRequest {
  const ids = buildNotebookReplyIdentity(requestID)
  return {
    v: 1 as const,
    requestId: ids.requestId,
    opId: ids.opId,
    op: "notebook/reply" as const,
    idempotencyKey: ids.idempotencyKey,
    context: { directory, requestID },
    payload: { result },
  }
}

function buildRejectReq(directory: string, requestID: string, error: NotebookFailure): NotebookRejectContractRequest {
  const ids = buildNotebookRejectIdentity(requestID)
  return {
    v: 1 as const,
    requestId: ids.requestId,
    opId: ids.opId,
    op: "notebook/reject" as const,
    idempotencyKey: ids.idempotencyKey,
    context: { directory, requestID },
    payload: { error },
  }
}

function buildListReq(directory: string): NotebookListContractRequest {
  const ids = buildNotebookListIdentity()
  return {
    v: 1 as const,
    requestId: ids.requestId,
    opId: ids.opId,
    op: "notebook/list" as const,
    idempotencyKey: ids.idempotencyKey,
    context: { directory },
    payload: {},
  }
}

type Conn = Pick<KiloConnectionService, "isPrivateAvailable" | "getPrivatePeer" | "getPrivateEpoch"> & {
  invalidatePrivatePeerOnObserverTimeout?: (reason: string) => void
  privateNotebookWithHandle?: (req: NotebookReplyContractRequest | NotebookRejectContractRequest) => Handle
  privateNotebookReplyWithHandle?: (req: NotebookReplyContractRequest) => Handle
  privateNotebookRejectWithHandle?: (req: NotebookRejectContractRequest) => Handle
  privateNotebookListWithHandle?: (req: NotebookListContractRequest) => Handle
}

type SdkNotebookClient = {
  kilocode: {
    notebook: {
      reply: (args: {
        requestID: string
        directory: string
        result: NotebookResult
      }) => Promise<{ data?: unknown; error?: unknown }>
      reject: (args: {
        requestID: string
        directory: string
        error: NotebookFailure
      }) => Promise<{ data?: unknown; error?: unknown }>
      list: (args: { directory: string }) => Promise<{ data?: unknown; error?: unknown }>
    }
  }
}

function isNotFoundError(error: unknown): boolean {
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
  const obj = record(error)
  if (!obj) return false
  const cause = record(obj.cause)
  const body = record(cause?.body)
  return [obj, record(obj.data), cause, body, record(body?.data)].some(
    (value) => value?.name === "NotFoundError" || value?._tag === "NotFound" || value?.status === 404,
  )
}

function acquireReply(
  conn: Conn,
  req: NotebookReplyContractRequest,
): { ok: true; handle: Handle | null; promise: Promise<unknown> } | { ok: false; reason: string } {
  try {
    const generic = conn.privateNotebookWithHandle?.bind(conn) ?? null
    if (generic) {
      const got = generic(req)
      return { ok: true, handle: got, promise: got.promise }
    }
    const factory = conn.privateNotebookReplyWithHandle?.bind(conn) ?? null
    if (!factory) return { ok: false, reason: "missing-capability" }
    const got = factory(req)
    return { ok: true, handle: got, promise: got.promise }
  } catch (err) {
    return { ok: false, reason: String(err instanceof Error ? err.message : err).slice(0, 200) }
  }
}

function acquireReject(
  conn: Conn,
  req: NotebookRejectContractRequest,
): { ok: true; handle: Handle | null; promise: Promise<unknown> } | { ok: false; reason: string } {
  try {
    const generic = conn.privateNotebookWithHandle?.bind(conn) ?? null
    if (generic) {
      const got = generic(req)
      return { ok: true, handle: got, promise: got.promise }
    }
    const factory = conn.privateNotebookRejectWithHandle?.bind(conn) ?? null
    if (!factory) return { ok: false, reason: "missing-capability" }
    const got = factory(req)
    return { ok: true, handle: got, promise: got.promise }
  } catch (err) {
    return { ok: false, reason: String(err instanceof Error ? err.message : err).slice(0, 200) }
  }
}

function ownerDeps(
  conn: Conn,
): { peer: ServePrivatePeer | null; live: boolean; epoch: number | null; invalidate: (reason: string) => void } | null {
  const typed = conn as unknown as {
    getPrivatePeer?: () => ServePrivatePeer | null
    getPrivateEpoch?: () => number | null
    invalidatePrivatePeerOnObserverTimeout?: (reason: string) => void
  }
  if (typeof typed.getPrivatePeer !== "function" || typeof typed.getPrivateEpoch !== "function") return null
  const peer = typed.getPrivatePeer()
  const epoch = typed.getPrivateEpoch() ?? null
  const invalidate = (reason: string) => typed.invalidatePrivatePeerOnObserverTimeout?.(reason)
  return { peer, live: true, epoch, invalidate }
}

function acquireList(
  conn: Conn,
  req: NotebookListContractRequest,
): { ok: true; handle: Handle | null; promise: Promise<unknown> } | { ok: false; reason: string } {
  try {
    const direct = conn.privateNotebookListWithHandle?.bind(conn) ?? null
    if (direct) {
      const got = direct(req)
      return { ok: true, handle: got, promise: got.promise }
    }
    const deps = ownerDeps(conn)
    if (!deps || !deps.peer) return { ok: false, reason: "missing-capability" }
    const got = notebookListHandle(
      { peer: deps.peer, live: deps.live, epoch: deps.epoch, invalidate: deps.invalidate },
      req,
    )
    return { ok: true, handle: got, promise: got.promise }
  } catch (err) {
    return { ok: false, reason: String(err instanceof Error ? err.message : err).slice(0, 200) }
  }
}

async function attemptList(
  conn: Conn | null,
  req: NotebookListContractRequest,
  valid: boolean,
): Promise<NotebookListPrivateOutcome | { kind: "fallback"; reason: string }> {
  if (!valid) return { kind: "fallback", reason: "invalid" }
  if (!conn) return { kind: "fallback", reason: "unavailable" }
  try {
    if (!conn.isPrivateAvailable()) return { kind: "fallback", reason: "unavailable" }
  } catch {
    return { kind: "fallback", reason: "unavailable" }
  }
  const acq = acquireList(conn, req)
  if (!acq.ok) return { kind: "fallback", reason: "missing-capability" }
  try {
    return settleList(req, await withTimeout(acq.promise, 3000))
  } catch {
    expired(acq.handle, req.opId)
    return { kind: "fallback", reason: "timeout" }
  }
}

function expired(handle: Handle | null, opId: string): void {
  if (!handle?.cancel) return
  try {
    handle.cancel(`private notebook timeout opId=${opId}`)
  } catch {
    console.warn("[Kilo New] NotebookBridge: private timeout cancel failed:", { opId })
  }
}

type PrivateSettle =
  | { kind: "settled"; stale: boolean }
  | { kind: "terminal"; code: string }
  | { kind: "fallback"; reason: string }

function settleReply(req: NotebookReplyContractRequest, result: unknown): PrivateSettle {
  const kind = (result as { kind?: unknown }).kind
  if (kind === "ambiguous") return { kind: "fallback", reason: "ambiguous" }
  if (kind === "terminal") {
    try {
      validateNotebookReplyResult(result, req)
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
    return { kind: "settled", stale: false }
  }
  if (kind === "terminal-failure") {
    try {
      const out = validateNotebookTerminalFailure(result, req)
      const code = out.failure.code
      if (code === "notebook.not_found") return { kind: "settled", stale: true }
      if (code === "notebook.invalid_reply" || code === "scope_mismatch") return { kind: "terminal", code }
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
    return { kind: "fallback", reason: "failure" }
  }
  return { kind: "fallback", reason: "invalid" }
}

function settleReject(req: NotebookRejectContractRequest, result: unknown): PrivateSettle {
  const kind = (result as { kind?: unknown }).kind
  if (kind === "ambiguous") return { kind: "fallback", reason: "ambiguous" }
  if (kind === "terminal") {
    try {
      validateNotebookRejectResult(result, req)
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
    return { kind: "settled", stale: false }
  }
  if (kind === "terminal-failure") {
    try {
      const out = validateNotebookTerminalFailure(result, req)
      const code = out.failure.code
      if (code === "notebook.not_found") return { kind: "settled", stale: true }
      if (code === "notebook.invalid_reply" || code === "scope_mismatch") return { kind: "terminal", code }
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
    return { kind: "fallback", reason: "failure" }
  }
  return { kind: "fallback", reason: "invalid" }
}

async function attemptReply(conn: Conn | null, req: NotebookReplyContractRequest): Promise<PrivateSettle> {
  if (!conn) return { kind: "fallback", reason: "unavailable" }
  try {
    if (!conn.isPrivateAvailable()) return { kind: "fallback", reason: "unavailable" }
  } catch {
    return { kind: "fallback", reason: "unavailable" }
  }
  const acq = acquireReply(conn, req)
  if (!acq.ok) return { kind: "fallback", reason: "missing-capability" }
  let result: unknown
  try {
    result = await withTimeout(acq.promise, 3000)
  } catch {
    expired(acq.handle, req.opId)
    return { kind: "fallback", reason: "timeout" }
  }
  return settleReply(req, result)
}

async function attemptReject(conn: Conn | null, req: NotebookRejectContractRequest): Promise<PrivateSettle> {
  if (!conn) return { kind: "fallback", reason: "unavailable" }
  try {
    if (!conn.isPrivateAvailable()) return { kind: "fallback", reason: "unavailable" }
  } catch {
    return { kind: "fallback", reason: "unavailable" }
  }
  const acq = acquireReject(conn, req)
  if (!acq.ok) return { kind: "fallback", reason: "missing-capability" }
  let result: unknown
  try {
    result = await withTimeout(acq.promise, 3000)
  } catch {
    expired(acq.handle, req.opId)
    return { kind: "fallback", reason: "timeout" }
  }
  return settleReject(req, result)
}

function fallbackReqId(requestID: string): NotebookReplyContractRequest {
  const token = crypto.randomUUID()
  return {
    v: 1 as const,
    requestId: crypto.randomUUID(),
    opId: `notebook:${requestID}:${token}`,
    op: "notebook/reply" as const,
    idempotencyKey: `notebook:${requestID}:${token}`,
    context: { directory: "", requestID },
    payload: { result: { operation: "read", requestPath: "unknown", path: "unknown", revision: "unknown", cells: [] } },
  }
}

// Private-first notebook reply: one private attempt plus at most one
// same-directory/request SDK `kilocode.notebook.reply` fallback, never a
// private retry. Valid private success closes with zero SDK;
// `notebook.not_found` returns stale accepted success; `notebook.
// invalid_reply`/scope mismatch closes with zero SDK as a retryable
// failure (pending stays intact server-side); SDK 404 also returns stale
// accepted success. Logs use fixed categories with opaque op IDs only.
export async function replyNotebookPrivateFirst(opts: {
  connection?: Conn | null
  client: SdkNotebookClient | null | undefined
  directory: string
  requestID: string
  result: NotebookResult
}): Promise<{ outcome: NotebookSettleOutcome; req: NotebookReplyContractRequest }> {
  let req: NotebookReplyContractRequest
  let attempt: PrivateSettle
  try {
    req = buildReplyReq(opts.directory, opts.requestID, opts.result)
    validateNotebookReplyContractRequest(req)
    attempt = await attemptReply(opts.connection ?? null, req)
  } catch {
    req = fallbackReqId(opts.requestID)
    attempt = { kind: "fallback", reason: "invalid" }
  }
  if (attempt.kind === "settled") return { outcome: { kind: "settled", stale: attempt.stale }, req }
  if (attempt.kind === "terminal") {
    console.warn("[Kilo New] NotebookBridge: notebook reply private terminal:", { code: attempt.code, opId: req.opId })
    return { outcome: { kind: "retry", code: attempt.code }, req }
  }
  if (attempt.reason !== "unavailable") {
    console.warn("[Kilo New] NotebookBridge: notebook reply private fallback:", {
      reason: attempt.reason,
      opId: req.opId,
    })
  }
  const fn = opts.client?.kilocode?.notebook?.reply
  if (typeof fn !== "function") return { outcome: { kind: "retry" }, req }
  try {
    const response = await fn.call(opts.client?.kilocode?.notebook, {
      requestID: opts.requestID,
      directory: opts.directory,
      result: opts.result,
    })
    if (!response.error) return { outcome: { kind: "settled", stale: false }, req }
    if (isNotFoundError(response.error)) return { outcome: { kind: "settled", stale: true }, req }
    console.warn("[Kilo New] NotebookBridge: notebook reply fallback failed:", { opId: req.opId })
    return { outcome: { kind: "retry" }, req }
  } catch {
    console.warn("[Kilo New] NotebookBridge: notebook reply fallback failed:", { opId: req.opId })
    return { outcome: { kind: "retry" }, req }
  }
}

// Private-first notebook reject: same exactly-one-fallback shape as reply.
export async function rejectNotebookPrivateFirst(opts: {
  connection?: Conn | null
  client: SdkNotebookClient | null | undefined
  directory: string
  requestID: string
  error: NotebookFailure
}): Promise<{ outcome: NotebookSettleOutcome; req: NotebookRejectContractRequest }> {
  let req: NotebookRejectContractRequest
  let attempt: PrivateSettle
  try {
    req = buildRejectReq(opts.directory, opts.requestID, opts.error)
    validateNotebookRejectContractRequest(req)
    attempt = await attemptReject(opts.connection ?? null, req)
  } catch {
    const token = crypto.randomUUID()
    req = {
      v: 1 as const,
      requestId: crypto.randomUUID(),
      opId: `notebook:${opts.requestID}:${token}`,
      op: "notebook/reject" as const,
      idempotencyKey: `notebook:${opts.requestID}:${token}`,
      context: { directory: opts.directory, requestID: opts.requestID },
      payload: { error: opts.error },
    }
    attempt = { kind: "fallback", reason: "invalid" }
  }
  if (attempt.kind === "settled") return { outcome: { kind: "settled", stale: attempt.stale }, req }
  if (attempt.kind === "terminal") {
    console.warn("[Kilo New] NotebookBridge: notebook reject private terminal:", { code: attempt.code, opId: req.opId })
    return { outcome: { kind: "retry", code: attempt.code }, req }
  }
  if (attempt.reason !== "unavailable") {
    console.warn("[Kilo New] NotebookBridge: notebook reject private fallback:", {
      reason: attempt.reason,
      opId: req.opId,
    })
  }
  const fn = opts.client?.kilocode?.notebook?.reject
  if (typeof fn !== "function") return { outcome: { kind: "retry" }, req }
  try {
    const response = await fn.call(opts.client?.kilocode?.notebook, {
      requestID: opts.requestID,
      directory: opts.directory,
      error: opts.error,
    })
    if (!response.error) return { outcome: { kind: "settled", stale: false }, req }
    if (isNotFoundError(response.error)) return { outcome: { kind: "settled", stale: true }, req }
    console.warn("[Kilo New] NotebookBridge: notebook reject fallback failed:", { opId: req.opId })
    return { outcome: { kind: "retry" }, req }
  } catch {
    console.warn("[Kilo New] NotebookBridge: notebook reject fallback failed:", { opId: req.opId })
    return { outcome: { kind: "retry" }, req }
  }
}

function settleList(
  req: NotebookListContractRequest,
  result: unknown,
): NotebookListPrivateOutcome | { kind: "fallback"; reason: string } {
  const rec = result as { kind?: unknown; status?: unknown } | null
  if (!rec || typeof rec !== "object") return { kind: "fallback", reason: "invalid" }
  if (rec.kind === "invalid") return { kind: "fallback", reason: "invalid" }
  const wire = rec as { kind?: string; result?: unknown }
  const inner = wire.kind === "valid" ? wire.result : result
  const typed = inner as { status?: unknown }
  if (typed.status === "ambiguous") return { kind: "fallback", reason: "ambiguous" }
  if (typed.status === "succeeded") {
    try {
      const out = validateNotebookListResult(inner, req)
      if (out.status !== "succeeded" || out.accepted !== true) return { kind: "fallback", reason: "invalid" }
      return { kind: "ok", items: validateNotebookListEntries(out.data.notebooks) }
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
  }
  if (typed.status === "failed") {
    try {
      const out = validateNotebookListResult(inner, req)
      if (out.status !== "failed") return { kind: "fallback", reason: "invalid" }
      if (out.failure.retryable === true) return { kind: "fallback", reason: out.failure.code }
      return { kind: "unknown" }
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
  }
  return { kind: "fallback", reason: "invalid" }
}

// Private-first notebook list: one private attempt plus at most one
// same-directory SDK `kilocode.notebook.list` fallback, never a private
// retry. Read-only; an ambiguous or failed-retryable private outcome falls
// back once, a terminal list failure closes as unknown.
export async function listNotebooksPrivateFirst(opts: {
  connection?: Conn | null
  client: SdkNotebookClient | null | undefined
  directory: string
}): Promise<{ outcome: NotebookListPrivateOutcome; req: NotebookListContractRequest }> {
  let req: NotebookListContractRequest
  let valid = true
  try {
    req = buildListReq(opts.directory)
    validateNotebookListContractRequest(req)
  } catch {
    const token = crypto.randomUUID()
    req = {
      v: 1 as const,
      requestId: crypto.randomUUID(),
      opId: `notebook-list:${token}`,
      op: "notebook/list" as const,
      idempotencyKey: `notebook-list:${token}`,
      context: { directory: opts.directory },
      payload: {},
    }
    valid = false
  }
  const conn = opts.connection ?? null
  const privateOutcome = await attemptList(conn, req, valid)
  if (privateOutcome.kind === "ok") return { outcome: privateOutcome, req }
  if (privateOutcome.kind === "unknown") return { outcome: privateOutcome, req }
  const reason = (privateOutcome as { reason: string }).reason
  if (reason !== "unavailable") {
    console.warn("[Kilo New] NotebookBridge: notebook list private fallback:", { reason, opId: req.opId })
  }
  const fn = opts.client?.kilocode?.notebook?.list
  if (typeof fn !== "function") return { outcome: { kind: "unknown" }, req }
  try {
    const response = await fn.call(opts.client?.kilocode?.notebook, { directory: opts.directory })
    if (response.error) return { outcome: { kind: "unknown" }, req }
    // The SDK fallback preserves the bridge's existing lenient mapping: the
    // backend already schema-validates pending requests server-side, so items
    // pass through as received. Strict entry validation applies to the
    // private path above only.
    const items = (Array.isArray(response.data) ? response.data : []) as NotebookListEntry[]
    return { outcome: { kind: "ok", items }, req }
  } catch {
    return { outcome: { kind: "unknown" }, req }
  }
}
