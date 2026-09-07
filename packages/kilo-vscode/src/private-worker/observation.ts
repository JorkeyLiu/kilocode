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
import { ErrorCode } from "./json-rpc"

export const OBSERVATION_VERSION = "1.0" as const

export const OBSERVATION_METHODS = {
  SNAPSHOT: "observation/snapshot",
  READ: "observation/read",
  ACK: "observation/ack",
  SUBSCRIBE: "observation/subscribe",
  LIST: "observation/list",
} as const

export const OBSERVATION_NOTIFICATION = "observation/changed" as const

export type ObservationKind = "changed" | "deleted"

const VALID_KINDS = new Set<string>(["changed", "deleted"])

function isValidKind(v: unknown): v is ObservationKind {
  return typeof v === "string" && VALID_KINDS.has(v)
}

function isValidSessionId(v: unknown): boolean {
  return typeof v === "string" && v.length > 0 && v.startsWith("ses") && !v.includes("\0")
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

export interface ObservationDeps {
  getSnapshot: () => Promise<{ cursor: number; snapshot: unknown }>
  readAfter: (cursor: number) => Promise<ObservationReadBackendResult>
  ack: (cursor: number) => Promise<void>
  list?: (input: { directory: string; archived?: boolean; cursor?: string; limit: number }) => Promise<ObservationListResult>
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
  if (params !== null && typeof params === "object" && !Array.isArray(params) && "v" in (params as Record<string, unknown>)) {
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
    return { v: OBSERVATION_VERSION, cursor: res.cursor, rehydrate: false as const, entries: [...res.entries] as ObservationEntry[] }
  }

  private async handleAck(params: unknown): Promise<AckResult> {
    validateVersion(params)
    const cursor = extractCursor(params, true)
    await this.deps.ack(cursor)
    return { v: OBSERVATION_VERSION, cursor }
  }

  private async handleSubscribe(params: unknown): Promise<SubscribeResult> {
    validateVersion(params)
    if (params !== null && typeof params === "object" && !Array.isArray(params) && "cursor" in (params as Record<string, unknown>)) {
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
    const directory: string = (() => {
      if (!("directory" in o)) throw invalidParams("directory is required")
      const raw = o.directory
      if (typeof raw !== "string" || raw.length === 0 || raw.includes("\0")) throw invalidParams("directory must be non-empty absolute path")
      if (!isAbsolute(raw)) throw invalidParams("directory must be non-empty absolute path")
      try {
        return canonicalDirectory(raw)
      } catch (e) {
        const msg = (e as Error).message
        if (msg.includes("directory")) throw invalidParams(msg)
        throw invalidParams("directory must be non-empty absolute path")
      }
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

  notifyChanged(peer: { notify: (method: string, params?: unknown) => void }, entries: ReadonlyArray<ObservationEntry>, cursor: number): void {
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
