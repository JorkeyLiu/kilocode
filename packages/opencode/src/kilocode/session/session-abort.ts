import { Effect } from "effect"
import { canonicalDirectory } from "@/kilocode/session/canonical-directory"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { SessionID } from "@/session/schema"
import { NotFoundError } from "@/storage/storage"
import { KiloSessionPrompt } from "@/kilocode/session/prompt"

export const VERSION = 1 as const
export const OP = "session/abort" as const

export interface AbortRequest {
  v: typeof VERSION
  requestId: string
  opId: string
  op: typeof OP
  idempotencyKey: string
  context: {
    directory: string
    sessionId: string
  }
  payload: Record<string, never>
}

export interface AbortAffected {
  kind: "root" | "descendant"
  disposition: "cancelled" | "not_affected"
  generationId: string
  sessionId: string
}

export interface AbortSucceeded {
  kind: "terminal"
  v: typeof VERSION
  requestId: string
  opId: string
  idempotencyKey: string
  accepted: true
  terminal: true
  affected: AbortAffected[]
  diagnostic: { code: string; retryable: false; time: number }
}

export interface AbortFailed {
  kind: "terminal-failure"
  v: typeof VERSION
  requestId: string
  opId: string
  idempotencyKey: string
  accepted: false
  terminal: true
  failure: { code: string; retryable: false; time: number }
  sideEffect: false
}

export type AbortResult = AbortSucceeded | AbortFailed

function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

export function parseAbortOpId(opId: string): { sessionId: string; token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new Error("opId must be non-empty string")
  const segs = opId.split(":")
  if (segs.length !== 3) throw new Error(`abort opId must have 2 segments: ${opId}`)
  if (segs[0] !== "abort") throw new Error(`opId kind must be abort: ${opId}`)
  const sid = segs[1]!
  const token = segs[2]!
  if (sid.length === 0 || token.length === 0) throw new Error(`opId segment must be non-empty: ${opId}`)
  if (token.includes(":")) throw new Error("opId token must not contain ':'")
  return { sessionId: sid, token }
}

// eslint-disable-next-line complexity
export function validateAbortRequest(raw: unknown): AbortRequest {
  if (!isRecord(raw)) throw new Error("request must be object")
  if (raw.v !== 1) throw new Error("v must be 1")
  if (!nonEmpty(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!nonEmpty(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== OP) throw new Error("op must be session/abort")
  if (!nonEmpty(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId for abort")
  const ctx = raw.context
  if (!isRecord(ctx)) throw new Error("context must be object")
  for (const k of Object.keys(ctx)) {
    if (k !== "directory" && k !== "sessionId") throw new Error(`unexpected context field ${k}`)
  }
  if (typeof ctx.directory !== "string" || ctx.directory.length === 0) throw new Error("context.directory must be non-empty string")
  canonicalDirectory(ctx.directory as string)
  if (typeof ctx.sessionId !== "string" || !(ctx.sessionId as string).startsWith("ses"))
    throw new Error("context.sessionId must be SessionID")
  const payload = raw.payload
  if (!isRecord(payload)) throw new Error("payload must be object")
  if (Object.keys(payload).length !== 0) throw new Error("payload must be empty object for abort")
  for (const k of Object.keys(raw)) {
    if (!["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"].includes(k))
      throw new Error(`unexpected field ${k}`)
  }
  const parsed = parseAbortOpId(raw.opId as string)
  if (parsed.sessionId !== (ctx.sessionId as string))
    throw new Error(`opId session binding mismatch: ${raw.opId} vs ${ctx.sessionId}`)
  const idem = parseAbortOpId(raw.idempotencyKey as string)
  if (idem.sessionId !== (ctx.sessionId as string)) throw new Error("idempotencyKey session binding mismatch")
  if (idem.token !== parsed.token) throw new Error("idempotencyKey token must equal opId token")
  return raw as unknown as AbortRequest
}

function failed(req: AbortRequest, code: string): AbortFailed {
  return {
    kind: "terminal-failure",
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: false,
    terminal: true,
    failure: { code, retryable: false as const, time: Date.now() },
    sideEffect: false as const,
  }
}

// Terminal abort: validates scope, awaits the existing cancellation owner
// (KiloSessionPrompt.cancelTree over SessionRunState) until the targeted
// active epoch/finalizer converges, then returns. Never invents a terminal
// turn; generationIDs come only from the owner's CancelTreeResult.
// Namespace isolation: owner generations are minted as `gen_<hex><base62>`
// by Runner while request tokens are `crypto.randomUUID()` hex/dash strings,
// so a generation can never equal the request token by construction and no
// post-cancel token comparison exists here. Every `terminal-failure` below
// returns before any cancellation signal.
export const abortSession = Effect.fn("SessionAbort.abort")(function* (raw: unknown) {
  const req = validateAbortRequest(raw)
  const dir = canonicalDirectory(req.context.directory)
  const sid = SessionID.make(req.context.sessionId)
  const sessions = yield* Session.Service
  const state = yield* SessionRunState.Service
  const found = yield* sessions.get(sid).pipe(
    Effect.map((v) => ({ tag: "ok" as const, value: v })),
    Effect.catch((err: unknown) => {
      const missing = err instanceof NotFoundError || (err as { _tag?: string })?._tag === "NotFoundError"
      if (missing) return Effect.succeed({ tag: "fail" as const, code: "session.not_found" })
      return Effect.die(err)
    }),
    Effect.catchDefect((defect: unknown) => Effect.die(defect)),
  )
  if (found.tag !== "ok") return failed(req, found.code)
  let stored: string
  try {
    stored = canonicalDirectory(found.value.directory)
  } catch {
    return failed(req, "scope_mismatch")
  }
  if (stored !== dir) return failed(req, "scope_mismatch")
  const tree = yield* KiloSessionPrompt.cancelTree({
    sessionID: sid,
    sessions,
    cancel: (id: SessionID) => state.cancel(id),
  })
  const affected: AbortAffected[] = []
  for (const gen of tree.generations) {
    if (!gen.generationID) continue
    affected.push({
      kind: gen.sessionID === sid ? "root" : "descendant",
      disposition: gen.wasBusy ? "cancelled" : "not_affected",
      generationId: gen.generationID,
      sessionId: gen.sessionID,
    })
  }
  return {
    kind: "terminal",
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: true,
    terminal: true,
    affected,
    diagnostic: { code: "cancelled", retryable: false as const, time: Date.now() },
  } satisfies AbortSucceeded
})
