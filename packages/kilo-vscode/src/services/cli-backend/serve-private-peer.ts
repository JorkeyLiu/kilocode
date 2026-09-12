/* eslint-disable max-lines */
import { isAbsolute, normalize, resolve } from "path"
import { JsonRpcPeer } from "../../private-worker/peer"
import type { ChildProcess } from "child_process"
import {
  makeGetAmbiguous,
  normalizePrivateGetWire,
  PrivateGetValidationError,
  validateGetRequest,
} from "./serve-private-get"
import type { PrivateGetWireOutcome, ServePrivateGetRequest, ServePrivateGetResult } from "./serve-private-get"
import {
  makeMessagesAmbiguous,
  normalizePrivateMessagesWire,
  PrivateMessagesValidationError,
  validateMessagesRequest,
} from "./serve-private-messages"
import type {
  PrivateMessagesWireOutcome,
  ServePrivateMessagesRequest,
  ServePrivateMessagesResult,
} from "./serve-private-messages"
import { makeChildrenCancel, requestChildrenOutcome, validateChildrenRequest } from "./serve-private-children"
import { handleProviderExecute, isProviderExecuteAvailable, PROVIDER_EXECUTE_METHOD } from "./serve-private-provider-execute"
import {
  handleProviderHttpExecute,
  isProviderHttpExecuteAvailable,
  PROVIDER_HTTP_EXECUTE_METHOD,
} from "./serve-private-provider-http-execute"
import type { PrivateChildrenWireOutcome, ServePrivateChildrenRequest } from "./serve-private-children"
import {
  makeSessionModelUsageAmbiguous,
  normalizePrivateSessionModelUsageWire,
  SessionModelUsageValidationError,
  validateSessionModelUsageContractRequest,
  validateSessionModelUsageResult,
} from "./serve-private-session-model-usage-contract"
import type {
  SessionModelUsageContractRequest,
  SessionModelUsageResult,
  SessionModelUsageWireOutcome,
} from "./serve-private-session-model-usage-contract"
import {
  isAgentRequirementsValidationError,
  makeAgentRequirementsAmbiguous,
  normalizePrivateAgentRequirementsWire,
  validateAgentRequirementsContractRequest,
  validateAgentRequirementsResult,
} from "./serve-private-agent-requirements-contract"
import type {
  AgentRequirementsContractRequest,
  AgentRequirementsResult,
  AgentRequirementsWireOutcome,
} from "./serve-private-agent-requirements-contract"
import { AgentRequirementsValidationError } from "./serve-private-agent-requirements-contract"
import {
  makeSkillRemoveAmbiguous,
  normalizePrivateSkillRemoveWire,
  SkillRemoveValidationError,
  validateSkillRemoveContractRequest,
} from "./serve-private-skill-remove-contract"
import type {
  SkillRemoveContractRequest,
  SkillRemoveResult,
  SkillRemoveWireOutcome,
} from "./serve-private-skill-remove-contract"
import {
  makeRemoteStatusCancel,
  PrivateRemoteStatusValidationError,
  requestRemoteStatusOutcome,
  validateRemoteStatusRequest,
} from "./serve-private-remote-status"
import type {
  PrivateRemoteStatusWireOutcome,
  ServePrivateRemoteStatusRequest,
  ServePrivateRemoteStatusResult,
} from "./serve-private-remote-status"
import { validateSessionListContractRequest as validateSessionListRequest } from "./serve-private-session-list-contract"
import { requestSessionListOutcome } from "./serve-private-session-list"
import type {
  PrivateSessionListWireOutcome,
  ServePrivateSessionListRequest,
} from "./serve-private-session-list-contract"
import { validateCommandListContractRequest as validateCommandListRequest } from "./serve-private-command-list-contract"
import { CommandListValidationError } from "./serve-private-command-list-contract"
import { requestCommandListOutcome } from "./serve-private-command-list"
import type {
  CommandListContractRequest,
  CommandListResult,
  CommandListWireOutcome,
} from "./serve-private-command-list-contract"
import { validateConfigWarningsContractRequest as validateConfigWarningsRequest } from "./serve-private-config-warnings-contract"
import type { ConfigWarningsContractRequest, ConfigWarningsWireOutcome } from "./serve-private-config-warnings-contract"
import {
  configWarningsObserverTimeoutBranch,
  makeConfigWarningsCancel,
  requestConfigWarningsOutcome,
} from "./serve-private-config-warnings"
import { validateProjectCurrentContractRequest as validateProjectCurrentRequest } from "./serve-private-project-current-contract"
import type { ProjectCurrentContractRequest, ProjectCurrentWireOutcome } from "./serve-private-project-current-contract"
import {
  makeProjectCurrentCancel,
  projectCurrentObserverTimeoutBranch,
  requestProjectCurrentOutcome,
} from "./serve-private-project-current"
import { validateFindFilesContractRequest as validateFindFilesRequest } from "./serve-private-find-files-contract"
import type { FindFilesContractRequest, FindFilesWireOutcome } from "./serve-private-find-files-contract"
import { FindFilesValidationError } from "./serve-private-find-files-contract"
import {
  findFilesObserverTimeoutBranch,
  makeFindFilesCancel,
  requestFindFilesOutcome,
} from "./serve-private-find-files"
import {
  canonicalPathOpId,
  comparePathParity,
  isPathValidationError,
  makePathAmbiguous,
  normalizePrivatePathWire,
  PathValidationError,
  validatePathContractRequest,
  validatePathResult,
} from "./serve-private-path-contract"
import type { PathContractRequest, PathResult, PathWireOutcome } from "./serve-private-path-contract"
import { failedPathResult, pathObserverTimeoutBranch, requestPathOutcome } from "./serve-private-path"
import {
  assertGenerationNotRequestIdentity,
  makeAbortAmbiguous,
  validateAbortContractRequest,
  validateAbortDispositionEntry,
  validateAbortDispositionTerminal,
  validateAbortTerminalFailure,
} from "./serve-private-abort-contract"
import type {
  AbortAmbiguous,
  AbortContractRequest,
  AbortDispositionTerminal,
  AbortTerminalFailure,
} from "./serve-private-abort-contract"
import {
  makeQuestionAmbiguous,
  validateQuestionRejectContractRequest,
  validateQuestionReplyContractRequest,
  validateQuestionReplyResult,
  validateQuestionRejectResult,
  validateQuestionTerminalFailure,
} from "./serve-private-question-contract"
import {
  canonicalPromptOpId,
  makePromptAmbiguous,
  normalizePrivatePromptWire,
  PrivatePromptValidationError,
  validatePromptContractRequest,
  validatePromptResult,
} from "./serve-private-prompt-contract"
import {
  makeRevertAmbiguous,
  makeUnrevertAmbiguous,
  validateRevertRequest,
  validateRevertResult,
  validateUnrevertRequest,
  validateUnrevertResult,
} from "./serve-private-revert-contract"
import type {
  ServePrivateRevertRequest,
  ServePrivateRevertResult,
  ServePrivateUnrevertRequest,
  ServePrivateUnrevertResult,
} from "./serve-private-revert-contract"
import type { PromptContractRequest, PromptResult, PrivatePromptWireOutcome } from "./serve-private-prompt-contract"
import {
  makeCommandAmbiguous,
  normalizePrivateCommandWire,
  PrivateCommandValidationError,
  validateCommandContractRequest,
  validateCommandResult,
} from "./serve-private-command-contract"
import type { CommandContractRequest, CommandResult, PrivateCommandWireOutcome } from "./serve-private-command-contract"
import type {
  QuestionAmbiguous,
  QuestionContractRequest,
  QuestionRejectContractRequest,
  QuestionReplyContractRequest,
  QuestionTerminal,
  QuestionTerminalFailure,
} from "./serve-private-question-contract"
import {
  makePermissionAmbiguous,
  validatePermissionReplyContractRequest,
  validatePermissionReplyResult,
  validatePermissionSaveContractRequest,
  validatePermissionSaveResult,
  validatePermissionTerminalFailure,
} from "./serve-private-permission-contract"
import {
  makePermissionListAmbiguous,
  normalizePrivatePermissionListWire,
  validatePermissionListContractRequest,
  validatePermissionListResult,
} from "./serve-private-permission-list-contract"
import type {
  PermissionListContractRequest,
  PermissionListResult,
  PermissionListWireOutcome,
} from "./serve-private-permission-list-contract"
import {
  makeMcpStatusAmbiguous,
  normalizePrivateMcpStatusWire,
  validateMcpStatusContractRequest,
} from "./serve-private-mcp-status-contract"
import type {
  McpStatusContractRequest,
  McpStatusResult,
  McpStatusWireOutcome,
} from "./serve-private-mcp-status-contract"
import {
  makeMcpConnectAmbiguous,
  makeMcpDisconnectAmbiguous,
  normalizePrivateMcpConnectWire,
  normalizePrivateMcpDisconnectWire,
  validateMcpConnectContractRequest,
  validateMcpDisconnectContractRequest,
} from "./serve-private-mcp-connection-contract"
import type {
  McpConnectContractRequest,
  McpConnectWireOutcome,
  McpDisconnectContractRequest,
  McpDisconnectWireOutcome,
} from "./serve-private-mcp-connection-contract"
import type {
  PermissionAmbiguous,
  PermissionContractRequest,
  PermissionReplyContractRequest,
  PermissionSaveContractRequest,
  PermissionTerminal,
  PermissionTerminalFailure,
} from "./serve-private-permission-contract"

export {
  canonicalGetOpId,
  compareGetParity,
  isPrivateGetValidationError,
  makeGetAmbiguous,
  normalizePrivateGetWire,
  PrivateGetValidationError,
  validateGetRequest,
  validateGetResult,
} from "./serve-private-get"
export type { PrivateGetWireOutcome, ServePrivateGetRequest, ServePrivateGetResult } from "./serve-private-get"
export {
  canonicalMessagesOpId,
  compareMessagesParity,
  isPrivateMessagesValidationError,
  makeMessagesAmbiguous,
  normalizePrivateMessagesWire,
  PrivateMessagesValidationError,
  validateMessagesRequest,
  validateMessagesResult,
} from "./serve-private-messages"
export type {
  PrivateMessagesWireOutcome,
  ServePrivateMessagesRequest,
  ServePrivateMessagesResult,
} from "./serve-private-messages"
export {
  canonicalChildrenOpId,
  compareChildrenParity,
  isPrivateChildrenValidationError,
  makeChildrenAmbiguous,
  normalizePrivateChildrenWire,
  PrivateChildrenValidationError,
  validateChildrenRequest,
  validateChildrenResult,
} from "./serve-private-children"
export type {
  PrivateChildrenWireOutcome,
  ServePrivateChildrenRequest,
  ServePrivateChildrenResult,
} from "./serve-private-children"
export {
  canonicalSessionModelUsageOpId,
  checkSessionModelUsageScope,
  isSessionModelUsageValidationError,
  makeSessionModelUsageAmbiguous,
  normalizePrivateSessionModelUsageWire,
  parseSessionModelUsageOpId,
  SessionModelUsageValidationError,
  validateSessionModelUsageContractRequest,
  validateSessionModelUsageFailure,
  validateSessionModelUsagePayload,
  validateSessionModelUsageResult,
} from "./serve-private-session-model-usage-contract"
export type {
  SessionModelUsageContractRequest,
  SessionModelUsagePayload,
  SessionModelUsageResult,
  SessionModelUsageWireOutcome,
} from "./serve-private-session-model-usage-contract"
export {
  canonicalAgentRequirementsOpId,
  checkAgentRequirementsScope,
  isAgentRequirementsValidationError,
  makeAgentRequirementsAmbiguous,
  normalizePrivateAgentRequirementsWire,
  parseAgentRequirementsOpId,
  AgentRequirementsValidationError,
  validateAgentRequirementsContractRequest,
  validateAgentRequirementsFailure,
  validateAgentRequirementsPayload,
  validateAgentRequirementsResult,
} from "./serve-private-agent-requirements-contract"
export type {
  AgentRequirementsContractRequest,
  AgentRequirementsPayload,
  AgentRequirementsResult,
  AgentRequirementsWireOutcome,
} from "./serve-private-agent-requirements-contract"
export {
  canonicalSkillRemoveOpId,
  makeSkillRemoveAmbiguous,
  normalizePrivateSkillRemoveWire,
  parseSkillRemoveOpId,
  SkillRemoveValidationError,
  validateSkillRemoveContractRequest,
  validateSkillRemoveResult,
} from "./serve-private-skill-remove-contract"
export type {
  SkillRemoveContractRequest,
  SkillRemoveResult,
  SkillRemoveWireOutcome,
} from "./serve-private-skill-remove-contract"
export {
  canonicalRemoteStatusOpId,
  compareRemoteStatusParity,
  failedRemoteStatusResult,
  isPrivateRemoteStatusValidationError,
  makeRemoteStatusAmbiguous,
  makeRemoteStatusCancel,
  normalizePrivateRemoteStatusWire,
  PrivateRemoteStatusValidationError,
  requestRemoteStatusOutcome,
  validateRemoteStatusRequest,
  validateRemoteStatusResult,
  wrapRemoteStatusOutcomeForOwner,
} from "./serve-private-remote-status"
export type {
  PrivateRemoteStatusWireOutcome,
  ServePrivateRemoteStatusRequest,
  ServePrivateRemoteStatusResult,
} from "./serve-private-remote-status"
export {
  canonicalPathOpId,
  comparePathParity,
  isPathValidationError,
  makePathAmbiguous,
  normalizePrivatePathWire,
  PathValidationError,
  validatePathContractRequest,
  validatePathResult,
} from "./serve-private-path-contract"
export type { PathContractRequest, PathResult, PathWireOutcome } from "./serve-private-path-contract"
export {
  failedPathResult,
  PATH_TRANSPORT_FAILURE_MESSAGE,
  pathObserverTimeoutBranch,
  requestPathOutcome,
} from "./serve-private-path"
export interface ServePrivateCancelQueuedRequest {
  v: 1
  requestId: string
  opId: string
  op: "session/cancelQueued"
  idempotencyKey: string
  context: {
    directory: string
    sessionId: string
    parentSessionId?: string | null
    configVersion?: number
    sessionRevision?: number
  }
  payload: {
    messageId: string
  }
}

export type ServePrivateCancelQueuedResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/cancelQueued"
      idempotencyKey: string
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: { cancelled: boolean }
      revision?: { session: number; config: number }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/cancelQueued"
      idempotencyKey: string
      status: "failed"
      outcome: {
        type: "failed"
        time: number
        failure: { code: string; message: string; retryable: boolean; detail?: string }
      }
      accepted: boolean
      failure: { code: string; message: string; retryable: boolean; detail?: string }
      revision?: { session: number; config: number }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/cancelQueued"
      idempotencyKey: string
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      revision?: { session: number; config: number }
      transportUnknown?: boolean
    }

export function canonicalCancelQueuedOpId(sessionId: string, messageId: string): string {
  return `cancelQueued:${sessionId}:${messageId}`
}

export function canonicalSessionUpdateOpId(sessionId: string, token?: string): string {
  if (token !== undefined) {
    if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
    if (token.includes(":")) throw new TypeError("token must not contain ':'")
    return `sessionUpdate:${sessionId}:${token}`
  }
  return `sessionUpdate:${sessionId}`
}

export function canonicalForkOpId(sessionId: string, token?: string): string {
  if (token !== undefined) {
    if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
    if (token.includes(":")) throw new TypeError("token must not contain ':'")
    return `fork:${sessionId}:${token}`
  }
  return `fork:${sessionId}`
}

export function canonicalCreateOpId(token: string): string {
  if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
  if (token.includes(":")) throw new TypeError("token must not contain ':'")
  return `create:${token}`
}

function canonicalDeleteOpId(sessionId: string, token: string): string {
  if (typeof sessionId !== "string" || sessionId.length === 0) throw new TypeError("sessionId must be non-empty string")
  if (sessionId.includes(":")) throw new TypeError("sessionId must not contain ':'")
  if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
  if (token.includes(":")) throw new TypeError("token must not contain ':'")
  return `delete:${sessionId}:${token}`
}

export function buildStatusOpId(token: string): string {
  if (typeof token !== "string" || token.length === 0) throw new TypeError("token must be non-empty string")
  if (token.includes(":")) throw new TypeError("token must not contain ':'")
  return `status:${token}`
}

export interface ServePrivateStatusRequest {
  v: 1
  requestId: string
  opId: string
  op: "session/status"
  idempotencyKey: string
  context: {
    directory: string
  }
  payload: Record<string, never>
}

export type ServePrivateStatusResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/status"
      idempotencyKey: string
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: { statuses: Record<string, Record<string, unknown>> }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/status"
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
      op: "session/status"
      idempotencyKey: string
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      transportUnknown?: boolean
    }

function makeStatusAmbiguous(req: ServePrivateStatusRequest, transportUnknown = true): ServePrivateStatusResult {
  const out: ServePrivateStatusResult = {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/status",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

export function validateStatusRequest(raw: unknown): ServePrivateStatusRequest {
  if (!isRecord(raw)) throw new Error("request must be object")
  if (raw.v !== 1) throw new Error("v must be 1")
  if (!isNonEmptyString(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmptyString(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== "session/status") throw new Error("op must be session/status")
  if (!isNonEmptyString(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId for status")
  const ctx = raw.context
  if (!isRecord(ctx)) throw new Error("context must be object")
  const allowedCtx = new Set(["directory"])
  for (const k of Object.keys(ctx as Record<string, unknown>))
    if (!allowedCtx.has(k)) throw new Error(`unexpected context field ${k}`)
  if (
    typeof ctx.directory !== "string" ||
    !isAbsolute(ctx.directory as string) ||
    (ctx.directory as string).includes("\0")
  )
    throw new Error("context.directory must be absolute path")
  const payload = raw.payload
  if (!isRecord(payload)) throw new Error("payload must be object")
  if (Object.keys(payload as Record<string, unknown>).length !== 0)
    throw new Error("payload must be empty object for status")
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw as Record<string, unknown>))
    if (!allowedRoot.has(k)) throw new Error(`unexpected field ${k}`)
  return raw as unknown as ServePrivateStatusRequest
}

const STATUS_TYPES = new Set(["idle", "busy", "retry", "offline"])
const STATUS_RETRY_ACTION_FIELDS = new Set(["reason", "provider", "title", "message", "label", "link"])

function isQuestionId(v: unknown): boolean {
  return typeof v === "string" && (v as string).startsWith("que")
}

function validateStatusAction(sid: string, action: unknown): void {
  if (!isRecord(action)) throw new Error(`statuses[${sid}].action invalid`)
  const rec = action as Record<string, unknown>
  for (const f of ["reason", "provider", "title", "message", "label"]) {
    if (typeof rec[f] !== "string") throw new Error(`statuses[${sid}].action.${f} invalid`)
  }
  if (rec.link !== undefined && typeof rec.link !== "string") throw new Error(`statuses[${sid}].action.link invalid`)
  for (const k of Object.keys(rec)) {
    if (!STATUS_RETRY_ACTION_FIELDS.has(k)) throw new Error(`unexpected statuses[${sid}].action field ${k}`)
  }
}

function validateStatusEntry(sid: string, entry: unknown): void {
  if (!isRecord(entry)) throw new Error(`statuses[${sid}] must be object`)
  const rec = entry as Record<string, unknown>
  const type = rec.type
  if (typeof type !== "string" || !STATUS_TYPES.has(type)) throw new Error(`statuses[${sid}].type invalid`)
  if (type === "idle" || type === "busy") {
    for (const k of Object.keys(rec)) {
      if (k !== "type") throw new Error(`unexpected statuses[${sid}] field ${k}`)
    }
    return
  }
  if (type === "retry") {
    if (!isSafeInt(rec.attempt)) throw new Error(`statuses[${sid}].attempt invalid`)
    if (typeof rec.message !== "string") throw new Error(`statuses[${sid}].message invalid`)
    if (!isSafeInt(rec.next)) throw new Error(`statuses[${sid}].next invalid`)
    if (rec.action !== undefined) validateStatusAction(sid, rec.action)
    const allowed = new Set(["type", "attempt", "message", "action", "next"])
    for (const k of Object.keys(rec)) {
      if (!allowed.has(k)) throw new Error(`unexpected statuses[${sid}] field ${k}`)
    }
    return
  }
  if (!isQuestionId(rec.requestID)) throw new Error(`statuses[${sid}].requestID invalid`)
  if (typeof rec.message !== "string") throw new Error(`statuses[${sid}].message invalid`)
  const allowed = new Set(["type", "requestID", "message"])
  for (const k of Object.keys(rec)) {
    if (!allowed.has(k)) throw new Error(`unexpected statuses[${sid}] field ${k}`)
  }
}

const STATUS_RESULT_ROOT_SUCCEEDED = new Set([
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
const STATUS_RESULT_ROOT_FAILED = new Set([
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
const STATUS_RESULT_ROOT_AMBIGUOUS = new Set([
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
const STATUS_FAILURE_FIELDS = new Set(["code", "message", "retryable", "detail"])
const STATUS_OUTCOME_SUCCEEDED_FIELDS = new Set(["type", "time"])
const STATUS_OUTCOME_FAILED_FIELDS = new Set(["type", "time", "failure"])
const STATUS_OUTCOME_AMBIGUOUS_FIELDS = new Set(["type", "time"])

/**
 * Type-honest wire normalization for `session/status` (LOCK-008/LOCK-013).
 * A raw wire payload is either a strictly valid private status result or an
 * invalid-wire diagnostic. Invalid wire is never a normal `failed` result and
 * never reaches `compareStatusParity` or SDK state.
 */
export type PrivateStatusWireOutcome =
  | { kind: "valid"; result: ServePrivateStatusResult }
  | { kind: "invalid"; detail: string }

export class PrivateStatusValidationError extends Error {
  readonly kind = "private-status-validation" as const
  readonly detail: string
  constructor(detail: string) {
    super(`invalid private response shape: ${detail}`)
    this.name = "PrivateStatusValidationError"
    this.detail = detail
  }
}

export function isPrivateStatusValidationError(v: unknown): v is PrivateStatusValidationError {
  return !!v && typeof v === "object" && (v as { kind?: unknown }).kind === "private-status-validation"
}

export function normalizePrivateStatusWire(raw: unknown, req: ServePrivateStatusRequest): PrivateStatusWireOutcome {
  try {
    const result = validateStatusResult(raw, req)
    return { kind: "valid", result }
  } catch (e) {
    const detail = String(e instanceof Error ? e.message : e).slice(0, 200)
    return { kind: "invalid", detail }
  }
}

function assertFailureDetailMirror(top: Record<string, unknown>, out: Record<string, unknown>): void {
  const hasTop = top.detail !== undefined
  const hasOut = out.detail !== undefined
  if (!hasTop && !hasOut) return
  if (hasTop !== hasOut) throw new Error("failure detail presence mismatch")
  if (top.detail !== out.detail) throw new Error("failure detail mismatch")
}

function assertAllowedKeys(rec: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const k of Object.keys(rec)) if (!allowed.has(k)) throw new Error(`unexpected ${label} field ${k}`)
}

function validateStatusFailureShape(v: unknown, label: string): Record<string, unknown> {
  if (!isRecord(v)) throw new Error(`${label} invalid`)
  assertAllowedKeys(v as Record<string, unknown>, STATUS_FAILURE_FIELDS, label)
  const rec = v as Record<string, unknown>
  if (typeof rec.code !== "string" || typeof rec.message !== "string" || typeof rec.retryable !== "boolean")
    throw new Error(`${label} invalid`)
  if (rec.detail !== undefined && typeof rec.detail !== "string")
    throw new Error(`${label}.detail must be string if present`)
  return rec
}

// eslint-disable-next-line complexity
export function validateStatusResult(raw: unknown, req: ServePrivateStatusRequest): ServePrivateStatusResult {
  if (!isRecord(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== "session/status") throw new Error("op mismatch")
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
    assertAllowedKeys(rec, STATUS_RESULT_ROOT_SUCCEEDED, "result")
    assertAllowedKeys(outRec, STATUS_OUTCOME_SUCCEEDED_FIELDS, "outcome")
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    if (rec.transportUnknown !== undefined) throw new Error("succeeded must not have transportUnknown")
    if (rec.revision !== undefined) throw new Error("revision not accepted for status result")
    const data = rec.data
    if (!isRecord(data)) throw new Error("succeeded data must be object")
    const allowedData = new Set(["statuses"])
    for (const k of Object.keys(data as Record<string, unknown>))
      if (!allowedData.has(k)) throw new Error(`unexpected data field ${k}`)
    const statuses = (data as Record<string, unknown>).statuses
    if (!isRecord(statuses)) throw new Error("succeeded data.statuses must be object")
    for (const [sid, entry] of Object.entries(statuses as Record<string, unknown>)) validateStatusEntry(sid, entry)
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (outRec.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    if (outRec.data !== undefined) throw new Error("succeeded outcome must not have data")
    return raw as unknown as ServePrivateStatusResult
  }
  if (status === "failed") {
    assertAllowedKeys(rec, STATUS_RESULT_ROOT_FAILED, "result")
    assertAllowedKeys(outRec, STATUS_OUTCOME_FAILED_FIELDS, "outcome")
    if (rec.transportUnknown !== undefined) throw new Error("failed must not have transportUnknown")
    if (rec.revision !== undefined) throw new Error("revision not accepted for status result")
    if (rec.configVersion !== undefined) throw new Error("configVersion not accepted for status result")
    if (rec.sessionRevision !== undefined) throw new Error("sessionRevision not accepted for status result")
    const failure = validateStatusFailureShape(rec.failure, "failed failure")
    const outFailure = validateStatusFailureShape(outRec.failure, "failed outcome.failure")
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    assertFailureDetailMirror(failure, outFailure)
    if (rec.data !== undefined) throw new Error("failed must not have data")
    if (outRec.data !== undefined) throw new Error("failed outcome must not have data")
    return raw as unknown as ServePrivateStatusResult
  }
  assertAllowedKeys(rec, STATUS_RESULT_ROOT_AMBIGUOUS, "result")
  assertAllowedKeys(outRec, STATUS_OUTCOME_AMBIGUOUS_FIELDS, "outcome")
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.revision !== undefined) throw new Error("revision not accepted for status result")
  if (rec.configVersion !== undefined) throw new Error("configVersion not accepted for status result")
  if (rec.sessionRevision !== undefined) throw new Error("sessionRevision not accepted for status result")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (outRec.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  if (outRec.data !== undefined) throw new Error("ambiguous outcome must not have data")
  return raw as unknown as ServePrivateStatusResult
}

const SESSION_TITLE_LIMIT = 200
const unsafeTitle = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u
function validateTitleStrict(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("payload.title must be non-empty string")
  const value = raw.trim()
  if (!value) throw new Error("payload.title must be non-empty string")
  if (value.length > SESSION_TITLE_LIMIT) throw new Error("payload.title too long")
  if (unsafeTitle.test(value)) throw new Error("payload.title contains control characters")
  return value
}
function isSessionId(v: unknown): boolean {
  return typeof v === "string" && (v as string).startsWith("ses")
}
function isMessageId(v: unknown): boolean {
  return typeof v === "string" && (v as string).startsWith("msg")
}
function canonicalDir(dir: string): string {
  return normalize(resolve(dir))
}
function parseSessionUpdateOpId(opId: string): { kind: string; parts: string[] } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  const segs = opId.split(":")
  if (segs.length < 2) throw new TypeError(`opId must contain ':'`)
  const kind = segs[0]!
  if (kind !== "sessionUpdate") throw new TypeError(`opId kind must be sessionUpdate: ${opId}`)
  const rest = segs.slice(1)
  for (const p of rest) if (p.length === 0) throw new TypeError(`opId segment must be non-empty: ${opId}`)
  if (rest.length !== 1 && rest.length !== 2)
    throw new TypeError(`sessionUpdate opId must have 1 or 2 segments: ${opId}`)
  return { kind, parts: rest }
}

export interface ServePrivateSessionUpdateRequest {
  v: 1
  requestId: string
  opId: string
  op: "session/update"
  idempotencyKey: string
  context: {
    directory: string
    sessionId: string
    parentSessionId?: string | null
    configVersion?: number
    sessionRevision?: number
  }
  payload: {
    title: string
  }
}

export type ServePrivateSessionUpdateResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/update"
      idempotencyKey: string
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: { session: Record<string, unknown>; title?: string } | { title: string; session?: Record<string, unknown> }
      revision?: { session: number; config: number }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/update"
      idempotencyKey: string
      status: "failed"
      outcome: {
        type: "failed"
        time: number
        failure: { code: string; message: string; retryable: boolean; detail?: string }
      }
      accepted: boolean
      failure: { code: string; message: string; retryable: boolean; detail?: string }
      revision?: { session: number; config: number }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/update"
      idempotencyKey: string
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      revision?: { session: number; config: number }
      transportUnknown?: boolean
    }

export interface ServePrivateForkRequest {
  v: 1
  requestId: string
  opId: string
  op: "session/fork"
  idempotencyKey: string
  context: {
    directory: string
    sessionId: string
    parentSessionId?: string | null
    configVersion?: number
    sessionRevision?: number
  }
  payload: {
    messageId?: string | null
  }
}

export type ServePrivateForkResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/fork"
      idempotencyKey: string
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: { session: Record<string, unknown> }
      revision?: { session: number; config: number }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/fork"
      idempotencyKey: string
      status: "failed"
      outcome: {
        type: "failed"
        time: number
        failure: { code: string; message: string; retryable: boolean; detail?: string }
      }
      accepted: boolean
      failure: { code: string; message: string; retryable: boolean; detail?: string }
      revision?: { session: number; config: number }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/fork"
      idempotencyKey: string
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      revision?: { session: number; config: number }
      transportUnknown?: boolean
    }

function makeAmbiguous(req: ServePrivateCancelQueuedRequest, transportUnknown = true): ServePrivateCancelQueuedResult {
  const out: ServePrivateCancelQueuedResult = {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/cancelQueued",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

function makeFailedInternal(
  req: ServePrivateCancelQueuedRequest,
  message: string,
  code = "internal",
): ServePrivateCancelQueuedResult {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/cancelQueued",
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: Date.now(), failure: { code, message, retryable: false } },
    accepted: false,
    failure: { code, message, retryable: false },
  }
}

function makeUpdateAmbiguous(
  req: ServePrivateSessionUpdateRequest,
  transportUnknown = true,
): ServePrivateSessionUpdateResult {
  const out: ServePrivateSessionUpdateResult = {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/update",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

function makeUpdateFailedInternal(
  req: ServePrivateSessionUpdateRequest,
  message: string,
  code = "internal",
): ServePrivateSessionUpdateResult {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/update",
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: Date.now(), failure: { code, message, retryable: false } },
    accepted: false,
    failure: { code, message, retryable: false },
  }
}

function makeForkAmbiguous(req: ServePrivateForkRequest, transportUnknown = true): ServePrivateForkResult {
  const out: ServePrivateForkResult = {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/fork",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

export interface ServePrivateCreateRequest {
  v: 1
  requestId: string
  opId: string
  op: "session/create"
  idempotencyKey: string
  context: {
    directory: string
    parentSessionId?: string | null
    configVersion?: number
  }
  payload: {
    title?: string | null
    parentID?: string | null
    platform?: string | null
    metadata?: Record<string, unknown> | null
  }
}

export type ServePrivateCreateResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/create"
      idempotencyKey: string
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: { session: Record<string, unknown> }
      revision?: { session: number; config: number }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/create"
      idempotencyKey: string
      status: "failed"
      outcome: {
        type: "failed"
        time: number
        failure: { code: string; message: string; retryable: boolean; detail?: string }
      }
      accepted: boolean
      failure: { code: string; message: string; retryable: boolean; detail?: string }
      revision?: { session: number; config: number }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/create"
      idempotencyKey: string
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      revision?: { session: number; config: number }
      transportUnknown?: boolean
    }

function makeCreateAmbiguous(req: ServePrivateCreateRequest, transportUnknown = true): ServePrivateCreateResult {
  const out: ServePrivateCreateResult = {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/create",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

function makeCreateFailedInternal(
  req: ServePrivateCreateRequest,
  message: string,
  code = "internal",
): ServePrivateCreateResult {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/create",
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: Date.now(), failure: { code, message, retryable: false } },
    accepted: false,
    failure: { code, message, retryable: false },
  }
}

export interface ServePrivateDeleteRequest {
  v: 1
  requestId: string
  opId: string
  op: "session/delete"
  idempotencyKey: string
  context: {
    directory: string
    sessionId: string
    parentSessionId?: string | null
    configVersion?: number
    sessionRevision?: number
  }
  payload: Record<string, never>
}

export type ServePrivateDeleteResult =
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/delete"
      idempotencyKey: string
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: Record<string, never>
      revision?: { session: number; config: number }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/delete"
      idempotencyKey: string
      status: "failed"
      outcome: {
        type: "failed"
        time: number
        failure: { code: string; message: string; retryable: boolean; detail?: string }
      }
      accepted: boolean
      failure: { code: string; message: string; retryable: boolean; detail?: string }
      revision?: { session: number; config: number }
    }
  | {
      v: 1
      requestId: string
      opId: string
      op: "session/delete"
      idempotencyKey: string
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      revision?: { session: number; config: number }
      transportUnknown?: boolean
    }

function makeDeleteAmbiguous(req: ServePrivateDeleteRequest, transportUnknown = true): ServePrivateDeleteResult {
  const out: ServePrivateDeleteResult = {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/delete",
    idempotencyKey: req.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

function makeDeleteFailedInternal(
  req: ServePrivateDeleteRequest,
  message: string,
  code = "internal",
): ServePrivateDeleteResult {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/delete",
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: Date.now(), failure: { code, message, retryable: false } },
    accepted: false,
    failure: { code, message, retryable: false },
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

export type ServePrivateAbortRequest = AbortContractRequest
export type ServePrivateAbortResult = AbortDispositionTerminal | AbortTerminalFailure | AbortAmbiguous

export function validateAbortRequest(raw: unknown): ServePrivateAbortRequest {
  return validateAbortContractRequest(raw)
}

export function validateAbortResult(raw: unknown, req: ServePrivateAbortRequest): ServePrivateAbortResult {
  if (!isRecord(raw)) throw new Error("result must be object")
  const kind = raw.kind
  if (kind === "terminal") {
    const out = validateAbortDispositionTerminal(raw)
    if (out.requestId !== req.requestId) throw new Error("requestId mismatch")
    if (out.opId !== req.opId) throw new Error("opId mismatch")
    if (out.idempotencyKey !== req.idempotencyKey) throw new Error("idempotencyKey mismatch")
    const refs = out.affected.map((e) => {
      validateAbortDispositionEntry(e)
      return { kind: "generation" as const, generationId: e.generationId, sessionId: e.sessionId }
    })
    assertGenerationNotRequestIdentity(req, refs)
    return out
  }
  if (kind === "terminal-failure") return validateAbortTerminalFailure(raw, req)
  throw new Error(`abort result kind must be terminal or terminal-failure, got ${String(kind)}`)
}

export type ServePrivateQuestionReplyRequest = QuestionReplyContractRequest
export type ServePrivateQuestionRejectRequest = QuestionRejectContractRequest
export type ServePrivateQuestionResult = QuestionTerminal | QuestionTerminalFailure | QuestionAmbiguous

export function validateQuestionReplyRequest(raw: unknown): ServePrivateQuestionReplyRequest {
  return validateQuestionReplyContractRequest(raw)
}

export function validateQuestionRejectRequest(raw: unknown): ServePrivateQuestionRejectRequest {
  return validateQuestionRejectContractRequest(raw)
}

export function validateQuestionReplyOutcome(
  raw: unknown,
  req: ServePrivateQuestionReplyRequest,
): ServePrivateQuestionResult {
  if (!isRecord(raw)) throw new Error("result must be object")
  const kind = raw.kind
  if (kind === "terminal") return validateQuestionReplyResult(raw, req)
  if (kind === "terminal-failure") return validateQuestionTerminalFailure(raw, req)
  if (kind === "ambiguous") {
    const allowed = new Set([
      "kind",
      "v",
      "requestId",
      "opId",
      "idempotencyKey",
      "accepted",
      "terminal",
      "transportUnknown",
    ])
    for (const k of Object.keys(raw)) {
      if (!allowed.has(k)) throw new Error(`unexpected ambiguous field ${k}`)
    }
    if (raw.v !== 1) throw new Error("v must be 1")
    if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
    if (raw.opId !== req.opId) throw new Error("opId mismatch")
    if (raw.idempotencyKey !== req.idempotencyKey) throw new Error("idempotencyKey mismatch")
    if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
    if (raw.terminal !== false) throw new Error("ambiguous terminal must be false")
    return raw as unknown as ServePrivateQuestionResult
  }
  throw new Error(`question reply result kind must be terminal, terminal-failure, or ambiguous, got ${String(kind)}`)
}

export function validateQuestionRejectOutcome(
  raw: unknown,
  req: ServePrivateQuestionRejectRequest,
): ServePrivateQuestionResult {
  if (!isRecord(raw)) throw new Error("result must be object")
  const kind = raw.kind
  if (kind === "terminal") return validateQuestionRejectResult(raw, req)
  if (kind === "terminal-failure") return validateQuestionTerminalFailure(raw, req)
  if (kind === "ambiguous") {
    const allowed = new Set([
      "kind",
      "v",
      "requestId",
      "opId",
      "idempotencyKey",
      "accepted",
      "terminal",
      "transportUnknown",
    ])
    for (const k of Object.keys(raw)) {
      if (!allowed.has(k)) throw new Error(`unexpected ambiguous field ${k}`)
    }
    if (raw.v !== 1) throw new Error("v must be 1")
    if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
    if (raw.opId !== req.opId) throw new Error("opId mismatch")
    if (raw.idempotencyKey !== req.idempotencyKey) throw new Error("idempotencyKey mismatch")
    if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
    if (raw.terminal !== false) throw new Error("ambiguous terminal must be false")
    return raw as unknown as ServePrivateQuestionResult
  }
  throw new Error(`question reject result kind must be terminal, terminal-failure, or ambiguous, got ${String(kind)}`)
}

export type ServePrivatePermissionSaveRequest = PermissionSaveContractRequest
export type ServePrivatePermissionReplyRequest = PermissionReplyContractRequest
export type ServePrivatePermissionResult = PermissionTerminal | PermissionTerminalFailure | PermissionAmbiguous

export function validatePermissionSaveRequest(raw: unknown): ServePrivatePermissionSaveRequest {
  return validatePermissionSaveContractRequest(raw)
}

export function validatePermissionReplyRequest(raw: unknown): ServePrivatePermissionReplyRequest {
  return validatePermissionReplyContractRequest(raw)
}

export function validatePermissionSaveOutcome(
  raw: unknown,
  req: ServePrivatePermissionSaveRequest,
): ServePrivatePermissionResult {
  if (!isRecord(raw)) throw new Error("result must be object")
  const kind = raw.kind
  if (kind === "terminal") return validatePermissionSaveResult(raw, req)
  if (kind === "terminal-failure") return validatePermissionTerminalFailure(raw, req)
  if (kind === "ambiguous") {
    const allowed = new Set(["kind", "v", "requestId", "opId", "idempotencyKey", "accepted", "terminal", "transportUnknown"])
    for (const k of Object.keys(raw)) {
      if (!allowed.has(k)) throw new Error(`unexpected ambiguous field ${k}`)
    }
    if (raw.v !== 1) throw new Error("v must be 1")
    if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
    if (raw.opId !== req.opId) throw new Error("opId mismatch")
    if (raw.idempotencyKey !== req.idempotencyKey) throw new Error("idempotencyKey mismatch")
    if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
    if (raw.terminal !== false) throw new Error("ambiguous terminal must be false")
    return raw as unknown as ServePrivatePermissionResult
  }
  throw new Error(`permission save result kind must be terminal, terminal-failure, or ambiguous, got ${String(kind)}`)
}

export function validatePermissionReplyOutcome(
  raw: unknown,
  req: ServePrivatePermissionReplyRequest,
): ServePrivatePermissionResult {
  if (!isRecord(raw)) throw new Error("result must be object")
  const kind = raw.kind
  if (kind === "terminal") return validatePermissionReplyResult(raw, req)
  if (kind === "terminal-failure") return validatePermissionTerminalFailure(raw, req)
  if (kind === "ambiguous") {
    const allowed = new Set(["kind", "v", "requestId", "opId", "idempotencyKey", "accepted", "terminal", "transportUnknown"])
    for (const k of Object.keys(raw)) {
      if (!allowed.has(k)) throw new Error(`unexpected ambiguous field ${k}`)
    }
    if (raw.v !== 1) throw new Error("v must be 1")
    if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
    if (raw.opId !== req.opId) throw new Error("opId mismatch")
    if (raw.idempotencyKey !== req.idempotencyKey) throw new Error("idempotencyKey mismatch")
    if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
    if (raw.terminal !== false) throw new Error("ambiguous terminal must be false")
    return raw as unknown as ServePrivatePermissionResult
  }
  throw new Error(`permission reply result kind must be terminal, terminal-failure, or ambiguous, got ${String(kind)}`)
}

function isNonEmptyString(v: unknown): boolean {
  return typeof v === "string" && v.length > 0
}

function isSafeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && Number.isSafeInteger(v)
}

function bestEffortDispose(peer: JsonRpcPeer | null, label: string): void {
  if (!peer) return
  try {
    peer.dispose()
  } catch (err) {
    console.warn(`[Kilo PrivatePeer] best-effort ${label} dispose failed:`, String(err))
  }
}

const PRIVATE_PROTOCOL_NAME = "kilo-private"
const PRIVATE_PROTOCOL_MAJOR = 1

// eslint-disable-next-line complexity
export function validateCancelQueuedRequest(raw: unknown): ServePrivateCancelQueuedRequest {
  if (!isRecord(raw)) throw new Error("request must be object")
  if (raw.v !== 1) throw new Error("v must be 1")
  if (!isNonEmptyString(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmptyString(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== "session/cancelQueued") throw new Error("op must be session/cancelQueued")
  if (!isNonEmptyString(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  const ctx = raw.context
  if (!isRecord(ctx)) throw new Error("context must be object")
  if (typeof ctx.directory !== "string" || ctx.directory.length === 0)
    throw new Error("context.directory must be non-empty string")
  if (typeof ctx.sessionId !== "string" || ctx.sessionId.length === 0)
    throw new Error("context.sessionId must be non-empty string")
  if (
    "parentSessionId" in ctx &&
    ctx.parentSessionId !== null &&
    ctx.parentSessionId !== undefined &&
    typeof ctx.parentSessionId !== "string"
  )
    throw new Error("context.parentSessionId must be string or null")
  if ("configVersion" in ctx && ctx.configVersion !== undefined && !isSafeInt(ctx.configVersion))
    throw new Error("context.configVersion must be integer >=0")
  if ("sessionRevision" in ctx && ctx.sessionRevision !== undefined && !isSafeInt(ctx.sessionRevision))
    throw new Error("context.sessionRevision must be integer >=0")
  const payload = raw.payload
  if (!isRecord(payload)) throw new Error("payload must be object")
  if (typeof payload.messageId !== "string" || payload.messageId.length === 0)
    throw new Error("payload.messageId must be non-empty string")
  const expected = canonicalCancelQueuedOpId(ctx.sessionId as string, payload.messageId as string)
  if (raw.opId !== expected) throw new Error(`opId must be canonical ${expected}`)
  return raw as unknown as ServePrivateCancelQueuedRequest
}

const CANCELQUEUED_RESULT_ROOT_SUCCEEDED = new Set([
  "v",
  "requestId",
  "opId",
  "op",
  "idempotencyKey",
  "status",
  "outcome",
  "accepted",
  "data",
  "revision",
])
const CANCELQUEUED_RESULT_ROOT_FAILED = new Set([
  "v",
  "requestId",
  "opId",
  "op",
  "idempotencyKey",
  "status",
  "outcome",
  "accepted",
  "failure",
  "revision",
])
const CANCELQUEUED_RESULT_ROOT_AMBIGUOUS = new Set([
  "v",
  "requestId",
  "opId",
  "op",
  "idempotencyKey",
  "status",
  "outcome",
  "accepted",
  "revision",
])
const CANCELQUEUED_OUTCOME_SUCCEEDED_FIELDS = new Set(["type", "time"])
const CANCELQUEUED_OUTCOME_FAILED_FIELDS = new Set(["type", "time", "failure"])
const CANCELQUEUED_OUTCOME_AMBIGUOUS_FIELDS = new Set(["type", "time"])
const CANCELQUEUED_FAILURE_FIELDS = new Set(["code", "message", "retryable", "detail"])
const CANCELQUEUED_DATA_FIELDS = new Set(["cancelled"])
const CANCELQUEUED_REVISION_FIELDS = new Set(["session", "config"])

function validateCancelQueuedFailureShape(v: unknown, label: string): Record<string, unknown> {
  if (!isRecord(v)) throw new Error(`${label} invalid`)
  assertAllowedKeys(v as Record<string, unknown>, CANCELQUEUED_FAILURE_FIELDS, label)
  const rec = v as Record<string, unknown>
  if (typeof rec.code !== "string" || typeof rec.message !== "string" || typeof rec.retryable !== "boolean")
    throw new Error(`${label} invalid`)
  if (rec.detail !== undefined && typeof rec.detail !== "string")
    throw new Error(`${label}.detail must be string if present`)
  return rec
}

function validateCancelQueuedRevision(v: unknown): void {
  if (v === undefined) return
  if (!isRecord(v)) throw new Error("revision must be {session,config} integers")
  assertAllowedKeys(v as Record<string, unknown>, CANCELQUEUED_REVISION_FIELDS, "revision")
  const rec = v as Record<string, unknown>
  if (!isSafeInt(rec.session) || !isSafeInt(rec.config)) throw new Error("revision must be {session,config} integers")
}

// eslint-disable-next-line complexity
export function validateCancelQueuedResult(
  raw: unknown,
  req: ServePrivateCancelQueuedRequest,
): ServePrivateCancelQueuedResult {
  if (!isRecord(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== "session/cancelQueued") throw new Error("op mismatch")
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
    assertAllowedKeys(rec, CANCELQUEUED_RESULT_ROOT_SUCCEEDED, "result")
    assertAllowedKeys(outRec, CANCELQUEUED_OUTCOME_SUCCEEDED_FIELDS, "outcome")
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    validateCancelQueuedRevision(rec.revision)
    const data = rec.data
    if (!isRecord(data)) throw new Error("succeeded data.cancelled must be boolean")
    assertAllowedKeys(data as Record<string, unknown>, CANCELQUEUED_DATA_FIELDS, "data")
    if (typeof (data as Record<string, unknown>).cancelled !== "boolean")
      throw new Error("succeeded data.cancelled must be boolean")
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (outRec.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    if (outRec.data !== undefined) throw new Error("succeeded outcome must not have data")
    return raw as unknown as ServePrivateCancelQueuedResult
  }
  if (status === "failed") {
    assertAllowedKeys(rec, CANCELQUEUED_RESULT_ROOT_FAILED, "result")
    assertAllowedKeys(outRec, CANCELQUEUED_OUTCOME_FAILED_FIELDS, "outcome")
    if (raw.accepted !== false) throw new Error("failed accepted must be false")
    validateCancelQueuedRevision(rec.revision)
    const failure = validateCancelQueuedFailureShape(rec.failure, "failed failure")
    const outFailure = validateCancelQueuedFailureShape(outRec.failure, "failed outcome.failure")
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    assertFailureDetailMirror(failure, outFailure)
    if (rec.data !== undefined) throw new Error("failed must not have data")
    if (outRec.data !== undefined) throw new Error("failed outcome must not have data")
    return raw as unknown as ServePrivateCancelQueuedResult
  }
  // ambiguous
  assertAllowedKeys(rec, CANCELQUEUED_RESULT_ROOT_AMBIGUOUS, "result")
  assertAllowedKeys(outRec, CANCELQUEUED_OUTCOME_AMBIGUOUS_FIELDS, "outcome")
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  validateCancelQueuedRevision(rec.revision)
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (outRec.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  if (outRec.data !== undefined) throw new Error("ambiguous outcome must not have data")
  return raw as unknown as ServePrivateCancelQueuedResult
}

// eslint-disable-next-line complexity
export function validateSessionUpdateRequest(raw: unknown): ServePrivateSessionUpdateRequest {
  if (!isRecord(raw)) throw new Error("request must be object")
  if (raw.v !== 1) throw new Error("v must be 1")
  if (!isNonEmptyString(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmptyString(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== "session/update") throw new Error("op must be session/update")
  if (!isNonEmptyString(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  const ctx = raw.context
  if (!isRecord(ctx)) throw new Error("context must be object")
  if (
    typeof ctx.directory !== "string" ||
    !isAbsolute(ctx.directory as string) ||
    (ctx.directory as string).includes("\0")
  )
    throw new Error("context.directory must be absolute path")
  if (!isSessionId(ctx.sessionId)) throw new Error("context.sessionId must be SessionID")
  // Private requires explicit parentSessionId === null (must be present and null, not omitted or non-null)
  if (!("parentSessionId" in ctx) || ctx.parentSessionId !== null)
    throw new Error("context.parentSessionId must be null")
  if ("configVersion" in ctx && ctx.configVersion !== undefined && !isSafeInt(ctx.configVersion))
    throw new Error("context.configVersion must be integer >=0")
  if ("sessionRevision" in ctx && ctx.sessionRevision !== undefined && !isSafeInt(ctx.sessionRevision))
    throw new Error("context.sessionRevision must be integer >=0")
  const payload = raw.payload
  if (!isRecord(payload)) throw new Error("payload must be object")
  if (typeof payload.title !== "string" || payload.title.length === 0)
    throw new Error("payload.title must be non-empty string")
  validateTitleStrict(payload.title)
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw as Record<string, unknown>))
    if (!allowedRoot.has(k)) throw new Error(`unexpected field ${k}`)
  const allowedCtx = new Set(["directory", "sessionId", "parentSessionId", "configVersion", "sessionRevision"])
  for (const k of Object.keys(ctx as Record<string, unknown>))
    if (!allowedCtx.has(k)) throw new Error(`unexpected context field ${k}`)
  const allowedPayload = new Set(["title"])
  for (const k of Object.keys(payload as Record<string, unknown>))
    if (!allowedPayload.has(k)) throw new Error(`unexpected payload field ${k}`)
  if (ctx.parentSessionId !== null && ctx.parentSessionId !== undefined)
    throw new Error("parentSessionId must be null for sessionUpdate")
  const opId = raw.opId as string
  if (opId === `sessionUpdate:${ctx.sessionId as string}`) {
    // base, no token
  } else if ((opId as string).startsWith(`sessionUpdate:${ctx.sessionId as string}:`)) {
    const token = (opId as string).slice(`sessionUpdate:${ctx.sessionId as string}:`.length)
    if (token.length === 0) throw new TypeError(`opId segment must be non-empty: ${opId}`)
    if (token.includes(":")) throw new TypeError(`token must not contain ':'`)
  } else {
    const parsed = parseSessionUpdateOpId(opId)
    if (parsed.parts[0] !== ctx.sessionId) throw new Error(`opId session binding mismatch: ${opId} vs ${ctx.sessionId}`)
  }
  return raw as unknown as ServePrivateSessionUpdateRequest
}

// eslint-disable-next-line complexity
export function validateSessionUpdateResult(
  raw: unknown,
  req: ServePrivateSessionUpdateRequest,
): ServePrivateSessionUpdateResult {
  if (!isRecord(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== "session/update") throw new Error("op mismatch")
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
  if ("revision" in raw && raw.revision !== undefined) {
    const rev = raw.revision as unknown
    if (
      !isRecord(rev) ||
      typeof rev.session !== "number" ||
      typeof rev.config !== "number" ||
      !isSafeInt(rev.session) ||
      !isSafeInt(rev.config)
    )
      throw new Error("revision must be {session,config} integers")
  }
  if ("transportUnknown" in raw && raw.transportUnknown !== undefined && typeof raw.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (status === "succeeded") {
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    const data = (raw as Record<string, unknown>).data
    if (!isRecord(data)) throw new Error("succeeded data must be object")
    const hasTitle =
      typeof (data as Record<string, unknown>).title === "string" &&
      ((data as Record<string, unknown>).title as string).length > 0
    const sess = (data as Record<string, unknown>).session
    const hasSessionTitle =
      isRecord(sess) &&
      typeof (sess as Record<string, unknown>).title === "string" &&
      ((sess as Record<string, unknown>).title as string).length > 0
    if (!hasTitle && !hasSessionTitle) throw new Error("succeeded data must contain title or session.title")
    if ((raw as Record<string, unknown>).failure !== undefined) throw new Error("succeeded must not have failure")
    if ((outcome as Record<string, unknown>).failure !== undefined)
      throw new Error("succeeded outcome must not have failure")
    return raw as unknown as ServePrivateSessionUpdateResult
  }
  if (status === "failed") {
    const failure = (raw as Record<string, unknown>).failure
    const outFailure = (outcome as Record<string, unknown>).failure
    if (
      !isRecord(failure) ||
      typeof failure.code !== "string" ||
      typeof failure.message !== "string" ||
      typeof failure.retryable !== "boolean"
    )
      throw new Error("failed failure invalid")
    if (
      !isRecord(outFailure) ||
      typeof outFailure.code !== "string" ||
      typeof outFailure.message !== "string" ||
      typeof outFailure.retryable !== "boolean"
    )
      throw new Error("failed outcome.failure invalid")
    if (failure.code !== (outFailure as Record<string, unknown>).code) throw new Error("failure code mismatch")
    if (failure.message !== (outFailure as Record<string, unknown>).message) throw new Error("failure message mismatch")
    if (failure.retryable !== (outFailure as Record<string, unknown>).retryable)
      throw new Error("failure retryable mismatch")
    const failureDetail = (failure as Record<string, unknown>).detail
    const outDetail = (outFailure as Record<string, unknown>).detail
    if (failureDetail !== undefined && typeof failureDetail !== "string")
      throw new Error("failed failure.detail must be string if present")
    if (outDetail !== undefined && typeof outDetail !== "string")
      throw new Error("failed outcome.failure.detail must be string if present")
    if (String(failureDetail ?? "") !== String(outDetail ?? "")) throw new Error("failure detail mismatch")
    if ((raw as Record<string, unknown>).data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as ServePrivateSessionUpdateResult
  }
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if ((raw as Record<string, unknown>).data !== undefined) throw new Error("ambiguous must not have data")
  if ((raw as Record<string, unknown>).failure !== undefined) throw new Error("ambiguous must not have failure")
  if ((outcome as Record<string, unknown>).failure !== undefined)
    throw new Error("ambiguous outcome must not have failure")
  if ((outcome as Record<string, unknown>).data !== undefined) throw new Error("ambiguous outcome must not have data")
  return raw as unknown as ServePrivateSessionUpdateResult
}

function parseForkOpId(opId: string): { kind: string; parts: string[] } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  const segs = opId.split(":")
  if (segs.length < 2) throw new TypeError(`opId must contain ':'`)
  const kind = segs[0]!
  if (kind !== "fork") throw new TypeError(`opId kind must be fork: ${opId}`)
  const rest = segs.slice(1)
  for (const p of rest) if (p.length === 0) throw new TypeError(`opId segment must be non-empty: ${opId}`)
  if (rest.length !== 1 && rest.length !== 2) throw new TypeError(`fork opId must have 1 or 2 segments: ${opId}`)
  return { kind, parts: rest }
}

// eslint-disable-next-line complexity
export function validateForkRequest(raw: unknown): ServePrivateForkRequest {
  if (!isRecord(raw)) throw new Error("request must be object")
  if (raw.v !== 1) throw new Error("v must be 1")
  if (!isNonEmptyString(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmptyString(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== "session/fork") throw new Error("op must be session/fork")
  if (!isNonEmptyString(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  const ctx = raw.context
  if (!isRecord(ctx)) throw new Error("context must be object")
  if (
    typeof ctx.directory !== "string" ||
    !isAbsolute(ctx.directory as string) ||
    (ctx.directory as string).includes("\0")
  )
    throw new Error("context.directory must be absolute path")
  if (!isSessionId(ctx.sessionId)) throw new Error("context.sessionId must be SessionID")
  if ("parentSessionId" in ctx && ctx.parentSessionId !== null && ctx.parentSessionId !== undefined)
    throw new Error("context.parentSessionId must be null")
  if ("configVersion" in ctx && ctx.configVersion !== undefined && !isSafeInt(ctx.configVersion))
    throw new Error("context.configVersion must be integer >=0")
  if ("sessionRevision" in ctx && ctx.sessionRevision !== undefined && !isSafeInt(ctx.sessionRevision))
    throw new Error("context.sessionRevision must be integer >=0")
  const payload = raw.payload
  if (!isRecord(payload)) throw new Error("payload must be object")
  if ("messageId" in payload && payload.messageId !== null && payload.messageId !== undefined) {
    if (!isMessageId(payload.messageId)) throw new Error("payload.messageId must be MessageID")
  }
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw as Record<string, unknown>))
    if (!allowedRoot.has(k)) throw new Error(`unexpected field ${k}`)
  const allowedCtx = new Set(["directory", "sessionId", "parentSessionId", "configVersion", "sessionRevision"])
  for (const k of Object.keys(ctx as Record<string, unknown>))
    if (!allowedCtx.has(k)) throw new Error(`unexpected context field ${k}`)
  const allowedPayload = new Set(["messageId"])
  for (const k of Object.keys(payload as Record<string, unknown>))
    if (!allowedPayload.has(k)) throw new Error(`unexpected payload field ${k}`)
  const opId = raw.opId as string
  // Backend authoritative SessionID predicate allows colon/space; opId must be exactly `fork:<sessionId>` or `fork:<sessionId>:<token>` with token non-empty no colon.
  if (opId === `fork:${ctx.sessionId as string}`) {
    // no token, ok
  } else if ((opId as string).startsWith(`fork:${ctx.sessionId as string}:`)) {
    const token = (opId as string).slice(`fork:${ctx.sessionId as string}:`.length)
    if (token.length === 0) throw new TypeError(`opId segment must be non-empty: ${opId}`)
    if (token.includes(":")) throw new TypeError(`token must not contain ':'`)
  } else {
    // fallback to strict parser for non-colon sessionIds to preserve error shape
    const parsed = parseForkOpId(opId)
    if (parsed.parts[0] !== ctx.sessionId) throw new Error(`opId session binding mismatch: ${opId} vs ${ctx.sessionId}`)
  }
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId for fork")
  const idem = raw.idempotencyKey as string
  if (idem === `fork:${ctx.sessionId as string}`) {
  } else if (idem.startsWith(`fork:${ctx.sessionId as string}:`)) {
    const token = idem.slice(`fork:${ctx.sessionId as string}:`.length)
    if (token.length === 0) throw new TypeError(`idempotencyKey segment must be non-empty: ${idem}`)
    if (token.includes(":")) throw new TypeError(`idempotencyKey token must not contain ':'`)
  } else {
    const parsed = parseForkOpId(idem)
    if (parsed.parts[0] !== ctx.sessionId)
      throw new Error(`idempotencyKey session binding mismatch: ${idem} vs ${ctx.sessionId}`)
  }
  return raw as unknown as ServePrivateForkRequest
}

// eslint-disable-next-line complexity
export function validateForkResult(raw: unknown, req: ServePrivateForkRequest): ServePrivateForkResult {
  if (!isRecord(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== "session/fork") throw new Error("op mismatch")
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
  if ("revision" in raw && raw.revision !== undefined) {
    const rev = raw.revision as unknown
    if (
      !isRecord(rev) ||
      typeof rev.session !== "number" ||
      typeof rev.config !== "number" ||
      !isSafeInt(rev.session) ||
      !isSafeInt(rev.config)
    )
      throw new Error("revision must be {session,config} integers")
  }
  if ("transportUnknown" in raw && raw.transportUnknown !== undefined && typeof raw.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (status === "succeeded") {
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    const data = (raw as Record<string, unknown>).data
    if (!isRecord(data) || !isRecord((data as Record<string, unknown>).session))
      throw new Error("succeeded data.session must be object")
    if ((raw as Record<string, unknown>).failure !== undefined) throw new Error("succeeded must not have failure")
    if ((outcome as Record<string, unknown>).failure !== undefined)
      throw new Error("succeeded outcome must not have failure")
    return raw as unknown as ServePrivateForkResult
  }
  if (status === "failed") {
    const failure = (raw as Record<string, unknown>).failure
    const outFailure = (outcome as Record<string, unknown>).failure
    if (
      !isRecord(failure) ||
      typeof failure.code !== "string" ||
      typeof failure.message !== "string" ||
      typeof failure.retryable !== "boolean"
    )
      throw new Error("failed failure invalid")
    if (
      !isRecord(outFailure) ||
      typeof outFailure.code !== "string" ||
      typeof outFailure.message !== "string" ||
      typeof outFailure.retryable !== "boolean"
    )
      throw new Error("failed outcome.failure invalid")
    if (failure.code !== (outFailure as Record<string, unknown>).code) throw new Error("failure code mismatch")
    if (failure.message !== (outFailure as Record<string, unknown>).message) throw new Error("failure message mismatch")
    if (failure.retryable !== (outFailure as Record<string, unknown>).retryable)
      throw new Error("failure retryable mismatch")
    if ((raw as Record<string, unknown>).data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as ServePrivateForkResult
  }
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if ((raw as Record<string, unknown>).data !== undefined) throw new Error("ambiguous must not have data")
  if ((raw as Record<string, unknown>).failure !== undefined) throw new Error("ambiguous must not have failure")
  if ((outcome as Record<string, unknown>).failure !== undefined)
    throw new Error("ambiguous outcome must not have failure")
  if ((outcome as Record<string, unknown>).data !== undefined) throw new Error("ambiguous outcome must not have data")
  return raw as unknown as ServePrivateForkResult
}

function parseCreateOpId(opId: string): { kind: string; parts: string[] } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  const segs = opId.split(":")
  if (segs.length < 2) throw new TypeError(`opId must contain ':'`)
  const kind = segs[0]!
  if (kind !== "create") throw new TypeError(`opId kind must be create: ${opId}`)
  const rest = segs.slice(1)
  for (const p of rest) if (p.length === 0) throw new TypeError(`opId segment must be non-empty: ${opId}`)
  if (rest.length !== 1) throw new TypeError(`create opId must have 1 segment: ${opId}`)
  return { kind, parts: rest }
}

// eslint-disable-next-line complexity
export function validateCreateRequest(raw: unknown): ServePrivateCreateRequest {
  if (!isRecord(raw)) throw new Error("request must be object")
  if (raw.v !== 1) throw new Error("v must be 1")
  if (!isNonEmptyString(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmptyString(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== "session/create") throw new Error("op must be session/create")
  if (!isNonEmptyString(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  const ctx = raw.context
  if (!isRecord(ctx)) throw new Error("context must be object")
  if (
    typeof ctx.directory !== "string" ||
    !isAbsolute(ctx.directory as string) ||
    (ctx.directory as string).includes("\0")
  )
    throw new Error("context.directory must be absolute path")
  if ("parentSessionId" in ctx && ctx.parentSessionId !== null && ctx.parentSessionId !== undefined)
    throw new Error("context.parentSessionId must be null")
  if ("configVersion" in ctx && ctx.configVersion !== undefined && !isSafeInt(ctx.configVersion))
    throw new Error("context.configVersion must be integer >=0")
  const payload = raw.payload
  if (!isRecord(payload)) throw new Error("payload must be object")
  if ("title" in payload && payload.title !== null && payload.title !== undefined) {
    if (typeof payload.title !== "string") throw new Error("payload.title must be string")
    validateTitleStrict(payload.title)
  }
  if ("parentID" in payload && payload.parentID !== null && payload.parentID !== undefined) {
    if (!isSessionId(payload.parentID)) throw new Error("payload.parentID must be SessionID")
  }
  if ("platform" in payload && payload.platform !== null && payload.platform !== undefined) {
    if (typeof payload.platform !== "string") throw new Error("payload.platform must be string")
  }
  if ("metadata" in payload && payload.metadata !== null && payload.metadata !== undefined) {
    if (!isRecord(payload.metadata)) throw new Error("payload.metadata must be object")
  }
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw as Record<string, unknown>))
    if (!allowedRoot.has(k)) throw new Error(`unexpected field ${k}`)
  const allowedCtx = new Set(["directory", "parentSessionId", "configVersion"])
  for (const k of Object.keys(ctx as Record<string, unknown>))
    if (!allowedCtx.has(k)) throw new Error(`unexpected context field ${k}`)
  const allowedPayload = new Set(["title", "parentID", "platform", "metadata"])
  for (const k of Object.keys(payload as Record<string, unknown>))
    if (!allowedPayload.has(k)) throw new Error(`unexpected payload field ${k}`)
  const opId = raw.opId as string
  parseCreateOpId(opId)
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId for create")
  parseCreateOpId(raw.idempotencyKey as string)
  return raw as unknown as ServePrivateCreateRequest
}

// eslint-disable-next-line complexity
export function validateCreateResult(raw: unknown, req: ServePrivateCreateRequest): ServePrivateCreateResult {
  if (!isRecord(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== "session/create") throw new Error("op mismatch")
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
  if ("revision" in raw && raw.revision !== undefined) {
    const rev = raw.revision as unknown
    if (
      !isRecord(rev) ||
      typeof rev.session !== "number" ||
      typeof rev.config !== "number" ||
      !isSafeInt(rev.session) ||
      !isSafeInt(rev.config)
    )
      throw new Error("revision must be {session,config} integers")
  }
  if ("transportUnknown" in raw && raw.transportUnknown !== undefined && typeof raw.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (status === "succeeded") {
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    const data = (raw as Record<string, unknown>).data
    if (!isRecord(data)) throw new Error("succeeded data must be object")
    const sess = (data as Record<string, unknown>).session
    if (!isRecord(sess)) throw new Error("succeeded data.session must be object")
    if (
      typeof (sess as Record<string, unknown>).id !== "string" ||
      !((sess as Record<string, unknown>).id as string).startsWith("ses")
    )
      throw new Error("succeeded data.session.id must be SessionID")
    if (
      typeof (sess as Record<string, unknown>).directory !== "string" ||
      !isAbsolute((sess as Record<string, unknown>).directory as string)
    )
      throw new Error("succeeded data.session.directory must be absolute")
    if (typeof (sess as Record<string, unknown>).title !== "string")
      throw new Error("succeeded data.session.title must be string")
    if ((sess as Record<string, unknown>).title === "")
      throw new Error("succeeded data.session.title must be non-empty")
    if ((raw as Record<string, unknown>).failure !== undefined) throw new Error("succeeded must not have failure")
    if ((outcome as Record<string, unknown>).failure !== undefined)
      throw new Error("succeeded outcome must not have failure")
    if ((raw as Record<string, unknown>).transportUnknown !== undefined)
      throw new Error("succeeded must not have transportUnknown")
    return raw as unknown as ServePrivateCreateResult
  }
  if (status === "failed") {
    const failure = (raw as Record<string, unknown>).failure
    const outFailure = (outcome as Record<string, unknown>).failure
    if (
      !isRecord(failure) ||
      typeof failure.code !== "string" ||
      typeof failure.message !== "string" ||
      typeof failure.retryable !== "boolean"
    )
      throw new Error("failed failure invalid")
    if (
      !isRecord(outFailure) ||
      typeof outFailure.code !== "string" ||
      typeof outFailure.message !== "string" ||
      typeof outFailure.retryable !== "boolean"
    )
      throw new Error("failed outcome.failure invalid")
    if (failure.code !== (outFailure as Record<string, unknown>).code) throw new Error("failure code mismatch")
    if (failure.message !== (outFailure as Record<string, unknown>).message) throw new Error("failure message mismatch")
    if (failure.retryable !== (outFailure as Record<string, unknown>).retryable)
      throw new Error("failure retryable mismatch")
    if ((raw as Record<string, unknown>).data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as ServePrivateCreateResult
  }
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if ((raw as Record<string, unknown>).data !== undefined) throw new Error("ambiguous must not have data")
  if ((raw as Record<string, unknown>).failure !== undefined) throw new Error("ambiguous must not have failure")
  if ((outcome as Record<string, unknown>).failure !== undefined)
    throw new Error("ambiguous outcome must not have failure")
  if ((outcome as Record<string, unknown>).data !== undefined) throw new Error("ambiguous outcome must not have data")
  return raw as unknown as ServePrivateCreateResult
}

function parseDeleteOpId(opId: string): { kind: string; parts: string[] } {
  if (typeof opId !== "string" || opId.length === 0) throw new TypeError("opId must be non-empty string")
  const segs = opId.split(":")
  if (segs.length < 2) throw new TypeError(`opId must contain ':'`)
  const kind = segs[0]!
  if (kind !== "delete") throw new TypeError(`opId kind must be delete: ${opId}`)
  const rest = segs.slice(1)
  for (const p of rest) if (p.length === 0) throw new TypeError(`opId segment must be non-empty: ${opId}`)
  if (rest.length !== 2) throw new TypeError(`delete opId must have 2 segments: ${opId}`)
  return { kind, parts: rest }
}

// eslint-disable-next-line complexity
export function validateDeleteRequest(raw: unknown): ServePrivateDeleteRequest {
  if (!isRecord(raw)) throw new Error("request must be object")
  if (raw.v !== 1) throw new Error("v must be 1")
  if (!isNonEmptyString(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!isNonEmptyString(raw.opId)) throw new Error("opId must be non-empty string")
  if (raw.op !== "session/delete") throw new Error("op must be session/delete")
  if (!isNonEmptyString(raw.idempotencyKey)) throw new Error("idempotencyKey must be non-empty string")
  if (raw.idempotencyKey !== raw.opId) throw new Error("idempotencyKey must equal opId for delete")
  const ctx = raw.context
  if (!isRecord(ctx)) throw new Error("context must be object")
  if (
    typeof ctx.directory !== "string" ||
    !isAbsolute(ctx.directory as string) ||
    (ctx.directory as string).includes("\0")
  )
    throw new Error("context.directory must be absolute path")
  if (!isSessionId(ctx.sessionId)) throw new Error("context.sessionId must be SessionID")
  if (!("parentSessionId" in ctx) || ctx.parentSessionId !== null)
    throw new Error("context.parentSessionId must be null")
  if ("configVersion" in ctx && ctx.configVersion !== undefined && !isSafeInt(ctx.configVersion))
    throw new Error("context.configVersion must be integer >=0")
  if ("sessionRevision" in ctx && ctx.sessionRevision !== undefined && !isSafeInt(ctx.sessionRevision))
    throw new Error("context.sessionRevision must be integer >=0")
  const payload = raw.payload
  if (!isRecord(payload)) throw new Error("payload must be object")
  if (Object.keys(payload as Record<string, unknown>).length !== 0)
    throw new Error("payload must be empty object for delete")
  const allowedRoot = new Set(["v", "requestId", "opId", "op", "idempotencyKey", "context", "payload"])
  for (const k of Object.keys(raw as Record<string, unknown>))
    if (!allowedRoot.has(k)) throw new Error(`unexpected field ${k}`)
  const allowedCtx = new Set(["directory", "sessionId", "parentSessionId", "configVersion", "sessionRevision"])
  for (const k of Object.keys(ctx as Record<string, unknown>))
    if (!allowedCtx.has(k)) throw new Error(`unexpected context field ${k}`)
  const opId = raw.opId as string
  const parsed = parseDeleteOpId(opId)
  if (parsed.parts[0] !== ctx.sessionId) throw new Error(`opId session binding mismatch: ${opId} vs ${ctx.sessionId}`)
  const idemParsed = parseDeleteOpId(raw.idempotencyKey as string)
  if (idemParsed.parts[0] !== ctx.sessionId)
    throw new Error(`idempotencyKey session binding mismatch: ${raw.idempotencyKey} vs ${ctx.sessionId}`)
  return raw as unknown as ServePrivateDeleteRequest
}

// eslint-disable-next-line complexity
export function validateDeleteResult(raw: unknown, req: ServePrivateDeleteRequest): ServePrivateDeleteResult {
  if (!isRecord(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.opId !== req.opId) throw new Error("opId mismatch")
  if (raw.op !== "session/delete") throw new Error("op mismatch")
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
  if ("revision" in raw && raw.revision !== undefined) {
    const rev = raw.revision as unknown
    if (
      !isRecord(rev) ||
      typeof rev.session !== "number" ||
      typeof rev.config !== "number" ||
      !isSafeInt(rev.session) ||
      !isSafeInt(rev.config)
    )
      throw new Error("revision must be {session,config} integers")
  }
  if ("transportUnknown" in raw && raw.transportUnknown !== undefined && typeof raw.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (status === "succeeded") {
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    const data = (raw as Record<string, unknown>).data
    if (!isRecord(data)) throw new Error("succeeded data must be object")
    if (Object.keys(data as Record<string, unknown>).length !== 0)
      throw new Error("succeeded data must be empty object")
    if ((raw as Record<string, unknown>).failure !== undefined) throw new Error("succeeded must not have failure")
    if ((outcome as Record<string, unknown>).failure !== undefined)
      throw new Error("succeeded outcome must not have failure")
    if ((raw as Record<string, unknown>).transportUnknown !== undefined)
      throw new Error("succeeded must not have transportUnknown")
    return raw as unknown as ServePrivateDeleteResult
  }
  if (status === "failed") {
    if (raw.accepted !== false) throw new Error("failed accepted must be false")
    if ((raw as Record<string, unknown>).transportUnknown !== undefined)
      throw new Error("failed must not have transportUnknown")
    const failure = (raw as Record<string, unknown>).failure
    const outFailure = (outcome as Record<string, unknown>).failure
    if (
      !isRecord(failure) ||
      typeof failure.code !== "string" ||
      typeof failure.message !== "string" ||
      typeof failure.retryable !== "boolean"
    )
      throw new Error("failed failure invalid")
    if (
      !isRecord(outFailure) ||
      typeof outFailure.code !== "string" ||
      typeof outFailure.message !== "string" ||
      typeof outFailure.retryable !== "boolean"
    )
      throw new Error("failed outcome.failure invalid")
    if (failure.code !== (outFailure as Record<string, unknown>).code) throw new Error("failure code mismatch")
    if (failure.message !== (outFailure as Record<string, unknown>).message) throw new Error("failure message mismatch")
    if (failure.retryable !== (outFailure as Record<string, unknown>).retryable)
      throw new Error("failure retryable mismatch")
    if ((raw as Record<string, unknown>).data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as ServePrivateDeleteResult
  }
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if ((raw as Record<string, unknown>).data !== undefined) throw new Error("ambiguous must not have data")
  if ((raw as Record<string, unknown>).failure !== undefined) throw new Error("ambiguous must not have failure")
  if ((outcome as Record<string, unknown>).failure !== undefined)
    throw new Error("ambiguous outcome must not have failure")
  if ((outcome as Record<string, unknown>).data !== undefined) throw new Error("ambiguous outcome must not have data")
  return raw as unknown as ServePrivateDeleteResult
}

export interface ServePrivatePeerOptions {
  reader: NodeJS.ReadableStream | null
  writer: NodeJS.WritableStream | null
  pid?: number
  epoch: number
  process?: ChildProcess | null
  initializeTimeoutMs?: number
  /**
   * Reverse capabilities: CLI->host methods this extension can receive.
   * Optional additive field, defaults to empty. Distinct from the legacy
   * `capabilities` request field (server-method list, ignored by the CLI)
   * and from the server capabilities awaited in the initialize response.
   */
  reverseCapabilities?: readonly string[]
  /**
   * Host-owned provider execution dependencies. When provided and
   * execution deps are installed, `provider/execute` is advertised and
   * handled. The service instance is not owned; no duplicate SecretStorage.
   */
  providerExecuteDeps?: import("./serve-private-provider-execute").ProviderExecuteDeps
  providerHttpExecuteDeps?: import("./serve-private-provider-http-execute").ProviderHttpExecuteDeps
}

/** Legacy request `capabilities` list: server-method expectations, ignored by the CLI. */
export const LEGACY_INITIALIZE_CAPABILITIES: readonly string[] = [
  "session/cancelQueued",
  "session/update",
  "session/fork",
  "session/create",
  "session/delete",
  "session/revert",
  "session/unrevert",
  "session/abort",
  "session/status",
  "session/get",
  "session/messages",
  "session/children",
  "remote/status",
  "experimental/session/list",
  "path/get",
  "find/files",
  "question/reply",
  "question/reject",
]

export const SERVE_REVERSE_CAPABILITY_MAX_LENGTH = 128
export const SERVE_REVERSE_CAPABILITIES_MAX_COUNT = 64

function isReservedReverseCapability(name: string): boolean {
  if (name === "initialize") return true
  if (name === "$/cancelRequest") return true
  if (name.startsWith("$/")) return true
  return false
}

export function normalizeReverseCapabilities(raw: unknown): string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new TypeError("reverseCapabilities must be array when present")
  if (raw.length > SERVE_REVERSE_CAPABILITIES_MAX_COUNT) throw new TypeError("reverseCapabilities too many entries")
  const out: string[] = []
  const set = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.length === 0)
      throw new TypeError("reverseCapabilities entries must be non-empty strings")
    if (entry.length > SERVE_REVERSE_CAPABILITY_MAX_LENGTH) throw new TypeError("reverseCapabilities entry too long")
    if (entry.includes("\0")) throw new TypeError("reverseCapabilities entry invalid")
    if (isReservedReverseCapability(entry)) throw new TypeError("reverseCapabilities entry reserved")
    if (set.has(entry)) throw new TypeError("reverseCapabilities entries must be unique")
    set.add(entry)
    out.push(entry)
  }
  return [...out]
}

const invalidatedTransports = new WeakSet<object>()

export class ServePrivatePeer {
  private peer: JsonRpcPeer | null = null
  private available = false
  private disposed = false
  private invalidated = false
  private capabilities: Record<string, unknown> | unknown[] | null = null
  private initRaw: unknown | null = null
  private initEpoch: number | null = null
  private initializing: Promise<boolean> | null = null
  private initSeq = 0

  constructor(private readonly opts: ServePrivatePeerOptions) {}

  getEpoch(): number {
    return this.opts.epoch
  }

  getPid(): number | undefined {
    return this.opts.pid
  }

  isAvailable(): boolean {
    return this.available && !this.disposed && this.peer?.getState() === "open"
  }

  isDisposed(): boolean {
    return this.disposed
  }

  getCapabilities(): unknown {
    return this.capabilities
  }

  getInitResult(): unknown {
    return this.initRaw
  }

  async initialize(timeoutMs = 5000): Promise<boolean> {
    if (this.disposed) return false
    if (this.invalidated) return false
    if (this.opts.reader && invalidatedTransports.has(this.opts.reader as object)) return false
    if (this.opts.writer && invalidatedTransports.has(this.opts.writer as object)) return false
    if (this.available) return true
    if (this.initializing) return this.initializing
    const seq = ++this.initSeq
    this.initializing = this.doInitialize(timeoutMs, seq)
    try {
      return await this.initializing
    } finally {
      if (this.initSeq === seq) this.initializing = null
    }
  }

  // eslint-disable-next-line complexity
  private async doInitialize(timeoutMs: number, seq: number): Promise<boolean> {
    const actualTimeout = this.opts.initializeTimeoutMs ?? timeoutMs
    if (!this.opts.reader || !this.opts.writer) {
      this.available = false
      return false
    }
    const epochAtStart = this.opts.epoch
    this.initEpoch = epochAtStart
    const providerDeps = this.opts.providerExecuteDeps
    const httpDeps = this.opts.providerHttpExecuteDeps ?? providerDeps
    // Advertise provider/execute and provider/httpExecute only when host can handle.
    // Fail closed if caller explicitly offered without deps.
    const canExecute = !!providerDeps && isProviderExecuteAvailable()
    const canHttp = !!httpDeps && isProviderHttpExecuteAvailable()
    const onRequest =
      (providerDeps && canExecute) || (httpDeps && canHttp)
        ? async (method: string, params: unknown, ctx: import("../../private-worker/peer").RequestContext) => {
            if (method === PROVIDER_EXECUTE_METHOD && providerDeps && canExecute) {
              return handleProviderExecute(params, providerDeps, ctx.signal)
            }
            if (method === PROVIDER_HTTP_EXECUTE_METHOD && httpDeps && canHttp) {
              return handleProviderHttpExecute(params, httpDeps, ctx)
            }
            const err = new Error(`Method not found: ${method}`) as Error & { code?: number }
            err.code = -32601
            throw err
          }
        : undefined
    const peerAtStart = new JsonRpcPeer({
      reader: this.opts.reader,
      writer: this.opts.writer,
      child: this.opts.process ?? undefined,
      onClosed: () => {
        if (this.initSeq !== seq) return
        if (this.peer !== peerAtStart) return
        if (this.initEpoch !== epochAtStart) return
        if (this.opts.epoch !== epochAtStart) return
        this.available = false
      },
      ...(onRequest ? { onRequest } : {}),
    })
    this.peer = peerAtStart

    let reverseOffer: string[]
    try {
      const base = normalizeReverseCapabilities(this.opts.reverseCapabilities)
      const hasOfferedExecute = base.includes("provider/execute")
      const hasOfferedHttp = base.includes("provider/httpExecute")
      if (hasOfferedExecute && !canExecute) {
        throw new TypeError("provider/execute reverse capability requires execution dependencies")
      }
      if (hasOfferedHttp && !canHttp) {
        throw new TypeError("provider/httpExecute reverse capability requires execution dependencies")
      }
      if (canExecute && !hasOfferedExecute) base.push("provider/execute")
      if (canHttp && !hasOfferedHttp) base.push("provider/httpExecute")
      reverseOffer = base
    } catch (err) {
      console.warn("[Kilo PrivatePeer] invalid reverseCapabilities:", String(err))
      bestEffortDispose(peerAtStart, "invalid-reverse-offer")
      if (this.peer === peerAtStart) this.peer = null
      this.available = false
      this.markTransportInvalidated()
      return false
    }
    const initPromise = peerAtStart.request("initialize", {
      protocol: { name: "kilo-private", major: 1, minor: 0 },
      clientInfo: { name: "kilo-vscode", version: "7.4.11" },
      capabilities: [...LEGACY_INITIALIZE_CAPABILITIES],
      reverseCapabilities: reverseOffer,
    })
    void initPromise.catch((err) => console.warn("[Kilo PrivatePeer] initialize request error:", String(err)))

    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`initialize timed out after ${actualTimeout}ms`)), actualTimeout)
      ;(timer as unknown as { unref?: () => void })?.unref?.()
    })

    try {
      const res = (await Promise.race([initPromise, timeout])) as Record<string, unknown>
      if (timer) clearTimeout(timer)
      if (this.initSeq !== seq) {
        bestEffortDispose(peerAtStart, "stale-seq")
        if (this.peer === peerAtStart) this.peer = null
        return false
      }
      if (this.peer !== peerAtStart) {
        bestEffortDispose(peerAtStart, "stale-peer")
        return false
      }
      if (this.disposed) return false
      if (this.initEpoch !== epochAtStart) return false
      if (this.opts.epoch !== epochAtStart) return false
      if (peerAtStart.getState() !== "open") {
        this.available = false
        bestEffortDispose(peerAtStart, "post-initialize-closed")
        if (this.peer === peerAtStart) this.peer = null
        this.markTransportInvalidated()
        return false
      }

      const proto = res?.protocol as Record<string, unknown> | undefined
      let protoName: string | undefined
      let protoMajor: number | undefined
      if (proto && typeof proto.name === "string") protoName = proto.name as string
      if (proto && typeof proto.major === "number") protoMajor = proto.major as number
      else if (typeof res?.protocolVersion === "string") {
        const parts = (res.protocolVersion as string).split(".")
        const n = Number(parts[0])
        if (!Number.isNaN(n)) protoMajor = n
      } else if (res?.protocolVersion && typeof res.protocolVersion === "object") {
        const pv = res.protocolVersion as Record<string, unknown>
        if (typeof pv.major === "number") protoMajor = pv.major as number
      }

      // Strict identity: require kilo-private name and major 1; missing/wrong => fail-closed unavailable.
      // Known old CLI shapes (capabilities {} or protocolVersion "1.0" with serverInfo kilo-private-worker)
      // have no protocol.name and are treated as unavailable rather than crashing the SDK connection.
      if (protoName !== PRIVATE_PROTOCOL_NAME || protoMajor !== PRIVATE_PROTOCOL_MAJOR) {
        this.available = false
        bestEffortDispose(peerAtStart, "protocol-mismatch")
        if (this.peer === peerAtStart) this.peer = null
        console.warn("[Kilo PrivatePeer] protocol mismatch fail-closed:", { protoName, protoMajor })
        this.markTransportInvalidated()
        return false
      }

      const caps = (res as Record<string, unknown>)?.capabilities as unknown
      let hasCancelQueued = false
      let hasSessionUpdate = false
      let hasFork = false
      let hasCreate = false
      let hasStatus = false
      let hasGet = false
      let hasMessages = false
      let hasChildren = false
      let hasRemoteStatus = false
      let hasSessionList = false
      let hasPath = false
      let hasCommandList = false
      let hasFindFiles = false
      if (Array.isArray(caps)) {
        hasCancelQueued = caps.includes("session/cancelQueued")
        hasSessionUpdate = caps.includes("session/update")
        hasFork = caps.includes("session/fork")
        hasCreate = caps.includes("session/create")
        hasStatus = caps.includes("session/status")
        hasGet = caps.includes("session/get")
        hasMessages = caps.includes("session/messages")
        hasChildren = caps.includes("session/children")
        hasRemoteStatus = caps.includes("remote/status")
        hasSessionList = caps.includes("experimental/session/list")
        hasPath = caps.includes("path/get")
        hasCommandList = caps.includes("command/list")
        hasFindFiles = caps.includes("find/files")
      } else if (caps && typeof caps === "object") {
        const c = caps as Record<string, unknown>
        if ((c as Record<string, unknown>)["session/cancelQueued"]) hasCancelQueued = true
        else if (
          Array.isArray((c as Record<string, unknown>).session) &&
          ((c as Record<string, unknown>).session as unknown[]).includes("cancelQueued")
        )
          hasCancelQueued = true
        else if ((c as Record<string, unknown>).session && typeof (c as Record<string, unknown>).session === "object") {
          const sess = (c as Record<string, unknown>).session as Record<string, unknown>
          if (sess.cancelQueued) hasCancelQueued = true
        } else if (c["session/cancelQueued"] === true) hasCancelQueued = true
        if ((c as Record<string, unknown>)["session/update"]) hasSessionUpdate = true
        else if (
          Array.isArray((c as Record<string, unknown>).session) &&
          ((c as Record<string, unknown>).session as unknown[]).includes("update")
        )
          hasSessionUpdate = true
        else if ((c as Record<string, unknown>).session && typeof (c as Record<string, unknown>).session === "object") {
          const sess = (c as Record<string, unknown>).session as Record<string, unknown>
          if ((sess as Record<string, unknown>).update) hasSessionUpdate = true
        } else if (c["session/update"] === true) hasSessionUpdate = true
        if ((c as Record<string, unknown>)["session/fork"]) hasFork = true
        else if (
          Array.isArray((c as Record<string, unknown>).session) &&
          ((c as Record<string, unknown>).session as unknown[]).includes("fork")
        )
          hasFork = true
        else if ((c as Record<string, unknown>).session && typeof (c as Record<string, unknown>).session === "object") {
          const sess = (c as Record<string, unknown>).session as Record<string, unknown>
          if ((sess as Record<string, unknown>).fork) hasFork = true
        } else if (c["session/fork"] === true) hasFork = true
        if ((c as Record<string, unknown>)["session/create"]) hasCreate = true
        else if (
          Array.isArray((c as Record<string, unknown>).session) &&
          ((c as Record<string, unknown>).session as unknown[]).includes("create")
        )
          hasCreate = true
        else if ((c as Record<string, unknown>).session && typeof (c as Record<string, unknown>).session === "object") {
          const sess = (c as Record<string, unknown>).session as Record<string, unknown>
          if ((sess as Record<string, unknown>).create) hasCreate = true
        } else if (c["session/create"] === true) hasCreate = true
        if ((c as Record<string, unknown>)["session/status"]) hasStatus = true
        else if (
          Array.isArray((c as Record<string, unknown>).session) &&
          ((c as Record<string, unknown>).session as unknown[]).includes("status")
        )
          hasStatus = true
        else if ((c as Record<string, unknown>).session && typeof (c as Record<string, unknown>).session === "object") {
          const sess = (c as Record<string, unknown>).session as Record<string, unknown>
          if ((sess as Record<string, unknown>).status) hasStatus = true
        } else if (c["session/status"] === true) hasStatus = true
        if ((c as Record<string, unknown>)["session/get"]) hasGet = true
        else if (
          Array.isArray((c as Record<string, unknown>).session) &&
          ((c as Record<string, unknown>).session as unknown[]).includes("get")
        )
          hasGet = true
        else if ((c as Record<string, unknown>).session && typeof (c as Record<string, unknown>).session === "object") {
          const sess = (c as Record<string, unknown>).session as Record<string, unknown>
          if ((sess as Record<string, unknown>).get) hasGet = true
        } else if (c["session/get"] === true) hasGet = true
        if ((c as Record<string, unknown>)["session/messages"]) hasMessages = true
        else if (
          Array.isArray((c as Record<string, unknown>).session) &&
          ((c as Record<string, unknown>).session as unknown[]).includes("messages")
        )
          hasMessages = true
        else if ((c as Record<string, unknown>).session && typeof (c as Record<string, unknown>).session === "object") {
          const sess = (c as Record<string, unknown>).session as Record<string, unknown>
          if ((sess as Record<string, unknown>).messages) hasMessages = true
        } else if (c["session/messages"] === true) hasMessages = true
        if ((c as Record<string, unknown>)["session/children"]) hasChildren = true
        else if (
          Array.isArray((c as Record<string, unknown>).session) &&
          ((c as Record<string, unknown>).session as unknown[]).includes("children")
        )
          hasChildren = true
        else if (((c as Record<string, unknown>).session as Record<string, unknown> | null)?.children)
          hasChildren = true
        if ((c as Record<string, unknown>)["remote/status"]) hasRemoteStatus = true
        if ((c as Record<string, unknown>)["experimental/session/list"]) hasSessionList = true
        if ((c as Record<string, unknown>)["path/get"]) hasPath = true
        if ((c as Record<string, unknown>)["command/list"]) hasCommandList = true
        if ((c as Record<string, unknown>)["find/files"]) hasFindFiles = true
        if (Object.keys(c).length === 0) {
          hasCancelQueued = false
          hasSessionUpdate = false
          hasFork = false
          hasCreate = false
          hasStatus = false
          hasGet = false
          hasMessages = false
          hasChildren = false
          hasRemoteStatus = false
          hasSessionList = false
          hasPath = false
          hasCommandList = false
          hasFindFiles = false
        }
      }

      if (
        !hasCancelQueued &&
        !hasSessionUpdate &&
        !hasFork &&
        !hasCreate &&
        !hasStatus &&
        !hasGet &&
        !hasMessages &&
        !hasChildren &&
        !hasRemoteStatus &&
        !hasSessionList &&
        !hasPath &&
        !hasCommandList &&
        !hasFindFiles
      ) {
        this.available = false
        bestEffortDispose(peerAtStart, "missing-capability")
        if (this.peer === peerAtStart) this.peer = null
        this.markTransportInvalidated()
        return false
      }

      if (
        this.initSeq !== seq ||
        this.peer !== peerAtStart ||
        this.disposed ||
        this.initEpoch !== epochAtStart ||
        this.opts.epoch !== epochAtStart
      ) {
        bestEffortDispose(peerAtStart, "stale-epoch")
        if (this.peer === peerAtStart) this.peer = null
        return false
      }

      this.capabilities = caps as Record<string, unknown>
      this.initRaw = res
      this.available = true
      return true
    } catch (err) {
      if (timer) clearTimeout(timer)
      console.warn("[Kilo PrivatePeer] initialize failed:", String(err))
      if (this.initSeq !== seq || this.peer !== peerAtStart || this.disposed || this.initEpoch !== epochAtStart) {
        bestEffortDispose(peerAtStart, "initialize-disposed")
        if (this.peer === peerAtStart) this.peer = null
        return false
      }
      this.available = false
      bestEffortDispose(peerAtStart, "initialize-error")
      if (this.peer === peerAtStart) this.peer = null
      this.markTransportInvalidated()
      return false
    }
  }

  async privateCancelQueued(req: ServePrivateCancelQueuedRequest): Promise<ServePrivateCancelQueuedResult> {
    const handle = this.privateCancelQueuedWithHandle(req)
    return handle.promise
  }

  private isStaleHandle(peerAtCall: JsonRpcPeer, epoch: number): boolean {
    if (this.disposed) return true
    if (this.opts.epoch !== epoch) return true
    if (this.peer !== peerAtCall) return true
    if (peerAtCall.getState() === "closed") return true
    return false
  }

  private isClosedHandle(peerAtCall: JsonRpcPeer, epoch: number, err: unknown): boolean {
    if (this.isStaleHandle(peerAtCall, epoch)) return true
    if (this.peer?.getState() === "closed") return true
    const e = err as { code?: number; message?: string; stale?: boolean }
    if (e?.stale === true) return true
    if (e?.code === -32603) return true
    const m = e?.message
    if (typeof m === "string") {
      if (m.includes("Peer closed")) return true
      if (m.includes("Peer disposed")) return true
      if (m.includes("Peer is closed")) return true
    }
    return false
  }

  private parseFailedInfo(err: unknown): { code: string; msg: string } {
    const e = err as { code?: number; message?: string }
    const code = typeof e?.code === "number" ? String(e.code) : "internal"
    const msg = e?.message ?? String(err)
    return { code, msg }
  }

  private failedCancelQueued(
    req: ServePrivateCancelQueuedRequest,
    code: string,
    msg: string,
  ): ServePrivateCancelQueuedResult {
    return {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "session/cancelQueued",
      idempotencyKey: req.idempotencyKey,
      status: "failed",
      outcome: { type: "failed", time: Date.now(), failure: { code, message: msg, retryable: false } },
      accepted: false,
      failure: { code, message: msg, retryable: false },
    }
  }

  private failedUpdate(
    req: ServePrivateSessionUpdateRequest,
    code: string,
    msg: string,
  ): ServePrivateSessionUpdateResult {
    return {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "session/update",
      idempotencyKey: req.idempotencyKey,
      status: "failed",
      outcome: { type: "failed", time: Date.now(), failure: { code, message: msg, retryable: false } },
      accepted: false,
      failure: { code, message: msg, retryable: false },
    }
  }

  private failedCreate(req: ServePrivateCreateRequest, code: string, msg: string): ServePrivateCreateResult {
    return {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "session/create",
      idempotencyKey: req.idempotencyKey,
      status: "failed",
      outcome: { type: "failed", time: Date.now(), failure: { code, message: msg, retryable: false } },
      accepted: false,
      failure: { code, message: msg, retryable: false },
    }
  }

  private failedDelete(req: ServePrivateDeleteRequest, code: string, msg: string): ServePrivateDeleteResult {
    return {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "session/delete",
      idempotencyKey: req.idempotencyKey,
      status: "failed",
      outcome: { type: "failed", time: Date.now(), failure: { code, message: msg, retryable: false } },
      accepted: false,
      failure: { code, message: msg, retryable: false },
    }
  }

  private failedPath(req: PathContractRequest, code: string, msg: string): PathResult {
    return failedPathResult(req, code, msg)
  }

  private failedStatus(req: ServePrivateStatusRequest, code: string, msg: string): ServePrivateStatusResult {
    return {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "session/status",
      idempotencyKey: req.idempotencyKey,
      status: "failed",
      outcome: { type: "failed", time: Date.now(), failure: { code, message: msg, retryable: false } },
      accepted: false,
      failure: { code, message: msg, retryable: false },
    }
  }

  private failedGet(req: ServePrivateGetRequest, code: string, msg: string): ServePrivateGetResult {
    return {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "session/get",
      idempotencyKey: req.idempotencyKey,
      status: "failed",
      outcome: { type: "failed", time: Date.now(), failure: { code, message: msg, retryable: false } },
      accepted: false,
      failure: { code, message: msg, retryable: false },
    }
  }

  private failedMessages(req: ServePrivateMessagesRequest, code: string, msg: string): ServePrivateMessagesResult {
    return {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "session/messages",
      idempotencyKey: req.idempotencyKey,
      status: "failed",
      outcome: { type: "failed", time: Date.now(), failure: { code, message: msg, retryable: false } },
      accepted: false,
      failure: { code, message: msg, retryable: false },
    }
  }

  private makeHandleCancel(
    id: number,
    opId: string,
    peerAtCall: JsonRpcPeer,
    epoch: number,
  ): (msg?: string) => boolean {
    return (msg = "private parity timeout"): boolean => {
      if (this.isStaleHandle(peerAtCall, epoch)) {
        try {
          this.invalidateOnObserverTimeout(`stale observer timeout opId=${opId}`)
        } catch (err) {
          console.warn("[Kilo] stale observer cleanup failed:", String(err).slice(0, 200), { opId })
        }
        return false
      }
      let ok = false
      try {
        ok = this.tryCancelPending(id, msg)
      } catch (err) {
        console.warn("[Kilo] observer timeout cancel failed:", String(err).slice(0, 200), { opId })
        try {
          this.invalidateOnObserverTimeout(`observer timeout cancel throw opId=${opId}`)
        } catch (inner) {
          console.warn("[Kilo] observer timeout invalidate failed:", String(inner).slice(0, 200), { opId })
        }
        return false
      }
      if (!ok) {
        try {
          this.invalidateOnObserverTimeout(`observer timeout exact cancel miss opId=${opId}`)
        } catch (err) {
          console.warn("[Kilo] observer timeout invalidate failed:", String(err).slice(0, 200), { opId })
        }
        return false
      }
      return true
    }
  }

  private makeMessagesHandleCancel(id: number, peerAtCall: JsonRpcPeer, epoch: number): (msg?: string) => boolean {
    return (msg = "private parity timeout"): boolean => {
      if (this.isStaleHandle(peerAtCall, epoch)) {
        try {
          this.invalidateOnObserverTimeout("stale observer timeout")
        } catch {
          console.warn("[Kilo] stale observer cleanup failed:", {
            op: "session/messages",
            stale: true,
            cleanupFailed: true,
          })
        }
        return false
      }
      let ok = false
      try {
        ok = this.tryCancelPending(id, msg)
      } catch {
        console.warn("[Kilo] observer timeout cancel failed:", { op: "session/messages", cancelFailed: true })
        try {
          this.invalidateOnObserverTimeout("observer timeout cancel throw")
        } catch {
          console.warn("[Kilo] observer timeout invalidate failed:", { op: "session/messages", invalidateFailed: true })
        }
        return false
      }
      if (!ok) {
        try {
          this.invalidateOnObserverTimeout("observer timeout exact cancel miss")
        } catch {
          console.warn("[Kilo] observer timeout invalidate failed:", { op: "session/messages", invalidateFailed: true })
        }
        return false
      }
      return true
    }
  }

  privateChildrenOutcomeWithHandle(req: ServePrivateChildrenRequest): {
    id: number
    promise: Promise<PrivateChildrenWireOutcome>
    cancel: (msg?: string) => boolean
  } {
    validateChildrenRequest(req)
    if (this.disposed) throw new Error("Peer disposed")
    if (!this.available || !this.peer || this.peer.getState() !== "open") throw new Error("Private peer unavailable")
    if (!this.hasCapability("session/children")) throw new Error("Private peer missing session/children capability")
    const currentEpoch = this.opts.epoch
    const peerAtCall = this.peer
    return requestChildrenOutcome(
      peerAtCall as unknown as import("./serve-private-children").ChildrenRawTransport,
      {
        isStale: () => this.isStaleHandle(peerAtCall, currentEpoch),
        isClosed: (e) => this.isClosedHandle(peerAtCall, currentEpoch, e),
        failInfo: (e) => this.parseFailedInfo(e),
      },
      (id) =>
        makeChildrenCancel(id, {
          isStale: () => this.isStaleHandle(peerAtCall, currentEpoch),
          tryCancel: (msg) => this.tryCancelPending(id, msg),
          invalidate: (reason) => this.invalidateOnObserverTimeout(reason),
        }),
      req,
    )
  }

  privateRemoteStatusOutcomeWithHandle(req: ServePrivateRemoteStatusRequest): {
    id: number
    promise: Promise<PrivateRemoteStatusWireOutcome>
    cancel: (msg?: string) => boolean
  } {
    validateRemoteStatusRequest(req)
    if (this.disposed) throw new Error("Peer disposed")
    if (!this.available || !this.peer || this.peer.getState() !== "open") throw new Error("Private peer unavailable")
    if (!this.hasCapability("remote/status")) throw new Error("Private peer missing remote/status capability")
    const currentEpoch = this.opts.epoch
    const peerAtCall = this.peer
    return requestRemoteStatusOutcome(
      peerAtCall as unknown as import("./serve-private-remote-status").RemoteStatusRawTransport,
      {
        isStale: () => this.isStaleHandle(peerAtCall, currentEpoch),
        isClosed: (e) => this.isClosedHandle(peerAtCall, currentEpoch, e),
        failInfo: (e) => this.parseFailedInfo(e),
      },
      (id) =>
        makeRemoteStatusCancel(id, {
          isStale: () => this.isStaleHandle(peerAtCall, currentEpoch),
          tryCancel: (msg) => this.tryCancelPending(id, msg),
          invalidate: (reason) => this.invalidateOnObserverTimeout(reason),
        }),
      req,
    )
  }

  async privateRemoteStatus(req: ServePrivateRemoteStatusRequest): Promise<ServePrivateRemoteStatusResult> {
    const handle = this.privateRemoteStatusWithHandle(req)
    return handle.promise
  }

  /** Atomic handle: allocates id synchronously and returns exact id for timeout cancellation ownership.
   * Resolved values are always strictly valid results; invalid wire rejects
   * with PrivateRemoteStatusValidationError and never resolves as a normal result.
   */
  privateRemoteStatusWithHandle(req: ServePrivateRemoteStatusRequest): {
    id: number
    promise: Promise<ServePrivateRemoteStatusResult>
    cancel: (msg?: string) => boolean
  } {
    validateRemoteStatusRequest(req)
    if (this.disposed) throw new Error("Peer disposed")
    if (!this.available || !this.peer || this.peer.getState() !== "open") {
      throw new Error("Private peer unavailable")
    }
    if (!this.hasCapability("remote/status")) {
      throw new Error("Private peer missing remote/status capability")
    }
    const currentEpoch = this.opts.epoch
    const peerAtCall = this.peer
    const outcome = requestRemoteStatusOutcome(
      peerAtCall as unknown as import("./serve-private-remote-status").RemoteStatusRawTransport,
      {
        isStale: () => this.isStaleHandle(peerAtCall, currentEpoch),
        isClosed: (e) => this.isClosedHandle(peerAtCall, currentEpoch, e),
        failInfo: (e) => this.parseFailedInfo(e),
      },
      (id) =>
        makeRemoteStatusCancel(id, {
          isStale: () => this.isStaleHandle(peerAtCall, currentEpoch),
          tryCancel: (msg) => this.tryCancelPending(id, msg),
          invalidate: (reason) => this.invalidateOnObserverTimeout(reason),
        }),
      req,
    )
    const promise = (async (): Promise<ServePrivateRemoteStatusResult> => {
      const wire = await outcome.promise
      if (wire.kind === "invalid") throw new PrivateRemoteStatusValidationError(wire.detail)
      return wire.result
    })()
    return { id: outcome.id, promise, cancel: outcome.cancel }
  }

  privateCancelQueuedWithHandle(req: ServePrivateCancelQueuedRequest): {
    id: number
    promise: Promise<ServePrivateCancelQueuedResult>
    cancel: (msg?: string) => boolean
  } {
    validateCancelQueuedRequest(req)
    if (this.disposed) throw new Error("Peer disposed")
    if (!this.available || !this.peer || this.peer.getState() !== "open") {
      throw new Error("Private peer unavailable")
    }
    const currentEpoch = this.opts.epoch
    const peerAtCall = this.peer
    const { id, promise: rawPromise } = peerAtCall.requestWithId("session/cancelQueued", req)
    const promise = (async (): Promise<ServePrivateCancelQueuedResult> => {
      try {
        const raw = (await rawPromise) as unknown
        if (this.isStaleHandle(peerAtCall, currentEpoch)) return makeAmbiguous(req, true)
        try {
          return validateCancelQueuedResult(raw, req)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          return makeFailedInternal(req, `invalid private response shape: ${msg}`)
        }
      } catch (e: unknown) {
        if (this.isClosedHandle(peerAtCall, currentEpoch, e)) return makeAmbiguous(req, true)
        const { code, msg } = this.parseFailedInfo(e)
        return this.failedCancelQueued(req, code, msg)
      }
    })()
    const cancel = this.makeHandleCancel(id as unknown as number, req.opId, peerAtCall, currentEpoch)
    return { id: id as unknown as number, promise, cancel }
  }

  // eslint-disable-next-line complexity
  hasCapability(cap: string): boolean {
    const caps = this.capabilities
    if (!caps) return false
    if (Array.isArray(caps)) return caps.includes(cap)
    if (typeof caps === "object") {
      const c = caps as Record<string, unknown>
      if (c[cap]) return true
      if (cap === "session/update" && c["session/update"] === true) return true
      if (cap === "session/update" && Array.isArray(c.session) && (c.session as unknown[]).includes("update"))
        return true
      if (cap === "session/update" && typeof c.session === "object" && c.session !== null) {
        const sess = c.session as Record<string, unknown>
        if (sess.update) return true
      }
      if (cap === "session/cancelQueued" && c["session/cancelQueued"]) return true
      if (cap === "session/fork" && c["session/fork"] === true) return true
      if (cap === "session/fork" && Array.isArray(c.session) && (c.session as unknown[]).includes("fork")) return true
      if (cap === "session/fork" && typeof c.session === "object" && c.session !== null) {
        const sess = c.session as Record<string, unknown>
        if (sess.fork) return true
      }
      if (cap === "session/create" && c["session/create"] === true) return true
      if (cap === "session/create" && Array.isArray(c.session) && (c.session as unknown[]).includes("create"))
        return true
      if (cap === "session/create" && typeof c.session === "object" && c.session !== null) {
        const sess = c.session as Record<string, unknown>
        if (sess.create) return true
      }
      if (cap === "session/delete" && c["session/delete"] === true) return true
      if (cap === "session/delete" && Array.isArray(c.session) && (c.session as unknown[]).includes("delete"))
        return true
      if (cap === "session/delete" && typeof c.session === "object" && c.session !== null) {
        const sess = c.session as Record<string, unknown>
        if (sess.delete) return true
      }
      if (cap === "session/prompt" && c["session/prompt"] === true) return true
      if (cap === "session/prompt" && Array.isArray(c.session) && (c.session as unknown[]).includes("prompt")) return true
      if (cap === "session/prompt" && typeof c.session === "object" && c.session !== null) {
        const sess = c.session as Record<string, unknown>
        if (sess.prompt) return true
      }
      if (cap === "session/abort" && c["session/abort"] === true) return true
      if (cap === "session/abort" && Array.isArray(c.session) && (c.session as unknown[]).includes("abort")) return true
      if (cap === "session/abort" && typeof c.session === "object" && c.session !== null) {
        const sess = c.session as Record<string, unknown>
        if (sess.abort) return true
      }
      if (cap === "session/status" && c["session/status"] === true) return true
      if (cap === "session/status" && Array.isArray(c.session) && (c.session as unknown[]).includes("status"))
        return true
      if (cap === "session/status" && typeof c.session === "object" && c.session !== null) {
        const sess = c.session as Record<string, unknown>
        if (sess.status) return true
      }
      if (cap === "session/get" && c["session/get"] === true) return true
      if (cap === "session/get" && Array.isArray(c.session) && (c.session as unknown[]).includes("get")) return true
      if (cap === "session/get" && typeof c.session === "object" && c.session !== null) {
        const sess = c.session as Record<string, unknown>
        if (sess.get) return true
      }
      if (cap === "session/messages" && c["session/messages"] === true) return true
      if (cap === "session/messages" && Array.isArray(c.session) && (c.session as unknown[]).includes("messages"))
        return true
      if (cap === "session/messages" && typeof c.session === "object" && c.session !== null) {
        const sess = c.session as Record<string, unknown>
        if (sess.messages) return true
      }
      if (cap === "session/children" && c["session/children"] === true) return true
      if (cap === "session/children" && Array.isArray(c.session) && (c.session as unknown[]).includes("children"))
        return true
      if (cap === "session/children" && typeof c.session === "object" && c.session !== null) {
        const sess = c.session as Record<string, unknown>
        if (sess.children) return true
      }
      if (cap === "remote/status" && c["remote/status"]) return true
      if (cap === "experimental/session/list" && c["experimental/session/list"]) return true
      if (cap === "path/get" && c["path/get"]) return true
      if (cap === "command/list" && c["command/list"]) return true
      if (cap === "find/files" && c["find/files"]) return true
      if (cap === "question/reply" && c["question/reply"]) return true
      if (cap === "question/reject" && c["question/reject"]) return true
      if (cap === "permission/save-always-rules" && c["permission/save-always-rules"]) return true
      if (cap === "permission/reply" && c["permission/reply"]) return true
      if (cap === "skill/remove" && c["skill/remove"]) return true
    }
    return false
  }

  async privateSessionUpdate(req: ServePrivateSessionUpdateRequest): Promise<ServePrivateSessionUpdateResult> {
    const handle = this.privateSessionUpdateWithHandle(req)
    return handle.promise
  }

  privateSessionUpdateWithHandle(req: ServePrivateSessionUpdateRequest): {
    id: number
    promise: Promise<ServePrivateSessionUpdateResult>
    cancel: (msg?: string) => boolean
  } {
    validateSessionUpdateRequest(req)
    if (this.disposed) throw new Error("Peer disposed")
    if (!this.available || !this.peer || this.peer.getState() !== "open") {
      throw new Error("Private peer unavailable")
    }
    if (!this.hasCapability("session/update")) {
      throw new Error("Private peer missing session/update capability")
    }
    const currentEpoch = this.opts.epoch
    const peerAtCall = this.peer
    const { id, promise: rawPromise } = peerAtCall.requestWithId("session/update", req)
    const promise = (async (): Promise<ServePrivateSessionUpdateResult> => {
      try {
        const raw = (await rawPromise) as unknown
        if (this.isStaleHandle(peerAtCall, currentEpoch)) return makeUpdateAmbiguous(req, true)
        try {
          return validateSessionUpdateResult(raw, req)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          return makeUpdateFailedInternal(req, `invalid private response shape: ${msg}`)
        }
      } catch (e: unknown) {
        if (this.isClosedHandle(peerAtCall, currentEpoch, e)) return makeUpdateAmbiguous(req, true)
        const { code, msg } = this.parseFailedInfo(e)
        return this.failedUpdate(req, code, msg)
      }
    })()
    const cancel = this.makeHandleCancel(id as unknown as number, req.opId, peerAtCall, currentEpoch)
    return { id: id as unknown as number, promise, cancel }
  }

  async privateFork(req: ServePrivateForkRequest): Promise<ServePrivateForkResult> {
    const handle = this.privateForkWithHandle(req)
    return handle.promise
  }

  privateForkWithHandle(req: ServePrivateForkRequest): {
    id: number
    promise: Promise<ServePrivateForkResult>
    cancel: (msg?: string) => boolean
  } {
    validateForkRequest(req)
    if (this.disposed) throw new Error("Peer disposed")
    if (!this.available || !this.peer || this.peer.getState() !== "open") {
      throw new Error("Private peer unavailable")
    }
    if (!this.hasCapability("session/fork")) {
      throw new Error("Private peer missing session/fork capability")
    }
    const currentEpoch = this.opts.epoch
    const peerAtCall = this.peer
    const { id, promise: rawPromise } = peerAtCall.requestWithId("session/fork", req)
    // Fork failure closure: only a protocol-valid `failed` result carries a trusted
    // `failure.retryable` signal. Invalid wire, transport, closed, and stale outcomes
    // normalize to `ambiguous` so the provider takes the single SDK fallback.
    const promise = (async (): Promise<ServePrivateForkResult> => {
      try {
        const raw = (await rawPromise) as unknown
        if (this.isStaleHandle(peerAtCall, currentEpoch)) return makeForkAmbiguous(req, true)
        try {
          return validateForkResult(raw, req)
        } catch {
          return makeForkAmbiguous(req, true)
        }
      } catch (e: unknown) {
        if (this.isClosedHandle(peerAtCall, currentEpoch, e)) return makeForkAmbiguous(req, true)
        return makeForkAmbiguous(req, true)
      }
    })()
    const cancel = this.makeHandleCancel(id as unknown as number, req.opId, peerAtCall, currentEpoch)
    return { id: id as unknown as number, promise, cancel }
  }

  async privateCreate(req: ServePrivateCreateRequest): Promise<ServePrivateCreateResult> {
    const handle = this.privateCreateWithHandle(req)
    return handle.promise
  }

  /** Atomic handle: allocates id synchronously and returns exact id for timeout cancellation ownership. */
  privateCreateWithHandle(req: ServePrivateCreateRequest): {
    id: number
    promise: Promise<ServePrivateCreateResult>
    cancel: (msg?: string) => boolean
  } {
    validateCreateRequest(req)
    if (this.disposed) throw new Error("Peer disposed")
    if (!this.available || !this.peer || this.peer.getState() !== "open") {
      throw new Error("Private peer unavailable")
    }
    if (!this.hasCapability("session/create")) {
      throw new Error("Private peer missing session/create capability")
    }
    const currentEpoch = this.opts.epoch
    const peerAtCall = this.peer
    const { id, promise: rawPromise } = peerAtCall.requestWithId("session/create", req)
    const promise = (async (): Promise<ServePrivateCreateResult> => {
      try {
        const raw = (await rawPromise) as unknown
        if (this.isStaleHandle(peerAtCall, currentEpoch)) return makeCreateAmbiguous(req, true)
        try {
          return validateCreateResult(raw, req)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          return makeCreateFailedInternal(req, `invalid private response shape: ${msg}`)
        }
      } catch (e: unknown) {
        if (this.isClosedHandle(peerAtCall, currentEpoch, e)) return makeCreateAmbiguous(req, true)
        const { code, msg } = this.parseFailedInfo(e)
        return this.failedCreate(req, code, msg)
      }
    })()
    const cancel = this.makeHandleCancel(id as unknown as number, req.opId, peerAtCall, currentEpoch)
    return { id: id as unknown as number, promise, cancel }
  }

  async privateDelete(req: ServePrivateDeleteRequest): Promise<ServePrivateDeleteResult> {
    const handle = this.privateDeleteWithHandle(req)
    return handle.promise
  }

  async privateRevert(req: ServePrivateRevertRequest): Promise<ServePrivateRevertResult> {
    const handle = this.privateRevertWithHandle(req)
    return handle.promise
  }

  privateRevertWithHandle(req: ServePrivateRevertRequest): {
    id: number
    promise: Promise<ServePrivateRevertResult>
    cancel: (msg?: string) => boolean
  } {
    validateRevertRequest(req)
    if (this.disposed) throw new Error("Peer disposed")
    if (!this.available || !this.peer || this.peer.getState() !== "open") {
      throw new Error("Private peer unavailable")
    }
    if (!this.hasCapability("session/revert")) {
      throw new Error("Private peer missing session/revert capability")
    }
    const currentEpoch = this.opts.epoch
    const peerAtCall = this.peer
    const { id, promise: rawPromise } = peerAtCall.requestWithId("session/revert", req)
    const promise = (async (): Promise<ServePrivateRevertResult> => {
      try {
        const raw = (await rawPromise) as unknown
        if (this.isStaleHandle(peerAtCall, currentEpoch)) return makeRevertAmbiguous(req, true)
        try {
          return validateRevertResult(raw, req)
        } catch {
          return makeRevertAmbiguous(req, true)
        }
      } catch (e: unknown) {
        if (this.isClosedHandle(peerAtCall, currentEpoch, e)) return makeRevertAmbiguous(req, true)
        return makeRevertAmbiguous(req, true)
      }
    })()
    const cancel = this.makeHandleCancel(id as unknown as number, req.opId, peerAtCall, currentEpoch)
    return { id: id as unknown as number, promise, cancel }
  }

  async privateUnrevert(req: ServePrivateUnrevertRequest): Promise<ServePrivateUnrevertResult> {
    const handle = this.privateUnrevertWithHandle(req)
    return handle.promise
  }

  privateUnrevertWithHandle(req: ServePrivateUnrevertRequest): {
    id: number
    promise: Promise<ServePrivateUnrevertResult>
    cancel: (msg?: string) => boolean
  } {
    validateUnrevertRequest(req)
    if (this.disposed) throw new Error("Peer disposed")
    if (!this.available || !this.peer || this.peer.getState() !== "open") {
      throw new Error("Private peer unavailable")
    }
    if (!this.hasCapability("session/unrevert")) {
      throw new Error("Private peer missing session/unrevert capability")
    }
    const currentEpoch = this.opts.epoch
    const peerAtCall = this.peer
    const { id, promise: rawPromise } = peerAtCall.requestWithId("session/unrevert", req)
    const promise = (async (): Promise<ServePrivateUnrevertResult> => {
      try {
        const raw = (await rawPromise) as unknown
        if (this.isStaleHandle(peerAtCall, currentEpoch)) return makeUnrevertAmbiguous(req, true)
        try {
          return validateUnrevertResult(raw, req)
        } catch {
          return makeUnrevertAmbiguous(req, true)
        }
      } catch (e: unknown) {
        if (this.isClosedHandle(peerAtCall, currentEpoch, e)) return makeUnrevertAmbiguous(req, true)
        return makeUnrevertAmbiguous(req, true)
      }
    })()
    const cancel = this.makeHandleCancel(id as unknown as number, req.opId, peerAtCall, currentEpoch)
    return { id: id as unknown as number, promise, cancel }
  }

  privateDeleteWithHandle(req: ServePrivateDeleteRequest): {
    id: number
    promise: Promise<ServePrivateDeleteResult>
    cancel: (msg?: string) => boolean
  } {
    validateDeleteRequest(req)
    if (this.disposed) throw new Error("Peer disposed")
    if (!this.available || !this.peer || this.peer.getState() !== "open") {
      throw new Error("Private peer unavailable")
    }
    if (!this.hasCapability("session/delete")) {
      throw new Error("Private peer missing session/delete capability")
    }
    const currentEpoch = this.opts.epoch
    const peerAtCall = this.peer
    const { id, promise: rawPromise } = peerAtCall.requestWithId("session/delete", req)
    const promise = (async (): Promise<ServePrivateDeleteResult> => {
      try {
        const raw = (await rawPromise) as unknown
        if (this.isStaleHandle(peerAtCall, currentEpoch)) return makeDeleteAmbiguous(req, true)
        try {
          return validateDeleteResult(raw, req)
        } catch {
          return makeDeleteAmbiguous(req, true)
        }
      } catch (e: unknown) {
        if (this.isClosedHandle(peerAtCall, currentEpoch, e)) return makeDeleteAmbiguous(req, true)
        return makeDeleteAmbiguous(req, true)
      }
    })()
    const cancel = this.makeHandleCancel(id as unknown as number, req.opId, peerAtCall, currentEpoch)
    return { id: id as unknown as number, promise, cancel }
  }

  async privatePrompt(req: PromptContractRequest): Promise<PromptResult> {
    const handle = this.privatePromptWithHandle(req)
    return handle.promise
  }

  async privateCommand(req: CommandContractRequest): Promise<CommandResult> {
    const handle = this.privateCommandWithHandle(req)
    return handle.promise
  }

  privateCommandWithHandle(req: CommandContractRequest): {
    id: number
    promise: Promise<CommandResult>
    cancel: (msg?: string) => boolean
  } {
    validateCommandContractRequest(req)
    if (this.disposed) throw new Error("Peer disposed")
    if (!this.available || !this.peer || this.peer.getState() !== "open") {
      throw new Error("Private peer unavailable")
    }
    if (!this.hasCapability("session/command")) {
      throw new Error("Private peer missing session/command capability")
    }
    const currentEpoch = this.opts.epoch
    const peerAtCall = this.peer
    const { id, promise: rawPromise } = peerAtCall.requestWithId("session/command", req)
    const promise = (async (): Promise<CommandResult> => {
      try {
        const raw = (await rawPromise) as unknown
        if (this.isStaleHandle(peerAtCall, currentEpoch)) return makeCommandAmbiguous(req, true)
        const out = normalizePrivateCommandWire(raw, req)
        if (out.kind === "invalid") return makeCommandAmbiguous(req, true)
        return out.result
      } catch (e: unknown) {
        if (this.isClosedHandle(peerAtCall, currentEpoch, e)) return makeCommandAmbiguous(req, true)
        return makeCommandAmbiguous(req, true)
      }
    })()
    const cancel = this.makeHandleCancel(id as unknown as number, req.opId, peerAtCall, currentEpoch)
    return { id: id as unknown as number, promise, cancel }
  }

  privatePromptWithHandle(req: PromptContractRequest): {
    id: number
    promise: Promise<PromptResult>
    cancel: (msg?: string) => boolean
  } {
    validatePromptContractRequest(req)
    if (this.disposed) throw new Error("Peer disposed")
    if (!this.available || !this.peer || this.peer.getState() !== "open") {
      throw new Error("Private peer unavailable")
    }
    if (!this.hasCapability("session/prompt")) {
      throw new Error("Private peer missing session/prompt capability")
    }
    const currentEpoch = this.opts.epoch
    const peerAtCall = this.peer
    const { id, promise: rawPromise } = peerAtCall.requestWithId("session/prompt", req)
    const promise = (async (): Promise<PromptResult> => {
      try {
        const raw = (await rawPromise) as unknown
        if (this.isStaleHandle(peerAtCall, currentEpoch)) return makePromptAmbiguous(req, true)
        const out = normalizePrivatePromptWire(raw, req)
        if (out.kind === "invalid") return makePromptAmbiguous(req, true)
        return out.result
      } catch (e: unknown) {
        if (this.isClosedHandle(peerAtCall, currentEpoch, e)) return makePromptAmbiguous(req, true)
        return makePromptAmbiguous(req, true)
      }
    })()
    const cancel = this.makeHandleCancel(id as unknown as number, req.opId, peerAtCall, currentEpoch)
    return { id: id as unknown as number, promise, cancel }
  }

  async privateAbort(req: ServePrivateAbortRequest): Promise<ServePrivateAbortResult> {
    const handle = this.privateAbortWithHandle(req)
    return handle.promise
  }

  privateAbortWithHandle(req: ServePrivateAbortRequest): {
    id: number
    promise: Promise<ServePrivateAbortResult>
    cancel: (msg?: string) => boolean
  } {
    validateAbortRequest(req)
    if (this.disposed) throw new Error("Peer disposed")
    if (!this.available || !this.peer || this.peer.getState() !== "open") {
      throw new Error("Private peer unavailable")
    }
    if (!this.hasCapability("session/abort")) {
      throw new Error("Private peer missing session/abort capability")
    }
    const currentEpoch = this.opts.epoch
    const peerAtCall = this.peer
    const { id, promise: rawPromise } = peerAtCall.requestWithId("session/abort", req)
    const promise = (async (): Promise<ServePrivateAbortResult> => {
      try {
        const raw = (await rawPromise) as unknown
        try {
          return validateAbortResult(raw, req)
        } catch {
          return makeAbortAmbiguous(req)
        }
      } catch (e: unknown) {
        if (this.isClosedHandle(peerAtCall, currentEpoch, e)) return makeAbortAmbiguous(req)
        return makeAbortAmbiguous(req)
      }
    })()
    const cancel = this.makeHandleCancel(id as unknown as number, req.opId, peerAtCall, currentEpoch)
    return { id: id as unknown as number, promise, cancel }
  }

  async privateQuestionReply(req: ServePrivateQuestionReplyRequest): Promise<ServePrivateQuestionResult> {
    const handle = this.privateQuestionReplyWithHandle(req)
    return handle.promise
  }

  privateQuestionReplyWithHandle(req: ServePrivateQuestionReplyRequest): {
    id: number
    promise: Promise<ServePrivateQuestionResult>
    cancel: (msg?: string) => boolean
  } {
    validateQuestionReplyRequest(req)
    if (this.disposed) throw new Error("Peer disposed")
    if (!this.available || !this.peer || this.peer.getState() !== "open") {
      throw new Error("Private peer unavailable")
    }
    if (!this.hasCapability("question/reply")) {
      throw new Error("Private peer missing question/reply capability")
    }
    const currentEpoch = this.opts.epoch
    const peerAtCall = this.peer
    const { id, promise: rawPromise } = peerAtCall.requestWithId("question/reply", req)
    const promise = (async (): Promise<ServePrivateQuestionResult> => {
      try {
        const raw = (await rawPromise) as unknown
        try {
          return validateQuestionReplyOutcome(raw, req)
        } catch {
          return makeQuestionAmbiguous(req)
        }
      } catch (e: unknown) {
        if (this.isClosedHandle(peerAtCall, currentEpoch, e)) return makeQuestionAmbiguous(req)
        return makeQuestionAmbiguous(req)
      }
    })()
    const cancel = this.makeHandleCancel(id as unknown as number, req.opId, peerAtCall, currentEpoch)
    return { id: id as unknown as number, promise, cancel }
  }

  async privateQuestionReject(req: ServePrivateQuestionRejectRequest): Promise<ServePrivateQuestionResult> {
    const handle = this.privateQuestionRejectWithHandle(req)
    return handle.promise
  }

  privateQuestionRejectWithHandle(req: ServePrivateQuestionRejectRequest): {
    id: number
    promise: Promise<ServePrivateQuestionResult>
    cancel: (msg?: string) => boolean
  } {
    validateQuestionRejectRequest(req)
    if (this.disposed) throw new Error("Peer disposed")
    if (!this.available || !this.peer || this.peer.getState() !== "open") {
      throw new Error("Private peer unavailable")
    }
    if (!this.hasCapability("question/reject")) {
      throw new Error("Private peer missing question/reject capability")
    }
    const currentEpoch = this.opts.epoch
    const peerAtCall = this.peer
    const { id, promise: rawPromise } = peerAtCall.requestWithId("question/reject", req)
    const promise = (async (): Promise<ServePrivateQuestionResult> => {
      try {
        const raw = (await rawPromise) as unknown
        try {
          return validateQuestionRejectOutcome(raw, req)
        } catch {
          return makeQuestionAmbiguous(req)
        }
      } catch (e: unknown) {
        if (this.isClosedHandle(peerAtCall, currentEpoch, e)) return makeQuestionAmbiguous(req)
        return makeQuestionAmbiguous(req)
      }
    })()
    const cancel = this.makeHandleCancel(id as unknown as number, req.opId, peerAtCall, currentEpoch)
    return { id: id as unknown as number, promise, cancel }
  }

  async privatePermissionSave(req: ServePrivatePermissionSaveRequest): Promise<ServePrivatePermissionResult> {
    const handle = this.privatePermissionSaveWithHandle(req)
    return handle.promise
  }

  privatePermissionSaveWithHandle(req: ServePrivatePermissionSaveRequest): {
    id: number
    promise: Promise<ServePrivatePermissionResult>
    cancel: (msg?: string) => boolean
  } {
    validatePermissionSaveRequest(req)
    if (this.disposed) throw new Error("Peer disposed")
    if (!this.available || !this.peer || this.peer.getState() !== "open") {
      throw new Error("Private peer unavailable")
    }
    if (!this.hasCapability("permission/save-always-rules")) {
      throw new Error("Private peer missing permission/save-always-rules capability")
    }
    const currentEpoch = this.opts.epoch
    const peerAtCall = this.peer
    const { id, promise: rawPromise } = peerAtCall.requestWithId("permission/save-always-rules", req)
    const promise = (async (): Promise<ServePrivatePermissionResult> => {
      try {
        const raw = (await rawPromise) as unknown
        try {
          return validatePermissionSaveOutcome(raw, req)
        } catch {
          return makePermissionAmbiguous(req)
        }
      } catch (e: unknown) {
        if (this.isClosedHandle(peerAtCall, currentEpoch, e)) return makePermissionAmbiguous(req)
        return makePermissionAmbiguous(req)
      }
    })()
    const cancel = this.makeHandleCancel(id as unknown as number, req.opId, peerAtCall, currentEpoch)
    return { id: id as unknown as number, promise, cancel }
  }

  async privatePermissionReply(req: ServePrivatePermissionReplyRequest): Promise<ServePrivatePermissionResult> {
    const handle = this.privatePermissionReplyWithHandle(req)
    return handle.promise
  }

  privatePermissionReplyWithHandle(req: ServePrivatePermissionReplyRequest): {
    id: number
    promise: Promise<ServePrivatePermissionResult>
    cancel: (msg?: string) => boolean
  } {
    validatePermissionReplyRequest(req)
    if (this.disposed) throw new Error("Peer disposed")
    if (!this.available || !this.peer || this.peer.getState() !== "open") {
      throw new Error("Private peer unavailable")
    }
    if (!this.hasCapability("permission/reply")) {
      throw new Error("Private peer missing permission/reply capability")
    }
    const currentEpoch = this.opts.epoch
    const peerAtCall = this.peer
    const { id, promise: rawPromise } = peerAtCall.requestWithId("permission/reply", req)
    const promise = (async (): Promise<ServePrivatePermissionResult> => {
      try {
        const raw = (await rawPromise) as unknown
        try {
          return validatePermissionReplyOutcome(raw, req)
        } catch {
          return makePermissionAmbiguous(req)
        }
      } catch (e: unknown) {
        if (this.isClosedHandle(peerAtCall, currentEpoch, e)) return makePermissionAmbiguous(req)
        return makePermissionAmbiguous(req)
      }
    })()
    const cancel = this.makeHandleCancel(id as unknown as number, req.opId, peerAtCall, currentEpoch)
    return { id: id as unknown as number, promise, cancel }
  }

  async privatePermissionList(req: PermissionListContractRequest): Promise<PermissionListResult> {
    const handle = this.privatePermissionListWithHandle(req)
    const outcome = await handle.promise
    if (outcome.kind === "invalid") throw new Error(outcome.detail)
    return outcome.result
  }

  async privateMcpStatus(req: McpStatusContractRequest): Promise<McpStatusResult> {
    const handle = this.privateMcpStatusWithHandle(req)
    const outcome = await handle.promise
    if (outcome.kind === "invalid") throw new Error(outcome.detail)
    return outcome.result
  }

  private failedMcpStatus(req: McpStatusContractRequest, code: string, msg: string): McpStatusResult {
    return {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "mcp/status",
      idempotencyKey: req.idempotencyKey,
      status: "failed",
      outcome: { type: "failed", time: Date.now(), failure: { code, message: msg, retryable: false } },
      accepted: false,
      failure: { code, message: msg, retryable: false },
    }
  }

  privateMcpStatusWithHandle(req: McpStatusContractRequest): {
    id: number
    promise: Promise<McpStatusWireOutcome>
    cancel: (msg?: string) => boolean
  } {
    validateMcpStatusContractRequest(req)
    if (this.disposed) throw new Error("Peer disposed")
    if (!this.available || !this.peer || this.peer.getState() !== "open") {
      throw new Error("Private peer unavailable")
    }
    if (!this.hasCapability("mcp/status")) {
      throw new Error("Private peer missing mcp/status capability")
    }
    const currentEpoch = this.opts.epoch
    const peerAtCall = this.peer
    const { id, promise: rawPromise } = peerAtCall.requestWithId("mcp/status", req)
    const promise = (async (): Promise<McpStatusWireOutcome> => {
      let raw: unknown
      try {
        raw = (await rawPromise) as unknown
      } catch (e: unknown) {
        if (this.isClosedHandle(peerAtCall, currentEpoch, e))
          return { kind: "valid", result: makeMcpStatusAmbiguous(req, true) }
        const { code, msg } = this.parseFailedInfo(e)
        return { kind: "valid", result: this.failedMcpStatus(req, code, msg) }
      }
      if (this.isStaleHandle(peerAtCall, currentEpoch))
        return { kind: "valid", result: makeMcpStatusAmbiguous(req, true) }
      return normalizePrivateMcpStatusWire(raw, req)
    })()
    const cancel = this.makeHandleCancel(id as unknown as number, req.opId, peerAtCall, currentEpoch)
    return { id: id as unknown as number, promise, cancel }
  }

  /**
   * Internal normalized handle for the read-only mcp/status private-first read.
   * Resolves the discriminated wire outcome so invalid wire is an explicit
   * `{ kind: "invalid" }` value consumed before any SDK fallback, never a
   * normal result. Transport/closed/epoch semantics match the public handle.
   */
  privateMcpStatusOutcomeWithHandle(req: McpStatusContractRequest): {
    id: number
    promise: Promise<McpStatusWireOutcome>
    cancel: (msg?: string) => boolean
  } {
    validateMcpStatusContractRequest(req)
    if (this.disposed) throw new Error("Peer disposed")
    if (!this.available || !this.peer || this.peer.getState() !== "open") {
      throw new Error("Private peer unavailable")
    }
    if (!this.hasCapability("mcp/status")) {
      throw new Error("Private peer missing mcp/status capability")
    }
    const currentEpoch = this.opts.epoch
    const peerAtCall = this.peer
    const { id, promise: rawPromise } = peerAtCall.requestWithId("mcp/status", req)
    const promise = (async (): Promise<McpStatusWireOutcome> => {
      let raw: unknown
      try {
        raw = (await rawPromise) as unknown
      } catch (e: unknown) {
        if (this.isClosedHandle(peerAtCall, currentEpoch, e))
          return { kind: "valid", result: makeMcpStatusAmbiguous(req, true) }
        const { code, msg } = this.parseFailedInfo(e)
        return { kind: "valid", result: this.failedMcpStatus(req, code, msg) }
      }
      if (this.isStaleHandle(peerAtCall, currentEpoch))
        return { kind: "valid", result: makeMcpStatusAmbiguous(req, true) }
      return normalizePrivateMcpStatusWire(raw, req)
    })()
    const cancel = this.makeHandleCancel(id as unknown as number, req.opId, peerAtCall, currentEpoch)
    return { id: id as unknown as number, promise, cancel }
  }

  /**
   * Internal normalized handle for the private-only mcp/connect mutation.
   * Resolves the discriminated wire outcome so invalid wire is an explicit
   * `{ kind: "invalid" }` value consumed before any refresh decision, never
   * a normal result. Transport/closed/epoch semantics match the skill/remove
   * mutation handle. There is no SDK fallback: every non-succeeded outcome
   * fails closed and re-observes authoritative mcp/status.
   */
  privateMcpConnectOutcomeWithHandle(req: McpConnectContractRequest): {
    id: number
    promise: Promise<McpConnectWireOutcome>
    cancel: (msg?: string) => boolean
  } {
    validateMcpConnectContractRequest(req)
    if (this.disposed) throw new Error("Peer disposed")
    if (!this.available || !this.peer || this.peer.getState() !== "open") {
      throw new Error("Private peer unavailable")
    }
    if (!this.hasCapability("mcp/connect")) {
      throw new Error("Private peer missing mcp/connect capability")
    }
    const currentEpoch = this.opts.epoch
    const peerAtCall = this.peer
    const { id, promise: rawPromise } = peerAtCall.requestWithId("mcp/connect", req)
    const promise = (async (): Promise<McpConnectWireOutcome> => {
      let raw: unknown
      try {
        raw = (await rawPromise) as unknown
      } catch (e: unknown) {
        if (this.isClosedHandle(peerAtCall, currentEpoch, e))
          return { kind: "valid", result: makeMcpConnectAmbiguous(req, true) }
        return { kind: "valid", result: makeMcpConnectAmbiguous(req, true) }
      }
      if (this.isStaleHandle(peerAtCall, currentEpoch))
        return { kind: "valid", result: makeMcpConnectAmbiguous(req, true) }
      return normalizePrivateMcpConnectWire(raw, req)
    })()
    const cancel = this.makeHandleCancel(id as unknown as number, req.opId, peerAtCall, currentEpoch)
    return { id: id as unknown as number, promise, cancel }
  }

  /**
   * Internal normalized handle for the private-only mcp/disconnect mutation,
   * same fail-closed semantics as mcp/connect above.
   */
  privateMcpDisconnectOutcomeWithHandle(req: McpDisconnectContractRequest): {
    id: number
    promise: Promise<McpDisconnectWireOutcome>
    cancel: (msg?: string) => boolean
  } {
    validateMcpDisconnectContractRequest(req)
    if (this.disposed) throw new Error("Peer disposed")
    if (!this.available || !this.peer || this.peer.getState() !== "open") {
      throw new Error("Private peer unavailable")
    }
    if (!this.hasCapability("mcp/disconnect")) {
      throw new Error("Private peer missing mcp/disconnect capability")
    }
    const currentEpoch = this.opts.epoch
    const peerAtCall = this.peer
    const { id, promise: rawPromise } = peerAtCall.requestWithId("mcp/disconnect", req)
    const promise = (async (): Promise<McpDisconnectWireOutcome> => {
      let raw: unknown
      try {
        raw = (await rawPromise) as unknown
      } catch (e: unknown) {
        if (this.isClosedHandle(peerAtCall, currentEpoch, e))
          return { kind: "valid", result: makeMcpDisconnectAmbiguous(req, true) }
        return { kind: "valid", result: makeMcpDisconnectAmbiguous(req, true) }
      }
      if (this.isStaleHandle(peerAtCall, currentEpoch))
        return { kind: "valid", result: makeMcpDisconnectAmbiguous(req, true) }
      return normalizePrivateMcpDisconnectWire(raw, req)
    })()
    const cancel = this.makeHandleCancel(id as unknown as number, req.opId, peerAtCall, currentEpoch)
    return { id: id as unknown as number, promise, cancel }
  }

  private failedPermissionList(req: PermissionListContractRequest, code: string, msg: string): PermissionListResult {
    return {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "permission/list",
      idempotencyKey: req.idempotencyKey,
      status: "failed",
      outcome: { type: "failed", time: Date.now(), failure: { code, message: msg, retryable: false } },
      accepted: false,
      failure: { code, message: msg, retryable: false },
    }
  }

  privatePermissionListWithHandle(req: PermissionListContractRequest): {
    id: number
    promise: Promise<PermissionListWireOutcome>
    cancel: (msg?: string) => boolean
  } {
    validatePermissionListContractRequest(req)
    if (this.disposed) throw new Error("Peer disposed")
    if (!this.available || !this.peer || this.peer.getState() !== "open") {
      throw new Error("Private peer unavailable")
    }
    if (!this.hasCapability("permission/list")) {
      throw new Error("Private peer missing permission/list capability")
    }
    const currentEpoch = this.opts.epoch
    const peerAtCall = this.peer
    const { id, promise: rawPromise } = peerAtCall.requestWithId("permission/list", req)
    const promise = (async (): Promise<PermissionListWireOutcome> => {
      let raw: unknown
      try {
        raw = (await rawPromise) as unknown
      } catch (e: unknown) {
        if (this.isClosedHandle(peerAtCall, currentEpoch, e))
          return { kind: "valid", result: makePermissionListAmbiguous(req, true) }
        const { code, msg } = this.parseFailedInfo(e)
        return { kind: "valid", result: this.failedPermissionList(req, code, msg) }
      }
      if (this.isStaleHandle(peerAtCall, currentEpoch))
        return { kind: "valid", result: makePermissionListAmbiguous(req, true) }
      return normalizePrivatePermissionListWire(raw, req)
    })()
    const cancel = this.makeHandleCancel(id as unknown as number, req.opId, peerAtCall, currentEpoch)
    return { id: id as unknown as number, promise, cancel }
  }

  async privateStatus(req: ServePrivateStatusRequest): Promise<ServePrivateStatusResult> {
    const handle = this.privateStatusWithHandle(req)
    return handle.promise
  }

  /** Atomic handle: allocates id synchronously and returns exact id for timeout cancellation ownership.
   * Resolved values are always strictly valid results; invalid wire rejects
   * with PrivateStatusValidationError and never resolves as a normal result.
   */
  privateStatusWithHandle(req: ServePrivateStatusRequest): {
    id: number
    promise: Promise<ServePrivateStatusResult>
    cancel: (msg?: string) => boolean
  } {
    validateStatusRequest(req)
    if (this.disposed) throw new Error("Peer disposed")
    if (!this.available || !this.peer || this.peer.getState() !== "open") {
      throw new Error("Private peer unavailable")
    }
    if (!this.hasCapability("session/status")) {
      throw new Error("Private peer missing session/status capability")
    }
    const currentEpoch = this.opts.epoch
    const peerAtCall = this.peer
    const { id, promise: rawPromise } = peerAtCall.requestWithId("session/status", req)
    const promise = (async (): Promise<ServePrivateStatusResult> => {
      let raw: unknown
      try {
        raw = (await rawPromise) as unknown
      } catch (e: unknown) {
        if (this.isClosedHandle(peerAtCall, currentEpoch, e)) return makeStatusAmbiguous(req, true)
        const { code, msg } = this.parseFailedInfo(e)
        return this.failedStatus(req, code, msg)
      }
      if (this.isStaleHandle(peerAtCall, currentEpoch)) return makeStatusAmbiguous(req, true)
      const out = normalizePrivateStatusWire(raw, req)
      if (out.kind === "invalid") throw new PrivateStatusValidationError(out.detail)
      return out.result
    })()
    const cancel = this.makeHandleCancel(id as unknown as number, req.opId, peerAtCall, currentEpoch)
    return { id: id as unknown as number, promise, cancel }
  }

  /**
   * Internal normalized handle for the read-only status parity observer.
   * Resolves the discriminated wire outcome so invalid wire is an explicit
   * `{ kind: "invalid" }` value consumed before any comparator, never a
   * normal result. Transport/closed/epoch semantics match the public handle.
   */
  privateStatusOutcomeWithHandle(req: ServePrivateStatusRequest): {
    id: number
    promise: Promise<PrivateStatusWireOutcome>
    cancel: (msg?: string) => boolean
  } {
    validateStatusRequest(req)
    if (this.disposed) throw new Error("Peer disposed")
    if (!this.available || !this.peer || this.peer.getState() !== "open") {
      throw new Error("Private peer unavailable")
    }
    if (!this.hasCapability("session/status")) {
      throw new Error("Private peer missing session/status capability")
    }
    const currentEpoch = this.opts.epoch
    const peerAtCall = this.peer
    const { id, promise: rawPromise } = peerAtCall.requestWithId("session/status", req)
    const promise = (async (): Promise<PrivateStatusWireOutcome> => {
      let raw: unknown
      try {
        raw = (await rawPromise) as unknown
      } catch (e: unknown) {
        if (this.isClosedHandle(peerAtCall, currentEpoch, e))
          return { kind: "valid", result: makeStatusAmbiguous(req, true) }
        const { code, msg } = this.parseFailedInfo(e)
        return { kind: "valid", result: this.failedStatus(req, code, msg) }
      }
      if (this.isStaleHandle(peerAtCall, currentEpoch)) return { kind: "valid", result: makeStatusAmbiguous(req, true) }
      return normalizePrivateStatusWire(raw, req)
    })()
    const cancel = this.makeHandleCancel(id as unknown as number, req.opId, peerAtCall, currentEpoch)
    return { id: id as unknown as number, promise, cancel }
  }

  async privateGet(req: ServePrivateGetRequest): Promise<ServePrivateGetResult> {
    const handle = this.privateGetWithHandle(req)
    return handle.promise
  }

  /** Atomic handle: allocates id synchronously and returns exact id for timeout cancellation ownership.
   * Resolved values are always strictly valid results; invalid wire rejects
   * with PrivateGetValidationError and never resolves as a normal result.
   */
  privateGetWithHandle(req: ServePrivateGetRequest): {
    id: number
    promise: Promise<ServePrivateGetResult>
    cancel: (msg?: string) => boolean
  } {
    validateGetRequest(req)
    if (this.disposed) throw new Error("Peer disposed")
    if (!this.available || !this.peer || this.peer.getState() !== "open") {
      throw new Error("Private peer unavailable")
    }
    if (!this.hasCapability("session/get")) {
      throw new Error("Private peer missing session/get capability")
    }
    const currentEpoch = this.opts.epoch
    const peerAtCall = this.peer
    const { id, promise: rawPromise } = peerAtCall.requestWithId("session/get", req)
    const promise = (async (): Promise<ServePrivateGetResult> => {
      let raw: unknown
      try {
        raw = (await rawPromise) as unknown
      } catch (e: unknown) {
        if (this.isClosedHandle(peerAtCall, currentEpoch, e)) return makeGetAmbiguous(req, true)
        const { code, msg } = this.parseFailedInfo(e)
        return this.failedGet(req, code, msg)
      }
      if (this.isStaleHandle(peerAtCall, currentEpoch)) return makeGetAmbiguous(req, true)
      const out = normalizePrivateGetWire(raw, req)
      if (out.kind === "invalid") throw new PrivateGetValidationError(out.detail)
      return out.result
    })()
    const cancel = this.makeHandleCancel(id as unknown as number, req.opId, peerAtCall, currentEpoch)
    return { id: id as unknown as number, promise, cancel }
  }

  /**
   * Internal normalized handle for the read-only get parity observer.
   * Resolves the discriminated wire outcome so invalid wire is an explicit
   * `{ kind: "invalid" }` value consumed before any comparator, never a
   * normal result. Transport/closed/epoch semantics match the public handle.
   */
  privateGetOutcomeWithHandle(req: ServePrivateGetRequest): {
    id: number
    promise: Promise<PrivateGetWireOutcome>
    cancel: (msg?: string) => boolean
  } {
    validateGetRequest(req)
    if (this.disposed) throw new Error("Peer disposed")
    if (!this.available || !this.peer || this.peer.getState() !== "open") {
      throw new Error("Private peer unavailable")
    }
    if (!this.hasCapability("session/get")) {
      throw new Error("Private peer missing session/get capability")
    }
    const currentEpoch = this.opts.epoch
    const peerAtCall = this.peer
    const { id, promise: rawPromise } = peerAtCall.requestWithId("session/get", req)
    const promise = (async (): Promise<PrivateGetWireOutcome> => {
      let raw: unknown
      try {
        raw = (await rawPromise) as unknown
      } catch (e: unknown) {
        if (this.isClosedHandle(peerAtCall, currentEpoch, e))
          return { kind: "valid", result: makeGetAmbiguous(req, true) }
        const { code, msg } = this.parseFailedInfo(e)
        return { kind: "valid", result: this.failedGet(req, code, msg) }
      }
      if (this.isStaleHandle(peerAtCall, currentEpoch)) return { kind: "valid", result: makeGetAmbiguous(req, true) }
      return normalizePrivateGetWire(raw, req)
    })()
    const cancel = this.makeHandleCancel(id as unknown as number, req.opId, peerAtCall, currentEpoch)
    return { id: id as unknown as number, promise, cancel }
  }

  async privateMessages(req: ServePrivateMessagesRequest): Promise<ServePrivateMessagesResult> {
    const handle = this.privateMessagesWithHandle(req)
    return handle.promise
  }

  /** Atomic handle: allocates id synchronously and returns exact id for timeout cancellation ownership.
   * Resolved values are always strictly valid results; invalid wire rejects
   * with PrivateMessagesValidationError and never resolves as a normal result.
   */
  privateMessagesWithHandle(req: ServePrivateMessagesRequest): {
    id: number
    promise: Promise<ServePrivateMessagesResult>
    cancel: (msg?: string) => boolean
  } {
    validateMessagesRequest(req)
    if (this.disposed) throw new Error("Peer disposed")
    if (!this.available || !this.peer || this.peer.getState() !== "open") {
      throw new Error("Private peer unavailable")
    }
    if (!this.hasCapability("session/messages")) {
      throw new Error("Private peer missing session/messages capability")
    }
    const currentEpoch = this.opts.epoch
    const peerAtCall = this.peer
    const { id, promise: rawPromise } = peerAtCall.requestWithId("session/messages", req)
    const promise = (async (): Promise<ServePrivateMessagesResult> => {
      let raw: unknown
      try {
        raw = (await rawPromise) as unknown
      } catch (e: unknown) {
        if (this.isClosedHandle(peerAtCall, currentEpoch, e)) return makeMessagesAmbiguous(req, true)
        const { code, msg } = this.parseFailedInfo(e)
        return this.failedMessages(req, code, msg)
      }
      if (this.isStaleHandle(peerAtCall, currentEpoch)) return makeMessagesAmbiguous(req, true)
      const out = normalizePrivateMessagesWire(raw, req)
      if (out.kind === "invalid") throw new PrivateMessagesValidationError(out.detail)
      return out.result
    })()
    const cancel = this.makeMessagesHandleCancel(id as unknown as number, peerAtCall, currentEpoch)
    return { id: id as unknown as number, promise, cancel }
  }

  /**
   * Internal normalized handle for the read-only messages parity observer.
   * Resolves the discriminated wire outcome so invalid wire is an explicit
   * `{ kind: "invalid" }` value consumed before any comparator, never a
   * normal result. Transport/closed/epoch semantics match the public handle.
   */
  privateMessagesOutcomeWithHandle(req: ServePrivateMessagesRequest): {
    id: number
    promise: Promise<PrivateMessagesWireOutcome>
    cancel: (msg?: string) => boolean
  } {
    validateMessagesRequest(req)
    if (this.disposed) throw new Error("Peer disposed")
    if (!this.available || !this.peer || this.peer.getState() !== "open") {
      throw new Error("Private peer unavailable")
    }
    if (!this.hasCapability("session/messages")) {
      throw new Error("Private peer missing session/messages capability")
    }
    const currentEpoch = this.opts.epoch
    const peerAtCall = this.peer
    const { id, promise: rawPromise } = peerAtCall.requestWithId("session/messages", req)
    const promise = (async (): Promise<PrivateMessagesWireOutcome> => {
      let raw: unknown
      try {
        raw = (await rawPromise) as unknown
      } catch (e: unknown) {
        if (this.isClosedHandle(peerAtCall, currentEpoch, e))
          return { kind: "valid", result: makeMessagesAmbiguous(req, true) }
        const { code, msg } = this.parseFailedInfo(e)
        return { kind: "valid", result: this.failedMessages(req, code, msg) }
      }
      if (this.isStaleHandle(peerAtCall, currentEpoch))
        return { kind: "valid", result: makeMessagesAmbiguous(req, true) }
      return normalizePrivateMessagesWire(raw, req)
    })()
    const cancel = this.makeMessagesHandleCancel(id as unknown as number, peerAtCall, currentEpoch)
    return { id: id as unknown as number, promise, cancel }
  }

  private failedSessionModelUsage(
    req: SessionModelUsageContractRequest,
    code: string,
    msg: string,
  ): SessionModelUsageResult {
    return {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "session/model-usage",
      idempotencyKey: req.idempotencyKey,
      status: "failed",
      outcome: { type: "failed", time: Date.now(), failure: { code, message: msg, retryable: false } },
      accepted: false,
      failure: { code, message: msg, retryable: false },
    }
  }

  async privateSessionModelUsage(req: SessionModelUsageContractRequest): Promise<SessionModelUsageResult> {
    const handle = this.privateSessionModelUsageWithHandle(req)
    return handle.promise
  }

  /** Atomic handle: allocates id synchronously and returns exact id for timeout cancellation ownership.
   * Resolved values are always strictly valid results; invalid wire rejects
   * with SessionModelUsageValidationError and never resolves as a normal result.
   */
  privateSessionModelUsageWithHandle(req: SessionModelUsageContractRequest): {
    id: number
    promise: Promise<SessionModelUsageResult>
    cancel: (msg?: string) => boolean
  } {
    validateSessionModelUsageContractRequest(req)
    if (this.disposed) throw new Error("Peer disposed")
    if (!this.available || !this.peer || this.peer.getState() !== "open") {
      throw new Error("Private peer unavailable")
    }
    if (!this.hasCapability("session/model-usage")) {
      throw new Error("Private peer missing session/model-usage capability")
    }
    const currentEpoch = this.opts.epoch
    const peerAtCall = this.peer
    const { id, promise: rawPromise } = peerAtCall.requestWithId("session/model-usage", req)
    const promise = (async (): Promise<SessionModelUsageResult> => {
      let raw: unknown
      try {
        raw = (await rawPromise) as unknown
      } catch (e: unknown) {
        if (this.isClosedHandle(peerAtCall, currentEpoch, e))
          return makeSessionModelUsageAmbiguous(req, true)
        const { code, msg } = this.parseFailedInfo(e)
        return this.failedSessionModelUsage(req, code, msg)
      }
      if (this.isStaleHandle(peerAtCall, currentEpoch)) return makeSessionModelUsageAmbiguous(req, true)
      const out: SessionModelUsageWireOutcome = normalizePrivateSessionModelUsageWire(raw, req)
      if (out.kind === "invalid") throw new SessionModelUsageValidationError(out.detail)
      return out.result
    })()
    const cancel = this.makeHandleCancel(id as unknown as number, req.opId, peerAtCall, currentEpoch)
    return { id: id as unknown as number, promise, cancel }
  }

  /**
   * Internal normalized handle for the read-only session-model-usage private-first read.
   * Resolves the discriminated wire outcome so invalid wire is an explicit
   * `{ kind: "invalid" }` value consumed before any SDK fallback, never a
   * normal result. Transport/closed/epoch semantics match the public handle.
   */
  privateSessionModelUsageOutcomeWithHandle(req: SessionModelUsageContractRequest): {
    id: number
    promise: Promise<SessionModelUsageWireOutcome>
    cancel: (msg?: string) => boolean
  } {
    validateSessionModelUsageContractRequest(req)
    if (this.disposed) throw new Error("Peer disposed")
    if (!this.available || !this.peer || this.peer.getState() !== "open") {
      throw new Error("Private peer unavailable")
    }
    if (!this.hasCapability("session/model-usage")) {
      throw new Error("Private peer missing session/model-usage capability")
    }
    const currentEpoch = this.opts.epoch
    const peerAtCall = this.peer
    const { id, promise: rawPromise } = peerAtCall.requestWithId("session/model-usage", req)
    const promise = (async (): Promise<SessionModelUsageWireOutcome> => {
      let raw: unknown
      try {
        raw = (await rawPromise) as unknown
      } catch (e: unknown) {
        if (this.isClosedHandle(peerAtCall, currentEpoch, e))
          return { kind: "valid", result: makeSessionModelUsageAmbiguous(req, true) }
        const { code, msg } = this.parseFailedInfo(e)
        return { kind: "valid", result: this.failedSessionModelUsage(req, code, msg) }
      }
      if (this.isStaleHandle(peerAtCall, currentEpoch))
        return { kind: "valid", result: makeSessionModelUsageAmbiguous(req, true) }
      return normalizePrivateSessionModelUsageWire(raw, req)
    })()
    const cancel = this.makeHandleCancel(id as unknown as number, req.opId, peerAtCall, currentEpoch)
    return { id: id as unknown as number, promise, cancel }
  }

  private failedAgentRequirements(
    req: AgentRequirementsContractRequest,
    code: string,
    msg: string,
  ): AgentRequirementsResult {
    return {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "agent/requirements",
      idempotencyKey: req.idempotencyKey,
      status: "failed",
      outcome: { type: "failed", time: Date.now(), failure: { code, message: msg, retryable: false } },
      accepted: false,
      failure: { code, message: msg, retryable: false },
    }
  }

  async privateAgentRequirements(req: AgentRequirementsContractRequest): Promise<AgentRequirementsResult> {
    const handle = this.privateAgentRequirementsWithHandle(req)
    return handle.promise
  }

  /** Atomic handle: allocates id synchronously and returns exact id for timeout cancellation ownership.
   * Resolved values are always strictly valid results; invalid wire rejects
   * with AgentRequirementsValidationError and never resolves as a normal result.
   */
  privateAgentRequirementsWithHandle(req: AgentRequirementsContractRequest): {
    id: number
    promise: Promise<AgentRequirementsResult>
    cancel: (msg?: string) => boolean
  } {
    validateAgentRequirementsContractRequest(req)
    if (this.disposed) throw new Error("Peer disposed")
    if (!this.available || !this.peer || this.peer.getState() !== "open") {
      throw new Error("Private peer unavailable")
    }
    if (!this.hasCapability("agent/requirements")) {
      throw new Error("Private peer missing agent/requirements capability")
    }
    const currentEpoch = this.opts.epoch
    const peerAtCall = this.peer
    const { id, promise: rawPromise } = peerAtCall.requestWithId("agent/requirements", req)
    const promise = (async (): Promise<AgentRequirementsResult> => {
      let raw: unknown
      try {
        raw = (await rawPromise) as unknown
      } catch (e: unknown) {
        if (this.isClosedHandle(peerAtCall, currentEpoch, e)) return makeAgentRequirementsAmbiguous(req, true)
        const { code, msg } = this.parseFailedInfo(e)
        return this.failedAgentRequirements(req, code, msg)
      }
      if (this.isStaleHandle(peerAtCall, currentEpoch)) return makeAgentRequirementsAmbiguous(req, true)
      const out: AgentRequirementsWireOutcome = normalizePrivateAgentRequirementsWire(raw, req)
      if (out.kind === "invalid") throw new AgentRequirementsValidationError(out.detail)
      return out.result
    })()
    const cancel = this.makeHandleCancel(id as unknown as number, req.opId, peerAtCall, currentEpoch)
    return { id: id as unknown as number, promise, cancel }
  }

  /**
   * Internal normalized handle for the read-only agent-requirements private-first read.
   * Resolves the discriminated wire outcome so invalid wire is an explicit
   * `{ kind: "invalid" }` value consumed before any SDK fallback, never a
   * normal result. Transport/closed/epoch semantics match the public handle.
   */
  privateAgentRequirementsOutcomeWithHandle(req: AgentRequirementsContractRequest): {
    id: number
    promise: Promise<AgentRequirementsWireOutcome>
    cancel: (msg?: string) => boolean
  } {
    validateAgentRequirementsContractRequest(req)
    if (this.disposed) throw new Error("Peer disposed")
    if (!this.available || !this.peer || this.peer.getState() !== "open") {
      throw new Error("Private peer unavailable")
    }
    if (!this.hasCapability("agent/requirements")) {
      throw new Error("Private peer missing agent/requirements capability")
    }
    const currentEpoch = this.opts.epoch
    const peerAtCall = this.peer
    const { id, promise: rawPromise } = peerAtCall.requestWithId("agent/requirements", req)
    const promise = (async (): Promise<AgentRequirementsWireOutcome> => {
      let raw: unknown
      try {
        raw = (await rawPromise) as unknown
      } catch (e: unknown) {
        if (this.isClosedHandle(peerAtCall, currentEpoch, e))
          return { kind: "valid", result: makeAgentRequirementsAmbiguous(req, true) }
        const { code, msg } = this.parseFailedInfo(e)
        return { kind: "valid", result: this.failedAgentRequirements(req, code, msg) }
      }
      if (this.isStaleHandle(peerAtCall, currentEpoch))
        return { kind: "valid", result: makeAgentRequirementsAmbiguous(req, true) }
      return normalizePrivateAgentRequirementsWire(raw, req)
    })()
    const cancel = this.makeHandleCancel(id as unknown as number, req.opId, peerAtCall, currentEpoch)
    return { id: id as unknown as number, promise, cancel }
  }

  async privateSkillRemove(req: SkillRemoveContractRequest): Promise<SkillRemoveResult> {
    const handle = this.privateSkillRemoveWithHandle(req)
    return handle.promise
  }

  /** Atomic handle: allocates id synchronously and returns exact id for timeout cancellation ownership.
   * Resolved values are always strictly valid results; invalid wire rejects
   * with SkillRemoveValidationError and never resolves as a normal result.
   */
  privateSkillRemoveWithHandle(req: SkillRemoveContractRequest): {
    id: number
    promise: Promise<SkillRemoveResult>
    cancel: (msg?: string) => boolean
  } {
    validateSkillRemoveContractRequest(req)
    if (this.disposed) throw new Error("Peer disposed")
    if (!this.available || !this.peer || this.peer.getState() !== "open") {
      throw new Error("Private peer unavailable")
    }
    if (!this.hasCapability("skill/remove")) {
      throw new Error("Private peer missing skill/remove capability")
    }
    const currentEpoch = this.opts.epoch
    const peerAtCall = this.peer
    const { id, promise: rawPromise } = peerAtCall.requestWithId("skill/remove", req)
    const promise = (async (): Promise<SkillRemoveResult> => {
      let raw: unknown
      try {
        raw = (await rawPromise) as unknown
      } catch (e: unknown) {
        if (this.isClosedHandle(peerAtCall, currentEpoch, e)) return makeSkillRemoveAmbiguous(req, true)
        return makeSkillRemoveAmbiguous(req, true)
      }
      if (this.isStaleHandle(peerAtCall, currentEpoch)) return makeSkillRemoveAmbiguous(req, true)
      const out: SkillRemoveWireOutcome = normalizePrivateSkillRemoveWire(raw, req)
      if (out.kind === "invalid") throw new SkillRemoveValidationError(out.detail)
      return out.result
    })()
    const cancel = this.makeHandleCancel(id as unknown as number, req.opId, peerAtCall, currentEpoch)
    return { id: id as unknown as number, promise, cancel }
  }

  /**
   * Internal normalized handle for the private-only skill/remove mutation.
   * Resolves the discriminated wire outcome so invalid wire is an explicit
   * `{ kind: "invalid" }` value consumed before any refresh decision, never
   * a normal result. Transport/closed/epoch semantics match the public
   * handle. There is no SDK fallback: every non-succeeded outcome fails
   * closed and re-observes authoritative skills.
   */
  privateSkillRemoveOutcomeWithHandle(req: SkillRemoveContractRequest): {
    id: number
    promise: Promise<SkillRemoveWireOutcome>
    cancel: (msg?: string) => boolean
  } {
    validateSkillRemoveContractRequest(req)
    if (this.disposed) throw new Error("Peer disposed")
    if (!this.available || !this.peer || this.peer.getState() !== "open") {
      throw new Error("Private peer unavailable")
    }
    if (!this.hasCapability("skill/remove")) {
      throw new Error("Private peer missing skill/remove capability")
    }
    const currentEpoch = this.opts.epoch
    const peerAtCall = this.peer
    const { id, promise: rawPromise } = peerAtCall.requestWithId("skill/remove", req)
    const promise = (async (): Promise<SkillRemoveWireOutcome> => {
      let raw: unknown
      try {
        raw = (await rawPromise) as unknown
      } catch (e: unknown) {
        if (this.isClosedHandle(peerAtCall, currentEpoch, e))
          return { kind: "valid", result: makeSkillRemoveAmbiguous(req, true) }
        return { kind: "valid", result: makeSkillRemoveAmbiguous(req, true) }
      }
      if (this.isStaleHandle(peerAtCall, currentEpoch))
        return { kind: "valid", result: makeSkillRemoveAmbiguous(req, true) }
      return normalizePrivateSkillRemoveWire(raw, req)
    })()
    const cancel = this.makeHandleCancel(id as unknown as number, req.opId, peerAtCall, currentEpoch)
    return { id: id as unknown as number, promise, cancel }
  }

  /** Normalized outcome handle for the read-only session-list parity observer. */
  privateSessionListOutcomeWithHandle(req: ServePrivateSessionListRequest): {
    id: number
    promise: Promise<PrivateSessionListWireOutcome>
    cancel: (msg?: string) => boolean
  } {
    validateSessionListRequest(req)
    if (this.disposed) throw new Error("Peer disposed")
    if (!this.available || !this.peer || this.peer.getState() !== "open") {
      throw new Error("Private peer unavailable")
    }
    if (!this.hasCapability("experimental/session/list")) {
      throw new Error("Private peer missing experimental/session/list capability")
    }
    const currentEpoch = this.opts.epoch
    const peerAtCall = this.peer
    return requestSessionListOutcome(
      peerAtCall as unknown as import("./serve-private-session-list").SessionListRawTransport,
      {
        isStale: () => this.isStaleHandle(peerAtCall, currentEpoch),
        isClosed: (e) => this.isClosedHandle(peerAtCall, currentEpoch, e),
        failInfo: (e) => ({ ...this.parseFailedInfo(e), msg: "private session-list transport failed" }),
      },
      (id) => this.makeHandleCancel(id, req.opId, peerAtCall, currentEpoch),
      req,
    )
  }

  async privatePath(req: PathContractRequest): Promise<PathResult> {
    const handle = this.privatePathOutcomeWithHandle(req)
    const outcome = await handle.promise
    if (outcome.kind === "invalid") throw new PathValidationError(outcome.detail)
    return outcome.result
  }

  /** Normalized outcome handle for the private-first path read. */
  privatePathOutcomeWithHandle(req: PathContractRequest): {
    id: number
    promise: Promise<PathWireOutcome>
    cancel: (msg?: string) => boolean
  } {
    validatePathContractRequest(req)
    if (this.disposed) throw new Error("Peer disposed")
    if (!this.available || !this.peer || this.peer.getState() !== "open") {
      throw new Error("Private peer unavailable")
    }
    if (!this.hasCapability("path/get")) {
      throw new Error("Private peer missing path/get capability")
    }
    const currentEpoch = this.opts.epoch
    const peerAtCall = this.peer
    return requestPathOutcome(
      peerAtCall as unknown as import("./serve-private-path").PathRawTransport,
      {
        isStale: () => this.isStaleHandle(peerAtCall, currentEpoch),
        isClosed: (e) => this.isClosedHandle(peerAtCall, currentEpoch, e),
        failInfo: (e) => ({ ...this.parseFailedInfo(e), msg: "private path transport failed" }),
      },
      (id) => this.makeHandleCancel(id, req.opId, peerAtCall, currentEpoch),
      req,
    )
  }

  async privateCommandList(req: CommandListContractRequest): Promise<CommandListResult> {
    const handle = this.privateCommandListOutcomeWithHandle(req)
    const outcome = await handle.promise
    if (outcome.kind === "invalid") throw new CommandListValidationError(outcome.detail)
    return outcome.result
  }

  /** Normalized outcome handle for the read-only command-list parity observer. */
  privateCommandListOutcomeWithHandle(req: CommandListContractRequest): {
    id: number
    promise: Promise<CommandListWireOutcome>
    cancel: (msg?: string) => boolean
  } {
    validateCommandListRequest(req)
    if (this.disposed) throw new Error("Peer disposed")
    if (!this.available || !this.peer || this.peer.getState() !== "open") {
      throw new Error("Private peer unavailable")
    }
    if (!this.hasCapability("command/list")) {
      throw new Error("Private peer missing command/list capability")
    }
    const currentEpoch = this.opts.epoch
    const peerAtCall = this.peer
    return requestCommandListOutcome(
      peerAtCall as unknown as import("./serve-private-command-list").CommandListRawTransport,
      {
        isStale: () => this.isStaleHandle(peerAtCall, currentEpoch),
        isClosed: (e) => this.isClosedHandle(peerAtCall, currentEpoch, e),
        failInfo: (e) => ({ ...this.parseFailedInfo(e), msg: "private command-list transport failed" }),
      },
      (id) => this.makeHandleCancel(id, req.opId, peerAtCall, currentEpoch),
      req,
    )
  }

  /** Normalized outcome handle for the read-only config-warnings parity observer. */
  privateConfigWarningsOutcomeWithHandle(req: ConfigWarningsContractRequest): {
    id: number
    promise: Promise<ConfigWarningsWireOutcome>
    cancel: (msg?: string) => boolean
  } {
    validateConfigWarningsRequest(req)
    if (this.disposed) throw new Error("Peer disposed")
    if (!this.available || !this.peer || this.peer.getState() !== "open") {
      throw new Error("Private peer unavailable")
    }
    if (!this.hasCapability("config/warnings")) {
      throw new Error("Private peer missing config/warnings capability")
    }
    const currentEpoch = this.opts.epoch
    const peerAtCall = this.peer
    return requestConfigWarningsOutcome(
      peerAtCall as unknown as import("./serve-private-config-warnings").ConfigWarningsRawTransport,
      {
        isStale: () => this.isStaleHandle(peerAtCall, currentEpoch),
        isClosed: (e) => this.isClosedHandle(peerAtCall, currentEpoch, e),
        failInfo: () => ({ code: "transport", msg: "private config-warnings transport failed" }),
      },
      (id) =>
        makeConfigWarningsCancel(id, {
          isStale: () => this.isStaleHandle(peerAtCall, currentEpoch),
          tryCancel: (msg) => this.tryCancelPending(id, msg),
          invalidate: (reason) => this.invalidateOnObserverTimeout(reason),
        }),
      req,
    )
  }

  /** Normalized outcome handle for the read-only project-current vcs-only parity observer. */
  privateProjectCurrentOutcomeWithHandle(req: ProjectCurrentContractRequest): {
    id: number
    promise: Promise<ProjectCurrentWireOutcome>
    cancel: (msg?: string) => boolean
  } {
    validateProjectCurrentRequest(req)
    if (this.disposed) throw new Error("Peer disposed")
    if (!this.available || !this.peer || this.peer.getState() !== "open") {
      throw new Error("Private peer unavailable")
    }
    if (!this.hasCapability("project/current")) {
      throw new Error("Private peer missing project/current capability")
    }
    const currentEpoch = this.opts.epoch
    const peerAtCall = this.peer
    return requestProjectCurrentOutcome(
      peerAtCall as unknown as import("./serve-private-project-current").ProjectCurrentRawTransport,
      {
        isStale: () => this.isStaleHandle(peerAtCall, currentEpoch),
        isClosed: (e) => this.isClosedHandle(peerAtCall, currentEpoch, e),
        failInfo: () => ({ code: "transport", msg: "private project-current transport failed" }),
      },
      (id) =>
        makeProjectCurrentCancel(id, {
          isStale: () => this.isStaleHandle(peerAtCall, currentEpoch),
          tryCancel: (msg) => this.tryCancelPending(id, msg),
          invalidate: (reason) => this.invalidateOnObserverTimeout(reason),
        }),
      req,
    )
  }

  async privateFindFiles(
    req: FindFilesContractRequest,
  ): Promise<import("./serve-private-find-files-contract").FindFilesResult> {
    const handle = this.privateFindFilesOutcomeWithHandle(req)
    const outcome = await handle.promise
    if (outcome.kind === "invalid") throw new FindFilesValidationError(outcome.detail)
    return outcome.result
  }

  /** Normalized outcome handle for the read-only find/files parity observer. */
  privateFindFilesOutcomeWithHandle(req: FindFilesContractRequest): {
    id: number
    promise: Promise<FindFilesWireOutcome>
    cancel: (msg?: string) => boolean
  } {
    validateFindFilesRequest(req)
    if (this.disposed) throw new Error("Peer disposed")
    if (!this.available || !this.peer || this.peer.getState() !== "open") {
      throw new Error("Private peer unavailable")
    }
    if (!this.hasCapability("find/files")) {
      throw new Error("Private peer missing find/files capability")
    }
    const currentEpoch = this.opts.epoch
    const peerAtCall = this.peer
    return requestFindFilesOutcome(
      peerAtCall as unknown as import("./serve-private-find-files").FindFilesRawTransport,
      {
        isStale: () => this.isStaleHandle(peerAtCall, currentEpoch),
        isClosed: (e) => this.isClosedHandle(peerAtCall, currentEpoch, e),
        failInfo: () => ({ code: "transport", msg: "private find failed" }),
      },
      (id) =>
        makeFindFilesCancel(id, {
          isStale: () => this.isStaleHandle(peerAtCall, currentEpoch),
          tryCancel: (msg) => this.tryCancelPending(id, msg),
          invalidate: (reason) => this.invalidateOnObserverTimeout(reason),
        }),
      req,
    )
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.available = false
    this.initSeq += 1
    this.initializing = null
    bestEffortDispose(this.peer, "dispose")
    this.peer = null
  }

  private markTransportInvalidated(): void {
    this.invalidated = true
    this.available = false
    if (this.opts.reader) invalidatedTransports.add(this.opts.reader as object)
    if (this.opts.writer) invalidatedTransports.add(this.opts.writer as object)
  }

  getPendingCount(): number {
    return this.peer?.getPendingCount() ?? 0
  }

  /**
   * Controlled convergence transport (first unit). Exact epoch pinning with
   * fail-closed capability check; stale epoch or closed transport throws so
   * the caller maps acquire=>blocked and resolve=>pending (never fallback,
   * never rewrite). Exact cancel via tryCancelPending by the owner.
   */
  async requestConvergence(
    method: "config/convergence/acquire" | "config/convergence/resolve" | "config/convergence/observe",
    params: unknown,
  ): Promise<unknown> {
    if (this.disposed) throw new Error("Peer disposed")
    if (!this.available || !this.peer || this.peer.getState() !== "open") throw new Error("Private peer unavailable")
    if (!this.hasCapability(method)) throw new Error(`Private peer missing ${method} capability`)
    const epoch = this.opts.epoch
    const peer = this.peer
    const { promise } = peer.requestWithId(method, params)
    const raw = await promise
    if (this.peer !== peer || this.opts.epoch !== epoch || peer.getState() !== "open")
      throw new Error("convergence epoch changed")
    return raw
  }

  peekNextJsonRpcId(): number | null {
    return this.peer?.peekNextId() ?? null
  }

  tryCancelPending(id: number, message = "private parity timeout"): boolean {
    return this.peer?.tryCancelPending(id as unknown as never, message) ?? false
  }

  /**
   * Private observer timeout invalidates this private peer epoch; thereafter
   * private parity remains disabled (fail-closed) until the next full backend
   * connection/server reset (no automatic retry/reconnect, no detached work).
   * The owner (KiloConnectionService) disposes and nulls this peer and will
   * re-negotiate only on next connect/reconnect.
   */
  private invalidateSafeBranch(reason: string): boolean {
    const branch =
      pathObserverTimeoutBranch(reason) ??
      configWarningsObserverTimeoutBranch(reason) ??
      projectCurrentObserverTimeoutBranch(reason) ??
      findFilesObserverTimeoutBranch(reason)
    if (!branch) return false
    if (branch.op === "session/messages") {
      console.warn(`[Kilo PrivatePeer] observer timeout invalidates epoch:`, { op: branch.op, epoch: this.opts.epoch })
    } else {
      console.warn(`[Kilo PrivatePeer] observer timeout invalidates:`, {
        op: branch.op,
        invalidated: true,
      })
    }
    try {
      this.dispose()
    } catch {
      console.warn("[Kilo PrivatePeer] invalidate dispose failed:", { op: branch.op, invalidateFailed: true })
    }
    return true
  }

  invalidateOnObserverTimeout(reason: string): void {
    if (this.invalidateSafeBranch(reason)) return
    console.warn(`[Kilo PrivatePeer] observer timeout invalidates epoch ${this.opts.epoch}: ${reason}`)
    try {
      this.dispose()
    } catch (e) {
      console.warn("[Kilo PrivatePeer] invalidate dispose failed:", String(e))
    }
  }

  getProtocolForFixture(): { name: string; major: number; minor?: number } | null {
    const raw = this.initRaw as Record<string, unknown> | null
    if (!raw) return null
    const proto = raw.protocol as Record<string, unknown> | undefined
    if (proto && typeof proto.name === "string" && typeof proto.major === "number") {
      const out: { name: string; major: number; minor?: number } = {
        name: proto.name as string,
        major: proto.major as number,
      }
      if (typeof proto.minor === "number") out.minor = proto.minor as number
      return out
    }
    // fallback shapes
    if (typeof raw.protocolVersion === "string") {
      const parts = (raw.protocolVersion as string).split(".")
      const maj = Number(parts[0])
      const min = parts[1] !== undefined ? Number(parts[1]) : undefined
      if (!Number.isNaN(maj))
        return { name: "kilo-private", major: maj, ...(min !== undefined && !Number.isNaN(min) ? { minor: min } : {}) }
    }
    return null
  }

  getPeerStateForFixture(): string {
    if (this.disposed) return "disposed"
    if (!this.peer) return "absent"
    try {
      return this.peer.getState()
    } catch {
      return "unknown"
    }
  }

  private collectKnownKeys(c: Record<string, unknown>, out: string[]): void {
    for (const k of Object.keys(c)) {
      if (
        (k === "session/cancelQueued" ||
          k === "session/update" ||
          k === "session/fork" ||
          k === "session/create" ||
          k === "session/delete" ||
          k === "session/abort" ||
          k === "session/status" ||
          k === "session/get" ||
          k === "session/messages" ||
          k === "session/children" ||
          k === "remote/status" ||
          k === "experimental/session/list" ||
          k === "path/get" ||
          k === "command/list" ||
          k === "config/warnings" ||
          k === "project/current" ||
          k === "find/files") &&
        c[k]
      )
        out.push(k)
    }
  }

  private collectSessionArray(c: Record<string, unknown>, out: string[]): void {
    if (!Array.isArray(c.session)) return
    for (const v of c.session as unknown[]) {
      if (v === "cancelQueued") out.push("session/cancelQueued")
      else if (v === "update") out.push("session/update")
      else if (v === "fork") out.push("session/fork")
      else if (v === "create") out.push("session/create")
      else if (v === "delete") out.push("session/delete")
      else if (v === "abort") out.push("session/abort")
      else if (v === "status") out.push("session/status")
      else if (v === "get") out.push("session/get")
      else if (v === "messages") out.push("session/messages")
      else if (v === "children") out.push("session/children")
    }
  }

  private collectSessionObject(c: Record<string, unknown>, out: string[]): void {
    if (typeof c.session !== "object" || c.session === null) return
    const sess = c.session as Record<string, unknown>
    if (sess.cancelQueued) out.push("session/cancelQueued")
    if (sess.update) out.push("session/update")
    if (sess.fork) out.push("session/fork")
    if (sess.create) out.push("session/create")
    if (sess.delete) out.push("session/delete")
    if (sess.abort) out.push("session/abort")
    if (sess.status) out.push("session/status")
    if (sess.get) out.push("session/get")
    if (sess.messages) out.push("session/messages")
    if (sess.children) out.push("session/children")
  }

  private capsFromRecord(c: Record<string, unknown>): string[] {
    const out: string[] = []
    this.collectKnownKeys(c, out)
    this.collectSessionArray(c, out)
    this.collectSessionObject(c, out)
    return [...new Set(out)]
  }

  getCapabilitiesListForFixture(): string[] {
    const caps = this.capabilities
    if (!caps) return []
    if (Array.isArray(caps)) return [...(caps as string[])]
    if (typeof caps === "object") return this.capsFromRecord(caps as Record<string, unknown>)
    return []
  }
}

export function getSdkHttpStatus(sdk: { response?: unknown; error?: unknown; data?: unknown }): number | null {
  const resp = (sdk as { response?: unknown }).response as { status?: unknown } | undefined
  if (
    resp &&
    typeof resp.status === "number" &&
    Number.isInteger(resp.status) &&
    resp.status >= 100 &&
    resp.status < 600
  )
    return resp.status
  if (resp && typeof resp.status === "string") {
    const n = Number(resp.status)
    if (Number.isInteger(n) && n >= 100 && n < 600) return n
  }
  return null
}

function sdkHttpStatus(sdk: { data?: unknown; error?: unknown; response?: unknown }): number | null {
  const fromResponse = getSdkHttpStatus(sdk as { response?: unknown })
  if (fromResponse !== null) return fromResponse
  if (!sdk.error) return null
  const err = sdk.error as Record<string, unknown>
  const candidates: unknown[] = [
    err.status,
    err.statusCode,
    err.code,
    err.httpStatus,
    (err as Record<string, unknown>).status_code,
    (err as Record<string, unknown>).httpStatusCode,
  ]
  for (const c of candidates) {
    if (typeof c === "number" && Number.isInteger(c) && c >= 100 && c < 600) return c
    if (typeof c === "string") {
      const n = Number(c)
      if (Number.isInteger(n) && n >= 100 && n < 600) return n
    }
  }
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

function sdkStatusClass(status: number | null): string | null {
  if (status === null) return null
  if (status === 400) return "400"
  if (status === 404) return "404"
  if (status === 409) return "409"
  if (status === 500) return "500"
  return String(status)
}

// eslint-disable-next-line complexity
export function compareParity(
  priv: ServePrivateCancelQueuedResult,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
): { divergence: string | null; details: Record<string, unknown> } {
  const privStatus: string = priv.status
  const isTransportUnknown = !!(priv as Record<string, unknown>).transportUnknown
  if (isTransportUnknown) {
    return { divergence: "transport-unknown", details: { privStatus, transportUnknown: true } }
  }
  const sdkError = sdk.error !== undefined && sdk.error !== null
  const sdkStatus: string = sdkError ? "failed" : "succeeded"
  // ambiguous without transportUnknown maps to SDK 409 class
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
    const sdkCancelled: unknown = sdk.data
    const privCancelled: unknown = (priv as Extract<ServePrivateCancelQueuedResult, { status: "succeeded" }>).data
      ?.cancelled
    if (sdkCancelled !== privCancelled) {
      return {
        divergence: `cancelled-mismatch:sdk=${String(sdkCancelled)} priv=${String(privCancelled)}`,
        details: { sdkCancelled, privCancelled },
      }
    }
    return { divergence: null, details: {} }
  }
  if (sdkStatus === "failed" && privStatus === "failed") {
    const privCode: string = ((priv as Extract<ServePrivateCancelQueuedResult, { status: "failed" }>).failure?.code ??
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
          divergence: `failure-class-mismatch:sdk=${String(cls)} priv=${privCode}`,
          details: { sdkClass: cls, privCode, http },
        }
      }
      return { divergence: null, details: { sdkClass: cls, privCode } }
    }
    // fallback when SDK class unknown: require exact code equality only if SDK provides string code that looks like typed code
    const sdkCodeRaw: string | undefined = (() => {
      const e = sdk.error as Record<string, unknown>
      const c = e.code ?? e.status ?? e._tag
      if (typeof c === "string" && c.length > 0 && !/^\d+$/.test(c)) return c
      return undefined
    })()
    if (sdkCodeRaw && privCode !== sdkCodeRaw) {
      return {
        divergence: `failure-code-mismatch:sdk=${sdkCodeRaw} priv=${privCode}`,
        details: { sdkCode: sdkCodeRaw, privCode },
      }
    }
    return { divergence: null, details: {} }
  }
  return { divergence: null, details: {} }
}

// eslint-disable-next-line complexity
export function compareUpdateParity(
  priv: ServePrivateSessionUpdateResult,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
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
    const sdkData = sdk.data as Record<string, unknown> | undefined
    const sdkTitle: unknown =
      sdkData?.title ?? (sdkData?.session as Record<string, unknown> | undefined)?.title ?? sdk.data
    const pdata = (priv as Extract<ServePrivateSessionUpdateResult, { status: "succeeded" }>).data as Record<
      string,
      unknown
    >
    const privTitle: unknown =
      (pdata as Record<string, unknown>).title ??
      ((pdata as Record<string, unknown>).session as Record<string, unknown> | undefined)?.title
    // If both are plain strings, compare directly; otherwise compare title fields
    const sdkStr =
      typeof sdkTitle === "string" ? sdkTitle : typeof sdkData?.title === "string" ? sdkData?.title : sdkTitle
    const privStr = typeof privTitle === "string" ? privTitle : undefined
    if (typeof sdkStr === "string" && typeof privStr === "string") {
      if (sdkStr !== privStr) {
        return { divergence: `title-mismatch`, details: { mismatch: true } }
      }
      return { divergence: null, details: {} }
    }
    // fallback: compare stringified data when title not extractable — treat as divergence if not equal (redacted)
    if (String(sdkTitle) !== String(privTitle)) {
      return { divergence: `title-mismatch`, details: { mismatch: true } }
    }
    return { divergence: null, details: {} }
  }
  if (sdkStatus === "failed" && privStatus === "failed") {
    const privCode: string = ((priv as Extract<ServePrivateSessionUpdateResult, { status: "failed" }>).failure?.code ??
      "unknown") as string
    const http = sdkHttpStatus(sdk)
    const cls = sdkStatusClass(http)
    const allowed = (() => {
      if (cls === "400") return new Set(["validation.failed", "scope_mismatch", "invalid.title"])
      if (cls === "404") return new Set(["session.not_found"])
      if (cls === "409") return new Set(["stale", "conflict", "InstanceUnavailableDuringConfigRebuild"])
      if (cls === "500") return new Set(["internal"])
      return null
    })()
    if (allowed) {
      if (!allowed.has(privCode)) {
        return {
          divergence: `failure-class-mismatch:sdk=${String(cls)} priv=${privCode}`,
          details: { sdkClass: cls, privCode, http },
        }
      }
      return { divergence: null, details: { sdkClass: cls, privCode } }
    }
    const sdkCodeRaw: string | undefined = (() => {
      const e = sdk.error as Record<string, unknown>
      const c = e.code ?? e.status ?? e._tag
      if (typeof c === "string" && c.length > 0 && !/^\d+$/.test(c)) return c
      return undefined
    })()
    if (sdkCodeRaw && privCode !== sdkCodeRaw) {
      return {
        divergence: `failure-code-mismatch:sdk=${sdkCodeRaw} priv=${privCode}`,
        details: { sdkCode: sdkCodeRaw, privCode },
      }
    }
    return { divergence: null, details: {} }
  }
  return { divergence: null, details: {} }
}

// eslint-disable-next-line complexity
export function compareForkParity(
  priv: ServePrivateForkResult,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
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
    const sdkData = sdk.data as Record<string, unknown> | undefined
    const sdkSess =
      (sdkData as Record<string, unknown> | undefined) ?? (sdk.data as Record<string, unknown> | undefined)
    const sdkId: unknown = (sdkSess as Record<string, unknown> | undefined)?.id ?? sdk.data
    const pdata = (priv as Extract<ServePrivateForkResult, { status: "succeeded" }>).data as Record<string, unknown>
    const privSess = (pdata.session as Record<string, unknown> | undefined) ?? (pdata as Record<string, unknown>)
    const privId: unknown = (privSess as Record<string, unknown>)?.id ?? pdata.id
    if (String(sdkId) !== String(privId)) {
      return {
        divergence: `fork-id-mismatch`,
        details: { mismatch: true, field: "id", sdkId: String(sdkId), privId: String(privId) },
      }
    }
    const sdkParent: unknown =
      (sdkSess as Record<string, unknown> | undefined)?.parentID ??
      (sdkSess as Record<string, unknown> | undefined)?.parent_id
    const privParent: unknown =
      (privSess as Record<string, unknown> | undefined)?.parentID ??
      (privSess as Record<string, unknown> | undefined)?.parent_id
    if (String(sdkParent ?? "") !== String(privParent ?? "")) {
      return {
        divergence: `fork-parent-mismatch`,
        details: {
          mismatch: true,
          field: "parentID",
          sdkParent: String(sdkParent ?? ""),
          privParent: String(privParent ?? ""),
        },
      }
    }
    const sdkDirRaw: unknown = (sdkSess as Record<string, unknown> | undefined)?.directory
    const privDirRaw: unknown = (privSess as Record<string, unknown> | undefined)?.directory
    if (typeof sdkDirRaw === "string" && typeof privDirRaw === "string") {
      let sdkDir = sdkDirRaw
      let privDir = privDirRaw
      try {
        sdkDir = canonicalDir(sdkDirRaw)
      } catch {}
      try {
        privDir = canonicalDir(privDirRaw)
      } catch {}
      if (sdkDir !== privDir) {
        return {
          divergence: `fork-directory-mismatch`,
          details: { mismatch: true, field: "directory", sdkDir, privDir },
        }
      }
    } else if (String(sdkDirRaw ?? "") !== String(privDirRaw ?? "")) {
      return {
        divergence: `fork-directory-mismatch`,
        details: {
          mismatch: true,
          field: "directory",
          sdkDir: String(sdkDirRaw ?? ""),
          privDir: String(privDirRaw ?? ""),
        },
      }
    }
    return { divergence: null, details: {} }
  }
  if (sdkStatus === "failed" && privStatus === "failed") {
    const privCode: string = ((priv as Extract<ServePrivateForkResult, { status: "failed" }>).failure?.code ??
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
          divergence: `failure-class-mismatch:sdk=${String(cls)} priv=${privCode}`,
          details: { sdkClass: cls, privCode, http },
        }
      }
      return { divergence: null, details: { sdkClass: cls, privCode } }
    }
    const sdkCodeRaw: string | undefined = (() => {
      const e = sdk.error as Record<string, unknown>
      const c = e.code ?? e.status ?? e._tag
      if (typeof c === "string" && c.length > 0 && !/^\d+$/.test(c)) return c
      return undefined
    })()
    if (sdkCodeRaw && privCode !== sdkCodeRaw) {
      return {
        divergence: `failure-code-mismatch:sdk=${sdkCodeRaw} priv=${privCode}`,
        details: { sdkCode: sdkCodeRaw, privCode },
      }
    }
    return { divergence: null, details: {} }
  }
  return { divergence: null, details: {} }
}

// Stable field-wise comparison of one shared status entry. Only the complete
// SessionStatus semantic fields are compared (idle/busy: type only; retry:
// attempt/message/next/action incl. nested action fields with optional link;
// offline: requestID/message). No revision/time metadata exists on entries
// and none is compared. Returns the first differing field, or null when equal.
function compareStatusEntryField(sdkEntry: unknown, privEntry: unknown): string | null {
  if (!isRecord(sdkEntry) || !isRecord(privEntry)) return "entry"
  const sdk = sdkEntry as Record<string, unknown>
  const priv = privEntry as Record<string, unknown>
  const type = sdk.type
  if (type === "retry") {
    for (const f of ["attempt", "message", "next"]) {
      if (sdk[f] !== priv[f]) return f
    }
    const sdkAction = sdk.action
    const privAction = priv.action
    if (sdkAction === undefined && privAction === undefined) return null
    if (sdkAction === undefined || privAction === undefined) return "action"
    if (!isRecord(sdkAction) || !isRecord(privAction)) return "action"
    const sdkRec = sdkAction as Record<string, unknown>
    const privRec = privAction as Record<string, unknown>
    for (const f of ["reason", "provider", "title", "message", "label", "link"]) {
      if ((sdkRec[f] ?? undefined) !== (privRec[f] ?? undefined)) return `action.${f}`
    }
    return null
  }
  if (type === "offline") {
    if (sdk.requestID !== priv.requestID) return "requestID"
    if (sdk.message !== priv.message) return "message"
    return null
  }
  return null
}

// eslint-disable-next-line complexity
export function compareStatusParity(
  priv: ServePrivateStatusResult,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
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
    const sdkMap = (sdk.data ?? {}) as Record<string, { type?: unknown } | unknown>
    const privData = (priv as Extract<ServePrivateStatusResult, { status: "succeeded" }>).data
    const privMap = (privData.statuses ?? {}) as Record<string, { type?: unknown } | unknown>
    const sdkKeys = new Set(Object.keys(sdkMap))
    const privKeys = new Set(Object.keys(privMap))
    const missing = [...sdkKeys].filter((k) => !privKeys.has(k)).slice(0, 10)
    const extra = [...privKeys].filter((k) => !sdkKeys.has(k)).slice(0, 10)
    const typeMismatch: string[] = []
    for (const k of sdkKeys) {
      if (!privKeys.has(k)) continue
      const sdkType = (sdkMap[k] as { type?: unknown })?.type
      const privType = (privMap[k] as { type?: unknown })?.type
      if (sdkType !== privType) {
        typeMismatch.push(k)
        if (typeMismatch.length >= 10) break
      }
    }
    const fieldMismatch: string[] = []
    const fieldDetails: Array<{ sid: string; field: string }> = []
    for (const k of sdkKeys) {
      if (!privKeys.has(k)) continue
      const sdkType = (sdkMap[k] as { type?: unknown })?.type
      const privType = (privMap[k] as { type?: unknown })?.type
      if (sdkType !== privType) continue
      const field = compareStatusEntryField(sdkMap[k], privMap[k])
      if (field) {
        fieldMismatch.push(k)
        if (fieldDetails.length < 10) fieldDetails.push({ sid: k, field })
        if (fieldMismatch.length >= 10) break
      }
    }
    if (missing.length > 0 || extra.length > 0 || typeMismatch.length > 0 || fieldMismatch.length > 0) {
      return {
        divergence: `status-map-mismatch:missing=${missing.length} extra=${extra.length} typeMismatch=${typeMismatch.length} fieldMismatch=${fieldMismatch.length}`,
        details: {
          sdkSize: sdkKeys.size,
          privSize: privKeys.size,
          missing,
          extra,
          typeMismatch,
          fieldMismatch,
          fields: fieldDetails,
        },
      }
    }
    return { divergence: null, details: { sdkSize: sdkKeys.size, privSize: privKeys.size } }
  }
  if (sdkStatus === "failed" && privStatus === "failed") {
    const privCode: string = ((priv as Extract<ServePrivateStatusResult, { status: "failed" }>).failure?.code ??
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
          divergence: `failure-class-mismatch:sdk=${String(cls)} priv=${privCode}`,
          details: { sdkClass: cls, privCode, http },
        }
      }
      return { divergence: null, details: { sdkClass: cls, privCode } }
    }
    const sdkCodeRaw: string | undefined = (() => {
      const e = sdk.error as Record<string, unknown>
      const c = e.code ?? e.status ?? e._tag
      if (typeof c === "string" && c.length > 0 && !/^\d+$/.test(c)) return c
      return undefined
    })()
    if (sdkCodeRaw && privCode !== sdkCodeRaw) {
      return {
        divergence: `failure-code-mismatch:sdk=${sdkCodeRaw} priv=${privCode}`,
        details: { sdkCode: sdkCodeRaw, privCode },
      }
    }
    return { divergence: null, details: {} }
  }
  return { divergence: null, details: {} }
}

// eslint-disable-next-line complexity
export function compareCreateParity(
  priv: ServePrivateCreateResult,
  sdk: { data?: unknown; error?: unknown; response?: unknown },
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
    const sdkData = sdk.data as Record<string, unknown> | undefined
    const sdkSess =
      (sdkData as Record<string, unknown> | undefined) ?? (sdk.data as Record<string, unknown> | undefined)
    const sdkId: unknown = (sdkSess as Record<string, unknown> | undefined)?.id ?? sdk.data
    const pdata = (priv as Extract<ServePrivateCreateResult, { status: "succeeded" }>).data as Record<string, unknown>
    const privSess = pdata.session as Record<string, unknown> | undefined
    const privId: unknown = (privSess as Record<string, unknown>)?.id
    if (String(sdkId) !== String(privId)) {
      return {
        divergence: `create-id-mismatch`,
        details: { mismatch: true, field: "id", sdkId: String(sdkId), privId: String(privId) },
      }
    }
    const sdkDirRaw: unknown = (sdkSess as Record<string, unknown> | undefined)?.directory
    const privDirRaw: unknown = (privSess as Record<string, unknown> | undefined)?.directory
    if (typeof sdkDirRaw === "string" && typeof privDirRaw === "string") {
      let sdkDir = sdkDirRaw
      let privDir = privDirRaw
      try {
        sdkDir = canonicalDir(sdkDirRaw)
      } catch {}
      try {
        privDir = canonicalDir(privDirRaw)
      } catch {}
      if (sdkDir !== privDir) {
        return {
          divergence: `create-directory-mismatch`,
          details: { mismatch: true, field: "directory", sdkDir, privDir },
        }
      }
    } else if (String(sdkDirRaw ?? "") !== String(privDirRaw ?? "")) {
      return {
        divergence: `create-directory-mismatch`,
        details: {
          mismatch: true,
          field: "directory",
          sdkDir: String(sdkDirRaw ?? ""),
          privDir: String(privDirRaw ?? ""),
        },
      }
    }
    const sdkTitleRaw: unknown = (sdkSess as Record<string, unknown> | undefined)?.title
    const privTitleRaw: unknown = (privSess as Record<string, unknown> | undefined)?.title
    if (String(sdkTitleRaw ?? "") !== String(privTitleRaw ?? "")) {
      return {
        divergence: `create-title-mismatch`,
        details: {
          mismatch: true,
          field: "title",
          sdkTitle: String(sdkTitleRaw ?? ""),
          privTitle: String(privTitleRaw ?? ""),
        },
      }
    }
    // canonical requires priv session object; missing is divergence
    if (!privSess || typeof (privSess as Record<string, unknown>).id !== "string") {
      return {
        divergence: `create-id-mismatch`,
        details: { mismatch: true, field: "id", sdkId: String(sdkId), privId: String(privId) },
      }
    }
    return { divergence: null, details: {} }
  }
  if (sdkStatus === "failed" && privStatus === "failed") {
    const privCode: string = ((priv as Extract<ServePrivateCreateResult, { status: "failed" }>).failure?.code ??
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
          divergence: `failure-class-mismatch:sdk=${String(cls)} priv=${privCode}`,
          details: { sdkClass: cls, privCode, http },
        }
      }
      return { divergence: null, details: { sdkClass: cls, privCode } }
    }
    const sdkCodeRaw: string | undefined = (() => {
      const e = sdk.error as Record<string, unknown>
      const c = e.code ?? e.status ?? e._tag
      if (typeof c === "string" && c.length > 0 && !/^\d+$/.test(c)) return c
      return undefined
    })()
    if (sdkCodeRaw && privCode !== sdkCodeRaw) {
      return {
        divergence: `failure-code-mismatch:sdk=${sdkCodeRaw} priv=${privCode}`,
        details: { sdkCode: sdkCodeRaw, privCode },
      }
    }
    return { divergence: null, details: {} }
  }
  return { divergence: null, details: {} }
}
