// `find/files` bounded-search private carrier contract (Active,
// private-first `handleFileSearch` only). Strict v1 envelope helpers plus the
// locked safe `{path,type}` projection. The safe list is consumed
// private-first via `kilo-provider/find-files-privatefirst.ts` with exactly
// one same-tuple SDK fallback per logical type; the SDK string array stays
// the fallback user-visible surface only.
//
// Source facts (read-only evidence, not imported):
// - Route: `GET /find/file` with `FindFileQuery`
//   (`query`, `dirs?` (`"true"|"false"`), `type?` (`"file"|"directory"`),
//   `limit?` (1..200), plus `WorkspaceRoutingQuery`) in
//   `packages/opencode/src/server/routes/instance/httpapi/groups/file.ts`
//   (`identifier: "find.files"`, success `Array(String)` file paths).
// - Handler: `packages/opencode/src/server/routes/instance/httpapi/handlers/file.ts`
//   `findFile` reads `InstanceState.context` directory, calls
//   `FileSystem.Service.find({query, limit ?? 10, type ?? (dirs === "false" ? "file" : undefined)})`,
//   and maps each item to `item.path` (string array).
// - Consumer: `packages/kilo-vscode/src/kilo-provider/file-search.ts`
//   calls `client.find.files({query, directory: dir, type: "file"|"directory", limit: 50})`
//   for files and folders separately.
// - Source constraint: existing ripgrep `.gitignore`/`.ignore` behavior remains
//   a source constraint. `.kilocodeignore` is not claimed or fabricated here.
//
// Locked safety model (contract-only, fail closed):
// - Search is workspace/session-directory bound via routing-only
//   `context.directory`/`workspace`; no arbitrary cross-directory scan is
//   represented.
// - Success data is only relative POSIX-normalized `{path,type}` entries with
//   explicit `file|directory` type; absolute paths, URIs, cwd/root echoes,
//   mime, contents, ignored flags, and raw filesystem metadata are rejected.
// - Request requires explicit `type: file|directory`; legacy `dirs` is rejected.
// - Query is non-empty, max 256 characters, and rejects NUL.
// - Limit, when present, is an integer 1..50. Success arrays are bounded to 50.
// - Sensitive-name filtering rejects `.env` and `.env.*` except `.env.example`,
//   private key/certificate extensions, and sensitive directory segments;
//   ordinary dotfiles such as `.github` and `.eslintrc` remain valid.
// - Failures are fixed and redacted: `{code,message,retryable}` only, with no
//   path, directory, workspace, query, absolute/URI, raw error, or result echo.

import { isAbsolute, normalize, resolve } from "path"

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function isNonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

function canonicalDir(dir: string): string {
  return normalize(resolve(dir))
}

function assertAllowedKeys(rec: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const k of Object.keys(rec)) if (!allowed.has(k)) throw new Error(`unexpected ${label} field ${k}`)
}

function containsPathMaterialValue(v: string): boolean {
  return v.includes("/") || v.includes("\\") || v.includes("\0")
}

export const FIND_FILES_QUERY_MAX = 256
export const FIND_FILES_LIMIT_MIN = 1
export const FIND_FILES_LIMIT_MAX = 50
export const FIND_FILES_RESULTS_MAX = 50

export function canonicalFindFilesOpId(token: string): string {
  if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
  if (token.includes(":")) throw new TypeError("token must not contain ':'")
  if (containsPathMaterialValue(token)) throw new TypeError("token must not contain path material")
  return `find-files:${token}`
}

export function parseFindFilesOpId(opId: string): { token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  if (containsPathMaterialValue(opId)) throw new TypeError("opId must not contain path material")
  const segs = opId.split(":")
  if (segs.length !== 2) throw new TypeError("find-files opId must have 1 segment")
  if (segs[0] !== "find-files") throw new TypeError("opId kind must be find-files")
  const token = segs[1]!
  if (token.length === 0) throw new TypeError("opId segment must be non-empty")
  if (containsPathMaterialValue(token)) throw new TypeError("opId token must not contain path material")
  return { token }
}

export interface FindFilesContractRequest {
  v: 1
  requestId: string
  opId: string
  op: "find/files"
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

// eslint-disable-next-line complexity
export function validateFindFilesContractRequest(raw: unknown): FindFilesContractRequest {
  if (!isRecord(raw)) throw new Error("request must be object")
  if (raw.v !== 1) throw new Error("v must be 1")
  if (!isNonEmpty(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmpty(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== "find/files") throw new Error("op must be find/files")
  if (!isNonEmpty(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId for find-files contract")
  if (containsPathMaterialValue(raw.requestId as string)) throw new Error("requestId must not contain path material")
  if (containsPathMaterialValue(raw.idempotencyKey as string))
    throw new Error("idempotencyKey must not contain path material")
  const ctx = raw.context
  if (!isRecord(ctx)) throw new Error("context must be object")
  const allowedCtx = new Set(["directory", "workspace"])
  for (const k of Object.keys(ctx as Record<string, unknown>))
    if (!allowedCtx.has(k)) throw new Error(`unexpected context field ${k}`)
  if (typeof ctx.directory !== "string" || !isAbsolute(ctx.directory) || ctx.directory.includes("\0"))
    throw new Error("context.directory must be absolute path")
  if (ctx.workspace !== undefined) {
    if (!isNonEmpty(ctx.workspace) || (ctx.workspace as string).includes("\0"))
      throw new Error("context.workspace must be non-empty string when present")
  }
  const payload = raw.payload
  if (!isRecord(payload)) throw new Error("payload must be object")
  const allowedPayload = new Set(["query", "type", "limit"])
  for (const k of Object.keys(payload as Record<string, unknown>))
    if (!allowedPayload.has(k)) throw new Error(`unexpected payload field ${k}`)
  const rec = payload as Record<string, unknown>
  if (typeof rec.query !== "string" || rec.query.length === 0) throw new Error("payload.query must be non-empty string")
  if (rec.query.length > FIND_FILES_QUERY_MAX) throw new Error("payload.query must be at most 256 characters")
  if ((rec.query as string).includes("\0")) throw new Error("payload.query must not contain NUL")
  if (rec.type !== "file" && rec.type !== "directory") throw new Error("payload.type must be file or directory")
  if (rec.limit !== undefined) {
    if (typeof rec.limit !== "number" || !Number.isInteger(rec.limit)) throw new Error("payload.limit must be integer")
    if (rec.limit < FIND_FILES_LIMIT_MIN || rec.limit > FIND_FILES_LIMIT_MAX)
      throw new Error("payload.limit must be 1..50")
  }
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw as Record<string, unknown>))
    if (!allowedRoot.has(k)) throw new Error(`unexpected field ${k}`)
  parseFindFilesOpId(raw.opId as string)
  const idem = parseFindFilesOpId(raw.idempotencyKey as string)
  if (idem.token !== parseFindFilesOpId(raw.opId as string).token)
    throw new Error("idempotencyKey token must equal opId token")
  return raw as unknown as FindFilesContractRequest
}

export type FindFilesScopeWhich = "directory" | "workspace" | "request"

export type FindFilesScopeCheck = { ok: true } | { ok: false; code: "scope_mismatch"; which: FindFilesScopeWhich }

export function checkFindFilesScope(
  req: FindFilesContractRequest,
  expected: { directory: string; workspace?: string; token: string },
): FindFilesScopeCheck {
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
  const parsed = parseFindFilesOpId(req.opId)
  if (parsed.token !== expected.token) return { ok: false, code: "scope_mismatch", which: "request" }
  const bound = canonicalFindFilesOpId(expected.token)
  if (req.opId !== bound || req.idempotencyKey !== bound) return { ok: false, code: "scope_mismatch", which: "request" }
  return { ok: true }
}

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

export interface FindFilesEntry {
  path: string
  type: "file" | "directory"
}

const FIND_FILES_ENTRY_FIELDS = new Set(["path", "type"])

export function validateFindFilesEntry(raw: unknown): FindFilesEntry {
  if (!isRecord(raw)) throw new Error("find-files entry must be object")
  assertAllowedKeys(raw as Record<string, unknown>, FIND_FILES_ENTRY_FIELDS, "find-files-entry")
  validateFindFilesRelPath((raw as Record<string, unknown>).path)
  const type = (raw as Record<string, unknown>).type
  if (type !== "file" && type !== "directory") throw new Error("find-files-entry.type must be file or directory")
  return raw as unknown as FindFilesEntry
}

export function validateFindFilesEntries(raw: unknown): FindFilesEntry[] {
  if (!Array.isArray(raw)) throw new Error("files must be array")
  if (raw.length > FIND_FILES_RESULTS_MAX) throw new Error("files must be bounded to 50")
  return (raw as unknown[]).map((item) => validateFindFilesEntry(item))
}

export interface FindFilesFailure {
  code: string
  message: string
  retryable: boolean
}

const FIND_FILES_FAILURE_FORBIDDEN = new Set([
  "session",
  "sessionId",
  "prompt",
  "tool",
  "error",
  "raw",
  "output",
  "detail",
  "path",
  "paths",
  "directory",
  "workspace",
  "query",
  "absolute",
  "uri",
  "cwd",
  "root",
  "mime",
  "contents",
  "content",
  "ignored",
  "files",
  "results",
  "result",
  "data",
  "type",
  "limit",
  "dirs",
])

const FIND_FILES_FAILURE_FIELDS = new Set(["code", "message", "retryable"])

export function validateFindFilesFailure(raw: unknown): FindFilesFailure {
  if (!isRecord(raw)) throw new Error("failure must be object")
  for (const k of Object.keys(raw)) {
    if (FIND_FILES_FAILURE_FORBIDDEN.has(k)) throw new Error(`failure must not carry ${k}`)
  }
  assertAllowedKeys(raw as Record<string, unknown>, FIND_FILES_FAILURE_FIELDS, "failure")
  if (!isNonEmpty(raw.code)) throw new Error("failure code must be non-empty string")
  if (!isNonEmpty(raw.message)) throw new Error("failure message must be non-empty string")
  if (typeof raw.retryable !== "boolean") throw new Error("failure retryable must be boolean")
  if (containsPathMaterialValue(raw.code as string) || containsPathMaterialValue(raw.message as string))
    throw new Error("failure must not carry path material")
  return raw as unknown as FindFilesFailure
}

export type FindFilesResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: "find/files"
      idempotencyKey: string
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: { files: FindFilesEntry[] }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "find/files"
      idempotencyKey: string
      status: "failed"
      outcome: { type: "failed"; time: number; failure: FindFilesFailure }
      accepted: false
      failure: FindFilesFailure
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "find/files"
      idempotencyKey: string
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      transportUnknown?: boolean
    }

export function makeFindFilesAmbiguous(req: FindFilesContractRequest, transportUnknown = true): FindFilesResult {
  const out: FindFilesResult = {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "find/files",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

export type FindFilesWireOutcome = { kind: "valid"; result: FindFilesResult } | { kind: "invalid"; detail: string }

export const FIND_FILES_INVALID_DETAIL = "invalid private response shape"
export const FIND_FILES_FAILED_CODE = "find.failed"
export const FIND_FILES_FAILED_MESSAGE = "private find failed"

export class FindFilesValidationError extends Error {
  readonly kind = "private-find-files-validation" as const
  readonly detail: string
  constructor(_detail: string) {
    super(FIND_FILES_INVALID_DETAIL)
    this.name = "FindFilesValidationError"
    this.detail = FIND_FILES_INVALID_DETAIL
  }
}

export function isFindFilesValidationError(v: unknown): v is FindFilesValidationError {
  return !!v && typeof v === "object" && (v as { kind?: unknown }).kind === "private-find-files-validation"
}

export function normalizePrivateFindFilesWire(raw: unknown, req: FindFilesContractRequest): FindFilesWireOutcome {
  try {
    const result = validateFindFilesResult(raw, req)
    if (result.status === "failed") {
      const retryable = result.failure.retryable
      const fixed = { code: FIND_FILES_FAILED_CODE, message: FIND_FILES_FAILED_MESSAGE, retryable }
      const redacted: FindFilesResult = {
        ...result,
        failure: fixed,
        outcome: { ...result.outcome, failure: fixed },
      }
      return { kind: "valid", result: redacted }
    }
    return { kind: "valid", result }
  } catch {
    return { kind: "invalid", detail: FIND_FILES_INVALID_DETAIL }
  }
}

const FIND_FILES_RESULT_SUCCEEDED = new Set([
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
const FIND_FILES_RESULT_FAILED = new Set([
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
const FIND_FILES_RESULT_AMBIGUOUS = new Set([
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
const FIND_FILES_OUTCOME_PLAIN = new Set(["type", "time"])
const FIND_FILES_OUTCOME_FAILED = new Set(["type", "time", "failure"])

// eslint-disable-next-line complexity
export function validateFindFilesResult(raw: unknown, req: FindFilesContractRequest): FindFilesResult {
  if (!isRecord(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== "find/files") throw new Error("op mismatch")
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
    assertAllowedKeys(rec, FIND_FILES_RESULT_SUCCEEDED, "result")
    assertAllowedKeys(outRec, FIND_FILES_OUTCOME_PLAIN, "outcome")
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    const data = rec.data
    if (!isRecord(data)) throw new Error("succeeded data must be object")
    const allowedData = new Set(["files"])
    for (const k of Object.keys(data as Record<string, unknown>))
      if (!allowedData.has(k)) throw new Error(`unexpected data field ${k}`)
    validateFindFilesEntries((data as Record<string, unknown>).files)
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (outRec.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as FindFilesResult
  }
  if (status === "failed") {
    assertAllowedKeys(rec, FIND_FILES_RESULT_FAILED, "result")
    assertAllowedKeys(outRec, FIND_FILES_OUTCOME_FAILED, "outcome")
    if (raw.accepted !== false) throw new Error("failed accepted must be false")
    const failure = validateFindFilesFailure(rec.failure)
    const outFailure = validateFindFilesFailure(outRec.failure)
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    if (rec.data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as FindFilesResult
  }
  assertAllowedKeys(rec, FIND_FILES_RESULT_AMBIGUOUS, "result")
  assertAllowedKeys(outRec, FIND_FILES_OUTCOME_PLAIN, "outcome")
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (outRec.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as FindFilesResult
}
