// kilocode_change start - bounded auto-continuation for truncated responses
// Leaf module shared by the prompt loop (injection + eligibility) and the task
// tool (report correlation). Kept out of session/prompt.ts so task.ts can use
// it at runtime without a prompt.ts <-> task.ts import cycle.
import { Effect, Option } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { SessionID } from "../schema"
import type { Session } from "../session"
import type { MessageV2 } from "../message-v2"

// Instruction sent to the model after an assistant turn ends with finish="unknown"
// and partial output. The continuation is a same-session, same-turn retry: the
// prior partial text stays in history and the model continues from the last
// point instead of repeating completed work.
export const UNKNOWN_FINISH_CONTINUE_INSTRUCTION =
  "Your previous response was cut off before it was complete. Continue from the last point of your previous response and finish the remaining content. Do not repeat work you already completed."

// LOCK-005: metadata key on the synthetic continuation text part holding the
// exact source assistant message ID the continuation is continuing.
export const CONTINUE_FROM_KEY = "continueFrom"

// LOCK-003: a truncated assistant carrying any unresolved or errored tool part
// is not eligible for auto-continuation. Pending/running/error states mean the
// tool outcome is unknown; the model must not re-drive side effects. Completed
// tool states may continue when the normal loop gates allow it.
export function hasUnsafeTool(parts: SessionV1.Part[] | undefined) {
  return parts?.some((part) => part.type === "tool" && part.state.status !== "completed") ?? false
}

// LOCK-001: report selection only accepts assistant text parts that are
// neither synthetic nor ignored. Synthetic text covers transient snapshot
// progress (fire-and-forget cleanup may leave it on the final message) and
// other UI-only injections; ignored text covers the memory marker and the
// output-length warning. Legitimate child report text is never flagged either
// way, so skipping both classes cannot drop a real report.
export function lastText(parts: SessionV1.Part[]) {
  return (
    parts.findLast(
      (part): part is MessageV2.TextPart => part.type === "text" && part.synthetic !== true && part.ignored !== true,
    )?.text ?? ""
  )
}

// LOCK-005: the exact auto-continuation marker is a synthetic text part on the
// continuation user message whose metadata holds the source assistant ID.
function markerSource(msg: SessionV1.WithParts | undefined) {
  if (!msg || msg.info.role !== "user") return undefined
  const marker = msg.parts.find(
    (part): part is MessageV2.TextPart =>
      part.type === "text" && part.synthetic === true && typeof part.metadata?.[CONTINUE_FROM_KEY] === "string",
  )
  const source = marker?.metadata?.[CONTINUE_FROM_KEY]
  return typeof source === "string" && source.length > 0 ? source : undefined
}

// LOCK-007: durable one-continuation bound across runLoop re-entry. The
// in-memory set only lives for one runLoop invocation; the synthetic
// continuation user message persists in history with its marker, so this
// predicate detects the marker directly and blocks a second injection when a
// fresh runLoop resumes a turn whose last user message is the continuation.
export function isAutoContinueMarker(msg: SessionV1.WithParts | undefined) {
  return markerSource(msg) !== undefined
}

// LOCK-004: the full logical child report is the correlated partial assistant
// text followed by the continuation assistant text, joined by a single newline
// when both are non-empty. Fails closed to the final text unless the marker,
// source ID, and source assistant all line up exactly — no older turns, no
// synthetic instruction text, no unrelated assistant text.
export function composeTaskReport(input: {
  final: SessionV1.WithParts
  parent: SessionV1.WithParts | undefined
  source: SessionV1.WithParts | undefined
}) {
  const finalText = lastText(input.final.parts)
  if (!finalText) return finalText
  const sourceID = markerSource(input.parent)
  if (!sourceID) return finalText
  const src = input.source
  if (!src || src.info.id !== sourceID) return finalText
  if (src.info.role !== "assistant" || src.info.finish !== "unknown" || src.info.error) return finalText
  if (src.info.sessionID !== input.final.info.sessionID) return finalText
  const partialText = lastText(src.parts)
  if (!partialText) return finalText
  return `${partialText}\n${finalText}`
}

// Effect wrapper used by the task tool: given the final child assistant result,
// returns the current final text normally, or partial + final when the final
// assistant's parent user message carries the exact auto-continuation marker
// and the source assistant (fetched from the same session) is a truncated
// unknown-finish assistant. Lookup failures fall back to the final text.
export const taskReport = Effect.fn("autoContinue.taskReport")(function* (input: {
  sessions: Session.Interface
  sessionID: SessionID
  final: SessionV1.WithParts
}) {
  const info = input.final.info
  if (info.role !== "assistant") return lastText(input.final.parts)
  const find = (id: string) =>
    input.sessions
      .findMessage(input.sessionID, (m) => m.info.id === id)
      .pipe(
        Effect.catchTag("NotFoundError", () => Effect.succeed(Option.none())),
        Effect.map(Option.getOrUndefined),
      )
  const parent = yield* find(info.parentID)
  const sourceID = markerSource(parent)
  if (!sourceID) return lastText(input.final.parts)
  const source = yield* find(sourceID)
  return composeTaskReport({ final: input.final, parent, source })
})
// kilocode_change end
