import { Effect, Schema } from "effect"
import { canonicalDirectory } from "@/kilocode/session/canonical-directory"
import { Notebook } from "@/kilocode/notebook/service"
import { Failure as NotebookFailureSchema, Result as NotebookResultSchema } from "@/kilocode/notebook/protocol"

export const VERSION = 1 as const
export const OP_REPLY = "notebook/reply" as const
export const OP_REJECT = "notebook/reject" as const
export const OP_LIST = "notebook/list" as const

export type Op = typeof OP_REPLY | typeof OP_REJECT
export type FailureCode = "notebook.not_found" | "notebook.invalid_reply" | "scope_mismatch"

export interface ReplyRequest {
  v: typeof VERSION
  requestId: string
  opId: string
  op: typeof OP_REPLY
  idempotencyKey: string
  context: { directory: string; requestID: string }
  payload: { result: unknown }
}

export interface RejectRequest {
  v: typeof VERSION
  requestId: string
  opId: string
  op: typeof OP_REJECT
  idempotencyKey: string
  context: { directory: string; requestID: string }
  payload: { error: unknown }
}

export interface ListRequest {
  v: typeof VERSION
  requestId: string
  opId: string
  op: typeof OP_LIST
  idempotencyKey: string
  context: { directory: string }
  payload: Record<string, never>
}

export interface ReplyTerminal {
  kind: "terminal"
  v: typeof VERSION
  requestId: string
  opId: string
  idempotencyKey: string
  accepted: true
  terminal: true
  sessionID: string
  requestID: string
}

export interface RejectTerminal {
  kind: "terminal"
  v: typeof VERSION
  requestId: string
  opId: string
  idempotencyKey: string
  accepted: true
  terminal: true
  sessionID: string
  requestID: string
}

export interface NotebookFailure {
  kind: "terminal-failure"
  v: typeof VERSION
  requestId: string
  opId: string
  idempotencyKey: string
  accepted: false
  terminal: true
  failure: { code: FailureCode; retryable: false; time: number }
  sideEffect: false
}

export type NotebookResult = ReplyTerminal | RejectTerminal | NotebookFailure

function record(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function present(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

function isNotebookID(v: unknown): boolean {
  return (
    typeof v === "string" &&
    (v as string).startsWith("nbr_") &&
    (v as string).length > 4 &&
    !(v as string).includes("\0") &&
    !(v as string).includes(":") &&
    !(v as string).includes("/") &&
    !(v as string).includes("\\")
  )
}

export function canonicalNotebookOpId(requestID: string, token: string): string {
  if (!isNotebookID(requestID)) throw new Error("requestID must be NotebookRequestID")
  if (typeof token !== "string" || token.length === 0) throw new Error("token must be non-empty string")
  if (token.includes(":")) throw new Error("token must not contain ':'")
  if (token.includes("\0")) throw new Error("token must not contain null bytes")
  if (token.includes("/") || token.includes("\\")) throw new Error("token must not carry path material")
  return `notebook:${requestID}:${token}`
}

export function parseNotebookOpId(opId: string): { requestID: string; token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new Error("opId must be non-empty string")
  if (opId.includes("\0")) throw new Error("opId must not contain null bytes")
  const segs = opId.split(":")
  if (segs.length !== 3) throw new Error(`notebook opId must have 2 segments: ${opId}`)
  if (segs[0] !== "notebook") throw new Error(`opId kind must be notebook: ${opId}`)
  const rid = segs[1]!
  if (!isNotebookID(rid)) throw new Error(`opId requestID must be NotebookRequestID: ${opId}`)
  const token = segs[2]!
  if (token.length === 0) throw new Error(`opId token must be non-empty: ${opId}`)
  if (token.includes("\0")) throw new Error("opId token must not contain null bytes")
  if (token.includes("/") || token.includes("\\")) throw new Error("opId token must not carry path material")
  return { requestID: rid, token }
}

export function canonicalNotebookListOpId(token: string): string {
  if (typeof token !== "string" || token.length === 0) throw new Error("token must be non-empty string")
  if (token.includes(":")) throw new Error("token must not contain ':'")
  if (token.includes("\0")) throw new Error("token must not contain null bytes")
  if (token.includes("/") || token.includes("\\")) throw new Error("token must not carry path material")
  return `notebook-list:${token}`
}

export function parseNotebookListOpId(opId: string): { token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new Error("opId must be non-empty string")
  if (opId.includes("\0")) throw new Error("opId must not contain null bytes")
  const segs = opId.split(":")
  if (segs.length !== 2) throw new Error(`notebook-list opId must be notebook-list:<token>: ${opId}`)
  if (segs[0] !== "notebook-list") throw new Error(`opId kind must be notebook-list: ${opId}`)
  const token = segs[1]!
  if (token.length === 0) throw new Error(`opId token must be non-empty: ${opId}`)
  if (token.includes("\0")) throw new Error("opId token must not contain null bytes")
  if (token.includes("/") || token.includes("\\")) throw new Error("opId token must not carry path material")
  return { token }
}

function base(raw: unknown): Record<string, unknown> {
  if (!record(raw)) throw new Error("request must be object")
  const allowed = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) throw new Error(`unexpected field ${k}`)
  }
  if (raw.v !== 1) throw new Error("v must be 1")
  if (!present(raw.requestId)) throw new Error("requestId must be non-empty string")
  if ((raw.requestId as string).includes("\0")) throw new Error("requestId must not contain null bytes")
  if (!present(raw.opId)) throw new Error("opId must be non-empty string")
  if ((raw.opId as string).includes("\0")) throw new Error("opId must not contain null bytes")
  if (raw.op !== OP_REPLY && raw.op !== OP_REJECT && raw.op !== OP_LIST)
    throw new Error("op must be notebook/reply, notebook/reject, or notebook/list")
  if (!present(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if ((raw.idempotencyKey as string).includes("\0")) throw new Error("idempotencyKey must not contain null bytes")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId")
  return raw as Record<string, unknown>
}

function checkDirContext(ctx: unknown, withRequest: boolean): void {
  if (!record(ctx)) throw new Error("context must be object")
  const allowed = withRequest ? new Set(["directory", "requestID"]) : new Set(["directory"])
  for (const k of Object.keys(ctx)) {
    if (!allowed.has(k)) throw new Error(`unexpected context field ${k}`)
  }
  if (typeof ctx.directory !== "string" || ctx.directory.length === 0)
    throw new Error("context.directory must be non-empty string")
  canonicalDirectory(ctx.directory)
  if (withRequest && !isNotebookID(ctx.requestID)) throw new Error("context.requestID must be NotebookRequestID")
}

function checkBinding(raw: Record<string, unknown>, withRequest: boolean): void {
  if (withRequest) {
    const parsed = parseNotebookOpId(raw.opId as string)
    const idem = parseNotebookOpId(raw.idempotencyKey as string)
    if (idem.requestID !== parsed.requestID) throw new Error("idempotencyKey request binding mismatch")
    if (idem.token !== parsed.token) throw new Error("idempotencyKey token must equal opId token")
    return
  }
  const parsed = parseNotebookListOpId(raw.opId as string)
  const idem = parseNotebookListOpId(raw.idempotencyKey as string)
  if (idem.token !== parsed.token) throw new Error("idempotencyKey token must equal opId token")
}

export function validateNotebookReplyRequest(raw: unknown): ReplyRequest {
  const root = base(raw)
  if (root.op !== OP_REPLY) throw new Error("op must be notebook/reply")
  checkDirContext(root.context, true)
  checkBinding(root, true)
  const payload = root.payload
  if (!record(payload)) throw new Error("payload must be object")
  if (Object.keys(payload).length !== 1 || !("result" in payload)) throw new Error("payload must carry only result")
  // Strict protocol shape; decoded value is used for settlement, never echoed.
  Schema.decodeUnknownSync(NotebookResultSchema)(payload.result)
  const ctx = root.context as Record<string, unknown>
  return {
    v: 1,
    requestId: root.requestId as string,
    opId: root.opId as string,
    op: OP_REPLY,
    idempotencyKey: root.idempotencyKey as string,
    context: { directory: ctx.directory as string, requestID: ctx.requestID as string },
    payload: { result: payload.result },
  }
}

export function validateNotebookRejectRequest(raw: unknown): RejectRequest {
  const root = base(raw)
  if (root.op !== OP_REJECT) throw new Error("op must be notebook/reject")
  checkDirContext(root.context, true)
  checkBinding(root, true)
  const payload = root.payload
  if (!record(payload)) throw new Error("payload must be object")
  if (Object.keys(payload).length !== 1 || !("error" in payload)) throw new Error("payload must carry only error")
  Schema.decodeUnknownSync(NotebookFailureSchema)(payload.error)
  const ctx = root.context as Record<string, unknown>
  return {
    v: 1,
    requestId: root.requestId as string,
    opId: root.opId as string,
    op: OP_REJECT,
    idempotencyKey: root.idempotencyKey as string,
    context: { directory: ctx.directory as string, requestID: ctx.requestID as string },
    payload: { error: payload.error },
  }
}

export function validateNotebookListRequest(raw: unknown): ListRequest {
  const root = base(raw)
  if (root.op !== OP_LIST) throw new Error("op must be notebook/list")
  checkDirContext(root.context, false)
  checkBinding(root, false)
  const payload = root.payload
  if (!record(payload)) throw new Error("payload must be object")
  if (Object.keys(payload).length !== 0) throw new Error("payload must be empty object for notebook-list")
  const ctx = root.context as Record<string, unknown>
  return {
    v: 1,
    requestId: root.requestId as string,
    opId: root.opId as string,
    op: OP_LIST,
    idempotencyKey: root.idempotencyKey as string,
    context: { directory: ctx.directory as string },
    payload: {},
  }
}

function failed(requestId: string, opId: string, key: string, code: FailureCode): NotebookFailure {
  return {
    kind: "terminal-failure",
    v: 1,
    requestId,
    opId,
    idempotencyKey: key,
    accepted: false,
    terminal: true,
    failure: { code, retryable: false as const, time: Date.now() },
    sideEffect: false as const,
  }
}

function bound(req: { opId: string; context: { requestID: string } }): boolean {
  const parsed = parseNotebookOpId(req.opId)
  return parsed.requestID === req.context.requestID
}

function scopeFromRaw(raw: unknown): { requestId: string; opId: string; key: string } | null {
  if (!record(raw)) return null
  if (!present(raw.requestId) || !present(raw.opId) || !present(raw.idempotencyKey)) return null
  return { requestId: raw.requestId as string, opId: raw.opId as string, key: raw.idempotencyKey as string }
}

// Private `notebook/reply`: the same `Notebook.Service.reply` as HTTP
// `POST /kilocode/notebook/:requestID/reply` under the caller's
// drain-control + `InstanceRef` lane. Returns a minimal terminal binding
// only (sessionID + requestID); cell source/outputs/full result are never
// echoed. A syntactically valid reply whose result does not match the
// pending request settles `notebook.invalid_reply` (retryable=false, zero
// SDK fallback, pending intact). Unknown pending settles
// `notebook.not_found` (stale-settled, not a retry).
export const replyNotebookPrivate = Effect.fn("NotebookPrivate.reply")(function* (raw: unknown) {
  let req: ReplyRequest
  try {
    req = validateNotebookReplyRequest(raw)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("op must be notebook/")) {
      const ids = scopeFromRaw(raw)
      if (!ids) throw e
      return failed(ids.requestId, ids.opId, ids.key, "scope_mismatch")
    }
    throw e
  }
  if (!bound(req)) return failed(req.requestId, req.opId, req.idempotencyKey, "scope_mismatch")
  const svc = yield* Notebook.Service
  const pending = yield* svc.list()
  const found = pending.find((entry) => String(entry.id) === req.context.requestID)
  if (!found) return failed(req.requestId, req.opId, req.idempotencyKey, "notebook.not_found")
  const sid = String(found.sessionID)
  const done = yield* svc
    .reply({
      requestID: found.id,
      result: Schema.decodeUnknownSync(NotebookResultSchema)(req.payload.result) as never,
    })
    .pipe(
      Effect.map(() => ({ tag: "ok" as const })),
      Effect.catchTag("Notebook.NotFoundError", () => Effect.succeed({ tag: "gone" as const })),
      Effect.catchTag("Notebook.InvalidReplyError", () => Effect.succeed({ tag: "mismatch" as const })),
    )
  if (done.tag === "gone") return failed(req.requestId, req.opId, req.idempotencyKey, "notebook.not_found")
  if (done.tag === "mismatch") return failed(req.requestId, req.opId, req.idempotencyKey, "notebook.invalid_reply")
  return {
    kind: "terminal",
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: true,
    terminal: true,
    sessionID: sid,
    requestID: String(found.id),
  } satisfies ReplyTerminal
})

// Private `notebook/reject`: the same `Notebook.Service.reject` as HTTP
// `POST /kilocode/notebook/:requestID/reject` under the caller's lane.
// Minimal terminal binding only; unknown pending settles
// `notebook.not_found` (stale-settled, not a retry).
export const rejectNotebookPrivate = Effect.fn("NotebookPrivate.reject")(function* (raw: unknown) {
  let req: RejectRequest
  try {
    req = validateNotebookRejectRequest(raw)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("op must be notebook/")) {
      const ids = scopeFromRaw(raw)
      if (!ids) throw e
      return failed(ids.requestId, ids.opId, ids.key, "scope_mismatch")
    }
    throw e
  }
  if (!bound(req)) return failed(req.requestId, req.opId, req.idempotencyKey, "scope_mismatch")
  const svc = yield* Notebook.Service
  const pending = yield* svc.list()
  const found = pending.find((entry) => String(entry.id) === req.context.requestID)
  if (!found) return failed(req.requestId, req.opId, req.idempotencyKey, "notebook.not_found")
  const sid = String(found.sessionID)
  const done = yield* svc
    .reject({
      requestID: found.id,
      error: Schema.decodeUnknownSync(NotebookFailureSchema)(req.payload.error) as never,
    })
    .pipe(
      Effect.map(() => ({ tag: "ok" as const })),
      Effect.catchTag("Notebook.NotFoundError", () => Effect.succeed({ tag: "gone" as const })),
    )
  if (done.tag !== "ok") return failed(req.requestId, req.opId, req.idempotencyKey, "notebook.not_found")
  return {
    kind: "terminal",
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: true,
    terminal: true,
    sessionID: sid,
    requestID: String(found.id),
  } satisfies RejectTerminal
})
