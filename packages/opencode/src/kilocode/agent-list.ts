import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { canonicalDirectory } from "@/kilocode/session/canonical-directory"
import {
  acquireDrainControl,
  InstanceUnavailableDuringConfigRebuildError,
} from "@/kilocode/server/drain-control-acquire"
import { InstanceRef } from "@/effect/instance-ref"

export const VERSION = 1 as const
export const OP = "agent/list" as const
export const CAPABILITY = "agent/list" as const

export interface AgentListRequest {
  v: typeof VERSION
  requestId: string
  op: typeof OP
  context: {
    directory: string
    workspace?: string
  }
  payload: Record<string, never>
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

export interface AgentListFailure {
  code: string
  message: string
  retryable: boolean
}

export interface AgentListSucceeded {
  v: typeof VERSION
  requestId: string
  op: typeof OP
  status: "succeeded"
  outcome: { type: "succeeded"; time: number }
  accepted: true
  data: AgentListData
}

export interface AgentListFailed {
  v: typeof VERSION
  requestId: string
  op: typeof OP
  status: "failed"
  outcome: { type: "failed"; time: number; failure: AgentListFailure }
  accepted: false
  failure: AgentListFailure
}

export interface AgentListAmbiguous {
  v: typeof VERSION
  requestId: string
  op: typeof OP
  status: "ambiguous"
  outcome: { type: "ambiguous"; time: number }
  accepted: false
  transportUnknown?: boolean
}

export type AgentListResult = AgentListSucceeded | AgentListFailed | AgentListAmbiguous

export const VALIDATION_MESSAGE = "invalid agent-list request"
export const SCOPE_MESSAGE = "directory mismatch"
export const FENCE_MESSAGE =
  "Instance is unavailable during config rebuild; no active runtime for this request"
export const INTERNAL_MESSAGE = "internal error"

export class AgentListInternal extends Error {
  readonly _tag = "AgentListInternal" as const
  constructor() {
    super(INTERNAL_MESSAGE)
    this.name = "AgentListInternal"
  }
}

function record(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function present(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

function pathless(v: string): boolean {
  return !v.includes("/") && !v.includes("\\") && !v.includes("\0")
}

function noNul(v: unknown): v is string {
  return typeof v === "string" && !v.includes("\0")
}

export function validateAgentListRequest(raw: unknown): AgentListRequest {
  if (!record(raw)) throw new Error("params must be object")
  if (raw.v !== VERSION) throw new Error("v must be 1")
  if (!present(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!pathless(raw.requestId as string)) throw new Error("requestId must be non-empty string without path material")
  if (raw.op !== OP) throw new Error("op must be agent/list")
  const ctx = raw.context
  if (!record(ctx)) throw new Error("context must be object")
  const allowedCtx = new Set(["directory", "workspace"])
  for (const k of Object.keys(ctx)) if (!allowedCtx.has(k)) throw new Error("unexpected context field")
  if (typeof ctx.directory !== "string" || ctx.directory.length === 0)
    throw new Error("context.directory must be non-empty string")
  canonicalDirectory(ctx.directory)
  if (ctx.workspace !== undefined) {
    if (typeof ctx.workspace !== "string" || ctx.workspace.length === 0 || (ctx.workspace as string).includes("\0"))
      throw new Error("context.workspace must be non-empty string when present")
  }
  const payload = raw.payload
  if (!record(payload)) throw new Error("payload must be object")
  if (Object.keys(payload).length !== 0) throw new Error("payload must be empty object for agent-list")
  const allowedRoot = new Set(["v", "requestId", "op", "context", "payload"])
  for (const k of Object.keys(raw)) if (!allowedRoot.has(k)) throw new Error("unexpected field")
  return raw as unknown as AgentListRequest
}

type Ids = { requestId: string }

function sanitized(v: unknown): string {
  if (typeof v !== "string" || v.length === 0 || !pathless(v)) return "unknown"
  return v
}

export function fallbackAgentListIds(raw: unknown): Ids {
  const o = (record(raw) ? raw : {}) as Record<string, unknown>
  return { requestId: sanitized(o.requestId) }
}

export function safeAgentListIds(req: { requestId: string }): Ids {
  return { requestId: sanitized(req.requestId) }
}

export function failed(ids: Ids, code: string, message: string, retryable: boolean): AgentListFailed {
  const failure = { code, message, retryable }
  return {
    v: VERSION,
    requestId: ids.requestId,
    op: OP,
    status: "failed",
    outcome: { type: "failed", time: Date.now(), failure },
    accepted: false,
    failure,
  }
}

export function succeeded(req: AgentListRequest, data: AgentListData): AgentListSucceeded {
  return {
    v: VERSION,
    requestId: req.requestId,
    op: OP,
    status: "succeeded",
    outcome: { type: "succeeded", time: Date.now() },
    accepted: true,
    data,
  }
}

export function ambiguous(req: AgentListRequest, transportUnknown = true): AgentListAmbiguous {
  const out: AgentListAmbiguous = {
    v: VERSION,
    requestId: req.requestId,
    op: OP,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) out.transportUnknown = true
  return out
}

const ENTRY_FIELDS = new Set([
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
  // Canonical `Schema.String` allows empty: presence + string (no NUL) only.
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
  for (const k of Object.keys(raw)) if (!ENTRY_FIELDS.has(k)) throw new Error(`unexpected agent field ${k}`)
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
  const permission = (raw.permission as unknown[]).map(checkPermissionRule)
  if (raw.model !== undefined) checkModel(raw.model)
  if (raw.variant !== undefined && !noNul(raw.variant)) throw new Error("agent.variant invalid")
  if (raw.prompt !== undefined && !noNul(raw.prompt)) throw new Error("agent.prompt invalid")
  if (!record(raw.options)) throw new Error("agent.options must be object")
  if (raw.requirements !== undefined) checkRequirements(raw.requirements)
  if (raw.steps !== undefined) {
    if (typeof raw.steps !== "number" || !Number.isFinite(raw.steps)) throw new Error("agent.steps invalid")
  }
  return raw as unknown as AgentListEntry
}

export function validateAgentListEntries(raw: unknown): AgentListEntry[] {
  if (!Array.isArray(raw)) throw new Error("agents must be array")
  return (raw as unknown[]).map((item) => validateAgentListEntry(item))
}

export function validateAgentListData(raw: unknown): AgentListData {
  if (!record(raw)) throw new Error("data must be object")
  const allowed = new Set(["agents"])
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new Error("unexpected data field")
  return { agents: validateAgentListEntries(raw.agents) }
}

const RESULT_SUCCEEDED = new Set(["v", "requestId", "op", "status", "outcome", "accepted", "data"])
const RESULT_FAILED = new Set(["v", "requestId", "op", "status", "outcome", "accepted", "failure"])
const RESULT_AMBIGUOUS = new Set(["v", "requestId", "op", "status", "outcome", "accepted", "transportUnknown"])
const OUTCOME_PLAIN = new Set(["type", "time"])
const OUTCOME_FAILED = new Set(["type", "time", "failure"])
const FAILURE_FIELDS = new Set(["code", "message", "retryable"])

function checkFailure(raw: unknown): AgentListFailure {
  if (!record(raw)) throw new Error("failure must be object")
  for (const k of Object.keys(raw)) if (!FAILURE_FIELDS.has(k)) throw new Error("unexpected failure field")
  if (!present(raw.code)) throw new Error("failure code must be non-empty string")
  if (!present(raw.message)) throw new Error("failure message must be non-empty string")
  if (typeof raw.retryable !== "boolean") throw new Error("failure retryable must be boolean")
  return raw as unknown as AgentListFailure
}

export function validateAgentListResult(raw: unknown, req: AgentListRequest): AgentListResult {
  if (!record(raw)) throw new Error("result must be object")
  if (raw.v !== VERSION) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.op !== OP) throw new Error("op mismatch")
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
  const out = outcome as Record<string, unknown>
  if (status === "succeeded") {
    for (const k of Object.keys(rec)) if (!RESULT_SUCCEEDED.has(k)) throw new Error("unexpected result field")
    for (const k of Object.keys(out)) if (!OUTCOME_PLAIN.has(k)) throw new Error("unexpected outcome field")
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    validateAgentListData(rec.data)
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (out.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as AgentListSucceeded
  }
  if (status === "failed") {
    for (const k of Object.keys(rec)) if (!RESULT_FAILED.has(k)) throw new Error("unexpected result field")
    for (const k of Object.keys(out)) if (!OUTCOME_FAILED.has(k)) throw new Error("unexpected outcome field")
    if (raw.accepted !== false) throw new Error("failed accepted must be false")
    const failure = checkFailure(rec.failure)
    const outFailure = checkFailure(out.failure)
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    if (rec.data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as AgentListFailed
  }
  for (const k of Object.keys(rec)) if (!RESULT_AMBIGUOUS.has(k)) throw new Error("unexpected result field")
  for (const k of Object.keys(out)) if (!OUTCOME_PLAIN.has(k)) throw new Error("unexpected outcome field")
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (out.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as AgentListAmbiguous
}

export function isSettledAgentListResult(result: unknown, req: AgentListRequest): boolean {
  if (!record(result)) return false
  const status = (result as { status?: unknown }).status
  if (status !== "succeeded" && status !== "failed") return false
  try {
    const out = validateAgentListResult(result, req)
    if (out.status === "succeeded") return true
    if (out.status === "failed") return out.failure.retryable === false
    return false
  } catch {
    return false
  }
}

// Shared `agent.list` read body for HTTP + fd. Only `Agent.Service.list()` —
// the same owner and result as `GET /agent` (`identifier: "app.agents"`).
// No `InstanceRef` manual construction, no drain/read lease, no external
// network, no secret, no cache. `directory`/`workspace` are carrier routing
// identity only and never reach the service beyond `InstanceState` selection
// performed by the caller lane. The wire projection is the exact
// `Agent.Info` shape (full SDK wire, not the UI subset); unknown fields are
// rejected so provider credentials or hidden runtime state can never cross.
export const fetchAgentListData = (): Effect.Effect<Agent.Info[], never, Agent.Service> =>
  Effect.gen(function* () {
    const svc = yield* Agent.Service
    const list = yield* svc.list().pipe(Effect.catch(() => Effect.die(new AgentListInternal())))
    try {
      const entries = validateAgentListEntries(list)
      return entries as unknown as Agent.Info[]
    } catch {
      return yield* Effect.die(new AgentListInternal())
    }
  })

// Private `agent/list`: routing-only directory validation, then the shared
// read via the existing drain-control + `InstanceRef` lane (same lane as
// `skill/list`/`command/list` — no new lifecycle lane, no manual
// `InstanceRef` construction, no new drain/read lease, no journal/replay).
// `directory`/`workspace` are carrier routing identity only; `workspace`
// never reaches the service. Read-only, safely repeatable: an ambiguous
// transport outcome may safely repeat via the same-directory SDK
// `client.app.agents` fallback; the op never retries.
export const agentListPrivate = Effect.fn("AgentListPrivate.read")(function* (raw: unknown) {
  let req: AgentListRequest
  try {
    req = validateAgentListRequest(raw)
  } catch {
    return failed(fallbackAgentListIds(raw), "validation.failed", VALIDATION_MESSAGE, false)
  }
  const safe = safeAgentListIds(req)
  let dir: string
  try {
    dir = canonicalDirectory(req.context.directory)
  } catch {
    return failed(safe, "validation.failed", VALIDATION_MESSAGE, false)
  }
  if (req.context.workspace !== undefined) {
    const ws = req.context.workspace
    if (typeof ws !== "string" || ws.length === 0 || ws.includes("\0"))
      return failed(safe, "validation.failed", VALIDATION_MESSAGE, false)
  }
  const acquired = yield* acquireDrainControl(dir).pipe(
    Effect.map((v) => ({ tag: "ok" as const, value: v })),
    Effect.catch((err: unknown) => {
      const fence =
        err instanceof InstanceUnavailableDuringConfigRebuildError ||
        (err as { _tag?: string })?._tag === "InstanceUnavailableDuringConfigRebuild"
      const code = fence ? "InstanceUnavailableDuringConfigRebuild" : "internal"
      const message = fence ? FENCE_MESSAGE : INTERNAL_MESSAGE
      return Effect.succeed({ tag: "fail" as const, result: failed(safe, code, message, fence) })
    }),
    Effect.catchDefect(() => Effect.succeed({ tag: "fail" as const, result: failed(safe, "internal", INTERNAL_MESSAGE, false) })),
  )
  if (acquired.tag !== "ok") return acquired.result
  const inner = Effect.gen(function* () {
    let stored: string
    try {
      stored = canonicalDirectory(acquired.value.ctx.directory)
    } catch {
      return failed(safe, "internal", INTERNAL_MESSAGE, false)
    }
    if (stored !== dir) return failed(safe, "scope_mismatch", SCOPE_MESSAGE, false)
    const out = yield* fetchAgentListData().pipe(
      Effect.map((agents) => ({ tag: "ok" as const, agents })),
      Effect.catch(() => Effect.succeed({ tag: "fail" as const })),
      Effect.catchDefect(() => Effect.succeed({ tag: "fail" as const })),
    )
    if (out.tag !== "ok") return failed(safe, "internal", INTERNAL_MESSAGE, false)
    try {
      validateAgentListEntries(out.agents)
    } catch {
      return failed(safe, "internal", INTERNAL_MESSAGE, false)
    }
    return succeeded(req, { agents: out.agents })
  }).pipe(Effect.provideService(InstanceRef, acquired.value.ctx), Effect.ensuring(acquired.value.release))
  return yield* inner.pipe(
    Effect.catch(() => Effect.succeed(failed(safe, "internal", INTERNAL_MESSAGE, false))),
    Effect.catchDefect(() => Effect.succeed(failed(safe, "internal", INTERNAL_MESSAGE, false))),
  )
})
