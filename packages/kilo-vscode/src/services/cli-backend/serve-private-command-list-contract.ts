// Private-first `command/list` instance-inventory contract (production).
// Strict request/result validation plus the safe consumer projection
// (`{name, description?, source?, hints?}`). The FD carrier invokes the same
// `Command.Service.list()` used by `GET /command`; the extension
// `loadCommands` is private-first with exactly one SDK `client.command.list`
// fallback. `template` (lazy promise content), `agent`, `model`, and
// `subtask` never cross the boundary.
//
// Source facts (read-only, not imported):
// - Route: `GET /command` with `WorkspaceRoutingQuery` (`directory?`,
//   `workspace?`) in
//   `packages/opencode/src/server/routes/instance/httpapi/groups/instance.ts`
//   (`identifier: "command.list"`, success `Array(Command.Info)`).
// - Handler: `packages/opencode/src/server/routes/instance/httpapi/handlers/instance.ts`
//   `getCommand` returns `command.list()` with no filter arguments.
// - Service: `packages/opencode/src/command/index.ts` `Command.list()`
//   (`Info[]`); `Info` = `{name, description?, agent?, model?,
//   source? ("command"|"mcp"|"skill"), template (Unknown, lazy promise),
//   subtask?, hints (string[])}`. `list()` is duplicate-aware: `Object.values`
//   plus one extra `fromSkill(item)` entry when a skill shares a name with a
//   non-skill command (`names.has(item.name)` push), so one skill/non-skill
//   same-name pair (two entries, same `name`, different `source`) is a legal
//   production shape.
// - SDK: `client.command.list({directory})` issues `GET /command` and remains
//   the exactly-one fallback for retryable/unavailable/invalid/ambiguous/
//   transport/closed/timeout outcomes.
// - Consumer: `packages/kilo-vscode/src/kilo-provider/commands.ts`
//   `loadCommands` maps each entry to `{name, description, source, hints}`
//   only, preserving the carrier's `Command.Service.list()` order;
//   `agent`/`model`/`template`/`subtask` never cross that boundary.
// - Distinct from `session/command` (per-session command execution),
//   `v2.command.list` (`GET /api/command`), `app.agents`, and `app.skills`.
//   This contract never matches those operations.

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

export function canonicalCommandListOpId(token: string): string {
  if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
  if (token.includes(":")) throw new TypeError("token must not contain ':'")
  return `command-list:${token}`
}

export function parseCommandListOpId(opId: string): { token: string } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  const segs = opId.split(":")
  if (segs.length !== 2) throw new TypeError(`command-list opId must be command-list:<token>: ${opId}`)
  if (segs[0] !== "command-list") throw new TypeError(`opId kind must be command-list: ${opId}`)
  const token = segs[1]!
  if (token.length === 0) throw new TypeError(`opId segment must be non-empty: ${opId}`)
  return { token }
}

export interface CommandListContractRequest {
  v: 1
  requestId: string
  opId: string
  op: "command/list"
  idempotencyKey: string
  context: {
    directory: string
    workspace?: string
  }
  payload: Record<string, never>
}

// eslint-disable-next-line complexity
export function validateCommandListContractRequest(raw: unknown): CommandListContractRequest {
  if (!isRecord(raw)) throw new Error("request must be object")
  if (raw.v !== 1) throw new Error("v must be 1")
  if (!isNonEmpty(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmpty(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== "command/list") throw new Error("op must be command/list")
  if (!isNonEmpty(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId for command-list contract")
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
  if (Object.keys(payload as Record<string, unknown>).length !== 0) throw new Error("payload must be empty object for command-list contract")
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw as Record<string, unknown>)) if (!allowedRoot.has(k)) throw new Error(`unexpected field ${k}`)
  parseCommandListOpId(raw.opId as string)
  const idem = parseCommandListOpId(raw.idempotencyKey as string)
  if (idem.token !== parseCommandListOpId(raw.opId as string).token) throw new Error("idempotencyKey token must equal opId token")
  return raw as unknown as CommandListContractRequest
}

export type CommandListScopeWhich = "directory" | "workspace" | "request"

export type CommandListScopeCheck =
  | { ok: true }
  | { ok: false; code: "scope_mismatch"; which: CommandListScopeWhich }

export function checkCommandListScope(
  req: CommandListContractRequest,
  expected: { directory: string; workspace?: string; token: string },
): CommandListScopeCheck {
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
  const parsed = parseCommandListOpId(req.opId)
  if (parsed.token !== expected.token) return { ok: false, code: "scope_mismatch", which: "request" }
  const bound = canonicalCommandListOpId(expected.token)
  if (req.opId !== bound || req.idempotencyKey !== bound) return { ok: false, code: "scope_mismatch", which: "request" }
  return { ok: true }
}

// Safe command summary projection: the consumer subset
// (`kilo-provider/commands.ts` maps `{name, description, source, hints}`).
// `template` (lazy promise content), `agent`, `model`, `subtask`, and any raw
// secret material are excluded by design so fixtures cannot carry prompt
// content and no template/agent/model/subtask meaning is inferred.
// Duplicate names are legal: production `Command.list()` keeps one
// skill/non-skill same-name pair as two entries with the same `name` and
// different `source`, so entry validation never enforces name uniqueness.
export interface CommandListEntry {
  name: string
  description?: string
  source?: "command" | "mcp" | "skill"
  hints?: string[]
}

const COMMAND_LIST_ENTRY_FIELDS = new Set(["name", "description", "source", "hints"])
const COMMAND_LIST_ENTRY_SOURCES = new Set(["command", "mcp", "skill"])

export function validateCommandListEntry(raw: unknown): CommandListEntry {
  if (!isRecord(raw)) throw new Error("command entry must be object")
  assertAllowedKeys(raw as Record<string, unknown>, COMMAND_LIST_ENTRY_FIELDS, "command-entry")
  if (!isNonEmpty(raw.name)) throw new Error("command-entry.name must be non-empty string")
  if (raw.description !== undefined && typeof raw.description !== "string") throw new Error("command-entry.description must be string when present")
  if (raw.source !== undefined && (typeof raw.source !== "string" || !COMMAND_LIST_ENTRY_SOURCES.has(raw.source as string))) {
    throw new Error("command-entry.source must be command/mcp/skill when present")
  }
  if (raw.hints !== undefined) {
    if (!Array.isArray(raw.hints)) throw new Error("command-entry.hints must be string array when present")
    for (const h of raw.hints as unknown[]) if (typeof h !== "string") throw new Error("command-entry.hints must be string array when present")
  }
  return raw as unknown as CommandListEntry
}

export function validateCommandListEntries(raw: unknown): CommandListEntry[] {
  if (!Array.isArray(raw)) throw new Error("commands must be array")
  return (raw as unknown[]).map((item) => validateCommandListEntry(item))
}

export interface CommandListFailure {
  code: string
  message: string
  retryable: boolean
}

const COMMAND_LIST_FAILURE_FORBIDDEN = new Set([
  "command",
  "commands",
  "template",
  "agent",
  "model",
  "subtask",
  "hints",
  "source",
  "prompt",
  "tool",
  "error",
  "raw",
  "output",
  "detail",
  "directory",
  "workspace",
])

const COMMAND_LIST_FAILURE_FIELDS = new Set(["code", "message", "retryable"])

export function validateCommandListFailure(raw: unknown): CommandListFailure {
  if (!isRecord(raw)) throw new Error("failure must be object")
  for (const k of Object.keys(raw)) {
    if (COMMAND_LIST_FAILURE_FORBIDDEN.has(k)) throw new Error(`failure must not carry ${k}`)
  }
  assertAllowedKeys(raw as Record<string, unknown>, COMMAND_LIST_FAILURE_FIELDS, "failure")
  if (!isNonEmpty(raw.code)) throw new Error("failure code must be non-empty string")
  if (!isNonEmpty(raw.message)) throw new Error("failure message must be non-empty string")
  if (typeof raw.retryable !== "boolean") throw new Error("failure retryable must be boolean")
  return raw as unknown as CommandListFailure
}

export type CommandListResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: "command/list"
      idempotencyKey: string
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: { commands: CommandListEntry[] }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "command/list"
      idempotencyKey: string
      status: "failed"
      outcome: { type: "failed"; time: number; failure: CommandListFailure }
      accepted: boolean
      failure: CommandListFailure
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "command/list"
      idempotencyKey: string
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      transportUnknown?: boolean
    }

export function makeCommandListAmbiguous(req: CommandListContractRequest, transportUnknown = true): CommandListResult {
  const out: CommandListResult = {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "command/list",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

export type CommandListWireOutcome =
  | { kind: "valid"; result: CommandListResult }
  | { kind: "invalid"; detail: string }

export class CommandListValidationError extends Error {
  readonly kind = "private-command-list-validation" as const
  readonly detail: string
  constructor(detail: string) {
    super(`invalid private response shape: ${detail}`)
    this.name = "CommandListValidationError"
    this.detail = detail
  }
}

export function isCommandListValidationError(v: unknown): v is CommandListValidationError {
  return !!v && typeof v === "object" && (v as { kind?: unknown }).kind === "private-command-list-validation"
}

export function normalizePrivateCommandListWire(raw: unknown, req: CommandListContractRequest): CommandListWireOutcome {
  try {
    const result = validateCommandListResult(raw, req)
    return { kind: "valid", result }
  } catch (e) {
    const detail = String(e instanceof Error ? e.message : e).slice(0, 200)
    return { kind: "invalid", detail }
  }
}

const COMMAND_LIST_RESULT_SUCCEEDED = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "status", "outcome", "accepted", "data"])
const COMMAND_LIST_RESULT_FAILED = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "status", "outcome", "accepted", "failure"])
const COMMAND_LIST_RESULT_AMBIGUOUS = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "status", "outcome", "accepted", "transportUnknown"])
const COMMAND_LIST_OUTCOME_PLAIN = new Set(["type", "time"])
const COMMAND_LIST_OUTCOME_FAILED = new Set(["type", "time", "failure"])

// eslint-disable-next-line complexity
export function validateCommandListResult(raw: unknown, req: CommandListContractRequest): CommandListResult {
  if (!isRecord(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== "command/list") throw new Error("op mismatch")
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
    assertAllowedKeys(rec, COMMAND_LIST_RESULT_SUCCEEDED, "result")
    assertAllowedKeys(outRec, COMMAND_LIST_OUTCOME_PLAIN, "outcome")
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    const data = rec.data
    if (!isRecord(data)) throw new Error("succeeded data must be object")
    const allowedData = new Set(["commands"])
    for (const k of Object.keys(data as Record<string, unknown>)) if (!allowedData.has(k)) throw new Error(`unexpected data field ${k}`)
    validateCommandListEntries((data as Record<string, unknown>).commands)
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (outRec.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as CommandListResult
  }
  if (status === "failed") {
    assertAllowedKeys(rec, COMMAND_LIST_RESULT_FAILED, "result")
    assertAllowedKeys(outRec, COMMAND_LIST_OUTCOME_FAILED, "outcome")
    const failure = validateCommandListFailure(rec.failure)
    const outFailure = validateCommandListFailure(outRec.failure)
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    if (rec.data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as CommandListResult
  }
  assertAllowedKeys(rec, COMMAND_LIST_RESULT_AMBIGUOUS, "result")
  assertAllowedKeys(outRec, COMMAND_LIST_OUTCOME_PLAIN, "outcome")
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean") throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (outRec.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as CommandListResult
}


