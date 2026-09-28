import type { PanelOperation } from "../src/types/messages/agent-manager"

// Fixed runtime-owned crash discriminants (packages/core/src/session/operation.ts):
// prompt pre-bind terminal `prompt.abandoned` / `prompt abandoned due to runtime restart`
// and provider crash terminal `provider.abandoned` / `Provider attempt abandoned after runtime restart`.
// Code alone is insufficient: live user cancel/scope shutdown reuse `prompt.abandoned`
// and legacy live paths reuse `provider.abandoned` with variable messages.
// Exact message match only; never render op.message and never infer from absent recovery.
const PROMPT_CRASH_CODE = "prompt.abandoned"
const PROMPT_CRASH_MESSAGE = "prompt abandoned due to runtime restart"
const PROVIDER_CRASH_CODE = "provider.abandoned"
const PROVIDER_CRASH_MESSAGE = "Provider attempt abandoned after runtime restart"

export const RUNTIME_RESTART_TEXT = "Stopped after runtime restart"

export function isRuntimeRestartAbandoned(op?: PanelOperation): boolean {
  if (!op || op.outcome !== "abandoned") return false
  if (typeof op.code !== "string" || typeof op.message !== "string") return false
  if (op.code === PROMPT_CRASH_CODE && op.message === PROMPT_CRASH_MESSAGE) return true
  return op.code === PROVIDER_CRASH_CODE && op.message === PROVIDER_CRASH_MESSAGE
}

export function operationStatusText(op?: PanelOperation): string | undefined {
  if (!op) return undefined
  if (op.outcome === "in-flight") return "Running"
  if (op.outcome === "succeeded") return undefined
  if (op.outcome === "failed") return `Failed · ${op.code}: ${op.message}`
  if (op.outcome === "abandoned") {
    if (isRuntimeRestartAbandoned(op)) return RUNTIME_RESTART_TEXT
    const src = op.cancel?.source ? ` · ${op.cancel.source}` : ""
    return `Cancelled${src}`
  }
  if (op.outcome === "ambiguous" || op.outcome === "superseded") return op.outcome === "ambiguous" ? "Ambiguous" : "Superseded"
  return undefined
}

export function operationStatusTone(op?: PanelOperation): string {
  if (!op) return "neutral"
  if (op.outcome === "failed") return "error"
  if (op.outcome === "in-flight") return "running"
  if (op.outcome === "abandoned") return isRuntimeRestartAbandoned(op) ? "neutral" : "cancelled"
  return "neutral"
}

/**
 * Concise owner status for a versioned redacted recovery projection.
 * Renders only budget counts and termination — never layer timestamps,
 * raw diagnostics, secrets, or anything readable as a replay instruction.
 */
export function operationRecoveryText(op?: PanelOperation): string | undefined {
  const rec = op?.recovery
  if (!rec) return undefined
  if (op?.outcome !== "failed" && op?.outcome !== "abandoned") return undefined
  if (typeof rec.used !== "number" || typeof rec.limit !== "number") return undefined
  if (!Number.isSafeInteger(rec.used) || !Number.isSafeInteger(rec.limit)) return undefined
  if (rec.used < 0 || rec.limit < 0 || rec.used > rec.limit) return undefined
  const base = `retries ${rec.used}/${rec.limit}`
  return rec.terminated ? `${base} · closed` : base
}
