import * as crypto from "crypto"
import {
  canonicalSuggestionOpId,
  validateSuggestionAcceptContractRequest,
  validateSuggestionAcceptResult,
  validateSuggestionDismissContractRequest,
  validateSuggestionDismissResult,
  validateSuggestionTerminalFailure,
} from "../services/cli-backend/serve-private-suggestion-contract"
import type {
  SuggestionAcceptContractRequest,
  SuggestionDismissContractRequest,
} from "../services/cli-backend/serve-private-suggestion-contract"
import { suggestionAcceptHandle, suggestionDismissHandle } from "../services/cli-backend/serve-private-suggestion-connection"
import {
  canonicalSuggestionListOpId,
  validateSuggestionListContractRequest,
  validateSuggestionListResult,
} from "../services/cli-backend/serve-private-suggestion-list-contract"
import type { SuggestionListContractRequest, SuggestionListEntry } from "../services/cli-backend/serve-private-suggestion-list-contract"
import { suggestionListHandle } from "../services/cli-backend/serve-private-suggestion-list-connection"
import type { ServePrivatePeer } from "../services/cli-backend/serve-private-peer"
import type { KiloConnectionService } from "../services/cli-backend"

export type SuggestionPrivateOutcome =
  | { kind: "terminal" }
  | { kind: "terminal-failure"; code: "suggestion.not_found" | "scope_mismatch" }
  | { kind: "fallback"; reason: string }

export type SuggestionListPrivateOutcome =
  | { kind: "ok"; items: SuggestionListEntry[] }
  | { kind: "unknown" }
  | { kind: "fallback"; reason: string }

type Handle = { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean }

export function buildSuggestionAcceptIdentity(requestID: string): {
  opId: string
  idempotencyKey: string
  requestId: string
} {
  const token = crypto.randomUUID()
  const opId = canonicalSuggestionOpId(requestID, token)
  return { opId, idempotencyKey: opId, requestId: crypto.randomUUID() }
}

export function buildSuggestionDismissIdentity(requestID: string): {
  opId: string
  idempotencyKey: string
  requestId: string
} {
  const token = crypto.randomUUID()
  const opId = canonicalSuggestionOpId(requestID, token)
  return { opId, idempotencyKey: opId, requestId: crypto.randomUUID() }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`private suggestion timeout after ${ms}ms`)), ms)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

function buildAcceptReq(directory: string, requestID: string, index: number): SuggestionAcceptContractRequest {
  const ids = buildSuggestionAcceptIdentity(requestID)
  return {
    v: 1 as const,
    requestId: ids.requestId,
    opId: ids.opId,
    op: "suggestion/accept" as const,
    idempotencyKey: ids.idempotencyKey,
    context: { directory, requestID },
    payload: { index },
  }
}

function buildDismissReq(directory: string, requestID: string): SuggestionDismissContractRequest {
  const ids = buildSuggestionDismissIdentity(requestID)
  return {
    v: 1 as const,
    requestId: ids.requestId,
    opId: ids.opId,
    op: "suggestion/dismiss" as const,
    idempotencyKey: ids.idempotencyKey,
    context: { directory, requestID },
    payload: {},
  }
}

function validAccept(req: SuggestionAcceptContractRequest): boolean {
  try {
    validateSuggestionAcceptContractRequest(req)
    return true
  } catch {
    return false
  }
}

function validDismiss(req: SuggestionDismissContractRequest): boolean {
  try {
    validateSuggestionDismissContractRequest(req)
    return true
  } catch {
    return false
  }
}

type Conn = Pick<KiloConnectionService, "isPrivateAvailable" | "getPrivatePeer" | "getPrivateEpoch"> & {
  invalidatePrivatePeerOnObserverTimeout?: (reason: string) => void
  privateSuggestionWithHandle?: (
    req: SuggestionAcceptContractRequest | SuggestionDismissContractRequest,
  ) => Handle
  privateSuggestionAcceptWithHandle?: (req: SuggestionAcceptContractRequest) => Handle
  privateSuggestionDismissWithHandle?: (req: SuggestionDismissContractRequest) => Handle
  privateSuggestionListOutcomeWithHandle?: (req: SuggestionListContractRequest) => Handle
  privateSuggestionListWithHandle?: (req: SuggestionListContractRequest) => Handle
}

function ownerDeps(conn: Conn): {
  peer: ServePrivatePeer | null
  live: boolean
  epoch: number | null
  invalidate: (reason: string) => void
} | null {
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

function acquireAccept(
  conn: Conn,
  req: SuggestionAcceptContractRequest,
): { ok: true; handle: Handle | null; promise: Promise<unknown> } | { ok: false; reason: string } {
  try {
    const generic = conn.privateSuggestionWithHandle?.bind(conn) ?? null
    if (generic) {
      const got = generic(req)
      return { ok: true, handle: got, promise: got.promise }
    }
    const factory = conn.privateSuggestionAcceptWithHandle?.bind(conn) ?? null
    if (factory) {
      const got = factory(req)
      return { ok: true, handle: got, promise: got.promise }
    }
    const deps = ownerDeps(conn)
    if (!deps || !deps.peer) return { ok: false, reason: "missing-capability" }
    const got = suggestionAcceptHandle(
      { peer: deps.peer, live: deps.live, epoch: deps.epoch, invalidate: deps.invalidate },
      req,
    )
    return { ok: true, handle: got, promise: got.promise }
  } catch (err) {
    return { ok: false, reason: String(err instanceof Error ? err.message : err).slice(0, 200) }
  }
}

function acquireDismiss(
  conn: Conn,
  req: SuggestionDismissContractRequest,
): { ok: true; handle: Handle | null; promise: Promise<unknown> } | { ok: false; reason: string } {
  try {
    const generic = conn.privateSuggestionWithHandle?.bind(conn) ?? null
    if (generic) {
      const got = generic(req)
      return { ok: true, handle: got, promise: got.promise }
    }
    const factory = conn.privateSuggestionDismissWithHandle?.bind(conn) ?? null
    if (factory) {
      const got = factory(req)
      return { ok: true, handle: got, promise: got.promise }
    }
    const deps = ownerDeps(conn)
    if (!deps || !deps.peer) return { ok: false, reason: "missing-capability" }
    const got = suggestionDismissHandle(
      { peer: deps.peer, live: deps.live, epoch: deps.epoch, invalidate: deps.invalidate },
      req,
    )
    return { ok: true, handle: got, promise: got.promise }
  } catch (err) {
    return { ok: false, reason: String(err instanceof Error ? err.message : err).slice(0, 200) }
  }
}

function expired(handle: Handle | null, opId: string): void {
  if (!handle?.cancel) return
  try {
    handle.cancel(`private suggestion timeout opId=${opId}`)
  } catch (err) {
    console.warn("[Kilo Suggestion] private timeout cancel failed:", String(err).slice(0, 200), { opId })
  }
}

function settleAccept(req: SuggestionAcceptContractRequest, result: unknown): SuggestionPrivateOutcome {
  const kind = (result as { kind?: unknown }).kind
  if (kind === "ambiguous") return { kind: "fallback", reason: "ambiguous" }
  if (kind === "terminal") {
    try {
      validateSuggestionAcceptResult(result, req)
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
    return { kind: "terminal" }
  }
  if (kind === "terminal-failure") {
    try {
      const out = validateSuggestionTerminalFailure(result, req)
      const code = out.failure.code
      if (code === "suggestion.not_found" || code === "scope_mismatch")
        return { kind: "terminal-failure", code }
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
    return { kind: "fallback", reason: "failure" }
  }
  return { kind: "fallback", reason: "invalid" }
}

function settleDismiss(req: SuggestionDismissContractRequest, result: unknown): SuggestionPrivateOutcome {
  const kind = (result as { kind?: unknown }).kind
  if (kind === "ambiguous") return { kind: "fallback", reason: "ambiguous" }
  if (kind === "terminal") {
    try {
      validateSuggestionDismissResult(result, req)
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
    return { kind: "terminal" }
  }
  if (kind === "terminal-failure") {
    try {
      const out = validateSuggestionTerminalFailure(result, req)
      const code = out.failure.code
      if (code === "suggestion.not_found" || code === "scope_mismatch")
        return { kind: "terminal-failure", code }
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
    return { kind: "fallback", reason: "failure" }
  }
  return { kind: "fallback", reason: "invalid" }
}

export async function acceptSuggestionPrivateFirst(opts: {
  connection?: Conn | null
  directory: string
  requestID: string
  index: number
}): Promise<{ outcome: SuggestionPrivateOutcome; req: SuggestionAcceptContractRequest }> {
  let req: SuggestionAcceptContractRequest
  try {
    req = buildAcceptReq(opts.directory, opts.requestID, opts.index)
  } catch {
    const token = crypto.randomUUID()
    const fallback: SuggestionAcceptContractRequest = {
      v: 1 as const,
      requestId: crypto.randomUUID(),
      opId: `suggestion:${opts.requestID}:${token}`,
      op: "suggestion/accept" as const,
      idempotencyKey: `suggestion:${opts.requestID}:${token}`,
      context: { directory: opts.directory, requestID: opts.requestID },
      payload: { index: opts.index },
    }
    return { outcome: { kind: "fallback", reason: "invalid" }, req: fallback }
  }
  if (!validAccept(req)) return { outcome: { kind: "fallback", reason: "invalid" }, req }
  const conn = opts.connection ?? null
  if (!conn) return { outcome: { kind: "fallback", reason: "unavailable" }, req }
  try {
    if (!conn.isPrivateAvailable()) return { outcome: { kind: "fallback", reason: "unavailable" }, req }
  } catch {
    return { outcome: { kind: "fallback", reason: "unavailable" }, req }
  }
  const acq = acquireAccept(conn, req)
  if (!acq.ok) return { outcome: { kind: "fallback", reason: "missing-capability" }, req }
  let result: unknown
  try {
    result = await withTimeout(acq.promise, 3000)
  } catch {
    expired(acq.handle, req.opId)
    return { outcome: { kind: "fallback", reason: "timeout" }, req }
  }
  return { outcome: settleAccept(req, result), req }
}

export async function dismissSuggestionPrivateFirst(opts: {
  connection?: Conn | null
  directory: string
  requestID: string
}): Promise<{ outcome: SuggestionPrivateOutcome; req: SuggestionDismissContractRequest }> {
  let req: SuggestionDismissContractRequest
  try {
    req = buildDismissReq(opts.directory, opts.requestID)
  } catch {
    const token = crypto.randomUUID()
    const fallback: SuggestionDismissContractRequest = {
      v: 1 as const,
      requestId: crypto.randomUUID(),
      opId: `suggestion:${opts.requestID}:${token}`,
      op: "suggestion/dismiss" as const,
      idempotencyKey: `suggestion:${opts.requestID}:${token}`,
      context: { directory: opts.directory, requestID: opts.requestID },
      payload: {},
    }
    return { outcome: { kind: "fallback", reason: "invalid" }, req: fallback }
  }
  if (!validDismiss(req)) return { outcome: { kind: "fallback", reason: "invalid" }, req }
  const conn = opts.connection ?? null
  if (!conn) return { outcome: { kind: "fallback", reason: "unavailable" }, req }
  try {
    if (!conn.isPrivateAvailable()) return { outcome: { kind: "fallback", reason: "unavailable" }, req }
  } catch {
    return { outcome: { kind: "fallback", reason: "unavailable" }, req }
  }
  const acq = acquireDismiss(conn, req)
  if (!acq.ok) return { outcome: { kind: "fallback", reason: "missing-capability" }, req }
  let result: unknown
  try {
    result = await withTimeout(acq.promise, 3000)
  } catch {
    expired(acq.handle, req.opId)
    return { outcome: { kind: "fallback", reason: "timeout" }, req }
  }
  return { outcome: settleDismiss(req, result), req }
}

export function buildSuggestionListIdentity(): { opId: string; idempotencyKey: string; requestId: string } {
  const token = crypto.randomUUID()
  const opId = canonicalSuggestionListOpId(token)
  return { opId, idempotencyKey: opId, requestId: crypto.randomUUID() }
}

function buildListReq(directory: string): SuggestionListContractRequest {
  const ids = buildSuggestionListIdentity()
  return {
    v: 1 as const,
    requestId: ids.requestId,
    opId: ids.opId,
    op: "suggestion/list" as const,
    idempotencyKey: ids.idempotencyKey,
    context: { directory },
    payload: {},
  }
}

function validList(req: SuggestionListContractRequest): boolean {
  try {
    validateSuggestionListContractRequest(req)
    return true
  } catch {
    return false
  }
}

function acquireList(conn: Conn, req: SuggestionListContractRequest): { ok: true; handle: Handle | null; promise: Promise<unknown> } | { ok: false; reason: string } {
  try {
    const outcome = conn.privateSuggestionListOutcomeWithHandle?.bind(conn) ?? null
    if (outcome) {
      const got = outcome(req)
      return { ok: true, handle: got, promise: got.promise }
    }
    const direct = conn.privateSuggestionListWithHandle?.bind(conn) ?? null
    if (direct) {
      const got = direct(req)
      return { ok: true, handle: got, promise: got.promise }
    }
    const deps = ownerDeps(conn)
    if (!deps || !deps.peer) return { ok: false, reason: "missing-capability" }
    const got = suggestionListHandle({ peer: deps.peer, live: deps.live, epoch: deps.epoch, invalidate: deps.invalidate }, req)
    return { ok: true, handle: got, promise: got.promise }
  } catch (err) {
    return { ok: false, reason: String(err instanceof Error ? err.message : err).slice(0, 200) }
  }
}

function settleList(req: SuggestionListContractRequest, result: unknown): SuggestionListPrivateOutcome {
  const rec = result as { kind?: unknown; status?: unknown } | null
  if (!rec || typeof rec !== "object") return { kind: "fallback", reason: "invalid" }
  if (rec.kind === "invalid") return { kind: "fallback", reason: "invalid" }
  const wire = rec as { kind?: string; result?: unknown }
  const inner = wire.kind === "valid" ? wire.result : result
  const typed = inner as { status?: unknown }
  if (typed.status === "ambiguous") return { kind: "fallback", reason: "ambiguous" }
  if (typed.status === "succeeded") {
    try {
      const out = validateSuggestionListResult(inner, req)
      if (out.status !== "succeeded" || out.accepted !== true) return { kind: "fallback", reason: "invalid" }
      return { kind: "ok", items: out.data.suggestions }
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
  }
  if (typed.status === "failed") {
    try {
      const out = validateSuggestionListResult(inner, req)
      if (out.status !== "failed") return { kind: "fallback", reason: "invalid" }
      return { kind: "fallback", reason: out.failure.code }
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
  }
  return { kind: "fallback", reason: "invalid" }
}

export async function listSuggestionsPrivateFirst(opts: {
  connection?: Conn | null
  directory: string
}): Promise<{ outcome: SuggestionListPrivateOutcome; req: SuggestionListContractRequest }> {
  let req: SuggestionListContractRequest
  try {
    req = buildListReq(opts.directory)
  } catch {
    const token = crypto.randomUUID()
    const fallback: SuggestionListContractRequest = {
      v: 1 as const,
      requestId: crypto.randomUUID(),
      opId: `suggestion-list:${token}`,
      op: "suggestion/list" as const,
      idempotencyKey: `suggestion-list:${token}`,
      context: { directory: opts.directory },
      payload: {},
    }
    return { outcome: { kind: "fallback", reason: "invalid" }, req: fallback }
  }
  if (!validList(req)) return { outcome: { kind: "fallback", reason: "invalid" }, req }
  const conn = opts.connection ?? null
  if (!conn) return { outcome: { kind: "fallback", reason: "unavailable" }, req }
  try {
    if (!conn.isPrivateAvailable()) return { outcome: { kind: "fallback", reason: "unavailable" }, req }
  } catch {
    return { outcome: { kind: "fallback", reason: "unavailable" }, req }
  }
  const acq = acquireList(conn, req)
  if (!acq.ok) return { outcome: { kind: "fallback", reason: "missing-capability" }, req }
  let result: unknown
  try {
    result = await withTimeout(acq.promise, 3000)
  } catch {
    expired(acq.handle, req.opId)
    return { outcome: { kind: "fallback", reason: "timeout" }, req }
  }
  return { outcome: settleList(req, result), req }
}

export async function readSuggestionsForDir(opts: {
  connection?: Conn | null
  client: unknown
  directory: string
}): Promise<{ kind: "ok"; items: SuggestionListEntry[] } | { kind: "unknown" }> {
  const attempt = await listSuggestionsPrivateFirst({ connection: opts.connection ?? null, directory: opts.directory })
  if (attempt.outcome.kind === "ok") return { kind: "ok", items: attempt.outcome.items }
  const client = opts.client as {
    suggestion?: { list?: (args: { directory: string }) => Promise<{ data?: unknown; error?: unknown }> }
  } | null
  if (!client?.suggestion?.list) return { kind: "unknown" }
  try {
    const res = await client.suggestion.list({ directory: opts.directory })
    if (res.error) return { kind: "unknown" }
    const items = Array.isArray(res.data) ? (res.data as SuggestionListEntry[]) : []
    return { kind: "ok", items }
  } catch {
    return { kind: "unknown" }
  }
}
