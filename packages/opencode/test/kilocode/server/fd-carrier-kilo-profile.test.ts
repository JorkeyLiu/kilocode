import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import { Auth } from "../../../src/auth"
import {
  CAPABILITY,
  KiloProfileInternal,
  KiloProfileUnauthorized,
  KiloProfileUpstream,
  OP,
  VERSION,
  fetchKiloProfileData,
  kiloProfilePrivate,
  validateKiloProfileData,
  validateKiloProfileRequest,
} from "../../../src/kilocode/kilo-profile"
import { FD_CAPABILITIES } from "../../../src/kilocode/server/fd-carrier-protocol"

function full() {
  return {
    profile: {
      email: "a@b.c",
      name: "n",
      organizations: [{ id: "o1", name: "O", role: "owner" }],
      selectedOrganizationId: "o1",
      hasPersonalAccount: true,
    },
    balance: { balance: 1.5 },
    kiloPass: {
      currentPeriodBaseCreditsUsd: 1,
      currentPeriodUsageUsd: 2,
      currentPeriodBonusCreditsUsd: 3,
      nextBillingAt: "2026-01-01",
    },
    currentOrgId: "o1",
  }
}

function authLayer(info: unknown) {
  return Layer.mock(Auth.Service, {
    get: () => Effect.succeed(info as never),
  })
}

describe("kilo/profile private observation (backend)", () => {
  it("advertises the kilo/profile capability with op kilo/profile v1", () => {
    expect(CAPABILITY).toBe("kilo/profile")
    expect(OP).toBe("kilo/profile")
    expect(VERSION).toBe(1)
    expect([...FD_CAPABILITIES]).toContain("kilo/profile")
  })

  it("validates routing-only request strictly", () => {
    const base = { v: 1, requestId: "r1", op: "kilo/profile", context: { directory: "/tmp" }, payload: {} }
    expect(validateKiloProfileRequest(base).op).toBe("kilo/profile")
    expect(() => validateKiloProfileRequest({ ...base, context: { directory: "rel" } })).toThrow()
    expect(() => validateKiloProfileRequest({ ...base, payload: { x: 1 } })).toThrow()
    expect(() => validateKiloProfileRequest({ ...base, extra: 1 })).toThrow()
    expect(() => validateKiloProfileRequest({ ...base, opId: "x", idempotencyKey: "x" })).toThrow()
  })

  it("validates strict data with precise nullability", () => {
    expect(validateKiloProfileData(full())).toEqual(full())
    expect(
      validateKiloProfileData({ profile: { email: "a@b.c" }, balance: null, kiloPass: null, currentOrgId: null }),
    ).toEqual({ profile: { email: "a@b.c" }, balance: null, kiloPass: null, currentOrgId: null })
    expect(() => validateKiloProfileData({ ...full(), extra: 1 })).toThrow()
    expect(() => validateKiloProfileData({ profile: {}, balance: null, kiloPass: null, currentOrgId: null })).toThrow()
  })

  it("allows canonical empty strings for email and organization id/name/role", () => {
    const empty = {
      profile: { email: "", organizations: [{ id: "", name: "", role: "" }] },
      balance: null,
      kiloPass: null,
      currentOrgId: null,
    }
    expect(validateKiloProfileData(empty)).toEqual(empty)
    // Presence still required: missing/undefined/non-string rejected.
    expect(() =>
      validateKiloProfileData({ profile: {}, balance: null, kiloPass: null, currentOrgId: null }),
    ).toThrow()
    expect(() =>
      validateKiloProfileData({
        profile: { email: "a@b.c", organizations: [{ id: "", name: 1, role: "" }] },
        balance: null,
        kiloPass: null,
        currentOrgId: null,
      }),
    ).toThrow()
    expect(() => validateKiloProfileData({ ...full(), profile: { ...full().profile, email: 1 } })).toThrow()
  })

  it("returns full data via shared Auth + fetch (injectable)", async () => {
    const data = full()
    const out = await Effect.runPromise(
      fetchKiloProfileData({
        fetchProfile: async () => data.profile,
        fetchBalance: async () => data.balance,
        fetchKiloPassState: async () => data.kiloPass,
      }).pipe(Effect.provide(authLayer({ type: "oauth", refresh: "r", access: "a", expires: 1, accountId: "o1" }))),
    )
    expect(out).toEqual(data)
  })

  it("supports null balance/kiloPass/currentOrgId", async () => {
    const out = await Effect.runPromise(
      fetchKiloProfileData({
        fetchProfile: async () => ({ email: "a@b.c" }),
        fetchBalance: async () => null,
        fetchKiloPassState: async () => null,
      }).pipe(Effect.provide(authLayer({ type: "oauth", refresh: "r", access: "a", expires: 1 }))),
    )
    expect(out).toEqual({ profile: { email: "a@b.c" }, balance: null, kiloPass: null, currentOrgId: null })
  })

  it("maps only explicit local missing/non-oauth to unauthorized (no upstream-text guessing)", async () => {
    for (const info of [undefined, { type: "api", key: "k" }]) {
      const err = await Effect.runPromise(
        fetchKiloProfileData({
          fetchProfile: async () => ({ email: "a@b.c" }),
          fetchBalance: async () => null,
          fetchKiloPassState: async () => null,
        }).pipe(Effect.provide(authLayer(info)), Effect.flip),
      )
      expect(err).toBeInstanceOf(KiloProfileUnauthorized)
    }
    // The gateway's own invalid-token 401/403 is an upstream failure (HTTP
    // keeps its original BadRequest/400 mapping; fd maps to retryable
    // upstream with SDK fallback), never local unauthorized.
    const err = await Effect.runPromise(
      fetchKiloProfileData({
        fetchProfile: async () => {
          throw new Error("Invalid token")
        },
        fetchBalance: async () => null,
        fetchKiloPassState: async () => null,
      }).pipe(
        Effect.provide(authLayer({ type: "oauth", refresh: "r", access: "a", expires: 1 })),
        Effect.flip,
      ),
    )
    expect(err).toBeInstanceOf(KiloProfileUpstream)
  })

  it("maps gateway failure to upstream and malformed shape to internal", async () => {
    const up = await Effect.runPromise(
      fetchKiloProfileData({
        fetchProfile: async () => {
          throw new Error("Failed to fetch profile: 500")
        },
        fetchBalance: async () => null,
        fetchKiloPassState: async () => null,
      }).pipe(
        Effect.provide(authLayer({ type: "oauth", refresh: "r", access: "a", expires: 1 })),
        Effect.flip,
      ),
    )
    expect(up).toBeInstanceOf(KiloProfileUpstream)
    const bad = await Effect.runPromise(
      fetchKiloProfileData({
        fetchProfile: async () => ({ email: 1 }),
        fetchBalance: async () => null,
        fetchKiloPassState: async () => null,
      }).pipe(
        Effect.provide(authLayer({ type: "oauth", refresh: "r", access: "a", expires: 1 })),
        Effect.flip,
      ),
    )
    expect(bad).toBeInstanceOf(KiloProfileInternal)
  })

  it("private handler maps unauthorized/upstream/validation strictly (no drain/InstanceRef)", async () => {
    const bad = (await Effect.runPromise(
      kiloProfilePrivate({ v: 1 }).pipe(Effect.provide(authLayer(undefined))),
    )) as {
      status: string
      failure: { code: string; retryable: boolean }
    }
    expect(bad.status).toBe("failed")
    expect(bad.failure.code).toBe("validation.failed")
    expect(bad.failure.retryable).toBe(false)
  })
})
