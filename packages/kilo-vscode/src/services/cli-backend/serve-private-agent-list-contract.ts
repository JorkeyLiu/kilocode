// Private-first `agent/list` read-only observation contract (production).
// Request is strictly `{v:1,requestId,op:"agent/list",
// context:{directory,workspace?},payload:{}}` with no `opId`/`idempotencyKey`
// (observation identity is `requestId` only). Success data preserves the exact
// HTTP `GET /agent` shape (`Array<Agent>`): full `Agent.Info` wire, not the
// UI subset. Unknown entry fields are rejected so provider credentials or
// hidden runtime state can never cross.
//
// Source facts:
// - Route: `GET /agent` with `WorkspaceRoutingQuery` in
//   `packages/opencode/src/server/routes/instance/httpapi/groups/instance.ts`
//   (`identifier: "app.agents"`, success `Array(Agent.Info)`).
// - Handler: `packages/opencode/src/server/routes/instance/httpapi/handlers/instance.ts`
//   `getAgent` returns the shared `fetchAgentListData` (`Agent.Service.list()`
//   + strict wire validation).
// - Service: `packages/opencode/src/agent/agent.ts` `Agent.Service.list()`
//   (`Info[]` sorted default-first then name); `Info` matches the v2 SDK
//   `Agent` (`name,displayName?,source?,description?,deprecated?,mode,
//   native?,hidden?,topP?,temperature?,color?,permission,model?,variant?,
//   prompt?,options,requirements?,steps?`).
// - SDK: v2 `client.app.agents({directory,workspace?})` issues `GET /agent`
//   and remains the exactly-one fallback for unavailable/retryable/invalid/
//   ambiguous/transport/closed/timeout outcomes. Validated terminal
//   (`retryable === false`, including `validation.failed`/`scope_mismatch`/
//   `internal`) closes with zero SDK.
// - Consumer: `KiloProvider.fetchAndSendAgents` (non-canonical) is
//   private-first via `fetchAgentsPrivateFirst`: validated success returns
//   with zero SDK; validated terminal closes with zero SDK; otherwise exactly
//   one same-directory SDK fallback. The helper never retries, posts, caches,
//   filters, or sorts; the caller keeps `retry()`, `filterVisibleAgents`,
//   cache/post semantics and the canonical `sendCanonicalAgents` short-circuit.
// - Distinct from `skill/list` (safe subset, no terminal), `command/list`,
//   `kilo/profile`, provider catalog, and `agent/requirements`. This contract
//   never matches those operations.
//
// ROUTING vs PAYLOAD SEMANTICS (v1):
// - `context.directory` binds request routing and scope. A scope match says
//   nothing about payload freshness or completeness.
// - Payload is validated shape-only. No freshness, ordering, lifecycle, or
//   cross-directory claim is made.
// - Out of scope: provider catalog, models discover, `config.get`,
//   notebook, OAuth, `instance.reload`, agent UI/sort rules, caching/dedup,
//   transport behavior beyond the fixed failure taxonomy.

import { isAbsolute } from "path"

function record(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function present(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

function clean(v: unknown, label: string): string {
  if (!present(v)) throw new Error(`${label} must be non-empty string`)
  const text = v as string
  if (text.includes("\0")) throw new Error(`${label} must not contain null bytes`)
  return text
}

function pathless(v: string): boolean {
  return !v.includes("/") && !v.includes("\\") && !v.includes("\0")
}

function noNul(v: unknown): v is string {
  return typeof v === "string" && !v.includes("\0")
}

export interface AgentListPermissionRule {
  permission: string
  pattern: string
  action: "allow" | "deny" | "ask"
}

export interface AgentListModel {
  modelID: string
  providerID: string
}

export interface AgentListVSCodeExtension {
  name: string
  id: string
}

export interface AgentListRequirements {
  skills?: string[]
  mcps?: string[]
  vscode_extensions?: AgentListVSCodeExtension[]
}

export interface AgentListEntry {
  name: string
  displayName?: string
  source?: string
  description?: string
  deprecated?: boolean
  mode: "subagent" | "primary" | "all"
  native?: boolean
  hidden?: boolean
  topP?: number
  temperature?: number
  color?: string
  permission: AgentListPermissionRule[]
  model?: AgentListModel
  variant?: string
  prompt?: string
  options: Record<string, unknown>
  requirements?: AgentListRequirements
  steps?: number
}

export interface AgentListData {
  agents: AgentListEntry[]
}

export interface AgentListContractRequest {
  v: 1
  requestId: string
  op: "agent/list"
  context: { directory: string; workspace?: string }
  payload: Record<string, never>
}

export function validateAgentListContractRequest(raw: unknown): AgentListContractRequest {
  if (!record(raw)) throw new Error("request must be object")
  const allowed = new Set(["v", "requestId", "op", "context", "payload"])
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) throw new Error(`unexpected field ${k}`)
  }
  if (raw.v !== 1) throw new Error("v must be 1")
  clean(raw.requestId, "requestId")
  if (!pathless(raw.requestId as string)) throw new Error("requestId must not carry path material")
  if (raw.op !== "agent/list") throw new Error("op must be agent/list")
  const ctx = raw.context
  if (!record(ctx)) throw new Error("context must be object")
  const ctxAllowed = new Set(["directory", "workspace"])
  for (const k of Object.keys(ctx)) {
    if (!ctxAllowed.has(k)) throw new Error(`unexpected context field ${k}`)
  }
  if (typeof ctx.directory !== "string" || !isAbsolute(ctx.directory) || ctx.directory.includes("\0"))
    throw new Error("context.directory must be absolute path")
  if (ctx.workspace !== undefined) {
    if (!present(ctx.workspace) || (ctx.workspace as string).includes("\0"))
      throw new Error("context.workspace must be non-empty string when present")
  }
  const payload = raw.payload
  if (!record(payload)) throw new Error("payload must be object")
  if (Object.keys(payload).length !== 0) throw new Error("payload must be empty object for agent-list")
  return raw as unknown as AgentListContractRequest
}

const AGENT_ENTRY_FIELDS = new Set([
  "name",
  "displayName",
  "source",
  "description",
  "deprecated",
  "mode",
  "native",
  "hidden",
  "topP",
  "temperature",
  "color",
  "permission",
  "model",
  "variant",
  "prompt",
  "options",
  "requirements",
  "steps",
])

function checkPermissionRule(raw: unknown): AgentListPermissionRule {
  if (!record(raw)) throw new Error("permission entry must be object")
  const allowed = new Set(["permission", "pattern", "action"])
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new Error("unexpected permission field")
  if (!noNul(raw.permission)) throw new Error("permission.permission invalid")
  if (!noNul(raw.pattern)) throw new Error("permission.pattern invalid")
  if (raw.action !== "allow" && raw.action !== "deny" && raw.action !== "ask")
    throw new Error("permission.action invalid")
  return raw as unknown as AgentListPermissionRule
}

function checkModel(raw: unknown): AgentListModel {
  if (!record(raw)) throw new Error("model must be object")
  const allowed = new Set(["modelID", "providerID"])
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new Error("unexpected model field")
  if (!present(raw.modelID) || (raw.modelID as string).includes("\0")) throw new Error("model.modelID invalid")
  if (!present(raw.providerID) || (raw.providerID as string).includes("\0"))
    throw new Error("model.providerID invalid")
  return raw as unknown as AgentListModel
}

function checkRequirementName(v: unknown, label: string): string {
  if (typeof v !== "string" || v.length === 0 || v.length > 128 || !/\S/.test(v) || v.includes("\0"))
    throw new Error(`${label} invalid`)
  return v
}

function checkRequirementGroup(raw: unknown, label: string): string[] {
  if (!Array.isArray(raw)) throw new Error(`${label} must be array`)
  if (raw.length === 0 || raw.length > 20) throw new Error(`${label} must have 1..20 entries`)
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of raw as unknown[]) {
    const name = checkRequirementName(item, `${label} entry`)
    if (seen.has(name)) throw new Error(`duplicate ${label} requirement`)
    seen.add(name)
    out.push(name)
  }
  return out
}

function checkVSCodeExtension(raw: unknown): AgentListVSCodeExtension {
  if (!record(raw)) throw new Error("vscode extension must be object")
  const allowed = new Set(["name", "id"])
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new Error("unexpected vscode extension field")
  checkRequirementName(raw.name, "vscode extension name")
  const id = raw.id
  if (typeof id !== "string" || id.length === 0 || id.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id))
    throw new Error("vscode extension id invalid")
  return raw as unknown as AgentListVSCodeExtension
}

function checkRequirements(raw: unknown): AgentListRequirements {
  if (!record(raw)) throw new Error("requirements must be object")
  const allowed = new Set(["skills", "mcps", "vscode_extensions"])
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new Error("unexpected requirements field")
  const out: AgentListRequirements = {}
  if (raw.skills !== undefined) out.skills = checkRequirementGroup(raw.skills, "skills")
  if (raw.mcps !== undefined) out.mcps = checkRequirementGroup(raw.mcps, "mcps")
  if (raw.vscode_extensions !== undefined) {
    const list = raw.vscode_extensions
    if (!Array.isArray(list)) throw new Error("vscode_extensions must be array")
    if (list.length === 0 || list.length > 20) throw new Error("vscode_extensions must have 1..20 entries")
    const seen = new Set<string>()
    out.vscode_extensions = (list as unknown[]).map((item) => {
      const entry = checkVSCodeExtension(item)
      if (seen.has(entry.id)) throw new Error("duplicate vscode_extensions requirement")
      seen.add(entry.id)
      return entry
    })
  }
  if (!out.skills && !out.mcps && !out.vscode_extensions) throw new Error("requirements must have at least one group")
  return out
}

export function validateAgentListEntry(raw: unknown): AgentListEntry {
  if (!record(raw)) throw new Error("agent entry must be object")
  for (const k of Object.keys(raw)) if (!AGENT_ENTRY_FIELDS.has(k)) throw new Error(`unexpected agent field ${k}`)
  if (!present(raw.name) || (raw.name as string).includes("\0")) throw new Error("agent.name invalid")
  if (raw.displayName !== undefined && !noNul(raw.displayName)) throw new Error("agent.displayName invalid")
  if (raw.source !== undefined && !noNul(raw.source)) throw new Error("agent.source invalid")
  if (raw.description !== undefined && !noNul(raw.description)) throw new Error("agent.description invalid")
  if (raw.deprecated !== undefined && typeof raw.deprecated !== "boolean") throw new Error("agent.deprecated invalid")
  if (raw.mode !== "subagent" && raw.mode !== "primary" && raw.mode !== "all") throw new Error("agent.mode invalid")
  if (raw.native !== undefined && typeof raw.native !== "boolean") throw new Error("agent.native invalid")
  if (raw.hidden !== undefined && typeof raw.hidden !== "boolean") throw new Error("agent.hidden invalid")
  if (raw.topP !== undefined && (typeof raw.topP !== "number" || !Number.isFinite(raw.topP)))
    throw new Error("agent.topP invalid")
  if (raw.temperature !== undefined && (typeof raw.temperature !== "number" || !Number.isFinite(raw.temperature)))
    throw new Error("agent.temperature invalid")
  if (raw.color !== undefined && !noNul(raw.color)) throw new Error("agent.color invalid")
  if (!Array.isArray(raw.permission)) throw new Error("agent.permission must be array")
  for (const rule of raw.permission as unknown[]) checkPermissionRule(rule)
  if (raw.model !== undefined) checkModel(raw.model)
  if (raw.variant !== undefined && !noNul(raw.variant)) throw new Error("agent.variant invalid")
  if (raw.prompt !== undefined && !noNul(raw.prompt)) throw new Error("agent.prompt invalid")
  if (!record(raw.options)) throw new Error("agent.options must be object")
  if (raw.requirements !== undefined) checkRequirements(raw.requirements)
  if (raw.steps !== undefined && (typeof raw.steps !== "number" || !Number.isFinite(raw.steps)))
    throw new Error("agent.steps invalid")
  return raw as unknown as AgentListEntry
}

export function validateAgentListEntries(raw: unknown): AgentListEntry[] {
  if (!Array.isArray(raw)) throw new Error("agents must be array")
  return (raw as unknown[]).map((item) => validateAgentListEntry(item))
}

export function validateAgentListData(raw: unknown): AgentListData {
  if (!record(raw)) throw new Error("data must be object")
  const allowed = new Set(["agents"])
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new Error(`unexpected data field ${k}`)
  return { agents: validateAgentListEntries(raw.agents) }
}

export interface AgentListFailure {
  code: string
  message: string
  retryable: boolean
}

export const AGENT_LIST_FAILURE_CODES = new Set([
  "validation.failed",
  "scope_mismatch",
  "InstanceUnavailableDuringConfigRebuild",
  "internal",
] as const)
export type AgentListFailureCode =
  | "validation.failed"
  | "scope_mismatch"
  | "InstanceUnavailableDuringConfigRebuild"
  | "internal"
export const AGENT_LIST_FAILURE_MESSAGES: Record<AgentListFailureCode, string> = {
  "validation.failed": "invalid agent-list request",
  scope_mismatch: "directory mismatch",
  InstanceUnavailableDuringConfigRebuild:
    "Instance is unavailable during config rebuild; no active runtime for this request",
  internal: "internal error",
}
export const AGENT_LIST_FAILURE_RETRYABLE: Record<AgentListFailureCode, boolean> = {
  "validation.failed": false,
  scope_mismatch: false,
  InstanceUnavailableDuringConfigRebuild: true,
  internal: false,
}

const FAILURE_FIELDS = new Set(["code", "message", "retryable"])

export function validateAgentListFailure(raw: unknown): AgentListFailure {
  if (!record(raw)) throw new Error("failure must be object")
  for (const k of Object.keys(raw)) {
    if (!FAILURE_FIELDS.has(k)) throw new Error(`unexpected failure field ${k}`)
  }
  if (typeof raw.code !== "string" || !AGENT_LIST_FAILURE_CODES.has(raw.code as AgentListFailureCode))
    throw new Error("failure code must be a known agent-list category")
  const code = raw.code as AgentListFailureCode
  if (raw.message !== AGENT_LIST_FAILURE_MESSAGES[code])
    throw new Error("failure message must be the fixed message for its code")
  if (raw.retryable !== AGENT_LIST_FAILURE_RETRYABLE[code])
    throw new Error("failure retryable must match its code")
  return raw as unknown as AgentListFailure
}

export type AgentListResult =
  | {
      v: 1
      requestId: string
      op: "agent/list"
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: AgentListData
    }
  | {
      v: 1
      requestId: string
      op: "agent/list"
      status: "failed"
      outcome: { type: "failed"; time: number; failure: AgentListFailure }
      accepted: boolean
      failure: AgentListFailure
    }
  | {
      v: 1
      requestId: string
      op: "agent/list"
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      transportUnknown?: boolean
    }

export function makeAgentListAmbiguous(req: AgentListContractRequest, transportUnknown = true): AgentListResult {
  const out: AgentListResult = {
    v: 1,
    requestId: req.requestId,
    op: "agent/list",
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

export type AgentListWireOutcome = { kind: "valid"; result: AgentListResult } | { kind: "invalid"; detail: string }

export class AgentListValidationError extends Error {
  readonly kind = "private-agent-list-validation" as const
  readonly detail: string
  constructor(detail: string) {
    super(`invalid private response shape: ${detail}`)
    this.name = "AgentListValidationError"
    this.detail = detail
  }
}

export function isAgentListValidationError(v: unknown): v is AgentListValidationError {
  return !!v && typeof v === "object" && (v as { kind?: unknown }).kind === "private-agent-list-validation"
}

export function normalizePrivateAgentListWire(
  raw: unknown,
  req: AgentListContractRequest,
): AgentListWireOutcome {
  try {
    const result = validateAgentListResult(raw, req)
    return { kind: "valid", result }
  } catch (e) {
    const detail = String(e instanceof Error ? e.message : e).slice(0, 200)
    return { kind: "invalid", detail }
  }
}

const RESULT_SUCCEEDED = new Set(["v", "requestId", "op", "status", "outcome", "accepted", "data"])
const RESULT_FAILED = new Set(["v", "requestId", "op", "status", "outcome", "accepted", "failure"])
const RESULT_AMBIGUOUS = new Set(["v", "requestId", "op", "status", "outcome", "accepted", "transportUnknown"])
const OUTCOME_PLAIN = new Set(["type", "time"])
const OUTCOME_FAILED = new Set(["type", "time", "failure"])

// eslint-disable-next-line complexity
export function validateAgentListResult(raw: unknown, req: AgentListContractRequest): AgentListResult {
  if (!record(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.op !== "agent/list") throw new Error("op mismatch")
  const status = raw.status
  if (status !== "succeeded" && status !== "failed" && status !== "ambiguous")
    throw new Error("status must be succeeded/failed/ambiguous")
  if (typeof raw.accepted !== "boolean") throw new Error("accepted must be boolean")
  const outcome = raw.outcome
  if (!record(outcome) || typeof outcome.type !== "string" || typeof outcome.time !== "number")
    throw new Error("outcome invalid")
  if (outcome.type !== status) throw new Error("outcome.type must match status")
  if (!Number.isFinite(outcome.time) || outcome.time < 0) throw new Error("outcome.time invalid")
  const rec = raw as Record<string, unknown>
  const outRec = outcome as Record<string, unknown>
  if (status === "succeeded") {
    for (const k of Object.keys(rec)) if (!RESULT_SUCCEEDED.has(k)) throw new Error(`unexpected result field ${k}`)
    for (const k of Object.keys(outRec)) if (!OUTCOME_PLAIN.has(k)) throw new Error(`unexpected outcome field ${k}`)
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    const data = rec.data
    if (!record(data)) throw new Error("succeeded data must be object")
    validateAgentListData(data)
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (outRec.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as AgentListResult
  }
  if (status === "failed") {
    for (const k of Object.keys(rec)) if (!RESULT_FAILED.has(k)) throw new Error(`unexpected result field ${k}`)
    for (const k of Object.keys(outRec)) if (!OUTCOME_FAILED.has(k)) throw new Error(`unexpected outcome field ${k}`)
    const failure = validateAgentListFailure(rec.failure)
    const outFailure = validateAgentListFailure(outRec.failure)
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    if (rec.data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as AgentListResult
  }
  for (const k of Object.keys(rec)) if (!RESULT_AMBIGUOUS.has(k)) throw new Error(`unexpected result field ${k}`)
  for (const k of Object.keys(outRec)) if (!OUTCOME_PLAIN.has(k)) throw new Error(`unexpected outcome field ${k}`)
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (outRec.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as AgentListResult
}

export function isSettledAgentListResult(result: unknown, req: AgentListContractRequest): boolean {
  if (!record(result)) return false
  const kind = (result as { status?: unknown }).status
  if (kind !== "succeeded" && kind !== "failed") return false
  try {
    const out = validateAgentListResult(result, req)
    if (out.status === "succeeded") return true
    if (out.status === "failed") return out.failure.retryable === false
    return false
  } catch {
    return false
  }
}
