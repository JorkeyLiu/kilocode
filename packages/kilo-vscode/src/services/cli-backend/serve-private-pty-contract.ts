// Private-first `pty/create` + `pty/update` + `pty/remove` contract (production).
// Requests are strictly `{v:1,requestId,opId,op, idempotencyKey,
// context:{directory[,ptyID]},payload}` with `opId === idempotencyKey`,
// `opId === pty-create:<token>` (create: single opaque pathless token, no
// ptyID exists yet), `opId === pty-update:<ptyID>:<token>` or
// `pty-remove:<ptyID>:<token>` (single opaque pathless token, ptyID-bound),
// canonical absolute `context.directory`, bound `ptyID` (update/remove), and
// closed payload (create: command/args/cwd/title/env only; `update`: size
// rows/cols only; `remove`: empty). One request-scoped token; no durable
// replay/journal promise (create is non-idempotent: one accepted call spawns
// one PTY, so the op never retries).
//
// Source facts:
// - Private entry: `packages/opencode/src/kilocode/pty-private.ts`
//   (`pty/create` + `pty/update` + `pty/remove` FD ops, strict validation,
//   existing drain-control + `InstanceRef` lane, per-directory `Pty.Service`
//   via the AppLayer-owned dedicated `PtyServiceMap` — the same instance
//   AppLayer provides to HTTP, WS, and fd ops, so fd ops and HTTP
//   `POST /pty` + `PUT/DELETE /pty/:ptyID` share one owner; create runs the
//   same `PtyPreparation.prepareCreate` as HTTP; redacted terminal failures,
//   no journal/replay).
// - Consumer: `packages/kilo-vscode/src/kilo-provider/pty-privatefirst.ts`
//   is private-first: validated success and validated terminal
//   (`retryable === false`) close with zero SDK; fence/unavailable/invalid/
//   ambiguous/transport/closed/timeout takes exactly one same-tuple SDK
//   fallback. Update and remove are idempotent, so ambiguous may safely
//   fallback once; create is non-idempotent, so at most one private attempt
//   plus at most one SDK fallback with no retry on either path.

import { isAbsolute } from "path"

function record(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}
function present(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

function pathless(v: string): boolean {
  return !v.includes("/") && !v.includes("\\") && !v.includes("\0")
}

function isPtyID(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length > 0 &&
    (v as string).startsWith("pty") &&
    !(v as string).includes("\0") &&
    !(v as string).includes("/") &&
    !(v as string).includes("\\") &&
    !(v as string).includes(":")
  )
}

export const PTY_CREATE_OP = "pty/create" as const
export const PTY_UPDATE_OP = "pty/update" as const
export const PTY_REMOVE_OP = "pty/remove" as const

export function canonicalPtyCreateOpId(token: string): string {
  if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
  if (token.includes(":")) throw new TypeError("token must not contain ':'")
  if (!pathless(token)) throw new TypeError("token must not carry path material")
  return `pty-create:${token}`
}

export function canonicalPtyUpdateOpId(ptyID: string, token: string): string {
  if (!isPtyID(ptyID)) throw new TypeError("ptyID must be opaque PtyID")
  if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
  if (token.includes(":")) throw new TypeError("token must not contain ':'")
  if (!pathless(token)) throw new TypeError("token must not carry path material")
  return `pty-update:${ptyID}:${token}`
}

export function canonicalPtyRemoveOpId(ptyID: string, token: string): string {
  if (!isPtyID(ptyID)) throw new TypeError("ptyID must be opaque PtyID")
  if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
  if (token.includes(":")) throw new TypeError("token must not contain ':'")
  if (!pathless(token)) throw new TypeError("token must not carry path material")
  return `pty-remove:${ptyID}:${token}`
}

function parseCreateOpId(opId: string): { token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  const segs = opId.split(":")
  if (segs.length !== 2 || segs[0] !== "pty-create" || segs[1]!.length === 0)
    throw new TypeError("opId must be pty-create:<token>")
  const token = segs[1]!
  if (!pathless(token)) throw new TypeError("opId token must not carry path material")
  return { token }
}

function parseUpdateOpId(opId: string): { ptyID: string; token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  const segs = opId.split(":")
  if (segs.length !== 3 || segs[0] !== "pty-update" || segs[1]!.length === 0 || segs[2]!.length === 0)
    throw new TypeError("opId must be pty-update:<ptyID>:<token>")
  const ptyID = segs[1]!
  const token = segs[2]!
  if (!isPtyID(ptyID)) throw new TypeError("opId ptyID binding invalid")
  if (!pathless(token)) throw new TypeError("opId token must not carry path material")
  return { ptyID, token }
}

function parseRemoveOpId(opId: string): { ptyID: string; token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  const segs = opId.split(":")
  if (segs.length !== 3 || segs[0] !== "pty-remove" || segs[1]!.length === 0 || segs[2]!.length === 0)
    throw new TypeError("opId must be pty-remove:<ptyID>:<token>")
  const ptyID = segs[1]!
  const token = segs[2]!
  if (!isPtyID(ptyID)) throw new TypeError("opId ptyID binding invalid")
  if (!pathless(token)) throw new TypeError("opId token must not carry path material")
  return { ptyID, token }
}

export interface PtyCreateContractRequest {
  v: 1
  requestId: string
  opId: string
  op: typeof PTY_CREATE_OP
  idempotencyKey: string
  context: { directory: string }
  payload: { command?: string; args?: string[]; cwd?: string; title?: string; env?: Record<string, string> }
}

export interface PtyUpdateContractRequest {
  v: 1
  requestId: string
  opId: string
  op: typeof PTY_UPDATE_OP
  idempotencyKey: string
  context: { directory: string; ptyID: string }
  payload: { size: { rows: number; cols: number } }
}

export interface PtyRemoveContractRequest {
  v: 1
  requestId: string
  opId: string
  op: typeof PTY_REMOVE_OP
  idempotencyKey: string
  context: { directory: string; ptyID: string }
  payload: Record<string, never>
}

function validateIds(raw: Record<string, unknown>, op: string): void {
  if (raw.v !== 1) throw new Error("v must be 1")
  if (!present(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!present(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== op) throw new Error(`op must be ${op}`)
  if (!present(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId")
  if (!pathless(raw.requestId as string)) throw new Error("requestId must not carry path material")
  if (!pathless(raw.opId as string)) throw new Error("opId must not carry path material")
  if (!pathless(raw.idempotencyKey as string)) throw new Error("idempotencyKey must not carry path material")
}

function validateCtx(raw: unknown): { directory: string; ptyID: string } {
  if (!record(raw)) throw new Error("context must be object")
  const allowed = new Set(["directory", "ptyID"])
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new Error("unexpected context field")
  if (typeof raw.directory !== "string" || raw.directory.length === 0)
    throw new Error("context.directory must be non-empty string")
  if (!isAbsolute(raw.directory) || (raw.directory as string).includes("\0"))
    throw new Error("context.directory must be absolute path")
  if (!isPtyID((raw as Record<string, unknown>).ptyID)) throw new Error("context.ptyID must be PtyID")
  return { directory: raw.directory as string, ptyID: (raw as Record<string, unknown>).ptyID as string }
}

function validateCreateCtx(raw: unknown): { directory: string } {
  if (!record(raw)) throw new Error("context must be object")
  const allowed = new Set(["directory"])
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new Error("unexpected context field")
  if (typeof raw.directory !== "string" || raw.directory.length === 0)
    throw new Error("context.directory must be non-empty string")
  if (!isAbsolute(raw.directory) || (raw.directory as string).includes("\0"))
    throw new Error("context.directory must be absolute path")
  return { directory: raw.directory as string }
}

function checkCreateCommand(raw: unknown): string | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== "string" || raw.length === 0 || raw.includes("\0"))
    throw new Error("payload.command must be non-empty string")
  return raw
}

function checkCreateArgs(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) throw new Error("payload.args must be string array")
  for (const a of raw) {
    if (typeof a !== "string" || a.includes("\0")) throw new Error("payload.args must be string array")
  }
  return [...(raw as string[])]
}

function checkCreateCwd(raw: unknown): string | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== "string" || raw.length === 0 || raw.includes("\0"))
    throw new Error("payload.cwd must be non-empty string")
  return raw
}

function checkCreateTitle(raw: unknown): string | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 200 || raw.includes("\0"))
    throw new Error("payload.title must be non-empty string")
  return raw
}

function checkCreateEnv(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined) return undefined
  if (!record(raw)) throw new Error("payload.env must be string record")
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (k.length === 0 || k.includes("\0") || k.includes("=")) throw new Error("payload.env must be string record")
    if (k === "__proto__" || k === "constructor" || k === "prototype")
      throw new Error("payload.env must be string record")
    if (typeof v !== "string" || v.includes("\0")) throw new Error("payload.env must be string record")
    env[k] = v
  }
  return env
}

function validateCreatePayload(raw: unknown): PtyCreateContractRequest["payload"] {
  if (!record(raw)) throw new Error("payload must be object")
  const allowed = new Set(["command", "args", "cwd", "title", "env"])
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new Error("unexpected payload field")
  const out: PtyCreateContractRequest["payload"] = {}
  const command = checkCreateCommand(raw.command)
  if (command !== undefined) out.command = command
  const args = checkCreateArgs(raw.args)
  if (args !== undefined) out.args = args
  const cwd = checkCreateCwd(raw.cwd)
  if (cwd !== undefined) out.cwd = cwd
  const title = checkCreateTitle(raw.title)
  if (title !== undefined) out.title = title
  const env = checkCreateEnv(raw.env)
  if (env !== undefined) out.env = env
  return out
}

export function validatePtyCreateContractRequest(raw: unknown): PtyCreateContractRequest {
  if (!record(raw)) throw new Error("request must be object")
  validateIds(raw, PTY_CREATE_OP)
  const ctx = validateCreateCtx(raw.context)
  if (!record(raw.payload)) throw new Error("payload must be object")
  validateCreatePayload(raw.payload)
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw)) if (!allowedRoot.has(k)) throw new Error("unexpected field")
  const parsed = parseCreateOpId(raw.opId as string)
  const idem = parseCreateOpId(raw.idempotencyKey as string)
  if (idem.token !== parsed.token) throw new Error("idempotencyKey token must equal opId token")
  return raw as unknown as PtyCreateContractRequest
}

function validateSize(raw: unknown): { rows: number; cols: number } {
  if (!record(raw)) throw new Error("payload.size must be object")
  const keys = Object.keys(raw)
  if (keys.length !== 2 || !keys.includes("rows") || !keys.includes("cols"))
    throw new Error("payload.size must be {rows,cols} only")
  if (typeof raw.rows !== "number" || !Number.isSafeInteger(raw.rows) || (raw.rows as number) < 1)
    throw new Error("payload.size.rows must be positive integer")
  if (typeof raw.cols !== "number" || !Number.isSafeInteger(raw.cols) || (raw.cols as number) < 1)
    throw new Error("payload.size.cols must be positive integer")
  return { rows: raw.rows as number, cols: raw.cols as number }
}

export function validatePtyUpdateContractRequest(raw: unknown): PtyUpdateContractRequest {
  if (!record(raw)) throw new Error("request must be object")
  validateIds(raw, PTY_UPDATE_OP)
  const ctx = validateCtx(raw.context)
  if (!record(raw.payload)) throw new Error("payload must be object")
  for (const k of Object.keys(raw.payload as Record<string, unknown>))
    if (k !== "size") throw new Error("unexpected payload field")
  const size = validateSize((raw.payload as Record<string, unknown>).size)
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw)) if (!allowedRoot.has(k)) throw new Error("unexpected field")
  const parsed = parseUpdateOpId(raw.opId as string)
  if (parsed.ptyID !== ctx.ptyID) throw new Error("opId ptyID binding mismatch")
  const idem = parseUpdateOpId(raw.idempotencyKey as string)
  if (idem.ptyID !== ctx.ptyID || idem.token !== parsed.token)
    throw new Error("idempotencyKey token must equal opId token")
  return raw as unknown as PtyUpdateContractRequest
}

export function validatePtyRemoveContractRequest(raw: unknown): PtyRemoveContractRequest {
  if (!record(raw)) throw new Error("request must be object")
  validateIds(raw, PTY_REMOVE_OP)
  const ctx = validateCtx(raw.context)
  if (!record(raw.payload)) throw new Error("payload must be object")
  if (Object.keys(raw.payload as Record<string, unknown>).length !== 0)
    throw new Error("payload must be empty object for pty-remove")
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw)) if (!allowedRoot.has(k)) throw new Error("unexpected field")
  const parsed = parseRemoveOpId(raw.opId as string)
  if (parsed.ptyID !== ctx.ptyID) throw new Error("opId ptyID binding mismatch")
  const idem = parseRemoveOpId(raw.idempotencyKey as string)
  if (idem.ptyID !== ctx.ptyID || idem.token !== parsed.token)
    throw new Error("idempotencyKey token must equal opId token")
  return raw as unknown as PtyRemoveContractRequest
}

export interface PtyFailure {
  code: string
  message: string
  retryable: boolean
}

export type PtyCreateResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: typeof PTY_CREATE_OP
      idempotencyKey: string
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: { id: string; title: string }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: typeof PTY_CREATE_OP
      idempotencyKey: string
      status: "failed"
      outcome: { type: "failed"; time: number; failure: PtyFailure }
      accepted: boolean
      failure: PtyFailure
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: typeof PTY_CREATE_OP
      idempotencyKey: string
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      transportUnknown?: boolean
    }

export type PtyUpdateResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: typeof PTY_UPDATE_OP
      idempotencyKey: string
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: { updated: true }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: typeof PTY_UPDATE_OP
      idempotencyKey: string
      status: "failed"
      outcome: { type: "failed"; time: number; failure: PtyFailure }
      accepted: boolean
      failure: PtyFailure
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: typeof PTY_UPDATE_OP
      idempotencyKey: string
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      transportUnknown?: boolean
    }

export type PtyRemoveResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: typeof PTY_REMOVE_OP
      idempotencyKey: string
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: { removed: true }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: typeof PTY_REMOVE_OP
      idempotencyKey: string
      status: "failed"
      outcome: { type: "failed"; time: number; failure: PtyFailure }
      accepted: boolean
      failure: PtyFailure
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: typeof PTY_REMOVE_OP
      idempotencyKey: string
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      transportUnknown?: boolean
    }

export function makePtyCreateAmbiguous(req: PtyCreateContractRequest, transportUnknown = true): PtyCreateResult {
  const out = {
    v: 1 as const,
    requestId: req.requestId,
    opId: req.opId,
    op: "pty/create" as const,
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous" as const,
    outcome: { type: "ambiguous" as const, time: Date.now() },
    accepted: false as const,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

export function makePtyUpdateAmbiguous(req: PtyUpdateContractRequest, transportUnknown = true): PtyUpdateResult {
  const out = {
    v: 1 as const,
    requestId: req.requestId,
    opId: req.opId,
    op: "pty/update" as const,
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous" as const,
    outcome: { type: "ambiguous" as const, time: Date.now() },
    accepted: false as const,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

export function makePtyRemoveAmbiguous(req: PtyRemoveContractRequest, transportUnknown = true): PtyRemoveResult {
  const out = {
    v: 1 as const,
    requestId: req.requestId,
    opId: req.opId,
    op: "pty/remove" as const,
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous" as const,
    outcome: { type: "ambiguous" as const, time: Date.now() },
    accepted: false as const,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

// Redacted failure shape ({code,message,retryable} only). Path, directory,
// pty, token, ws, auth, create-payload (command/args/cwd/title/env), and
// transport echo keys are rejected.
const FAILURE_FORBIDDEN = new Set([
  "ptyID",
  "ptyId",
  "directory",
  "workspace",
  "token",
  "stack",
  "data",
  "wsUrl",
  "auth",
  "env",
  "command",
  "args",
  "cwd",
  "title",
  "payload",
  "size",
])

const FAILURE_FIELDS = new Set(["code", "message", "retryable"])

// Only CLI-authoritative terminal codes plus the local fixed `transport`
// fallback are accepted; anything else is invalid wire and fails closed to
// the SDK fallback. The CLI never emits `transport` (it emits the five codes
// below); the extension peer helper synthesizes fixed `transport` failures
// for thrown fd errors so the helper's explicit `transport` branch stays
// reachable without echoing raw host codes or error strings.
const FAILURE_CODES = new Set([
  "validation.failed",
  "scope_mismatch",
  "pty.not_found",
  "internal",
  "InstanceUnavailableDuringConfigRebuild",
  "transport",
])

export function validatePtyFailure(raw: unknown): PtyFailure {
  if (!record(raw)) throw new Error("failure must be object")
  for (const k of Object.keys(raw)) {
    if (FAILURE_FORBIDDEN.has(k)) throw new Error("failure must not carry raw field")
  }
  for (const k of Object.keys(raw)) if (!FAILURE_FIELDS.has(k)) throw new Error("unexpected failure field")
  if (!present(raw.code)) throw new Error("failure code must be non-empty string")
  if (!FAILURE_CODES.has(raw.code as string)) throw new Error("failure code is not CLI-authoritative")
  if (!present(raw.message)) throw new Error("failure message must be non-empty string")
  if (typeof raw.retryable !== "boolean") throw new Error("failure retryable must be boolean")
  return raw as unknown as PtyFailure
}

export type PtyCreateWireOutcome = { kind: "valid"; result: PtyCreateResult } | { kind: "invalid"; detail: string }
export type PtyUpdateWireOutcome = { kind: "valid"; result: PtyUpdateResult } | { kind: "invalid"; detail: string }
export type PtyRemoveWireOutcome = { kind: "valid"; result: PtyRemoveResult } | { kind: "invalid"; detail: string }

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
export function validatePtyCreateResult(raw: unknown, req: PtyCreateContractRequest): PtyCreateResult {
  if (!record(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== PTY_CREATE_OP) throw new Error("op mismatch")
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
    for (const k of Object.keys(rec)) if (!RESULT_SUCCEEDED.has(k)) throw new Error("unexpected result field")
    for (const k of Object.keys(outRec)) if (!OUTCOME_PLAIN.has(k)) throw new Error("unexpected outcome field")
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    const data = rec.data
    if (!record(data)) throw new Error("succeeded data must be object")
    for (const k of Object.keys(data)) if (k !== "id" && k !== "title") throw new Error("unexpected data field")
    if (!isPtyID((data as Record<string, unknown>).id)) throw new Error("succeeded data.id must be PtyID")
    if (
      typeof (data as Record<string, unknown>).title !== "string" ||
      ((data as Record<string, unknown>).title as string).length === 0
    )
      throw new Error("succeeded data.title must be non-empty string")
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (outRec.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as PtyCreateResult
  }
  if (status === "failed") {
    for (const k of Object.keys(rec)) if (!RESULT_FAILED.has(k)) throw new Error("unexpected result field")
    for (const k of Object.keys(outRec)) if (!OUTCOME_FAILED.has(k)) throw new Error("unexpected outcome field")
    const failure = validatePtyFailure(rec.failure)
    const outFailure = validatePtyFailure(outRec.failure)
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    if (rec.data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as PtyCreateResult
  }
  for (const k of Object.keys(rec)) if (!RESULT_AMBIGUOUS.has(k)) throw new Error("unexpected result field")
  for (const k of Object.keys(outRec)) if (!OUTCOME_PLAIN.has(k)) throw new Error("unexpected outcome field")
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (outRec.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as PtyCreateResult
}

// eslint-disable-next-line complexity
export function validatePtyUpdateResult(raw: unknown, req: PtyUpdateContractRequest): PtyUpdateResult {
  if (!record(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== PTY_UPDATE_OP) throw new Error("op mismatch")
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
    for (const k of Object.keys(rec)) if (!RESULT_SUCCEEDED.has(k)) throw new Error("unexpected result field")
    for (const k of Object.keys(outRec)) if (!OUTCOME_PLAIN.has(k)) throw new Error("unexpected outcome field")
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    const data = rec.data
    if (!record(data)) throw new Error("succeeded data must be object")
    for (const k of Object.keys(data)) if (k !== "updated") throw new Error("unexpected data field")
    if (data.updated !== true) throw new Error("succeeded data.updated must be true")
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (outRec.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as PtyUpdateResult
  }
  if (status === "failed") {
    for (const k of Object.keys(rec)) if (!RESULT_FAILED.has(k)) throw new Error("unexpected result field")
    for (const k of Object.keys(outRec)) if (!OUTCOME_FAILED.has(k)) throw new Error("unexpected outcome field")
    const failure = validatePtyFailure(rec.failure)
    const outFailure = validatePtyFailure(outRec.failure)
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    if (rec.data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as PtyUpdateResult
  }
  for (const k of Object.keys(rec)) if (!RESULT_AMBIGUOUS.has(k)) throw new Error("unexpected result field")
  for (const k of Object.keys(outRec)) if (!OUTCOME_PLAIN.has(k)) throw new Error("unexpected outcome field")
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (outRec.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as PtyUpdateResult
}

// eslint-disable-next-line complexity
export function validatePtyRemoveResult(raw: unknown, req: PtyRemoveContractRequest): PtyRemoveResult {
  if (!record(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== PTY_REMOVE_OP) throw new Error("op mismatch")
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
    for (const k of Object.keys(rec)) if (!RESULT_SUCCEEDED.has(k)) throw new Error("unexpected result field")
    for (const k of Object.keys(outRec)) if (!OUTCOME_PLAIN.has(k)) throw new Error("unexpected outcome field")
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    const data = rec.data
    if (!record(data)) throw new Error("succeeded data must be object")
    for (const k of Object.keys(data)) if (k !== "removed") throw new Error("unexpected data field")
    if (data.removed !== true) throw new Error("succeeded data.removed must be true")
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (outRec.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as PtyRemoveResult
  }
  if (status === "failed") {
    for (const k of Object.keys(rec)) if (!RESULT_FAILED.has(k)) throw new Error("unexpected result field")
    for (const k of Object.keys(outRec)) if (!OUTCOME_FAILED.has(k)) throw new Error("unexpected outcome field")
    const failure = validatePtyFailure(rec.failure)
    const outFailure = validatePtyFailure(outRec.failure)
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    if (rec.data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as PtyRemoveResult
  }
  for (const k of Object.keys(rec)) if (!RESULT_AMBIGUOUS.has(k)) throw new Error("unexpected result field")
  for (const k of Object.keys(outRec)) if (!OUTCOME_PLAIN.has(k)) throw new Error("unexpected outcome field")
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (outRec.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as PtyRemoveResult
}

export function isSettledPtyCreateResult(result: unknown, req: PtyCreateContractRequest): boolean {
  if (!record(result)) return false
  const status = (result as { status?: unknown }).status
  if (status !== "succeeded" && status !== "failed") return false
  try {
    const out = validatePtyCreateResult(result, req)
    if (out.status === "succeeded") return true
    if (out.status === "failed") return out.failure.retryable === false
    return false
  } catch {
    return false
  }
}

export function isSettledPtyUpdateResult(result: unknown, req: PtyUpdateContractRequest): boolean {
  if (!record(result)) return false
  const status = (result as { status?: unknown }).status
  if (status !== "succeeded" && status !== "failed") return false
  try {
    const out = validatePtyUpdateResult(result, req)
    if (out.status === "succeeded") return true
    if (out.status === "failed") return out.failure.retryable === false
    return false
  } catch {
    return false
  }
}

export function isSettledPtyRemoveResult(result: unknown, req: PtyRemoveContractRequest): boolean {
  if (!record(result)) return false
  const status = (result as { status?: unknown }).status
  if (status !== "succeeded" && status !== "failed") return false
  try {
    const out = validatePtyRemoveResult(result, req)
    if (out.status === "succeeded") return true
    if (out.status === "failed") return out.failure.retryable === false
    return false
  } catch {
    return false
  }
}
