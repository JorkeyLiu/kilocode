/**
 * Provider action handlers extracted from KiloProvider to stay under max-lines.
 * These are pure async functions that operate on the SDK client — no vscode dependency.
 */
import type { KiloClient } from "@kilocode/sdk/v2"
import { validateProviderID as validateProviderIDShared } from "./shared/custom-provider"
import { KILO_AUTO, KILO_PROVIDER_ID, parseModelString } from "./shared/provider-model"

/**
 * Compute the default model selection from CLI config, VS Code settings, or hardcoded fallback.
 * Pure function — takes cachedConfig and vscode settings as parameters.
 */
type AuthState = "api" | "oauth" | "wellknown"

/** Fetch provider availability and authentication state without exposing stored credentials. */
export async function fetchProviderData(client: KiloClient, dir: string) {
  const authRequest =
    typeof client.provider.auth === "function"
      ? client.provider
          .auth({ directory: dir }, { throwOnError: true })
          .then((r) => r.data ?? {})
          .catch(() => ({}))
      : Promise.resolve({})
  const kiloRequest = client.kilo
    .authStatus({ directory: dir }, { throwOnError: true })
    .then((r) => (r.data?.authenticated ? (r.data.type ?? null) : null))
    .catch(() => null)

  const [{ data: response }, authMethods, kiloAuth] = await Promise.all([
    client.provider.list({ directory: dir }, { throwOnError: true }),
    authRequest,
    kiloRequest,
  ])
  const authStates: Record<string, AuthState> = {}
  const all = response.all.map((item) => {
    const raw = item as Record<string, unknown>
    if (typeof raw.id === "string" && typeof raw.key === "string" && raw.key) {
      authStates[raw.id] = "api"
    }
    if (!("key" in raw)) return item
    const next = { ...raw }
    delete next.key
    return next as (typeof response.all)[number]
  })
  delete authStates[KILO_PROVIDER_ID]
  if (kiloAuth) authStates[KILO_PROVIDER_ID] = kiloAuth
  return { response: { ...response, all }, authMethods, authStates }
}

export function buildActionContext(
  client: KiloClient,
  post: (msg: unknown) => void,
  errFn: (err: unknown) => string,
  dir: string,
  refresh: () => Promise<void>,
): ActionContext {
  return {
    client,
    postMessage: post,
    getErrorMessage: errFn,
    workspaceDir: dir,
    fetchAndSendProviders: refresh,
  }
}

function isModelSelection(r: unknown): r is { providerID: string; modelID: string } {
  return (
    !!r &&
    typeof r === "object" &&
    typeof (r as Record<string, unknown>).providerID === "string" &&
    typeof (r as Record<string, unknown>).modelID === "string"
  )
}

/** Validate and sanitize recent model selections from untrusted sources. */
export function validateRecents(raw: unknown): Array<{ providerID: string; modelID: string }> {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(isModelSelection)
    .slice(0, 5)
    .map((r) => ({ providerID: r.providerID, modelID: r.modelID }))
}

/** Validate and sanitize favorite model selections from untrusted sources. */
export function validateFavorites(raw: unknown): Array<{ providerID: string; modelID: string }> {
  if (!Array.isArray(raw)) return []
  return raw.filter(isModelSelection).map((r) => ({ providerID: r.providerID, modelID: r.modelID }))
}

/** Validate and sanitize per-mode model selections from untrusted sources. */
export function validateModelSelections(raw: unknown): Record<string, { providerID: string; modelID: string }> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const result: Record<string, { providerID: string; modelID: string }> = {}
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (isModelSelection(val)) {
      result[key] = { providerID: val.providerID, modelID: val.modelID }
    }
  }
  return result
}

export function computeDefaultSelection(
  cachedConfig: { config?: { model?: string } } | null,
  vscodePID: string,
  vscodeMID: string,
): { providerID: string; modelID: string } {
  const configured = parseModelString(cachedConfig?.config?.model)
  if (configured) return configured
  if (vscodePID && vscodeMID) return { providerID: vscodePID, modelID: vscodeMID }
  return { ...KILO_AUTO }
}

type PostMessage = (message: unknown) => void
type GetErrorMessage = (error: unknown) => string

interface ActionContext {
  client: KiloClient
  postMessage: PostMessage
  getErrorMessage: GetErrorMessage
  workspaceDir: string
  fetchAndSendProviders: () => Promise<void>
}

function postError(
  ctx: ActionContext,
  requestId: string,
  providerID: string,
  action: "connect" | "authorize",
  message: string,
) {
  ctx.postMessage({ type: "providerActionError", requestId, providerID, action, message })
}

function validateID(
  ctx: ActionContext,
  requestId: string,
  providerID: string,
  action: "connect" | "authorize",
): string | null {
  const result = validateProviderIDShared(providerID)
  if ("value" in result) return result.value
  postError(ctx, requestId, providerID, action, result.error)
  return null
}

export async function authorizeProviderOAuth(
  ctx: ActionContext,
  requestId: string,
  providerID: string,
  method: number,
) {
  const id = validateID(ctx, requestId, providerID, "authorize")
  if (!id) return
  try {
    const { data: authorization } = await ctx.client.provider.oauth.authorize(
      { providerID: id, method, directory: ctx.workspaceDir },
      { throwOnError: true },
    )
    if (!authorization) {
      postError(ctx, requestId, providerID, "authorize", "Failed to start provider authorization")
      return
    }
    ctx.postMessage({ type: "providerOAuthReady", requestId, providerID: id, authorization })
  } catch (error) {
    postError(
      ctx,
      requestId,
      providerID,
      "authorize",
      ctx.getErrorMessage(error) || "Failed to start provider authorization",
    )
  }
}

export async function completeProviderOAuth(
  ctx: ActionContext,
  requestId: string,
  providerID: string,
  method: number,
  code?: string,
) {
  const id = validateID(ctx, requestId, providerID, "connect")
  if (!id) return
  try {
    await ctx.client.provider.oauth.callback(
      { providerID: id, method, code, directory: ctx.workspaceDir },
      { throwOnError: true },
    )
    // LOCK-001: backend OAuth callback coordinates drain/rebuild and emits
    // global.disposed — the extension must NOT call global.dispose. The
    // callback response IS the mutation acknowledgement, so emit the success
    // message immediately and refresh without waiting for rebuild.
    ctx.postMessage({ type: "providerConnected", requestId, providerID: id })
    try {
      await ctx.fetchAndSendProviders()
    } catch (error) {
      // A refresh failure after a successful mutation must never be reported
      // as a connect failure.
      console.warn(`[Kilo New] provider ${id} connected but provider refresh failed:`, error)
    }
  } catch (error) {
    postError(
      ctx,
      requestId,
      providerID,
      "connect",
      ctx.getErrorMessage(error) || "Failed to complete provider authorization",
    )
  }
}

// ---------------------------------------------------------------------------
// LOCK-003/004: Credential read authorization — pure, testable seam
// ---------------------------------------------------------------------------

/** Result of a credential read authorization check. */
export type CredentialAuthResult = { authorized: false; error: string } | { authorized: true; key: string }

/**
 * Authorize a credential read against a fresh provider list response.
 *
 * LOCK-003 constraints enforced:
 * - `providerID` must be non-empty and not "kilo"
 * - Target provider must exist in the fresh list
 * - Authorized sources: "api" (built-in stored key), "custom" (custom provider),
 *   or "config" with non-empty key AND empty env array (proving key was explicitly
 *   stored via auth, not derived from env/config)
 * - `key` must be a non-empty string
 *
 * On failure the returned error is a generic message; the key is never
 * included in the error path.
 */
export function authorizeCredentialRead(
  providerID: string,
  providerList: Array<Record<string, unknown>>,
): CredentialAuthResult {
  if (!providerID) return { authorized: false, error: "Unable to load API key" }
  if (providerID === "kilo") return { authorized: false, error: "Unable to load API key" }

  const target = providerList.find((item) => item.id === providerID)
  if (!target) return { authorized: false, error: "Unable to load API key" }

  const source = target.source
  const key = target.key
  const hasKey = typeof key === "string" && key.length > 0

  // source="api": built-in provider with explicitly stored key
  if (source === "api" && hasKey) return { authorized: true, key }

  // source="custom": custom provider with stored key (pre-backend-init shape)
  if (source === "custom" && hasKey) return { authorized: true, key }

  // source="config": backend overwrites source to "config" after init.
  // Only authorize when env is empty (proving key was explicitly stored via auth,
  // not derived from an environment variable).
  const env = target.env
  if (source === "config" && hasKey && Array.isArray(env) && env.length === 0) {
    return { authorized: true, key }
  }

  return { authorized: false, error: "Unable to load API key" }
}

/**
 * Map a runtime model-discovery failure to the existing
 * `customProviderModelsFetched` auth UX. The backend reports stored-key
 * authentication failures as `Unauthorized` (upstream 401/403); every other
 * failure is a non-auth error. Inspects the hey-api error body
 * (`{name, data.message}`), nested causes, and plain messages.
 */
export function isProviderModelsAuthError(error: unknown): boolean {
  if (typeof error === "string") return /401|403|unauthor|authentication/i.test(error)
  if (!error || typeof error !== "object") return false
  const record = error as Record<string, unknown>
  if (record.name === "Unauthorized") return true
  const candidates: unknown[] = [record.message, record.error]
  const data = record.data
  if (data && typeof data === "object") {
    const inner = data as Record<string, unknown>
    candidates.push(inner.message)
  }
  const cause = (record as { cause?: unknown }).cause
  if (cause !== undefined) candidates.push(cause)
  return candidates.some(
    (item) => typeof item === "string" && /401|403|unauthor|authentication/i.test(item),
  )
}
