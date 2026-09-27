import type { PanelOperation } from "../src/types/messages/agent-manager"

export function operationStatusText(op?: PanelOperation): string | undefined {
  if (!op) return undefined
  if (op.outcome === "in-flight") return "Running"
  if (op.outcome === "succeeded") return undefined
  if (op.outcome === "failed") return `Failed · ${op.code}: ${op.message}`
  if (op.outcome === "abandoned") {
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
  if (op.outcome === "abandoned") return "cancelled"
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
