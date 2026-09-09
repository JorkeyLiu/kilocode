import * as crypto from "crypto"
import {
  canonicalQuestionOpId,
  validateQuestionRejectContractRequest,
  validateQuestionReplyContractRequest,
  validateQuestionRejectResult,
  validateQuestionReplyResult,
  validateQuestionTerminalFailure,
} from "../services/cli-backend/serve-private-question-contract"
import type {
  QuestionRejectContractRequest,
  QuestionReplyContractRequest,
} from "../services/cli-backend/serve-private-question-contract"
import type { KiloConnectionService } from "../services/cli-backend"

export type QuestionPrivateOutcome =
  | { kind: "terminal" }
  | { kind: "terminal-failure"; code: "question.not_found" | "scope_mismatch" }
  | { kind: "fallback"; reason: string }

type Handle = { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean }

export function buildQuestionReplyIdentity(requestID: string): {
  opId: string
  idempotencyKey: string
  requestId: string
} {
  const token = crypto.randomUUID()
  const opId = canonicalQuestionOpId(requestID, token)
  return { opId, idempotencyKey: opId, requestId: crypto.randomUUID() }
}

export function buildQuestionRejectIdentity(requestID: string): {
  opId: string
  idempotencyKey: string
  requestId: string
} {
  const token = crypto.randomUUID()
  const opId = canonicalQuestionOpId(requestID, token)
  return { opId, idempotencyKey: opId, requestId: crypto.randomUUID() }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`private question timeout after ${ms}ms`)), ms)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

function buildReplyReq(directory: string, requestID: string, answers: string[][]): QuestionReplyContractRequest {
  const ids = buildQuestionReplyIdentity(requestID)
  return {
    v: 1 as const,
    requestId: ids.requestId,
    opId: ids.opId,
    op: "question/reply" as const,
    idempotencyKey: ids.idempotencyKey,
    context: { directory, requestID },
    payload: { answers: answers.map((row) => [...row]) },
  }
}

function buildRejectReq(directory: string, requestID: string): QuestionRejectContractRequest {
  const ids = buildQuestionRejectIdentity(requestID)
  return {
    v: 1 as const,
    requestId: ids.requestId,
    opId: ids.opId,
    op: "question/reject" as const,
    idempotencyKey: ids.idempotencyKey,
    context: { directory, requestID },
    payload: {},
  }
}

function validReply(req: QuestionReplyContractRequest): boolean {
  try {
    validateQuestionReplyContractRequest(req)
    return true
  } catch {
    return false
  }
}

function validReject(req: QuestionRejectContractRequest): boolean {
  try {
    validateQuestionRejectContractRequest(req)
    return true
  } catch {
    return false
  }
}

type Conn = Pick<KiloConnectionService, "isPrivateAvailable"> & {
  privateQuestionWithHandle?: (req: QuestionReplyContractRequest | QuestionRejectContractRequest) => Handle
  privateQuestionReplyWithHandle?: (req: QuestionReplyContractRequest) => Handle
  privateQuestionRejectWithHandle?: (req: QuestionRejectContractRequest) => Handle
}

function acquireReply(conn: Conn, req: QuestionReplyContractRequest): { ok: true; handle: Handle | null; promise: Promise<unknown> } | { ok: false; reason: string } {
  try {
    const generic = conn.privateQuestionWithHandle?.bind(conn) ?? null
    if (generic) {
      const got = generic(req)
      return { ok: true, handle: got, promise: got.promise }
    }
    const factory = conn.privateQuestionReplyWithHandle?.bind(conn) ?? null
    if (!factory) return { ok: false, reason: "missing-capability" }
    const got = factory(req)
    return { ok: true, handle: got, promise: got.promise }
  } catch (err) {
    return { ok: false, reason: String(err instanceof Error ? err.message : err).slice(0, 200) }
  }
}

function acquireReject(conn: Conn, req: QuestionRejectContractRequest): { ok: true; handle: Handle | null; promise: Promise<unknown> } | { ok: false; reason: string } {
  try {
    const generic = conn.privateQuestionWithHandle?.bind(conn) ?? null
    if (generic) {
      const got = generic(req)
      return { ok: true, handle: got, promise: got.promise }
    }
    const factory = conn.privateQuestionRejectWithHandle?.bind(conn) ?? null
    if (!factory) return { ok: false, reason: "missing-capability" }
    const got = factory(req)
    return { ok: true, handle: got, promise: got.promise }
  } catch (err) {
    return { ok: false, reason: String(err instanceof Error ? err.message : err).slice(0, 200) }
  }
}

function expired(handle: Handle | null, opId: string): void {
  if (!handle?.cancel) return
  try {
    handle.cancel(`private question timeout opId=${opId}`)
  } catch (err) {
    console.warn("[Kilo Question] private timeout cancel failed:", String(err).slice(0, 200), { opId })
  }
}

function settleReply(req: QuestionReplyContractRequest, result: unknown): QuestionPrivateOutcome {
  const kind = (result as { kind?: unknown }).kind
  if (kind === "ambiguous") return { kind: "fallback", reason: "ambiguous" }
  if (kind === "terminal") {
    try {
      validateQuestionReplyResult(result, req)
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
    return { kind: "terminal" }
  }
  if (kind === "terminal-failure") {
    try {
      const out = validateQuestionTerminalFailure(result, req)
      const code = out.failure.code
      if (code === "question.not_found" || code === "scope_mismatch") return { kind: "terminal-failure", code }
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
    return { kind: "fallback", reason: "failure" }
  }
  return { kind: "fallback", reason: "invalid" }
}

function settleReject(req: QuestionRejectContractRequest, result: unknown): QuestionPrivateOutcome {
  const kind = (result as { kind?: unknown }).kind
  if (kind === "ambiguous") return { kind: "fallback", reason: "ambiguous" }
  if (kind === "terminal") {
    try {
      validateQuestionRejectResult(result, req)
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
    return { kind: "terminal" }
  }
  if (kind === "terminal-failure") {
    try {
      const out = validateQuestionTerminalFailure(result, req)
      const code = out.failure.code
      if (code === "question.not_found" || code === "scope_mismatch") return { kind: "terminal-failure", code }
    } catch {
      return { kind: "fallback", reason: "invalid" }
    }
    return { kind: "fallback", reason: "failure" }
  }
  return { kind: "fallback", reason: "invalid" }
}

export async function replyQuestionPrivateFirst(opts: {
  connection?: Conn | null
  directory: string
  requestID: string
  answers: string[][]
}): Promise<{ outcome: QuestionPrivateOutcome; req: QuestionReplyContractRequest }> {
  let req: QuestionReplyContractRequest
  try {
    req = buildReplyReq(opts.directory, opts.requestID, opts.answers)
  } catch {
    const token = crypto.randomUUID()
    const fallback: QuestionReplyContractRequest = {
      v: 1 as const,
      requestId: crypto.randomUUID(),
      opId: `question:${opts.requestID}:${token}`,
      op: "question/reply" as const,
      idempotencyKey: `question:${opts.requestID}:${token}`,
      context: { directory: opts.directory, requestID: opts.requestID },
      payload: { answers: opts.answers.map((row) => [...row]) },
    }
    return { outcome: { kind: "fallback", reason: "invalid" }, req: fallback }
  }
  if (!validReply(req)) return { outcome: { kind: "fallback", reason: "invalid" }, req }
  const conn = opts.connection ?? null
  if (!conn) return { outcome: { kind: "fallback", reason: "unavailable" }, req }
  try {
    if (!conn.isPrivateAvailable()) return { outcome: { kind: "fallback", reason: "unavailable" }, req }
  } catch {
    return { outcome: { kind: "fallback", reason: "unavailable" }, req }
  }
  const acq = acquireReply(conn, req)
  if (!acq.ok) return { outcome: { kind: "fallback", reason: "missing-capability" }, req }
  let result: unknown
  try {
    result = await withTimeout(acq.promise, 3000)
  } catch {
    expired(acq.handle, req.opId)
    return { outcome: { kind: "fallback", reason: "timeout" }, req }
  }
  return { outcome: settleReply(req, result), req }
}

export async function rejectQuestionPrivateFirst(opts: {
  connection?: Conn | null
  directory: string
  requestID: string
}): Promise<{ outcome: QuestionPrivateOutcome; req: QuestionRejectContractRequest }> {
  let req: QuestionRejectContractRequest
  try {
    req = buildRejectReq(opts.directory, opts.requestID)
  } catch {
    const token = crypto.randomUUID()
    const fallback: QuestionRejectContractRequest = {
      v: 1 as const,
      requestId: crypto.randomUUID(),
      opId: `question:${opts.requestID}:${token}`,
      op: "question/reject" as const,
      idempotencyKey: `question:${opts.requestID}:${token}`,
      context: { directory: opts.directory, requestID: opts.requestID },
      payload: {},
    }
    return { outcome: { kind: "fallback", reason: "invalid" }, req: fallback }
  }
  if (!validReject(req)) return { outcome: { kind: "fallback", reason: "invalid" }, req }
  const conn = opts.connection ?? null
  if (!conn) return { outcome: { kind: "fallback", reason: "unavailable" }, req }
  try {
    if (!conn.isPrivateAvailable()) return { outcome: { kind: "fallback", reason: "unavailable" }, req }
  } catch {
    return { outcome: { kind: "fallback", reason: "unavailable" }, req }
  }
  const acq = acquireReject(conn, req)
  if (!acq.ok) return { outcome: { kind: "fallback", reason: "missing-capability" }, req }
  let result: unknown
  try {
    result = await withTimeout(acq.promise, 3000)
  } catch {
    expired(acq.handle, req.opId)
    return { outcome: { kind: "fallback", reason: "timeout" }, req }
  }
  return { outcome: settleReject(req, result), req }
}
