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
 * One private `instance/reload` attempt (`instance-reload:<token>` for
 * `opId`/`idempotencyKey` + `requestId` + canonical `directory`/`workspace?`,
 * empty payload, 3 s exact-cancel/settled-first epoch) plus at most one
 * same-directory SDK `client.instance.reload` fallback per call, never
 * retried. Valid private `succeeded`+`accepted` returns `succeeded` with zero
 * SDK; validated terminal `failed` (`retryable === false`, including
 * `conflict` for the existing active-session guard) closes with zero SDK and
 * the existing conflict/failed shape; retryable fence plus
 * unavailable/invalid/ambiguous/transport/closed/timeout takes exactly one
 * same-directory SDK fallback with no retry inside the helper. An ambiguous
 * fallback can produce at most two underlying reloads and two disposed
 * events (merged by the existing `LifecycleRefreshCoordinator`); this unit
 * promises no exactly-once boots and no new dedup/singleflight owner.
 *
 * Success semantics: the private result or HTTP response is only an ack that
 * the reload was accepted/completed. Runtime projection converges through
 * `server.instance.disposed` / `global.disposed` plus the per-provider
 * `LifecycleRefreshCoordinator`. This helper owns no refresh, no new
 * dedup/singleflight owner, and no UI copy change.
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

export const RELOAD_CONFLICT_WARNING =
  "Cannot reload while a session is running. Wait for it to finish or abort it first."

export const RELOAD_FAILED_ERROR = "Reload failed. See extension logs for details."

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
  }
  try {
    await opts.client.instance.reload({ directory: opts.directory }, { throwOnError: true })
    return { kind: "succeeded" }
  } catch (err) {
    if (isReloadConflictError(err)) return { kind: "conflict", cause: err }
    return { kind: "failed", cause: err }
  }
}
