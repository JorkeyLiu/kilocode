/**
 * Provider action handlers extracted from KiloProvider to stay under max-lines.
 * These are pure async functions that operate on the SDK client — no vscode dependency.
 */
import type { Config, KiloClient } from "@kilocode/sdk/v2"
import { validateProviderID as validateProviderIDShared } from "./shared/custom-provider"
import { resolveCustomProviderAuth, sanitizeCustomProviderConfig } from "./shared/custom-provider"
import { isCustomProviderPackage, KILO_AUTO, KILO_PROVIDER_ID, parseModelString } from "./shared/provider-model"
import { configFeatures } from "./features"

/**
 * Compute the default model selection from CLI config, VS Code settings, or hardcoded fallback.
 * Pure function — takes cachedConfig and vscode settings as parameters.
 */
type AuthState = "api" | "oauth" | "wellknown"

/** API key retained extension-side for authenticated model fetches (#10139). */
export interface StoredProviderKey {
  key: string
  baseURL: string
}

function disabledWithout(list: string[] | undefined, id: string) {
  return (list ?? []).filter((item) => item !== id)
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function customProvider(config: unknown) {
  return record(config) && isCustomProviderPackage(config.npm)
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false
    if (a.length !== b.length) return false
    return a.every((value, index) => same(value, b[index]))
  }
  if (!record(a) || !record(b)) return false
  const akeys = Object.keys(a).sort()
  const bkeys = Object.keys(b).sort()
  if (akeys.length !== bkeys.length) return false
  return akeys.every((key, index) => key === bkeys[index] && same(a[key], b[key]))
}

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
  const storedKeys: Record<string, StoredProviderKey> = {}
  const all = response.all.map((item) => {
    const raw = item as Record<string, unknown>
    if (typeof raw.id === "string" && typeof raw.key === "string" && raw.key) {
      authStates[raw.id] = "api"
      // Retain the key on the extension side so model fetches for an existing
      // provider can authenticate without the webview ever seeing the secret
      // (#10139). Only providers with a configured baseURL are retained — the
      // fetch handler requires a URL match before applying a stored key.
      const options = record(raw.options) ? raw.options : undefined
      const baseURL = options && typeof options.baseURL === "string" ? options.baseURL : undefined
      if (baseURL) storedKeys[raw.id] = { key: raw.key, baseURL }
    }
    if (!("key" in raw)) return item
    const next = { ...raw }
    delete next.key
    return next as (typeof response.all)[number]
  })
  delete authStates[KILO_PROVIDER_ID]
  if (kiloAuth) authStates[KILO_PROVIDER_ID] = kiloAuth
  return { response: { ...response, all }, authMethods, authStates, storedKeys }
}

/**
 * Resolve the stored API key for a model fetch on an existing provider.
 * The key is only applied when the requested URL matches the provider's
 * configured baseURL, so a stored secret can never be redirected to a
 * different host (e.g. after the user edits the URL field).
 */
export function resolveStoredKey(
  storedKeys: Record<string, StoredProviderKey>,
  providerID: unknown,
  url: string,
): string | undefined {
  if (typeof providerID !== "string" || !providerID) return undefined
  const stored = storedKeys[providerID]
  if (!stored) return undefined
  const normalize = (value: string) => value.trim().replace(/\/+$/, "")
  return normalize(stored.baseURL) === normalize(url) ? stored.key : undefined
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
type SetCachedConfig = (msg: unknown) => void
type AuthMetadata = Record<string, string>

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
  action: "connect" | "disconnect" | "authorize" | "delete",
  message: string,
) {
  ctx.postMessage({ type: "providerActionError", requestId, providerID, action, message })
}

function validateID(
  ctx: ActionContext,
  requestId: string,
  providerID: string,
  action: "connect" | "disconnect" | "authorize" | "delete",
): string | null {
  const result = validateProviderIDShared(providerID)
  if ("value" in result) return result.value
  postError(ctx, requestId, providerID, action, result.error)
  return null
}

function cleanMetadata(input?: Record<string, unknown>): AuthMetadata | undefined {
  const entries = Object.entries(input ?? {})
    .map(([key, value]) => [key, typeof value === "string" ? value.trim() : ""] as const)
    .filter(([key, value]) => key !== "" && value !== "")
  if (entries.length === 0) return undefined
  return Object.fromEntries(entries)
}

async function configs(ctx: ActionContext) {
  const [{ data: global }, { data: merged }] = await Promise.all([
    ctx.client.global.config.get({ throwOnError: true }),
    ctx.client.config.get({ directory: ctx.workspaceDir }, { throwOnError: true }),
  ])
  return { global: global ?? {}, merged: merged ?? {} }
}

async function refreshConfig(ctx: ActionContext, setCachedConfig: SetCachedConfig) {
  const [{ data: config }, { data: global }] = await Promise.all([
    ctx.client.config.get({ directory: ctx.workspaceDir }, { throwOnError: true }),
    ctx.client.global.config.get({ throwOnError: true }),
  ])
  if (!config) return
  const features = configFeatures()
  setCachedConfig({ type: "configLoaded", config, globalConfig: global, features })
  ctx.postMessage({ type: "configUpdated", config, globalConfig: global, features })
}

async function saveGlobal(ctx: ActionContext, config: Config) {
  await ctx.client.global.config.update({ config }, { throwOnError: true })
}

async function saveProject(ctx: ActionContext, config: Config) {
  await ctx.client.config.update({ config, directory: ctx.workspaceDir }, { throwOnError: true })
}

async function removeCustom(ctx: ActionContext, id: string, global: Config, merged: Config) {
  const cfg = global.provider?.[id]
  const effective = merged.provider?.[id]
  const hasDisabled = (global.disabled_providers ?? []).includes(id)
  const tasks = []
  if (customProvider(cfg)) {
    tasks.push(
      saveGlobal(ctx, {
        provider: { [id]: null },
        disabled_providers: disabledWithout(global.disabled_providers, id),
      }),
    )
  } else if (hasDisabled) {
    // Project-only custom provider — clean stale disabled ID from global config
    // without touching the global provider key.
    tasks.push(
      saveGlobal(ctx, {
        disabled_providers: disabledWithout(global.disabled_providers, id),
      }),
    )
  }
  if (customProvider(effective)) {
    tasks.push(saveProject(ctx, { provider: { [id]: null } }))
  }
  await Promise.all(tasks)
}

export async function connectProvider(
  ctx: ActionContext,
  requestId: string,
  providerID: string,
  apiKey: string,
  metadata?: Record<string, unknown>,
) {
  const id = validateID(ctx, requestId, providerID, "connect")
  if (!id) return
  try {
    const meta = cleanMetadata(metadata)
    const auth = meta ? { type: "api" as const, key: apiKey, metadata: meta } : { type: "api" as const, key: apiKey }
    await ctx.client.auth.set({ providerID: id, auth }, { throwOnError: true })
    // LOCK-001: backend auth.set coordinates drain/rebuild and emits
    // global.disposed — the extension must NOT call global.dispose. The
    // auth.set response IS the mutation acknowledgement, so emit the success
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
    postError(ctx, requestId, providerID, "connect", ctx.getErrorMessage(error) || "Failed to connect provider")
  }
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

export async function disconnectProvider(
  ctx: ActionContext,
  requestId: string,
  providerID: string,
  cachedConfigMessage: unknown,
  setCachedConfig: SetCachedConfig,
) {
  const id = validateID(ctx, requestId, providerID, "disconnect")
  if (!id) return
  try {
    // LOCK-002: auth.remove must NEVER swallow backend failure. Backend
    // compensation preserves credentials on failure, so the extension must
    // retain the current connected state and surface the real error — success
    // is claimed only after auth removal succeeds.
    await ctx.client.auth.remove({ providerID: id }, { throwOnError: true })

    if (id === "kilo") {
      ctx.postMessage({ type: "profileData", data: null })
    }

    // LOCK-001: backend auth.remove coordinates drain/rebuild and emits
    // global.disposed — the extension must NOT call global.dispose. The
    // auth.remove response IS the mutation acknowledgement, so emit the
    // success message immediately and refresh without waiting for rebuild.
    ctx.postMessage({ type: "providerDisconnected", requestId, providerID: id })
    try {
      await ctx.fetchAndSendProviders()
    } catch (error) {
      // A refresh failure after a successful mutation must never be reported
      // as a disconnect failure.
      console.warn(`[Kilo New] provider ${id} disconnected but provider refresh failed:`, error)
    }
  } catch (error) {
    postError(ctx, requestId, providerID, "disconnect", ctx.getErrorMessage(error) || "Failed to disconnect provider")
  }
}

export async function deleteCustomProvider(
  ctx: ActionContext,
  requestId: string,
  providerID: string,
  cachedConfigMessage: unknown,
  setCachedConfig: SetCachedConfig,
) {
  const id = validateID(ctx, requestId, providerID, "delete")
  if (!id) return
  try {
    const config = await configs(ctx)
    const cfg = config.global.provider?.[id]
    const effective = config.merged.provider?.[id]
    const custom = customProvider(cfg) || customProvider(effective)

    if (!custom) {
      postError(ctx, requestId, providerID, "delete", "Provider is not a custom provider")
      return
    }

    // Atomic backend-coordinated deletion (LOCK-001/002/003/005).
    // The backend endpoint handles ALL config deletion atomically: auth removal,
    // global config patch, project config patch, and instance
    // rebuild through a single convergence pass.
    // The extension must NOT issue a second project PATCH (LOCK-001).
    const response = await ctx.client.customProvider.delete(
      { providerID: id, directory: ctx.workspaceDir },
      { throwOnError: true },
    )

    // Check the structured result — the endpoint returns 400 for validation
    // failures (non-custom provider, config persistence errors).
    if (!response.data?.success) {
      postError(ctx, requestId, providerID, "delete", "Failed to delete custom provider")
      return
    }

    // LOCK-004: a successful backend response IS the mutation acknowledgement.
    // Emit providerDeleted immediately after the mutation, then refresh. A
    // refresh/config-read failure must never be reported as a deletion failure
    // and deletion is never retried automatically — the failure is logged
    // truthfully instead.
    ctx.postMessage({ type: "providerDeleted", requestId, providerID: id })
    try {
      await refreshConfig(ctx, setCachedConfig)
      await ctx.fetchAndSendProviders()
    } catch (error) {
      console.warn(
        `[Kilo New] custom provider ${id} deleted but config/provider refresh failed:`,
        error,
      )
    }
  } catch (error) {
    postError(ctx, requestId, providerID, "delete", ctx.getErrorMessage(error) || "Failed to delete custom provider")
  }
}

export async function saveCustomProvider(
  ctx: ActionContext,
  requestId: string,
  providerID: string,
  provider: Record<string, unknown>,
  apiKey: string | undefined,
  apiKeyChanged: boolean,
) {
  const id = validateID(ctx, requestId, providerID, "connect")
  if (!id) return

  const sanitized = sanitizeCustomProviderConfig(provider)
  if ("error" in sanitized) {
    postError(ctx, requestId, providerID, "connect", sanitized.error)
    return
  }

  const auth = resolveCustomProviderAuth(apiKey, apiKeyChanged)

  try {
    // LOCK-001/005: exactly ONE generated backend mutation. The backend
    // persists the config (computing null deletions from the old global entry
    // itself) and the auth union atomically, registers exactly one rebuild,
    // and emits the transaction ConfigUpdated event at the response
    // acknowledgement boundary — the extension must NOT issue separate
    // global.config/auth calls and must NOT dispose.
    const response = await ctx.client.customProvider.save(
      { providerID: id, config: sanitized.value, auth, directory: ctx.workspaceDir },
      { throwOnError: true },
    )

    // Check the structured result — the endpoint returns 400 for validation
    // failures (non-custom provider, config schema errors).
    if (!response.data?.success) {
      postError(ctx, requestId, providerID, "connect", "Failed to save custom provider")
      return
    }

    // LOCK-005: the backend response IS the mutation acknowledgement. The
    // backend SSE transaction event reconciles config; post providerConnected
    // only after success, then refresh. A refresh failure must never be
    // reported as a save failure and save is never retried automatically.
    ctx.postMessage({ type: "providerConnected", requestId, providerID: id })
    try {
      await ctx.fetchAndSendProviders()
    } catch (error) {
      console.warn(`[Kilo New] custom provider ${id} saved but provider refresh failed:`, error)
    }
  } catch (error) {
    postError(ctx, requestId, providerID, "connect", ctx.getErrorMessage(error) || "Failed to save custom provider")
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
