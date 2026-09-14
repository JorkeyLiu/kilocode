import { isAbsolute } from "path"
import {
  canonicalNotebookListOpId,
  parseNotebookListOpId,
  type NotebookListContractRequest,
} from "./serve-private-notebook-contract"

export type { NotebookListContractRequest }
export { canonicalNotebookListOpId, parseNotebookListOpId }

function record(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function present(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

function clean(v: unknown, label: string): string {
  if (!present(v)) throw new Error(`${label} must be non-empty string`)
  const text = v as string
  if (text.includes("\0")) throw new Error(`${label} must not contain null bytes`)
  return text
}

export function validateNotebookListContractRequest(raw: unknown): NotebookListContractRequest {
  if (!record(raw)) throw new Error("request must be object")
  const allowed = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) throw new Error(`unexpected field ${k}`)
  }
  if (raw.v !== 1) throw new Error("v must be 1")
  clean(raw.requestId, "requestId")
  clean(raw.opId, "opId")
  if (raw.op !== "notebook/list") throw new Error("op must be notebook/list")
  clean(raw.idempotencyKey, "idempotencyKey")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId")
  const ctx = raw.context
  if (!record(ctx)) throw new Error("context must be object")
  const ctxAllowed = new Set(["directory"])
  for (const k of Object.keys(ctx)) {
    if (!ctxAllowed.has(k)) throw new Error(`unexpected context field ${k}`)
  }
  if (typeof ctx.directory !== "string" || !isAbsolute(ctx.directory) || ctx.directory.includes("\0"))
    throw new Error("context.directory must be absolute path")
  const payload = raw.payload
  if (!record(payload)) throw new Error("payload must be object")
  if (Object.keys(payload).length !== 0) throw new Error("payload must be empty object for notebook-list")
  const parsed = parseNotebookListOpId(raw.opId as string)
  const idem = parseNotebookListOpId(raw.idempotencyKey as string)
  if (idem.token !== parsed.token) throw new Error("idempotencyKey token must equal opId token")
  return raw as unknown as NotebookListContractRequest
}

function isNotebookId(v: unknown): boolean {
  return (
    typeof v === "string" &&
    (v as string).startsWith("nbr_") &&
    (v as string).length > 4 &&
    !(v as string).includes("\0")
  )
}

function isSessionId(v: unknown): boolean {
  return typeof v === "string" && (v as string).startsWith("ses")
}

export interface NotebookListEntry {
  id: string
  sessionID: string
  operation: "read" | "edit" | "execute"
  path: string
}

const ENTRY_FIELDS = new Set([
  "id",
  "sessionID",
  "path",
  "operation",
  "includeOutputs",
  "expectedRevision",
  "index",
  "edit",
])

const ENTRY_FORBIDDEN = new Set(["cells", "source", "outputs", "result", "cell", "output", "contents", "data"])

export function validateNotebookListEntry(raw: unknown): NotebookListEntry {
  if (!record(raw)) throw new Error("notebook entry must be object")
  for (const k of Object.keys(raw)) {
    if (ENTRY_FORBIDDEN.has(k)) throw new Error(`notebook entry must not carry ${k}`)
  }
  for (const k of Object.keys(raw)) {
    if (!ENTRY_FIELDS.has(k)) throw new Error(`unexpected notebook entry field ${k}`)
  }
  if (!isNotebookId(raw.id)) throw new Error("notebook entry id must be NotebookRequestID")
  if ((raw.id as string).includes("\0")) throw new Error("notebook entry id must not contain null bytes")
  if (!isSessionId(raw.sessionID)) throw new Error("notebook entry sessionID must be SessionID")
  if (raw.operation !== "read" && raw.operation !== "edit" && raw.operation !== "execute")
    throw new Error("notebook entry operation must be read, edit, or execute")
  if (typeof raw.path !== "string" || raw.path.length === 0)
    throw new Error("notebook entry path must be non-empty string")
  if ((raw.path as string).includes("\0")) throw new Error("notebook entry path must not contain null bytes")
  return raw as unknown as NotebookListEntry
}

export function validateNotebookListEntries(raw: unknown): NotebookListEntry[] {
  if (!Array.isArray(raw)) throw new Error("notebooks must be array")
  return (raw as unknown[]).map((item) => validateNotebookListEntry(item))
}

export interface NotebookListFailure {
  code: string
  message: string
  retryable: boolean
}

const FAILURE_FORBIDDEN = new Set([
  "notebook",
  "notebooks",
  "directory",
  "workspace",
  "session",
  "sessionID",
  "requestID",
  "path",
  "cells",
  "source",
  "outputs",
  "result",
  "error",
  "raw",
  "output",
  "detail",
])

const FAILURE_FIELDS = new Set(["code", "message", "retryable"])

export function validateNotebookListFailure(raw: unknown): NotebookListFailure {
  if (!record(raw)) throw new Error("failure must be object")
  for (const k of Object.keys(raw)) {
    if (FAILURE_FORBIDDEN.has(k)) throw new Error(`failure must not carry ${k}`)
  }
  for (const k of Object.keys(raw)) {
    if (!FAILURE_FIELDS.has(k)) throw new Error(`unexpected failure field ${k}`)
  }
  if (!present(raw.code)) throw new Error("failure code must be non-empty string")
  if (!present(raw.message)) throw new Error("failure message must be non-empty string")
  if (typeof raw.retryable !== "boolean") throw new Error("failure retryable must be boolean")
  return raw as unknown as NotebookListFailure
}

export type NotebookListResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: "notebook/list"
      idempotencyKey: string
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: { notebooks: NotebookListEntry[] }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "notebook/list"
      idempotencyKey: string
      status: "failed"
      outcome: { type: "failed"; time: number; failure: NotebookListFailure }
      accepted: boolean
      failure: NotebookListFailure
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "notebook/list"
      idempotencyKey: string
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      transportUnknown?: boolean
    }

export function makeNotebookListAmbiguous(
  req: NotebookListContractRequest,
  transportUnknown = true,
): NotebookListResult {
  const out: NotebookListResult = {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "notebook/list",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

export type NotebookListWireOutcome =
  | { kind: "valid"; result: NotebookListResult }
  | { kind: "invalid"; detail: string }

export class NotebookListValidationError extends Error {
  readonly kind = "private-notebook-list-validation" as const
  readonly detail: string
  constructor(detail: string) {
    super(`invalid private response shape: ${detail}`)
    this.name = "NotebookListValidationError"
    this.detail = detail
  }
}

export function isNotebookListValidationError(v: unknown): v is NotebookListValidationError {
  return !!v && typeof v === "object" && (v as { kind?: unknown }).kind === "private-notebook-list-validation"
}

export function normalizePrivateNotebookListWire(
  raw: unknown,
  req: NotebookListContractRequest,
): NotebookListWireOutcome {
  try {
    const result = validateNotebookListResult(raw, req)
    return { kind: "valid", result }
  } catch (e) {
    const detail = String(e instanceof Error ? e.message : e).slice(0, 200)
    return { kind: "invalid", detail }
  }
}

const RESULT_SUCCEEDED = new Set([
  "v",
  "requestId",
  "opId",
  "op",
  "idempotencyKey",
  "status",
  "outcome",
  "accepted",
  "data",
])
const RESULT_FAILED = new Set([
  "v",
  "requestId",
  "opId",
  "op",
  "idempotencyKey",
  "status",
  "outcome",
  "accepted",
  "failure",
])
const RESULT_AMBIGUOUS = new Set([
  "v",
  "requestId",
  "opId",
  "op",
  "idempotencyKey",
  "status",
  "outcome",
  "accepted",
  "transportUnknown",
])
const OUTCOME_PLAIN = new Set(["type", "time"])
const OUTCOME_FAILED = new Set(["type", "time", "failure"])

// eslint-disable-next-line complexity
export function validateNotebookListResult(raw: unknown, req: NotebookListContractRequest): NotebookListResult {
  if (!record(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== "notebook/list") throw new Error("op mismatch")
  if (raw.idempotencyKey !== req.idempotencyKey) throw new Error("idempotencyKey mismatch")
  const status = raw.status
  if (status !== "succeeded" && status !== "failed" && status !== "ambiguous")
    throw new Error("status must be succeeded/failed/ambiguous")
  if (typeof raw.accepted !== "boolean") throw new Error("accepted must be boolean")
  const outcome = raw.outcome
  if (!record(outcome) || typeof outcome.type !== "string" || typeof outcome.time !== "number")
    throw new Error("outcome invalid")
  if (outcome.type !== status) throw new Error("outcome.type must match status")
  if (!Number.isFinite(outcome.time) || outcome.time < 0) throw new Error("outcome.time invalid")
  const rec = raw as Record<string, unknown>
  const outRec = outcome as Record<string, unknown>
  if (status === "succeeded") {
    for (const k of Object.keys(rec)) if (!RESULT_SUCCEEDED.has(k)) throw new Error(`unexpected result field ${k}`)
    for (const k of Object.keys(outRec)) if (!OUTCOME_PLAIN.has(k)) throw new Error(`unexpected outcome field ${k}`)
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    const data = rec.data
    if (!record(data)) throw new Error("succeeded data must be object")
    const allowedData = new Set(["notebooks"])
    for (const k of Object.keys(data)) if (!allowedData.has(k)) throw new Error(`unexpected data field ${k}`)
    validateNotebookListEntries((data as Record<string, unknown>).notebooks)
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (outRec.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as NotebookListResult
  }
  if (status === "failed") {
    for (const k of Object.keys(rec)) if (!RESULT_FAILED.has(k)) throw new Error(`unexpected result field ${k}`)
    for (const k of Object.keys(outRec)) if (!OUTCOME_FAILED.has(k)) throw new Error(`unexpected outcome field ${k}`)
    const failure = validateNotebookListFailure(rec.failure)
    const outFailure = validateNotebookListFailure(outRec.failure)
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    if (rec.data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as NotebookListResult
  }
  for (const k of Object.keys(rec)) if (!RESULT_AMBIGUOUS.has(k)) throw new Error(`unexpected result field ${k}`)
  for (const k of Object.keys(outRec)) if (!OUTCOME_PLAIN.has(k)) throw new Error(`unexpected outcome field ${k}`)
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (outRec.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as NotebookListResult
}

export function isSettledNotebookListResult(result: unknown, req: NotebookListContractRequest): boolean {
  if (!record(result)) return false
  const kind = (result as { status?: unknown }).status
  if (kind !== "succeeded" && kind !== "failed") return false
  try {
    const out = validateNotebookListResult(result, req)
    if (out.status === "succeeded") return true
    if (out.status === "failed") return out.failure.retryable === false
    return false
  } catch {
    return false
  }
}
