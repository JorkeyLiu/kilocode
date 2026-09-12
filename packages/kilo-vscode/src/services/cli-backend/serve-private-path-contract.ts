// `path/get` private-first single-operation read.
// Strict v1 helpers for the private `path/get` capability: routing-only
// directory/workspace identity, empty payload, safe five-field Path
// projection, redacted failures, and a pure directory-field comparator for
// test evidence only (never a third request in production). `model-state`
// consumes only `Path.state`; `home`/`config` stay process-global and
// `worktree`/`directory` stay shape-only with no new isolation contract.
// Worktree derivation/freshness/transport remain explicit unknowns.
//
// Source facts (read-only evidence, not imported):
// - Route: `GET /path` with `WorkspaceRoutingQuery` (`directory?`,
//   `workspace?`) in
//   `packages/opencode/src/server/routes/instance/httpapi/groups/instance.ts`
//   (`identifier: "path.get"`, success `PathInfo`
//   `{home,state,config,worktree,directory}`, all strings).
// - Handler: `packages/opencode/src/server/routes/instance/httpapi/handlers/instance.ts`
//   `getPath` returns `Global.Path.home/state/config` (process-global closure)
//   plus `ctx.worktree`/`ctx.directory` (directory-routed `InstanceState`
//   context via `InstanceRef`/`capture()`, fed by `WorkspaceRouteContext`
//   directory selection: fork target, session directory, `?directory`,
//   `x-kilo-directory`, or `process.cwd()`).
// - Globals: `packages/core/src/global.ts` `Path` (`home` = `os.homedir()` /
//   `KILO_TEST_HOME`; `data`/`cache`/`config`/`state` XDG; `tmp` = os tmpdir).
//   Handler serves static `Global.Path.config`; the effective
//   `Flag.KILO_CONFIG_DIR ?? Path.config` value lives in `Global.make()`
//   service construction and is not the served `path.get` `config` value.
// - SDK: v2 `client.path.get({directory?, workspace?})` issues `GET /path`;
//   v2 generated `Path` type is exactly
//   `{home,state,config,worktree,directory}` (all strings). Stale v1
//   generated `Path` carries only `{state,config,worktree,directory}`
//   (no `home`) and is drifted; server `PathInfo`/OpenAPI is source of truth.
// - SDK/server shape check 2026-09-05: no drift between server `PathInfo`,
//   v2 generated `Path`, and OpenAPI `Path` (five required strings,
//   `additionalProperties: false`); v1 generated `Path` drift noted above
//   and not used as a shape claim.
// - Consumers: `packages/kilo-vscode/src/kilo-provider/model-state.ts:62`
//   reads only `data.state` (model.json location);
//   `packages/opencode/src/cli/cmd/tui/context/project.tsx` `sync()` calls
//   `path.get({workspace})` and reconciles the full five-field shape.
// - Exercise: `httpapi-exercise` asserts `body.directory === ctx.directory`
//   and `body.worktree === ctx.directory` under `x-kilo-directory` routing;
//   `sdk-v1-smoke` asserts `path.get` returns 200 with defined data.
//
// MIXED GLOBAL/DIRECTORY OWNERSHIP (explicit, honest v1):
// - `home`, `state`, `config` are PROCESS-GLOBAL (`Global.Path` closure, not
//   directory-keyed `InstanceState`). This contract never binds them to the
//   request directory, never asserts payload global equality, and never
//   compares them for directory isolation. Cross-directory equality of the
//   three globals is EXPECTED, not a divergence.
// - `worktree` and `directory` are DIRECTORY-DERIVED (request-routed
//   `InstanceContext`). `directory` is the canonical routing identity and is
//   scope-bound; `worktree` is carried shape-only.
// - No invented worktree semantics: `worktree` derivation (git top-level
//   resolution vs `"/"` non-git fallback, `canonicalRoot`) is UNRESOLVED here.
//   Validation asserts `worktree` is a non-empty string only and never asserts
//   `worktree === directory`. Parity compares the observed `worktree` value
//   exactly but always marks `worktreeDerivationUnknown: true` so equality is
//   never read as a derivation claim.
// - `directory`/`workspace` in the request context are ROUTING-ONLY labels.
//   Scope checks guard request-routing identity only; a scope match says
//   nothing about payload ownership.
// - Out of scope: `instance.dispose`, `instance.reload`, `vcs.*`, `command`,
//   `agent`, `skill`, `lsp`, `formatter`, and any freshness/caching claim.

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

function containsPathMaterialValue(v: string): boolean {
  return v.includes("/") || v.includes("\\") || v.includes("\0")
}

function assertAllowedKeys(rec: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const k of Object.keys(rec)) if (!allowed.has(k)) throw new Error(`unexpected ${label} field`)
}

export const PATH_GLOBAL_FIELDS = ["home", "state", "config"] as const
export type PathGlobalField = (typeof PATH_GLOBAL_FIELDS)[number]

export function isPathProcessGlobalField(v: unknown): v is PathGlobalField {
  return v === "home" || v === "state" || v === "config"
}

export const PATH_DIRECTORY_FIELDS = ["worktree", "directory"] as const
export type PathDirectoryField = (typeof PATH_DIRECTORY_FIELDS)[number]

export function isPathDirectoryField(v: unknown): v is PathDirectoryField {
  return v === "worktree" || v === "directory"
}

function pathTokenHasMaterial(token: string): boolean {
  return token.includes("/") || token.includes("\\") || token.includes("\0")
}

export function canonicalPathOpId(token: string): string {
  if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
  if (token.includes(":")) throw new TypeError("token must not contain ':'")
  if (pathTokenHasMaterial(token)) throw new TypeError("token must not contain path material")
  return `path:${token}`
}

export function parsePathOpId(opId: string): { token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  if (opId.includes("/") || opId.includes("\\") || opId.includes("\0"))
    throw new TypeError("opId must not contain path material")
  const segs = opId.split(":")
  if (segs.length !== 2) throw new TypeError("path opId must have 1 segment")
  if (segs[0] !== "path") throw new TypeError("opId kind must be path")
  const token = segs[1]!
  if (token.length === 0) throw new TypeError("opId segment must be non-empty")
  if (pathTokenHasMaterial(token)) throw new TypeError("opId token must not contain path material")
  return { token }
}

export interface PathContractRequest {
  v: 1
  requestId: string
  opId: string
  op: "path/get"
  idempotencyKey: string
  context: {
    directory: string
    workspace?: string
  }
  payload: Record<string, never>
}

// eslint-disable-next-line complexity
export function validatePathContractRequest(raw: unknown): PathContractRequest {
  if (!isRecord(raw)) throw new Error("request must be object")
  if (raw.v !== 1) throw new Error("v must be 1")
  if (!isNonEmpty(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmpty(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== "path/get") throw new Error("op must be path/get")
  if (!isNonEmpty(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId for path contract")
  if (typeof raw.requestId === "string" && ((raw.requestId as string).includes("/") || (raw.requestId as string).includes("\\") || (raw.requestId as string).includes("\0")))
    throw new Error("requestId must be non-empty string without path material")
  if (typeof raw.idempotencyKey === "string" && ((raw.idempotencyKey as string).includes("/") || (raw.idempotencyKey as string).includes("\\") || (raw.idempotencyKey as string).includes("\0")))
    throw new Error("idempotencyKey must be non-empty string without path material")
  const ctx = raw.context
  if (!isRecord(ctx)) throw new Error("context must be object")
  const allowedCtx = new Set(["directory", "workspace"])
  for (const k of Object.keys(ctx as Record<string, unknown>))
    if (!allowedCtx.has(k)) throw new Error("unexpected context field")
  if (typeof ctx.directory !== "string" || !isAbsolute(ctx.directory) || ctx.directory.includes("\0"))
    throw new Error("context.directory must be absolute path")
  if (ctx.workspace !== undefined) {
    if (!isNonEmpty(ctx.workspace) || (ctx.workspace as string).includes("\0"))
      throw new Error("context.workspace must be non-empty string when present")
  }
  const payload = raw.payload
  if (!isRecord(payload)) throw new Error("payload must be object")
  if (Object.keys(payload as Record<string, unknown>).length !== 0)
    throw new Error("payload must be empty object for path contract")
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw as Record<string, unknown>))
    if (!allowedRoot.has(k)) throw new Error("unexpected field")
  parsePathOpId(raw.opId as string)
  const idem = parsePathOpId(raw.idempotencyKey as string)
  if (idem.token !== parsePathOpId(raw.opId as string).token)
    throw new Error("idempotencyKey token must equal opId token")
  return raw as unknown as PathContractRequest
}

export type PathScopeWhich = "directory" | "workspace" | "request"

export type PathScopeCheck = { ok: true } | { ok: false; code: "scope_mismatch"; which: PathScopeWhich }

export function checkPathScope(
  req: PathContractRequest,
  expected: { directory: string; workspace?: string; token: string },
): PathScopeCheck {
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
  if ((wantWs === undefined) !== (gotWs === undefined))
    return { ok: false, code: "scope_mismatch", which: "workspace" }
  if (wantWs !== undefined && gotWs !== wantWs) return { ok: false, code: "scope_mismatch", which: "workspace" }
  const parsed = parsePathOpId(req.opId)
  if (parsed.token !== expected.token) return { ok: false, code: "scope_mismatch", which: "request" }
  const bound = canonicalPathOpId(expected.token)
  if (req.opId !== bound || req.idempotencyKey !== bound)
    return { ok: false, code: "scope_mismatch", which: "request" }
  return { ok: true }
}

// Honest v1 payload projection: exactly the five production `PathInfo` fields.
// All values are non-empty strings with no NUL bytes. No relation between
// `worktree` and `directory` is asserted here by design (worktree derivation
// is unresolved); the request directory is routing-only and says nothing
// about payload ownership.
export interface PathPayload {
  home: string
  state: string
  config: string
  worktree: string
  directory: string
}

const PATH_PAYLOAD_FIELDS = new Set(["home", "state", "config", "worktree", "directory"])

export function validatePathPayload(raw: unknown): PathPayload {
  if (!isRecord(raw)) throw new Error("path payload must be object")
  assertAllowedKeys(raw as Record<string, unknown>, PATH_PAYLOAD_FIELDS, "path")
  const rec = raw as Record<string, unknown>
  for (const field of PATH_PAYLOAD_FIELDS) {
    const val = rec[field]
    if (!isNonEmpty(val) || (val as string).includes("\0")) throw new Error("path field must be non-empty string")
  }
  return raw as unknown as PathPayload
}

export type PathResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: "path/get"
      idempotencyKey: string
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: { path: PathPayload }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "path/get"
      idempotencyKey: string
      status: "failed"
      outcome: { type: "failed"; time: number; failure: PathFailure }
      accepted: boolean
      failure: PathFailure
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "path/get"
      idempotencyKey: string
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      transportUnknown?: boolean
    }

export function makePathAmbiguous(req: PathContractRequest, transportUnknown = true): PathResult {
  const out: PathResult = {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "path/get",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

// Redacted failure shape following `remote.status` / `experimental/session/list`
// conventions ({code,message,retryable} only). Raw path/session/directory echo
// keys are rejected so fixtures cannot carry host path material.
export interface PathFailure {
  code: string
  message: string
  retryable: boolean
}

const PATH_FAILURE_FORBIDDEN = new Set([
  "session",
  "sessionId",
  "prompt",
  "tool",
  "error",
  "raw",
  "output",
  "detail",
  "home",
  "state",
  "config",
  "worktree",
  "directory",
  "workspace",
  "path",
])

const PATH_FAILURE_FIELDS = new Set(["code", "message", "retryable"])

export const PATH_FAILED_CODE = "path.failed"
export const PATH_FAILED_MESSAGE = "private path failed"

export function validatePathFailure(raw: unknown): PathFailure {
  if (!isRecord(raw)) throw new Error("failure must be object")
  for (const k of Object.keys(raw)) {
    if (PATH_FAILURE_FORBIDDEN.has(k)) throw new Error("failure must not carry raw field")
  }
  assertAllowedKeys(raw as Record<string, unknown>, PATH_FAILURE_FIELDS, "failure")
  if (!isNonEmpty(raw.code)) throw new Error("failure code must be non-empty string")
  if (!isNonEmpty(raw.message)) throw new Error("failure message must be non-empty string")
  if (typeof raw.retryable !== "boolean") throw new Error("failure retryable must be boolean")
  if (containsPathMaterialValue(raw.code as string) || containsPathMaterialValue(raw.message as string))
    throw new Error("failure must not carry path material")
  return raw as unknown as PathFailure
}

export type PathWireOutcome = { kind: "valid"; result: PathResult } | { kind: "invalid"; detail: string }

export const PATH_INVALID_DETAIL = "invalid private response shape"

export class PathValidationError extends Error {
  readonly kind = "private-path-validation" as const
  readonly detail: string
  constructor(_detail: string) {
    super(PATH_INVALID_DETAIL)
    this.name = "PathValidationError"
    this.detail = PATH_INVALID_DETAIL
  }
}

export function isPathValidationError(v: unknown): v is PathValidationError {
  return !!v && typeof v === "object" && (v as { kind?: unknown }).kind === "private-path-validation"
}

export function normalizePrivatePathWire(raw: unknown, req: PathContractRequest): PathWireOutcome {
  try {
    const result = validatePathResult(raw, req)
    if (result.status === "failed") {
      const retryable = result.failure.retryable
      const fixed = { code: PATH_FAILED_CODE, message: PATH_FAILED_MESSAGE, retryable }
      const redacted: PathResult = {
        ...result,
        failure: fixed,
        outcome: { ...result.outcome, failure: fixed },
      }
      return { kind: "valid", result: redacted }
    }
    return { kind: "valid", result }
  } catch {
    return { kind: "invalid", detail: PATH_INVALID_DETAIL }
  }
}

const PATH_RESULT_SUCCEEDED = new Set([
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
const PATH_RESULT_FAILED = new Set([
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
const PATH_RESULT_AMBIGUOUS = new Set([
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
const PATH_OUTCOME_PLAIN = new Set(["type", "time"])
const PATH_OUTCOME_FAILED = new Set(["type", "time", "failure"])

// eslint-disable-next-line complexity
export function validatePathResult(raw: unknown, req: PathContractRequest): PathResult {
  if (!isRecord(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== "path/get") throw new Error("op mismatch")
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
    assertAllowedKeys(rec, PATH_RESULT_SUCCEEDED, "result")
    assertAllowedKeys(outRec, PATH_OUTCOME_PLAIN, "outcome")
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    const data = rec.data
    if (!isRecord(data)) throw new Error("succeeded data must be object")
    const allowedData = new Set(["path"])
    for (const k of Object.keys(data as Record<string, unknown>))
      if (!allowedData.has(k)) throw new Error("unexpected data field")
    // Full five-field projection validated for shape only. No directory
    // binding is asserted here by design: globals stay process-global and the
    // request directory is routing-only.
    validatePathPayload((data as Record<string, unknown>).path)
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (outRec.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as PathResult
  }
  if (status === "failed") {
    assertAllowedKeys(rec, PATH_RESULT_FAILED, "result")
    assertAllowedKeys(outRec, PATH_OUTCOME_FAILED, "outcome")
    const failure = validatePathFailure(rec.failure)
    const outFailure = validatePathFailure(outRec.failure)
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    if (rec.data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as PathResult
  }
  assertAllowedKeys(rec, PATH_RESULT_AMBIGUOUS, "result")
  assertAllowedKeys(outRec, PATH_OUTCOME_PLAIN, "outcome")
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (outRec.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as PathResult
}

// Detached parity only (contract evidence, never production parity):
// compares ONLY the two directory-derived fields (`worktree`, `directory`)
// exactly. The three process-global fields (`home`, `state`, `config`) are
// explicitly excluded: they are never read and never compared, so global
// differences across processes can never surface as divergence.
// `worktreeDerivationUnknown: true` plus `globalExcluded: true` in the details
// mark those explicit exclusions so no reader mistakes parity for a worktree
// derivation claim or for directory isolation of globals. The request
// directory is never compared; only observed payload values are.
export function comparePathParity(
  priv: PathResult,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
): { divergence: string | null; details: Record<string, unknown> } {
  const base = { worktreeDerivationUnknown: true, globalExcluded: true }
  const privStatus: string = priv.status
  if (!!(priv as Record<string, unknown>).transportUnknown) {
    return { divergence: "transport-unknown", details: { privStatus, transportUnknown: true, ...base } }
  }
  const sdkError = sdk.error !== undefined && sdk.error !== null
  const sdkStatus: string = sdkError ? "failed" : "succeeded"
  if (sdkStatus !== privStatus) {
    return {
      divergence: `status-mismatch:sdk=${sdkStatus} priv=${privStatus}`,
      details: { sdkStatus, privStatus, ...base },
    }
  }
  if (sdkStatus === "succeeded" && privStatus === "succeeded") {
    const sdkPayload = (sdk.data ?? {}) as Record<string, unknown>
    const pdata = (priv as Extract<PathResult, { status: "succeeded" }>).data as Record<string, unknown>
    const privPayload = (pdata.path ?? {}) as Record<string, unknown>
    if (typeof sdkPayload.worktree !== "string" || typeof sdkPayload.directory !== "string") {
      return { divergence: "path-shape-mismatch", details: { ...base, mismatch: true } }
    }
    if (sdkPayload.directory !== privPayload.directory) {
      return { divergence: "path-directory-mismatch", details: { ...base, mismatch: true, field: "directory" } }
    }
    if (sdkPayload.worktree !== privPayload.worktree) {
      return { divergence: "path-worktree-mismatch", details: { ...base, mismatch: true, field: "worktree" } }
    }
    return { divergence: null, details: { ...base } }
  }
  return { divergence: null, details: { ...base } }
}
