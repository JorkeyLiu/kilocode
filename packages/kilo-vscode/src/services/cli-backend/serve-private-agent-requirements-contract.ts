// Gate B deferred `kilocode.agentRequirements` read-only candidate contract evidence only.
// Pure contract helpers with no transport, no private capability, no dispatch,
// no runtime observation, no durable state, no guard/evaluator change,
// no production parity claim.
// `op:"agent/requirements"` below is a contract-evidence label only; it is
// never registered as a private capability and never sent over any peer.
// Production `agentRequirements` stays SDK-only
// (`GET /kilocode/agent/requirements` via `@kilocode/sdk`
// `client.kilocode.agentRequirements`).
//
// Source facts (read-only evidence, not imported):
// - Route: `GET /kilocode/agent/requirements` with `AgentRequirementQuery`
//   (`WorkspaceRoutingQueryFields` + `agent: Schema.String`) in
//   `packages/opencode/src/kilocode/server/httpapi/groups/kilocode.ts:126-135`
//   (`identifier: "kilocode.agentRequirements"`, success `AgentRequirementResult`).
// - Handler: `packages/opencode/src/kilocode/server/httpapi/handlers/kilocode.ts:52-56`
//   `agentRequirements` returns `agents.requirementStatus(ctx.query.agent)`.
// - Payload/service: `packages/opencode/src/kilocode/agent-requirements.ts:30-44`
//   `Result {agent, directory, enabled, state: disabled|ready|blocked|error,
//   skills: SkillItem[], mcps: MCPItem[], vscode_extensions: VSCodeExtension[],
//   error?: {code: unknown_agent|malformed_declaration|discovery_failed|
//   mcp_status_failed, message}}`; `SkillItem`/`MCPItem`
//   `{name, status: ready|missing|error, message?}`; server `VSCodeExtension`
//   (`ConfigAgentV1.VSCodeExtension` in `packages/core/src/v1/config/agent.ts:20-23`)
//   is strictly `{name, id}` — NO `message`, NO `status`. Host-side `status`
//   augmentation (`applyVSCodeExtensionRequirements`) is rejected here by design,
//   and any `message` key on extensions is rejected as non-authority.
// - SDK: `client.kilocode.agentRequirements({agent, directory})` is the sole
//   authority.
// - Consumer: `packages/kilo-vscode/src/kilo-provider/agent-requirements-controller.ts:190-213,216-240`
//   calls the SDK endpoint and then applies HOST-SIDE augmentation via
//   `applyVSCodeExtensionRequirements` (`kilo-provider/agent-requirements.ts:85-101`),
//   which adds host-computed `status` per extension and may flip `ready` to
//   `blocked`. That augmented shape is NOT server authority and is excluded
//   from this contract by design (server `vscode_extensions` entries with a
//   `status` key are rejected).
//
// ROUTING-ONLY vs PAYLOAD SEMANTICS (explicit, honest v1):
// - `context.directory`/`context.agent` are ROUTING-ONLY labels. Scope checks
//   guard request-routing identity only; a scope match says nothing about
//   payload ownership, discovery freshness, or guard semantics.
// - Payload `agent`/`directory`/`enabled`/`state`/`skills`/`mcps`/
//   `vscode_extensions`/`error` are validated shape-only against the server
//   `AgentRequirementResult` authority. No discovery freshness, no ordering,
//   no guard/execution-blocking, and no cross-directory claim is made.
// - Array ordering is explicitly UNRESOLVED here: parity never compares order.
// - Out of scope: requirement guard / execution blocking
//   (`agent-requirements.ts:242-261` `guard`), host-side
//   `applyVSCodeExtensionRequirements` augmentation, skill discovery
//   freshness, MCP status freshness, transport behavior, and any other
//   operation.

import { isAbsolute, normalize, resolve } from "path"

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function isNonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

// Authority shape copy (shape-only validation, not a new authority):
// mirrors `packages/core/src/v1/config/agent.ts:13-18`
// `RequirementName`: length 1..128 + `/\S/` (at least one non-whitespace char).
// `RequirementID`: length 1..128 + `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`.
// These two helpers apply ONLY to `vscode_extensions` `name`/`id`; every
// other response string is a plain server `string` (see projection comment).
const REQUIREMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const REQUIREMENT_NAME_PATTERN = /\S/

function isRequirementName(v: unknown): v is string {
  return (
    typeof v === "string" && v.length >= 1 && v.length <= 128 && REQUIREMENT_NAME_PATTERN.test(v)
  )
}

function isRequirementID(v: unknown): v is string {
  return (
    typeof v === "string" && v.length >= 1 && v.length <= 128 && REQUIREMENT_ID_PATTERN.test(v)
  )
}

function canonicalDir(dir: string): string {
  return normalize(resolve(dir))
}

function assertAllowedKeys(rec: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const k of Object.keys(rec)) if (!allowed.has(k)) throw new Error(`unexpected ${label} field ${k}`)
}

export function canonicalAgentRequirementsOpId(agent: string, token: string): string {
  if (typeof agent !== "string" || agent.length === 0) throw new TypeError("agent must be non-empty string")
  if (agent.includes(":")) throw new TypeError("agent must not contain ':'")
  if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
  if (token.includes(":")) throw new TypeError("token must not contain ':'")
  return `agent-requirements:${agent}:${token}`
}

export function parseAgentRequirementsOpId(opId: string): { agent: string; token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  const segs = opId.split(":")
  if (segs.length !== 3) throw new TypeError(`agent-requirements opId must have 2 segments: ${opId}`)
  if (segs[0] !== "agent-requirements") throw new TypeError(`opId kind must be agent-requirements: ${opId}`)
  const agent = segs[1]!
  const token = segs[2]!
  if (agent.length === 0) throw new TypeError(`opId segment must be non-empty: ${opId}`)
  if (token.length === 0) throw new TypeError(`opId segment must be non-empty: ${opId}`)
  return { agent, token }
}

export interface AgentRequirementsContractRequest {
  v: 1
  requestId: string
  opId: string
  op: "agent/requirements"
  idempotencyKey: string
  context: {
    directory: string
    agent: string
  }
  payload: Record<string, never>
}

// eslint-disable-next-line complexity
export function validateAgentRequirementsContractRequest(raw: unknown): AgentRequirementsContractRequest {
  if (!isRecord(raw)) throw new Error("request must be object")
  if (raw.v !== 1) throw new Error("v must be 1")
  if (!isNonEmpty(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmpty(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== "agent/requirements") throw new Error("op must be agent/requirements")
  if (!isNonEmpty(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId)
    throw new Error("idempotencyKey must equal opId for agent-requirements contract")
  const ctx = raw.context
  if (!isRecord(ctx)) throw new Error("context must be object")
  const allowedCtx = new Set(["directory", "agent"])
  for (const k of Object.keys(ctx as Record<string, unknown>))
    if (!allowedCtx.has(k)) throw new Error(`unexpected context field ${k}`)
  if (typeof ctx.directory !== "string" || !isAbsolute(ctx.directory) || ctx.directory.includes("\0"))
    throw new Error("context.directory must be absolute path")
  if (!isNonEmpty(ctx.agent)) throw new Error("context.agent must be non-empty string")
  const payload = raw.payload
  if (!isRecord(payload)) throw new Error("payload must be object")
  if (Object.keys(payload as Record<string, unknown>).length !== 0)
    throw new Error("payload must be empty object for agent-requirements contract")
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw as Record<string, unknown>))
    if (!allowedRoot.has(k)) throw new Error(`unexpected field ${k}`)
  const parsed = parseAgentRequirementsOpId(raw.opId as string)
  if (parsed.agent !== ctx.agent)
    throw new Error(`opId agent binding mismatch: ${raw.opId} vs ${ctx.agent}`)
  const idem = parseAgentRequirementsOpId(raw.idempotencyKey as string)
  if (idem.agent !== ctx.agent)
    throw new Error(`idempotencyKey agent binding mismatch: ${raw.idempotencyKey} vs ${ctx.agent}`)
  if (idem.token !== parsed.token) throw new Error("idempotencyKey token must equal opId token")
  return raw as unknown as AgentRequirementsContractRequest
}

export type AgentRequirementsScopeWhich = "directory" | "agent" | "request"

export type AgentRequirementsScopeCheck =
  | { ok: true }
  | { ok: false; code: "scope_mismatch"; which: AgentRequirementsScopeWhich }

export function checkAgentRequirementsScope(
  req: AgentRequirementsContractRequest,
  expected: { directory: string; agent: string; token: string },
): AgentRequirementsScopeCheck {
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
  if (req.context.agent !== expected.agent) return { ok: false, code: "scope_mismatch", which: "agent" }
  const parsed = parseAgentRequirementsOpId(req.opId)
  if (parsed.agent !== expected.agent || parsed.token !== expected.token)
    return { ok: false, code: "scope_mismatch", which: "request" }
  const bound = canonicalAgentRequirementsOpId(expected.agent, expected.token)
  if (req.opId !== bound || req.idempotencyKey !== bound)
    return { ok: false, code: "scope_mismatch", which: "request" }
  return { ok: true }
}

// Safe v1 payload projection: exactly the server `AgentRequirementResult`
// fields (`agent`, `directory`, `enabled`, `state`, `skills`, `mcps`,
// `vscode_extensions`, optional `error`) with required enum shapes only.
// Shape-only validation; no discovery freshness, ordering, guard, or
// cross-directory claim. Server `vscode_extensions` entries are strictly
// `{name, id}` — host-side `status` augmentation
// (`applyVSCodeExtensionRequirements`) and any non-authority `message` key
// are rejected here by design. ONLY extension `name`/`id` carry authority
// refinements: extension `name` follows authority `RequirementName`
// (1..128 chars, contains non-whitespace); extension `id` follows authority
// `RequirementID` (1..128 chars, `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`).
// All other response strings are plain server `string` shapes with no
// refinement: skill/mcp `name`, skill/mcp `message?`, payload `agent`,
// payload `directory`, and `error.message` accept any string (including
// empty or long values). The routing-only request validator above keeps its
// own non-empty/absolute-path input rules; those are request-input rules,
// not response authority refinements.
export type AgentRequirementItemStatus = "ready" | "missing" | "error"
export type AgentRequirementState = "disabled" | "ready" | "blocked" | "error"
export type AgentRequirementErrorCode =
  | "unknown_agent"
  | "malformed_declaration"
  | "discovery_failed"
  | "mcp_status_failed"

export interface AgentRequirementItem {
  name: string
  status: AgentRequirementItemStatus
  message?: string
}

export interface AgentRequirementVSCodeExtension {
  name: string
  id: string
}

export interface AgentRequirementError {
  code: AgentRequirementErrorCode
  message: string
}

export interface AgentRequirementsPayload {
  agent: string
  directory: string
  enabled: boolean
  state: AgentRequirementState
  skills: AgentRequirementItem[]
  mcps: AgentRequirementItem[]
  vscode_extensions: AgentRequirementVSCodeExtension[]
  error?: AgentRequirementError
}

const REQUIREMENTS_PAYLOAD_FIELDS = new Set([
  "agent",
  "directory",
  "enabled",
  "state",
  "skills",
  "mcps",
  "vscode_extensions",
  "error",
])
const REQUIREMENTS_ITEM_FIELDS = new Set(["name", "status", "message"])
const REQUIREMENTS_ITEM_STATUS = new Set(["ready", "missing", "error"])
const REQUIREMENTS_STATE = new Set(["disabled", "ready", "blocked", "error"])
const REQUIREMENTS_EXTENSION_FIELDS = new Set(["name", "id"])
const REQUIREMENTS_ERROR_FIELDS = new Set(["code", "message"])
const REQUIREMENTS_ERROR_CODE = new Set([
  "unknown_agent",
  "malformed_declaration",
  "discovery_failed",
  "mcp_status_failed",
])

// Host-only error codes (`agent-requirements.ts` host controller
// `scope_mismatch`/`request_failed`) are never server authority and are
// rejected by the server error-code enum above.
const REQUIREMENTS_HOST_ERROR_CODE = new Set(["scope_mismatch", "request_failed"])

function validateRequirementItem(raw: unknown, label: string): AgentRequirementItem {
  if (!isRecord(raw)) throw new Error(`${label} entries must be object`)
  assertAllowedKeys(raw as Record<string, unknown>, REQUIREMENTS_ITEM_FIELDS, label)
  const rec = raw as Record<string, unknown>
  if (typeof rec.name !== "string") throw new Error(`${label}.name must be string`)
  if (typeof rec.status !== "string" || !REQUIREMENTS_ITEM_STATUS.has(rec.status))
    throw new Error(`${label}.status must be ready/missing/error`)
  if (rec.message !== undefined && typeof rec.message !== "string")
    throw new Error(`${label}.message must be string when present`)
  return raw as unknown as AgentRequirementItem
}

function validateRequirementExtension(raw: unknown): AgentRequirementVSCodeExtension {
  if (!isRecord(raw)) throw new Error("vscode_extensions entries must be object")
  assertAllowedKeys(raw as Record<string, unknown>, REQUIREMENTS_EXTENSION_FIELDS, "vscode_extension")
  const rec = raw as Record<string, unknown>
  if (!isRequirementName(rec.name))
    throw new Error("vscode_extension.name must be RequirementName (1..128 chars, non-whitespace)")
  if (!isRequirementID(rec.id))
    throw new Error("vscode_extension.id must be RequirementID (1..128 chars, ^[A-Za-z0-9][A-Za-z0-9._-]*$)")
  return raw as unknown as AgentRequirementVSCodeExtension
}

function validateRequirementError(raw: unknown): AgentRequirementError {
  if (!isRecord(raw)) throw new Error("error must be object")
  assertAllowedKeys(raw as Record<string, unknown>, REQUIREMENTS_ERROR_FIELDS, "error")
  const rec = raw as Record<string, unknown>
  if (typeof rec.code !== "string" || !REQUIREMENTS_ERROR_CODE.has(rec.code)) {
    if (typeof rec.code === "string" && REQUIREMENTS_HOST_ERROR_CODE.has(rec.code))
      throw new Error("error.code is host-only and never server authority")
    throw new Error("error.code must be unknown_agent/malformed_declaration/discovery_failed/mcp_status_failed")
  }
  if (typeof rec.message !== "string") throw new Error("error.message must be string")
  return raw as unknown as AgentRequirementError
}

export function validateAgentRequirementsPayload(raw: unknown): AgentRequirementsPayload {
  if (!isRecord(raw)) throw new Error("agent-requirements payload must be object")
  assertAllowedKeys(raw as Record<string, unknown>, REQUIREMENTS_PAYLOAD_FIELDS, "agent-requirements")
  const rec = raw as Record<string, unknown>
  if (typeof rec.agent !== "string") throw new Error("agent must be string")
  if (typeof rec.directory !== "string") throw new Error("directory must be string")
  if (typeof rec.enabled !== "boolean") throw new Error("enabled must be boolean")
  if (typeof rec.state !== "string" || !REQUIREMENTS_STATE.has(rec.state))
    throw new Error("state must be disabled/ready/blocked/error")
  if (!Array.isArray(rec.skills)) throw new Error("skills must be array")
  for (const entry of rec.skills as unknown[]) validateRequirementItem(entry, "skills")
  if (!Array.isArray(rec.mcps)) throw new Error("mcps must be array")
  for (const entry of rec.mcps as unknown[]) validateRequirementItem(entry, "mcps")
  if (!Array.isArray(rec.vscode_extensions)) throw new Error("vscode_extensions must be array")
  for (const entry of rec.vscode_extensions as unknown[]) validateRequirementExtension(entry)
  if (rec.error !== undefined) validateRequirementError(rec.error)
  return raw as unknown as AgentRequirementsPayload
}

export type AgentRequirementsResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: "agent/requirements"
      idempotencyKey: string
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: { requirements: AgentRequirementsPayload }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "agent/requirements"
      idempotencyKey: string
      status: "failed"
      outcome: { type: "failed"; time: number; failure: AgentRequirementsFailure }
      accepted: boolean
      failure: AgentRequirementsFailure
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "agent/requirements"
      idempotencyKey: string
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      transportUnknown?: boolean
    }

export function makeAgentRequirementsAmbiguous(
  req: AgentRequirementsContractRequest,
  transportUnknown = true,
): AgentRequirementsResult {
  const out: AgentRequirementsResult = {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "agent/requirements",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

// Redacted failure shape ({code,message,retryable} only). Requirement,
// credential, and guard echo keys are rejected so fixtures cannot carry
// requirement material, secret material, or guard semantics.
export interface AgentRequirementsFailure {
  code: string
  message: string
  retryable: boolean
}

const REQUIREMENTS_FAILURE_FORBIDDEN = new Set([
  "session",
  "sessionId",
  "agent",
  "directory",
  "workspace",
  "skills",
  "mcps",
  "vscode_extensions",
  "state",
  "enabled",
  "error",
  "status",
  "prompt",
  "tool",
  "token",
  "secret",
  "credential",
  "password",
  "auth",
  "guard",
  "blocked",
  "scope",
])

const REQUIREMENTS_FAILURE_FIELDS = new Set(["code", "message", "retryable"])

export const AGENT_REQUIREMENTS_FAILED_CODE = "agent-requirements.failed"
export const AGENT_REQUIREMENTS_FAILED_MESSAGE = "private agent-requirements failed"

export function validateAgentRequirementsFailure(raw: unknown): AgentRequirementsFailure {
  if (!isRecord(raw)) throw new Error("failure must be object")
  for (const k of Object.keys(raw)) {
    if (REQUIREMENTS_FAILURE_FORBIDDEN.has(k)) throw new Error("failure must not carry raw field")
  }
  assertAllowedKeys(raw as Record<string, unknown>, REQUIREMENTS_FAILURE_FIELDS, "failure")
  if (!isNonEmpty(raw.code)) throw new Error("failure code must be non-empty string")
  if (!isNonEmpty(raw.message)) throw new Error("failure message must be non-empty string")
  if (typeof raw.retryable !== "boolean") throw new Error("failure retryable must be boolean")
  return raw as unknown as AgentRequirementsFailure
}

export type AgentRequirementsWireOutcome =
  | { kind: "valid"; result: AgentRequirementsResult }
  | { kind: "invalid"; detail: string }

export const AGENT_REQUIREMENTS_INVALID_DETAIL = "invalid private response shape"

export class AgentRequirementsValidationError extends Error {
  readonly kind = "private-agent-requirements-validation" as const
  readonly detail: string
  constructor(_detail: string) {
    super(AGENT_REQUIREMENTS_INVALID_DETAIL)
    this.name = "AgentRequirementsValidationError"
    this.detail = AGENT_REQUIREMENTS_INVALID_DETAIL
  }
}

export function isAgentRequirementsValidationError(v: unknown): v is AgentRequirementsValidationError {
  return !!v && typeof v === "object" && (v as { kind?: unknown }).kind === "private-agent-requirements-validation"
}

export function normalizePrivateAgentRequirementsWire(
  raw: unknown,
  req: AgentRequirementsContractRequest,
): AgentRequirementsWireOutcome {
  try {
    const result = validateAgentRequirementsResult(raw, req)
    if (result.status === "failed") {
      const retryable = result.failure.retryable
      const fixed = { code: AGENT_REQUIREMENTS_FAILED_CODE, message: AGENT_REQUIREMENTS_FAILED_MESSAGE, retryable }
      const redacted: AgentRequirementsResult = {
        ...result,
        failure: fixed,
        outcome: { ...result.outcome, failure: fixed },
      }
      return { kind: "valid", result: redacted }
    }
    return { kind: "valid", result }
  } catch {
    return { kind: "invalid", detail: AGENT_REQUIREMENTS_INVALID_DETAIL }
  }
}

const REQUIREMENTS_RESULT_SUCCEEDED = new Set([
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
const REQUIREMENTS_RESULT_FAILED = new Set([
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
const REQUIREMENTS_RESULT_AMBIGUOUS = new Set([
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
const REQUIREMENTS_OUTCOME_PLAIN = new Set(["type", "time"])
const REQUIREMENTS_OUTCOME_FAILED = new Set(["type", "time", "failure"])

// eslint-disable-next-line complexity
export function validateAgentRequirementsResult(
  raw: unknown,
  req: AgentRequirementsContractRequest,
): AgentRequirementsResult {
  if (!isRecord(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== "agent/requirements") throw new Error("op mismatch")
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
    assertAllowedKeys(rec, REQUIREMENTS_RESULT_SUCCEEDED, "result")
    assertAllowedKeys(outRec, REQUIREMENTS_OUTCOME_PLAIN, "outcome")
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    const data = rec.data
    if (!isRecord(data)) throw new Error("succeeded data must be object")
    const allowedData = new Set(["requirements"])
    for (const k of Object.keys(data as Record<string, unknown>))
      if (!allowedData.has(k)) throw new Error("unexpected data field")
    // Shape-only projection validation against the server authority. No
    // discovery freshness, ordering, guard, or directory binding is asserted
    // here by design; the request directory/agent are routing-only.
    validateAgentRequirementsPayload((data as Record<string, unknown>).requirements)
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (outRec.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as AgentRequirementsResult
  }
  if (status === "failed") {
    assertAllowedKeys(rec, REQUIREMENTS_RESULT_FAILED, "result")
    assertAllowedKeys(outRec, REQUIREMENTS_OUTCOME_FAILED, "outcome")
    const failure = validateAgentRequirementsFailure(rec.failure)
    const outFailure = validateAgentRequirementsFailure(outRec.failure)
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    if (rec.data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as AgentRequirementsResult
  }
  assertAllowedKeys(rec, REQUIREMENTS_RESULT_AMBIGUOUS, "result")
  assertAllowedKeys(outRec, REQUIREMENTS_OUTCOME_PLAIN, "outcome")
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (outRec.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as AgentRequirementsResult
}

// Detached parity only (contract evidence, never production parity):
// compares ONLY the shared server projection (`agent`, `enabled`, `state`,
// `skills`, `mcps`, `vscode_extensions` server shape, `error` `{code,message}`)
// for the same request. Order is never compared (`orderIgnored: true`); `skills`/
// `mcps`/`vscode_extensions` length/membership gaps are reported as
// `agent-requirements-membership-unknown`, never as a match. Arrays use
// stable canonical multiset comparison: order ignored, duplicate identity
// entries preserved by full semantic projection, object key insertion order
// ignored (fields read by name, never `JSON.stringify`). The request
// directory is never compared; only observed payload values are. Host-side
// `status` augmentation on `vscode_extensions` is not compared — the server
// shape has no `status`, and any augmented value is outside this contract.
// Server/OpenAPI authority declares no array identity uniqueness; duplicate
// `name`/`id` entries are legal and compared as multisets.
// eslint-disable-next-line complexity
export function compareAgentRequirementsParity(
  priv: AgentRequirementsResult,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
): { divergence: string | null; details: Record<string, unknown> } {
  const base = { orderIgnored: true }
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
    const pdata = (priv as Extract<AgentRequirementsResult, { status: "succeeded" }>).data as Record<string, unknown>
    const privPayload = (pdata.requirements ?? {}) as Record<string, unknown>
    try {
      validateAgentRequirementsPayload(sdkPayload)
    } catch {
      return { divergence: "agent-requirements-shape-mismatch", details: { ...base, mismatch: true } }
    }
    if (sdkPayload.agent !== privPayload.agent) {
      return { divergence: "agent-requirements-agent-mismatch", details: { ...base, mismatch: true, field: "agent" } }
    }
    if (sdkPayload.enabled !== privPayload.enabled) {
      return {
        divergence: "agent-requirements-enabled-mismatch",
        details: { ...base, mismatch: true, field: "enabled" },
      }
    }
    if (sdkPayload.state !== privPayload.state) {
      return { divergence: "agent-requirements-state-mismatch", details: { ...base, mismatch: true, field: "state" } }
    }
    const canonicalItem = (entry: unknown): string => {
      const rec = entry as Record<string, unknown>
      const name = String(rec.name)
      const status = String(rec.status)
      const msg = rec.message === undefined ? "0" : `1:${String(rec.message)}`
      return `${name}\u0000${status}\u0000${msg}`
    }
    const canonicalExt = (entry: unknown): string => {
      const rec = entry as Record<string, unknown>
      return `${String(rec.name)}\u0000${String(rec.id)}`
    }
    const identityItem = (entry: unknown): string => String((entry as Record<string, unknown>).name)
    const identityExt = (entry: unknown): string => String((entry as Record<string, unknown>).id)
    const sorted = (list: string[]): string[] => [...list].sort()
    for (const field of ["skills", "mcps"] as const) {
      const sdkList = (sdkPayload[field] ?? []) as unknown[]
      const privList = (privPayload[field] ?? []) as unknown[]
      const sdkFull = sorted(sdkList.map(canonicalItem))
      const privFull = sorted(privList.map(canonicalItem))
      if (sdkFull.length === privFull.length && sdkFull.every((v, i) => v === privFull[i])) continue
      const sdkKeys = sorted(sdkList.map(identityItem))
      const privKeys = sorted(privList.map(identityItem))
      if (sdkKeys.length !== privKeys.length || sdkKeys.some((k, i) => k !== privKeys[i])) {
        return { divergence: "agent-requirements-membership-unknown", details: { ...base, mismatch: true } }
      }
      return {
        divergence: `agent-requirements-${field}-mismatch`,
        details: { ...base, mismatch: true, field },
      }
    }
    const sdkExtList = (sdkPayload.vscode_extensions ?? []) as unknown[]
    const privExtList = (privPayload.vscode_extensions ?? []) as unknown[]
    const sdkExtFull = sorted(sdkExtList.map(canonicalExt))
    const privExtFull = sorted(privExtList.map(canonicalExt))
    if (sdkExtFull.length === privExtFull.length && sdkExtFull.every((v, i) => v === privExtFull[i])) {
      // hold: fall through to error comparison below
    } else {
      const sdkExtKeys = sorted(sdkExtList.map(identityExt))
      const privExtKeys = sorted(privExtList.map(identityExt))
      if (sdkExtKeys.length !== privExtKeys.length || sdkExtKeys.some((k, i) => k !== privExtKeys[i])) {
        return { divergence: "agent-requirements-membership-unknown", details: { ...base, mismatch: true } }
      }
      return {
        divergence: "agent-requirements-vscode-extensions-mismatch",
        details: { ...base, mismatch: true, field: "vscode_extensions" },
      }
    }
    const sdkErr = (sdkPayload.error ?? null) as Record<string, unknown> | null
    const privErr = (privPayload.error ?? null) as Record<string, unknown> | null
    if ((sdkErr === null) !== (privErr === null)) {
      return { divergence: "agent-requirements-error-mismatch", details: { ...base, mismatch: true, field: "error" } }
    }
    if (sdkErr && privErr && (sdkErr.code !== privErr.code || sdkErr.message !== privErr.message)) {
      return { divergence: "agent-requirements-error-mismatch", details: { ...base, mismatch: true, field: "error" } }
    }
    return { divergence: null, details: { ...base } }
  }
  return { divergence: null, details: { ...base } }
}
