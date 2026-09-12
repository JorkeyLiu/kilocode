import { Effect } from "effect"
import { canonicalDirectory } from "@/kilocode/session/canonical-directory"
import { Suggestion } from "./index"

export const VERSION = 1 as const
export const OP_ACCEPT = "suggestion/accept" as const
export const OP_DISMISS = "suggestion/dismiss" as const

export type Op = typeof OP_ACCEPT | typeof OP_DISMISS
export type FailureCode = "suggestion.not_found" | "scope_mismatch"

export interface AcceptRequest {
  v: typeof VERSION
  requestId: string
  opId: string
  op: typeof OP_ACCEPT
  idempotencyKey: string
  context: { directory: string; requestID: string }
  payload: { index: number }
}

export interface DismissRequest {
  v: typeof VERSION
  requestId: string
  opId: string
  op: typeof OP_DISMISS
  idempotencyKey: string
  context: { directory: string; requestID: string }
  payload: Record<string, never>
}

export interface AcceptTerminal {
  kind: "terminal"
  v: typeof VERSION
  requestId: string
  opId: string
  idempotencyKey: string
  accepted: true
  terminal: true
  sessionID: string
  requestID: string
  index: number
  action: { label: string; description?: string; prompt: string }
}

export interface DismissTerminal {
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

export interface SuggestionFailure {
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

export type SuggestionResult = AcceptTerminal | DismissTerminal | SuggestionFailure

function record(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function present(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

function isSuggestionId(v: unknown): boolean {
  return typeof v === "string" && (v as string).startsWith("sug")
}

export function canonicalSuggestionOpId(requestID: string, token: string): string {
  if (typeof requestID !== "string" || requestID.length === 0) throw new Error("requestID must be non-empty string")
  if (requestID.includes("\0")) throw new Error("requestID must not contain null bytes")
  if (!isSuggestionId(requestID)) throw new Error("requestID must be SuggestionID")
  if (requestID.includes(":")) throw new Error("requestID must not contain ':'")
  if (requestID.includes("/") || requestID.includes("\\")) throw new Error("requestID must not carry path material")
  if (typeof token !== "string" || token.length === 0) throw new Error("token must be non-empty string")
  if (token.includes(":")) throw new Error("token must not contain ':'")
  if (token.includes("\0")) throw new Error("token must not contain null bytes")
  if (token.includes("/") || token.includes("\\")) throw new Error("token must not carry path material")
  return `suggestion:${requestID}:${token}`
}

export function parseSuggestionOpId(opId: string): { requestID: string; token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new Error("opId must be non-empty string")
  if (opId.includes("\0")) throw new Error("opId must not contain null bytes")
  const segs = opId.split(":")
  if (segs.length !== 3) throw new Error(`suggestion opId must have 2 segments: ${opId}`)
  if (segs[0] !== "suggestion") throw new Error(`opId kind must be suggestion: ${opId}`)
  const rid = segs[1]!
  const token = segs[2]!
  if (rid.length === 0 || !isSuggestionId(rid)) throw new Error(`opId requestID must be SuggestionID: ${opId}`)
  if (rid.includes("\0")) throw new Error("opId requestID must not contain null bytes")
  if (rid.includes("/") || rid.includes("\\")) throw new Error("opId requestID must not carry path material")
  if (token.length === 0) throw new Error(`opId token must be non-empty: ${opId}`)
  if (token.includes(":")) throw new Error("opId token must not contain ':'")
  if (token.includes("\0")) throw new Error("opId token must not contain null bytes")
  if (token.includes("/") || token.includes("\\")) throw new Error("opId token must not carry path material")
  return { requestID: rid, token }
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
  if (raw.op !== OP_ACCEPT && raw.op !== OP_DISMISS) throw new Error("op must be suggestion/accept or suggestion/dismiss")
  if (!present(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if ((raw.idempotencyKey as string).includes("\0")) throw new Error("idempotencyKey must not contain null bytes")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId")
  const ctx = raw.context
  if (!record(ctx)) throw new Error("context must be object")
  const ctxAllowed = new Set(["directory", "requestID"])
  for (const k of Object.keys(ctx)) {
    if (!ctxAllowed.has(k)) throw new Error(`unexpected context field ${k}`)
  }
  if (typeof ctx.directory !== "string" || ctx.directory.length === 0)
    throw new Error("context.directory must be non-empty string")
  canonicalDirectory(ctx.directory)
  if (!isSuggestionId(ctx.requestID)) throw new Error("context.requestID must be SuggestionID")
  if ((ctx.requestID as string).includes("\0")) throw new Error("context.requestID must not contain null bytes")
  if ((ctx.requestID as string).includes(":")) throw new Error("context.requestID must not contain ':'")
  const parsed = parseSuggestionOpId(raw.opId as string)
  const idem = parseSuggestionOpId(raw.idempotencyKey as string)
  if (idem.requestID !== parsed.requestID) throw new Error("idempotencyKey request binding mismatch")
  if (idem.token !== parsed.token) throw new Error("idempotencyKey token must equal opId token")
  return raw as Record<string, unknown>
}

function safeIndex(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)
    throw new Error("payload.index must be non-negative safe integer")
  return v
}

export function validateSuggestionAcceptRequest(raw: unknown): AcceptRequest {
  const root = base(raw)
  if (root.op !== OP_ACCEPT) throw new Error("op must be suggestion/accept")
  const payload = root.payload
  if (!record(payload)) throw new Error("payload must be object")
  if (Object.keys(payload).length !== 1 || !("index" in payload))
    throw new Error("payload must carry only index")
  const index = safeIndex((payload as Record<string, unknown>).index)
  return {
    v: 1,
    requestId: root.requestId as string,
    opId: root.opId as string,
    op: OP_ACCEPT,
    idempotencyKey: root.idempotencyKey as string,
    context: {
      directory: (root.context as Record<string, unknown>).directory as string,
      requestID: (root.context as Record<string, unknown>).requestID as string,
    },
    payload: { index },
  }
}

export function validateSuggestionDismissRequest(raw: unknown): DismissRequest {
  const root = base(raw)
  if (root.op !== OP_DISMISS) throw new Error("op must be suggestion/dismiss")
  const payload = root.payload
  if (!record(payload)) throw new Error("payload must be object")
  if (Object.keys(payload).length !== 0) throw new Error("payload must be empty object for dismiss")
  return {
    v: 1,
    requestId: root.requestId as string,
    opId: root.opId as string,
    op: OP_DISMISS,
    idempotencyKey: root.idempotencyKey as string,
    context: {
      directory: (root.context as Record<string, unknown>).directory as string,
      requestID: (root.context as Record<string, unknown>).requestID as string,
    },
    payload: {},
  }
}

function failed(requestId: string, opId: string, key: string, code: FailureCode): SuggestionFailure {
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
  const parsed = parseSuggestionOpId(req.opId)
  return parsed.requestID === req.context.requestID
}

function scopeFromRaw(raw: unknown): { requestId: string; opId: string; key: string } | null {
  if (!record(raw)) return null
  if (!present(raw.requestId) || !present(raw.opId) || !present(raw.idempotencyKey)) return null
  return { requestId: raw.requestId as string, opId: raw.opId as string, key: raw.idempotencyKey as string }
}

export const acceptSuggestionPrivate = Effect.fn("SuggestionPrivate.accept")(function* (raw: unknown) {
  let req: AcceptRequest
  try {
    req = validateSuggestionAcceptRequest(raw)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("op must be suggestion/")) {
      const ids = scopeFromRaw(raw)
      if (!ids) throw e
      return failed(ids.requestId, ids.opId, ids.key, "scope_mismatch")
    }
    throw e
  }
  if (!bound(req)) return failed(req.requestId, req.opId, req.idempotencyKey, "scope_mismatch")
  // Pending suggestions are globally unique by request ID; directory is
  // routing/snapshot binding only with no ownership filtering.
  const pending = yield* Effect.promise(() => Suggestion.list())
  const found = pending.find((entry) => entry.id === (req.context.requestID as unknown as typeof entry.id))
  if (!found) return failed(req.requestId, req.opId, req.idempotencyKey, "suggestion.not_found")
  const index = req.payload.index
  const action = found.actions[index]
  // Preserve current side-effect semantics: Suggestion.accept deletes the
  // pending entry and rejects the waiter on invalid index, then returns
  // false. Both unknown and invalid-index outcomes surface as
  // suggestion.not_found with no content in diagnostics.
  const ok = yield* Effect.promise(() =>
    Suggestion.accept({ requestID: req.context.requestID, index }),
  )
  if (!ok) return failed(req.requestId, req.opId, req.idempotencyKey, "suggestion.not_found")
  if (!action) return failed(req.requestId, req.opId, req.idempotencyKey, "suggestion.not_found")
  const sid = String(found.sessionID)
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
    index,
    action: {
      label: action.label,
      ...(action.description !== undefined ? { description: action.description } : {}),
      prompt: action.prompt,
    },
  } satisfies AcceptTerminal
})

export const dismissSuggestionPrivate = Effect.fn("SuggestionPrivate.dismiss")(function* (raw: unknown) {
  let req: DismissRequest
  try {
    req = validateSuggestionDismissRequest(raw)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("op must be suggestion/")) {
      const ids = scopeFromRaw(raw)
      if (!ids) throw e
      return failed(ids.requestId, ids.opId, ids.key, "scope_mismatch")
    }
    throw e
  }
  if (!bound(req)) return failed(req.requestId, req.opId, req.idempotencyKey, "scope_mismatch")
  const pending = yield* Effect.promise(() => Suggestion.list())
  const found = pending.find((entry) => entry.id === (req.context.requestID as unknown as typeof entry.id))
  if (!found) return failed(req.requestId, req.opId, req.idempotencyKey, "suggestion.not_found")
  const sid = String(found.sessionID)
  const rid = String(found.id)
  const done = yield* Effect.promise(() => Suggestion.dismiss(req.context.requestID))
  if (!done) return failed(req.requestId, req.opId, req.idempotencyKey, "suggestion.not_found")
  return {
    kind: "terminal",
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: true,
    terminal: true,
    sessionID: sid,
    requestID: rid,
  } satisfies DismissTerminal
})
