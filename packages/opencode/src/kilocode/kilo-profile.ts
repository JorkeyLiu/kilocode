import { Effect } from "effect"
import { fetchBalance, fetchKiloPassState, fetchProfile } from "@kilocode/kilo-gateway"
import { Auth } from "@/auth"

export interface KiloProfileOrganization {
  id: string
  name: string
  role: string
}

export interface KiloProfileData {
  profile: {
    email: string
    name?: string
    organizations?: KiloProfileOrganization[]
    selectedOrganizationId?: string
    hasPersonalAccount?: boolean
  }
  balance: { balance: number } | null
  kiloPass: {
    currentPeriodBaseCreditsUsd: number
    currentPeriodUsageUsd: number
    currentPeriodBonusCreditsUsd: number
    nextBillingAt?: string | null
  } | null
  currentOrgId: string | null
}

export const UNAUTHORIZED_MESSAGE = "not authenticated with Kilo Gateway"
export const UPSTREAM_MESSAGE = "kilo gateway upstream failed"
export const INTERNAL_MESSAGE = "internal error"

export class KiloProfileUnauthorized extends Error {
  readonly _tag = "KiloProfileUnauthorized" as const
  constructor() {
    super(UNAUTHORIZED_MESSAGE)
    this.name = "KiloProfileUnauthorized"
  }
}

export class KiloProfileUpstream extends Error {
  readonly _tag = "KiloProfileUpstream" as const
  constructor() {
    super(UPSTREAM_MESSAGE)
    this.name = "KiloProfileUpstream"
  }
}

export class KiloProfileInternal extends Error {
  readonly _tag = "KiloProfileInternal" as const
  constructor() {
    super(INTERNAL_MESSAGE)
    this.name = "KiloProfileInternal"
  }
}

function record(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function checkStringField(v: unknown): v is string {
  return typeof v === "string" && !v.includes("\0")
}

function checkOrganization(raw: unknown): KiloProfileOrganization {
  if (!record(raw)) throw new Error("organization must be object")
  const allowed = new Set(["id", "name", "role"])
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new Error("unexpected organization field")
  // Canonical `Schema.String` allows empty: presence + string (no NUL) only.
  if (!checkStringField(raw.id)) throw new Error("organization.id invalid")
  if (!checkStringField(raw.name)) throw new Error("organization.name invalid")
  if (!checkStringField(raw.role)) throw new Error("organization.role invalid")
  return raw as unknown as KiloProfileOrganization
}

export function validateKiloProfileData(raw: unknown): KiloProfileData {
  if (!record(raw)) throw new Error("data must be object")
  const allowed = new Set(["profile", "balance", "kiloPass", "currentOrgId"])
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new Error("unexpected data field")
  const profile = raw.profile
  if (!record(profile)) throw new Error("profile must be object")
  const allowedProfile = new Set(["email", "name", "organizations", "selectedOrganizationId", "hasPersonalAccount"])
  for (const k of Object.keys(profile)) if (!allowedProfile.has(k)) throw new Error("unexpected profile field")
  // Canonical `Schema.String` allows empty: `email` must be present as a
  // string (no NUL); empty is valid (gateway may return `""`).
  if (!checkStringField(profile.email)) throw new Error("profile.email invalid")
  if (profile.name !== undefined && (typeof profile.name !== "string" || (profile.name as string).includes("\0")))
    throw new Error("profile.name invalid")
  if (profile.organizations !== undefined) {
    if (!Array.isArray(profile.organizations)) throw new Error("profile.organizations must be array")
    for (const item of profile.organizations as unknown[]) checkOrganization(item)
  }
  if (
    profile.selectedOrganizationId !== undefined &&
    (typeof profile.selectedOrganizationId !== "string" ||
      (profile.selectedOrganizationId as string).includes("\0"))
  )
    throw new Error("profile.selectedOrganizationId invalid")
  if (profile.hasPersonalAccount !== undefined && typeof profile.hasPersonalAccount !== "boolean")
    throw new Error("profile.hasPersonalAccount invalid")
  const balance = raw.balance
  if (balance !== null) {
    if (!record(balance)) throw new Error("balance must be object or null")
    const allowedBalance = new Set(["balance"])
    for (const k of Object.keys(balance)) if (!allowedBalance.has(k)) throw new Error("unexpected balance field")
    if (typeof balance.balance !== "number" || !Number.isFinite(balance.balance))
      throw new Error("balance.balance invalid")
  }
  const kiloPass = raw.kiloPass
  if (kiloPass !== null) {
    if (!record(kiloPass)) throw new Error("kiloPass must be object or null")
    const allowedPass = new Set([
      "currentPeriodBaseCreditsUsd",
      "currentPeriodUsageUsd",
      "currentPeriodBonusCreditsUsd",
      "nextBillingAt",
    ])
    for (const k of Object.keys(kiloPass)) if (!allowedPass.has(k)) throw new Error("unexpected kiloPass field")
    for (const k of [
      "currentPeriodBaseCreditsUsd",
      "currentPeriodUsageUsd",
      "currentPeriodBonusCreditsUsd",
    ] as const) {
      if (typeof kiloPass[k] !== "number" || !Number.isFinite(kiloPass[k] as number))
        throw new Error(`kiloPass.${k} invalid`)
    }
    if (
      kiloPass.nextBillingAt !== undefined &&
      kiloPass.nextBillingAt !== null &&
      typeof kiloPass.nextBillingAt !== "string"
    )
      throw new Error("kiloPass.nextBillingAt invalid")
    if (typeof kiloPass.nextBillingAt === "string" && (kiloPass.nextBillingAt as string).includes("\0"))
      throw new Error("kiloPass.nextBillingAt invalid")
  }
  const currentOrgId = raw.currentOrgId
  if (currentOrgId !== null && (typeof currentOrgId !== "string" || (currentOrgId as string).includes("\0")))
    throw new Error("currentOrgId invalid")
  return raw as unknown as KiloProfileData
}

export interface KiloProfileDeps {
  fetchProfile?: (token: string) => Promise<unknown>
  fetchBalance?: (token: string, orgId?: string) => Promise<unknown>
  fetchKiloPassState?: (token: string) => Promise<unknown>
}

// Shared `kilo.profile` read body for authenticated `GET /kilo/profile`.
// Only `Auth.Service` plus the existing gateway fetches; no `InstanceRef`,
// no drain/read lease, no config fence, no cache, no timeout, no
// `AbortSignal`.
//
// Error taxonomy (no upstream-text guessing): only an explicit local
// unauthenticated state (`Auth.get` missing/non-oauth/empty access) is
// `KiloProfileUnauthorized`. Every gateway fetch failure — including the
// gateway's own `Invalid token` 401/403 — is `KiloProfileUpstream` so the HTTP
// route keeps its original `BadRequest` mapping. Malformed gateway shape is
// `KiloProfileInternal`.
export const fetchKiloProfileData = (
  deps?: KiloProfileDeps,
): Effect.Effect<KiloProfileData, KiloProfileUnauthorized | KiloProfileUpstream | KiloProfileInternal, Auth.Service> =>
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const info = yield* auth.get("kilo").pipe(
      Effect.catch(() => Effect.fail(new KiloProfileInternal() as KiloProfileInternal)),
    )
    if (!info || info.type !== "oauth") return yield* Effect.fail(new KiloProfileUnauthorized())
    const access = (info as { access?: unknown }).access
    if (typeof access !== "string" || access.length === 0)
      return yield* Effect.fail(new KiloProfileUnauthorized())
    const currentOrgId = (info as { accountId?: unknown }).accountId ?? null
    const runProfile = deps?.fetchProfile ?? (fetchProfile as (token: string) => Promise<unknown>)
    const runBalance = deps?.fetchBalance ?? (fetchBalance as (token: string, org?: string) => Promise<unknown>)
    const runPass =
      deps?.fetchKiloPassState ?? (fetchKiloPassState as (token: string) => Promise<unknown>)
    const profile = yield* Effect.tryPromise({
      try: () => runProfile(access),
      catch: () => new KiloProfileUpstream(),
    })
    const orgArg = typeof currentOrgId === "string" ? currentOrgId : undefined
    const pair = yield* Effect.tryPromise({
      try: () => Promise.all([runBalance(access, orgArg), runPass(access)]),
      catch: () => new KiloProfileUpstream(),
    })
    const balance: unknown = pair[0]
    const kiloPass: unknown = pair[1]
    const data = {
      profile,
      balance,
      kiloPass,
      currentOrgId,
    }
    try {
      return validateKiloProfileData(data)
    } catch {
      return yield* Effect.fail(new KiloProfileInternal())
    }
  })
