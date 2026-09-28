import type { ObservationCreateOperationResult, ObservationDeleteOperationResult, ObservationOperationResult } from "../private-worker/observation"
import { ErrorCode } from "../private-worker/json-rpc"
import type { PrivateSessionReader } from "./options"
import { SessionNotFoundError, SessionScopeMismatchError } from "./session-detail"

export type PrivateOperationAttempt =
  | { kind: "found"; operation: { opId: string; outcome: string; code: string; message: string; time: number; cancel?: unknown; recovery?: unknown } }
  | { kind: "terminal"; error: SessionNotFoundError | SessionScopeMismatchError }
  | { kind: "unavailable" }

function isUsable(reader: PrivateSessionReader | null | undefined): reader is PrivateSessionReader & { operation: NonNullable<PrivateSessionReader["operation"]> } {
  return !!reader && typeof reader.operation === "function" && reader.isEnabled() && reader.isStarted()
}

function internal(msg: string): Error & { code?: number } {
  const err = new Error(msg) as Error & { code?: number }
  err.code = ErrorCode.InternalError
  return err
}

const OUTCOMES = new Set(["succeeded", "failed", "ambiguous", "in-flight", "superseded", "abandoned"])
const OP_KEYS = new Set(["opId", "outcome", "code", "message", "time", "cancel", "recovery", "forkedSessionId"])
const CANCELS = new Set(["user_stop", "steering", "timeout", "network_disconnect", "unknown"])
const REC_KEYS = new Set(["v", "owner", "scope", "used", "limit", "terminated", "nextAt", "retryOccurrence", "layer", "closeReason", "replay"])

function checkCancel(op: Record<string, unknown>): void {
  if (!("cancel" in op) || op.cancel === undefined) return
  const c = op.cancel as Record<string, unknown>
  if (c === null || typeof c !== "object" || Array.isArray(c)) throw internal("operation returned invalid operation shape")
  if (typeof c.source !== "string" || !CANCELS.has(c.source as string)) throw internal("operation returned invalid operation shape")
  if (Object.keys(c).length !== 1) throw internal("operation returned invalid operation shape")
}

function checkKindBinding(opId: string, sessionId: string): "prompt" | "revert" | "unrevert" | "sessionUpdate" | "fork" {
  if (opId.startsWith("prompt:")) {
    const suffix = opId.slice("prompt:".length)
    if (suffix.length === 0 || !suffix.startsWith("msg") || suffix.includes(":")) throw internal("operation returned invalid operation shape")
    return "prompt"
  }
  for (const kind of ["revert", "unrevert", "sessionUpdate", "fork"] as const) {
    const prefix = `${kind}:${sessionId}:`
    if (opId.startsWith(prefix)) {
      const token = opId.slice(prefix.length)
      if (token.length === 0 || token.includes(":") || token.includes("\0")) throw internal("operation returned invalid operation shape")
      return kind
    }
  }
  throw internal("operation returned invalid operation shape")
}

function checkForkChild(op: Record<string, unknown>, sessionId: string, kind: "prompt" | "revert" | "unrevert" | "sessionUpdate" | "fork"): void {
  if (!("forkedSessionId" in op) || op.forkedSessionId === undefined) return
  if (kind !== "fork") throw internal("operation returned invalid operation shape")
  if ((op.outcome as string) !== "succeeded") throw internal("operation returned invalid operation shape")
  const child = op.forkedSessionId
  if (typeof child !== "string" || child.length === 0 || child.includes("\0") || !child.startsWith("ses")) throw internal("operation returned invalid operation shape")
  if (child === sessionId) throw internal("operation returned invalid operation shape")
  if ("recovery" in op && op.recovery !== undefined) throw internal("operation returned invalid operation shape")
}

function checkRecovery(op: Record<string, unknown>, sessionId: string, kind: "prompt" | "revert" | "unrevert" | "sessionUpdate" | "fork"): void {
  if (!("recovery" in op) || op.recovery === undefined) return
  if (kind !== "prompt") throw internal("operation returned invalid operation shape")
  const rv = op.recovery as Record<string, unknown>
  for (const k of Object.keys(rv)) if (!REC_KEYS.has(k)) throw internal("operation returned invalid operation shape")
  if (rv.v !== 1) throw internal("operation returned invalid operation shape")
  if (rv.owner !== "generation") throw internal("operation returned invalid operation shape")
  if (typeof rv.scope !== "string" || rv.scope.length === 0 || (rv.scope as string).includes("\0")) throw internal("operation returned invalid operation shape")
  if (rv.scope !== sessionId) throw internal("operation returned scope mismatch")
  if ((op.outcome as string) !== "failed" && (op.outcome as string) !== "abandoned") throw internal("operation returned invalid operation shape")
  if (rv.replay !== false) throw internal("operation returned invalid operation shape")
}

function checkEntry(op: Record<string, unknown>, sessionId: string, opId: string): void {
  for (const k of Object.keys(op)) if (!OP_KEYS.has(k)) throw internal("operation returned invalid operation shape")
  if (typeof op.opId !== "string" || op.opId.length === 0) throw internal("operation returned invalid operation shape")
  if (op.opId !== opId) throw internal("operation returned opId mismatch")
  const kind = checkKindBinding(op.opId as string, sessionId)
  if (typeof op.outcome !== "string" || !OUTCOMES.has(op.outcome as string)) throw internal("operation returned invalid operation shape")
  if (typeof op.code !== "string" || op.code.length === 0) throw internal("operation returned invalid operation shape")
  if (typeof op.message !== "string") throw internal("operation returned invalid operation shape")
  if (typeof op.time !== "number" || !Number.isFinite(op.time)) throw internal("operation returned invalid operation shape")
  checkCancel(op)
  checkRecovery(op, sessionId, kind)
  checkForkChild(op, sessionId, kind)
  if ("detail" in op || "stack" in op || "idempotencyHash" in op || "requestId" in op || "revision" in op || "opKind" in op) throw internal("operation returned invalid operation shape")
}

/**
 * Defensive revalidation of the private observation/operation result at the
 * provider boundary. Mirrors the controller wire invariants without
 * duplicating storage logic. Narrowly allows prompt:<messageId> plus exact
 * session-bound revert:<sessionId>:<token>, unrevert:<sessionId>:<token>,
 * sessionUpdate:<sessionId>:<token>, and fork:<sessionId>:<token>;
 * all other op kinds (create/delete/tombstones/etc) fail closed. Revert,
 * unrevert, sessionUpdate, and fork entries must carry no recovery
 * projection. Fork succeeded entries may carry an optional strictly
 * validated minimal forkedSessionId (ses id, not source, succeeded only).
 * Throws an InternalError-coded error on any malformed shape so callers
 * fail closed with zero SDK. No SDK fallback.
 */
export function validatePrivateOperationResult(raw: unknown, directory: string, sessionId: string, opId: string): ObservationOperationResult {
  void directory
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw internal("operation returned invalid shape")
  const r = raw as Record<string, unknown>
  if (r.v !== "1.0") throw internal("operation returned invalid version")
  if (typeof r.status !== "string" || !["found", "not_found", "scope_mismatch"].includes(r.status as string)) throw internal("operation returned invalid status")
  const status = r.status as string
  if (status === "not_found" || status === "scope_mismatch") {
    const allowed = new Set(["v", "status"])
    for (const k of Object.keys(r)) if (!allowed.has(k)) throw internal("operation returned invalid shape")
    if ("operation" in r) throw internal("operation returned invalid shape")
    return r as ObservationOperationResult
  }
  const allowedFound = new Set(["v", "status", "operation"])
  for (const k of Object.keys(r)) if (!allowedFound.has(k)) throw internal("operation returned invalid shape")
  if (!("operation" in r)) throw internal("operation returned invalid operation")
  checkEntry(r.operation as Record<string, unknown>, sessionId, opId)
  return r as ObservationOperationResult
}

/**
 * Non-owning single exact-opId private read. Never init/reconnect/dispose.
 * found: authoritative panel-safe entry with zero SDK. terminal: authoritative
 * not_found/scope_mismatch with zero SDK. unavailable: gate-off, throw,
 * malformed, or opId mismatch — caller fails closed with zero SDK and no
 * second private request. Never calls SDK.
 */
export async function tryPrivateOperationExact(
  reader: PrivateSessionReader | null | undefined,
  input: { directory: string; sessionId: string; opId: string },
): Promise<PrivateOperationAttempt> {
  if (!isUsable(reader)) return { kind: "unavailable" }
  let raw: unknown
  try {
    raw = await reader.operation({ directory: input.directory, sessionId: input.sessionId, opId: input.opId })
  } catch {
    return { kind: "unavailable" }
  }
  let validated: ObservationOperationResult
  try {
    validated = validatePrivateOperationResult(raw, input.directory, input.sessionId, input.opId)
  } catch {
    return { kind: "unavailable" }
  }
  if (validated.status === "found") return { kind: "found", operation: validated.operation as PrivateOperationAttempt extends { kind: "found"; operation: infer O } ? O : never }
  if (validated.status === "not_found") return { kind: "terminal", error: new SessionNotFoundError() }
  return { kind: "terminal", error: new SessionScopeMismatchError() }
}

export type PrivateCreateAttempt =
  | { kind: "found"; createdSessionId: string }
  | { kind: "not_found" }
  | { kind: "scope_mismatch" }
  | { kind: "unavailable" }

const CREATE_UUID_STRICT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isValidCreateOpId(opId: string): boolean {
  if (typeof opId !== "string" || !opId.startsWith("create:")) return false
  return CREATE_UUID_STRICT.test(opId.slice("create:".length))
}

function isValidCreatedId(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.startsWith("ses") && !v.includes("\0")
}

/**
 * Defensive revalidation of the INTERNAL observation/create-operation result.
 * Strictly allows only create:<uuid> opIds; found carries only the minimal
 * createdSessionId (ses id). Any snapshot/token/secret-bearing shape fails
 * closed. Throws InternalError-coded error on malformed shape.
 */
// eslint-disable-next-line complexity
export function validatePrivateCreateOperationResult(raw: unknown, opId: string): ObservationCreateOperationResult {
  if (!isValidCreateOpId(opId)) throw internal("create-operation returned invalid op id")
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw internal("create-operation returned invalid shape")
  const r = raw as Record<string, unknown>
  if (r.v !== "1.0") throw internal("create-operation returned invalid version")
  if (typeof r.status !== "string" || !["found", "not_found", "scope_mismatch"].includes(r.status as string))
    throw internal("create-operation returned invalid status")
  const status = r.status as string
  if (status === "not_found" || status === "scope_mismatch") {
    const allowed = new Set(["v", "status"])
    for (const k of Object.keys(r)) if (!allowed.has(k)) throw internal("create-operation returned invalid shape")
    if ("createdSessionId" in r) throw internal("create-operation returned invalid shape")
    return r as ObservationCreateOperationResult
  }
  const allowedFound = new Set(["v", "status", "createdSessionId"])
  for (const k of Object.keys(r)) if (!allowedFound.has(k)) throw internal("create-operation returned invalid shape")
  if (!isValidCreatedId(r.createdSessionId)) throw internal("create-operation returned invalid session shape")
  if ("operation" in r || "session" in r || "snapshot" in r || "token" in r || "sandbox" in r || "detail" in r || "stack" in r || "requestId" in r || "revision" in r || "opKind" in r)
    throw internal("create-operation returned invalid shape")
  return r as ObservationCreateOperationResult
}

function isCreateUsable(reader: PrivateSessionReader | null | undefined): reader is PrivateSessionReader & { createOperation: NonNullable<PrivateSessionReader["createOperation"]> } {
  return !!reader && typeof reader.createOperation === "function" && reader.isEnabled() && reader.isStarted()
}

/**
 * Non-owning single exact create:<uuid> private read keyed by opId +
 * directory only (no sessionId). Explicit not_found/scope_mismatch/
 * unavailable with zero SDK and no second private request. Never calls SDK.
 * Found returns only the minimal created session ID, never raw snapshot,
 * token, or secret.
 */
export async function tryPrivateCreateExact(
  reader: PrivateSessionReader | null | undefined,
  input: { directory: string; opId: string },
): Promise<PrivateCreateAttempt> {
  if (!isValidCreateOpId(input.opId)) return { kind: "unavailable" }
  if (!isCreateUsable(reader)) return { kind: "unavailable" }
  let raw: unknown
  try {
    raw = await reader.createOperation({ directory: input.directory, opId: input.opId })
  } catch {
    return { kind: "unavailable" }
  }
  let validated: ObservationCreateOperationResult
  try {
    validated = validatePrivateCreateOperationResult(raw, input.opId)
  } catch {
    return { kind: "unavailable" }
  }
  if (validated.status === "found") return { kind: "found", createdSessionId: validated.createdSessionId }
  if (validated.status === "not_found") return { kind: "not_found" }
  if (validated.status === "scope_mismatch") return { kind: "scope_mismatch" }
  return { kind: "unavailable" }
}

export type PrivateDeleteAttempt =
  | { kind: "found" }
  | { kind: "not_found" }
  | { kind: "scope_mismatch" }
  | { kind: "unavailable" };

const DELETE_UUID_STRICT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidDeleteOpId(opId: string, sessionId: string): boolean {
  if (typeof opId !== "string" || !opId.startsWith("delete:")) return false;
  const rest = opId.slice("delete:".length);
  const sep = rest.indexOf(":");
  if (sep <= 0 || sep === rest.length - 1) return false;
  const sid = rest.slice(0, sep);
  const token = rest.slice(sep + 1);
  if (sid !== sessionId) return false;
  if (sid.length === 0 || !sid.startsWith("ses") || sid.includes("\0")) return false;
  if (!DELETE_UUID_STRICT.test(token)) return false;
  return true;
}

/**
 * Defensive revalidation of the INTERNAL observation/delete-operation result.
 * Strictly allows only delete:<sessionId>:<uuid> opIds with session binding;
 * found carries no payload (exactly {v,status}), never raw code/message/hash.
 * Throws InternalError-coded error on malformed shape.
 */
// eslint-disable-next-line complexity
export function validatePrivateDeleteOperationResult(raw: unknown, sessionId: string, opId: string): ObservationDeleteOperationResult {
  if (!isValidDeleteOpId(opId, sessionId)) throw internal("delete-operation returned invalid op id");
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw internal("delete-operation returned invalid shape");
  const r = raw as Record<string, unknown>;
  if (r.v !== "1.0") throw internal("delete-operation returned invalid version");
  if (typeof r.status !== "string" || !["found", "not_found", "scope_mismatch"].includes(r.status as string))
    throw internal("delete-operation returned invalid status");
  const allowed = new Set(["v", "status"]);
  for (const k of Object.keys(r)) if (!allowed.has(k)) throw internal("delete-operation returned invalid shape");
  if ("operation" in r || "session" in r || "snapshot" in r || "token" in r || "sandbox" in r || "detail" in r || "stack" in r || "requestId" in r || "revision" in r || "opKind" in r || "code" in r || "message" in r || "hash" in r || "createdSessionId" in r)
    throw internal("delete-operation returned invalid shape");
  return r as ObservationDeleteOperationResult;
}

function isDeleteUsable(reader: PrivateSessionReader | null | undefined): reader is PrivateSessionReader & { deleteOperation: NonNullable<PrivateSessionReader["deleteOperation"]> } {
  return !!reader && typeof reader.deleteOperation === "function" && reader.isEnabled() && reader.isStarted();
}

/**
 * Non-owning single exact delete:<sessionId>:<uuid> tombstone read keyed by
 * directory+sessionId+opId. Read-only exact tombstone observation, never a
 * mutating dispatch and never SDK. Found means the exact tombstone committed
 * succeeded; not_found/scope_mismatch/unavailable never prune and never retry.
 */
export async function tryPrivateDeleteExact(
  reader: PrivateSessionReader | null | undefined,
  input: { directory: string; sessionId: string; opId: string },
): Promise<PrivateDeleteAttempt> {
  if (!isValidDeleteOpId(input.opId, input.sessionId)) return { kind: "unavailable" };
  if (!isDeleteUsable(reader)) return { kind: "unavailable" };
  let raw: unknown;
  try {
    raw = await reader.deleteOperation({ directory: input.directory, sessionId: input.sessionId, opId: input.opId });
  } catch {
    return { kind: "unavailable" };
  }
  let validated: ObservationDeleteOperationResult;
  try {
    validated = validatePrivateDeleteOperationResult(raw, input.sessionId, input.opId);
  } catch {
    return { kind: "unavailable" };
  }
  if (validated.status === "found") return { kind: "found" };
  if (validated.status === "not_found") return { kind: "not_found" };
  if (validated.status === "scope_mismatch") return { kind: "scope_mismatch" };
  return { kind: "unavailable" };
}
