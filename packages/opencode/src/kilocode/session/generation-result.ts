// Shared minimal result classification for accepted prompt/command generation.
// Success(WithParts) carrying assistant.info.error must not be recorded as
// prompt.succeeded: aborted stays abandoned (priority), any other assistant
// error terminalizes failed via SessionOperation.generationTerminal.
// User-only (noReply) stays succeeded; adopted multi-op keeps per-op identity
// because each dispatch classifies its own Success value independently.
import { SessionV1 } from "@opencode-ai/core/v1/session"

export type GenerationClassification =
  | { outcome: "succeeded"; code: "prompt.succeeded"; message: string }
  | { outcome: "failed"; code: "prompt.failed"; message: string; detail?: string }
  | { outcome: "abandoned"; code: "prompt.abandoned"; message: string }

function isAbortedError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  const name = (err as { name?: unknown }).name
  if (typeof name === "string" && (name === "MessageAbortedError" || name === "AbortedError")) return true
  try {
    if (SessionV1.AbortedError.isInstance(err as never)) return true
  } catch {
    return false
  }
  return false
}

function messageFromAssistantError(err: unknown): string {
  if (typeof err === "string") return err
  if (err && typeof err === "object") {
    const rec = err as Record<string, unknown>
    const data = rec.data as Record<string, unknown> | undefined
    if (data && typeof data.message === "string" && data.message.length > 0) return data.message
    if (typeof rec.message === "string" && rec.message.length > 0) return rec.message
    try {
      const json = JSON.stringify(err)
      if (typeof json === "string" && json.length > 0) return json
    } catch {}
  }
  return String(err)
}

function detailFromAssistantError(err: unknown, message: string): string | undefined {
  try {
    const json = JSON.stringify(err)
    if (typeof json === "string" && json.length > 0 && json !== message) return json
  } catch {}
  return undefined
}

export function classifyGenerationResult(value: unknown): GenerationClassification {
  const info = (value as { info?: { role?: unknown; error?: unknown } } | null | undefined)?.info
  if (!info || typeof info !== "object") return { outcome: "succeeded", code: "prompt.succeeded", message: "prompt succeeded" }
  if ((info as { role?: unknown }).role === "user") {
    return { outcome: "succeeded", code: "prompt.succeeded", message: "prompt succeeded" }
  }
  const err = (info as { error?: unknown }).error
  if (!err) return { outcome: "succeeded", code: "prompt.succeeded", message: "prompt succeeded" }
  if (isAbortedError(err)) return { outcome: "abandoned", code: "prompt.abandoned", message: "prompt abandoned" }
  const message = messageFromAssistantError(err)
  const detail = detailFromAssistantError(err, message)
  return detail !== undefined
    ? { outcome: "failed", code: "prompt.failed", message, detail }
    : { outcome: "failed", code: "prompt.failed", message }
}
