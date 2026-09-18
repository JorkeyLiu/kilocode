import { Effect, Schema } from "effect"
import { canonicalDirectory } from "@/kilocode/session/canonical-directory"
import { Permission } from "@/permission"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"

export const VERSION = 1 as const
export const OP_SAVE = "permission/save-always-rules" as const
export const OP_REPLY = "permission/reply" as const

export type Op = typeof OP_SAVE | typeof OP_REPLY
export type FailureCode = "permission.not_found" | "scope_mismatch" | "validation.failed" | "internal"

export interface SaveRequest {
  v: typeof VERSION
  requestId: string
  opId: string
  op: typeof OP_SAVE
  idempotencyKey: string
  context: { directory: string; requestID: string }
  payload: { approvedAlways?: string[]; deniedAlways?: string[] }
}

export interface ReplyRequest {
  v: typeof VERSION
  requestId: string
  opId: string
  op: typeof OP_REPLY
  idempotencyKey: string
  context: { directory: string; requestID: string }
  payload: { reply: PermissionV1.Reply; message?: string }
}

export interface SaveTerminal {
  kind: "terminal"
  v: typeof VERSION
  requestId: string
  opId: string
  idempotencyKey: string
  accepted: true
  terminal: true
  requestID: string
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
  reply: PermissionV1.Reply
}

export interface PermissionFailure {
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

export type PermissionResult = SaveTerminal | ReplyTerminal | PermissionFailure

function record(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function present(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

function decodedPermissionID(v: unknown): string {
  return Schema.decodeUnknownSync(PermissionV1.ID)(v) as unknown as string
}

export function canonicalPermissionOpId(requestID: string, token: string): string {
  const id = decodedPermissionID(requestID)
  if (id.includes("\0")) throw new Error("requestID must not contain null bytes")
  if (typeof token !== "string" || token.length === 0) throw new Error("token must be non-empty string")
  if (token.includes(":")) throw new Error("token must not contain ':'")
  if (token.includes("\0")) throw new Error("token must not contain null bytes")
  return `permission:${id}:${token}`
}

export function parsePermissionOpId(opId: string): { requestID: string; token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new Error("opId must be non-empty string")
  if (opId.includes("\0")) throw new Error("opId must not contain null bytes")
  const segs = opId.split(":")
  if (segs.length !== 3) throw new Error(`permission opId must have 2 segments: ${opId}`)
  if (segs[0] !== "permission") throw new Error(`opId kind must be permission: ${opId}`)
  const rid = decodedPermissionID(segs[1])
  if (rid.includes("\0")) throw new Error("opId requestID must not contain null bytes")
  const token = segs[2]!
  if (token.length === 0) throw new Error(`opId token must be non-empty: ${opId}`)
  if (token.includes(":")) throw new Error("opId token must not contain ':'")
  if (token.includes("\0")) throw new Error("opId token must not contain null bytes")
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
  if (raw.op !== OP_SAVE && raw.op !== OP_REPLY) throw new Error("op must be permission/save-always-rules or permission/reply")
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
  const rid = decodedPermissionID(ctx.requestID)
  if (rid.includes("\0")) throw new Error("context.requestID must not contain null bytes")
  const parsed = parsePermissionOpId(raw.opId as string)
  const idem = parsePermissionOpId(raw.idempotencyKey as string)
  if (idem.requestID !== parsed.requestID) throw new Error("idempotencyKey request binding mismatch")
  if (idem.token !== parsed.token) throw new Error("idempotencyKey token must equal opId token")
  return raw as Record<string, unknown>
}

function stringArray(v: unknown, label: string): string[] {
  if (!Array.isArray(v)) throw new Error(`${label} must be array`)
  for (const e of v) {
    if (typeof e !== "string") throw new Error(`${label} entries must be strings`)
    if (e.includes("\0")) throw new Error(`${label} entries must not contain null bytes`)
  }
  return [...(v as string[])]
}

export function validatePermissionSaveRequest(raw: unknown): SaveRequest {
  const root = base(raw)
  if (root.op !== OP_SAVE) throw new Error("op must be permission/save-always-rules")
  const payload = root.payload
  if (!record(payload)) throw new Error("payload must be object")
  const allowed = new Set(["approvedAlways", "deniedAlways"])
  for (const k of Object.keys(payload)) {
    if (!allowed.has(k)) throw new Error(`unexpected payload field ${k}`)
  }
  const out: SaveRequest = {
    v: 1,
    requestId: root.requestId as string,
    opId: root.opId as string,
    op: OP_SAVE,
    idempotencyKey: root.idempotencyKey as string,
    context: {
      directory: (root.context as Record<string, unknown>).directory as string,
      requestID: (root.context as Record<string, unknown>).requestID as string,
    },
    payload: {},
  }
  if (payload.approvedAlways !== undefined) out.payload.approvedAlways = stringArray(payload.approvedAlways, "payload.approvedAlways")
  if (payload.deniedAlways !== undefined) out.payload.deniedAlways = stringArray(payload.deniedAlways, "payload.deniedAlways")
  return out
}

export function validatePermissionReplyRequest(raw: unknown): ReplyRequest {
  const root = base(raw)
  if (root.op !== OP_REPLY) throw new Error("op must be permission/reply")
  const payload = root.payload
  if (!record(payload)) throw new Error("payload must be object")
  const allowed = new Set(["reply", "message"])
  for (const k of Object.keys(payload)) {
    if (!allowed.has(k)) throw new Error(`unexpected payload field ${k}`)
  }
  const reply = Schema.decodeUnknownSync(PermissionV1.Reply)(payload.reply)
  let message: string | undefined
  if (payload.message !== undefined) {
    if (typeof payload.message !== "string") throw new Error("payload.message must be string")
    if (payload.message.includes("\0")) throw new Error("payload.message must not contain null bytes")
    message = payload.message
  }
  return {
    v: 1,
    requestId: root.requestId as string,
    opId: root.opId as string,
    op: OP_REPLY,
    idempotencyKey: root.idempotencyKey as string,
    context: {
      directory: (root.context as Record<string, unknown>).directory as string,
      requestID: (root.context as Record<string, unknown>).requestID as string,
    },
    payload: message !== undefined ? { reply, message } : { reply },
  }
}

function failed(requestId: string, opId: string, key: string, code: FailureCode): PermissionFailure {
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
  const parsed = parsePermissionOpId(req.opId)
  return parsed.requestID === req.context.requestID
}

function scopeFromRaw(raw: unknown): { requestId: string; opId: string; key: string } | null {
  if (!record(raw)) return null
  if (!present(raw.requestId) || !present(raw.opId) || !present(raw.idempotencyKey)) return null
  return { requestId: raw.requestId as string, opId: raw.opId as string, key: raw.idempotencyKey as string }
}

export const savePermissionPrivate = Effect.fn("PermissionPrivate.save")(function* (raw: unknown) {
  let req: SaveRequest
  try {
    req = validatePermissionSaveRequest(raw)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("op must be permission/")) {
      const ids = scopeFromRaw(raw)
      if (!ids) throw e
      return failed(ids.requestId, ids.opId, ids.key, "scope_mismatch")
    }
    throw e
  }
  if (!bound(req)) return failed(req.requestId, req.opId, req.idempotencyKey, "scope_mismatch")
  const svc = yield* Permission.Service
  const done = yield* svc
    .saveAlwaysRules({
      requestID: PermissionV1.ID.make(req.context.requestID),
      approvedAlways: req.payload.approvedAlways ? [...req.payload.approvedAlways] : undefined,
      deniedAlways: req.payload.deniedAlways ? [...req.payload.deniedAlways] : undefined,
    })
    .pipe(
      Effect.map(() => ({ tag: "ok" as const })),
      Effect.catchTag("Permission.NotFoundError", () => Effect.succeed({ tag: "gone" as const })),
    )
  if (done.tag !== "ok") return failed(req.requestId, req.opId, req.idempotencyKey, "permission.not_found")
  return {
    kind: "terminal",
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: true,
    terminal: true,
    requestID: req.context.requestID,
  } satisfies SaveTerminal
})

export const replyPermissionPrivate = Effect.fn("PermissionPrivate.reply")(function* (raw: unknown) {
  let req: ReplyRequest
  try {
    req = validatePermissionReplyRequest(raw)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("op must be permission/")) {
      const ids = scopeFromRaw(raw)
      if (!ids) throw e
      return failed(ids.requestId, ids.opId, ids.key, "scope_mismatch")
    }
    throw e
  }
  if (!bound(req)) return failed(req.requestId, req.opId, req.idempotencyKey, "scope_mismatch")
  const svc = yield* Permission.Service
  const pending = yield* svc.list()
  const found = pending.find((entry) => String(entry.id) === req.context.requestID)
  if (!found) return failed(req.requestId, req.opId, req.idempotencyKey, "permission.not_found")
  const sid = String(found.sessionID)
  const done = yield* svc
    .reply({
      requestID: found.id,
      reply: req.payload.reply,
      ...(req.payload.message !== undefined ? { message: req.payload.message } : {}),
    })
    .pipe(
      Effect.map(() => ({ tag: "ok" as const })),
      Effect.catchTag("Permission.NotFoundError", () => Effect.succeed({ tag: "gone" as const })),
    )
  if (done.tag !== "ok") return failed(req.requestId, req.opId, req.idempotencyKey, "permission.not_found")
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
    reply: req.payload.reply,
  } satisfies ReplyTerminal
})
