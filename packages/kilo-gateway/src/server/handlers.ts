import { fetchBalance, fetchProfile } from "../api/profile.js"
import { fetchKiloPassState } from "../api/kilo-pass.js"
import { fetchKilocodeNotifications } from "../api/notifications.js"
import { clearModesCache } from "../api/modes.js"
import type { KilocodeBalance, KilocodeProfile, KiloPassState } from "../types.js"

export type KiloAuth =
  | { type: "api"; key: string }
  | { type: "oauth"; access: string; refresh: string; expires: number; accountId?: string }
  | { type: "wellknown"; key: string; token: string }

export interface KiloProfileResult {
  profile: KilocodeProfile
  balance: KilocodeBalance | null
  kiloPass: KiloPassState | null
  currentOrgId: string | null
}

export interface AuthStore {
  get(provider: string): Promise<KiloAuth | undefined>
  set(provider: string, auth: Extract<KiloAuth, { type: "oauth" }>): Promise<void>
}

export interface OrganizationDeps {
  auth: AuthStore
  clear(): void | Promise<void>
  dispose(): Promise<void>
}

export class UnauthorizedError extends Error {}

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export function getToken(auth: KiloAuth | undefined) {
  if (auth?.type === "api") return auth.key
  if (auth?.type === "oauth") return auth.access
  return undefined
}

export function getOrganizationId(auth: KiloAuth | undefined) {
  if (auth?.type === "oauth") return auth.accountId
  return undefined
}

export async function getProfile(auth: AuthStore): Promise<KiloProfileResult> {
  const info = await auth.get("kilo")
  if (!info || info.type !== "oauth") throw new UnauthorizedError("Not authenticated with Kilo Gateway")

  const currentOrgId = info.accountId ?? null
  const [profile, balance, kiloPass] = await Promise.all([
    fetchProfile(info.access),
    fetchBalance(info.access, currentOrgId ?? undefined),
    fetchKiloPassState(info.access),
  ])
  return { profile, balance, kiloPass, currentOrgId }
}

export async function getNotifications(auth: AuthStore) {
  const info = await auth.get("kilo")
  const token = getToken(info)
  if (!token) return []

  return fetchKilocodeNotifications({
    kilocodeToken: token,
    kilocodeOrganizationId: getOrganizationId(info),
  })
}

export async function setOrganization(deps: OrganizationDeps, organizationId: string | null) {
  const info = await deps.auth.get("kilo")
  if (!info || info.type !== "oauth") throw new UnauthorizedError("Not authenticated with Kilo Gateway")

  await deps.auth.set("kilo", {
    type: "oauth",
    refresh: info.refresh,
    access: info.access,
    expires: info.expires,
    ...(organizationId && { accountId: organizationId }),
  })

  await deps.clear()
  clearModesCache()
  await deps.dispose()
  return true
}

