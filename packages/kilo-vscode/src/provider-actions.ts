/**
 * Provider action handlers extracted from KiloProvider to stay under max-lines.
 * These are pure async functions that operate on the SDK client — no vscode dependency.
 */
import type { KiloClient } from "@kilocode/sdk/v2"
import type { KiloConnectionService } from "./services/cli-backend/connection-service"
import { fetchKiloAuthStatusPrivateFirst } from "./kilo-provider/kilo-auth-status-privatefirst"
import { fetchProviderAuthPrivateFirst } from "./kilo-provider/provider-auth-privatefirst"
import { fetchProviderCatalogPrivateFirst } from "./kilo-provider/provider-catalog-privatefirst"
import { validateProviderID as validateProviderIDShared } from "./shared/custom-provider"
import { KILO_AUTO, KILO_PROVIDER_ID, parseModelString } from "./shared/provider-model"

/**
 * Compute the default model selection from CLI config, VS Code settings, or hardcoded fallback.
 * Pure function — takes cachedConfig and vscode settings as parameters.
 */
type AuthState = "api" | "oauth" | "wellknown"

/** Fetch redacted provider catalog and derive authentication state without credential exposure. */
export async function fetchProviderData(
  client: KiloClient,
  dir: string,
  connection?: KiloConnectionService | null,
) {
  // Private-first auth branch only: catalog authority and `kilo.authStatus`
  // stay parallel with their own semantics. Auth private success and validated
  // terminal close with zero SDK; only unavailable/retryable/invalid/
  // ambiguous/transport/closed/timeout takes exactly one same-directory
  // `client.provider.auth` fallback inside the helper (no retry, no post,
  // no cache, no journal/reconcile). Old SDK without the method degrades to
  // `unavailable` without a call. Any auth outcome degrades to `{}` so the
  // whole `fetchProviderData` never rejects on auth.
  const authRequest = fetchProviderAuthPrivateFirst({
    connection: (connection ?? null) as never,
    client: client as never,
    directory: dir,
  })
    .then((out) => {
      if (out.kind === "ok") return out.data
      throw out.kind === "terminal"
        ? new Error(`provider auth terminal: ${out.code ?? "unknown"}`)
        : ((out as { cause?: unknown }).cause ?? new Error("provider auth unavailable"))
    })
    .catch(() => ({}))
  // Private-first `kilo.authStatus` branch: private success and validated
  // terminal close with zero SDK; only unavailable/retryable/invalid/
  // ambiguous/transport/closed/timeout takes exactly one same-directory
  // `client.kilo.authStatus` fallback inside the helper (no retry, no post,
  // no cache, no journal/reconcile). Any terminal/unavailable outcome plus
  // any SDK failure degrades to `null` so the whole `fetchProviderData`
  // never rejects on status.
  const kiloRequest = fetchKiloAuthStatusPrivateFirst({
    connection: (connection ?? null) as never,
    client: client as never,
    directory: dir,
  })
    .then((out) => {
      if (out.kind === "ok") return out.data.authenticated ? (out.data.type ?? null) : null
      throw out.kind === "terminal"
        ? new Error(`kilo auth-status terminal: ${out.code ?? "unknown"}`)
        : ((out as { cause?: unknown }).cause ?? new Error("kilo auth-status unavailable"))
    })
    .catch(() => null)

  // Private-first catalog branch only: `provider.auth` (private-first soft
  // `catch`-to-`{}` above) and `kilo.authStatus` stay parallel with their own
  // failure isolation (never combined into a snapshot). Catalog private success and validated
  // terminal close with zero SDK; only unavailable/retryable/invalid/
  // ambiguous/transport/closed/timeout takes exactly one same-directory
  // `client.provider.catalog` fallback inside the helper (no retry, no post,
  // no cache, no journal/reconcile). A catalog failure still rejects the whole
  // `fetchProviderData` so the outer `KiloProvider` keeps its old cache.
  const catalogRequest = fetchProviderCatalogPrivateFirst({
    connection: (connection ?? null) as never,
    client: client as never,
    directory: dir,
  }).then((out) => {
    if (out.kind === "ok") return out.data
    throw out.kind === "terminal" ? new Error(`provider catalog terminal: ${out.code ?? "unknown"}`) : (out.cause ?? new Error("provider catalog unavailable"))
  })

  const [catalog, authMethods, kiloAuth] = await Promise.all([catalogRequest, authRequest, kiloRequest])
  const response = catalog as unknown as {
    all: Array<{ id: string; hasCredential?: boolean }>
    default: Record<string, string>
    connected: string[]
    failed: string[]
  }
  const authStates: Record<string, AuthState> = {}
  for (const item of response.all) {
    if (typeof item.id === "string" && (item as { hasCredential?: unknown }).hasCredential === true) {
      authStates[item.id] = "api"
    }
  }
  delete authStates[KILO_PROVIDER_ID]
  if (kiloAuth) authStates[KILO_PROVIDER_ID] = kiloAuth
  return { response, authMethods, authStates }
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
// Model discovery auth-error mapping (pure, testable seam)
// ---------------------------------------------------------------------------

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
  return candidates.some((item) => typeof item === "string" && /401|403|unauthor|authentication/i.test(item))
}
