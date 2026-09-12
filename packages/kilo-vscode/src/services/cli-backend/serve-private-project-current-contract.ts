// `project/current` vcs-only narrow projection private carrier contract
// (Active, private-first `hasGit` only). Strict v1 envelope helpers plus the
// locked narrow vcs projection. The private path never transmits
// path-bearing or out-of-scope project fields: success data is
// `{vcs?: "git"}` only (`vcs === "git"` or absent). Any other `vcs` value or
// extra field is rejected as invalid wire and maps to redacted `internal` on
// the carrier. Only the derived `hasGit` boolean (`vcs === "git"`,
// fail-closed `false`) is consumed private-first via
// `kilo-provider/project-current-privatefirst.ts` with exactly-one
// same-directory SDK fallback; full `Project.Info` stays SDK-only and is
// never a private contract. Covers the `project/git-status` `hasGit`
// consumer only. Out of scope are `initGit`/`update`/`directories`/`list`,
// full `Project.Info` shape, `worktree`/`sandboxes`/`id`/`name`/`icon`/
// `commands`/`time`, and any transport/wiring/cache.
//
// Source facts (read-only evidence, not imported):
// - Route: `GET /project/current` with `directory?`, `workspace?` in
//   `packages/opencode/src/server/routes/instance/httpapi/groups/project.ts`
//   (`identifier: "project.current"`, success `Project.Info`).
// - Handler: `packages/opencode/src/server/routes/instance/httpapi/handlers/project.ts`
//   `current` returns `(yield* InstanceState.context).project` (single source,
//   read-only, no mutation).
// - Shape: `packages/opencode/src/project/project.ts` `ProjectVcs =
//   Schema.Literal("git")`, `Info = {id, worktree, vcs?, name?, icon?,
//   commands?, time, sandboxes[]}`; OpenAPI `Project` optional `vcs` enum
//   `["git"]`; SDK v2 `Project {id, worktree, vcs?: "git", ...}`.
// - Carrier: `packages/opencode/src/kilocode/server/fd-carrier.ts`
//   `project/current` reads `ctx.project.vcs` through the existing
//   `acquireDrainControl(directory)` + `InstanceRef` lane.
// - SDK: v2 `client.project.current({directory?, workspace?})` issues
//   `GET /project/current`.
// - Consumer: `packages/kilo-vscode/src/kilo-provider/git-status.ts`
//   `hasGit(client, directory)` = `client.project.current({directory}).then(r
//   => r.data?.vcs === "git").catch(() => false)`, called once during
//   `initializeConnection` with `getWorkspaceDirectory()` and cached to
//   `cachedGitRepo`.
//
// EXPLICIT UNKNOWNS (no inference without evidence):
// - Freshness: staleness/invalidation of `project.vcs` after config writes,
//   reloads, or convergence rebuilds is UNKNOWN; parity never claims freshness.
// - Ordering: not applicable (single value).
// - `directory`/`workspace` in the request context are ROUTING-ONLY labels.
//   Scope checks guard request-routing identity only. The payload is the
//   current directory instance snapshot read through the target directory's
//   `InstanceRef` lane (no global cache, no cross-directory aggregation).

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

export function canonicalProjectCurrentOpId(token: string): string {
  if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
  if (token.includes(":")) throw new TypeError("token must not contain ':'")
  return `project-current:${token}`
}

export function parseProjectCurrentOpId(opId: string): { token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  const segs = opId.split(":")
  if (segs.length !== 2) throw new TypeError(`project-current opId must have 1 segment: ${opId}`)
  if (segs[0] !== "project-current") throw new TypeError(`opId kind must be project-current: ${opId}`)
  const token = segs[1]!
  if (token.length === 0) throw new TypeError(`opId segment must be non-empty: ${opId}`)
  return { token }
}

export interface ProjectCurrentContractRequest {
  v: 1
  requestId: string
  opId: string
  op: "project/current"
  idempotencyKey: string
  context: {
    directory: string
    workspace?: string
  }
  payload: Record<string, never>
}

function containsProjectCurrentPathMaterial(v: string): boolean {
  return v.includes("/") || v.includes("\\") || v.includes("\0")
}

function assertNoProjectCurrentPathMaterial(v: string, label: string): void {
  if (containsProjectCurrentPathMaterial(v)) throw new Error(`${label} must not carry path material`)
}

// eslint-disable-next-line complexity
export function validateProjectCurrentContractRequest(raw: unknown): ProjectCurrentContractRequest {
  if (!isRecord(raw)) throw new Error("request must be object")
  if (raw.v !== 1) throw new Error("v must be 1")
  if (!isNonEmpty(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmpty(raw.opId)) throw new Error("opId must be non-empty string")
  assertNoProjectCurrentPathMaterial(raw.requestId as string, "requestId")
  assertNoProjectCurrentPathMaterial(raw.opId as string, "opId")
  if (raw.op !== "project/current") throw new Error("op must be project/current")
  if (!isNonEmpty(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  assertNoProjectCurrentPathMaterial(raw.idempotencyKey as string, "idempotencyKey")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId for project-current contract")
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
  if (Object.keys(payload as Record<string, unknown>).length !== 0)
    throw new Error("payload must be empty object for project-current contract")
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw as Record<string, unknown>))
    if (!allowedRoot.has(k)) throw new Error(`unexpected field ${k}`)
  parseProjectCurrentOpId(raw.opId as string)
  const idem = parseProjectCurrentOpId(raw.idempotencyKey as string)
  if (idem.token !== parseProjectCurrentOpId(raw.opId as string).token)
    throw new Error("idempotencyKey token must equal opId token")
  assertNoProjectCurrentPathMaterial(idem.token, "opId token")
  assertNoProjectCurrentPathMaterial(parseProjectCurrentOpId(raw.opId as string).token, "opId token")
  return raw as unknown as ProjectCurrentContractRequest
}

export type ProjectCurrentScopeWhich = "directory" | "workspace" | "request"

export type ProjectCurrentScopeCheck =
  | { ok: true }
  | { ok: false; code: "scope_mismatch"; which: ProjectCurrentScopeWhich }

export function checkProjectCurrentScope(
  req: ProjectCurrentContractRequest,
  expected: { directory: string; workspace?: string; token: string },
): ProjectCurrentScopeCheck {
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
  const parsed = parseProjectCurrentOpId(req.opId)
  if (parsed.token !== expected.token) return { ok: false, code: "scope_mismatch", which: "request" }
  const bound = canonicalProjectCurrentOpId(expected.token)
  if (req.opId !== bound || req.idempotencyKey !== bound) return { ok: false, code: "scope_mismatch", which: "request" }
  return { ok: true }
}

// Locked narrow vcs projection: `{vcs?: "git"}` only. `vcs === "git"` or
// absent are the sole accepted shapes. Path-bearing and out-of-scope fields
// (`worktree`, `sandboxes`, `id`, `name`, `icon`, `commands`, `time`) are
// never accepted here by design.
export interface ProjectCurrentPayload {
  vcs?: "git"
}

const PROJECT_CURRENT_PAYLOAD_FIELDS = new Set(["vcs"])

export function validateProjectCurrentPayload(raw: unknown): ProjectCurrentPayload {
  if (!isRecord(raw)) throw new Error("project-current payload must be object")
  assertAllowedKeys(raw as Record<string, unknown>, PROJECT_CURRENT_PAYLOAD_FIELDS, "project-current")
  const rec = raw as Record<string, unknown>
  if (rec.vcs !== undefined && rec.vcs !== "git") throw new Error("project-current vcs must be git when present")
  return raw as unknown as ProjectCurrentPayload
}

export function projectCurrentHasGit(payload: ProjectCurrentPayload): boolean {
  return payload.vcs === "git"
}

export type ProjectCurrentResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: "project/current"
      idempotencyKey: string
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: ProjectCurrentPayload
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "project/current"
      idempotencyKey: string
      status: "failed"
      outcome: { type: "failed"; time: number; failure: ProjectCurrentFailure }
      accepted: boolean
      failure: ProjectCurrentFailure
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "project/current"
      idempotencyKey: string
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      transportUnknown?: boolean
    }

export function makeProjectCurrentAmbiguous(
  req: ProjectCurrentContractRequest,
  transportUnknown = true,
): ProjectCurrentResult {
  const out: ProjectCurrentResult = {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "project/current",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

// Redacted failure shape following `config/warnings` conventions
// ({code,message,retryable} only). Path-bearing and project echo keys are
// rejected so fixtures cannot carry host path or project content material.
//
// Finite failure taxonomy: only fixed categories and fixed messages cross
// the private wire. Arbitrary backend codes/text are rejected as invalid
// wire; local transport maps to `transport` with its fixed message and never
// copies host codes or raw error strings.
export const PROJECT_CURRENT_FAILURE_CODES = new Set([
  "validation.failed",
  "InstanceUnavailableDuringConfigRebuild",
  "internal",
  "transport",
] as const)
export type ProjectCurrentFailureCode =
  | "validation.failed"
  | "InstanceUnavailableDuringConfigRebuild"
  | "internal"
  | "transport"
export const PROJECT_CURRENT_TRANSPORT_FAILURE_CODE: ProjectCurrentFailureCode = "transport"
export const PROJECT_CURRENT_FAILURE_MESSAGES: Record<ProjectCurrentFailureCode, string> = {
  "validation.failed": "invalid project-current request",
  InstanceUnavailableDuringConfigRebuild:
    "Instance is unavailable during config rebuild; no active runtime for this request",
  internal: "internal error",
  transport: "private project-current transport failed",
}
export const PROJECT_CURRENT_FAILURE_RETRYABLE: Record<ProjectCurrentFailureCode, boolean> = {
  "validation.failed": false,
  InstanceUnavailableDuringConfigRebuild: true,
  internal: false,
  transport: false,
}
export interface ProjectCurrentFailure {
  code: string
  message: string
  retryable: boolean
}

export const PROJECT_CURRENT_FAILURE_FORBIDDEN = new Set([
  "session",
  "sessionId",
  "prompt",
  "tool",
  "error",
  "raw",
  "output",
  "detail",
  "path",
  "vcs",
  "worktree",
  "sandboxes",
  "project",
  "directory",
  "workspace",
])

const PROJECT_CURRENT_FAILURE_FIELDS = new Set(["code", "message", "retryable"])

export function validateProjectCurrentFailure(raw: unknown): ProjectCurrentFailure {
  if (!isRecord(raw)) throw new Error("failure must be object")
  for (const k of Object.keys(raw)) {
    if (PROJECT_CURRENT_FAILURE_FORBIDDEN.has(k)) throw new Error(`failure must not carry ${k}`)
  }
  assertAllowedKeys(raw as Record<string, unknown>, PROJECT_CURRENT_FAILURE_FIELDS, "failure")
  if (typeof raw.code !== "string" || !PROJECT_CURRENT_FAILURE_CODES.has(raw.code as ProjectCurrentFailureCode))
    throw new Error("failure code must be a known project-current category")
  const code = raw.code as ProjectCurrentFailureCode
  if (raw.message !== PROJECT_CURRENT_FAILURE_MESSAGES[code])
    throw new Error("failure message must be the fixed message for its code")
  if (raw.retryable !== PROJECT_CURRENT_FAILURE_RETRYABLE[code])
    throw new Error("failure retryable must match its code")
  return raw as unknown as ProjectCurrentFailure
}

export type ProjectCurrentWireOutcome =
  | { kind: "valid"; result: ProjectCurrentResult }
  | { kind: "invalid"; detail: string }

export class ProjectCurrentValidationError extends Error {
  readonly kind = "private-project-current-validation" as const
  readonly detail: string
  constructor(detail: string) {
    super(`invalid private response shape: ${detail}`)
    this.name = "ProjectCurrentValidationError"
    this.detail = detail
  }
}

export function isProjectCurrentValidationError(v: unknown): v is ProjectCurrentValidationError {
  return !!v && typeof v === "object" && (v as { kind?: unknown }).kind === "private-project-current-validation"
}

export function normalizePrivateProjectCurrentWire(
  raw: unknown,
  req: ProjectCurrentContractRequest,
): ProjectCurrentWireOutcome {
  try {
    const result = validateProjectCurrentResult(raw, req)
    return { kind: "valid", result }
  } catch (e) {
    const detail = String(e instanceof Error ? e.message : e).slice(0, 200)
    return { kind: "invalid", detail }
  }
}

const PROJECT_CURRENT_RESULT_SUCCEEDED = new Set([
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
const PROJECT_CURRENT_RESULT_FAILED = new Set([
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
const PROJECT_CURRENT_RESULT_AMBIGUOUS = new Set([
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
const PROJECT_CURRENT_OUTCOME_PLAIN = new Set(["type", "time"])
const PROJECT_CURRENT_OUTCOME_FAILED = new Set(["type", "time", "failure"])

// eslint-disable-next-line complexity
export function validateProjectCurrentResult(raw: unknown, req: ProjectCurrentContractRequest): ProjectCurrentResult {
  if (!isRecord(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== "project/current") throw new Error("op mismatch")
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
    assertAllowedKeys(rec, PROJECT_CURRENT_RESULT_SUCCEEDED, "result")
    assertAllowedKeys(outRec, PROJECT_CURRENT_OUTCOME_PLAIN, "outcome")
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    const data = rec.data
    if (!isRecord(data)) throw new Error("succeeded data must be object")
    const allowedData = new Set(["vcs"])
    for (const k of Object.keys(data as Record<string, unknown>))
      if (!allowedData.has(k)) throw new Error(`unexpected data field ${k}`)
    // Narrow vcs-only projection: `git` or absent only; path-bearing fields
    // are never accepted here by design.
    validateProjectCurrentPayload(data)
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (outRec.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as ProjectCurrentResult
  }
  if (status === "failed") {
    assertAllowedKeys(rec, PROJECT_CURRENT_RESULT_FAILED, "result")
    assertAllowedKeys(outRec, PROJECT_CURRENT_OUTCOME_FAILED, "outcome")
    if (raw.accepted !== false) throw new Error("failed accepted must be false")
    const failure = validateProjectCurrentFailure(rec.failure)
    const outFailure = validateProjectCurrentFailure(outRec.failure)
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    if (rec.data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as ProjectCurrentResult
  }
  assertAllowedKeys(rec, PROJECT_CURRENT_RESULT_AMBIGUOUS, "result")
  assertAllowedKeys(outRec, PROJECT_CURRENT_OUTCOME_PLAIN, "outcome")
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (outRec.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as ProjectCurrentResult
}

// Pure diagnostic only (never wired to production: private-first issues at
// most one private result plus at most one SDK result per read, so a
// comparator would need a third request to add signal): both sides compare
// as the derived `hasGit` boolean (`vcs === "git"`). Failed-vs-failed status
// agreement holds with no content comparison. Malformed SDK `vcs` values
// (neither `git` nor absent) are reported as
// `project-current-shape-mismatch`, never coerced. The request directory is
// never compared; the private payload is the current directory instance
// snapshot with no freshness claim. Details carry fixed booleans only.
export function compareProjectCurrentParity(
  priv: ProjectCurrentResult,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
): { divergence: string | null; details: Record<string, unknown> } {
  const base = { directorySnapshot: true, freshnessUnknown: true }
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
    const sdkRaw = (sdk.data ?? {}) as Record<string, unknown>
    const sdkVcs = sdkRaw.vcs
    if (sdkVcs !== undefined && sdkVcs !== "git") {
      return { divergence: "project-current-shape-mismatch", details: { ...base, mismatch: true } }
    }
    const sdkHasGit = sdkVcs === "git"
    const privData = (priv as Extract<ProjectCurrentResult, { status: "succeeded" }>).data
    const privHasGit = projectCurrentHasGit(privData)
    if (sdkHasGit !== privHasGit) {
      return { divergence: "project-current-hasgit-mismatch", details: { ...base, mismatch: true } }
    }
    return { divergence: null, details: { ...base, hasGit: privHasGit } }
  }
  return { divergence: null, details: { ...base } }
}
