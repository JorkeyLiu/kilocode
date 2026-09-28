/**
 * Shared `instance.reload` private-first owner for the VS Code extension.
 *
 * Both reload entries (`KiloProvider.handleReload` for webview current
 * session, `kilo-code.new.reload` for the Agent Manager resolver) reboot the
 * same shared backend instance with an explicit absolute directory. This
 * module owns the private-first attempt plus the single
 * `client.instance.reload` SDK fallback shape, the 409 conflict detection,
 * and the shared user-facing copy. Callers keep their own directory
 * selection and their existing success projection.
 *
 * Accepted-only: one private `instance/reload` attempt (`instance-reload:<token>`
 * for `opId`/`idempotencyKey` + `requestId` + canonical `directory`/`workspace?`,
 * empty payload, 3 s exact-cancel/settled-first epoch) plus at most one
 * same-directory SDK `client.instance.reload` fallback only on proven
 * pre-send (`unavailable`/`missing-capability` before any private request
 * leaves the extension) or the strictly validated pre-accept retryable fence
 * (`failed` `retryable === true` with `accepted === false` and exact identity,
 * proven never accepted before reload), never retried. Valid private
 * `succeeded`+`accepted` returns `succeeded` with zero SDK; validated terminal
 * `failed` (`retryable === false`, including `conflict` for the existing
 * active-session guard) closes with zero SDK and the existing conflict/failed
 * shape. Every after-send uncertainty (`ambiguous`/`timeout`/`closed`/
 * `invalid`/`transportUnknown`/throw, including a retryable-shaped but
 * unproven result) returns explicit `unresolved` carrying the stable `opId`
 * with zero SDK and zero second dispatch. The disposed events stay the final
 * convergence owner for accepted reloads. Provider `unresolved` warns (never
 * asserts success, never runs a second reload, never clears the commands
 * cache) then requests one read-only reconciliation through the existing
 * per-provider `LifecycleRefreshCoordinator`, guarded by current
 * client/generation, dispose, and directory; the round re-reads authoritative
 * config/agents/skills/commands and keeps fail-soft behavior, so a lost
 * disposed SSE event cannot leave state stale across reconnection. The
 * `kilo-code.new.reload` command has no provider instance and no existing
 * shared read-only refresh path, so it keeps warn-only and converges via the
 * disposed events plus the next provider round. No polling, no scheduler, no
 * new dedup/singleflight owner, no new lifecycle owner/protocol.
 *
 * Success semantics: the private result or HTTP response is only an ack that
 * the reload was accepted/completed. Runtime projection converges through
 * `server.instance.disposed` / `global.disposed` plus the per-provider
 * `LifecycleRefreshCoordinator`. This helper owns no refresh, no new
 * dedup/singleflight owner, and no UI copy change beyond the unresolved
 * warning.
 */

import {
  attemptInstanceReloadPrivate,
  buildInstanceReloadReq,
  type InstanceReloadPrivateConnection,
} from "./instance-reload-privatefirst"

export type InstanceReloadSdkClient = {
  instance: {
    reload: (params: { directory: string }, opts: { throwOnError: true }) => Promise<unknown>
  }
}

export type InstanceReloadOutcome =
  | { kind: "succeeded" }
  | { kind: "conflict"; cause: unknown }
  | { kind: "failed"; cause: unknown }
  | { kind: "unresolved"; reason: string; opId: string }

export const RELOAD_CONFLICT_WARNING =
  "Cannot reload while a session is running. Wait for it to finish or abort it first."

export const RELOAD_FAILED_ERROR = "Reload failed. See extension logs for details."

export const RELOAD_UNRESOLVED_WARNING =
  "Reload status could not be confirmed. No retry was issued. It will converge automatically if the reload was accepted."

export function isReloadConflictError(err: unknown): boolean {
  if (!err || typeof err !== "object" || !("response" in err)) return false
  return (err as { response?: { status?: number } }).response?.status === 409
}

export async function requestInstanceReload(opts: {
  connection?: InstanceReloadPrivateConnection | null
  client: InstanceReloadSdkClient
  directory: string
  workspace?: string
}): Promise<InstanceReloadOutcome> {
  if (opts.directory) {
    const req = buildInstanceReloadReq(opts.directory, opts.workspace)
    const attempt = await attemptInstanceReloadPrivate(opts.connection ?? null, req)
    if (attempt.kind === "ok") return { kind: "succeeded" }
    if (attempt.kind === "terminal") {
      if (attempt.code === "conflict") return { kind: "conflict", cause: { code: "conflict" } }
      return { kind: "failed", cause: { code: attempt.code ?? "terminal" } }
    }
    if (attempt.kind === "unresolved") {
      console.warn("[Kilo New] instance reload unresolved:", { reason: attempt.reason, opId: attempt.opId })
      return { kind: "unresolved", reason: attempt.reason, opId: attempt.opId }
    }
  }
  try {
    await opts.client.instance.reload({ directory: opts.directory }, { throwOnError: true })
    return { kind: "succeeded" }
  } catch (err) {
    if (isReloadConflictError(err)) return { kind: "conflict", cause: err }
    return { kind: "failed", cause: err }
  }
}
