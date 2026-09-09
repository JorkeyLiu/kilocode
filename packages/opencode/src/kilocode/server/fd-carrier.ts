import * as fs from "node:fs"
import { Effect, Option, Schema } from "effect"
import { ErrorCode } from "@/private-worker/json-rpc"
import { AppRuntime } from "@/effect/app-runtime"
import { CancelQueuedDispatchService } from "@/kilocode/session/cancel-queued-dispatch"
import { SessionUpdateDispatchService, validatePrivateRequest } from "@/kilocode/session/session-update-dispatch"
import { SessionForkDispatchService } from "@/kilocode/session/session-fork-dispatch"
import { SessionCreateDispatchService } from "@/kilocode/session/session-create-dispatch"
import { SessionDeleteDispatchService } from "@/kilocode/session/session-delete-dispatch"
import { abortSession as abortSessionPrivate, validateAbortRequest as validateAbortEnvelope } from "@/kilocode/session/session-abort"
import { SessionStatus } from "@/session/status"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionID } from "@/session/schema"
import { NotFoundError } from "@/storage/storage"
import { canonicalDirectory } from "@/kilocode/session/canonical-directory"
import {
  acquireDrainControl,
  InstanceUnavailableDuringConfigRebuildError,
} from "@/kilocode/server/drain-control-acquire"
import { InstanceStore } from "@/project/instance-store"
import { GenerationGate } from "@/kilocode/server/generation-gate"
import { InstanceRef } from "@/effect/instance-ref"
import { KiloSessions } from "@/kilo-sessions/kilo-sessions"
import { Global } from "@opencode-ai/core/global"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Command } from "@/command"
import { Config } from "@/config/config"
import * as InstanceState from "@/effect/instance-state"
import { buildInitializeResult, validateProtocolVersion } from "./fd-carrier-protocol"
import { JsonRpcPeer as Peer } from "@/private-worker/peer"

export interface FdCarrierHandle {
  peer: Peer
  reader: NodeJS.ReadableStream
  writer: NodeJS.WritableStream
  dispose: () => void
}

export function isSocketStat(stat: unknown): boolean {
  try {
    const s = stat as { isSocket?: unknown }
    if (typeof s?.isSocket !== "function") return false
    return (s.isSocket as () => unknown)() === true
  } catch {
    return false
  }
}

export function isFdCarrierSocketEligible(stat3: unknown, stat4: unknown, platform: string): boolean {
  if (platform === "win32") return true
  if (platform === "darwin" || platform === "linux") return isSocketStat(stat3) && isSocketStat(stat4)
  console.warn("[kilo fd-carrier] unsupported platform, failing closed:", String(platform))
  return false
}

function carrierPlatform(deps?: { platform?: unknown }): string {
  const p = deps?.platform
  if (typeof p === "string" && p.length > 0) return p
  return process.platform
}

export function canUseFdCarrier(): boolean {
  const envOk = !!process.env.KILO_PARENT_PID || process.env.KILO_CLIENT === "vscode"
  if (!envOk) return false
  // Darwin/Linux: Bun keeps fd 3 open as FIFO and fd 4 as socket even
  // without ServerManager pipes — require both fds to be sockets.
  // Windows: retain existence gate until real Windows fd evidence exists.
  try {
    const s3 = fs.fstatSync(3)
    const s4 = fs.fstatSync(4)
    if (!isFdCarrierSocketEligible(s3, s4, process.platform)) {
      console.warn("[kilo fd-carrier] canUse check failed: fd3/fd4 are not both sockets")
      return false
    }
    return true
  } catch (err) {
    console.warn("[kilo fd-carrier] canUse check failed:", String(err))
    return false
  }
}

function bestEffortClose(stream: unknown, label: string): void {
  try {
    const c = stream as { destroy?: () => void; close?: () => void; end?: () => void; destroyed?: boolean }
    if (c.destroyed) return
    if (typeof c.destroy === "function") c.destroy()
    else if (typeof c.close === "function") c.close()
    else if (typeof c.end === "function") (c as { end: () => void }).end()
  } catch (err) {
    console.warn(`[kilo fd-carrier] best-effort ${label} cleanup failed:`, String(err))
  }
}

export const FD_STATUS_VERSION = 1 as const
export const FD_STATUS_OP = "session/status" as const
export const FD_GET_VERSION = 1 as const
export const FD_GET_OP = "session/get" as const
export const FD_MESSAGES_VERSION = 1 as const
export const FD_MESSAGES_OP = "session/messages" as const
export const FD_CHILDREN_VERSION = 1 as const
export const FD_CHILDREN_OP = "session/children" as const
export const FD_REMOTE_STATUS_VERSION = 1 as const
export const FD_REMOTE_STATUS_OP = "remote/status" as const
export const FD_SESSION_LIST_VERSION = 2 as const
export const FD_SESSION_LIST_OP = "experimental/session/list" as const
export const SESSION_LIST_CURSOR_VERSION = 1 as const
export const SESSION_LIST_CURSOR_MAX_LENGTH = 512 as const
export interface SessionListCursor {
  v: typeof SESSION_LIST_CURSOR_VERSION
  updated: number
  id: string
}
export function encodeSessionListCursor(updated: number, id: string): string {
  return Buffer.from(JSON.stringify({ v: SESSION_LIST_CURSOR_VERSION, updated, id }), "utf8").toString("base64url")
}
export function decodeSessionListCursor(raw: unknown): SessionListCursor {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > SESSION_LIST_CURSOR_MAX_LENGTH)
    throw new Error("filter.cursor must be opaque session-list cursor string")
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error("filter.cursor must be opaque session-list cursor string")
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))
  } catch {
    throw new Error("filter.cursor must be opaque session-list cursor string")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("filter.cursor must be opaque session-list cursor string")
  const rec = parsed as Record<string, unknown>
  const keys = Object.keys(rec)
  if (keys.length !== 3 || !keys.includes("v") || !keys.includes("updated") || !keys.includes("id"))
    throw new Error("filter.cursor must be opaque session-list cursor string")
  if (rec.v !== SESSION_LIST_CURSOR_VERSION) throw new Error("filter.cursor must be opaque session-list cursor string")
  if (typeof rec.updated !== "number" || !Number.isInteger(rec.updated) || (rec.updated as number) < 0)
    throw new Error("filter.cursor must be opaque session-list cursor string")
  if (typeof rec.id !== "string" || !(rec.id as string).startsWith("ses") || (rec.id as string).includes("\0"))
    throw new Error("filter.cursor must be opaque session-list cursor string")
  return { v: SESSION_LIST_CURSOR_VERSION, updated: rec.updated as number, id: rec.id as string }
}
export function isAfterSessionListCursor(row: { updated: number; id: string }, cursor: SessionListCursor): boolean {
  if (row.updated < cursor.updated) return true
  if (row.updated > cursor.updated) return false
  return row.id < cursor.id
}
export const FD_PATH_VERSION = 1 as const
export const FD_PATH_OP = "path/get" as const
export const FD_COMMAND_LIST_VERSION = 1 as const
export const FD_COMMAND_LIST_OP = "command/list" as const
export const FD_CONFIG_WARNINGS_VERSION = 1 as const
export const FD_CONFIG_WARNINGS_OP = "config/warnings" as const
export const FD_PROJECT_CURRENT_VERSION = 1 as const
export const FD_PROJECT_CURRENT_OP = "project/current" as const
export const FD_FIND_FILES_VERSION = 1 as const
export const FD_FIND_FILES_OP = "find/files" as const

export interface FdPathRequest {
  v: typeof FD_PATH_VERSION
  requestId: string
  opId: string
  op: typeof FD_PATH_OP
  idempotencyKey: string
  context: {
    directory: string
    workspace?: string
  }
  payload: Record<string, never>
}

export interface FdCommandListRequest {
  v: typeof FD_COMMAND_LIST_VERSION
  requestId: string
  opId: string
  op: typeof FD_COMMAND_LIST_OP
  idempotencyKey: string
  context: {
    directory: string
    workspace?: string
  }
  payload: Record<string, never>
}

export interface FdConfigWarningsRequest {
  v: typeof FD_CONFIG_WARNINGS_VERSION
  requestId: string
  opId: string
  op: typeof FD_CONFIG_WARNINGS_OP
  idempotencyKey: string
  context: {
    directory: string
    workspace?: string
  }
  payload: Record<string, never>
}

export interface FdProjectCurrentRequest {
  v: typeof FD_PROJECT_CURRENT_VERSION
  requestId: string
  opId: string
  op: typeof FD_PROJECT_CURRENT_OP
  idempotencyKey: string
  context: {
    directory: string
    workspace?: string
  }
  payload: Record<string, never>
}

export interface FdFindFilesRequest {
  v: typeof FD_FIND_FILES_VERSION
  requestId: string
  opId: string
  op: typeof FD_FIND_FILES_OP
  idempotencyKey: string
  context: {
    directory: string
    workspace?: string
  }
  payload: {
    query: string
    type: "file" | "directory"
    limit?: number
  }
}

export interface FdSessionListRequest {
  v: typeof FD_SESSION_LIST_VERSION
  requestId: string
  opId: string
  op: typeof FD_SESSION_LIST_OP
  idempotencyKey: string
  context: {
    directory: string
    workspace?: string
  }
  payload: {
    filter: {
      projectID?: string
      roots?: boolean
      start?: number
      cursor?: string
      search?: string
      limit?: number
      archived?: boolean
    }
  }
}

export interface FdRemoteStatusRequest {
  v: typeof FD_REMOTE_STATUS_VERSION
  requestId: string
  opId: string
  op: typeof FD_REMOTE_STATUS_OP
  idempotencyKey: string
  context: {
    directory: string
    workspace?: string
  }
  payload: Record<string, never>
}

export interface FdChildrenRequest {
  v: typeof FD_CHILDREN_VERSION
  requestId: string
  opId: string
  op: typeof FD_CHILDREN_OP
  idempotencyKey: string
  context: {
    directory: string
    parentSessionId: string
  }
  payload: Record<string, never>
}

export interface FdMessagesRequest {
  v: typeof FD_MESSAGES_VERSION
  requestId: string
  opId: string
  op: typeof FD_MESSAGES_OP
  idempotencyKey: string
  context: {
    directory: string
    sessionId: string
  }
  payload: {
    limit?: number
    before?: string
  }
}

export interface FdGetRequest {
  v: typeof FD_GET_VERSION
  requestId: string
  opId: string
  op: typeof FD_GET_OP
  idempotencyKey: string
  context: {
    directory: string
    sessionId: string
  }
  payload: Record<string, never>
}

export interface FdStatusRequest {
  v: typeof FD_STATUS_VERSION
  requestId: string
  opId: string
  op: typeof FD_STATUS_OP
  idempotencyKey: string
  context: {
    directory: string
  }
  payload: Record<string, never>
}

function isNonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function statusFailed(
  req: { requestId: string; opId: string; idempotencyKey: string },
  code: string,
  message: string,
  retryable: boolean,
): Record<string, unknown> {
  const time = Date.now()
  const failure = { code, message, retryable }
  return {
    v: FD_STATUS_VERSION,
    requestId: req.requestId,
    opId: req.opId,
    op: FD_STATUS_OP,
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time, failure },
    accepted: false,
    failure,
  }
}

function getFailed(
  req: { requestId: string; opId: string; idempotencyKey: string },
  code: string,
  message: string,
  retryable: boolean,
): Record<string, unknown> {
  const time = Date.now()
  const failure = { code, message, retryable }
  return {
    v: FD_GET_VERSION,
    requestId: req.requestId,
    opId: req.opId,
    op: FD_GET_OP,
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time, failure },
    accepted: false,
    failure,
  }
}

function messagesFailed(
  req: { requestId: string; opId: string; idempotencyKey: string },
  code: string,
  message: string,
  retryable: boolean,
): Record<string, unknown> {
  const time = Date.now()
  const failure = { code, message, retryable }
  return {
    v: FD_MESSAGES_VERSION,
    requestId: req.requestId,
    opId: req.opId,
    op: FD_MESSAGES_OP,
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time, failure },
    accepted: false,
    failure,
  }
}

function childrenFailed(
  req: { requestId: string; opId: string; idempotencyKey: string },
  code: string,
  message: string,
  retryable: boolean,
): Record<string, unknown> {
  const time = Date.now()
  const failure = { code, message, retryable }
  return {
    v: FD_CHILDREN_VERSION,
    requestId: req.requestId,
    opId: req.opId,
    op: FD_CHILDREN_OP,
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time, failure },
    accepted: false,
    failure,
  }
}

const GET_MESSAGE_LIMIT = 200

function boundGetMessage(msg: string): string {
  if (msg.length > GET_MESSAGE_LIMIT) return msg.slice(0, GET_MESSAGE_LIMIT)
  return msg
}

const MESSAGES_MESSAGE_LIMIT = 200

function boundMessagesMessage(msg: string): string {
  if (msg.length > MESSAGES_MESSAGE_LIMIT) return msg.slice(0, MESSAGES_MESSAGE_LIMIT)
  return msg
}

const CHILDREN_MESSAGE_LIMIT = 200

function boundChildrenMessage(msg: string): string {
  if (msg.length > CHILDREN_MESSAGE_LIMIT) return msg.slice(0, CHILDREN_MESSAGE_LIMIT)
  return msg
}

const REMOTE_STATUS_MESSAGE_LIMIT = 200

function boundRemoteStatusMessage(msg: string): string {
  if (msg.length > REMOTE_STATUS_MESSAGE_LIMIT) return msg.slice(0, REMOTE_STATUS_MESSAGE_LIMIT)
  return msg
}

const SESSION_LIST_MESSAGE_LIMIT = 200

function boundSessionListMessage(msg: string): string {
  if (msg.length > SESSION_LIST_MESSAGE_LIMIT) return msg.slice(0, SESSION_LIST_MESSAGE_LIMIT)
  return msg
}

const PATH_MESSAGE_LIMIT = 200

function boundPathMessage(msg: string): string {
  if (msg.length > PATH_MESSAGE_LIMIT) return msg.slice(0, PATH_MESSAGE_LIMIT)
  return msg
}

const COMMAND_LIST_MESSAGE_LIMIT = 200

function boundCommandListMessage(msg: string): string {
  if (msg.length > COMMAND_LIST_MESSAGE_LIMIT) return msg.slice(0, COMMAND_LIST_MESSAGE_LIMIT)
  return msg
}

function remoteStatusFailed(
  req: { requestId: string; opId: string; idempotencyKey: string },
  code: string,
  message: string,
  retryable: boolean,
): Record<string, unknown> {
  const time = Date.now()
  const failure = { code, message, retryable }
  return {
    v: FD_REMOTE_STATUS_VERSION,
    requestId: req.requestId,
    opId: req.opId,
    op: FD_REMOTE_STATUS_OP,
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time, failure },
    accepted: false,
    failure,
  }
}

function pathFailed(
  req: { requestId: string; opId: string; idempotencyKey: string },
  code: string,
  message: string,
  retryable: boolean,
): Record<string, unknown> {
  const time = Date.now()
  const failure = { code, message, retryable }
  return {
    v: FD_PATH_VERSION,
    requestId: req.requestId,
    opId: req.opId,
    op: FD_PATH_OP,
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time, failure },
    accepted: false,
    failure,
  }
}

function sessionListFailed(
  req: { requestId: string; opId: string; idempotencyKey: string },
  code: string,
  message: string,
  retryable: boolean,
): Record<string, unknown> {
  const time = Date.now()
  const failure = { code, message, retryable }
  return {
    v: FD_SESSION_LIST_VERSION,
    requestId: req.requestId,
    opId: req.opId,
    op: FD_SESSION_LIST_OP,
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time, failure },
    accepted: false,
    failure,
  }
}

function commandListFailed(
  req: { requestId: string; opId: string; idempotencyKey: string },
  code: string,
  message: string,
  retryable: boolean,
): Record<string, unknown> {
  const time = Date.now()
  const failure = { code, message, retryable }
  return {
    v: FD_COMMAND_LIST_VERSION,
    requestId: req.requestId,
    opId: req.opId,
    op: FD_COMMAND_LIST_OP,
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time, failure },
    accepted: false,
    failure,
  }
}

function configWarningsFailed(
  req: { requestId: string; opId: string; idempotencyKey: string },
  code: string,
  message: string,
  retryable: boolean,
): Record<string, unknown> {
  const time = Date.now()
  const failure = { code, message, retryable }
  return {
    v: FD_CONFIG_WARNINGS_VERSION,
    requestId: req.requestId,
    opId: req.opId,
    op: FD_CONFIG_WARNINGS_OP,
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time, failure },
    accepted: false,
    failure,
  }
}

function projectCurrentFailed(
  req: { requestId: string; opId: string; idempotencyKey: string },
  code: string,
  message: string,
  retryable: boolean,
): Record<string, unknown> {
  const time = Date.now()
  const failure = { code, message, retryable }
  return {
    v: FD_PROJECT_CURRENT_VERSION,
    requestId: req.requestId,
    opId: req.opId,
    op: FD_PROJECT_CURRENT_OP,
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time, failure },
    accepted: false,
    failure,
  }
}

function validateGetRequest(raw: unknown): FdGetRequest {
  if (!isRecord(raw)) throw new Error("params must be object")
  if (raw.v !== FD_GET_VERSION) throw new Error("v must be 1")
  if (!isNonEmpty(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmpty(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== FD_GET_OP) throw new Error("op must be session/get")
  if (!isNonEmpty(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId for get")
  const ctx = raw.context
  if (!isRecord(ctx)) throw new Error("context must be object")
  const allowedCtx = new Set(["directory", "sessionId"])
  for (const k of Object.keys(ctx)) if (!allowedCtx.has(k)) throw new Error(`unexpected context field ${k}`)
  if (typeof ctx.directory !== "string" || ctx.directory.length === 0)
    throw new Error("context.directory must be non-empty string")
  canonicalDirectory(ctx.directory)
  if (typeof ctx.sessionId !== "string" || !Schema.is(SessionID)(ctx.sessionId))
    throw new Error("context.sessionId must be SessionID")
  const payload = raw.payload
  if (!isRecord(payload)) throw new Error("payload must be object")
  if (Object.keys(payload).length !== 0) throw new Error("payload must be empty object for get")
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw)) if (!allowedRoot.has(k)) throw new Error(`unexpected field ${k}`)
  const opId = raw.opId as string
  const sid = ctx.sessionId as string
  const prefix = `get:${sid}:`
  if (!opId.startsWith(prefix)) throw new Error("opId must be get:<sessionId>:<token> with nonempty colon-free token")
  const token = opId.slice(prefix.length)
  if (token.length === 0 || token.includes(":"))
    throw new Error("opId must be get:<sessionId>:<token> with nonempty colon-free token")
  return raw as unknown as FdGetRequest
}

function validateMessagesRequest(raw: unknown): FdMessagesRequest {
  if (!isRecord(raw)) throw new Error("params must be object")
  if (raw.v !== FD_MESSAGES_VERSION) throw new Error("v must be 1")
  if (!isNonEmpty(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmpty(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== FD_MESSAGES_OP) throw new Error("op must be session/messages")
  if (!isNonEmpty(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId for messages")
  const ctx = raw.context
  if (!isRecord(ctx)) throw new Error("context must be object")
  const allowedCtx = new Set(["directory", "sessionId"])
  for (const k of Object.keys(ctx)) if (!allowedCtx.has(k)) throw new Error(`unexpected context field ${k}`)
  if (typeof ctx.directory !== "string" || ctx.directory.length === 0)
    throw new Error("context.directory must be non-empty string")
  canonicalDirectory(ctx.directory)
  if (typeof ctx.sessionId !== "string" || !Schema.is(SessionID)(ctx.sessionId))
    throw new Error("context.sessionId must be SessionID")
  const payload = raw.payload
  if (!isRecord(payload)) throw new Error("payload must be object")
  const allowedPayload = new Set(["limit", "before"])
  for (const k of Object.keys(payload)) if (!allowedPayload.has(k)) throw new Error(`unexpected payload field ${k}`)
  const limit = (payload as Record<string, unknown>).limit
  if (limit !== undefined) {
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0 || limit > Number.MAX_SAFE_INTEGER)
      throw new Error("payload.limit must be non-negative integer")
  }
  const before = (payload as Record<string, unknown>).before
  if (before !== undefined) {
    if (typeof before !== "string" || before.length === 0) throw new Error("payload.before must be non-empty string")
    if (limit === undefined) throw new Error("payload.before requires payload.limit")
  }
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw)) if (!allowedRoot.has(k)) throw new Error(`unexpected field ${k}`)
  const opId = raw.opId as string
  const sid = ctx.sessionId as string
  const prefix = `messages:${sid}:`
  if (!opId.startsWith(prefix))
    throw new Error("opId must be messages:<sessionId>:<token> with nonempty colon-free token")
  const token = opId.slice(prefix.length)
  if (token.length === 0 || token.includes(":"))
    throw new Error("opId must be messages:<sessionId>:<token> with nonempty colon-free token")
  return raw as unknown as FdMessagesRequest
}

function validateChildrenRequest(raw: unknown): FdChildrenRequest {
  if (!isRecord(raw)) throw new Error("params must be object")
  if (raw.v !== FD_CHILDREN_VERSION) throw new Error("v must be 1")
  if (!isNonEmpty(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmpty(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== FD_CHILDREN_OP) throw new Error("op must be session/children")
  if (!isNonEmpty(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId for children")
  const ctx = raw.context
  if (!isRecord(ctx)) throw new Error("context must be object")
  const allowedCtx = new Set(["directory", "parentSessionId"])
  for (const k of Object.keys(ctx)) if (!allowedCtx.has(k)) throw new Error(`unexpected context field ${k}`)
  if (typeof ctx.directory !== "string" || ctx.directory.length === 0)
    throw new Error("context.directory must be non-empty string")
  canonicalDirectory(ctx.directory)
  if (typeof ctx.parentSessionId !== "string" || !Schema.is(SessionID)(ctx.parentSessionId))
    throw new Error("context.parentSessionId must be SessionID")
  const payload = raw.payload
  if (!isRecord(payload)) throw new Error("payload must be object")
  if (Object.keys(payload).length !== 0) throw new Error("payload must be empty object for children")
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw)) if (!allowedRoot.has(k)) throw new Error(`unexpected field ${k}`)
  const opId = raw.opId as string
  const pid = ctx.parentSessionId as string
  const prefix = `children:${pid}:`
  if (!opId.startsWith(prefix))
    throw new Error("opId must be children:<parentSessionId>:<token> with nonempty colon-free token")
  const token = opId.slice(prefix.length)
  if (token.length === 0 || token.includes(":"))
    throw new Error("opId must be children:<parentSessionId>:<token> with nonempty colon-free token")
  return raw as unknown as FdChildrenRequest
}

function validateRemoteStatusRequest(raw: unknown): FdRemoteStatusRequest {
  if (!isRecord(raw)) throw new Error("params must be object")
  if (raw.v !== FD_REMOTE_STATUS_VERSION) throw new Error("v must be 1")
  if (!isNonEmpty(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmpty(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== FD_REMOTE_STATUS_OP) throw new Error("op must be remote/status")
  if (!isNonEmpty(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId for remote-status")
  const ctx = raw.context
  if (!isRecord(ctx)) throw new Error("context must be object")
  const allowedCtx = new Set(["directory", "workspace"])
  for (const k of Object.keys(ctx)) if (!allowedCtx.has(k)) throw new Error(`unexpected context field ${k}`)
  if (typeof ctx.directory !== "string" || ctx.directory.length === 0)
    throw new Error("context.directory must be non-empty string")
  canonicalDirectory(ctx.directory)
  if (ctx.workspace !== undefined) {
    if (typeof ctx.workspace !== "string" || ctx.workspace.length === 0 || (ctx.workspace as string).includes("\0"))
      throw new Error("context.workspace must be non-empty string when present")
  }
  const payload = raw.payload
  if (!isRecord(payload)) throw new Error("payload must be object")
  if (Object.keys(payload).length !== 0) throw new Error("payload must be empty object for remote-status")
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw)) if (!allowedRoot.has(k)) throw new Error(`unexpected field ${k}`)
  const opId = raw.opId as string
  const segs = opId.split(":")
  if (segs.length !== 2 || segs[0] !== "remote-status" || segs[1]!.length === 0)
    throw new Error("opId must be remote-status:<token> with nonempty colon-free token")
  if ((segs[1] as string).includes(":"))
    throw new Error("opId must be remote-status:<token> with nonempty colon-free token")
  return raw as unknown as FdRemoteStatusRequest
}

function validateSessionListRequest(raw: unknown): FdSessionListRequest {
  if (!isRecord(raw)) throw new Error("params must be object")
  if (raw.v !== FD_SESSION_LIST_VERSION) throw new Error("v must be 2")
  if (!isNonEmpty(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmpty(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== FD_SESSION_LIST_OP) throw new Error("op must be experimental/session/list")
  if (!isNonEmpty(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId for session-list")
  const ctx = raw.context
  if (!isRecord(ctx)) throw new Error("context must be object")
  const allowedCtx = new Set(["directory", "workspace"])
  for (const k of Object.keys(ctx)) if (!allowedCtx.has(k)) throw new Error(`unexpected context field ${k}`)
  if (typeof ctx.directory !== "string" || ctx.directory.length === 0)
    throw new Error("context.directory must be non-empty string")
  canonicalDirectory(ctx.directory)
  if (ctx.workspace !== undefined) {
    if (typeof ctx.workspace !== "string" || ctx.workspace.length === 0 || (ctx.workspace as string).includes("\0"))
      throw new Error("context.workspace must be non-empty string when present")
  }
  const payload = raw.payload
  if (!isRecord(payload)) throw new Error("payload must be object")
  const allowedPayload = new Set(["filter"])
  for (const k of Object.keys(payload)) if (!allowedPayload.has(k)) throw new Error(`unexpected payload field ${k}`)
  const filter = (payload as Record<string, unknown>).filter
  if (!isRecord(filter)) throw new Error("payload.filter must be object")
  const allowedFilter = new Set(["projectID", "roots", "start", "cursor", "search", "limit", "archived"])
  for (const k of Object.keys(filter)) if (!allowedFilter.has(k)) throw new Error(`unexpected filter field ${k}`)
  const rec = filter as Record<string, unknown>
  if (rec.projectID !== undefined && !isNonEmpty(rec.projectID))
    throw new Error("filter.projectID must be non-empty string when present")
  if (rec.roots !== undefined && typeof rec.roots !== "boolean")
    throw new Error("filter.roots must be boolean when present")
  if (rec.start !== undefined && (typeof rec.start !== "number" || !Number.isFinite(rec.start)))
    throw new Error("filter.start must be finite number when present")
  if (rec.cursor !== undefined) decodeSessionListCursor(rec.cursor)
  if (rec.search !== undefined && typeof rec.search !== "string")
    throw new Error("filter.search must be string when present")
  if (rec.limit !== undefined) {
    if (typeof rec.limit !== "number" || !Number.isInteger(rec.limit) || (rec.limit as number) <= 0)
      throw new Error("filter.limit must be positive integer when present")
  }
  if (rec.archived !== undefined && typeof rec.archived !== "boolean")
    throw new Error("filter.archived must be boolean when present")
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw)) if (!allowedRoot.has(k)) throw new Error(`unexpected field ${k}`)
  const opId = raw.opId as string
  const parts = opId.split(":")
  if (parts.length !== 2 || parts[0] !== "experimental-session-list" || parts[1]!.length === 0)
    throw new Error("opId must be experimental-session-list:<token> with nonempty colon-free token")
  return raw as unknown as FdSessionListRequest
}

function validatePathRequest(raw: unknown): FdPathRequest {
  if (!isRecord(raw)) throw new Error("params must be object")
  if (raw.v !== FD_PATH_VERSION) throw new Error("v must be 1")
  if (!isNonEmpty(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmpty(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== FD_PATH_OP) throw new Error("op must be path/get")
  if (!isNonEmpty(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId for path")
  const ctx = raw.context
  if (!isRecord(ctx)) throw new Error("context must be object")
  const allowedCtx = new Set(["directory", "workspace"])
  // Path redaction: unknown field names are never echoed — they may carry
  // path-bearing keys (audit: arbitrary keys reached the private failure).
  for (const k of Object.keys(ctx)) if (!allowedCtx.has(k)) throw new Error("unexpected context field")
  if (typeof ctx.directory !== "string" || ctx.directory.length === 0)
    throw new Error("context.directory must be non-empty string")
  canonicalDirectory(ctx.directory)
  if (ctx.workspace !== undefined) {
    if (typeof ctx.workspace !== "string" || ctx.workspace.length === 0 || (ctx.workspace as string).includes("\0"))
      throw new Error("context.workspace must be non-empty string when present")
  }
  const payload = raw.payload
  if (!isRecord(payload)) throw new Error("payload must be object")
  if (Object.keys(payload).length !== 0) throw new Error("payload must be empty object for path")
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw)) if (!allowedRoot.has(k)) throw new Error("unexpected field")
  if (containsPathMaterial(raw.requestId as string))
    throw new Error("requestId must be non-empty string without path material")
  if (containsPathMaterial(raw.idempotencyKey as string))
    throw new Error("idempotencyKey must be non-empty string without path material")
  const opId = raw.opId as string
  const segs = opId.split(":")
  if (segs.length !== 2 || segs[0] !== "path" || segs[1]!.length === 0)
    throw new Error("opId must be path:<token> with nonempty colon-free token")
  const token = segs[1] as string
  if (token.includes(":") || containsPathMaterial(token))
    throw new Error("opId must be path:<token> with nonempty colon-free token")
  return raw as unknown as FdPathRequest
}

function validateCommandListRequest(raw: unknown): FdCommandListRequest {
  if (!isRecord(raw)) throw new Error("params must be object")
  if (raw.v !== FD_COMMAND_LIST_VERSION) throw new Error("v must be 1")
  if (!isNonEmpty(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmpty(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== FD_COMMAND_LIST_OP) throw new Error("op must be command/list")
  if (!isNonEmpty(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId for command-list")
  const ctx = raw.context
  if (!isRecord(ctx)) throw new Error("context must be object")
  const allowedCtx = new Set(["directory", "workspace"])
  // Redaction (audit F-002): unknown field names are never echoed — they may
  // carry path-bearing keys (e.g. `/tmp/secret`).
  for (const k of Object.keys(ctx)) if (!allowedCtx.has(k)) throw new Error("unexpected context field")
  if (typeof ctx.directory !== "string" || ctx.directory.length === 0)
    throw new Error("context.directory must be non-empty string")
  canonicalDirectory(ctx.directory)
  if (ctx.workspace !== undefined) {
    if (typeof ctx.workspace !== "string" || ctx.workspace.length === 0 || (ctx.workspace as string).includes("\0"))
      throw new Error("context.workspace must be non-empty string when present")
  }
  const payload = raw.payload
  if (!isRecord(payload)) throw new Error("payload must be object")
  if (Object.keys(payload).length !== 0) throw new Error("payload must be empty object for command-list")
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw)) if (!allowedRoot.has(k)) throw new Error("unexpected field")
  // Path-bearing identities are never echoed (audit F-002): reject values
  // carrying `/`, `\`, or NUL before they can reach the failure wire.
  if (containsPathMaterial(raw.requestId as string))
    throw new Error("requestId must be non-empty string without path material")
  if (containsPathMaterial(raw.idempotencyKey as string))
    throw new Error("idempotencyKey must be non-empty string without path material")
  const opId = raw.opId as string
  const segs = opId.split(":")
  if (segs.length !== 2 || segs[0] !== "command-list" || segs[1]!.length === 0)
    throw new Error("opId must be command-list:<token> with nonempty colon-free token")
  const token = segs[1] as string
  if (token.includes(":") || containsPathMaterial(token))
    throw new Error("opId must be command-list:<token> with nonempty colon-free token")
  return raw as unknown as FdCommandListRequest
}

function validateConfigWarningsRequest(raw: unknown): FdConfigWarningsRequest {
  if (!isRecord(raw)) throw new Error("params must be object")
  if (raw.v !== FD_CONFIG_WARNINGS_VERSION) throw new Error("v must be 1")
  if (!isNonEmpty(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmpty(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== FD_CONFIG_WARNINGS_OP) throw new Error("op must be config/warnings")
  if (!isNonEmpty(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId for config-warnings")
  const ctx = raw.context
  if (!isRecord(ctx)) throw new Error("context must be object")
  const allowedCtx = new Set(["directory", "workspace"])
  // Redaction: unknown field names are never echoed — they may carry
  // path-bearing keys.
  for (const k of Object.keys(ctx)) if (!allowedCtx.has(k)) throw new Error("unexpected context field")
  if (typeof ctx.directory !== "string" || ctx.directory.length === 0)
    throw new Error("context.directory must be non-empty string")
  canonicalDirectory(ctx.directory)
  if (ctx.workspace !== undefined) {
    if (typeof ctx.workspace !== "string" || ctx.workspace.length === 0 || (ctx.workspace as string).includes("\0"))
      throw new Error("context.workspace must be non-empty string when present")
  }
  const payload = raw.payload
  if (!isRecord(payload)) throw new Error("payload must be object")
  if (Object.keys(payload).length !== 0) throw new Error("payload must be empty object for config-warnings")
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw)) if (!allowedRoot.has(k)) throw new Error("unexpected field")
  // Path-bearing identities are never echoed: reject values carrying `/`,
  // `\`, or NUL before they can reach the failure wire.
  if (containsPathMaterial(raw.requestId as string))
    throw new Error("requestId must be non-empty string without path material")
  if (containsPathMaterial(raw.idempotencyKey as string))
    throw new Error("idempotencyKey must be non-empty string without path material")
  const opId = raw.opId as string
  const segs = opId.split(":")
  if (segs.length !== 2 || segs[0] !== "config-warnings" || segs[1]!.length === 0)
    throw new Error("opId must be config-warnings:<token> with nonempty colon-free token")
  const token = segs[1] as string
  if (token.includes(":") || containsPathMaterial(token))
    throw new Error("opId must be config-warnings:<token> with nonempty colon-free token")
  return raw as unknown as FdConfigWarningsRequest
}

export type ConfigWarningsPathCategory = "config-file" | "agent-file" | "command-file" | "other"
export type ConfigWarningsMessageCategory =
  | "invalid-json"
  | "invalid-config"
  | "invalid-file"
  | "parse-agent"
  | "parse-command"
  | "substitute-agent"
  | "unknown"

export interface ConfigWarningsSafeEntry {
  pathCategory: ConfigWarningsPathCategory
  messageCategory: ConfigWarningsMessageCategory
}

export function configWarningsPathCategory(p: string): ConfigWarningsPathCategory {
  const lower = p.toLowerCase()
  if (lower.includes("agent")) return "agent-file"
  if (lower.includes("command")) return "command-file"
  if (lower.endsWith(".json") || lower.endsWith(".jsonc")) return "config-file"
  return "other"
}

export function configWarningsMessageCategory(m: string): ConfigWarningsMessageCategory {
  if (m.startsWith("Config file at") && m.includes("is not valid JSON")) return "invalid-json"
  if (m.startsWith("Configuration is invalid at")) return "invalid-config"
  if (m.startsWith("Config file at") && m.includes("is invalid")) return "invalid-file"
  if (m.startsWith("Failed to parse agent")) return "parse-agent"
  if (m.startsWith("Failed to parse command")) return "parse-command"
  if (m.startsWith("Failed to substitute variables in agent")) return "substitute-agent"
  return "unknown"
}

export function projectConfigWarningForCarrier(item: unknown): ConfigWarningsSafeEntry | null {
  if (!isRecord(item)) return null
  const p = (item as Record<string, unknown>).path
  const m = (item as Record<string, unknown>).message
  if (typeof p !== "string" || p.length === 0) return null
  if (typeof m !== "string" || m.length === 0) return null
  return { pathCategory: configWarningsPathCategory(p), messageCategory: configWarningsMessageCategory(m) }
}

function validateProjectCurrentRequest(raw: unknown): FdProjectCurrentRequest {
  if (!isRecord(raw)) throw new Error("params must be object")
  if (raw.v !== FD_PROJECT_CURRENT_VERSION) throw new Error("v must be 1")
  if (!isNonEmpty(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmpty(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== FD_PROJECT_CURRENT_OP) throw new Error("op must be project/current")
  if (!isNonEmpty(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId for project-current")
  const ctx = raw.context
  if (!isRecord(ctx)) throw new Error("context must be object")
  const allowedCtx = new Set(["directory", "workspace"])
  for (const k of Object.keys(ctx)) if (!allowedCtx.has(k)) throw new Error("unexpected context field")
  if (typeof ctx.directory !== "string" || ctx.directory.length === 0)
    throw new Error("context.directory must be non-empty string")
  canonicalDirectory(ctx.directory)
  if (ctx.workspace !== undefined) {
    if (typeof ctx.workspace !== "string" || ctx.workspace.length === 0 || (ctx.workspace as string).includes("\0"))
      throw new Error("context.workspace must be non-empty string when present")
  }
  const payload = raw.payload
  if (!isRecord(payload)) throw new Error("payload must be object")
  if (Object.keys(payload).length !== 0) throw new Error("payload must be empty object for project-current")
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw)) if (!allowedRoot.has(k)) throw new Error("unexpected field")
  if (containsPathMaterial(raw.requestId as string))
    throw new Error("requestId must be non-empty string without path material")
  if (containsPathMaterial(raw.idempotencyKey as string))
    throw new Error("idempotencyKey must be non-empty string without path material")
  const opId = raw.opId as string
  const segs = opId.split(":")
  if (segs.length !== 2 || segs[0] !== "project-current" || segs[1]!.length === 0)
    throw new Error("opId must be project-current:<token> with nonempty colon-free token")
  const token = segs[1] as string
  if (token.includes(":") || containsPathMaterial(token))
    throw new Error("opId must be project-current:<token> with nonempty colon-free token")
  return raw as unknown as FdProjectCurrentRequest
}

function validateStatusRequest(raw: unknown): FdStatusRequest {
  if (!isRecord(raw)) throw new Error("params must be object")
  if (raw.v !== FD_STATUS_VERSION) throw new Error("v must be 1")
  if (!isNonEmpty(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmpty(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== FD_STATUS_OP) throw new Error("op must be session/status")
  if (!isNonEmpty(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId for status")
  const ctx = raw.context
  if (!isRecord(ctx)) throw new Error("context must be object")
  const allowedCtx = new Set(["directory"])
  for (const k of Object.keys(ctx)) if (!allowedCtx.has(k)) throw new Error(`unexpected context field ${k}`)
  if (typeof ctx.directory !== "string" || ctx.directory.length === 0)
    throw new Error("context.directory must be non-empty string")
  canonicalDirectory(ctx.directory)
  const payload = raw.payload
  if (!isRecord(payload)) throw new Error("payload must be object")
  if (Object.keys(payload).length !== 0) throw new Error("payload must be empty object for status")
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw)) if (!allowedRoot.has(k)) throw new Error(`unexpected field ${k}`)
  return raw as unknown as FdStatusRequest
}

function fallbackIds(raw: unknown): { requestId: string; opId: string; idempotencyKey: string } {
  const o = (isRecord(raw) ? raw : {}) as Record<string, unknown>
  const requestId = isNonEmpty(o.requestId) ? (o.requestId as string) : "unknown"
  const opId = isNonEmpty(o.opId) ? (o.opId as string) : "unknown"
  const idempotencyKey = isNonEmpty(o.idempotencyKey) ? (o.idempotencyKey as string) : "unknown"
  return { requestId, opId, idempotencyKey }
}

function containsPathMaterial(v: string): boolean {
  return v.includes("/") || v.includes("\\") || v.includes("\0")
}

function sanitizePathId(v: unknown): string {
  if (typeof v !== "string" || v.length === 0) return "unknown"
  if (containsPathMaterial(v)) return "unknown"
  return v
}

function fallbackPathIds(raw: unknown): { requestId: string; opId: string; idempotencyKey: string } {
  const o = (isRecord(raw) ? raw : {}) as Record<string, unknown>
  return {
    requestId: sanitizePathId(o.requestId),
    opId: sanitizePathId(o.opId),
    idempotencyKey: sanitizePathId(o.idempotencyKey),
  }
}

function safePathIdentities(req: { requestId: string; opId: string; idempotencyKey: string }): {
  requestId: string
  opId: string
  idempotencyKey: string
} {
  return {
    requestId: sanitizePathId(req.requestId),
    opId: sanitizePathId(req.opId),
    idempotencyKey: sanitizePathId(req.idempotencyKey),
  }
}

function fallbackCommandListIds(raw: unknown): { requestId: string; opId: string; idempotencyKey: string } {
  const o = (isRecord(raw) ? raw : {}) as Record<string, unknown>
  return {
    requestId: sanitizePathId(o.requestId),
    opId: sanitizePathId(o.opId),
    idempotencyKey: sanitizePathId(o.idempotencyKey),
  }
}

function safeCommandListIdentities(req: { requestId: string; opId: string; idempotencyKey: string }): {
  requestId: string
  opId: string
  idempotencyKey: string
} {
  return {
    requestId: sanitizePathId(req.requestId),
    opId: sanitizePathId(req.opId),
    idempotencyKey: sanitizePathId(req.idempotencyKey),
  }
}

function fallbackConfigWarningsIds(raw: unknown): { requestId: string; opId: string; idempotencyKey: string } {
  const o = (isRecord(raw) ? raw : {}) as Record<string, unknown>
  return {
    requestId: sanitizePathId(o.requestId),
    opId: sanitizePathId(o.opId),
    idempotencyKey: sanitizePathId(o.idempotencyKey),
  }
}

function safeConfigWarningsIdentities(req: { requestId: string; opId: string; idempotencyKey: string }): {
  requestId: string
  opId: string
  idempotencyKey: string
} {
  return {
    requestId: sanitizePathId(req.requestId),
    opId: sanitizePathId(req.opId),
    idempotencyKey: sanitizePathId(req.idempotencyKey),
  }
}

const PATH_FENCE_MESSAGE = "Instance is unavailable during config rebuild; no active runtime for this request"
const PATH_INTERNAL_MESSAGE = "internal error"
const COMMAND_LIST_FENCE_MESSAGE = "Instance is unavailable during config rebuild; no active runtime for this request"
const COMMAND_LIST_INTERNAL_MESSAGE = "internal error"
const CONFIG_WARNINGS_FENCE_MESSAGE =
  "Instance is unavailable during config rebuild; no active runtime for this request"
const CONFIG_WARNINGS_INTERNAL_MESSAGE = "internal error"
const CONFIG_WARNINGS_VALIDATION_MESSAGE = "invalid config-warnings request"

function fallbackProjectCurrentIds(raw: unknown): { requestId: string; opId: string; idempotencyKey: string } {
  const o = (isRecord(raw) ? raw : {}) as Record<string, unknown>
  return {
    requestId: sanitizePathId(o.requestId),
    opId: sanitizePathId(o.opId),
    idempotencyKey: sanitizePathId(o.idempotencyKey),
  }
}

function safeProjectCurrentIdentities(req: { requestId: string; opId: string; idempotencyKey: string }): {
  requestId: string
  opId: string
  idempotencyKey: string
} {
  return {
    requestId: sanitizePathId(req.requestId),
    opId: sanitizePathId(req.opId),
    idempotencyKey: sanitizePathId(req.idempotencyKey),
  }
}

const PROJECT_CURRENT_FENCE_MESSAGE =
  "Instance is unavailable during config rebuild; no active runtime for this request"
const PROJECT_CURRENT_INTERNAL_MESSAGE = "internal error"
const PROJECT_CURRENT_VALIDATION_MESSAGE = "invalid project-current request"

function findFilesFailed(
  req: { requestId: string; opId: string; idempotencyKey: string },
  code: string,
  message: string,
  retryable: boolean,
): Record<string, unknown> {
  const time = Date.now()
  const failure = { code, message, retryable }
  return {
    v: FD_FIND_FILES_VERSION,
    requestId: req.requestId,
    opId: req.opId,
    op: FD_FIND_FILES_OP,
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time, failure },
    accepted: false,
    failure,
  }
}

function fallbackFindFilesIds(raw: unknown): { requestId: string; opId: string; idempotencyKey: string } {
  const o = (isRecord(raw) ? raw : {}) as Record<string, unknown>
  return {
    requestId: sanitizePathId(o.requestId),
    opId: sanitizePathId(o.opId),
    idempotencyKey: sanitizePathId(o.idempotencyKey),
  }
}

function safeFindFilesIdentities(req: { requestId: string; opId: string; idempotencyKey: string }): {
  requestId: string
  opId: string
  idempotencyKey: string
} {
  return {
    requestId: sanitizePathId(req.requestId),
    opId: sanitizePathId(req.opId),
    idempotencyKey: sanitizePathId(req.idempotencyKey),
  }
}

const FIND_FILES_QUERY_MAX = 256
const FIND_FILES_LIMIT_MIN = 1
const FIND_FILES_LIMIT_MAX = 50
const FIND_FILES_RESULTS_MAX = 50
const FIND_FILES_FENCE_MESSAGE = "Instance is unavailable during config rebuild; no active runtime for this request"
const FIND_FILES_INTERNAL_MESSAGE = "internal error"
const FIND_FILES_VALIDATION_MESSAGE = "invalid find-files request"
const FIND_FILES_SCOPE_MESSAGE = "directory mismatch"

const FIND_FILES_SENSITIVE_SEGMENTS = new Set([".ssh", ".aws", "secret", "secrets"])
const FIND_FILES_SENSITIVE_EXTENSIONS = new Set(["pem", "key", "p12", "pfx", "cer", "crt", "der", "jks"])

export function isSensitiveFindFilesPath(rel: string): boolean {
  const lower = rel.toLowerCase()
  const segs = lower.split("/")
  for (const seg of segs) {
    if (FIND_FILES_SENSITIVE_SEGMENTS.has(seg)) return true
  }
  const base = segs[segs.length - 1]!
  if (base === ".env") return true
  if (base.startsWith(".env.") && base !== ".env.example") return true
  const dot = base.lastIndexOf(".")
  if (dot >= 0 && dot < base.length - 1) {
    const ext = base.slice(dot + 1)
    if (FIND_FILES_SENSITIVE_EXTENSIONS.has(ext)) return true
  }
  return false
}

export function validateFindFilesRelPath(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) throw new Error("find-files path must be non-empty string")
  if (raw.includes("\0")) throw new Error("find-files path must not contain NUL")
  if (raw.includes("\\")) throw new Error("find-files path must be POSIX-normalized")
  if (raw.includes(":")) throw new Error("find-files path must not carry URI or drive material")
  if (raw.startsWith("/")) throw new Error("find-files path must be relative")
  if (raw.includes("://")) throw new Error("find-files path must not carry URI material")
  const segs = raw.split("/")
  for (const seg of segs) {
    if (seg.length === 0) throw new Error("find-files path must be normalized")
    if (seg === "." || seg === "..") throw new Error("find-files path must not escape")
  }
  if (isSensitiveFindFilesPath(raw)) throw new Error("find-files path is sensitive")
  return raw
}

function validateFindFilesRequest(raw: unknown): FdFindFilesRequest {
  if (!isRecord(raw)) throw new Error("params must be object")
  if (raw.v !== FD_FIND_FILES_VERSION) throw new Error("v must be 1")
  if (!isNonEmpty(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmpty(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== FD_FIND_FILES_OP) throw new Error("op must be find/files")
  if (!isNonEmpty(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId for find-files")
  const ctx = raw.context
  if (!isRecord(ctx)) throw new Error("context must be object")
  const allowedCtx = new Set(["directory", "workspace"])
  for (const k of Object.keys(ctx)) if (!allowedCtx.has(k)) throw new Error("unexpected context field")
  if (typeof ctx.directory !== "string" || ctx.directory.length === 0)
    throw new Error("context.directory must be non-empty string")
  canonicalDirectory(ctx.directory)
  if (ctx.workspace !== undefined) {
    if (typeof ctx.workspace !== "string" || ctx.workspace.length === 0 || (ctx.workspace as string).includes("\0"))
      throw new Error("context.workspace must be non-empty string when present")
  }
  const payload = raw.payload
  if (!isRecord(payload)) throw new Error("payload must be object")
  const allowedPayload = new Set(["query", "type", "limit"])
  for (const k of Object.keys(payload)) if (!allowedPayload.has(k)) throw new Error("unexpected payload field")
  const rec = payload as Record<string, unknown>
  if (typeof rec.query !== "string" || rec.query.length === 0) throw new Error("payload.query must be non-empty string")
  if (rec.query.length > FIND_FILES_QUERY_MAX) throw new Error("payload.query must be at most 256 characters")
  if ((rec.query as string).includes("\0")) throw new Error("payload.query must not contain NUL")
  if (rec.type !== "file" && rec.type !== "directory") throw new Error("payload.type must be file or directory")
  if (rec.limit !== undefined) {
    if (typeof rec.limit !== "number" || !Number.isInteger(rec.limit)) throw new Error("payload.limit must be integer")
    if ((rec.limit as number) < FIND_FILES_LIMIT_MIN || (rec.limit as number) > FIND_FILES_LIMIT_MAX)
      throw new Error("payload.limit must be 1..50")
  }
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw)) if (!allowedRoot.has(k)) throw new Error("unexpected field")
  if (containsPathMaterial(raw.requestId as string))
    throw new Error("requestId must be non-empty string without path material")
  if (containsPathMaterial(raw.idempotencyKey as string))
    throw new Error("idempotencyKey must be non-empty string without path material")
  const opId = raw.opId as string
  const segs = opId.split(":")
  if (segs.length !== 2 || segs[0] !== "find-files" || segs[1]!.length === 0)
    throw new Error("opId must be find-files:<token> with nonempty colon-free token")
  const token = segs[1] as string
  if (token.includes(":") || containsPathMaterial(token))
    throw new Error("opId must be find-files:<token> with nonempty colon-free token")
  return raw as unknown as FdFindFilesRequest
}

export function createFdCarrier(reader: NodeJS.ReadableStream, writer: NodeJS.WritableStream): FdCarrierHandle {
  // Ensure streams are flowing
  try {
    ;(reader as unknown as { resume?: () => void }).resume?.()
  } catch (err) {
    console.warn("[kilo fd-carrier] reader resume failed:", String(err))
  }
  let peer: Peer | null = null
  const dispose = () => {
    try {
      peer?.dispose()
    } catch (err) {
      console.warn("[kilo fd-carrier] peer dispose failed:", String(err))
    }
    bestEffortClose(reader, "reader")
    bestEffortClose(writer, "writer")
  }
  peer = new Peer({
    reader,
    writer,
    onClosed: () => {
      // EOF closes peer and destroys streams idempotently; peer already closed
      bestEffortClose(reader, "reader-onClosed")
      bestEffortClose(writer, "writer-onClosed")
    },
    onRequest: async (method: string, params: unknown) => {
      if (method === "initialize") {
        // validate major fail-closed
        try {
          validateProtocolVersion(params)
        } catch (e) {
          const code = (e as { code?: number })?.code ?? ErrorCode.InvalidParams
          const err = new Error(e instanceof Error ? e.message : String(e)) as Error & { code: number }
          err.code = code
          throw err
        }
        return buildInitializeResult()
      }
      // pre-init guard: all other methods require initialized
      if (!peer!.isInitialized()) {
        const err = new Error("Not initialized") as Error & { code: number }
        err.code = ErrorCode.InvalidRequest
        throw err
      }
      if (method === "session/cancelQueued") {
        // Route directly to B0 dispatch via AppRuntime, preserving typed envelope
        const result = await AppRuntime.runPromise(
          // @ts-ignore - AppRuntime provides CancelQueuedDispatch and all deps via AppLayer
          Effect.gen(function* () {
            const svc = yield* CancelQueuedDispatchService
            return yield* (svc.dispatch as (p: unknown) => Effect.Effect<unknown>)(params)
          }),
        )
        return result
      }
      if (method === "session/update") {
        const result = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const svc = yield* SessionUpdateDispatchService
            // Private-first authoritative: private-carrier fail-closed request
            // validation (explicit parentSessionId null + all private constraints)
            // runs before authoritative dispatch. Strict failure returns via the
            // replay-only fail-closed path without mutation.
            try {
              validatePrivateRequest(params)
            } catch {
              const fail = (svc as unknown as { dispatchPrivate?: (p: unknown) => Effect.Effect<unknown> })
                .dispatchPrivate
              if (!fail) {
                const err = new Error("session/update private authoritative unavailable") as Error & { code: number }
                err.code = ErrorCode.MethodNotFound
                throw err
              }
              return yield* (fail as (p: unknown) => Effect.Effect<unknown>)(params)
            }
            // Private-first authoritative: missing dispatch fails closed without mutation
            const fn = (svc as unknown as { dispatch?: (p: unknown) => Effect.Effect<unknown> }).dispatch
            if (!fn) {
              const err = new Error("session/update private authoritative unavailable") as Error & { code: number }
              err.code = ErrorCode.MethodNotFound
              throw err
            }
            return yield* (fn as (p: unknown) => Effect.Effect<unknown>)(params)
          }),
        )
        return result
      }
      if (method === "session/fork") {
        const result = (await AppRuntime.runPromise(
          Effect.gen(function* () {
            const svc = yield* SessionForkDispatchService
            return yield* (svc.dispatch as (p: unknown) => Effect.Effect<unknown>)(params)
          }),
        )) as Record<string, unknown>
        if (result && (result as { status?: string }).status === "succeeded" && (result as { data?: unknown }).data) {
          const data = (result as { data: unknown }).data
          if (data && typeof data === "object" && !Array.isArray(data) && (data as Record<string, unknown>).session === undefined) {
            return { ...(result as object), data: { session: data } }
          }
        }
        return result
      }
      if (method === "session/create") {
        const result = (await AppRuntime.runPromise(
          Effect.gen(function* () {
            const svc = yield* SessionCreateDispatchService
            return yield* (svc.dispatch as (p: unknown) => Effect.Effect<unknown>)(params)
          }),
        )) as Record<string, unknown>
        if (result && (result as { status?: string }).status === "succeeded" && (result as { data?: unknown }).data) {
          const data = (result as { data: unknown }).data
          if (data && typeof data === "object" && !Array.isArray(data) && (data as Record<string, unknown>).session === undefined) {
            return { ...(result as object), data: { session: data } }
          }
        }
        return result
      }
      if (method === "session/delete") {
        const result = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const svc = yield* SessionDeleteDispatchService
            const fn = (svc as unknown as { dispatch?: (p: unknown) => Effect.Effect<unknown> }).dispatch
            if (!fn) {
              const err = new Error("session/delete private authoritative unavailable") as Error & { code: number }
              err.code = ErrorCode.MethodNotFound
              throw err
            }
            return yield* (fn as (p: unknown) => Effect.Effect<unknown>)(params)
          }),
        )
        return result
      }
      if (method === "session/abort") {
        // Production abort: validates the abort tuple, awaits the existing
        // cancellation owner (cancelTree over SessionRunState) until terminal
        // convergence, then returns. No durable operation row, no revision.
        // Envelope validation runs before drain acquisition so malformed
        // requests fail as InvalidParams without touching runtime state.
        try {
          validateAbortEnvelope(params)
        } catch (e) {
          const err = new Error(e instanceof Error ? e.message : String(e)) as Error & { code: number }
          err.code = ErrorCode.InvalidParams
          throw err
        }
        const result = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const dir = (() => {
              try {
                const p = params as Record<string, unknown>
                const ctx = p.context as Record<string, unknown> | undefined
                if (typeof ctx?.directory !== "string") throw new Error("context.directory must be non-empty string")
                return canonicalDirectory(ctx.directory)
              } catch (e) {
                const err = new Error(e instanceof Error ? e.message : String(e)) as Error & { code: number }
                err.code = ErrorCode.InvalidParams
                throw err
              }
            })()
            const acquired = yield* acquireDrainControl(dir).pipe(
              Effect.map((v) => ({ tag: "ok" as const, value: v })),
              Effect.catch((err: unknown) => Effect.succeed({ tag: "fail" as const, err })),
              Effect.catchDefect((defect: unknown) => Effect.succeed({ tag: "fail" as const, err: defect })),
            )
            if (acquired.tag !== "ok") throw acquired.err
            const inner = Effect.gen(function* () {
              return yield* abortSessionPrivate(params)
            }).pipe(Effect.provideService(InstanceRef, acquired.value.ctx), Effect.ensuring(acquired.value.release))
            return yield* inner
          }),
        )
        return result
      }
      if (method === "session/status") {
        // B5 parity-only read-only: same-directory StatusMap via drain-control snapshot, never mutates.
        const result = await AppRuntime.runPromise(
          Effect.gen(function* () {
            let req: FdStatusRequest
            try {
              req = validateStatusRequest(params)
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e)
              return statusFailed(fallbackIds(params), "validation.failed", msg, false)
            }
            const dir = canonicalDirectory(req.context.directory)
            const acquired = yield* acquireDrainControl(dir).pipe(
              Effect.map((v) => ({ tag: "ok" as const, value: v })),
              Effect.catch((err: unknown) => {
                const fence = err instanceof InstanceUnavailableDuringConfigRebuildError
                const msg = err instanceof Error ? err.message : String(err)
                const code = fence ? "InstanceUnavailableDuringConfigRebuild" : "internal"
                return Effect.succeed({
                  tag: "fail" as const,
                  result: statusFailed(req, code, msg, fence),
                })
              }),
              Effect.catchDefect((defect: unknown) => {
                const msg = defect instanceof Error ? defect.message : String(defect)
                return Effect.succeed({ tag: "fail" as const, result: statusFailed(req, "internal", msg, false) })
              }),
            )
            if (acquired.tag !== "ok") return acquired.result
            const inner = Effect.gen(function* () {
              const svc = yield* SessionStatus.Service
              const map = yield* svc.list()
              return {
                v: FD_STATUS_VERSION,
                requestId: req.requestId,
                opId: req.opId,
                op: FD_STATUS_OP,
                idempotencyKey: req.idempotencyKey,
                status: "succeeded",
                outcome: { type: "succeeded", time: Date.now() },
                accepted: true,
                data: { statuses: Object.fromEntries(map) },
              }
            }).pipe(Effect.provideService(InstanceRef, acquired.value.ctx), Effect.ensuring(acquired.value.release))
            return yield* inner.pipe(
              Effect.catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err)
                return Effect.succeed(statusFailed(req, "internal", msg, false))
              }),
              Effect.catchDefect((defect: unknown) => {
                const msg = defect instanceof Error ? defect.message : String(defect)
                return Effect.succeed(statusFailed(req, "internal", msg, false))
              }),
            )
          }),
        )
        return result
      }
      if (method === "session/get") {
        // B6 parity-only read-only: same-directory Session.Info via drain-control snapshot, never mutates.
        const result = await AppRuntime.runPromise(
          Effect.gen(function* () {
            let req: FdGetRequest
            try {
              req = validateGetRequest(params)
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e)
              return getFailed(fallbackIds(params), "validation.failed", boundGetMessage(msg), false)
            }
            const dir = canonicalDirectory(req.context.directory)
            const acquired = yield* acquireDrainControl(dir).pipe(
              Effect.map((v) => ({ tag: "ok" as const, value: v })),
              Effect.catch((err: unknown) => {
                const fence =
                  err instanceof InstanceUnavailableDuringConfigRebuildError ||
                  (err as { _tag?: string })?._tag === "InstanceUnavailableDuringConfigRebuild"
                const code = fence ? "InstanceUnavailableDuringConfigRebuild" : "internal"
                const message = fence
                  ? boundGetMessage(err instanceof Error ? err.message : String(err))
                  : "internal error"
                return Effect.succeed({
                  tag: "fail" as const,
                  result: getFailed(req, code, message, fence),
                })
              }),
              Effect.catchDefect(() => {
                return Effect.succeed({
                  tag: "fail" as const,
                  result: getFailed(req, "internal", "internal error", false),
                })
              }),
            )
            if (acquired.tag !== "ok") return acquired.result
            const inner = Effect.gen(function* () {
              const svc = yield* Session.Service
              const sid = SessionID.make(req.context.sessionId)
              const found = yield* svc.get(sid).pipe(
                Effect.map((v) => ({ tag: "ok" as const, value: v })),
                Effect.catch((err: unknown) => {
                  const missing = err instanceof NotFoundError || (err as { _tag?: string })?._tag === "NotFoundError"
                  const code = missing ? "session.not_found" : "internal"
                  const message = missing ? "session not found" : "internal error"
                  return Effect.succeed({ tag: "fail" as const, code, message })
                }),
                Effect.catchDefect(() => {
                  return Effect.succeed({ tag: "fail" as const, code: "internal", message: "internal error" })
                }),
              )
              if (found.tag !== "ok") return getFailed(req, found.code, found.message, false)
              let stored: string
              try {
                stored = canonicalDirectory(found.value.directory)
              } catch {
                return getFailed(req, "internal", "internal error", false)
              }
              if (stored !== dir) return getFailed(req, "scope_mismatch", "directory mismatch", false)
              if (!Schema.is(Session.Info)(found.value)) return getFailed(req, "internal", "internal error", false)
              return {
                v: FD_GET_VERSION,
                requestId: req.requestId,
                opId: req.opId,
                op: FD_GET_OP,
                idempotencyKey: req.idempotencyKey,
                status: "succeeded",
                outcome: { type: "succeeded", time: Date.now() },
                accepted: true,
                data: { session: found.value },
              }
            }).pipe(Effect.provideService(InstanceRef, acquired.value.ctx), Effect.ensuring(acquired.value.release))
            return yield* inner.pipe(
              Effect.catch(() => {
                return Effect.succeed(getFailed(req, "internal", "internal error", false))
              }),
              Effect.catchDefect(() => {
                return Effect.succeed(getFailed(req, "internal", "internal error", false))
              }),
            )
          }),
        )
        return result
      }
      if (method === "session/messages") {
        // B7 diagnostic-only read-only: same-directory message page via drain-control snapshot, never mutates.
        const result = await AppRuntime.runPromise(
          Effect.gen(function* () {
            let req: FdMessagesRequest
            try {
              req = validateMessagesRequest(params)
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e)
              return messagesFailed(fallbackIds(params), "validation.failed", boundMessagesMessage(msg), false)
            }
            const dir = canonicalDirectory(req.context.directory)
            if (req.payload.before !== undefined) {
              try {
                MessageV2.cursor.decode(req.payload.before)
              } catch {
                return messagesFailed(req, "validation.failed", "invalid before cursor", false)
              }
            }
            const acquired = yield* acquireDrainControl(dir).pipe(
              Effect.map((v) => ({ tag: "ok" as const, value: v })),
              Effect.catch((err: unknown) => {
                const fence =
                  err instanceof InstanceUnavailableDuringConfigRebuildError ||
                  (err as { _tag?: string })?._tag === "InstanceUnavailableDuringConfigRebuild"
                const code = fence ? "InstanceUnavailableDuringConfigRebuild" : "internal"
                const message = fence
                  ? boundMessagesMessage(err instanceof Error ? err.message : String(err))
                  : "internal error"
                return Effect.succeed({
                  tag: "fail" as const,
                  result: messagesFailed(req, code, message, fence),
                })
              }),
              Effect.catchDefect(() => {
                return Effect.succeed({
                  tag: "fail" as const,
                  result: messagesFailed(req, "internal", "internal error", false),
                })
              }),
            )
            if (acquired.tag !== "ok") return acquired.result
            const inner = Effect.gen(function* () {
              const svc = yield* Session.Service
              const sid = SessionID.make(req.context.sessionId)
              const found = yield* svc.get(sid).pipe(
                Effect.map((v) => ({ tag: "ok" as const, value: v })),
                Effect.catch((err: unknown) => {
                  const missing = err instanceof NotFoundError || (err as { _tag?: string })?._tag === "NotFoundError"
                  const code = missing ? "session.not_found" : "internal"
                  const message = missing ? "session not found" : "internal error"
                  return Effect.succeed({ tag: "fail" as const, code, message })
                }),
                Effect.catchDefect(() => {
                  return Effect.succeed({ tag: "fail" as const, code: "internal", message: "internal error" })
                }),
              )
              if (found.tag !== "ok") return messagesFailed(req, found.code, found.message, false)
              let stored: string
              try {
                stored = canonicalDirectory(found.value.directory)
              } catch {
                return messagesFailed(req, "internal", "internal error", false)
              }
              if (stored !== dir) return messagesFailed(req, "scope_mismatch", "directory mismatch", false)
              const limit = req.payload.limit
              const full = limit === undefined || limit === 0
              if (full) {
                const list = yield* svc.messages({ sessionID: sid }).pipe(
                  Effect.map((v) => ({ tag: "ok" as const, value: v })),
                  Effect.catch((err: unknown) => {
                    const missing = err instanceof NotFoundError || (err as { _tag?: string })?._tag === "NotFoundError"
                    const code = missing ? "session.not_found" : "internal"
                    const message = missing ? "session not found" : "internal error"
                    return Effect.succeed({ tag: "fail" as const, code, message })
                  }),
                  Effect.catchDefect(() => {
                    return Effect.succeed({ tag: "fail" as const, code: "internal", message: "internal error" })
                  }),
                )
                if (list.tag !== "ok") return messagesFailed(req, list.code, list.message, false)
                if (!Array.isArray(list.value)) return messagesFailed(req, "internal", "internal error", false)
                return {
                  v: FD_MESSAGES_VERSION,
                  requestId: req.requestId,
                  opId: req.opId,
                  op: FD_MESSAGES_OP,
                  idempotencyKey: req.idempotencyKey,
                  status: "succeeded",
                  outcome: { type: "succeeded", time: Date.now() },
                  accepted: true,
                  data: { messages: list.value },
                }
              }
              const before = req.payload.before
              const page = yield* MessageV2.page({ sessionID: sid, limit: limit as number, before }).pipe(
                Effect.map((v) => ({ tag: "ok" as const, value: v })),
                Effect.catch((err: unknown) => {
                  const missing = err instanceof NotFoundError || (err as { _tag?: string })?._tag === "NotFoundError"
                  const code = missing ? "session.not_found" : "internal"
                  const message = missing ? "session not found" : "internal error"
                  return Effect.succeed({ tag: "fail" as const, code, message })
                }),
                Effect.catchDefect(() => {
                  return Effect.succeed({ tag: "fail" as const, code: "internal", message: "internal error" })
                }),
              )
              if (page.tag !== "ok") return messagesFailed(req, page.code, page.message, false)
              if (!Array.isArray(page.value.items)) return messagesFailed(req, "internal", "internal error", false)
              const next = page.value.more && page.value.cursor ? page.value.cursor : undefined
              return {
                v: FD_MESSAGES_VERSION,
                requestId: req.requestId,
                opId: req.opId,
                op: FD_MESSAGES_OP,
                idempotencyKey: req.idempotencyKey,
                status: "succeeded",
                outcome: { type: "succeeded", time: Date.now() },
                accepted: true,
                data: next ? { messages: page.value.items, nextCursor: next } : { messages: page.value.items },
              }
            }).pipe(Effect.provideService(InstanceRef, acquired.value.ctx), Effect.ensuring(acquired.value.release))
            return yield* inner.pipe(
              Effect.catch(() => {
                return Effect.succeed(messagesFailed(req, "internal", "internal error", false))
              }),
              Effect.catchDefect(() => {
                return Effect.succeed(messagesFailed(req, "internal", "internal error", false))
              }),
            )
          }),
        )
        return result
      }
      if (method === "session/children") {
        // B8 strict read-only: parent-directory bound Session.Info[] via drain-control snapshot, never mutates.
        const result = await AppRuntime.runPromise(
          Effect.gen(function* () {
            let req: FdChildrenRequest
            try {
              req = validateChildrenRequest(params)
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e)
              return childrenFailed(fallbackIds(params), "validation.failed", boundChildrenMessage(msg), false)
            }
            const dir = canonicalDirectory(req.context.directory)
            const preStore = yield* InstanceStore.Service
            const preGate = Option.getOrElse(
              yield* Effect.serviceOption(GenerationGate.Service),
              () => GenerationGate.noop,
            )
            const preSnap = yield* preStore.snapshot(dir).pipe(
              Effect.catch(() => Effect.succeed(Option.none())),
              Effect.catchDefect(() => Effect.succeed(Option.none())),
            )
            if (Option.isNone(preSnap) && preGate.isBarrierActive(dir)) {
              return childrenFailed(
                req,
                "InstanceUnavailableDuringConfigRebuild",
                boundChildrenMessage(
                  "Instance is unavailable during config rebuild; no active runtime for this request",
                ),
                true,
              )
            }
            const preSvc = yield* Session.Service
            const prePid = SessionID.make(req.context.parentSessionId)
            const preParent = yield* preSvc.get(prePid).pipe(
              Effect.map((v) => ({ tag: "ok" as const, value: v })),
              Effect.catch((err: unknown) => {
                const missing = err instanceof NotFoundError || (err as { _tag?: string })?._tag === "NotFoundError"
                const code = missing ? "session.not_found" : "internal"
                const message = missing ? "session not found" : "internal error"
                return Effect.succeed({ tag: "fail" as const, code, message })
              }),
              Effect.catchDefect(() => {
                return Effect.succeed({ tag: "fail" as const, code: "internal", message: "internal error" })
              }),
            )
            if (preParent.tag !== "ok") return childrenFailed(req, preParent.code, preParent.message, false)
            try {
              const preStored = canonicalDirectory(preParent.value.directory)
              if (preStored !== dir) return childrenFailed(req, "scope_mismatch", "directory mismatch", false)
            } catch {
              return childrenFailed(req, "internal", "internal error", false)
            }
            const acquired = yield* acquireDrainControl(dir).pipe(
              Effect.map((v) => ({ tag: "ok" as const, value: v })),
              Effect.catch((err: unknown) => {
                const fence =
                  err instanceof InstanceUnavailableDuringConfigRebuildError ||
                  (err as { _tag?: string })?._tag === "InstanceUnavailableDuringConfigRebuild"
                const code = fence ? "InstanceUnavailableDuringConfigRebuild" : "internal"
                const message = fence
                  ? boundChildrenMessage(err instanceof Error ? err.message : String(err))
                  : "internal error"
                return Effect.succeed({
                  tag: "fail" as const,
                  result: childrenFailed(req, code, message, fence),
                })
              }),
              Effect.catchDefect(() => {
                return Effect.succeed({
                  tag: "fail" as const,
                  result: childrenFailed(req, "internal", "internal error", false),
                })
              }),
            )
            if (acquired.tag !== "ok") return acquired.result
            const inner = Effect.gen(function* () {
              const svc = yield* Session.Service
              const pid = SessionID.make(req.context.parentSessionId)
              const parent = yield* svc.get(pid).pipe(
                Effect.map((v) => ({ tag: "ok" as const, value: v })),
                Effect.catch((err: unknown) => {
                  const missing = err instanceof NotFoundError || (err as { _tag?: string })?._tag === "NotFoundError"
                  const code = missing ? "session.not_found" : "internal"
                  const message = missing ? "session not found" : "internal error"
                  return Effect.succeed({ tag: "fail" as const, code, message })
                }),
                Effect.catchDefect(() => {
                  return Effect.succeed({ tag: "fail" as const, code: "internal", message: "internal error" })
                }),
              )
              if (parent.tag !== "ok") return childrenFailed(req, parent.code, parent.message, false)
              let stored: string
              try {
                stored = canonicalDirectory(parent.value.directory)
              } catch {
                return childrenFailed(req, "internal", "internal error", false)
              }
              if (stored !== dir) return childrenFailed(req, "scope_mismatch", "directory mismatch", false)
              const list = yield* svc.children(pid).pipe(
                Effect.map((v) => ({ tag: "ok" as const, value: v })),
                Effect.catch(() => {
                  return Effect.succeed({ tag: "fail" as const, code: "internal", message: "internal error" })
                }),
                Effect.catchDefect(() => {
                  return Effect.succeed({ tag: "fail" as const, code: "internal", message: "internal error" })
                }),
              )
              if (list.tag !== "ok") return childrenFailed(req, list.code, list.message, false)
              if (!Array.isArray(list.value)) return childrenFailed(req, "internal", "internal error", false)
              for (const item of list.value) {
                if (!Schema.is(Session.Info)(item)) return childrenFailed(req, "internal", "internal error", false)
                if ((item as Session.Info).parentID !== req.context.parentSessionId)
                  return childrenFailed(req, "internal", "internal error", false)
                try {
                  canonicalDirectory((item as Session.Info).directory)
                } catch {
                  return childrenFailed(req, "internal", "internal error", false)
                }
              }
              return {
                v: FD_CHILDREN_VERSION,
                requestId: req.requestId,
                opId: req.opId,
                op: FD_CHILDREN_OP,
                idempotencyKey: req.idempotencyKey,
                status: "succeeded",
                outcome: { type: "succeeded", time: Date.now() },
                accepted: true,
                data: { children: list.value },
              }
            }).pipe(Effect.provideService(InstanceRef, acquired.value.ctx), Effect.ensuring(acquired.value.release))
            return yield* inner.pipe(
              Effect.catch(() => {
                return Effect.succeed(childrenFailed(req, "internal", "internal error", false))
              }),
              Effect.catchDefect(() => {
                return Effect.succeed(childrenFailed(req, "internal", "internal error", false))
              }),
            )
          }),
        )
        return result
      }
      if (method === "remote/status") {
        // Remote-status parity-only read: process-global KiloSessions snapshot.
        // Directory/workspace are routing identity only; payload booleans are
        // never bound to the request directory. No mutation, no pagination,
        // no config ownership, no InstanceRef lane.
        const result = await AppRuntime.runPromise(
          Effect.gen(function* () {
            let req: FdRemoteStatusRequest
            try {
              req = validateRemoteStatusRequest(params)
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e)
              return remoteStatusFailed(fallbackIds(params), "validation.failed", boundRemoteStatusMessage(msg), false)
            }
            try {
              canonicalDirectory(req.context.directory)
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e)
              return remoteStatusFailed(req, "validation.failed", boundRemoteStatusMessage(msg), false)
            }
            if (req.context.workspace !== undefined) {
              const ws = req.context.workspace
              if (typeof ws !== "string" || ws.length === 0 || ws.includes("\0"))
                return remoteStatusFailed(req, "validation.failed", "invalid workspace", false)
            }
            const snap = yield* Effect.sync(() => KiloSessions.remoteStatus()).pipe(
              Effect.map((v) => ({ ok: true as const, v })),
              Effect.catch(() => Effect.succeed({ ok: false as const })),
              Effect.catchDefect(() => Effect.succeed({ ok: false as const })),
            )
            if (!snap.ok) return remoteStatusFailed(req, "internal", "internal error", false)
            const raw = snap.v as { enabled?: unknown; connected?: unknown }
            const enabled = raw.enabled === true
            const connected = raw.connected === true
            if (typeof raw.enabled !== "boolean") return remoteStatusFailed(req, "internal", "internal error", false)
            if (typeof raw.connected !== "boolean") return remoteStatusFailed(req, "internal", "internal error", false)
            return {
              v: FD_REMOTE_STATUS_VERSION,
              requestId: req.requestId,
              opId: req.opId,
              op: FD_REMOTE_STATUS_OP,
              idempotencyKey: req.idempotencyKey,
              status: "succeeded",
              outcome: { type: "succeeded", time: Date.now() },
              accepted: true,
              data: { status: { enabled, connected } },
            }
          }),
        )
        return result
      }
      if (method === "experimental/session/list") {
        // Session-list parity-only read: same-directory GlobalInfo page via
        // drain-control snapshot, projected to safe summaries with inline
        // optional opaque composite nextCursor matching production
        // x-next-cursor grammar ({v,updated,id} JSON/base64url, updated DESC,
        // id DESC). Directory/workspace are routing identity; workspace never
        // reaches the service. No mutation, no lifecycle claim.
        const result = await AppRuntime.runPromise(
          Effect.gen(function* () {
            let req: FdSessionListRequest
            try {
              req = validateSessionListRequest(params)
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e)
              return sessionListFailed(fallbackIds(params), "validation.failed", boundSessionListMessage(msg), false)
            }
            const dir = canonicalDirectory(req.context.directory)
            if (req.context.workspace !== undefined) {
              const ws = req.context.workspace
              if (typeof ws !== "string" || ws.length === 0 || ws.includes("\0"))
                return sessionListFailed(req, "validation.failed", "invalid workspace", false)
            }
            const filter = req.payload.filter
            const limit = filter.limit ?? 100
            if (filter.cursor !== undefined) {
              try {
                decodeSessionListCursor(filter.cursor)
              } catch {
                return sessionListFailed(req, "validation.failed", "invalid cursor", false)
              }
            }
            const acquired = yield* acquireDrainControl(dir).pipe(
              Effect.map((v) => ({ tag: "ok" as const, value: v })),
              Effect.catch((err: unknown) => {
                const fence =
                  err instanceof InstanceUnavailableDuringConfigRebuildError ||
                  (err as { _tag?: string })?._tag === "InstanceUnavailableDuringConfigRebuild"
                const code = fence ? "InstanceUnavailableDuringConfigRebuild" : "internal"
                const message = fence
                  ? boundSessionListMessage(err instanceof Error ? err.message : String(err))
                  : "internal error"
                return Effect.succeed({
                  tag: "fail" as const,
                  result: sessionListFailed(req, code, message, fence),
                })
              }),
              Effect.catchDefect(() => {
                return Effect.succeed({
                  tag: "fail" as const,
                  result: sessionListFailed(req, "internal", "internal error", false),
                })
              }),
            )
            if (acquired.tag !== "ok") return acquired.result
            const inner = Effect.gen(function* () {
              const svc = yield* Session.Service
              const base = {
                projectID: filter.projectID,
                directory: dir,
                roots: filter.roots,
                start: filter.start,
                search: filter.search,
                archived: filter.archived,
              }
              // Stable pagination without omission: push the opaque composite
              // cursor to the store (updated DESC, id DESC) and fetch limit+1.
              // No capped prefix; exhaustion is decided only by the store page.
              const readPage = (cursorValue: string | undefined, fetchLimit: number) =>
                svc.listGlobal({ ...base, cursor: cursorValue, limit: fetchLimit }).pipe(
                  Effect.map((v) => ({ tag: "ok" as const, value: v })),
                  Effect.catch(() => {
                    return Effect.succeed({ tag: "fail" as const })
                  }),
                  Effect.catchDefect(() => {
                    return Effect.succeed({ tag: "fail" as const })
                  }),
                )
              const paged = yield* readPage(filter.cursor, limit + 1)
              if (paged.tag !== "ok") return sessionListFailed(req, "internal", "internal error", false)
              const window: unknown[] = paged.value
              const page = window.length > limit ? window.slice(0, limit) : window
              const isTruncated = window.length > limit
              const summaries: Array<{ id: string; directory: string; title: string; updated: number }> = []
              for (const item of page) {
                const rec = item as unknown as Record<string, unknown>
                const id = rec.id
                const directory = rec.directory
                const title = rec.title
                const time = rec.time as { updated?: unknown } | undefined
                const updated = time?.updated
                if (typeof id !== "string" || !id.startsWith("ses"))
                  return sessionListFailed(req, "internal", "internal error", false)
                if (typeof directory !== "string" || directory.length === 0)
                  return sessionListFailed(req, "internal", "internal error", false)
                if (typeof title !== "string") return sessionListFailed(req, "internal", "internal error", false)
                if (typeof updated !== "number" || !Number.isFinite(updated) || updated < 0)
                  return sessionListFailed(req, "internal", "internal error", false)
                summaries.push({ id, directory, title, updated })
              }
              let next: string | undefined
              if (isTruncated && page.length > 0) {
                const last = page[page.length - 1] as unknown as Record<string, unknown>
                const t = (last.time as { updated?: unknown } | undefined)?.updated
                const lid = last.id
                if (typeof t !== "number" || !Number.isInteger(t) || t < 0)
                  return sessionListFailed(req, "internal", "internal error", false)
                if (typeof lid !== "string" || !lid.startsWith("ses"))
                  return sessionListFailed(req, "internal", "internal error", false)
                next = encodeSessionListCursor(t, lid)
              }
              return {
                v: FD_SESSION_LIST_VERSION,
                requestId: req.requestId,
                opId: req.opId,
                op: FD_SESSION_LIST_OP,
                idempotencyKey: req.idempotencyKey,
                status: "succeeded",
                outcome: { type: "succeeded", time: Date.now() },
                accepted: true,
                data: next !== undefined ? { sessions: summaries, nextCursor: next } : { sessions: summaries },
              }
            }).pipe(Effect.provideService(InstanceRef, acquired.value.ctx), Effect.ensuring(acquired.value.release))
            return yield* inner.pipe(
              Effect.catch(() => {
                return Effect.succeed(sessionListFailed(req, "internal", "internal error", false))
              }),
              Effect.catchDefect(() => {
                return Effect.succeed(sessionListFailed(req, "internal", "internal error", false))
              }),
            )
          }),
        )
        return result
      }
      if (method === "path/get") {
        // Path parity-only read: routing directory/workspace identity via the
        // existing drain-control lane (same lane as session/list), then the
        // real production source — process-global Global.Path plus
        // directory-routed InstanceState context (worktree/directory) — read
        // synchronously as the production getPath handler does. Globals stay
        // process-global and are never bound to the request directory; only
        // the five safe Path fields are returned. No mutation, no config
        // ownership, no worktree-derivation claim. Evidence: production
        // handler yields InstanceState.context (handlers/instance.ts getPath),
        // which requires InstanceRef; acquireDrainControl + InstanceRef is the
        // existing lane, not a new lifecycle lane (no fence/convergence added).
        const result = await AppRuntime.runPromise(
          Effect.gen(function* () {
            let req: FdPathRequest
            try {
              req = validatePathRequest(params)
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e)
              return pathFailed(fallbackPathIds(params), "validation.failed", boundPathMessage(msg), false)
            }
            const safe = safePathIdentities(req)
            let dir: string
            try {
              dir = canonicalDirectory(req.context.directory)
            } catch {
              return pathFailed(safe, "validation.failed", "invalid directory", false)
            }
            if (req.context.workspace !== undefined) {
              const ws = req.context.workspace
              if (typeof ws !== "string" || ws.length === 0 || ws.includes("\0"))
                return pathFailed(safe, "validation.failed", "invalid workspace", false)
            }
            const acquired = yield* acquireDrainControl(dir).pipe(
              Effect.map((v) => ({ tag: "ok" as const, value: v })),
              Effect.catch((err: unknown) => {
                const fence =
                  err instanceof InstanceUnavailableDuringConfigRebuildError ||
                  (err as { _tag?: string })?._tag === "InstanceUnavailableDuringConfigRebuild"
                const code = fence ? "InstanceUnavailableDuringConfigRebuild" : "internal"
                const message = fence ? PATH_FENCE_MESSAGE : PATH_INTERNAL_MESSAGE
                return Effect.succeed({
                  tag: "fail" as const,
                  result: pathFailed(safe, code, message, fence),
                })
              }),
              Effect.catchDefect(() => {
                return Effect.succeed({
                  tag: "fail" as const,
                  result: pathFailed(safe, "internal", PATH_INTERNAL_MESSAGE, false),
                })
              }),
            )
            if (acquired.tag !== "ok") return acquired.result
            const inner = Effect.gen(function* () {
              const ctx = yield* InstanceState.context
              const path = {
                home: Global.Path.home,
                state: Global.Path.state,
                config: Global.Path.config,
                worktree: ctx.worktree,
                directory: ctx.directory,
              }
              for (const v of [path.home, path.state, path.config, path.worktree, path.directory]) {
                if (typeof v !== "string" || v.length === 0 || v.includes("\0"))
                  return pathFailed(safe, "internal", PATH_INTERNAL_MESSAGE, false)
              }
              return {
                v: FD_PATH_VERSION,
                requestId: req.requestId,
                opId: req.opId,
                op: FD_PATH_OP,
                idempotencyKey: req.idempotencyKey,
                status: "succeeded",
                outcome: { type: "succeeded", time: Date.now() },
                accepted: true,
                data: { path },
              }
            }).pipe(Effect.provideService(InstanceRef, acquired.value.ctx), Effect.ensuring(acquired.value.release))
            return yield* inner.pipe(
              Effect.catch(() => {
                return Effect.succeed(pathFailed(safe, "internal", PATH_INTERNAL_MESSAGE, false))
              }),
              Effect.catchDefect(() => {
                return Effect.succeed(pathFailed(safe, "internal", PATH_INTERNAL_MESSAGE, false))
              }),
            )
          }),
        )
        return result
      }
      if (method === "command/list") {
        // Command-list parity-only read: same-directory Command.Service.list()
        // via the existing drain-control + InstanceRef lane (same lane as
        // session/list and path/get, no new lifecycle lane), projected to the
        // safe consumer subset ({name, description?, source?, hints?}).
        // `template` (lazy promise content), `agent`, `model`, and `subtask`
        // are never read, resolved, or projected. Duplicate names are legal:
        // production list() keeps one skill/non-skill same-name pair as two
        // entries, so no name-uniqueness is enforced. Directory/workspace are
        // routing identity; workspace never reaches the service. No mutation,
        // no ordering claim, no freshness/snapshot claim.
        const result = await AppRuntime.runPromise(
          Effect.gen(function* () {
            let req: FdCommandListRequest
            try {
              req = validateCommandListRequest(params)
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e)
              return commandListFailed(
                fallbackCommandListIds(params),
                "validation.failed",
                boundCommandListMessage(msg),
                false,
              )
            }
            const safe = safeCommandListIdentities(req)
            let dir: string
            try {
              dir = canonicalDirectory(req.context.directory)
            } catch {
              return commandListFailed(safe, "validation.failed", "invalid directory", false)
            }
            if (req.context.workspace !== undefined) {
              const ws = req.context.workspace
              if (typeof ws !== "string" || ws.length === 0 || ws.includes("\0"))
                return commandListFailed(safe, "validation.failed", "invalid workspace", false)
            }
            const acquired = yield* acquireDrainControl(dir).pipe(
              Effect.map((v) => ({ tag: "ok" as const, value: v })),
              Effect.catch((err: unknown) => {
                const fence =
                  err instanceof InstanceUnavailableDuringConfigRebuildError ||
                  (err as { _tag?: string })?._tag === "InstanceUnavailableDuringConfigRebuild"
                const code = fence ? "InstanceUnavailableDuringConfigRebuild" : "internal"
                const message = fence ? COMMAND_LIST_FENCE_MESSAGE : COMMAND_LIST_INTERNAL_MESSAGE
                return Effect.succeed({
                  tag: "fail" as const,
                  result: commandListFailed(safe, code, message, fence),
                })
              }),
              Effect.catchDefect(() => {
                return Effect.succeed({
                  tag: "fail" as const,
                  result: commandListFailed(safe, "internal", COMMAND_LIST_INTERNAL_MESSAGE, false),
                })
              }),
            )
            if (acquired.tag !== "ok") return acquired.result
            const inner = Effect.gen(function* () {
              const svc = yield* Command.Service
              const list = yield* svc.list().pipe(
                Effect.map((v) => ({ tag: "ok" as const, value: v })),
                Effect.catch(() => {
                  return Effect.succeed({ tag: "fail" as const })
                }),
                Effect.catchDefect(() => {
                  return Effect.succeed({ tag: "fail" as const })
                }),
              )
              if (list.tag !== "ok") return commandListFailed(safe, "internal", COMMAND_LIST_INTERNAL_MESSAGE, false)
              if (!Array.isArray(list.value))
                return commandListFailed(safe, "internal", COMMAND_LIST_INTERNAL_MESSAGE, false)
              const commands: Array<{
                name: string
                description?: string
                source?: "command" | "mcp" | "skill"
                hints?: string[]
              }> = []
              for (const item of list.value) {
                const rec = item as unknown as Record<string, unknown>
                const name = rec.name
                if (typeof name !== "string" || name.length === 0)
                  return commandListFailed(safe, "internal", COMMAND_LIST_INTERNAL_MESSAGE, false)
                const description = rec.description
                if (description !== undefined && typeof description !== "string")
                  return commandListFailed(safe, "internal", COMMAND_LIST_INTERNAL_MESSAGE, false)
                const source = rec.source
                if (source !== undefined && source !== "command" && source !== "mcp" && source !== "skill")
                  return commandListFailed(safe, "internal", COMMAND_LIST_INTERNAL_MESSAGE, false)
                const hints = rec.hints
                if (hints !== undefined) {
                  if (!Array.isArray(hints))
                    return commandListFailed(safe, "internal", COMMAND_LIST_INTERNAL_MESSAGE, false)
                  for (const h of hints as unknown[]) {
                    if (typeof h !== "string")
                      return commandListFailed(safe, "internal", COMMAND_LIST_INTERNAL_MESSAGE, false)
                  }
                }
                commands.push({
                  name,
                  ...(description !== undefined ? { description } : {}),
                  ...(source !== undefined ? { source } : {}),
                  ...(hints !== undefined ? { hints: hints as string[] } : {}),
                })
              }
              return {
                v: FD_COMMAND_LIST_VERSION,
                requestId: req.requestId,
                opId: req.opId,
                op: FD_COMMAND_LIST_OP,
                idempotencyKey: req.idempotencyKey,
                status: "succeeded",
                outcome: { type: "succeeded", time: Date.now() },
                accepted: true,
                data: { commands },
              }
            }).pipe(Effect.provideService(InstanceRef, acquired.value.ctx), Effect.ensuring(acquired.value.release))
            return yield* inner.pipe(
              Effect.catch(() => {
                return Effect.succeed(commandListFailed(safe, "internal", COMMAND_LIST_INTERNAL_MESSAGE, false))
              }),
              Effect.catchDefect(() => {
                return Effect.succeed(commandListFailed(safe, "internal", COMMAND_LIST_INTERNAL_MESSAGE, false))
              }),
            )
          }),
        )
        return result
      }
      if (method === "config/warnings") {
        // Config-warnings parity-only read: same-directory Config.Service
        // warnings via the existing drain-control + InstanceRef lane (same
        // lane as session/list, path/get, and command/list — no new
        // lifecycle lane, no fence, no convergence), projected to the locked
        // safe subset ({pathCategory, messageCategory}). Raw paths, raw
        // diagnostic text, and detail never cross the boundary. Directory and
        // workspace are routing identity; workspace never reaches the
        // service. No mutation, no ordering claim, no general freshness claim.
        const result = await AppRuntime.runPromise(
          Effect.gen(function* () {
            let req: FdConfigWarningsRequest
            try {
              req = validateConfigWarningsRequest(params)
            } catch {
              return configWarningsFailed(
                fallbackConfigWarningsIds(params),
                "validation.failed",
                CONFIG_WARNINGS_VALIDATION_MESSAGE,
                false,
              )
            }
            const safe = safeConfigWarningsIdentities(req)
            let dir: string
            try {
              dir = canonicalDirectory(req.context.directory)
            } catch {
              return configWarningsFailed(safe, "validation.failed", CONFIG_WARNINGS_VALIDATION_MESSAGE, false)
            }
            if (req.context.workspace !== undefined) {
              const ws = req.context.workspace
              if (typeof ws !== "string" || ws.length === 0 || ws.includes("\0"))
                return configWarningsFailed(safe, "validation.failed", CONFIG_WARNINGS_VALIDATION_MESSAGE, false)
            }
            const acquired = yield* acquireDrainControl(dir).pipe(
              Effect.map((v) => ({ tag: "ok" as const, value: v })),
              Effect.catch((err: unknown) => {
                const fence =
                  err instanceof InstanceUnavailableDuringConfigRebuildError ||
                  (err as { _tag?: string })?._tag === "InstanceUnavailableDuringConfigRebuild"
                const code = fence ? "InstanceUnavailableDuringConfigRebuild" : "internal"
                const message = fence ? CONFIG_WARNINGS_FENCE_MESSAGE : CONFIG_WARNINGS_INTERNAL_MESSAGE
                return Effect.succeed({
                  tag: "fail" as const,
                  result: configWarningsFailed(safe, code, message, fence),
                })
              }),
              Effect.catchDefect(() => {
                return Effect.succeed({
                  tag: "fail" as const,
                  result: configWarningsFailed(safe, "internal", CONFIG_WARNINGS_INTERNAL_MESSAGE, false),
                })
              }),
            )
            if (acquired.tag !== "ok") return acquired.result
            const inner = Effect.gen(function* () {
              const svc = yield* Config.Service
              const list = yield* svc.warnings().pipe(
                Effect.map((v) => ({ tag: "ok" as const, value: v })),
                Effect.catch(() => {
                  return Effect.succeed({ tag: "fail" as const })
                }),
                Effect.catchDefect(() => {
                  return Effect.succeed({ tag: "fail" as const })
                }),
              )
              if (list.tag !== "ok")
                return configWarningsFailed(safe, "internal", CONFIG_WARNINGS_INTERNAL_MESSAGE, false)
              if (!Array.isArray(list.value))
                return configWarningsFailed(safe, "internal", CONFIG_WARNINGS_INTERNAL_MESSAGE, false)
              const warnings: ConfigWarningsSafeEntry[] = []
              for (const item of list.value) {
                const proj = projectConfigWarningForCarrier(item)
                if (!proj) return configWarningsFailed(safe, "internal", CONFIG_WARNINGS_INTERNAL_MESSAGE, false)
                warnings.push(proj)
              }
              return {
                v: FD_CONFIG_WARNINGS_VERSION,
                requestId: req.requestId,
                opId: req.opId,
                op: FD_CONFIG_WARNINGS_OP,
                idempotencyKey: req.idempotencyKey,
                status: "succeeded",
                outcome: { type: "succeeded", time: Date.now() },
                accepted: true,
                data: { warnings },
              }
            }).pipe(Effect.provideService(InstanceRef, acquired.value.ctx), Effect.ensuring(acquired.value.release))
            return yield* inner.pipe(
              Effect.catch(() => {
                return Effect.succeed(configWarningsFailed(safe, "internal", CONFIG_WARNINGS_INTERNAL_MESSAGE, false))
              }),
              Effect.catchDefect(() => {
                return Effect.succeed(configWarningsFailed(safe, "internal", CONFIG_WARNINGS_INTERNAL_MESSAGE, false))
              }),
            )
          }),
        )
        return result
      }
      if (method === "project/current") {
        // Project-current vcs-only parity read: same-directory InstanceState
        // context project via the existing drain-control + InstanceRef lane
        // (same lane as path/get, command/list, config/warnings — no new
        // lifecycle lane, no fence, no convergence). Narrow projection is
        // `{vcs?: "git"}` only: `vcs === "git"` or absent/undefined are the
        // sole accepted values; any other value or extra envelope field maps
        // to redacted `internal`. Path-bearing fields (`worktree`,
        // `sandboxes`, `id`, `name`, `icon`, `commands`, `time`) never cross
        // the boundary. Directory/workspace are routing identity; workspace
        // never reaches the read. Covers the deferred `project/git-status`
        // `hasGit` consumer (`vcs === "git"`). No mutation, no ordering or
        // freshness claim.
        const result = await AppRuntime.runPromise(
          Effect.gen(function* () {
            let req: FdProjectCurrentRequest
            try {
              req = validateProjectCurrentRequest(params)
            } catch {
              return projectCurrentFailed(
                fallbackProjectCurrentIds(params),
                "validation.failed",
                PROJECT_CURRENT_VALIDATION_MESSAGE,
                false,
              )
            }
            const safe = safeProjectCurrentIdentities(req)
            let dir: string
            try {
              dir = canonicalDirectory(req.context.directory)
            } catch {
              return projectCurrentFailed(safe, "validation.failed", PROJECT_CURRENT_VALIDATION_MESSAGE, false)
            }
            if (req.context.workspace !== undefined) {
              const ws = req.context.workspace
              if (typeof ws !== "string" || ws.length === 0 || ws.includes("\0"))
                return projectCurrentFailed(safe, "validation.failed", PROJECT_CURRENT_VALIDATION_MESSAGE, false)
            }
            const acquired = yield* acquireDrainControl(dir).pipe(
              Effect.map((v) => ({ tag: "ok" as const, value: v })),
              Effect.catch((err: unknown) => {
                const fence =
                  err instanceof InstanceUnavailableDuringConfigRebuildError ||
                  (err as { _tag?: string })?._tag === "InstanceUnavailableDuringConfigRebuild"
                const code = fence ? "InstanceUnavailableDuringConfigRebuild" : "internal"
                const message = fence ? PROJECT_CURRENT_FENCE_MESSAGE : PROJECT_CURRENT_INTERNAL_MESSAGE
                return Effect.succeed({
                  tag: "fail" as const,
                  result: projectCurrentFailed(safe, code, message, fence),
                })
              }),
              Effect.catchDefect(() => {
                return Effect.succeed({
                  tag: "fail" as const,
                  result: projectCurrentFailed(safe, "internal", PROJECT_CURRENT_INTERNAL_MESSAGE, false),
                })
              }),
            )
            if (acquired.tag !== "ok") return acquired.result
            const inner = Effect.gen(function* () {
              const ctx = yield* InstanceState.context
              const vcs = (ctx.project as { vcs?: unknown }).vcs
              if (vcs !== undefined && vcs !== "git")
                return projectCurrentFailed(safe, "internal", PROJECT_CURRENT_INTERNAL_MESSAGE, false)
              return {
                v: FD_PROJECT_CURRENT_VERSION,
                requestId: req.requestId,
                opId: req.opId,
                op: FD_PROJECT_CURRENT_OP,
                idempotencyKey: req.idempotencyKey,
                status: "succeeded",
                outcome: { type: "succeeded", time: Date.now() },
                accepted: true,
                data: vcs === "git" ? { vcs: "git" as const } : {},
              }
            }).pipe(Effect.provideService(InstanceRef, acquired.value.ctx), Effect.ensuring(acquired.value.release))
            return yield* inner.pipe(
              Effect.catch(() => {
                return Effect.succeed(projectCurrentFailed(safe, "internal", PROJECT_CURRENT_INTERNAL_MESSAGE, false))
              }),
              Effect.catchDefect(() => {
                return Effect.succeed(projectCurrentFailed(safe, "internal", PROJECT_CURRENT_INTERNAL_MESSAGE, false))
              }),
            )
          }),
        )
        return result
      }
      if (method === "find/files") {
        // Find-files bounded read: routing directory/workspace identity via the
        // existing drain-control + InstanceRef lane (same lane as path/get,
        // command/list, config/warnings, project/current — no new lifecycle
        // lane, fence, transport, or timeout), then the natural production
        // source FileSystem.Service.find with explicit type and bounded limit
        // through its location scope. Success projects only relative POSIX
        // {path,type} entries: invalid or sensitive names are dropped silently
        // without logging, rejection, refetch, or fill; output caps at 50.
        // Failures are fixed and redacted with sanitized identities.
        const result = await AppRuntime.runPromise(
          Effect.gen(function* () {
            let req: FdFindFilesRequest
            try {
              req = validateFindFilesRequest(params)
            } catch {
              return findFilesFailed(
                fallbackFindFilesIds(params),
                "validation.failed",
                FIND_FILES_VALIDATION_MESSAGE,
                false,
              )
            }
            const safe = safeFindFilesIdentities(req)
            let dir: string
            try {
              dir = canonicalDirectory(req.context.directory)
            } catch {
              return findFilesFailed(safe, "validation.failed", FIND_FILES_VALIDATION_MESSAGE, false)
            }
            if (req.context.workspace !== undefined) {
              const ws = req.context.workspace
              if (typeof ws !== "string" || ws.length === 0 || ws.includes("\0"))
                return findFilesFailed(safe, "validation.failed", FIND_FILES_VALIDATION_MESSAGE, false)
            }
            const query = req.payload.query
            const type = req.payload.type
            const limit = req.payload.limit ?? FIND_FILES_RESULTS_MAX
            const acquired = yield* acquireDrainControl(dir).pipe(
              Effect.map((v) => ({ tag: "ok" as const, value: v })),
              Effect.catch((err: unknown) => {
                const fence =
                  err instanceof InstanceUnavailableDuringConfigRebuildError ||
                  (err as { _tag?: string })?._tag === "InstanceUnavailableDuringConfigRebuild"
                const code = fence ? "InstanceUnavailableDuringConfigRebuild" : "internal"
                const message = fence ? FIND_FILES_FENCE_MESSAGE : FIND_FILES_INTERNAL_MESSAGE
                return Effect.succeed({
                  tag: "fail" as const,
                  result: findFilesFailed(safe, code, message, fence),
                })
              }),
              Effect.catchDefect(() => {
                return Effect.succeed({
                  tag: "fail" as const,
                  result: findFilesFailed(safe, "internal", FIND_FILES_INTERNAL_MESSAGE, false),
                })
              }),
            )
            if (acquired.tag !== "ok") return acquired.result
            const inner = Effect.gen(function* () {
              let stored: string
              try {
                stored = canonicalDirectory(acquired.value.ctx.directory)
              } catch {
                return findFilesFailed(safe, "internal", FIND_FILES_INTERNAL_MESSAGE, false)
              }
              if (stored !== dir) return findFilesFailed(safe, "scope_mismatch", FIND_FILES_SCOPE_MESSAGE, false)
              const found = yield* Effect.gen(function* () {
                const locations = yield* LocationServiceMap
                const layer = locations.get({ directory: AbsolutePath.make(dir) })
                return yield* FileSystem.Service.use((svc) => svc.find({ query, type, limit })).pipe(
                  Effect.provide(layer),
                )
              }).pipe(
                Effect.provide(LocationServiceMap.layer),
                Effect.map((v) => ({ tag: "ok" as const, value: v })),
                Effect.catch(() => {
                  return Effect.succeed({ tag: "fail" as const })
                }),
                Effect.catchDefect(() => {
                  return Effect.succeed({ tag: "fail" as const })
                }),
              )
              if (found.tag !== "ok") return findFilesFailed(safe, "internal", FIND_FILES_INTERNAL_MESSAGE, false)
              const raw = found.value
              if (!Array.isArray(raw)) return findFilesFailed(safe, "internal", FIND_FILES_INTERNAL_MESSAGE, false)
              const files: Array<{ path: string; type: "file" | "directory" }> = []
              for (const item of raw) {
                if (files.length >= FIND_FILES_RESULTS_MAX) break
                const p = (item as { path?: unknown }).path
                const t = (item as { type?: unknown }).type
                if (typeof p !== "string" || (t !== "file" && t !== "directory")) continue
                if (t !== type) continue
                try {
                  validateFindFilesRelPath(p)
                } catch {
                  continue
                }
                files.push({ path: p, type: t })
              }
              return {
                v: FD_FIND_FILES_VERSION,
                requestId: req.requestId,
                opId: req.opId,
                op: FD_FIND_FILES_OP,
                idempotencyKey: req.idempotencyKey,
                status: "succeeded",
                outcome: { type: "succeeded", time: Date.now() },
                accepted: true,
                data: { files: files.slice(0, FIND_FILES_RESULTS_MAX) },
              }
            }).pipe(Effect.provideService(InstanceRef, acquired.value.ctx), Effect.ensuring(acquired.value.release))
            return yield* inner.pipe(
              Effect.catch(() => {
                return Effect.succeed(findFilesFailed(safe, "internal", FIND_FILES_INTERNAL_MESSAGE, false))
              }),
              Effect.catchDefect(() => {
                return Effect.succeed(findFilesFailed(safe, "internal", FIND_FILES_INTERNAL_MESSAGE, false))
              }),
            )
          }),
        )
        return result
      }
      const err = new Error(`Method not found: ${method}`) as Error & { code: number }
      err.code = ErrorCode.MethodNotFound
      throw err
    },
  })
  return { peer, reader, writer, dispose }
}

export interface FdCarrierDeps {
  fstatSync: (fd: number) => unknown
  createReadStream: (path: unknown, opts: unknown) => NodeJS.ReadableStream
  createWriteStream: (path: unknown, opts: unknown) => NodeJS.WritableStream
  platform?: string
}

export function tryStartFdCarrierWithDeps(deps: FdCarrierDeps): FdCarrierHandle | null {
  if (!canUseFdCarrierWithDeps(deps)) return null
  let reader: NodeJS.ReadableStream | null = null
  let writer: NodeJS.WritableStream | null = null
  try {
    if (!hasFdWithDeps(3, deps) || !hasFdWithDeps(4, deps)) return null
    reader = deps.createReadStream(
      null as unknown as string,
      { fd: 3, autoClose: false } as unknown as Record<string, unknown>,
    ) as unknown as NodeJS.ReadableStream
    try {
      writer = deps.createWriteStream(
        null as unknown as string,
        { fd: 4, autoClose: false } as unknown as Record<string, unknown>,
      ) as unknown as NodeJS.WritableStream
    } catch (err) {
      console.warn("[kilo fd-carrier] writer creation failed, releasing reader:", String(err))
      if (reader) bestEffortClose(reader, "reader-partial-cleanup")
      return null
    }
    try {
      ;(reader as unknown as { resume: () => void }).resume()
    } catch (err) {
      console.warn("[kilo fd-carrier] reader resume in tryStart failed:", String(err))
    }
    return createFdCarrier(reader, writer)
  } catch (err) {
    console.warn("[kilo fd-carrier] tryStart failed:", String(err))
    if (reader) bestEffortClose(reader, "reader-startup-cleanup")
    if (writer) bestEffortClose(writer, "writer-startup-cleanup")
    return null
  }
}

function hasFdWithDeps(fd: number, deps: FdCarrierDeps): boolean {
  try {
    const stat = deps.fstatSync(fd)
    const p = carrierPlatform(deps)
    if (p === "win32") return true
    if (p === "darwin" || p === "linux") {
      if (!isSocketStat(stat)) {
        console.warn("[kilo fd-carrier] hasFd check failed for", fd, "not a socket")
        return false
      }
      return true
    }
    console.warn("[kilo fd-carrier] hasFd check failed for", fd, "unsupported platform", String(p))
    return false
  } catch (err) {
    console.warn("[kilo fd-carrier] hasFd check failed for", fd, String(err))
    return false
  }
}

function canUseFdCarrierWithDeps(deps: FdCarrierDeps): boolean {
  const envOk = !!process.env.KILO_PARENT_PID || process.env.KILO_CLIENT === "vscode"
  if (!envOk) return false
  try {
    const s3 = deps.fstatSync(3)
    const s4 = deps.fstatSync(4)
    if (!isFdCarrierSocketEligible(s3, s4, carrierPlatform(deps))) {
      console.warn("[kilo fd-carrier] canUse check failed: fd3/fd4 are not both sockets")
      return false
    }
    return true
  } catch (err) {
    console.warn("[kilo fd-carrier] canUse check failed:", String(err))
    return false
  }
}

export function tryStartFdCarrier(): FdCarrierHandle | null {
  return tryStartFdCarrierWithDeps({
    fstatSync: fs.fstatSync.bind(fs),
    createReadStream: (p, o) => fs.createReadStream(p as string, o as never) as unknown as NodeJS.ReadableStream,
    createWriteStream: (p, o) => fs.createWriteStream(p as string, o as never) as unknown as NodeJS.WritableStream,
  })
}
