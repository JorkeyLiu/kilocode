// `experimental/session/list` read-only parity candidate (detached, warn-only).
// Strict v1 helpers for the private `experimental/session/list` capability:
// routing-only directory/workspace identity, `filter` payload, safe
// `{id,directory,title,updated}` summary projection with inline optional
// numeric `nextCursor` (omitted exactly when production omits `x-next-cursor`),
// redacted failures, and a detached parity helper comparing only the
// shared-id projection plus cursor presence/value for the same request.
// The private path never mutates SDK or user state and never replaces
// `GET /experimental/session` (`@kilocode/sdk`
// `client.experimental.session.list` remains the sole authority).
//
// Source facts (read-only evidence, not imported):
// - Route: `GET /experimental/session` with `SessionListQuery`
//   (`directory?`, `workspace?`, `projectID?`, `roots?`, `start?`, `cursor?`,
//   `search?`, `limit?`, `archived?`) in
//   `packages/opencode/src/server/routes/instance/httpapi/groups/experimental.ts`
//   (`identifier: "experimental.session.list"`, success
//   `Array(Session.GlobalInfo)` = `Session.Info` + `project: ProjectInfo|null`).
// - Handler: `packages/opencode/src/server/routes/instance/httpapi/handlers/experimental.ts`
//   `session` defaults `limit ?? 100`, calls `sessions.listGlobal` with
//   `limit + 1`, slices to `limit`, and emits `x-next-cursor` =
//   `last.time.updated` only when truncated.
// - Service: `Session.Service.listGlobal` (`GlobalInfo[]`).
// - SDK: v2 `client.experimental.session.list({directory?, workspace?,
//   projectID?, roots?, start?, cursor?, search?, limit?, archived?})` issues
//   `GET /experimental/session`.
// - Consumer: `packages/kilo-vscode/src/KiloProvider.ts`
//   `sessionRefreshContext.listSessions` calls with `{directory, limit, cursor}`
//   and reads the `x-next-cursor` response header.
// - Distinct from `session/status`, `session/get`, `session/messages`,
//   `session/children`, `experimental/session/background`, and the
//   non-experimental `GET /session` list route. This contract never matches
//   those operations.
//
// EXPLICIT UNKNOWNS (no inference without evidence):
// - Ordering: production description says "sorted by most recently updated"
//   but no ordering proof is captured here; parity never compares order.
// - Pagination: `limit`/`cursor`/`x-next-cursor` truncation semantics are not
//   modeled as a policy; length differences are membership-unknown, not match.
// - Freshness: `time.updated` staleness across calls is unknown.
// - Lifecycle: deleted/archived-session inclusion/exclusion is unknown;
//   `archived` default-excluded is description-only, not asserted.
// - Cross-directory: `directory`/`workspace` are ROUTING-ONLY labels; a scope
//   match says nothing about payload ownership and cross-directory payload
//   comparison is out of scope.

import { isAbsolute, normalize, resolve } from "path"

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function isNonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

function isSessionId(v: unknown): boolean {
  return typeof v === "string" && (v as string).startsWith("ses")
}

function canonicalDir(dir: string): string {
  return normalize(resolve(dir))
}

function assertAllowedKeys(rec: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const k of Object.keys(rec)) if (!allowed.has(k)) throw new Error(`unexpected ${label} field ${k}`)
}

export function canonicalSessionListOpId(token: string): string {
  if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
  if (token.includes(":")) throw new TypeError("token must not contain ':'")
  return `experimental-session-list:${token}`
}

export function parseSessionListOpId(opId: string): { token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  const segs = opId.split(":")
  if (segs.length !== 2) throw new TypeError(`experimental-session-list opId must be experimental-session-list:<token>: ${opId}`)
  if (segs[0] !== "experimental-session-list") throw new TypeError(`opId kind must be experimental-session-list: ${opId}`)
  const token = segs[1]!
  if (token.length === 0) throw new TypeError(`opId segment must be non-empty: ${opId}`)
  return { token }
}

export interface SessionListFilter {
  projectID?: string
  roots?: boolean
  start?: number
  cursor?: number
  search?: string
  limit?: number
  archived?: boolean
}

const SESSION_LIST_FILTER_FIELDS = new Set(["projectID", "roots", "start", "cursor", "search", "limit", "archived"])

function validateSessionListFilter(raw: unknown): SessionListFilter {
  if (!isRecord(raw)) throw new Error("payload.filter must be object")
  assertAllowedKeys(raw as Record<string, unknown>, SESSION_LIST_FILTER_FIELDS, "filter")
  const rec = raw as Record<string, unknown>
  if (rec.projectID !== undefined && !isNonEmpty(rec.projectID)) throw new Error("filter.projectID must be non-empty string when present")
  if (rec.roots !== undefined && typeof rec.roots !== "boolean") throw new Error("filter.roots must be boolean when present")
  if (rec.start !== undefined && (typeof rec.start !== "number" || !Number.isFinite(rec.start))) throw new Error("filter.start must be finite number when present")
  if (rec.cursor !== undefined && (typeof rec.cursor !== "number" || !Number.isFinite(rec.cursor))) throw new Error("filter.cursor must be finite number when present")
  if (rec.search !== undefined && typeof rec.search !== "string") throw new Error("filter.search must be string when present")
  if (rec.limit !== undefined) {
    if (typeof rec.limit !== "number" || !Number.isInteger(rec.limit) || rec.limit <= 0) throw new Error("filter.limit must be positive integer when present")
  }
  if (rec.archived !== undefined && typeof rec.archived !== "boolean") throw new Error("filter.archived must be boolean when present")
  return raw as unknown as SessionListFilter
}

export interface SessionListContractRequest {
  v: 1
  requestId: string
  opId: string
  op: "experimental/session/list"
  idempotencyKey: string
  context: {
    directory: string
    workspace?: string
  }
  payload: {
    filter: SessionListFilter
  }
}

// eslint-disable-next-line complexity
export function validateSessionListContractRequest(raw: unknown): SessionListContractRequest {
  if (!isRecord(raw)) throw new Error("request must be object")
  if (raw.v !== 1) throw new Error("v must be 1")
  if (!isNonEmpty(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmpty(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== "experimental/session/list") throw new Error("op must be experimental/session/list")
  if (!isNonEmpty(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId for session-list contract")
  const ctx = raw.context
  if (!isRecord(ctx)) throw new Error("context must be object")
  const allowedCtx = new Set(["directory", "workspace"])
  for (const k of Object.keys(ctx as Record<string, unknown>)) if (!allowedCtx.has(k)) throw new Error(`unexpected context field ${k}`)
  if (typeof ctx.directory !== "string" || !isAbsolute(ctx.directory) || ctx.directory.includes("\0")) throw new Error("context.directory must be absolute path")
  if (ctx.workspace !== undefined) {
    if (!isNonEmpty(ctx.workspace) || (ctx.workspace as string).includes("\0")) throw new Error("context.workspace must be non-empty string when present")
  }
  const payload = raw.payload
  if (!isRecord(payload)) throw new Error("payload must be object")
  const allowedPayload = new Set(["filter"])
  for (const k of Object.keys(payload as Record<string, unknown>)) if (!allowedPayload.has(k)) throw new Error(`unexpected payload field ${k}`)
  validateSessionListFilter((payload as Record<string, unknown>).filter)
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw as Record<string, unknown>)) if (!allowedRoot.has(k)) throw new Error(`unexpected field ${k}`)
  parseSessionListOpId(raw.opId as string)
  const idem = parseSessionListOpId(raw.idempotencyKey as string)
  if (idem.token !== parseSessionListOpId(raw.opId as string).token) throw new Error("idempotencyKey token must equal opId token")
  return raw as unknown as SessionListContractRequest
}

export type SessionListScopeWhich = "directory" | "workspace" | "request"

export type SessionListScopeCheck =
  | { ok: true }
  | { ok: false; code: "scope_mismatch"; which: SessionListScopeWhich }

export function checkSessionListScope(
  req: SessionListContractRequest,
  expected: { directory: string; workspace?: string; token: string },
): SessionListScopeCheck {
  let want = expected.directory
  try {
    want = canonicalDir(expected.directory)
  } catch {
    return { ok: false, code: "scope_mismatch", which: "directory" }
  }
  let got = req.context.directory
  try {
    got = canonicalDir(req.context.directory)
  } catch {
    return { ok: false, code: "scope_mismatch", which: "directory" }
  }
  if (got !== want) return { ok: false, code: "scope_mismatch", which: "directory" }
  const wantWs = expected.workspace
  const gotWs = req.context.workspace
  if ((wantWs === undefined) !== (gotWs === undefined)) return { ok: false, code: "scope_mismatch", which: "workspace" }
  if (wantWs !== undefined && gotWs !== wantWs) return { ok: false, code: "scope_mismatch", which: "workspace" }
  const parsed = parseSessionListOpId(req.opId)
  if (parsed.token !== expected.token) return { ok: false, code: "scope_mismatch", which: "request" }
  const bound = canonicalSessionListOpId(expected.token)
  if (req.opId !== bound || req.idempotencyKey !== bound) return { ok: false, code: "scope_mismatch", which: "request" }
  return { ok: true }
}

// Safe session summary projection: the smallest honest v1 subset that can be
// compared without product meaning. `id`/`directory`/`title` follow the B6
// `session/get` comparator; `updated` carries `time.updated` as a bare number
// with no freshness claim. All other `GlobalInfo` fields (slug, project,
// parent, summary, cost, tokens, share, agent, model, version, metadata,
// permission, revert, created/compacting/archived timestamps, diffs) are
// excluded by design so fixtures cannot carry secret material and no
// lifecycle/ordering meaning is inferred.
export interface SessionListSummary {
  id: string
  directory: string
  title: string
  updated: number
}

const SESSION_LIST_SUMMARY_FIELDS = new Set(["id", "directory", "title", "updated"])

export function validateSessionListSummary(raw: unknown): SessionListSummary {
  if (!isRecord(raw)) throw new Error("session summary must be object")
  assertAllowedKeys(raw as Record<string, unknown>, SESSION_LIST_SUMMARY_FIELDS, "session-summary")
  if (!isSessionId(raw.id)) throw new Error("session-summary.id must be SessionID")
  if (typeof raw.directory !== "string" || (raw.directory as string).length === 0) throw new Error("session-summary.directory must be non-empty string")
  if (typeof raw.title !== "string") throw new Error("session-summary.title must be string")
  if (typeof raw.updated !== "number" || !Number.isFinite(raw.updated) || (raw.updated as number) < 0) throw new Error("session-summary.updated must be non-negative finite number")
  return raw as unknown as SessionListSummary
}

export function validateSessionListSummaries(raw: unknown): SessionListSummary[] {
  if (!Array.isArray(raw)) throw new Error("sessions must be array")
  return (raw as unknown[]).map((item) => validateSessionListSummary(item))
}

export interface SessionListFailure {
  code: string
  message: string
  retryable: boolean
}

const SESSION_LIST_FAILURE_FORBIDDEN = new Set([
  "session",
  "sessionId",
  "sessions",
  "prompt",
  "tool",
  "error",
  "raw",
  "output",
  "detail",
  "directory",
  "workspace",
  "cursor",
])

const SESSION_LIST_FAILURE_FIELDS = new Set(["code", "message", "retryable"])

export function validateSessionListFailure(raw: unknown): SessionListFailure {
  if (!isRecord(raw)) throw new Error("failure must be object")
  for (const k of Object.keys(raw)) {
    if (SESSION_LIST_FAILURE_FORBIDDEN.has(k)) throw new Error(`failure must not carry ${k}`)
  }
  assertAllowedKeys(raw as Record<string, unknown>, SESSION_LIST_FAILURE_FIELDS, "failure")
  if (!isNonEmpty(raw.code)) throw new Error("failure code must be non-empty string")
  if (!isNonEmpty(raw.message)) throw new Error("failure message must be non-empty string")
  if (typeof raw.retryable !== "boolean") throw new Error("failure retryable must be boolean")
  return raw as unknown as SessionListFailure
}

export type SessionListResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: "experimental/session/list"
      idempotencyKey: string
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: { sessions: SessionListSummary[]; nextCursor?: number }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "experimental/session/list"
      idempotencyKey: string
      status: "failed"
      outcome: { type: "failed"; time: number; failure: SessionListFailure }
      accepted: boolean
      failure: SessionListFailure
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "experimental/session/list"
      idempotencyKey: string
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      transportUnknown?: boolean
    }

export function makeSessionListAmbiguous(req: SessionListContractRequest, transportUnknown = true): SessionListResult {
  const out: SessionListResult = {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "experimental/session/list",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

export type SessionListWireOutcome =
  | { kind: "valid"; result: SessionListResult }
  | { kind: "invalid"; detail: string }

export class SessionListValidationError extends Error {
  readonly kind = "private-session-list-validation" as const
  readonly detail: string
  constructor(detail: string) {
    super(`invalid private response shape: ${detail}`)
    this.name = "SessionListValidationError"
    this.detail = detail
  }
}

export function isSessionListValidationError(v: unknown): v is SessionListValidationError {
  return !!v && typeof v === "object" && (v as { kind?: unknown }).kind === "private-session-list-validation"
}

export function normalizePrivateSessionListWire(raw: unknown, req: SessionListContractRequest): SessionListWireOutcome {
  try {
    const result = validateSessionListResult(raw, req)
    return { kind: "valid", result }
  } catch (e) {
    const detail = String(e instanceof Error ? e.message : e).slice(0, 200)
    return { kind: "invalid", detail }
  }
}

const SESSION_LIST_RESULT_SUCCEEDED = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "status", "outcome", "accepted", "data"])
const SESSION_LIST_RESULT_FAILED = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "status", "outcome", "accepted", "failure"])
const SESSION_LIST_RESULT_AMBIGUOUS = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "status", "outcome", "accepted", "transportUnknown"])
const SESSION_LIST_OUTCOME_PLAIN = new Set(["type", "time"])
const SESSION_LIST_OUTCOME_FAILED = new Set(["type", "time", "failure"])

// eslint-disable-next-line complexity
export function validateSessionListResult(raw: unknown, req: SessionListContractRequest): SessionListResult {
  if (!isRecord(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== "experimental/session/list") throw new Error("op mismatch")
  if (raw.idempotencyKey !== req.idempotencyKey) throw new Error("idempotencyKey mismatch")
  const status = raw.status
  if (status !== "succeeded" && status !== "failed" && status !== "ambiguous") throw new Error("status must be succeeded/failed/ambiguous")
  if (typeof raw.accepted !== "boolean") throw new Error("accepted must be boolean")
  const outcome = raw.outcome
  if (!isRecord(outcome) || typeof outcome.type !== "string" || typeof outcome.time !== "number") throw new Error("outcome invalid")
  if (outcome.type !== status) throw new Error("outcome.type must match status")
  if (!Number.isFinite(outcome.time) || outcome.time < 0) throw new Error("outcome.time invalid")
  const rec = raw as Record<string, unknown>
  const outRec = outcome as Record<string, unknown>
  if (status === "succeeded") {
    assertAllowedKeys(rec, SESSION_LIST_RESULT_SUCCEEDED, "result")
    assertAllowedKeys(outRec, SESSION_LIST_OUTCOME_PLAIN, "outcome")
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    const data = rec.data
    if (!isRecord(data)) throw new Error("succeeded data must be object")
    const allowedData = new Set(["sessions", "nextCursor"])
    for (const k of Object.keys(data as Record<string, unknown>)) if (!allowedData.has(k)) throw new Error(`unexpected data field ${k}`)
    validateSessionListSummaries((data as Record<string, unknown>).sessions)
    const next = (data as Record<string, unknown>).nextCursor
    if (next !== undefined) {
      if (typeof next !== "number" || !Number.isFinite(next) || (next as number) < 0)
        throw new Error("succeeded data.nextCursor must be non-negative finite number when present")
    }
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (outRec.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as SessionListResult
  }
  if (status === "failed") {
    assertAllowedKeys(rec, SESSION_LIST_RESULT_FAILED, "result")
    assertAllowedKeys(outRec, SESSION_LIST_OUTCOME_FAILED, "outcome")
    const failure = validateSessionListFailure(rec.failure)
    const outFailure = validateSessionListFailure(outRec.failure)
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    if (rec.data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as SessionListResult
  }
  assertAllowedKeys(rec, SESSION_LIST_RESULT_AMBIGUOUS, "result")
  assertAllowedKeys(outRec, SESSION_LIST_OUTCOME_PLAIN, "outcome")
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean") throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (outRec.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as SessionListResult
}

// Detached parity only (never production parity):
// compares ONLY the projected summary fields (`id`, `directory`, `title`) for
// ids present on both sides plus cursor presence/value for the same request
// (private `data.nextCursor` vs production `x-next-cursor` header). Order is
// never compared; length/membership gaps are reported as explicit unknowns
// (`session-list-membership-unknown`) rather than matches or mismatches,
// because freshness and deleted/archived lifecycle are unknown. `updated` is
// validated for shape only and never compared. The request directory is never
// compared. Cursor values never leave this function; only presence booleans
// reach details.
type SdkSessionListCursorState =
  | { present: false }
  | { present: true; valid: true; value: number }
  | { present: true; valid: false }

function sdkSessionListCursorState(sdk: { response?: unknown }): SdkSessionListCursorState {
  const resp = (sdk as { response?: { headers?: unknown } }).response
  if (!resp || typeof resp !== "object") return { present: false }
  const headers = (resp as { headers?: unknown }).headers as { get?: unknown } | undefined
  if (headers && typeof headers.get === "function") {
    let v: unknown
    try {
      v = (headers.get as (k: string) => unknown).call(headers, "x-next-cursor")
    } catch {
      return { present: true, valid: false }
    }
    if (v === null || v === undefined) return { present: false }
    if (typeof v === "string") {
      if (v.trim().length === 0) return { present: true, valid: false }
      const n = Number(v)
      if (Number.isFinite(n) && n >= 0) return { present: true, valid: true, value: n }
      return { present: true, valid: false }
    }
    if (typeof v === "number") {
      if (Number.isFinite(v) && v >= 0) return { present: true, valid: true, value: v }
      return { present: true, valid: false }
    }
    return { present: true, valid: false }
  }
  return { present: false }
}

function privSessionListCursorValue(pdata: { nextCursor?: unknown }): number | null {
  const v = (pdata as { nextCursor?: unknown }).nextCursor
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v
  return null
}

type SessionListParityBase = { orderingUnknown: boolean; paginationUnknown: boolean; freshnessUnknown: boolean; lifecycleUnknown: boolean }

function compareSessionListSummaries(
  privSessions: SessionListSummary[],
  sdkRaw: unknown[],
  base: SessionListParityBase,
): { divergence: string | null; details: Record<string, unknown> } | null {
  const sdkById = new Map<string, Record<string, unknown>>()
  for (const item of sdkRaw) {
    if (!item || typeof item !== "object") continue
    const rec = item as Record<string, unknown>
    if (typeof rec.id === "string") sdkById.set(rec.id, rec)
  }
  for (const p of privSessions) {
    const s = sdkById.get(p.id)
    if (!s) {
      return { divergence: `session-list-membership-unknown:${p.id}`, details: { ...base, id: p.id } }
    }
    if (typeof s.directory === "string" && s.directory !== p.directory) {
      return { divergence: "session-list-directory-mismatch", details: { ...base, mismatch: true, field: "directory", id: p.id } }
    }
    if (typeof s.title === "string" && s.title !== p.title) {
      return { divergence: "session-list-title-mismatch", details: { ...base, mismatch: true, field: "title", id: p.id } }
    }
  }
  for (const [id] of sdkById) {
    if (!privSessions.some((p) => p.id === id)) {
      return { divergence: `session-list-membership-unknown:${id}`, details: { ...base, id } }
    }
  }
  return null
}

function compareSessionListCursors(
  pdata: { nextCursor?: unknown },
  sdk: { response?: unknown },
  compared: number,
  base: SessionListParityBase,
): { divergence: string | null; details: Record<string, unknown> } {
  const sdkState = sdkSessionListCursorState(sdk)
  const privCursor = privSessionListCursorValue(pdata)
  if (sdkState.present && !sdkState.valid) {
    return { divergence: "session-list-cursor-invalid", details: { ...base, sdkCursor: true, privCursor: privCursor !== null, invalid: true } }
  }
  const sdkCursor = sdkState.present && sdkState.valid ? sdkState.value : null
  const sdkHasCursor = sdkCursor !== null
  const privHasCursor = privCursor !== null
  if (sdkHasCursor !== privHasCursor || (sdkHasCursor && privHasCursor && sdkCursor !== privCursor)) {
    return { divergence: "session-list-cursor-mismatch", details: { ...base, sdkCursor: sdkHasCursor, privCursor: privHasCursor } }
  }
  return { divergence: null, details: { ...base, compared, sdkCursor: sdkHasCursor, privCursor: privHasCursor } }
}

export function compareSessionListParity(
  priv: SessionListResult,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
): { divergence: string | null; details: Record<string, unknown> } {
  const base = { orderingUnknown: true, paginationUnknown: true, freshnessUnknown: true, lifecycleUnknown: true }
  const privStatus: string = priv.status
  if (!!(priv as Record<string, unknown>).transportUnknown) {
    return { divergence: "transport-unknown", details: { privStatus, transportUnknown: true, ...base } }
  }
  const sdkError = sdk.error !== undefined && sdk.error !== null
  const sdkStatus: string = sdkError ? "failed" : "succeeded"
  if (sdkStatus !== privStatus) {
    return { divergence: `status-mismatch:sdk=${sdkStatus} priv=${privStatus}`, details: { sdkStatus, privStatus, ...base } }
  }
  if (sdkStatus === "succeeded" && privStatus === "succeeded") {
    const sdkRaw = sdk.data
    if (!Array.isArray(sdkRaw)) {
      return { divergence: "session-list-shape-mismatch", details: { ...base, mismatch: true } }
    }
    const pdata = (priv as Extract<SessionListResult, { status: "succeeded" }>).data
    const summaries = compareSessionListSummaries(pdata.sessions, sdkRaw as unknown[], base)
    if (summaries) return summaries
    return compareSessionListCursors(pdata as { nextCursor?: unknown }, sdk, pdata.sessions.length, base)
  }
  return { divergence: null, details: { ...base } }
}

// Peer-facing aliases following the serve-private-* naming conventions.
export type ServePrivateSessionListRequest = SessionListContractRequest
export type ServePrivateSessionListResult = SessionListResult
export type PrivateSessionListWireOutcome = SessionListWireOutcome
export { isSessionListValidationError as isPrivateSessionListValidationError }
