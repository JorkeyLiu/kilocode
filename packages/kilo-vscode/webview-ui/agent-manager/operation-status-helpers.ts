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
