import { isAbsolute, normalize, resolve } from "path"
import * as crypto from "crypto"

// B8 `session/children` read-only parent-directory-bound list snapshot (detached parity only).
// Request is strictly `{v:1,requestId,opId,op:"session/children",
// idempotencyKey,context:{directory,parentSessionId},payload:{}}`
// with `opId === children:<parentSessionId>:<token>` (token non-empty, no
// colon) and `idempotencyKey === opId`. Parent directory is the strict
// canonical scope; result child entries retain their own canonical
// directories and may differ from the parent directory. Success data is
// `{children: Session.Info[]}` with every child `parentID === parentSessionId`;
// the comparator treats results as an unordered keyed-by-id collection and
// compares stable relationship fields `id,parentID,canonical directory,title`
// plus the full payload in memory only. No ordering/revision/cursor contract.
// Concurrent create/fork/list changes are warning-only observation divergence.
// Diagnostics never expose ids, directories, titles, payloads, op/request ids,
// backend codes, or raw error strings: only fixed categories, counts,
// booleans, HTTP classes, and the constant op.

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function isNonEmptyString(v: unknown): boolean {
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

function assertFailureDetailMirror(top: Record<string, unknown>, out: Record<string, unknown>): void {
  const hasTop = top.detail !== undefined
  const hasOut = out.detail !== undefined
  if (!hasTop && !hasOut) return
  if (hasTop !== hasOut) throw new Error("failure detail presence mismatch")
  if (top.detail !== out.detail) throw new Error("failure detail mismatch")
}

function statusInRange(n: unknown): number | null {
  if (typeof n === "number" && Number.isInteger(n) && n >= 100 && n < 600) return n
  if (typeof n === "string") {
    const v = Number(n)
    if (Number.isInteger(v) && v >= 100 && v < 600) return v
  }
  return null
}

function errorStatusFromFields(err: Record<string, unknown>): number | null {
  const cands: unknown[] = [err.status, err.statusCode, err.code, err.httpStatus, err.status_code, err.httpStatusCode]
  for (const c of cands) {
    const v = statusInRange(c)
    if (v !== null) return v
  }
  return null
}

function errorStatusFromMessage(err: Record<string, unknown>): number | null {
  if (typeof err.message === "string") {
    const m = err.message.match(/\b(400|404|409|500)\b/)
    if (m) return Number(m[1])
  }
  const tag = typeof err._tag === "string" ? String(err._tag).toLowerCase() : ""
  if (tag.includes("notfound")) return 404
  if (tag.includes("conflict")) return 409
  if (tag.includes("badrequest")) return 400
  if (tag.includes("internal")) return 500
  return null
}

function sdkHttpStatus(sdk: { data?: unknown; error?: unknown; response?: unknown }): number | null {
  const resp = (sdk as { response?: unknown }).response as { status?: unknown } | undefined
  if (resp) {
    const v = statusInRange(resp.status)
    if (v !== null) return v
  }
  if (!sdk.error) return null
  const err = sdk.error as Record<string, unknown>
  return errorStatusFromFields(err) ?? errorStatusFromMessage(err)
}

function sdkStatusClass(status: number | null): string | null {
  if (status === null) return null
  if (status === 400) return "400"
  if (status === 404) return "404"
  if (status === 409) return "409"
  if (status === 500) return "500"
  return String(status)
}

export function canonicalChildrenOpId(parentSessionId: string, token: string): string {
  if (typeof parentSessionId !== "string" || parentSessionId.length === 0)
    throw new TypeError("parentSessionId must be non-empty string")
  if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
  if (token.includes(":")) throw new TypeError("token must not contain ':'")
  return `children:${parentSessionId}:${token}`
}

export interface ServePrivateChildrenRequest {
  v: 1
  requestId: string
  opId: string
  op: "session/children"
  idempotencyKey: string
  context: {
    directory: string
    parentSessionId: string
  }
  payload: Record<string, never>
}

export type ServePrivateChildrenResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/children"
      idempotencyKey: string
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: { children: Record<string, unknown>[] }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/children"
      idempotencyKey: string
      status: "failed"
      outcome: {
        type: "failed"
        time: number
        failure: { code: string; message: string; retryable: boolean; detail?: string }
      }
      accepted: boolean
      failure: { code: string; message: string; retryable: boolean; detail?: string }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/children"
      idempotencyKey: string
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      transportUnknown?: boolean
    }

export function makeChildrenAmbiguous(
  req: ServePrivateChildrenRequest,
  transportUnknown = true,
): ServePrivateChildrenResult {
  const out: ServePrivateChildrenResult = {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/children",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

export function failedChildrenResult(
  req: ServePrivateChildrenRequest,
  code: string,
  msg: string,
): ServePrivateChildrenResult {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/children",
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: Date.now(), failure: { code, message: msg, retryable: false } },
    accepted: false,
    failure: { code, message: msg, retryable: false },
  }
}

/** Minimal raw transport surface a peer owner needs for the children outcome handle. */
export interface ChildrenRawTransport {
  requestWithId(method: string, params: unknown): { id: number; promise: Promise<unknown> }
}

/** Epoch/closure semantics the peer owner supplies; diagnostics stay fixed-shape. */
interface ChildrenRequestHost {
  isStale(): boolean
  isClosed(err: unknown): boolean
  failInfo(err: unknown): { code: string; msg: string }
}

/**
 * Peer-side normalized outcome handle core for the read-only children parity
 * observer. The caller validates the request and checks availability and
 * capability first. Transport/closed maps to ambiguous transportUnknown,
 * thrown errors map to failed results, and malformed wire resolves as
 * `{ kind: "invalid" }` before any comparator. No retries, no replays.
 */
export function requestChildrenOutcome(
  raw: ChildrenRawTransport,
  host: ChildrenRequestHost,
  makeCancel: (id: number) => (msg?: string) => boolean,
  req: ServePrivateChildrenRequest,
): { id: number; promise: Promise<PrivateChildrenWireOutcome>; cancel: (msg?: string) => boolean } {
  const { id, promise: rawPromise } = raw.requestWithId("session/children", req)
  const promise = (async (): Promise<PrivateChildrenWireOutcome> => {
    let wire: unknown
    try {
      wire = await rawPromise
    } catch (e: unknown) {
      if (host.isClosed(e)) return { kind: "valid", result: makeChildrenAmbiguous(req, true) }
      const { code, msg } = host.failInfo(e)
      return { kind: "valid", result: failedChildrenResult(req, code, msg) }
    }
    if (host.isStale()) return { kind: "valid", result: makeChildrenAmbiguous(req, true) }
    return normalizePrivateChildrenWire(wire, req)
  })()
  return { id, promise, cancel: makeCancel(id) }
}

/**
 * Exact-id timeout cancel ownership for a children observer handle. Only
 * fixed categories reach diagnostics: the constant op plus booleans. Stale
 * handles clean only their captured peer; current-epoch miss/throw reports
 * through `invalidate` so the owner can fail-closed.
 */
export function makeChildrenCancel(
  id: number,
  host: { isStale(): boolean; tryCancel(msg: string): boolean; invalidate(reason: string): void },
): (msg?: string) => boolean {
  return (msg = "private parity timeout"): boolean => {
    if (host.isStale()) {
      try {
        host.invalidate("children stale observer timeout")
      } catch {
        console.warn("[Kilo] stale observer cleanup failed:", {
          op: "session/children",
          stale: true,
          cleanupFailed: true,
        })
      }
      return false
    }
    let ok = false
    try {
      ok = host.tryCancel(msg)
    } catch {
      console.warn("[Kilo] observer timeout cancel failed:", { op: "session/children", cancelFailed: true })
      try {
        host.invalidate("children observer timeout cancel throw")
      } catch {
        console.warn("[Kilo] observer timeout invalidate failed:", { op: "session/children", invalidateFailed: true })
      }
      return false
    }
    if (!ok) {
      try {
        host.invalidate("children observer timeout exact cancel miss")
      } catch {
        console.warn("[Kilo] observer timeout invalidate failed:", { op: "session/children", invalidateFailed: true })
      }
      return false
    }
    return true
  }
}

/** Owner-level epoch mapping for the connection pass-through. */
interface ChildrenOwner {
  epochAtCall: number | null
  isCurrent(): boolean
  invalidate(reason: string): void
}

/**
 * Connection-side epoch-aware wrapper around a peer children outcome handle.
 * Epoch drift or peer replacement maps to ambiguous transportUnknown; exact
 * cancel preserves the peer while current-epoch cancel miss/throw fail-closed
 * via owner invalidation. A stale captured handle cleans only its captured
 * peer and returns `"stale"` so the observer never invalidates the
 * replacement peer.
 */
export function wrapChildrenOutcomeForOwner(
  owner: ChildrenOwner,
  tryCancel: (id: number, msg: string) => boolean,
  staleCleanup: () => void,
  handle: { id: number; promise: Promise<PrivateChildrenWireOutcome> },
  req: ServePrivateChildrenRequest,
): { id: number; promise: Promise<PrivateChildrenWireOutcome>; cancel: (msg?: string) => boolean | "stale" } {
  const promise = handle.promise.then((outcome) => {
    if (!owner.isCurrent()) {
      return { kind: "valid", result: makeChildrenAmbiguous(req, true) } as PrivateChildrenWireOutcome
    }
    return outcome
  })
  const cancel = (msg = "private parity timeout"): boolean | "stale" => {
    if (!owner.isCurrent()) {
      try {
        staleCleanup()
      } catch {
        console.warn("[Kilo] stale observer cleanup failed:", {
          op: "session/children",
          stale: true,
          cleanupFailed: true,
        })
      }
      return "stale"
    }
    let ok = false
    try {
      ok = tryCancel(handle.id, msg)
    } catch {
      console.warn("[Kilo] observer timeout cancel failed:", {
        op: "session/children",
        cancelFailed: true,
      })
      try {
        owner.invalidate("children observer timeout cancel throw")
      } catch {
        console.warn("[Kilo] observer timeout invalidate failed:", {
          op: "session/children",
          invalidateFailed: true,
        })
      }
      return false
    }
    if (!ok) {
      try {
        owner.invalidate("children observer timeout exact cancel miss")
      } catch {
        console.warn("[Kilo] observer timeout invalidate failed:", {
          op: "session/children",
          invalidateFailed: true,
        })
      }
      return false
    }
    return true
  }
  return { id: handle.id, promise, cancel }
}

/**
 * Owner-managed deferred children observers: at most one deferred private
 * children observation per backend epoch + canonical parent directory +
 * parent session. Wrappers live in the owner's availability-listener set too;
 * this map only provides the dedupe key. No timers, no polling, no detached
 * work, no new peer lifecycle. The parent id is represented only by its
 * SHA-256 digest so keys never expose parent material.
 */
export class DeferredChildren {
  private readonly map = new Map<string, () => void>()
  constructor(private readonly listeners: Set<() => void>) {}

  key(epoch: number | null, dir: string, parentSessionId: string): string {
    let canonical = dir
    try {
      canonical = normalize(resolve(dir))
    } catch {
      canonical = dir
    }
    const parentPart = `h-${crypto.createHash("sha256").update(parentSessionId, "utf8").digest("hex")}`
    return `children:${epoch ?? "none"}:${canonical}:${parentPart}`
  }

  add(
    epoch: number | null,
    failedEpoch: number | null,
    available: boolean,
    dir: string,
    parentSessionId: string,
    listener: () => void,
  ): () => void {
    if (epoch === null) return () => {}
    if (failedEpoch !== null && epoch === failedEpoch) return () => {}
    if (available) return () => {}
    const key = this.key(epoch, dir, parentSessionId)
    if (this.map.has(key)) return () => {}
    let wrapper: () => void = () => {
      this.remove(key, wrapper)
      listener()
    }
    this.map.set(key, wrapper)
    this.listeners.add(wrapper)
    return () => {
      this.remove(key, wrapper)
    }
  }

  remove(key: string, wrapper: () => void): void {
    if (this.map.get(key) === wrapper) this.map.delete(key)
    this.listeners.delete(wrapper)
  }

  clearForEpoch(epoch: number | null): void {
    const prefix = `children:${epoch ?? "none"}:`
    for (const [key, wrapper] of [...this.map]) {
      if (!key.startsWith(prefix)) continue
      this.map.delete(key)
      this.listeners.delete(wrapper)
    }
  }

  clearAll(): void {
    for (const [, wrapper] of [...this.map]) this.listeners.delete(wrapper)
    this.map.clear()
  }

  get size(): number {
    return this.map.size
  }
}

// eslint-disable-next-line complexity
export function validateChildrenRequest(raw: unknown): ServePrivateChildrenRequest {
  if (!isRecord(raw)) throw new Error("request must be object")
  if (raw.v !== 1) throw new Error("v must be 1")
  if (!isNonEmptyString(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmptyString(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== "session/children") throw new Error("op must be session/children")
  if (!isNonEmptyString(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId for children")
  const ctx = raw.context
  if (!isRecord(ctx)) throw new Error("context must be object")
  const allowedCtx = new Set(["directory", "parentSessionId"])
  for (const k of Object.keys(ctx as Record<string, unknown>))
    if (!allowedCtx.has(k)) throw new Error(`unexpected context field ${k}`)
  if (
    typeof ctx.directory !== "string" ||
    !isAbsolute(ctx.directory as string) ||
    (ctx.directory as string).includes("\0")
  )
    throw new Error("context.directory must be absolute path")
  if (!isSessionId(ctx.parentSessionId)) throw new Error("context.parentSessionId must be SessionID")
  const payload = raw.payload
  if (!isRecord(payload)) throw new Error("payload must be object")
  if (Object.keys(payload as Record<string, unknown>).length !== 0)
    throw new Error("payload must be empty object for children")
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw as Record<string, unknown>))
    if (!allowedRoot.has(k)) throw new Error(`unexpected field ${k}`)
  // Exact request identity: opId must be `children:<parentSessionId>:<token>`
  // with a non-empty colon-free token. The parent id itself may contain
  // colons (backend SessionID predicate), so bind by prefix, not by split.
  const pid = ctx.parentSessionId as string
  const opId = raw.opId as string
  const prefix = `children:${pid}:`
  if (!opId.startsWith(prefix)) throw new Error("opId must be children:<parentSessionId>:<token>")
  const token = opId.slice(prefix.length)
  if (token.length === 0 || token.includes(":")) throw new Error("opId must be children:<parentSessionId>:<token>")
  return raw as unknown as ServePrivateChildrenRequest
}

const CHILDREN_RESULT_ROOT_SUCCEEDED = new Set([
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
const CHILDREN_RESULT_ROOT_FAILED = new Set([
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
const CHILDREN_RESULT_ROOT_AMBIGUOUS = new Set([
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
const CHILDREN_FAILURE_FIELDS = new Set(["code", "message", "retryable", "detail"])
const CHILDREN_OUTCOME_SUCCEEDED_FIELDS = new Set(["type", "time"])
const CHILDREN_OUTCOME_FAILED_FIELDS = new Set(["type", "time", "failure"])
const CHILDREN_OUTCOME_AMBIGUOUS_FIELDS = new Set(["type", "time"])

/**
 * Type-honest wire normalization for `session/children`.
 * A raw wire payload is either a strictly valid private children result or
 * an invalid-wire diagnostic. Invalid wire is never a normal `failed` result
 * and never reaches `compareChildrenParity` or SDK state.
 */
export type PrivateChildrenWireOutcome =
  | { kind: "valid"; result: ServePrivateChildrenResult }
  | { kind: "invalid"; detail: string }

export class PrivateChildrenValidationError extends Error {
  readonly kind = "private-children-validation" as const
  readonly detail: string
  constructor(detail: string) {
    super(`invalid private response shape: ${detail}`)
    this.name = "PrivateChildrenValidationError"
    this.detail = detail
  }
}

export function isPrivateChildrenValidationError(v: unknown): v is PrivateChildrenValidationError {
  return !!v && typeof v === "object" && (v as { kind?: unknown }).kind === "private-children-validation"
}

export function normalizePrivateChildrenWire(
  raw: unknown,
  req: ServePrivateChildrenRequest,
): PrivateChildrenWireOutcome {
  try {
    const result = validateChildrenResult(raw, req)
    return { kind: "valid", result }
  } catch (e) {
    const detail = String(e instanceof Error ? e.message : e).slice(0, 200)
    return { kind: "invalid", detail }
  }
}

function validateChildrenFailureShape(v: unknown, label: string): Record<string, unknown> {
  if (!isRecord(v)) throw new Error(`${label} invalid`)
  assertAllowedKeys(v as Record<string, unknown>, CHILDREN_FAILURE_FIELDS, label)
  const rec = v as Record<string, unknown>
  if (typeof rec.code !== "string" || typeof rec.message !== "string" || typeof rec.retryable !== "boolean")
    throw new Error(`${label} invalid`)
  if (rec.detail !== undefined && typeof rec.detail !== "string")
    throw new Error(`${label}.detail must be string if present`)
  return rec
}

const CHILDREN_ENTRY_FIELDS = new Set([
  "id",
  "slug",
  "projectID",
  "workspaceID",
  "directory",
  "path",
  "parentID",
  "summary",
  "cost",
  "tokens",
  "share",
  "title",
  "agent",
  "model",
  "version",
  "metadata",
  "time",
  "permission",
  "revert",
])

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v)
}

function isNonNegInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && Number.isFinite(v)
}

function isMessageId(v: unknown): boolean {
  return typeof v === "string" && (v as string).startsWith("msg")
}

function isPartId(v: unknown): boolean {
  return typeof v === "string" && (v as string).startsWith("prt")
}

function isWorkspaceId(v: unknown): boolean {
  return typeof v === "string" && (v as string).startsWith("wrk")
}

const CHILDREN_TIME_FIELDS = new Set(["created", "updated", "compacting", "archived"])
const CHILDREN_SUMMARY_FIELDS = new Set(["additions", "deletions", "files", "diffs"])
const CHILDREN_SUMMARY_DIFF_FIELDS = new Set(["file", "additions", "deletions", "status"])
const CHILDREN_TOKENS_FIELDS = new Set(["input", "output", "reasoning", "cache"])
const CHILDREN_TOKENS_CACHE_FIELDS = new Set(["read", "write"])
const CHILDREN_SHARE_FIELDS = new Set(["url"])
const CHILDREN_MODEL_FIELDS = new Set(["id", "providerID", "variant"])
const CHILDREN_REVERT_FIELDS = new Set(["messageID", "partID", "snapshot", "diff"])
const CHILDREN_PERMISSION_RULE_FIELDS = new Set(["permission", "pattern", "action"])

function validateChildrenTime(v: unknown): void {
  if (!isRecord(v)) throw new Error("succeeded data.children entry time must be object")
  const rec = v as Record<string, unknown>
  assertAllowedKeys(rec, CHILDREN_TIME_FIELDS, "succeeded data.children entry time")
  if (!isNonNegInt(rec.created) || !isNonNegInt(rec.updated))
    throw new Error("succeeded data.children entry time invalid")
  if (rec.compacting !== undefined && !isNonNegInt(rec.compacting))
    throw new Error("succeeded data.children entry time.compacting invalid")
  if (rec.archived !== undefined && !isFiniteNumber(rec.archived))
    throw new Error("succeeded data.children entry time.archived invalid")
}

function validateChildrenSummaryDiff(v: unknown): void {
  if (!isRecord(v)) throw new Error("succeeded data.children entry summary.diffs entry must be object")
  const rec = v as Record<string, unknown>
  assertAllowedKeys(rec, CHILDREN_SUMMARY_DIFF_FIELDS, "succeeded data.children entry summary.diffs entry")
  if (!isFiniteNumber(rec.additions) || !isFiniteNumber(rec.deletions))
    throw new Error("succeeded data.children entry summary.diffs entry invalid")
  if (rec.file !== undefined && typeof rec.file !== "string")
    throw new Error("succeeded data.children entry summary.diffs entry file invalid")
  if (
    rec.status !== undefined &&
    rec.status !== "added" &&
    rec.status !== "deleted" &&
    rec.status !== "modified"
  )
    throw new Error("succeeded data.children entry summary.diffs entry status invalid")
}

function validateChildrenSummary(v: unknown): void {
  if (!isRecord(v)) throw new Error("succeeded data.children entry summary invalid")
  const rec = v as Record<string, unknown>
  assertAllowedKeys(rec, CHILDREN_SUMMARY_FIELDS, "succeeded data.children entry summary")
  if (!isFiniteNumber(rec.additions) || !isFiniteNumber(rec.deletions) || !isFiniteNumber(rec.files))
    throw new Error("succeeded data.children entry summary invalid")
  if (rec.diffs !== undefined) {
    if (!Array.isArray(rec.diffs)) throw new Error("succeeded data.children entry summary.diffs invalid")
    for (const d of rec.diffs as unknown[]) validateChildrenSummaryDiff(d)
  }
}

function validateChildrenTokens(v: unknown): void {
  if (!isRecord(v)) throw new Error("succeeded data.children entry tokens invalid")
  const rec = v as Record<string, unknown>
  assertAllowedKeys(rec, CHILDREN_TOKENS_FIELDS, "succeeded data.children entry tokens")
  if (!isFiniteNumber(rec.input) || !isFiniteNumber(rec.output) || !isFiniteNumber(rec.reasoning))
    throw new Error("succeeded data.children entry tokens invalid")
  if (!isRecord(rec.cache)) throw new Error("succeeded data.children entry tokens.cache invalid")
  const cache = rec.cache as Record<string, unknown>
  assertAllowedKeys(cache, CHILDREN_TOKENS_CACHE_FIELDS, "succeeded data.children entry tokens.cache")
  if (!isFiniteNumber(cache.read) || !isFiniteNumber(cache.write))
    throw new Error("succeeded data.children entry tokens.cache invalid")
}

function validateChildrenShare(v: unknown): void {
  if (!isRecord(v)) throw new Error("succeeded data.children entry share invalid")
  const rec = v as Record<string, unknown>
  assertAllowedKeys(rec, CHILDREN_SHARE_FIELDS, "succeeded data.children entry share")
  if (!isNonEmptyString(rec.url)) throw new Error("succeeded data.children entry share.url invalid")
}

function validateChildrenModel(v: unknown): void {
  if (!isRecord(v)) throw new Error("succeeded data.children entry model invalid")
  const rec = v as Record<string, unknown>
  assertAllowedKeys(rec, CHILDREN_MODEL_FIELDS, "succeeded data.children entry model")
  if (!isNonEmptyString(rec.id)) throw new Error("succeeded data.children entry model.id invalid")
  if (!isNonEmptyString(rec.providerID)) throw new Error("succeeded data.children entry model.providerID invalid")
  if (rec.variant !== undefined && typeof rec.variant !== "string")
    throw new Error("succeeded data.children entry model.variant invalid")
}

function validateChildrenPermission(v: unknown): void {
  if (!Array.isArray(v)) throw new Error("succeeded data.children entry permission invalid")
  for (const rule of v as unknown[]) {
    if (!isRecord(rule)) throw new Error("succeeded data.children entry permission rule invalid")
    const rec = rule as Record<string, unknown>
    assertAllowedKeys(rec, CHILDREN_PERMISSION_RULE_FIELDS, "succeeded data.children entry permission rule")
    if (typeof rec.permission !== "string" || typeof rec.pattern !== "string")
      throw new Error("succeeded data.children entry permission rule invalid")
    if (rec.action !== "allow" && rec.action !== "deny" && rec.action !== "ask")
      throw new Error("succeeded data.children entry permission rule action invalid")
  }
}

function validateChildrenRevert(v: unknown): void {
  if (!isRecord(v)) throw new Error("succeeded data.children entry revert invalid")
  const rec = v as Record<string, unknown>
  assertAllowedKeys(rec, CHILDREN_REVERT_FIELDS, "succeeded data.children entry revert")
  if (!isMessageId(rec.messageID)) throw new Error("succeeded data.children entry revert.messageID invalid")
  if (rec.partID !== undefined && !isPartId(rec.partID))
    throw new Error("succeeded data.children entry revert.partID invalid")
  if (rec.snapshot !== undefined && typeof rec.snapshot !== "string")
    throw new Error("succeeded data.children entry revert.snapshot invalid")
  if (rec.diff !== undefined && typeof rec.diff !== "string")
    throw new Error("succeeded data.children entry revert.diff invalid")
}

// eslint-disable-next-line complexity
function validateChildrenEntry(item: unknown, parentSessionId: string): void {
  if (!isRecord(item)) throw new Error("succeeded data.children entry must be object")
  const rec = item as Record<string, unknown>
  assertAllowedKeys(rec, CHILDREN_ENTRY_FIELDS, "succeeded data.children entry")
  if (!isSessionId(rec.id)) throw new Error("succeeded data.children entry id must be SessionID")
  if (!isSessionId(rec.parentID)) throw new Error("succeeded data.children entry parentID must be SessionID")
  if (rec.parentID !== parentSessionId) throw new Error("succeeded data.children entry parentID mismatch")
  if (
    typeof rec.directory !== "string" ||
    (rec.directory as string).length === 0 ||
    !isAbsolute(rec.directory as string) ||
    (rec.directory as string).includes("\0")
  )
    throw new Error("succeeded data.children entry directory must be absolute path")
  try {
    const canon = canonicalDir(rec.directory as string)
    if (!isAbsolute(canon) || canon.includes("\0")) throw new Error("bad")
  } catch {
    throw new Error("succeeded data.children entry directory invalid")
  }
  if (typeof rec.title !== "string") throw new Error("succeeded data.children entry title must be string")
  if (typeof rec.slug !== "string") throw new Error("succeeded data.children entry slug must be string")
  if (!isNonEmptyString(rec.projectID))
    throw new Error("succeeded data.children entry projectID must be non-empty string")
  if (typeof rec.version !== "string") throw new Error("succeeded data.children entry version must be string")
  validateChildrenTime(rec.time)
  if (rec.workspaceID !== undefined && !isWorkspaceId(rec.workspaceID))
    throw new Error("succeeded data.children entry workspaceID invalid")
  if (
    rec.path !== undefined &&
    (typeof rec.path !== "string" || (rec.path as string).includes("\0"))
  )
    throw new Error("succeeded data.children entry path invalid")
  if (rec.summary !== undefined) validateChildrenSummary(rec.summary)
  if (rec.cost !== undefined && !isFiniteNumber(rec.cost))
    throw new Error("succeeded data.children entry cost invalid")
  if (rec.tokens !== undefined) validateChildrenTokens(rec.tokens)
  if (rec.share !== undefined) validateChildrenShare(rec.share)
  if (rec.agent !== undefined && typeof rec.agent !== "string")
    throw new Error("succeeded data.children entry agent invalid")
  if (rec.model !== undefined) validateChildrenModel(rec.model)
  if (rec.metadata !== undefined && !isRecord(rec.metadata))
    throw new Error("succeeded data.children entry metadata invalid")
  if (rec.permission !== undefined) validateChildrenPermission(rec.permission)
  if (rec.revert !== undefined) validateChildrenRevert(rec.revert)
}

// eslint-disable-next-line complexity
export function validateChildrenResult(raw: unknown, req: ServePrivateChildrenRequest): ServePrivateChildrenResult {
  if (!isRecord(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== "session/children") throw new Error("op mismatch")
  if (raw.idempotencyKey !== req.idempotencyKey) throw new Error("idempotencyKey mismatch")
  const status = raw.status
  if (status !== "succeeded" && status !== "failed" && status !== "ambiguous")
    throw new Error("status must be succeeded/failed/ambiguous")
  if (typeof raw.accepted !== "boolean") throw new Error("accepted must be boolean")
  const outcome = raw.outcome
  if (!isRecord(outcome) || typeof outcome.type !== "string" || typeof outcome.time !== "number")
    throw new Error("outcome invalid")
  if (outcome.type !== status) throw new Error("outcome.type must match status")
  if (!Number.isFinite(outcome.time) || outcome.time < 0) throw new Error("outcome.time invalid")
  const rec = raw as Record<string, unknown>
  const outRec = outcome as Record<string, unknown>
  if (status === "succeeded") {
    assertAllowedKeys(rec, CHILDREN_RESULT_ROOT_SUCCEEDED, "result")
    assertAllowedKeys(outRec, CHILDREN_OUTCOME_SUCCEEDED_FIELDS, "outcome")
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    if (rec.transportUnknown !== undefined) throw new Error("succeeded must not have transportUnknown")
    if (rec.revision !== undefined) throw new Error("revision not accepted for children result")
    if (rec.configVersion !== undefined) throw new Error("configVersion not accepted for children result")
    if (rec.sessionRevision !== undefined) throw new Error("sessionRevision not accepted for children result")
    const data = rec.data
    if (!isRecord(data)) throw new Error("succeeded data must be object")
    const allowedData = new Set(["children"])
    for (const k of Object.keys(data as Record<string, unknown>))
      if (!allowedData.has(k)) throw new Error(`unexpected data field ${k}`)
    const drec = data as Record<string, unknown>
    if (!Array.isArray(drec.children)) throw new Error("succeeded data.children must be array")
    const seen = new Set<string>()
    for (const item of drec.children as unknown[]) {
      validateChildrenEntry(item, req.context.parentSessionId)
      const id = (item as Record<string, unknown>).id as string
      if (seen.has(id)) throw new Error("succeeded data.children duplicate id")
      seen.add(id)
    }
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (outRec.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    if (outRec.data !== undefined) throw new Error("succeeded outcome must not have data")
    return raw as unknown as ServePrivateChildrenResult
  }
  if (status === "failed") {
    assertAllowedKeys(rec, CHILDREN_RESULT_ROOT_FAILED, "result")
    assertAllowedKeys(outRec, CHILDREN_OUTCOME_FAILED_FIELDS, "outcome")
    if (raw.accepted !== false) throw new Error("failed accepted must be false")
    if (rec.transportUnknown !== undefined) throw new Error("failed must not have transportUnknown")
    if (rec.revision !== undefined) throw new Error("revision not accepted for children result")
    if (rec.configVersion !== undefined) throw new Error("configVersion not accepted for children result")
    if (rec.sessionRevision !== undefined) throw new Error("sessionRevision not accepted for children result")
    const failure = validateChildrenFailureShape(rec.failure, "failed failure")
    const outFailure = validateChildrenFailureShape(outRec.failure, "failed outcome.failure")
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    assertFailureDetailMirror(failure, outFailure)
    if (rec.data !== undefined) throw new Error("failed must not have data")
    if (outRec.data !== undefined) throw new Error("failed outcome must not have data")
    return raw as unknown as ServePrivateChildrenResult
  }
  assertAllowedKeys(rec, CHILDREN_RESULT_ROOT_AMBIGUOUS, "result")
  assertAllowedKeys(outRec, CHILDREN_OUTCOME_AMBIGUOUS_FIELDS, "outcome")
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.revision !== undefined) throw new Error("revision not accepted for children result")
  if (rec.configVersion !== undefined) throw new Error("configVersion not accepted for children result")
  if (rec.sessionRevision !== undefined) throw new Error("sessionRevision not accepted for children result")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (outRec.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  if (outRec.data !== undefined) throw new Error("ambiguous outcome must not have data")
  return raw as unknown as ServePrivateChildrenResult
}

function sdkChildrenOf(sdk: { data?: unknown }): unknown[] | null {
  if (!Array.isArray(sdk.data)) return null
  return sdk.data as unknown[]
}

function childIdOf(item: unknown): string | null {
  if (!isRecord(item)) return null
  const id = (item as Record<string, unknown>).id
  return typeof id === "string" && id.length > 0 ? id : null
}

function childDirOf(item: unknown): string | null {
  if (!isRecord(item)) return null
  const dir = (item as Record<string, unknown>).directory
  return typeof dir === "string" && dir.length > 0 ? dir : null
}

function deepChildrenEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!deepChildrenEqual(a[i], b[i])) return false
    return true
  }
  if (isRecord(a) && isRecord(b)) {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    if (ka.length !== kb.length) return false
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false
      if (!deepChildrenEqual(a[k], (b as Record<string, unknown>)[k])) return false
    }
    return true
  }
  return false
}

// eslint-disable-next-line complexity
export function compareChildrenParity(
  priv: ServePrivateChildrenResult,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  parentSessionId: string,
): { divergence: string | null; details: Record<string, unknown> } {
  const privStatus: string = priv.status
  const isTransportUnknown = !!(priv as Record<string, unknown>).transportUnknown
  if (isTransportUnknown) {
    return { divergence: "transport-unknown", details: { privStatus, transportUnknown: true } }
  }
  const sdkError = sdk.error !== undefined && sdk.error !== null
  const sdkStatus: string = sdkError ? "failed" : "succeeded"
  if (privStatus === "ambiguous" && sdkStatus === "failed") {
    const http = sdkHttpStatus(sdk)
    if (http === 409) {
      return { divergence: null, details: { sdkStatus, privStatus, http } }
    }
    return {
      divergence: `status-mismatch:sdk=failed(${String(http ?? "unknown")}) priv=ambiguous`,
      details: { sdkStatus, privStatus, http },
    }
  }
  if (privStatus === "ambiguous" && sdkStatus === "succeeded") {
    return { divergence: `status-mismatch:sdk=succeeded priv=ambiguous`, details: { sdkStatus, privStatus } }
  }
  if (sdkStatus !== privStatus) {
    return { divergence: `status-mismatch:sdk=${sdkStatus} priv=${privStatus}`, details: { sdkStatus, privStatus } }
  }
  if (sdkStatus === "succeeded" && privStatus === "succeeded") {
    const sdkItems = sdkChildrenOf(sdk)
    const pdata = (priv as Extract<ServePrivateChildrenResult, { status: "succeeded" }>).data
    const privItems = (pdata as { children: unknown[] }).children ?? []
    // Safe metadata only: counts. Full payloads were compared in memory
    // (stable fields below plus deep equality) but ids, directories, titles,
    // and payloads never leave this function.
    const sdkCount = sdkItems ? sdkItems.length : -1
    const privCount = Array.isArray(privItems) ? privItems.length : -1
    if (sdkItems === null) {
      return { divergence: `observation-divergence:sdk-shape`, details: { sdkCount, privCount } }
    }
    // Unordered keyed-by-id collection: no ordering contract. Concurrent
    // create/fork/list changes shift membership; that is warn-only
    // observation divergence, never a parity failure.
    const sdkById = new Map<string, unknown>()
    for (const item of sdkItems) {
      const id = childIdOf(item)
      if (id === null) return { divergence: `observation-divergence:sdk-shape`, details: { sdkCount, privCount } }
      if (sdkById.has(id))
        return { divergence: `observation-divergence:sdk-duplicate-id`, details: { sdkCount, privCount } }
      sdkById.set(id, item)
    }
    const privById = new Map<string, unknown>()
    for (const item of privItems as unknown[]) {
      const id = childIdOf(item)
      if (id === null) return { divergence: `observation-divergence:priv-shape`, details: { sdkCount, privCount } }
      if (privById.has(id))
        return { divergence: `observation-divergence:priv-duplicate-id`, details: { sdkCount, privCount } }
      privById.set(id, item)
    }
    if (sdkById.size !== privById.size) {
      return { divergence: `observation-divergence:count-mismatch`, details: { sdkCount, privCount } }
    }
    for (const id of sdkById.keys()) {
      if (!privById.has(id)) {
        return { divergence: `observation-divergence:membership-mismatch`, details: { sdkCount, privCount } }
      }
    }
    // Stable relationship fields per child, keyed by id. Child entries
    // retain their own canonical directories and may differ from the parent
    // directory; only SDK/private agreement per child is compared.
    for (const [id, sdkItem] of sdkById) {
      const privItem = privById.get(id)
      const sdkRec = (isRecord(sdkItem) ? sdkItem : {}) as Record<string, unknown>
      const privRec = (isRecord(privItem) ? privItem : {}) as Record<string, unknown>
      if (String(sdkRec.parentID ?? "") !== String(privRec.parentID ?? "")) {
        return { divergence: `observation-divergence:parent-mismatch`, details: { sdkCount, privCount } }
      }
      if (String(privRec.parentID ?? "") !== parentSessionId) {
        return { divergence: `observation-divergence:parent-mismatch`, details: { sdkCount, privCount } }
      }
      const sdkDir = childDirOf(sdkItem)
      const privDir = childDirOf(privItem)
      if (sdkDir === null || privDir === null) {
        return { divergence: `observation-divergence:directory-mismatch`, details: { sdkCount, privCount } }
      }
      let sdkCanon = sdkDir
      let privCanon = privDir
      try {
        sdkCanon = canonicalDir(sdkDir)
      } catch {
        return { divergence: `observation-divergence:directory-mismatch`, details: { sdkCount, privCount } }
      }
      try {
        privCanon = canonicalDir(privDir)
      } catch {
        return { divergence: `observation-divergence:directory-mismatch`, details: { sdkCount, privCount } }
      }
      if (sdkCanon !== privCanon) {
        return { divergence: `observation-divergence:directory-mismatch`, details: { sdkCount, privCount } }
      }
      if (String(sdkRec.title ?? "") !== String(privRec.title ?? "")) {
        return { divergence: `observation-divergence:title-mismatch`, details: { sdkCount, privCount } }
      }
    }
    // Complete-payload comparison in memory keyed by id: same stable fields
    // can still hide material divergence. Compared fully here; only a fixed
    // summary category leaves this function.
    for (const [id, sdkItem] of sdkById) {
      if (!deepChildrenEqual(sdkItem, privById.get(id))) {
        return { divergence: `observation-divergence:content-mismatch`, details: { sdkCount, privCount } }
      }
    }
    return { divergence: null, details: { sdkCount, privCount } }
  }
  if (sdkStatus === "failed" && privStatus === "failed") {
    const privCode: string = ((priv as Extract<ServePrivateChildrenResult, { status: "failed" }>).failure?.code ??
      "unknown") as string
    const http = sdkHttpStatus(sdk)
    const cls = sdkStatusClass(http)
    const allowed = (() => {
      if (cls === "400") return new Set(["validation.failed", "scope_mismatch"])
      if (cls === "404") return new Set(["session.not_found"])
      if (cls === "409") return new Set(["stale", "conflict", "InstanceUnavailableDuringConfigRebuild"])
      if (cls === "500") return new Set(["internal"])
      return null
    })()
    if (allowed) {
      if (!allowed.has(privCode)) {
        return {
          divergence: `failure-class-mismatch`,
          details: { sdkClass: cls, http },
        }
      }
      return { divergence: null, details: { sdkClass: cls } }
    }
    const sdkCodeRaw: string | undefined = (() => {
      const e = sdk.error as Record<string, unknown>
      const c = e.code ?? e.status ?? e._tag
      if (typeof c === "string" && c.length > 0 && !/^\d+$/.test(c)) return c
      return undefined
    })()
    if (sdkCodeRaw && privCode !== sdkCodeRaw) {
      return {
        divergence: `failure-code-mismatch`,
        details: { sdkCodePresent: true },
      }
    }
    return { divergence: null, details: {} }
  }
  return { divergence: null, details: {} }
}
