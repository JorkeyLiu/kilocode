/**
 * Strict validation for the versioned redacted generation recovery projection.
 * Vscode-free pure helper so AgentManagerProvider stays under its complexity cap.
 */

const LAYERS = new Set(["provider", "incomplete", "broker", "task", "restart"])
const CLOSES = new Set(["completed", "interrupted", "error", "crash"])
const KEYS = new Set(["v", "owner", "scope", "used", "limit", "terminated", "nextAt", "retryOccurrence", "layer", "closeReason", "replay"])

function safeInt(x: unknown): boolean {
  return typeof x === "number" && Number.isSafeInteger(x) && (x as number) >= 0
}

function keysOk(rv: Record<string, unknown>): boolean {
  for (const k of Object.keys(rv)) if (!KEYS.has(k)) return false
  return true
}

function headOk(rv: Record<string, unknown>, sid: string): boolean {
  if (rv.v !== 1 || rv.owner !== "generation" || rv.replay !== false) return false
  if (typeof rv.scope !== "string" || rv.scope.length === 0 || (rv.scope as string).includes("\0")) return false
  return rv.scope === sid
}

function budgetOk(rv: Record<string, unknown>): boolean {
  if (!safeInt(rv.used) || !safeInt(rv.limit)) return false
  if ((rv.used as number) > (rv.limit as number)) return false
  return typeof rv.terminated === "boolean"
}

function timesOk(rv: Record<string, unknown>): boolean {
  if (rv.nextAt !== null && !safeInt(rv.nextAt)) return false
  return rv.retryOccurrence === null || safeInt(rv.retryOccurrence)
}

function vocabOk(rv: Record<string, unknown>): boolean {
  if (rv.layer !== null && (typeof rv.layer !== "string" || !LAYERS.has(rv.layer as string))) return false
  return rv.closeReason === null || (typeof rv.closeReason === "string" && CLOSES.has(rv.closeReason as string))
}

function coherenceOk(rv: Record<string, unknown>): boolean {
  if ((rv.terminated as boolean) !== (rv.closeReason !== null)) return false
  if (rv.closeReason !== null && rv.nextAt !== null) return false
  if (rv.closeReason === null && (((rv.layer as unknown) === null) !== (((rv.nextAt as unknown) === null)))) return false
  if (rv.retryOccurrence !== null && rv.layer === null) return false
  return !(rv.retryOccurrence !== null && rv.closeReason === null && rv.nextAt === null)
}

export function isValidPanelRecovery(rec: unknown, sid: string, outcome: string): boolean {
  if (rec === null || typeof rec !== "object" || Array.isArray(rec)) return false
  const rv = rec as Record<string, unknown>
  if (!keysOk(rv)) return false
  if (!headOk(rv, sid)) return false
  if (!budgetOk(rv)) return false
  if (!timesOk(rv)) return false
  if (!vocabOk(rv)) return false
  if (!coherenceOk(rv)) return false
  return outcome === "failed" || outcome === "abandoned"
}

const OUTCOMES = new Set(["succeeded", "failed", "ambiguous", "in-flight", "superseded", "abandoned"])
const CANCELS = new Set(["user_stop", "steering", "timeout", "network_disconnect", "unknown"])
const OP_KEYS = new Set(["opId", "outcome", "code", "message", "time", "cancel", "recovery"])

function shapeOk(op: Record<string, unknown>): boolean {
  if (typeof op.opId !== "string" || op.opId.length === 0) return false
  if (typeof op.outcome !== "string" || !OUTCOMES.has(op.outcome as string)) return false
  if (typeof op.code !== "string" || (op.code as string).length === 0) return false
  if (typeof op.message !== "string") return false
  return typeof op.time === "number" && Number.isFinite(op.time as number)
}

function leakOk(op: Record<string, unknown>): boolean {
  for (const k of Object.keys(op)) if (!OP_KEYS.has(k)) return false
  if (op.detail !== undefined || op.stack !== undefined) return false
  if (op.revision !== undefined || op.idempotencyHash !== undefined) return false
  return op.requestId === undefined && op.opKind === undefined
}

function cancelOk(op: Record<string, unknown>): boolean {
  const raw = op.cancel
  if (raw === undefined) return true
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return false
  const c = raw as Record<string, unknown>
  if (typeof c.source !== "string" || !CANCELS.has(c.source as string)) return false
  return Object.keys(c).length === 1
}

/**
 * Panel-safe derived fact only: strict shape, no diagnostic leak, versioned
 * redacted generation recovery projection for failed/abandoned, never a
 * replay instruction. No recovery for succeeded/in-flight/ambiguous/superseded.
 */
export function isPanelSafeOperation(op: unknown, sid: string): boolean {
  if (op === null || typeof op !== "object" || Array.isArray(op)) return false
  const rec = op as Record<string, unknown>
  if (!shapeOk(rec)) return false
  if (!leakOk(rec)) return false
  if (!cancelOk(rec)) return false
  const outcome = rec.outcome as string
  const recovery = rec.recovery
  if (recovery !== undefined && !isValidPanelRecovery(recovery, sid, outcome)) return false
  if (recovery !== undefined && outcome !== "failed" && outcome !== "abandoned") return false
  return true
}
