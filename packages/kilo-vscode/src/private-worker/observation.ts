/**
 * Observation wire foundation over the private JSON-RPC carrier.
 * Additive, protocol-level, versioned envelope with explicit method names
 * for snapshot hydration, changefeed read/subscribe delivery, and acknowledgement.
 * Payload-free entries only: { seq, session_id, revision, kind, time }.
 * Gap semantics: any stale/gapped cursor produces explicit rehydrate,
 * never fabricated deltas. Duplicate delivery idempotent via cursor/seq.
 *
 * Controller responsibility: ObservationController routes observation/snapshot,
 * read, ack, and subscribe RPCs to injected deps (getSnapshot, readAfter, ack).
 * Production wiring is via standalone worker's no-lease observer (Database.layerNoLease
 * + createChangefeedDeps) and PrivateObservationService; controller remains injectable
 * and testable without storage.
 */

import { isAbsolute } from "path"
import { canonicalDirectory } from "./canonical-directory"
import { decodeGlobalListCursor } from "./session-cursor"
import {
  assertFoundMessagePage,
  decodeMessageCursor,
  isStrictCursorTime,
  validateInfo,
  validatePart,
} from "./message-read"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { ErrorCode } from "./json-rpc"

export const OBSERVATION_VERSION = "1.0" as const

export const OBSERVATION_METHODS = {
  SNAPSHOT: "observation/snapshot",
  READ: "observation/read",
  ACK: "observation/ack",
  SUBSCRIBE: "observation/subscribe",
  LIST: "observation/list",
  GET: "observation/get",
  MESSAGES: "observation/messages",
} as const

export const OBSERVATION_NOTIFICATION = "observation/changed" as const

export const OBSERVATION_REQUIRED_CAPABILITIES = [
  "observation/snapshot",
  "observation/read",
  "observation/ack",
  "observation/subscribe",
  "observation/list",
  "observation/get",
  "observation/messages",
] as const

export type ObservationRequiredCapability = (typeof OBSERVATION_REQUIRED_CAPABILITIES)[number]

export function buildObservationCapabilities(): Record<string, unknown> {
  const caps: Record<string, unknown> = {
    observation: { version: OBSERVATION_VERSION },
  }
  for (const m of OBSERVATION_REQUIRED_CAPABILITIES) caps[m] = {}
  return caps
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

export function assertObservationCapable(result: unknown): void {
  if (!isPlainObject(result)) throw new Error("initialize result must be object")
  const r = result as Record<string, unknown>
  if (r.protocolVersion !== "1.0") throw new Error(`unsupported protocolVersion: ${String(r.protocolVersion)}`)
  if (!isPlainObject(r.serverInfo)) throw new Error("serverInfo must be object")
  if (!isPlainObject(r.capabilities)) throw new Error("capabilities must be object")
  const caps = r.capabilities as Record<string, unknown>
  for (const k of Object.keys(caps)) {
    if (k.length === 0 || k.includes("\0")) throw new Error(`illegal capability: ${JSON.stringify(k)}`)
  }
  const obs = caps["observation"]
  if (!isPlainObject(obs)) throw new Error("missing required capability: observation")
  const ver = (obs as Record<string, unknown>).version
  if (typeof ver !== "string" || ver.length === 0 || ver.includes("\0")) throw new Error("illegal observation version")
  if (ver !== OBSERVATION_VERSION) throw new Error(`unsupported observation version: ${String(ver)}`)
  for (const m of OBSERVATION_REQUIRED_CAPABILITIES) {
    if (!(m in caps)) throw new Error(`missing required capability: ${m}`)
    const v = caps[m]
    if (!isPlainObject(v as unknown)) throw new Error(`illegal capability value for ${m}`)
  }
}

export function isObservationCapable(result: unknown): boolean {
  try {
    assertObservationCapable(result)
    return true
  } catch {
    return false
  }
}

export type ObservationKind = "changed" | "deleted"

const VALID_KINDS = new Set<string>(["changed", "deleted"])

function isValidKind(v: unknown): v is ObservationKind {
  return typeof v === "string" && VALID_KINDS.has(v)
}

function isValidSessionId(v: unknown): boolean {
  return typeof v === "string" && v.length > 0 && v.startsWith("ses") && !v.includes("\0")
}

function isValidMessageId(v: unknown): boolean {
  return typeof v === "string" && v.length > 0 && v.startsWith("msg") && !v.includes("\0")
}

function isValidPartId(v: unknown): boolean {
  return typeof v === "string" && v.length > 0 && v.startsWith("prt") && !v.includes("\0")
}

function isValidTimestamp(v: unknown): boolean {
  return (
    typeof v === "number" &&
    Number.isFinite(v) &&
    Number.isSafeInteger(v) &&
    (v as number) >= 0 &&
    (v as number) <= 8640000000000000
  )
}

function isFiniteNumber(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v as number)
}

export interface ObservationEntry {
  seq: number
  session_id: string
  revision: number
  kind: ObservationKind
  time: number
}

export interface SnapshotResult {
  v: typeof OBSERVATION_VERSION
  cursor: number
  snapshot: unknown
}

export type ReadResultWire =
  | { v: typeof OBSERVATION_VERSION; cursor: number; rehydrate: false; entries: ObservationEntry[] }
  | { v: typeof OBSERVATION_VERSION; cursor: number; rehydrate: true; reason: string; entries: ObservationEntry[] }

export interface AckResult {
  v: typeof OBSERVATION_VERSION
  cursor: number
}

export interface SubscribeResult {
  v: typeof OBSERVATION_VERSION
  cursor: number
  subscribed: true
}

export interface ChangedNotification {
  v: typeof OBSERVATION_VERSION
  cursor: number
  entries: ObservationEntry[]
}

export type ObservationReadBackendResult =
  | { type: "deltas"; cursor: number; entries: ReadonlyArray<ObservationEntry> }
  | { type: "rehydrate"; cursor: number; reason: string }

export interface ObservationListEntry {
  id: string
  title: string
  parentID: string | null
  directory: string
  projectID: string
  createdAt: number
  updatedAt: number
}

export interface ObservationListResult {
  v: typeof OBSERVATION_VERSION
  entries: ObservationListEntry[]
  nextCursor?: string
}

export interface ObservationGetModel {
  providerID: string
  id: string
  variant?: string
}

export interface ObservationGetSession {
  id: string
  title: string
  parentID: string | null
  directory: string
  projectID: string
  createdAt: number
  updatedAt: number
  agent?: string
  model?: ObservationGetModel
  summary?: {
    additions: number
    deletions: number
    files: number
    diffs?: Array<{ file?: string; additions: number; deletions: number; status?: "added" | "deleted" | "modified" }>
  }
  revert?: { messageID: string; partID?: string; snapshot?: string; diff?: string }
}

export type ObservationGetResult =
  | { v: typeof OBSERVATION_VERSION; status: "found"; session: ObservationGetSession }
  | { v: typeof OBSERVATION_VERSION; status: "not_found" }
  | { v: typeof OBSERVATION_VERSION; status: "scope_mismatch" }

export type ObservationMessagesResult =
  | { v: typeof OBSERVATION_VERSION; status: "found"; messages: SessionV1.WithParts[]; nextCursor?: string }
  | { v: typeof OBSERVATION_VERSION; status: "not_found" }
  | { v: typeof OBSERVATION_VERSION; status: "scope_mismatch" }

export interface ObservationDeps {
  getSnapshot: () => Promise<{ cursor: number; snapshot: unknown }>
  readAfter: (cursor: number) => Promise<ObservationReadBackendResult>
  ack: (cursor: number) => Promise<void>
  list?: (input: {
    directory: string
    archived?: boolean
    cursor?: string
    limit: number
  }) => Promise<ObservationListResult>
  get?: (input: { directory: string; sessionId: string }) => Promise<ObservationGetResult>
  messages?: (input: {
    directory: string
    sessionId: string
    limit: number
    cursor?: string
  }) => Promise<ObservationMessagesResult>
}

function invalidParams(msg: string): Error & { code?: number } {
  const err = new Error(msg) as Error & { code?: number }
  err.code = ErrorCode.InvalidParams
  return err
}

function internalError(msg: string): Error & { code?: number } {
  const err = new Error(msg) as Error & { code?: number }
  err.code = ErrorCode.InternalError
  return err
}

function notFound(msg: string): Error & { code?: number } {
  const err = new Error(msg) as Error & { code?: number }
  err.code = ErrorCode.MethodNotFound
  return err
}

function validateVersion(params: unknown): void {
  if (
    params !== null &&
    typeof params === "object" &&
    !Array.isArray(params) &&
    "v" in (params as Record<string, unknown>)
  ) {
    const v = (params as Record<string, unknown>).v
    if (v !== undefined && v !== OBSERVATION_VERSION) {
      throw invalidParams(`unsupported observation version: ${String(v)}`)
    }
  }
}

function extractCursor(params: unknown, required: boolean): number {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw invalidParams("cursor must be object with integer cursor")
  }
  const o = params as Record<string, unknown>
  if (!("cursor" in o)) {
    if (required) throw invalidParams("cursor is required")
    throw invalidParams("cursor missing")
  }
  const c = o.cursor
  if (typeof c !== "number" || !Number.isInteger(c) || c < 0 || !Number.isSafeInteger(c)) {
    throw invalidParams("cursor must be integer >=0")
  }
  return c
}

function parseDirectory(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.includes("\0"))
    throw invalidParams("directory must be non-empty absolute path")
  if (!isAbsolute(raw)) throw invalidParams("directory must be non-empty absolute path")
  try {
    return canonicalDirectory(raw)
  } catch (e) {
    throw invalidParams(
      (e as Error).message.includes("directory") ? (e as Error).message : "directory must be non-empty absolute path",
    )
  }
}

function parseSessionId(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.includes("\0") || !raw.startsWith("ses"))
    throw invalidParams("sessionId must be non-empty session id")
  if (!isValidSessionId(raw)) throw invalidParams("sessionId must be non-empty session id")
  return raw as string
}

// eslint-disable-next-line complexity
function validateSummary(sum: unknown): void {
  if (typeof sum !== "object" || sum === null || Array.isArray(sum))
    throw internalError("get returned invalid session shape")
  const s = sum as Record<string, unknown>
  const allowed = new Set(["additions", "deletions", "files", "diffs"])
  for (const k of Object.keys(s)) if (!allowed.has(k)) throw internalError("get returned invalid session shape")
  if (!isFiniteNumber(s.additions)) throw internalError("get returned invalid session shape")
  if (!isFiniteNumber(s.deletions)) throw internalError("get returned invalid session shape")
  if (!isFiniteNumber(s.files)) throw internalError("get returned invalid session shape")
  if ("diffs" in s && s.diffs !== undefined) {
    if (!Array.isArray(s.diffs)) throw internalError("get returned invalid session shape")
    for (const d of s.diffs as unknown[]) {
      if (typeof d !== "object" || d === null || Array.isArray(d))
        throw internalError("get returned invalid session shape")
      const diff = d as Record<string, unknown>
      const allowedDiff = new Set(["file", "additions", "deletions", "status"])
      for (const k of Object.keys(diff))
        if (!allowedDiff.has(k)) throw internalError("get returned invalid session shape")
      if (!isFiniteNumber(diff.additions)) throw internalError("get returned invalid session shape")
      if (!isFiniteNumber(diff.deletions)) throw internalError("get returned invalid session shape")
      if ("file" in diff && diff.file !== undefined && typeof diff.file !== "string")
        throw internalError("get returned invalid session shape")
      if ("status" in diff && diff.status !== undefined) {
        if (typeof diff.status !== "string" || !["added", "deleted", "modified"].includes(diff.status as string))
          throw internalError("get returned invalid session shape")
      }
    }
  }
}

function validateRevert(rev: unknown): void {
  if (typeof rev !== "object" || rev === null || Array.isArray(rev))
    throw internalError("get returned invalid session shape")
  const r = rev as Record<string, unknown>
  const allowed = new Set(["messageID", "partID", "snapshot", "diff"])
  for (const k of Object.keys(r)) if (!allowed.has(k)) throw internalError("get returned invalid session shape")
  if (!isValidMessageId(r.messageID)) throw internalError("get returned invalid session shape")
  if ("partID" in r && r.partID !== undefined && !isValidPartId(r.partID))
    throw internalError("get returned invalid session shape")
  if ("snapshot" in r && r.snapshot !== undefined && typeof r.snapshot !== "string")
    throw internalError("get returned invalid session shape")
  if ("diff" in r && r.diff !== undefined && typeof r.diff !== "string")
    throw internalError("get returned invalid session shape")
}

function validateModel(raw: unknown): void {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw internalError("get returned invalid session shape")
  const m = raw as Record<string, unknown>
  const allowed = new Set(["providerID", "id", "variant"])
  for (const k of Object.keys(m)) if (!allowed.has(k)) throw internalError("get returned invalid session shape")
  if (typeof m.providerID !== "string" || m.providerID.length === 0 || (m.providerID as string).includes("\0")) {
    throw internalError("get returned invalid session shape")
  }
  if (typeof m.id !== "string" || m.id.length === 0 || (m.id as string).includes("\0")) {
    throw internalError("get returned invalid session shape")
  }
  if ("variant" in m && m.variant !== undefined) {
    if (typeof m.variant !== "string" || (m.variant as string).includes("\0"))
      throw internalError("get returned invalid session shape")
  }
}

// eslint-disable-next-line complexity
function validateFoundSession(raw: unknown, directory: string, sessionId: string): void {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw internalError("get returned invalid session shape")
  const s = raw as Record<string, unknown>
  if (
    !isValidSessionId(s.id) ||
    typeof s.title !== "string" ||
    (s.parentID !== null && !isValidSessionId(s.parentID as unknown)) ||
    s.parentID === undefined ||
    typeof s.directory !== "string" ||
    s.directory.length === 0 ||
    s.directory.includes("\0") ||
    !isAbsolute(s.directory as string) ||
    (() => {
      try {
        return (
          canonicalDirectory(s.directory as string) !== (s.directory as string) || (s.directory as string) !== directory
        )
      } catch {
        return true
      }
    })() ||
    typeof s.projectID !== "string" ||
    s.projectID.length === 0 ||
    (s.projectID as string).includes("\0") ||
    !isValidTimestamp(s.createdAt) ||
    !isValidTimestamp(s.updatedAt)
  ) {
    throw internalError("get returned invalid session shape")
  }
  if (s.id !== sessionId) throw internalError("get returned invalid session shape")
  if ("agent" in s && s.agent !== undefined && typeof s.agent !== "string")
    throw internalError("get returned invalid session shape")
  if ("agent" in s && typeof s.agent === "string" && s.agent.includes("\0"))
    throw internalError("get returned invalid session shape")
  if ("summary" in s && s.summary !== undefined) validateSummary(s.summary)
  if ("revert" in s && s.revert !== undefined) validateRevert(s.revert)
  if ("model" in s && s.model !== undefined) validateModel(s.model)
  const allowed = new Set([
    "id",
    "title",
    "parentID",
    "directory",
    "projectID",
    "createdAt",
    "updatedAt",
    "agent",
    "model",
    "summary",
    "revert",
  ])
  for (const k of Object.keys(s)) if (!allowed.has(k)) throw internalError("get returned invalid session shape")
}

function validateGetResult(res: unknown, directory: string, sessionId: string): asserts res is ObservationGetResult {
  if (res === null || typeof res !== "object" || Array.isArray(res)) throw internalError("get returned invalid shape")
  const r = res as Record<string, unknown>
  if (r.v !== OBSERVATION_VERSION) throw internalError("get returned invalid version")
  if (typeof r.status !== "string" || !["found", "not_found", "scope_mismatch"].includes(r.status as string))
    throw internalError("get returned invalid status")
  const status = r.status as string
  if (status === "not_found" || status === "scope_mismatch") {
    const allowed = new Set(["v", "status"])
    for (const k of Object.keys(r)) if (!allowed.has(k)) throw internalError("get returned invalid shape")
    if ("session" in r) throw internalError("get returned invalid shape")
    return
  }
  const allowedFound = new Set(["v", "status", "session"])
  for (const k of Object.keys(r)) if (!allowedFound.has(k)) throw internalError("get returned invalid shape")
  if (!("session" in r)) throw internalError("get returned invalid session")
  validateFoundSession(r.session, directory, sessionId)
}

// eslint-disable-next-line complexity
function validateMessagesResult(res: unknown, limit: number): asserts res is ObservationMessagesResult {
  if (res === null || typeof res !== "object" || Array.isArray(res))
    throw internalError("messages returned invalid shape")
  const r = res as Record<string, unknown>
  if (r.v !== OBSERVATION_VERSION) throw internalError("messages returned invalid version")
  if (typeof r.status !== "string" || !["found", "not_found", "scope_mismatch"].includes(r.status as string))
    throw internalError("messages returned invalid status")
  const status = r.status as string
  if (status === "not_found" || status === "scope_mismatch") {
    const allowed = new Set(["v", "status"])
    for (const k of Object.keys(r)) if (!allowed.has(k)) throw internalError("messages returned invalid shape")
    if ("messages" in r || "nextCursor" in r) throw internalError("messages returned invalid shape")
    return
  }
  const allowedFound = new Set(["v", "status", "messages", "nextCursor"])
  for (const k of Object.keys(r)) if (!allowedFound.has(k)) throw internalError("messages returned invalid shape")
  if (!Array.isArray(r.messages)) throw internalError("messages returned invalid messages")
  const messages = r.messages as unknown[]
  try {
    for (const m of messages) {
      if (m === null || typeof m !== "object" || Array.isArray(m))
        throw new Error("messages returned invalid message shape")
      const rec = m as Record<string, unknown>
      const keys = Object.keys(rec)
      if (keys.length !== 2 || !keys.includes("info") || !keys.includes("parts"))
        throw new Error("messages returned invalid message shape")
      validateInfo(rec.info)
      if (!Array.isArray(rec.parts)) throw new Error("messages returned invalid message shape")
      for (const p of rec.parts as unknown[]) validatePart(p)
    }
    const rawCursor = "nextCursor" in r ? r.nextCursor : undefined
    if (rawCursor !== undefined && typeof rawCursor !== "string")
      throw new Error("messages returned invalid nextCursor")
    if (rawCursor !== undefined) {
      const decoded = decodeMessageCursor(rawCursor)
      if (!isStrictCursorTime(decoded.time)) throw new Error("non-integer cursor time")
    }
    assertFoundMessagePage(messages as SessionV1.WithParts[], limit, rawCursor as string | undefined)
  } catch (e) {
    if (e instanceof Error && (e as { code?: number }).code !== undefined) throw e
    throw internalError(e instanceof Error ? e.message : String(e))
  }
}

export class ObservationController {
  constructor(private readonly deps: ObservationDeps) {}

  async handle(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case OBSERVATION_METHODS.SNAPSHOT:
        return this.handleSnapshot(params)
      case OBSERVATION_METHODS.READ:
        return this.handleRead(params)
      case OBSERVATION_METHODS.ACK:
        return this.handleAck(params)
      case OBSERVATION_METHODS.SUBSCRIBE:
        return this.handleSubscribe(params)
      case OBSERVATION_METHODS.LIST:
        return this.handleList(params)
      case OBSERVATION_METHODS.GET:
        return this.handleGet(params)
      case OBSERVATION_METHODS.MESSAGES:
        return this.handleMessages(params)
      default:
        throw notFound(`Method not found: ${method}`)
    }
  }

  private async handleSnapshot(params: unknown): Promise<SnapshotResult> {
    validateVersion(params)
    if (params !== undefined && params !== null && typeof params !== "object") {
      throw invalidParams("snapshot params must be object if provided")
    }
    const state = await this.deps.getSnapshot()
    if (typeof state.cursor !== "number" || !Number.isInteger(state.cursor) || state.cursor < 0) {
      throw internalError("snapshot returned invalid cursor")
    }
    return { v: OBSERVATION_VERSION, cursor: state.cursor, snapshot: state.snapshot }
  }

  private async handleRead(params: unknown): Promise<ReadResultWire> {
    validateVersion(params)
    const cursor = extractCursor(params, true)
    const res = await this.deps.readAfter(cursor)
    if (res.type === "rehydrate") {
      return { v: OBSERVATION_VERSION, cursor: res.cursor, rehydrate: true as const, reason: res.reason, entries: [] }
    }
    for (const e of res.entries) {
      if (
        typeof e.seq !== "number" ||
        typeof e.session_id !== "string" ||
        typeof e.revision !== "number" ||
        typeof e.kind !== "string" ||
        typeof e.time !== "number"
      ) {
        throw internalError("readAfter returned invalid entry shape")
      }
      if (!isValidKind(e.kind)) {
        throw invalidParams(`invalid observation kind: ${String(e.kind)}`)
      }
    }
    return {
      v: OBSERVATION_VERSION,
      cursor: res.cursor,
      rehydrate: false as const,
      entries: [...res.entries] as ObservationEntry[],
    }
  }

  private async handleAck(params: unknown): Promise<AckResult> {
    validateVersion(params)
    const cursor = extractCursor(params, true)
    await this.deps.ack(cursor)
    return { v: OBSERVATION_VERSION, cursor }
  }

  private async handleSubscribe(params: unknown): Promise<SubscribeResult> {
    validateVersion(params)
    if (
      params !== null &&
      typeof params === "object" &&
      !Array.isArray(params) &&
      "cursor" in (params as Record<string, unknown>)
    ) {
      extractCursor(params, true)
    } else if (params !== undefined && params !== null && typeof params !== "object") {
      throw invalidParams("subscribe params must be object if provided")
    }
    const snap = await this.deps.getSnapshot()
    if (typeof snap.cursor !== "number" || !Number.isInteger(snap.cursor) || snap.cursor < 0) {
      throw internalError("snapshot returned invalid cursor")
    }
    return { v: OBSERVATION_VERSION, cursor: snap.cursor, subscribed: true }
  }

  // eslint-disable-next-line complexity
  private async handleList(params: unknown): Promise<ObservationListResult> {
    if (params === null || typeof params !== "object" || Array.isArray(params)) {
      throw invalidParams("params must be object")
    }
    const o = params as Record<string, unknown>
    const allowed = new Set(["v", "directory", "archived", "cursor", "limit"])
    for (const k of Object.keys(o)) if (!allowed.has(k)) throw invalidParams(`unexpected field ${k}`)
    if (o.v !== OBSERVATION_VERSION) throw invalidParams(`unsupported observation version: ${String(o.v)}`)
    const directory = (() => {
      if (!("directory" in o)) throw invalidParams("directory is required")
      return parseDirectory(o.directory)
    })()
    const archived: boolean | undefined = (() => {
      if (!("archived" in o)) return undefined
      const raw = o.archived
      if (typeof raw !== "boolean") throw invalidParams("archived must be boolean when present")
      return raw as boolean
    })()
    const cursor: string | undefined = (() => {
      if (!("cursor" in o)) return undefined
      const raw = o.cursor
      if (typeof raw !== "string") throw invalidParams("cursor must be opaque session-list cursor string")
      try {
        decodeGlobalListCursor(raw)
      } catch (e) {
        throw invalidParams((e as Error).message)
      }
      return raw as string
    })()
    const limit = (() => {
      if (!("limit" in o)) return 100
      const raw = o.limit
      if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 500) {
        throw invalidParams("limit must be integer 1..500")
      }
      return raw as number
    })()
    if (!this.deps.list) throw notFound(`Method not found: ${OBSERVATION_METHODS.LIST}`)
    const res = await this.deps.list({ directory, archived, cursor, limit })
    if (res.v !== OBSERVATION_VERSION) throw internalError("list returned invalid version")
    if (!Array.isArray(res.entries)) throw internalError("list returned invalid entries")
    for (const e of res.entries) {
      if (
        !isValidSessionId(e.id) ||
        typeof e.title !== "string" ||
        (e.parentID !== null && !isValidSessionId(e.parentID)) ||
        typeof e.directory !== "string" ||
        e.directory.length === 0 ||
        e.directory.includes("\0") ||
        !isAbsolute(e.directory) ||
        (() => {
          try {
            return canonicalDirectory(e.directory) !== e.directory || e.directory !== directory
          } catch {
            return true
          }
        })() ||
        typeof e.projectID !== "string" ||
        e.projectID.length === 0 ||
        e.projectID.includes("\0") ||
        !isValidTimestamp(e.createdAt) ||
        !isValidTimestamp(e.updatedAt)
      ) {
        throw internalError("list returned invalid entry shape")
      }
    }
    if (res.nextCursor !== undefined) {
      try {
        const decoded = decodeGlobalListCursor(res.nextCursor)
        if (!isValidTimestamp(decoded.updated) || !isValidSessionId(decoded.id)) throw new Error("invalid cursor")
      } catch {
        throw internalError("list returned invalid nextCursor")
      }
    }
    const out: ObservationListResult = { v: OBSERVATION_VERSION, entries: [...res.entries] }
    if (res.nextCursor !== undefined) out.nextCursor = res.nextCursor
    return out
  }

  private async handleGet(params: unknown): Promise<ObservationGetResult> {
    if (params === null || typeof params !== "object" || Array.isArray(params))
      throw invalidParams("params must be object")
    const o = params as Record<string, unknown>
    const allowed = new Set(["v", "directory", "sessionId"])
    for (const k of Object.keys(o)) if (!allowed.has(k)) throw invalidParams(`unexpected field ${k}`)
    if (o.v !== OBSERVATION_VERSION) throw invalidParams(`unsupported observation version: ${String(o.v)}`)
    if (!("directory" in o)) throw invalidParams("directory is required")
    if (!("sessionId" in o)) throw invalidParams("sessionId is required")
    const directory = parseDirectory(o.directory)
    const sessionId = parseSessionId(o.sessionId)
    if (!this.deps.get) throw notFound(`Method not found: ${OBSERVATION_METHODS.GET}`)
    const res = await (async () => {
      try {
        return await this.deps.get!({ directory, sessionId })
      } catch (e) {
        if (e instanceof Error && (e as { code?: number }).code !== undefined) throw e
        throw internalError(e instanceof Error ? e.message : String(e))
      }
    })()
    validateGetResult(res, directory, sessionId)
    return res
  }

  private async handleMessages(params: unknown): Promise<ObservationMessagesResult> {
    if (params === null || typeof params !== "object" || Array.isArray(params))
      throw invalidParams("params must be object")
    const o = params as Record<string, unknown>
    const allowed = new Set(["v", "directory", "sessionId", "limit", "cursor"])
    for (const k of Object.keys(o)) if (!allowed.has(k)) throw invalidParams(`unexpected field ${k}`)
    if (o.v !== OBSERVATION_VERSION) throw invalidParams(`unsupported observation version: ${String(o.v)}`)
    if (!("directory" in o)) throw invalidParams("directory is required")
    if (!("sessionId" in o)) throw invalidParams("sessionId is required")
    if (!("limit" in o)) throw invalidParams("limit is required")
    const directory = parseDirectory(o.directory)
    const sessionId = parseSessionId(o.sessionId)
    const limit = (() => {
      const raw = o.limit
      if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 100)
        throw invalidParams("limit must be integer 1..100")
      return raw as number
    })()
    const msgCursor: string | undefined = (() => {
      if (!("cursor" in o) || o.cursor === undefined) return undefined
      const raw = o.cursor
      if (typeof raw !== "string") throw invalidParams("cursor must be opaque message cursor string")
      try {
        const decoded = decodeMessageCursor(raw)
        if (!isStrictCursorTime(decoded.time)) throw new Error("cursor must be opaque message cursor string")
      } catch (e) {
        throw invalidParams((e as Error).message)
      }
      return raw as string
    })()
    if (!this.deps.messages) throw notFound(`Method not found: ${OBSERVATION_METHODS.MESSAGES}`)
    const res = await (async () => {
      try {
        return await this.deps.messages!({ directory, sessionId, limit, cursor: msgCursor })
      } catch (e) {
        if (e instanceof Error && (e as { code?: number }).code !== undefined) throw e
        throw internalError(e instanceof Error ? e.message : String(e))
      }
    })()
    validateMessagesResult(res, limit)
    return res
  }

  notifyChanged(
    peer: { notify: (method: string, params?: unknown) => void },
    entries: ReadonlyArray<ObservationEntry>,
    cursor: number,
  ): void {
    for (const e of entries) {
      if (!isValidKind((e as ObservationEntry).kind)) {
        throw invalidParams(`invalid observation kind: ${String((e as ObservationEntry).kind)}`)
      }
    }
    const payload: ChangedNotification = { v: OBSERVATION_VERSION, cursor, entries: [...entries] as ObservationEntry[] }
    peer.notify(OBSERVATION_NOTIFICATION, payload)
  }
}

export function createObservationHandler(deps: ObservationDeps): (method: string, params: unknown) => Promise<unknown> {
  const ctrl = new ObservationController(deps)
  return (m, p) => ctrl.handle(m, p)
}
