/**
 * Authentication handlers — extracted from KiloProvider.
 *
 * Manages login (device auth flow), logout, organization switching,
 * and profile refresh. No vscode dependency.
 */

import type { KiloClient } from "@kilocode/sdk/v2/client"
import { getErrorMessage } from "../../kilo-provider-utils"
import {
  removeAuthPrivateFirst,
  type AuthRemovePrivateConnection,
} from "../auth-remove-privatefirst"

export interface AuthContext {
  readonly client: KiloClient | null
  postMessage(msg: unknown): void
  getWorkspaceDirectory(): string
  fetchAndSendProviders(): Promise<void>
  fetchAndSendAgents(): Promise<void>
  /** Private-first `auth/remove` connection (owner: `KiloConnectionService`). Absent stays SDK-only. */
  readonly connection?: AuthRemovePrivateConnection | null
}

/**
 * Handle login via the provider OAuth device-auth flow.
 * Sends device auth messages so the webview can display QR code, code, and timer.
 *
 * @param attempt - The current login attempt counter value (pre-incremented by caller).
 * @param getAttempt - Returns the latest attempt counter (may have changed if user cancelled).
 */
export async function handleLogin(ctx: AuthContext, attempt: number, getAttempt: () => number): Promise<void> {
  if (!ctx.client) return

  console.log("[Kilo New] KiloProvider: 🔐 Starting login flow...")

  try {
    const dir = ctx.getWorkspaceDirectory()

    // Step 1: Initiate OAuth authorization
    const { data: auth } = await ctx.client.provider.oauth.authorize(
      { providerID: "kilo", method: 0, directory: dir },
      { throwOnError: true },
    )
    console.log("[Kilo New] KiloProvider: 🔐 Got auth URL:", auth.url)

    // Parse code from instructions (format: "Open URL and enter code: ABCD-1234")
    const match = auth.instructions?.match(/code:\s*(\S+)/i)
    const code = match ? match[1] : undefined

    // Send device auth details to webview
    ctx.postMessage({
      type: "deviceAuthStarted",
      code,
      verificationUrl: auth.url,
      expiresIn: 900, // 15 minutes default
    })

    // Step 2: Wait for callback (blocks until polling completes)
    await ctx.client.provider.oauth.callback({ providerID: "kilo", method: 0, directory: dir }, { throwOnError: true })

    // Check if this attempt was cancelled
    if (attempt !== getAttempt()) return

    console.log("[Kilo New] KiloProvider: 🔐 Login successful")

    // LOCK-001/003: backend OAuth callback coordinates drain/rebuild and emits
    // global.disposed — the extension must NOT call global.dispose. The
    // callback response IS the login acknowledgement.

    // Step 3: Fetch profile and push to webview — best-effort after the
    // callback mutation. A profile read failure after a successful login must
    // never be reported as a login failure.
    try {
      const { data: profile } = await ctx.client.kilo.profile(undefined, { throwOnError: true })
      ctx.postMessage({ type: "profileData", data: profile })
    } catch (error) {
      console.warn("[Kilo New] KiloProvider: Login succeeded but profile fetch failed:", error)
    }
    ctx.postMessage({ type: "deviceAuthComplete" })
  } catch (error) {
    if (attempt !== getAttempt()) return
    ctx.postMessage({
      type: "deviceAuthFailed",
      error: getErrorMessage(error) || "Login failed",
    })
  }
}

/** Handle logout: remove auth credentials and clear profile. */
export async function handleLogout(ctx: AuthContext): Promise<void> {
  if (!ctx.client) return

  try {
    console.log("[Kilo New] KiloProvider: 🚪 Logging out...")
    // LOCK-001/002/003: backend auth.remove coordinates drain/rebuild and
    // emits global.disposed — the extension must NOT call global.dispose.
    // auth.remove is never best-effort: a backend failure must surface as a
    // real logout error, never a silent success.
    //
    // Private-first `auth/remove` over the fd carrier with exactly one
    // same-identity SDK `client.auth.remove` fallback (see
    // `kilo-provider/auth-remove-privatefirst.ts`; the SDK call lives only in
    // that helper's fallback — never here).
    const outcome = await removeAuthPrivateFirst({
      connection: ctx.connection ?? null,
      client: ctx.client as never,
      providerID: "kilo",
      directory: ctx.getWorkspaceDirectory(),
    })
    if (outcome.kind === "terminal")
      throw new Error(outcome.code ? `logout failed: ${outcome.code}` : "logout failed")
    if (outcome.kind === "unavailable") {
      const cause = (outcome as { cause?: unknown }).cause
      throw cause instanceof Error ? cause : new Error("Failed to logout")
    }
    console.log("[Kilo New] KiloProvider: 🚪 Logged out successfully")
    ctx.postMessage({ type: "profileData", data: null })

    // Refresh providers best-effort — a refresh failure after a successful
    // logout must never be reported as a logout failure.
    try {
      await ctx.fetchAndSendProviders()
    } catch (error) {
      console.warn("[Kilo New] KiloProvider: Logout succeeded but provider refresh failed:", error)
    }
  } catch (error) {
    console.error("[Kilo New] KiloProvider: ❌ Logout failed:", error)
    ctx.postMessage({
      type: "error",
      message: getErrorMessage(error) || "Failed to logout",
    })
  }
}

/**
 * Handle organization switch.
 * Persists the selection and refreshes profile + providers since both change with org context.
 */
export async function handleSetOrganization(ctx: AuthContext, organizationId: string | null): Promise<void> {
  if (!ctx.client) return

  console.log("[Kilo New] KiloProvider: Switching organization:", organizationId ?? "personal")
  try {
    // LOCK-001: the backend organization set coordinates provider auth and
    // the instance rebuild; its response IS the mutation acknowledgement.
    // The extension must NOT call global.dispose — a double disposal would race
    // the backend's own rebuild.
    await ctx.client.kilo.organization.set({ organizationId }, { throwOnError: true })
  } catch (error) {
    console.error("[Kilo New] KiloProvider: Failed to switch organization:", error)
    // Re-fetch current profile to reset webview state — best-effort
    try {
      const result = await ctx.client.kilo.profile()
      ctx.postMessage({ type: "profileData", data: result.data ?? null })
    } catch (profileError) {
      console.error("[Kilo New] KiloProvider: Failed to refresh profile after org switch error:", profileError)
    }
    return
  }

  // Org switch succeeded — refresh profile and providers independently (best-effort)
  try {
    const result = await ctx.client.kilo.profile()
    ctx.postMessage({ type: "profileData", data: result.data ?? null })
  } catch (error) {
    console.error("[Kilo New] KiloProvider: Failed to refresh profile after org switch:", error)
  }
  try {
    await ctx.fetchAndSendProviders()
  } catch (error) {
    console.error("[Kilo New] KiloProvider: Failed to refresh providers after org switch:", error)
  }
  try {
    await ctx.fetchAndSendAgents()
  } catch (error) {
    console.error("[Kilo New] KiloProvider: Failed to refresh agents after org switch:", error)
  }
}

/** Handle profile refresh request. */
export async function handleRefreshProfile(ctx: AuthContext): Promise<void> {
  if (!ctx.client) return

  console.log("[Kilo New] KiloProvider: 🔄 Refreshing profile...")
  const result = await ctx.client.kilo.profile().catch(() => ({ data: null }))
  ctx.postMessage({ type: "profileData", data: result.data ?? null })
}
