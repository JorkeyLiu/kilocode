/**
 * Drain-control admission lane for cold config writer barriers (LOCK-004/006).
 *
 * During a cold config writer drain, instance-gated reader admission starves
 * behind the writer barrier. The only requests that must still complete are the
 * pre-barrier lifecycle controls: session abort, queued-message cancel,
 * permission reply, and question reply/reject. These operate on the OLD
 * (pre-barrier) runtime — the exact instance that owns the pending
 * permission/question/run-state entries and the generation holding the drain.
 *
 * The middleware (instance-context.ts) classifies these paths with
 * `classifyDrainControl` (exact segment matching, never a regex, so no
 * near-match/traversal shape can be misclassified) and serves them from
 * `InstanceStore.snapshot` on a snapshot-first lane: the bypass never acquires
 * the gate, never boots a runtime, and never loads a fresh instance. Snapshot
 * admission is unconditional for classified controls with a cached instance,
 * which removes the racy `isBarrierActive` engagement — a control arriving
 * around the moment a writer claims still completes against the instance it
 * can see, whether the barrier is observable or not.
 *
 * No-snapshot semantics: when a control is classified but the directory has no
 * cached instance and a writer barrier is active, the request has nothing to
 * act on — a running generation cannot exist without an instance, pending
 * permissions/questions live in the instance's per-directory state (and are
 * rejected by its disposal finalizer), and queued prompts serialize behind a
 * generation that would have drained before disposal. A synthetic incomplete
 * InstanceContext is never built; the request is refused deterministically with
 * a 409 so the client can refetch status instead of hanging or dying with an
 * internal error. Without a barrier, the no-snapshot case falls through to the
 * normal reader lane so never-booted directories keep their existing
 * boot + process semantics.
 */

import { Effect, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { SessionID, MessageID } from "@/session/schema"
import { QuestionID } from "@/question/schema"

export type DrainControlKind = "abort" | "cancelQueued" | "permissionReply" | "questionReply" | "questionReject"

/**
 * Fail-closed segment decode (LOCK-004). Returns undefined when the segment is
 * malformed percent-encoding, or when the decoded form is empty, a "." / ".."
 * traversal shape, or contains a `/` or `\` separator that the raw path did
 * not expose. Encoded separators (`%2F`, `%5C`, `%2E` etc.) can never widen a
 * classified shape into a different route.
 */
const decodeSeg = (seg: string): string | undefined => {
  try {
    const decoded = decodeURIComponent(seg)
    if (decoded.length === 0 || decoded === "." || decoded === "..") return undefined
    if (decoded.includes("/") || decoded.includes("\\")) return undefined
    return decoded
  } catch {
    return undefined
  }
}

/**
 * QuestionID is a Newtype whose class type does not satisfy `Schema.is`'s
 * signature even though it is a runtime schema (see `Newtype` in
 * `@opencode-ai/core/schema`). Decode through the existing schema fail-closed.
 */
const isQuestionID = (value: string): boolean => {
  try {
    Schema.decodeUnknownSync(QuestionID)(value)
    return true
  } catch {
    return false
  }
}

/**
 * Classify an instance-route request as a drain-control path. Exact segment
 * matching against the declared route shapes:
 *
 * - POST /session/:sessionID/abort
 * - DELETE /session/:sessionID/queue/:messageID
 * - POST /permission/:requestID/reply
 * - POST /session/:sessionID/permissions/:permissionID  (legacy permission reply, LOCK-007)
 * - POST /question/:requestID/reply
 * - POST /question/:requestID/reject
 *
 * Returns undefined for every other path/method. The raw path must be exactly
 * one leading slash followed by non-empty segments (rejects duplicate leading
 * slash, empty/trailing/extra segments, and "." / ".." shapes). Each segment
 * is fail-closed decoded and must not hide a separator or traversal shape, and
 * the variable segments are validated against the same ID schemas the route
 * handlers use, so the bypass lane only admits requests the framework would
 * route to a control handler with valid params.
 */
export function classifyDrainControl(method: string, path: string): DrainControlKind | undefined {
  if (!path.startsWith("/") || path.startsWith("//") || path === "/") return undefined
  const raw = path.slice(1).split("/")
  if (raw.some((seg) => seg.length === 0 || seg === "." || seg === "..")) return undefined
  const ids = raw.map(decodeSeg)
  if (!ids.every((seg): seg is string => seg !== undefined)) return undefined
  if (method === "POST" && raw.length === 3 && raw[0] === "session" && raw[2] === "abort") {
    return Schema.is(SessionID)(ids[1]) ? "abort" : undefined
  }
  if (method === "DELETE" && raw.length === 4 && raw[0] === "session" && raw[2] === "queue") {
    return Schema.is(SessionID)(ids[1]) && Schema.is(MessageID)(ids[3]) ? "cancelQueued" : undefined
  }
  if (method === "POST" && raw.length === 3 && raw[0] === "permission" && raw[2] === "reply") {
    return Schema.is(PermissionV1.ID)(ids[1]) ? "permissionReply" : undefined
  }
  // LOCK-007: the legacy session-scoped permission reply
  // (POST /session/:sessionID/permissions/:permissionID) is drain-control
  // equivalent to the canonical /permission/:requestID/reply: both resolve the
  // pending permission on the pre-barrier instance and unblock the generation
  // that holds the drain. Classified as the same permissionReply kind so it
  // shares the reply's snapshot-first admission and 409 no-snapshot semantics.
  if (method === "POST" && raw.length === 4 && raw[0] === "session" && raw[2] === "permissions") {
    return Schema.is(SessionID)(ids[1]) && Schema.is(PermissionV1.ID)(ids[3]) ? "permissionReply" : undefined
  }
  if (method === "POST" && raw.length === 3 && raw[0] === "question" && raw[2] === "reply") {
    return isQuestionID(ids[1]) ? "questionReply" : undefined
  }
  if (method === "POST" && raw.length === 3 && raw[0] === "question" && raw[2] === "reject") {
    return isQuestionID(ids[1]) ? "questionReject" : undefined
  }
  return undefined
}

/** Deterministic refusal for a classified control with no cached instance. */
export const unavailable = (kind: DrainControlKind) =>
  HttpServerResponse.jsonUnsafe(
    {
      _tag: "InstanceUnavailableDuringConfigRebuild",
      control: kind,
      message: "Instance is unavailable during config rebuild; no active runtime for this request",
    },
    { status: 409 },
  )

/**
 * Serve a drain-control handler from an already-obtained pre-barrier snapshot
 * context. The context is the exact cached instance for the directory — never a
 * boot, never a fresh load — and the handler receives the original request so
 * payload/query decoding keeps working.
 */
export function serveControlFromSnapshot<E>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E>,
  ctx: InstanceContext,
  workspaceID: WorkspaceV2.ID | undefined,
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E> {
  return effect.pipe(
    Effect.provideService(InstanceRef, ctx),
    Effect.provideService(WorkspaceRef, workspaceID),
    Effect.provideService(HttpServerRequest.HttpServerRequest, request),
  )
}

export * as DrainControl from "./drain-control"
