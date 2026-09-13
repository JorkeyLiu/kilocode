/**
 * Shared `instance.reload` HTTP owner for the VS Code extension.
 *
 * Both reload entries (`KiloProvider.handleReload` for webview current
 * session, `kilo-code.new.reload` for the Agent Manager resolver) reboot the
 * same shared backend instance over HTTP/SDK with an explicit absolute
 * directory. This module owns the single `client.instance.reload` call shape,
 * the 409 conflict detection, and the shared user-facing copy. Callers keep
 * their own directory selection and their existing success projection.
 *
 * Success semantics: the HTTP response is only an ack that the reload was
 * accepted/completed. Runtime projection converges through
 * `server.instance.disposed` / `global.disposed` plus the per-provider
 * `LifecycleRefreshCoordinator`. This helper owns no refresh, no private
 * file-descriptor capability, no op/idempotency identity, and no fallback.
 */

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
  client: InstanceReloadSdkClient
  directory: string
}): Promise<InstanceReloadOutcome> {
  try {
    await opts.client.instance.reload({ directory: opts.directory }, { throwOnError: true })
    return { kind: "succeeded" }
  } catch (err) {
    if (isReloadConflictError(err)) return { kind: "conflict", cause: err }
    return { kind: "failed", cause: err }
  }
}
