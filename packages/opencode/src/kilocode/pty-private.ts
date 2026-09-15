import { Effect } from "effect"
import { Pty } from "@opencode-ai/core/pty"
import { PtyServiceMap } from "@opencode-ai/core/pty-service-map"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { canonicalDirectory } from "@/kilocode/session/canonical-directory"
import { PtyPreparation } from "@/pty-preparation"
import {
  acquireDrainControl,
  InstanceUnavailableDuringConfigRebuildError,
} from "@/kilocode/server/drain-control-acquire"
import { InstanceRef } from "@/effect/instance-ref"

export const VERSION = 1 as const
export const CREATE_OP = "pty/create" as const
export const UPDATE_OP = "pty/update" as const
export const REMOVE_OP = "pty/remove" as const
export const CREATE_CAPABILITY = "pty/create" as const
export const UPDATE_CAPABILITY = "pty/update" as const
export const REMOVE_CAPABILITY = "pty/remove" as const

export interface PtyCreateRequest {
  v: typeof VERSION
  requestId: string
  opId: string
  op: typeof CREATE_OP
  idempotencyKey: string
  context: { directory: string }
  payload: { command?: string; args?: string[]; cwd?: string; title?: string; env?: Record<string, string> }
}

export interface PtyUpdateRequest {
  v: typeof VERSION
  requestId: string
  opId: string
  op: typeof UPDATE_OP
  idempotencyKey: string
  context: { directory: string; ptyID: string }
  payload: { size: { rows: number; cols: number } }
}

export interface PtyRemoveRequest {
  v: typeof VERSION
  requestId: string
  opId: string
  op: typeof REMOVE_OP
  idempotencyKey: string
  context: { directory: string; ptyID: string }
  payload: Record<string, never>
}

export interface PtyFailure {
  code: string
  message: string
  retryable: boolean
}

export interface PtyUpdateSucceeded {
  v: typeof VERSION
  requestId: string
  opId: string
  op: typeof UPDATE_OP
  idempotencyKey: string
  status: "succeeded"
  outcome: { type: "succeeded"; time: number }
  accepted: true
  data: { updated: true }
}

export interface PtyCreateSucceeded {
  v: typeof VERSION
  requestId: string
  opId: string
  op: typeof CREATE_OP
  idempotencyKey: string
  status: "succeeded"
  outcome: { type: "succeeded"; time: number }
  accepted: true
  data: { id: string; title: string }
}

export interface PtyCreateFailed {
  v: typeof VERSION
  requestId: string
  opId: string
  op: typeof CREATE_OP
  idempotencyKey: string
  status: "failed"
  outcome: { type: "failed"; time: number; failure: PtyFailure }
  accepted: false
  failure: PtyFailure
}

export interface PtyRemoveSucceeded {
  v: typeof VERSION
  requestId: string
  opId: string
  op: typeof REMOVE_OP
  idempotencyKey: string
  status: "succeeded"
  outcome: { type: "succeeded"; time: number }
  accepted: true
  data: { removed: true }
}

export interface PtyUpdateFailed {
  v: typeof VERSION
  requestId: string
  opId: string
  op: typeof UPDATE_OP
  idempotencyKey: string
  status: "failed"
  outcome: { type: "failed"; time: number; failure: PtyFailure }
  accepted: false
  failure: PtyFailure
}

export interface PtyRemoveFailed {
  v: typeof VERSION
  requestId: string
  opId: string
  op: typeof REMOVE_OP
  idempotencyKey: string
  status: "failed"
  outcome: { type: "failed"; time: number; failure: PtyFailure }
  accepted: false
  failure: PtyFailure
}

export type PtyUpdateResult = PtyUpdateSucceeded | PtyUpdateFailed
export type PtyRemoveResult = PtyRemoveSucceeded | PtyRemoveFailed
export type PtyCreateResult = PtyCreateSucceeded | PtyCreateFailed

export const VALIDATION_MESSAGE = "invalid pty request"
export const SCOPE_MESSAGE = "directory mismatch"
export const FENCE_MESSAGE = "Instance is unavailable during config rebuild; no active runtime for this request"
export const INTERNAL_MESSAGE = "internal error"
export const NOT_FOUND_MESSAGE = "pty not found"

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
    v.startsWith("pty") &&
    !v.includes("\0") &&
    !v.includes("/") &&
    !v.includes("\\") &&
    !v.includes(":")
  )
}

export function canonicalPtyCreateOpId(token: string): string {
  if (typeof token !== "string" || token.length === 0) throw new Error("token must be non-empty string")
  if (token.includes(":")) throw new Error("token must not contain ':'")
  if (!pathless(token)) throw new Error("token must not carry path material")
  return `pty-create:${token}`
}

export function canonicalPtyUpdateOpId(ptyID: string, token: string): string {
  if (!isPtyID(ptyID)) throw new Error("ptyID must be opaque PtyID")
  if (typeof token !== "string" || token.length === 0) throw new Error("token must be non-empty string")
  if (token.includes(":")) throw new Error("token must not contain ':'")
  if (!pathless(token)) throw new Error("token must not carry path material")
  return `pty-update:${ptyID}:${token}`
}

export function canonicalPtyRemoveOpId(ptyID: string, token: string): string {
  if (!isPtyID(ptyID)) throw new Error("ptyID must be opaque PtyID")
  if (typeof token !== "string" || token.length === 0) throw new Error("token must be non-empty string")
  if (token.includes(":")) throw new Error("token must not contain ':'")
  if (!pathless(token)) throw new Error("token must not carry path material")
  return `pty-remove:${ptyID}:${token}`
}

function parseCreateOpId(opId: string): { token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new Error("opId must be non-empty string")
  const segs = opId.split(":")
  if (segs.length !== 2 || segs[0] !== "pty-create" || segs[1]!.length === 0)
    throw new Error("opId must be pty-create:<token>")
  const token = segs[1]!
  if (!pathless(token)) throw new Error("opId token must not carry path material")
  return { token }
}

function parseUpdateOpId(opId: string): { ptyID: string; token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new Error("opId must be non-empty string")
  const segs = opId.split(":")
  if (segs.length !== 3 || segs[0] !== "pty-update" || segs[1]!.length === 0 || segs[2]!.length === 0)
    throw new Error("opId must be pty-update:<ptyID>:<token>")
  const ptyID = segs[1]!
  const token = segs[2]!
  if (!isPtyID(ptyID)) throw new Error("opId ptyID binding invalid")
  if (!pathless(token)) throw new Error("opId token must not carry path material")
  return { ptyID, token }
}

function parseRemoveOpId(opId: string): { ptyID: string; token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new Error("opId must be non-empty string")
  const segs = opId.split(":")
  if (segs.length !== 3 || segs[0] !== "pty-remove" || segs[1]!.length === 0 || segs[2]!.length === 0)
    throw new Error("opId must be pty-remove:<ptyID>:<token>")
  const ptyID = segs[1]!
  const token = segs[2]!
  if (!isPtyID(ptyID)) throw new Error("opId ptyID binding invalid")
  if (!pathless(token)) throw new Error("opId token must not carry path material")
  return { ptyID, token }
}

function checkIds(raw: Record<string, unknown>, op: string): void {
  if (raw.v !== VERSION) throw new Error("v must be 1")
  if (!present(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!present(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== op) throw new Error(`op must be ${op}`)
  if (!present(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId")
  if (!pathless(raw.requestId as string)) throw new Error("requestId must not carry path material")
  if (!pathless(raw.opId as string)) throw new Error("opId must not carry path material")
  if (!pathless(raw.idempotencyKey as string)) throw new Error("idempotencyKey must not carry path material")
}

function checkContext(raw: unknown): { directory: string; ptyID: string } {
  if (!record(raw)) throw new Error("context must be object")
  const allowed = new Set(["directory", "ptyID"])
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new Error("unexpected context field")
  if (typeof raw.directory !== "string" || raw.directory.length === 0)
    throw new Error("context.directory must be non-empty string")
  canonicalDirectory(raw.directory as string)
  if (!isPtyID(raw.ptyID)) throw new Error("context.ptyID must be PtyID")
  return { directory: raw.directory as string, ptyID: raw.ptyID as string }
}

function checkSize(raw: unknown): { rows: number; cols: number } {
  if (!record(raw)) throw new Error("payload.size must be object")
  const keys = Object.keys(raw)
  if (keys.length !== 2 || !keys.includes("rows") || !keys.includes("cols"))
    throw new Error("payload.size must be {rows,cols} only")
  const rows = raw.rows
  const cols = raw.cols
  if (typeof rows !== "number" || !Number.isSafeInteger(rows) || rows < 1)
    throw new Error("payload.size.rows must be positive integer")
  if (typeof cols !== "number" || !Number.isSafeInteger(cols) || cols < 1)
    throw new Error("payload.size.cols must be positive integer")
  return { rows, cols }
}

function checkCreateContext(raw: unknown): { directory: string } {
  if (!record(raw)) throw new Error("context must be object")
  const allowed = new Set(["directory"])
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new Error("unexpected context field")
  if (typeof raw.directory !== "string" || raw.directory.length === 0)
    throw new Error("context.directory must be non-empty string")
  canonicalDirectory(raw.directory as string)
  return { directory: raw.directory as string }
}

function checkCreatePayload(raw: unknown): PtyCreateRequest["payload"] {
  if (!record(raw)) throw new Error("payload must be object")
  const allowed = new Set(["command", "args", "cwd", "title", "env"])
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new Error("unexpected payload field")
  const out: PtyCreateRequest["payload"] = {}
  if (raw.command !== undefined) {
    if (typeof raw.command !== "string" || raw.command.length === 0 || raw.command.includes("\0"))
      throw new Error("payload.command must be non-empty string")
    out.command = raw.command
  }
  if (raw.args !== undefined) {
    if (!Array.isArray(raw.args)) throw new Error("payload.args must be string array")
    for (const a of raw.args) {
      if (typeof a !== "string" || a.includes("\0")) throw new Error("payload.args must be string array")
    }
    out.args = [...(raw.args as string[])]
  }
  if (raw.cwd !== undefined) {
    if (typeof raw.cwd !== "string" || raw.cwd.length === 0 || raw.cwd.includes("\0"))
      throw new Error("payload.cwd must be non-empty string")
    out.cwd = raw.cwd
  }
  if (raw.title !== undefined) {
    if (typeof raw.title !== "string" || raw.title.length === 0 || raw.title.length > 200 || raw.title.includes("\0"))
      throw new Error("payload.title must be non-empty string")
    out.title = raw.title
  }
  if (raw.env !== undefined) {
    if (!record(raw.env)) throw new Error("payload.env must be string record")
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw.env)) {
      if (k.length === 0 || k.includes("\0") || k.includes("=")) throw new Error("payload.env must be string record")
      if (k === "__proto__" || k === "constructor" || k === "prototype")
        throw new Error("payload.env must be string record")
      if (typeof v !== "string" || v.includes("\0")) throw new Error("payload.env must be string record")
      env[k] = v
    }
    out.env = env
  }
  return out
}

export function validatePtyCreateRequest(raw: unknown): PtyCreateRequest {
  if (!record(raw)) throw new Error("params must be object")
  checkIds(raw, CREATE_OP)
  const ctx = checkCreateContext(raw.context)
  const payload = checkCreatePayload(raw.payload)
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw)) if (!allowedRoot.has(k)) throw new Error("unexpected field")
  const parsed = parseCreateOpId(raw.opId as string)
  const idem = parseCreateOpId(raw.idempotencyKey as string)
  if (idem.token !== parsed.token) throw new Error("idempotencyKey must equal opId")
  return {
    v: 1,
    requestId: raw.requestId as string,
    opId: raw.opId as string,
    op: CREATE_OP,
    idempotencyKey: raw.idempotencyKey as string,
    context: ctx,
    payload,
  }
}

export function validatePtyUpdateRequest(raw: unknown): PtyUpdateRequest {
  if (!record(raw)) throw new Error("params must be object")
  checkIds(raw, UPDATE_OP)
  const ctx = checkContext(raw.context)
  const payload = raw.payload
  if (!record(payload)) throw new Error("payload must be object")
  const allowedPayload = new Set(["size"])
  for (const k of Object.keys(payload)) if (!allowedPayload.has(k)) throw new Error("unexpected payload field")
  const size = checkSize((payload as Record<string, unknown>).size)
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw)) if (!allowedRoot.has(k)) throw new Error("unexpected field")
  const parsed = parseUpdateOpId(raw.opId as string)
  if (parsed.ptyID !== ctx.ptyID) throw new Error("opId ptyID binding mismatch")
  const idem = parseUpdateOpId(raw.idempotencyKey as string)
  if (idem.ptyID !== ctx.ptyID || idem.token !== parsed.token) throw new Error("idempotencyKey must equal opId")
  return {
    v: 1,
    requestId: raw.requestId as string,
    opId: raw.opId as string,
    op: UPDATE_OP,
    idempotencyKey: raw.idempotencyKey as string,
    context: ctx,
    payload: { size },
  }
}

export function validatePtyRemoveRequest(raw: unknown): PtyRemoveRequest {
  if (!record(raw)) throw new Error("params must be object")
  checkIds(raw, REMOVE_OP)
  const ctx = checkContext(raw.context)
  const payload = raw.payload
  if (!record(payload)) throw new Error("payload must be object")
  if (Object.keys(payload).length !== 0) throw new Error("payload must be empty object for pty-remove")
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw)) if (!allowedRoot.has(k)) throw new Error("unexpected field")
  const parsed = parseRemoveOpId(raw.opId as string)
  if (parsed.ptyID !== ctx.ptyID) throw new Error("opId ptyID binding mismatch")
  const idem = parseRemoveOpId(raw.idempotencyKey as string)
  if (idem.ptyID !== ctx.ptyID || idem.token !== parsed.token) throw new Error("idempotencyKey must equal opId")
  return {
    v: 1,
    requestId: raw.requestId as string,
    opId: raw.opId as string,
    op: REMOVE_OP,
    idempotencyKey: raw.idempotencyKey as string,
    context: ctx,
    payload: {},
  }
}

type Ids = { requestId: string; opId: string; idempotencyKey: string }

function sanitized(v: unknown): string {
  if (typeof v !== "string" || v.length === 0 || !pathless(v)) return "unknown"
  return v
}

export function fallbackPtyCreateIds(raw: unknown): Ids {
  const o = (record(raw) ? raw : {}) as Record<string, unknown>
  return { requestId: sanitized(o.requestId), opId: sanitized(o.opId), idempotencyKey: sanitized(o.idempotencyKey) }
}

export function fallbackPtyUpdateIds(raw: unknown): Ids {
  const o = (record(raw) ? raw : {}) as Record<string, unknown>
  return { requestId: sanitized(o.requestId), opId: sanitized(o.opId), idempotencyKey: sanitized(o.idempotencyKey) }
}

export function fallbackPtyRemoveIds(raw: unknown): Ids {
  const o = (record(raw) ? raw : {}) as Record<string, unknown>
  return { requestId: sanitized(o.requestId), opId: sanitized(o.opId), idempotencyKey: sanitized(o.idempotencyKey) }
}

export function safePtyCreateIds(req: Ids): Ids {
  return {
    requestId: sanitized(req.requestId),
    opId: sanitized(req.opId),
    idempotencyKey: sanitized(req.idempotencyKey),
  }
}

export function safePtyUpdateIds(req: Ids): Ids {
  return {
    requestId: sanitized(req.requestId),
    opId: sanitized(req.opId),
    idempotencyKey: sanitized(req.idempotencyKey),
  }
}

export function safePtyRemoveIds(req: Ids): Ids {
  return {
    requestId: sanitized(req.requestId),
    opId: sanitized(req.opId),
    idempotencyKey: sanitized(req.idempotencyKey),
  }
}

function failedCreate(ids: Ids, code: string, message: string, retryable: boolean): PtyCreateFailed {
  const failure = { code, message, retryable }
  return {
    v: VERSION,
    requestId: ids.requestId,
    opId: ids.opId,
    op: CREATE_OP,
    idempotencyKey: ids.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: Date.now(), failure },
    accepted: false,
    failure,
  }
}

function failedUpdate(ids: Ids, code: string, message: string, retryable: boolean): PtyUpdateFailed {
  const failure = { code, message, retryable }
  return {
    v: VERSION,
    requestId: ids.requestId,
    opId: ids.opId,
    op: UPDATE_OP,
    idempotencyKey: ids.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: Date.now(), failure },
    accepted: false,
    failure,
  }
}

function failedRemove(ids: Ids, code: string, message: string, retryable: boolean): PtyRemoveFailed {
  const failure = { code, message, retryable }
  return {
    v: VERSION,
    requestId: ids.requestId,
    opId: ids.opId,
    op: REMOVE_OP,
    idempotencyKey: ids.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: Date.now(), failure },
    accepted: false,
    failure,
  }
}

function succeededCreate(req: PtyCreateRequest, id: string, title: string): PtyCreateSucceeded {
  return {
    v: VERSION,
    requestId: req.requestId,
    opId: req.opId,
    op: CREATE_OP,
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: Date.now() },
    accepted: true,
    data: { id, title },
  }
}

function succeededUpdate(req: PtyUpdateRequest): PtyUpdateSucceeded {
  return {
    v: VERSION,
    requestId: req.requestId,
    opId: req.opId,
    op: UPDATE_OP,
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: Date.now() },
    accepted: true,
    data: { updated: true },
  }
}

function succeededRemove(req: PtyRemoveRequest): PtyRemoveSucceeded {
  return {
    v: VERSION,
    requestId: req.requestId,
    opId: req.opId,
    op: REMOVE_OP,
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: Date.now() },
    accepted: true,
    data: { removed: true },
  }
}

const CREATE_SUCCEEDED_KEYS = new Set([
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
const CREATE_FAILED_KEYS = new Set([
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
const UPDATE_SUCCEEDED_KEYS = new Set([
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
const UPDATE_FAILED_KEYS = new Set([
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
const REMOVE_SUCCEEDED_KEYS = new Set([
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
const REMOVE_FAILED_KEYS = new Set([
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
const FAILURE_FIELDS = new Set(["code", "message", "retryable"])

function checkFailure(raw: unknown): PtyFailure {
  if (!record(raw)) throw new Error("failure must be object")
  for (const k of Object.keys(raw)) if (!FAILURE_FIELDS.has(k)) throw new Error("unexpected failure field")
  if (!present(raw.code)) throw new Error("failure code must be non-empty string")
  if (!present(raw.message)) throw new Error("failure message must be non-empty string")
  if (typeof raw.retryable !== "boolean") throw new Error("failure retryable must be boolean")
  return raw as unknown as PtyFailure
}

export function validatePtyCreateResult(raw: unknown, req: PtyCreateRequest): PtyCreateResult {
  if (!record(raw)) throw new Error("result must be object")
  if (raw.v !== VERSION) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== CREATE_OP) throw new Error("op mismatch")
  if (raw.idempotencyKey !== req.idempotencyKey) throw new Error("idempotencyKey mismatch")
  const status = raw.status
  if (status !== "succeeded" && status !== "failed") throw new Error("status must be succeeded/failed")
  if (typeof raw.accepted !== "boolean") throw new Error("accepted must be boolean")
  const outcome = raw.outcome
  if (!record(outcome) || typeof outcome.type !== "string" || typeof outcome.time !== "number")
    throw new Error("outcome invalid")
  if (outcome.type !== status) throw new Error("outcome.type must match status")
  if (!Number.isFinite(outcome.time) || outcome.time < 0) throw new Error("outcome.time invalid")
  const rec = raw as Record<string, unknown>
  const out = outcome as Record<string, unknown>
  if (status === "succeeded") {
    for (const k of Object.keys(rec)) if (!CREATE_SUCCEEDED_KEYS.has(k)) throw new Error("unexpected result field")
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    const data = rec.data
    if (!record(data)) throw new Error("succeeded data must be object")
    for (const k of Object.keys(data)) if (k !== "id" && k !== "title") throw new Error("unexpected data field")
    if (!isPtyID(data.id)) throw new Error("succeeded data.id must be PtyID")
    if (typeof data.title !== "string" || data.title.length === 0)
      throw new Error("succeeded data.title must be non-empty string")
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (out.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as PtyCreateSucceeded
  }
  for (const k of Object.keys(rec)) if (!CREATE_FAILED_KEYS.has(k)) throw new Error("unexpected result field")
  const failure = checkFailure(rec.failure)
  const outFailure = checkFailure(out.failure)
  if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
  if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
  if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
  if (rec.data !== undefined) throw new Error("failed must not have data")
  return raw as unknown as PtyCreateFailed
}

export function validatePtyUpdateResult(raw: unknown, req: PtyUpdateRequest): PtyUpdateResult {
  if (!record(raw)) throw new Error("result must be object")
  if (raw.v !== VERSION) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== UPDATE_OP) throw new Error("op mismatch")
  if (raw.idempotencyKey !== req.idempotencyKey) throw new Error("idempotencyKey mismatch")
  const status = raw.status
  if (status !== "succeeded" && status !== "failed") throw new Error("status must be succeeded/failed")
  if (typeof raw.accepted !== "boolean") throw new Error("accepted must be boolean")
  const outcome = raw.outcome
  if (!record(outcome) || typeof outcome.type !== "string" || typeof outcome.time !== "number")
    throw new Error("outcome invalid")
  if (outcome.type !== status) throw new Error("outcome.type must match status")
  if (!Number.isFinite(outcome.time) || outcome.time < 0) throw new Error("outcome.time invalid")
  const rec = raw as Record<string, unknown>
  const out = outcome as Record<string, unknown>
  if (status === "succeeded") {
    for (const k of Object.keys(rec)) if (!UPDATE_SUCCEEDED_KEYS.has(k)) throw new Error("unexpected result field")
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    const data = rec.data
    if (!record(data)) throw new Error("succeeded data must be object")
    for (const k of Object.keys(data)) if (k !== "updated") throw new Error("unexpected data field")
    if (data.updated !== true) throw new Error("succeeded data.updated must be true")
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (out.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as PtyUpdateSucceeded
  }
  for (const k of Object.keys(rec)) if (!UPDATE_FAILED_KEYS.has(k)) throw new Error("unexpected result field")
  const failure = checkFailure(rec.failure)
  const outFailure = checkFailure(out.failure)
  if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
  if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
  if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
  if (rec.data !== undefined) throw new Error("failed must not have data")
  return raw as unknown as PtyUpdateFailed
}

export function validatePtyRemoveResult(raw: unknown, req: PtyRemoveRequest): PtyRemoveResult {
  if (!record(raw)) throw new Error("result must be object")
  if (raw.v !== VERSION) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== REMOVE_OP) throw new Error("op mismatch")
  if (raw.idempotencyKey !== req.idempotencyKey) throw new Error("idempotencyKey mismatch")
  const status = raw.status
  if (status !== "succeeded" && status !== "failed") throw new Error("status must be succeeded/failed")
  if (typeof raw.accepted !== "boolean") throw new Error("accepted must be boolean")
  const outcome = raw.outcome
  if (!record(outcome) || typeof outcome.type !== "string" || typeof outcome.time !== "number")
    throw new Error("outcome invalid")
  if (outcome.type !== status) throw new Error("outcome.type must match status")
  if (!Number.isFinite(outcome.time) || outcome.time < 0) throw new Error("outcome.time invalid")
  const rec = raw as Record<string, unknown>
  const out = outcome as Record<string, unknown>
  if (status === "succeeded") {
    for (const k of Object.keys(rec)) if (!REMOVE_SUCCEEDED_KEYS.has(k)) throw new Error("unexpected result field")
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    const data = rec.data
    if (!record(data)) throw new Error("succeeded data must be object")
    for (const k of Object.keys(data)) if (k !== "removed") throw new Error("unexpected data field")
    if (data.removed !== true) throw new Error("succeeded data.removed must be true")
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (out.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as PtyRemoveSucceeded
  }
  for (const k of Object.keys(rec)) if (!REMOVE_FAILED_KEYS.has(k)) throw new Error("unexpected result field")
  const failure = checkFailure(rec.failure)
  const outFailure = checkFailure(out.failure)
  if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
  if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
  if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
  if (rec.data !== undefined) throw new Error("failed must not have data")
  return raw as unknown as PtyRemoveFailed
}

// Private `pty/create`: per-directory `Pty.Service` via the canonical
// AppLayer-provided `PtyServiceMap` under canonical directory admission
// and existing `acquireDrainControl`/`InstanceRef`/ control-lease handling.
// Same owner as HTTP `POST /pty` (same `PtyPreparation.prepareCreate` +
// `Pty.Service.create`). Closed payload mirrors the HTTP create input.
// Non-idempotent: each accepted call spawns one PTY, so callers must never
// retry — at most one private attempt plus at most one SDK fallback. No
// durable replay/journal.
export const createPtyPrivate = Effect.fn("PtyPrivate.create")(function* (raw: unknown) {
  let req: PtyCreateRequest
  try {
    req = validatePtyCreateRequest(raw)
  } catch {
    return failedCreate(fallbackPtyCreateIds(raw), "validation.failed", VALIDATION_MESSAGE, false)
  }
  const safe = safePtyCreateIds(req)
  let dir: string
  try {
    dir = canonicalDirectory(req.context.directory)
  } catch {
    return failedCreate(safe, "validation.failed", VALIDATION_MESSAGE, false)
  }
  const acquired = yield* acquireDrainControl(dir).pipe(
    Effect.map((v) => ({ tag: "ok" as const, value: v })),
    Effect.catch((err: unknown) => {
      const fence =
        err instanceof InstanceUnavailableDuringConfigRebuildError ||
        (err as { _tag?: string })?._tag === "InstanceUnavailableDuringConfigRebuild"
      if (fence)
        return Effect.succeed({
          tag: "fail" as const,
          result: failedCreate(safe, "InstanceUnavailableDuringConfigRebuild", FENCE_MESSAGE, true),
        })
      return Effect.succeed({ tag: "fail" as const, result: failedCreate(safe, "internal", INTERNAL_MESSAGE, false) })
    }),
    Effect.catchDefect(() =>
      Effect.succeed({ tag: "fail" as const, result: failedCreate(safe, "internal", INTERNAL_MESSAGE, false) }),
    ),
  )
  if (acquired.tag !== "ok") return acquired.result
  const inner = Effect.gen(function* () {
    let stored: string
    try {
      stored = canonicalDirectory(acquired.value.ctx.directory)
    } catch {
      return failedCreate(safe, "internal", INTERNAL_MESSAGE, false)
    }
    if (stored !== dir) return failedCreate(safe, "scope_mismatch", SCOPE_MESSAGE, false)
    const out = yield* Effect.gen(function* () {
      const ptys = yield* PtyServiceMap
      const layer = ptys.get({ directory: AbsolutePath.make(dir) })
      const prepared = yield* PtyPreparation.prepareCreate({
        ...(req.payload.command !== undefined ? { command: req.payload.command } : {}),
        ...(req.payload.args !== undefined ? { args: [...req.payload.args] } : {}),
        ...(req.payload.cwd !== undefined ? { cwd: req.payload.cwd } : {}),
        ...(req.payload.title !== undefined ? { title: req.payload.title } : {}),
        ...(req.payload.env !== undefined ? { env: { ...req.payload.env } } : {}),
      })
      const info = yield* Pty.Service.use((svc) => svc.create(prepared)).pipe(Effect.provide(layer))
      return succeededCreate(req, info.id, info.title)
    }).pipe(
      Effect.catch(() => Effect.succeed(failedCreate(safe, "internal", INTERNAL_MESSAGE, false))),
      Effect.catchDefect(() => Effect.succeed(failedCreate(safe, "internal", INTERNAL_MESSAGE, false))),
    )
    return out
  }).pipe(Effect.provideService(InstanceRef, acquired.value.ctx), Effect.ensuring(acquired.value.release))
  return yield* inner.pipe(
    Effect.catch(() => Effect.succeed(failedCreate(safe, "internal", INTERNAL_MESSAGE, false))),
    Effect.catchDefect(() => Effect.succeed(failedCreate(safe, "internal", INTERNAL_MESSAGE, false))),
  )
})

// Private `pty/update`: per-directory `Pty.Service` via the canonical
// AppLayer-provided `PtyServiceMap` under canonical directory admission
// and existing `acquireDrainControl`/`InstanceRef`/ control-lease handling.
// Same owner as HTTP `PUT /pty/:ptyID`. Closed payload is size rows/cols
// only. `pty.not_found` is terminal non-retryable and success-equivalent
// for the caller. No durable replay/journal.
export const updatePtyPrivate = Effect.fn("PtyPrivate.update")(function* (raw: unknown) {
  let req: PtyUpdateRequest
  try {
    req = validatePtyUpdateRequest(raw)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("binding mismatch"))
      return failedUpdate(fallbackPtyUpdateIds(raw), "scope_mismatch", SCOPE_MESSAGE, false)
    return failedUpdate(fallbackPtyUpdateIds(raw), "validation.failed", VALIDATION_MESSAGE, false)
  }
  const safe = safePtyUpdateIds(req)
  let dir: string
  try {
    dir = canonicalDirectory(req.context.directory)
  } catch {
    return failedUpdate(safe, "validation.failed", VALIDATION_MESSAGE, false)
  }
  const ptyID = req.context.ptyID
  const size = req.payload.size
  const acquired = yield* acquireDrainControl(dir).pipe(
    Effect.map((v) => ({ tag: "ok" as const, value: v })),
    Effect.catch((err: unknown) => {
      const fence =
        err instanceof InstanceUnavailableDuringConfigRebuildError ||
        (err as { _tag?: string })?._tag === "InstanceUnavailableDuringConfigRebuild"
      if (fence)
        return Effect.succeed({
          tag: "fail" as const,
          result: failedUpdate(safe, "InstanceUnavailableDuringConfigRebuild", FENCE_MESSAGE, true),
        })
      return Effect.succeed({ tag: "fail" as const, result: failedUpdate(safe, "internal", INTERNAL_MESSAGE, false) })
    }),
    Effect.catchDefect(() =>
      Effect.succeed({ tag: "fail" as const, result: failedUpdate(safe, "internal", INTERNAL_MESSAGE, false) }),
    ),
  )
  if (acquired.tag !== "ok") return acquired.result
  const inner = Effect.gen(function* () {
    let stored: string
    try {
      stored = canonicalDirectory(acquired.value.ctx.directory)
    } catch {
      return failedUpdate(safe, "internal", INTERNAL_MESSAGE, false)
    }
    if (stored !== dir) return failedUpdate(safe, "scope_mismatch", SCOPE_MESSAGE, false)
    const out = yield* Effect.gen(function* () {
      const ptys = yield* PtyServiceMap
      const layer = ptys.get({ directory: AbsolutePath.make(dir) })
      return yield* Pty.Service.use((svc) => svc.update(ptyID as never, { size: { ...size } })).pipe(
        Effect.provide(layer),
      )
    }).pipe(
      Effect.map(() => succeededUpdate(req)),
      Effect.catchTag("Pty.NotFoundError", () =>
        Effect.succeed(failedUpdate(safe, "pty.not_found", NOT_FOUND_MESSAGE, false)),
      ),
      Effect.catch(() => Effect.succeed(failedUpdate(safe, "internal", INTERNAL_MESSAGE, false))),
      Effect.catchDefect(() => Effect.succeed(failedUpdate(safe, "internal", INTERNAL_MESSAGE, false))),
    )
    return out
  }).pipe(Effect.provideService(InstanceRef, acquired.value.ctx), Effect.ensuring(acquired.value.release))
  return yield* inner.pipe(
    Effect.catch(() => Effect.succeed(failedUpdate(safe, "internal", INTERNAL_MESSAGE, false))),
    Effect.catchDefect(() => Effect.succeed(failedUpdate(safe, "internal", INTERNAL_MESSAGE, false))),
  )
})

// Private `pty/remove`: per-directory `Pty.Service` via the same canonical
// `PtyServiceMap` owner as HTTP `DELETE /pty/:ptyID`. Empty payload.
// Idempotent: missing PTY maps to terminal `pty.not_found` which callers
// treat as already removed.
export const removePtyPrivate = Effect.fn("PtyPrivate.remove")(function* (raw: unknown) {
  let req: PtyRemoveRequest
  try {
    req = validatePtyRemoveRequest(raw)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes("binding mismatch"))
      return failedRemove(fallbackPtyRemoveIds(raw), "scope_mismatch", SCOPE_MESSAGE, false)
    return failedRemove(fallbackPtyRemoveIds(raw), "validation.failed", VALIDATION_MESSAGE, false)
  }
  const safe = safePtyRemoveIds(req)
  let dir: string
  try {
    dir = canonicalDirectory(req.context.directory)
  } catch {
    return failedRemove(safe, "validation.failed", VALIDATION_MESSAGE, false)
  }
  const ptyID = req.context.ptyID
  const acquired = yield* acquireDrainControl(dir).pipe(
    Effect.map((v) => ({ tag: "ok" as const, value: v })),
    Effect.catch((err: unknown) => {
      const fence =
        err instanceof InstanceUnavailableDuringConfigRebuildError ||
        (err as { _tag?: string })?._tag === "InstanceUnavailableDuringConfigRebuild"
      if (fence)
        return Effect.succeed({
          tag: "fail" as const,
          result: failedRemove(safe, "InstanceUnavailableDuringConfigRebuild", FENCE_MESSAGE, true),
        })
      return Effect.succeed({ tag: "fail" as const, result: failedRemove(safe, "internal", INTERNAL_MESSAGE, false) })
    }),
    Effect.catchDefect(() =>
      Effect.succeed({ tag: "fail" as const, result: failedRemove(safe, "internal", INTERNAL_MESSAGE, false) }),
    ),
  )
  if (acquired.tag !== "ok") return acquired.result
  const inner = Effect.gen(function* () {
    let stored: string
    try {
      stored = canonicalDirectory(acquired.value.ctx.directory)
    } catch {
      return failedRemove(safe, "internal", INTERNAL_MESSAGE, false)
    }
    if (stored !== dir) return failedRemove(safe, "scope_mismatch", SCOPE_MESSAGE, false)
    const out = yield* Effect.gen(function* () {
      const ptys = yield* PtyServiceMap
      const layer = ptys.get({ directory: AbsolutePath.make(dir) })
      return yield* Pty.Service.use((svc) => svc.remove(ptyID as never)).pipe(Effect.provide(layer))
    }).pipe(
      Effect.map(() => succeededRemove(req)),
      Effect.catchTag("Pty.NotFoundError", () =>
        Effect.succeed(failedRemove(safe, "pty.not_found", NOT_FOUND_MESSAGE, false)),
      ),
      Effect.catch(() => Effect.succeed(failedRemove(safe, "internal", INTERNAL_MESSAGE, false))),
      Effect.catchDefect(() => Effect.succeed(failedRemove(safe, "internal", INTERNAL_MESSAGE, false))),
    )
    return out
  }).pipe(Effect.provideService(InstanceRef, acquired.value.ctx), Effect.ensuring(acquired.value.release))
  return yield* inner.pipe(
    Effect.catch(() => Effect.succeed(failedRemove(safe, "internal", INTERNAL_MESSAGE, false))),
    Effect.catchDefect(() => Effect.succeed(failedRemove(safe, "internal", INTERNAL_MESSAGE, false))),
  )
})
