import { Effect } from "effect"
import { fetchBalance, fetchKiloPassState, fetchProfile } from "@kilocode/kilo-gateway"
import { Auth } from "@/auth"
import { canonicalDirectory } from "@/kilocode/session/canonical-directory"

export const VERSION = 1 as const
export const OP = "kilo/profile" as const
export const CAPABILITY = "kilo/profile" as const

export interface KiloProfileRequest {
  v: typeof VERSION
  requestId: string
  op: typeof OP
  context: {
    directory: string
    workspace?: string
  }
  payload: Record<string, never>
}

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

export interface KiloProfileFailure {
  code: string
  message: string
  retryable: boolean
}

export interface KiloProfileSucceeded {
  v: typeof VERSION
  requestId: string
  op: typeof OP
  status: "succeeded"
  outcome: { type: "succeeded"; time: number }
  accepted: true
  data: KiloProfileData
}

export interface KiloProfileFailed {
  v: typeof VERSION
  requestId: string
  op: typeof OP
  status: "failed"
  outcome: { type: "failed"; time: number; failure: KiloProfileFailure }
  accepted: false
  failure: KiloProfileFailure
}

export interface KiloProfileAmbiguous {
  v: typeof VERSION
  requestId: string
  op: typeof OP
  status: "ambiguous"
  outcome: { type: "ambiguous"; time: number }
  accepted: false
  transportUnknown?: boolean
}

export type KiloProfileResult = KiloProfileSucceeded | KiloProfileFailed | KiloProfileAmbiguous

export const VALIDATION_MESSAGE = "invalid kilo-profile request"
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

function present(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

function pathless(v: string): boolean {
  return !v.includes("/") && !v.includes("\\") && !v.includes("\0")
}

export function validateKiloProfileRequest(raw: unknown): KiloProfileRequest {
  if (!record(raw)) throw new Error("params must be object")
  if (raw.v !== VERSION) throw new Error("v must be 1")
  if (!present(raw.requestId)) throw new Error("requestId must be non-empty string")
  if (!pathless(raw.requestId as string)) throw new Error("requestId must be non-empty string without path material")
  if (raw.op !== OP) throw new Error("op must be kilo/profile")
  const ctx = raw.context
  if (!record(ctx)) throw new Error("context must be object")
  const allowedCtx = new Set(["directory", "workspace"])
  for (const k of Object.keys(ctx)) if (!allowedCtx.has(k)) throw new Error("unexpected context field")
  if (typeof ctx.directory !== "string" || ctx.directory.length === 0)
    throw new Error("context.directory must be non-empty string")
  canonicalDirectory(ctx.directory)
  if (ctx.workspace !== undefined) {
    if (typeof ctx.workspace !== "string" || ctx.workspace.length === 0 || (ctx.workspace as string).includes("\0"))
      throw new Error("context.workspace must be non-empty string when present")
  }
  const payload = raw.payload
  if (!record(payload)) throw new Error("payload must be object")
  if (Object.keys(payload).length !== 0) throw new Error("payload must be empty object for kilo-profile")
  const allowedRoot = new Set(["v", "requestId", "op", "context", "payload"])
  for (const k of Object.keys(raw)) if (!allowedRoot.has(k)) throw new Error("unexpected field")
  return raw as unknown as KiloProfileRequest
}

type Ids = { requestId: string }

function sanitized(v: unknown): string {
  if (typeof v !== "string" || v.length === 0 || !pathless(v)) return "unknown"
  return v
}

export function fallbackKiloProfileIds(raw: unknown): Ids {
  const o = (record(raw) ? raw : {}) as Record<string, unknown>
  return { requestId: sanitized(o.requestId) }
}

export function safeKiloProfileIds(req: { requestId: string }): Ids {
  return { requestId: sanitized(req.requestId) }
}

export function failed(ids: Ids, code: string, message: string, retryable: boolean): KiloProfileFailed {
  const failure = { code, message, retryable }
  return {
    v: VERSION,
    requestId: ids.requestId,
    op: OP,
    status: "failed",
    outcome: { type: "failed", time: Date.now(), failure },
    accepted: false,
    failure,
  }
}

export function succeeded(req: KiloProfileRequest, data: KiloProfileData): KiloProfileSucceeded {
  return {
    v: VERSION,
    requestId: req.requestId,
    op: OP,
    status: "succeeded",
    outcome: { type: "succeeded", time: Date.now() },
    accepted: true,
    data,
  }
}

export function ambiguous(req: KiloProfileRequest, transportUnknown = true): KiloProfileAmbiguous {
  const out: KiloProfileAmbiguous = {
    v: VERSION,
    requestId: req.requestId,
    op: OP,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) out.transportUnknown = true
  return out
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

const RESULT_SUCCEEDED = new Set(["v", "requestId", "op", "status", "outcome", "accepted", "data"])
const RESULT_FAILED = new Set(["v", "requestId", "op", "status", "outcome", "accepted", "failure"])
const RESULT_AMBIGUOUS = new Set(["v", "requestId", "op", "status", "outcome", "accepted", "transportUnknown"])
const OUTCOME_PLAIN = new Set(["type", "time"])
const OUTCOME_FAILED = new Set(["type", "time", "failure"])
const FAILURE_FIELDS = new Set(["code", "message", "retryable"])

function checkFailure(raw: unknown): KiloProfileFailure {
  if (!record(raw)) throw new Error("failure must be object")
  for (const k of Object.keys(raw)) if (!FAILURE_FIELDS.has(k)) throw new Error("unexpected failure field")
  if (!present(raw.code)) throw new Error("failure code must be non-empty string")
  if (!present(raw.message)) throw new Error("failure message must be non-empty string")
  if (typeof raw.retryable !== "boolean") throw new Error("failure retryable must be boolean")
  return raw as unknown as KiloProfileFailure
}

export function validateKiloProfileResult(raw: unknown, req: KiloProfileRequest): KiloProfileResult {
  if (!record(raw)) throw new Error("result must be object")
  if (raw.v !== VERSION) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.op !== OP) throw new Error("op mismatch")
  const status = raw.status
  if (status !== "succeeded" && status !== "failed" && status !== "ambiguous")
    throw new Error("status must be succeeded/failed/ambiguous")
  if (typeof raw.accepted !== "boolean") throw new Error("accepted must be boolean")
  const outcome = raw.outcome
  if (!record(outcome) || typeof outcome.type !== "string" || typeof outcome.time !== "number")
    throw new Error("outcome invalid")
  if (outcome.type !== status) throw new Error("outcome.type must match status")
  if (!Number.isFinite(outcome.time) || outcome.time < 0) throw new Error("outcome.time invalid")
  const rec = raw as Record<string, unknown>
  const out = outcome as Record<string, unknown>
  if (status === "succeeded") {
    for (const k of Object.keys(rec)) if (!RESULT_SUCCEEDED.has(k)) throw new Error("unexpected result field")
    for (const k of Object.keys(out)) if (!OUTCOME_PLAIN.has(k)) throw new Error("unexpected outcome field")
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    validateKiloProfileData(rec.data)
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (out.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as KiloProfileSucceeded
  }
  if (status === "failed") {
    for (const k of Object.keys(rec)) if (!RESULT_FAILED.has(k)) throw new Error("unexpected result field")
    for (const k of Object.keys(out)) if (!OUTCOME_FAILED.has(k)) throw new Error("unexpected outcome field")
    if (raw.accepted !== false) throw new Error("failed accepted must be false")
    const failure = checkFailure(rec.failure)
    const outFailure = checkFailure(out.failure)
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    if (rec.data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as KiloProfileFailed
  }
  for (const k of Object.keys(rec)) if (!RESULT_AMBIGUOUS.has(k)) throw new Error("unexpected result field")
  for (const k of Object.keys(out)) if (!OUTCOME_PLAIN.has(k)) throw new Error("unexpected outcome field")
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (out.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as KiloProfileAmbiguous
}

export function isSettledKiloProfileResult(result: unknown, req: KiloProfileRequest): boolean {
  if (!record(result)) return false
  const status = (result as { status?: unknown }).status
  if (status !== "succeeded" && status !== "failed") return false
  try {
    const out = validateKiloProfileResult(result, req)
    if (out.status === "succeeded") return true
    if (out.status === "failed") return out.failure.retryable === false
    return false
  } catch {
    return false
  }
}

export interface KiloProfileDeps {
  fetchProfile?: (token: string) => Promise<unknown>
  fetchBalance?: (token: string, orgId?: string) => Promise<unknown>
  fetchKiloPassState?: (token: string) => Promise<unknown>
}

// Shared `kilo.profile` read body for HTTP + fd. Only `Auth.Service` plus the
// existing gateway fetches; no `InstanceRef`, no drain/read lease, no config
// fence, no cache, no timeout, no `AbortSignal`. `directory`/`workspace` are
// carrier routing identity only and never reach the gateway.
//
// Error taxonomy (no upstream-text guessing): only an explicit local
// unauthenticated state (`Auth.get` missing/non-oauth/empty access) is
// `KiloProfileUnauthorized`. Every gateway fetch failure — including the
// gateway's own `Invalid token` 401/403 — is `KiloProfileUpstream` so the HTTP
// route keeps its original `BadRequest` mapping and the fd route maps to
// retryable `upstream` (SDK fallback). Malformed gateway shape is
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

// Private `kilo/profile`: routing-only directory validation, then the shared
// read. No `acquireDrainControl`, no `InstanceRef` lane, no journal/replay.
export const kiloProfilePrivate = Effect.fn("KiloProfilePrivate.read")(function* (raw: unknown) {
  let req: KiloProfileRequest
  try {
    req = validateKiloProfileRequest(raw)
  } catch {
    return failed(fallbackKiloProfileIds(raw), "validation.failed", VALIDATION_MESSAGE, false)
  }
  const safe = safeKiloProfileIds(req)
  try {
    canonicalDirectory(req.context.directory)
  } catch {
    return failed(safe, "validation.failed", VALIDATION_MESSAGE, false)
  }
  if (req.context.workspace !== undefined) {
    const ws = req.context.workspace
    if (typeof ws !== "string" || ws.length === 0 || ws.includes("\0"))
      return failed(safe, "validation.failed", VALIDATION_MESSAGE, false)
  }
  const out = yield* fetchKiloProfileData().pipe(
    Effect.map((data) => ({ tag: "ok" as const, data })),
    Effect.catch((e: unknown): Effect.Effect<{ tag: "unauthorized" } | { tag: "upstream" } | { tag: "fail" }, never, never> => {
      if (e instanceof KiloProfileUnauthorized) return Effect.succeed({ tag: "unauthorized" as const })
      if (e instanceof KiloProfileUpstream) return Effect.succeed({ tag: "upstream" as const })
      return Effect.succeed({ tag: "fail" as const })
    }),
    Effect.catchDefect(() => Effect.succeed({ tag: "fail" as const })),
  )
  if (out.tag === "ok") {
    try {
      validateKiloProfileData(out.data)
    } catch {
      return failed(safe, "internal", INTERNAL_MESSAGE, false)
    }
    return succeeded(req, out.data)
  }
  if (out.tag === "unauthorized") return failed(safe, "unauthorized", UNAUTHORIZED_MESSAGE, false)
  if (out.tag === "upstream") return failed(safe, "upstream", UPSTREAM_MESSAGE, true)
  return failed(safe, "internal", INTERNAL_MESSAGE, false)
})
