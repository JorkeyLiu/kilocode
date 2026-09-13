// Private-first `kilo/profile` read-only observation contract (production).
// Request is strictly `{v:1,requestId,op:"kilo/profile",
// context:{directory,workspace?},payload:{}}` with no `opId`/`idempotencyKey`
// (observation identity is `requestId` only). Success data preserves the exact
// HTTP `GET /kilo/profile` shape (`ProfileWithBalance`): required
// `profile,balance,kiloPass,currentOrgId` with precise nullability;
// `profile.email` required, other profile fields optional; `organizations`
// entries strict `{id,name,role}`; `kiloPass.nextBillingAt` optional nullable.
//
// Source facts:
// - Route: `GET /kilo/profile` with `WorkspaceRoutingQuery` in
//   `packages/opencode/src/kilocode/server/httpapi/groups/kilo-gateway.ts`
//   (`identifier: "kilo.profile"`, success `ProfileWithBalance`).
// - Handler: `packages/opencode/src/kilocode/server/httpapi/handlers/kilo-gateway.ts`
//   reads `Auth.get("kilo")` then `fetchProfile`/`fetchBalance`/`fetchKiloPassState`.
//   The FD handler invokes the same shared `fetchKiloProfileData` with no
//   `InstanceRef`/drain lane.
// - SDK: v2 kilo profile read with optional directory/workspace query issues
//   `GET /kilo/profile`; v2 generated `KiloProfileResponses[200]` is the exact
//   success shape mirrored here.
// - Consumers: `KiloProvider.syncWebviewState` + sse-connected plus
//   `kilo-provider/handlers/auth.ts` login/org-switch/refresh are private-first:
//   validated success returns with zero SDK; validated terminal closes with
//   zero SDK; fallback-eligible outcomes take exactly one same-directory SDK
//   `client.kilo.profile` call.
//
// ROUTING vs PAYLOAD SEMANTICS (v1):
// - `context.directory` binds request routing and scope. A scope match says
//   nothing about payload freshness or completeness.
// - Payload is validated shape-only. No freshness, ordering, lifecycle, or
//   cross-directory claim is made.
// - Out of scope: OAuth, `auth.set`, `instance.reload`, caching/dedup,
//   UI rendering, transport behavior beyond the fixed failure taxonomy.

import { isAbsolute } from "path"

function record(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function present(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

function clean(v: unknown, label: string): string {
  if (!present(v)) throw new Error(`${label} must be non-empty string`)
  const text = v as string
  if (text.includes("\0")) throw new Error(`${label} must not contain null bytes`)
  return text
}

function pathless(v: string): boolean {
  return !v.includes("/") && !v.includes("\\") && !v.includes("\0")
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

export interface KiloProfileContractRequest {
  v: 1
  requestId: string
  op: "kilo/profile"
  context: { directory: string; workspace?: string }
  payload: Record<string, never>
}

export function validateKiloProfileContractRequest(raw: unknown): KiloProfileContractRequest {
  if (!record(raw)) throw new Error("request must be object")
  const allowed = new Set(["v", "requestId", "op", "context", "payload"])
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) throw new Error(`unexpected field ${k}`)
  }
  if (raw.v !== 1) throw new Error("v must be 1")
  clean(raw.requestId, "requestId")
  if (!pathless(raw.requestId as string)) throw new Error("requestId must not carry path material")
  if (raw.op !== "kilo/profile") throw new Error("op must be kilo/profile")
  const ctx = raw.context
  if (!record(ctx)) throw new Error("context must be object")
  const ctxAllowed = new Set(["directory", "workspace"])
  for (const k of Object.keys(ctx)) {
    if (!ctxAllowed.has(k)) throw new Error(`unexpected context field ${k}`)
  }
  if (typeof ctx.directory !== "string" || !isAbsolute(ctx.directory) || ctx.directory.includes("\0"))
    throw new Error("context.directory must be absolute path")
  if (ctx.workspace !== undefined) {
    if (!present(ctx.workspace) || (ctx.workspace as string).includes("\0"))
      throw new Error("context.workspace must be non-empty string when present")
  }
  const payload = raw.payload
  if (!record(payload)) throw new Error("payload must be object")
  if (Object.keys(payload).length !== 0) throw new Error("payload must be empty object for kilo-profile")
  return raw as unknown as KiloProfileContractRequest
}

function str(v: unknown): v is string {
  return typeof v === "string" && !v.includes("\0")
}

export function validateKiloProfileOrganization(raw: unknown): KiloProfileOrganization {
  if (!record(raw)) throw new Error("organization must be object")
  const allowed = new Set(["id", "name", "role"])
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new Error("unexpected organization field")
  // Canonical `Schema.String` allows empty: presence + string (no NUL) only.
  if (!str(raw.id)) throw new Error("organization.id invalid")
  if (!str(raw.name)) throw new Error("organization.name invalid")
  if (!str(raw.role)) throw new Error("organization.role invalid")
  return raw as unknown as KiloProfileOrganization
}

function checkProfilePart(profile: unknown): void {
  if (!record(profile)) throw new Error("profile must be object")
  const allowedProfile = new Set(["email", "name", "organizations", "selectedOrganizationId", "hasPersonalAccount"])
  for (const k of Object.keys(profile)) if (!allowedProfile.has(k)) throw new Error("unexpected profile field")
  // Canonical `Schema.String` allows empty: `email` must be present as a
  // string (no NUL); empty is valid (gateway may return `""`).
  if (!str(profile.email)) throw new Error("profile.email invalid")
  if (profile.name !== undefined) {
    if (typeof profile.name !== "string" || (profile.name as string).includes("\0"))
      throw new Error("profile.name invalid")
  }
  if (profile.organizations !== undefined) {
    if (!Array.isArray(profile.organizations)) throw new Error("profile.organizations must be array")
    for (const item of profile.organizations as unknown[]) validateKiloProfileOrganization(item)
  }
  if (profile.selectedOrganizationId !== undefined) {
    if (typeof profile.selectedOrganizationId !== "string" || (profile.selectedOrganizationId as string).includes("\0"))
      throw new Error("profile.selectedOrganizationId invalid")
  }
  if (profile.hasPersonalAccount !== undefined && typeof profile.hasPersonalAccount !== "boolean")
    throw new Error("profile.hasPersonalAccount invalid")
}

function checkBalancePart(balance: unknown): void {
  if (balance === null) return
  if (!record(balance)) throw new Error("balance must be object or null")
  for (const k of Object.keys(balance)) if (k !== "balance") throw new Error("unexpected balance field")
  if (typeof balance.balance !== "number" || !Number.isFinite(balance.balance))
    throw new Error("balance.balance invalid")
}

function checkKiloPassPart(kiloPass: unknown): void {
  if (kiloPass === null) return
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
  if (kiloPass.nextBillingAt !== undefined && kiloPass.nextBillingAt !== null) {
    if (typeof kiloPass.nextBillingAt !== "string" || (kiloPass.nextBillingAt as string).includes("\0"))
      throw new Error("kiloPass.nextBillingAt invalid")
  }
}

export function validateKiloProfileData(raw: unknown): KiloProfileData {
  if (!record(raw)) throw new Error("data must be object")
  const allowed = new Set(["profile", "balance", "kiloPass", "currentOrgId"])
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new Error(`unexpected data field ${k}`)
  checkProfilePart(raw.profile)
  checkBalancePart(raw.balance)
  checkKiloPassPart(raw.kiloPass)
  const currentOrgId = raw.currentOrgId
  if (currentOrgId !== null) {
    if (typeof currentOrgId !== "string" || (currentOrgId as string).includes("\0"))
      throw new Error("currentOrgId invalid")
  }
  return raw as unknown as KiloProfileData
}

export interface KiloProfileFailure {
  code: string
  message: string
  retryable: boolean
}

export const KILO_PROFILE_FAILURE_CODES = new Set([
  "validation.failed",
  "unauthorized",
  "upstream",
  "internal",
] as const)
export type KiloProfileFailureCode = "validation.failed" | "unauthorized" | "upstream" | "internal"
export const KILO_PROFILE_FAILURE_MESSAGES: Record<KiloProfileFailureCode, string> = {
  "validation.failed": "invalid kilo-profile request",
  unauthorized: "not authenticated with Kilo Gateway",
  upstream: "kilo gateway upstream failed",
  internal: "internal error",
}
export const KILO_PROFILE_FAILURE_RETRYABLE: Record<KiloProfileFailureCode, boolean> = {
  "validation.failed": false,
  unauthorized: false,
  upstream: true,
  internal: false,
}

const FAILURE_FIELDS = new Set(["code", "message", "retryable"])

export function validateKiloProfileFailure(raw: unknown): KiloProfileFailure {
  if (!record(raw)) throw new Error("failure must be object")
  for (const k of Object.keys(raw)) {
    if (!FAILURE_FIELDS.has(k)) throw new Error(`unexpected failure field ${k}`)
  }
  if (typeof raw.code !== "string" || !KILO_PROFILE_FAILURE_CODES.has(raw.code as KiloProfileFailureCode))
    throw new Error("failure code must be a known kilo-profile category")
  const code = raw.code as KiloProfileFailureCode
  if (raw.message !== KILO_PROFILE_FAILURE_MESSAGES[code])
    throw new Error("failure message must be the fixed message for its code")
  if (raw.retryable !== KILO_PROFILE_FAILURE_RETRYABLE[code])
    throw new Error("failure retryable must match its code")
  return raw as unknown as KiloProfileFailure
}

export type KiloProfileResult =
  | {
      v: 1
      requestId: string
      op: "kilo/profile"
      status: "succeeded"
      outcome: { type: "succeeded"; time: number }
      accepted: true
      data: KiloProfileData
    }
  | {
      v: 1
      requestId: string
      op: "kilo/profile"
      status: "failed"
      outcome: { type: "failed"; time: number; failure: KiloProfileFailure }
      accepted: boolean
      failure: KiloProfileFailure
    }
  | {
      v: 1
      requestId: string
      op: "kilo/profile"
      status: "ambiguous"
      outcome: { type: "ambiguous"; time: number }
      accepted: false
      transportUnknown?: boolean
    }

export function makeKiloProfileAmbiguous(req: KiloProfileContractRequest, transportUnknown = true): KiloProfileResult {
  const out: KiloProfileResult = {
    v: 1,
    requestId: req.requestId,
    op: "kilo/profile",
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
  }
  if (transportUnknown) (out as { transportUnknown?: boolean }).transportUnknown = true
  return out
}

export type KiloProfileWireOutcome = { kind: "valid"; result: KiloProfileResult } | { kind: "invalid"; detail: string }

export class KiloProfileValidationError extends Error {
  readonly kind = "private-kilo-profile-validation" as const
  readonly detail: string
  constructor(detail: string) {
    super(`invalid private response shape: ${detail}`)
    this.name = "KiloProfileValidationError"
    this.detail = detail
  }
}

export function isKiloProfileValidationError(v: unknown): v is KiloProfileValidationError {
  return !!v && typeof v === "object" && (v as { kind?: unknown }).kind === "private-kilo-profile-validation"
}

export function normalizePrivateKiloProfileWire(
  raw: unknown,
  req: KiloProfileContractRequest,
): KiloProfileWireOutcome {
  try {
    const result = validateKiloProfileResult(raw, req)
    return { kind: "valid", result }
  } catch (e) {
    const detail = String(e instanceof Error ? e.message : e).slice(0, 200)
    return { kind: "invalid", detail }
  }
}

const RESULT_SUCCEEDED = new Set(["v", "requestId", "op", "status", "outcome", "accepted", "data"])
const RESULT_FAILED = new Set(["v", "requestId", "op", "status", "outcome", "accepted", "failure"])
const RESULT_AMBIGUOUS = new Set(["v", "requestId", "op", "status", "outcome", "accepted", "transportUnknown"])
const OUTCOME_PLAIN = new Set(["type", "time"])
const OUTCOME_FAILED = new Set(["type", "time", "failure"])

// eslint-disable-next-line complexity
export function validateKiloProfileResult(raw: unknown, req: KiloProfileContractRequest): KiloProfileResult {
  if (!record(raw)) throw new Error("result must be object")
  if (raw.v !== 1) throw new Error("result v must be 1")
  if (raw.requestId !== req.requestId) throw new Error("requestId mismatch")
  if (raw.op !== "kilo/profile") throw new Error("op mismatch")
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
  const outRec = outcome as Record<string, unknown>
  if (status === "succeeded") {
    for (const k of Object.keys(rec)) if (!RESULT_SUCCEEDED.has(k)) throw new Error(`unexpected result field ${k}`)
    for (const k of Object.keys(outRec)) if (!OUTCOME_PLAIN.has(k)) throw new Error(`unexpected outcome field ${k}`)
    if (raw.accepted !== true) throw new Error("succeeded accepted must be true")
    const data = rec.data
    if (!record(data)) throw new Error("succeeded data must be object")
    validateKiloProfileData(data)
    if (rec.failure !== undefined) throw new Error("succeeded must not have failure")
    if (outRec.failure !== undefined) throw new Error("succeeded outcome must not have failure")
    return raw as unknown as KiloProfileResult
  }
  if (status === "failed") {
    for (const k of Object.keys(rec)) if (!RESULT_FAILED.has(k)) throw new Error(`unexpected result field ${k}`)
    for (const k of Object.keys(outRec)) if (!OUTCOME_FAILED.has(k)) throw new Error(`unexpected outcome field ${k}`)
    const failure = validateKiloProfileFailure(rec.failure)
    const outFailure = validateKiloProfileFailure(outRec.failure)
    if (failure.code !== outFailure.code) throw new Error("failure code mismatch")
    if (failure.message !== outFailure.message) throw new Error("failure message mismatch")
    if (failure.retryable !== outFailure.retryable) throw new Error("failure retryable mismatch")
    if (rec.data !== undefined) throw new Error("failed must not have data")
    return raw as unknown as KiloProfileResult
  }
  for (const k of Object.keys(rec)) if (!RESULT_AMBIGUOUS.has(k)) throw new Error(`unexpected result field ${k}`)
  for (const k of Object.keys(outRec)) if (!OUTCOME_PLAIN.has(k)) throw new Error(`unexpected outcome field ${k}`)
  if (raw.accepted !== false) throw new Error("ambiguous accepted must be false")
  if (rec.transportUnknown !== undefined && typeof rec.transportUnknown !== "boolean")
    throw new Error("transportUnknown must be boolean")
  if (rec.data !== undefined) throw new Error("ambiguous must not have data")
  if (rec.failure !== undefined) throw new Error("ambiguous must not have failure")
  if (outRec.failure !== undefined) throw new Error("ambiguous outcome must not have failure")
  return raw as unknown as KiloProfileResult
}

export function isSettledKiloProfileResult(result: unknown, req: KiloProfileContractRequest): boolean {
  if (!record(result)) return false
  const kind = (result as { status?: unknown }).status
  if (kind !== "succeeded" && kind !== "failed") return false
  try {
    const out = validateKiloProfileResult(result, req)
    if (out.status === "succeeded") return true
    if (out.status === "failed") return out.failure.retryable === false
    return false
  } catch {
    return false
  }
}
