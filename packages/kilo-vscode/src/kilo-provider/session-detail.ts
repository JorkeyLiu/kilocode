import { isAbsolute } from "path"
import type { Session } from "@kilocode/sdk/v2/client"
import type { ObservationGetSession, ObservationGetResult } from "../private-worker/observation"
import { canonicalDirectory } from "../private-worker/canonical-directory"
import { ErrorCode } from "../private-worker/json-rpc"

export interface SessionDetail {
  id: string
  title: string
  parentID: string | null
  directory: string
  projectID: string
  createdAt: number
  updatedAt: number
  agent?: string
  summary?: { additions: number; deletions: number; files: number; diffs?: Array<{ file?: string; additions: number; deletions: number; status?: "added" | "deleted" | "modified" }> }
  revert?: { messageID: string; partID?: string; snapshot?: string; diff?: string }
}

function isValidSessionId(v: unknown): boolean {
  return typeof v === "string" && v.length > 0 && (v as string).startsWith("ses") && !(v as string).includes("\0")
}
function isValidMessageId(v: unknown): boolean {
  return typeof v === "string" && v.length > 0 && (v as string).startsWith("msg") && !(v as string).includes("\0")
}
function isValidPartId(v: unknown): boolean {
  return typeof v === "string" && v.length > 0 && (v as string).startsWith("prt") && !(v as string).includes("\0")
}
function isValidTimestamp(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v) && Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 8640000000000000
}
function isFiniteNumber(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v as number)
}

function internal(msg: string): Error & { code?: number } {
  const err = new Error(msg) as Error & { code?: number }
  err.code = ErrorCode.InternalError
  return err
}

/**
 * Narrow pure mapper: SDK Session -> SessionDetail.
 * Preserves only real fields. Canonical directory handling consistent with private projection.
 */
// eslint-disable-next-line complexity
export function sdkSessionToDetail(session: Session): SessionDetail {
  const raw = session as unknown as Record<string, unknown> & {
    id: string
    title: string
    parentID?: string | null
    directory: string
    projectID: string
    time: { created: number; updated: number }
    agent?: string
    summary?: unknown
    revert?: unknown
  }
  const id = raw.id
  const title = raw.title
  const parentID = raw.parentID ?? null
  const projectID = raw.projectID
  const createdAt = raw.time.created
  const updatedAt = raw.time.updated
  if (!isValidSessionId(id)) throw internal("sdk session has invalid id")
  if (typeof title !== "string") throw internal("sdk session has invalid title")
  if (parentID !== null && !isValidSessionId(parentID)) throw internal("sdk session has invalid parentID")
  if (typeof projectID !== "string" || projectID.length === 0 || projectID.includes("\0")) throw internal("sdk session has invalid projectID")
  if (!isValidTimestamp(createdAt) || !isValidTimestamp(updatedAt)) throw internal("sdk session has invalid timestamps")
  let directory: string
  try {
    directory = canonicalDirectory(raw.directory)
  } catch {
    throw internal("sdk session has invalid directory")
  }
  const detail: SessionDetail = { id, title, parentID, directory, projectID, createdAt, updatedAt }
  if (typeof raw.agent === "string") detail.agent = raw.agent
  if (raw.summary !== undefined && raw.summary !== null) {
    // Preserve as-is when SDK provides summary; validation mirrors observation adapter narrowly.
    const s = raw.summary as Record<string, unknown>
    if (typeof s.additions === "number" && typeof s.deletions === "number" && typeof s.files === "number") {
      const summary: SessionDetail["summary"] = { additions: s.additions as number, deletions: s.deletions as number, files: s.files as number }
      if (Array.isArray(s.diffs)) summary.diffs = s.diffs as unknown as NonNullable<SessionDetail["summary"]>["diffs"]
      detail.summary = summary
    }
  }
  if (raw.revert !== undefined && raw.revert !== null) {
    const r = raw.revert as Record<string, unknown>
    if (isValidMessageId(r.messageID)) {
      const revert: NonNullable<SessionDetail["revert"]> = { messageID: r.messageID as string }
      if (typeof r.partID === "string" && isValidPartId(r.partID)) revert.partID = r.partID as string
      if (typeof r.snapshot === "string") revert.snapshot = r.snapshot as string
      if (typeof r.diff === "string") revert.diff = r.diff as string
      detail.revert = revert
    }
  }
  return detail
}

/**
 * Narrow pure mapper: ObservationGetSession (validated) -> SessionDetail identity.
 */
export function observationSessionToDetail(session: ObservationGetSession): SessionDetail {
  const detail: SessionDetail = {
    id: session.id,
    title: session.title,
    parentID: session.parentID,
    directory: session.directory,
    projectID: session.projectID,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  }
  if (typeof session.agent === "string") detail.agent = session.agent
  if (session.summary !== undefined) detail.summary = session.summary as SessionDetail["summary"]
  if (session.revert !== undefined) detail.revert = session.revert as SessionDetail["revert"]
  return detail
}

/**
 * Narrow pure mapper: SessionDetail -> existing webview SessionInfo shape.
 * Mirrors kilocode sessionToWebview null semantics.
 */
export function detailToWebview(detail: SessionDetail) {
  return {
    id: detail.id,
    parentID: detail.parentID ?? null,
    title: detail.title,
    agent: detail.agent,
    createdAt: new Date(detail.createdAt).toISOString(),
    updatedAt: new Date(detail.updatedAt).toISOString(),
    revert: detail.revert ?? null,
    summary: detail.summary ?? null,
  }
}

/**
 * Defensive revalidation at KiloProvider boundary without duplicating broad observation controller.
 * Validates observation/get result shape and directory/session binding. Returns typed union.
 * Throws InternalError-coded error on malformed result.
 */
// eslint-disable-next-line complexity
export function validatePrivateGetResult(raw: unknown, directory: string, sessionId: string): ObservationGetResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw internal("get returned invalid shape")
  const r = raw as Record<string, unknown>
  if (r.v !== "1.0") throw internal("get returned invalid version")
  if (typeof r.status !== "string" || !["found", "not_found", "scope_mismatch"].includes(r.status as string)) throw internal("get returned invalid status")
  const status = r.status as string
  if (status === "not_found" || status === "scope_mismatch") {
    const allowed = new Set(["v", "status"])
    for (const k of Object.keys(r)) if (!allowed.has(k)) throw internal("get returned invalid shape")
    if ("session" in r) throw internal("get returned invalid shape")
    return r as ObservationGetResult
  }
  const allowedFound = new Set(["v", "status", "session"])
  for (const k of Object.keys(r)) if (!allowedFound.has(k)) throw internal("get returned invalid shape")
  if (!("session" in r)) throw internal("get returned invalid session")
  const s = r.session as Record<string, unknown>
  // Narrow revalidation of found session (mirrors observation adapter but minimal)
  if (!isValidSessionId(s.id) || typeof s.title !== "string" || (s.parentID !== null && s.parentID !== undefined && !isValidSessionId(s.parentID as unknown)) || s.parentID === undefined) throw internal("get returned invalid session shape")
  if (typeof s.directory !== "string" || s.directory.length === 0 || s.directory.includes("\0") || !isAbsolute(s.directory as string)) throw internal("get returned invalid session shape")
  let canonRequested: string
  let canonReturned: string
  try {
    canonRequested = canonicalDirectory(directory)
    canonReturned = canonicalDirectory(s.directory as string)
  } catch {
    throw internal("get returned invalid session shape")
  }
  if (canonReturned !== canonRequested || (s.directory as string) !== directory) {
    // Enforce exact canonical + lexical match with requested directory; private service already enforces but revalidate defensively
    try {
      if (canonicalDirectory(s.directory as string) !== (s.directory as string) || (s.directory as string) !== canonRequested) throw internal("get returned invalid session shape")
    } catch {
      throw internal("get returned invalid session shape")
    }
  }
  if (typeof s.projectID !== "string" || s.projectID.length === 0 || (s.projectID as string).includes("\0")) throw internal("get returned invalid session shape")
  if (!isValidTimestamp(s.createdAt) || !isValidTimestamp(s.updatedAt)) throw internal("get returned invalid session shape")
  if (s.id !== sessionId) throw internal("get returned invalid session shape")
  if ("agent" in s && s.agent !== undefined && typeof s.agent !== "string") throw internal("get returned invalid session shape")
  if ("agent" in s && typeof s.agent === "string" && (s.agent as string).includes("\0")) throw internal("get returned invalid session shape")
  if ("summary" in s && s.summary !== undefined) {
    const sum = s.summary as unknown
    if (typeof sum !== "object" || sum === null || Array.isArray(sum)) throw internal("get returned invalid session shape")
    const ss = sum as Record<string, unknown>
    const allowedSum = new Set(["additions", "deletions", "files", "diffs"])
    for (const k of Object.keys(ss)) if (!allowedSum.has(k)) throw internal("get returned invalid session shape")
    if (!isFiniteNumber(ss.additions) || !isFiniteNumber(ss.deletions) || !isFiniteNumber(ss.files)) throw internal("get returned invalid session shape")
    if ("diffs" in ss && ss.diffs !== undefined) {
      if (!Array.isArray(ss.diffs)) throw internal("get returned invalid session shape")
      for (const d of ss.diffs as unknown[]) {
        if (typeof d !== "object" || d === null || Array.isArray(d)) throw internal("get returned invalid session shape")
        const diff = d as Record<string, unknown>
        const allowedDiff = new Set(["file", "additions", "deletions", "status"])
        for (const k of Object.keys(diff)) if (!allowedDiff.has(k)) throw internal("get returned invalid session shape")
        if (!isFiniteNumber(diff.additions) || !isFiniteNumber(diff.deletions)) throw internal("get returned invalid session shape")
        if ("file" in diff && diff.file !== undefined && typeof diff.file !== "string") throw internal("get returned invalid session shape")
        if ("status" in diff && diff.status !== undefined && !["added", "deleted", "modified"].includes(diff.status as string)) throw internal("get returned invalid session shape")
      }
    }
  }
  if ("revert" in s && s.revert !== undefined) {
    const rev = s.revert as unknown
    if (typeof rev !== "object" || rev === null || Array.isArray(rev)) throw internal("get returned invalid session shape")
    const rr = rev as Record<string, unknown>
    const allowedRev = new Set(["messageID", "partID", "snapshot", "diff"])
    for (const k of Object.keys(rr)) if (!allowedRev.has(k)) throw internal("get returned invalid session shape")
    if (!isValidMessageId(rr.messageID)) throw internal("get returned invalid session shape")
    if ("partID" in rr && rr.partID !== undefined && !isValidPartId(rr.partID as unknown)) throw internal("get returned invalid session shape")
    if ("snapshot" in rr && rr.snapshot !== undefined && typeof rr.snapshot !== "string") throw internal("get returned invalid session shape")
    if ("diff" in rr && rr.diff !== undefined && typeof rr.diff !== "string") throw internal("get returned invalid session shape")
  }
  const allowedKeys = new Set(["id", "title", "parentID", "directory", "projectID", "createdAt", "updatedAt", "agent", "summary", "revert"])
  for (const k of Object.keys(s)) if (!allowedKeys.has(k)) throw internal("get returned invalid session shape")
  return r as ObservationGetResult
}

export class SessionNotFoundError extends Error {
  constructor(message = "Session not found") {
    super(message)
    this.name = "SessionNotFoundError"
  }
}
export class SessionScopeMismatchError extends Error {
  constructor(message = "Session scope mismatch") {
    super(message)
    this.name = "SessionScopeMismatchError"
  }
}
