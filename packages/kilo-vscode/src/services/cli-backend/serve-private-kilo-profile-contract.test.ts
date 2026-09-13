import { describe, expect, it } from "bun:test"
import {
  makeKiloProfileAmbiguous,
  normalizePrivateKiloProfileWire,
  validateKiloProfileContractRequest,
  validateKiloProfileData,
  validateKiloProfileResult,
} from "./serve-private-kilo-profile-contract"
import type { KiloProfileContractRequest } from "./serve-private-kilo-profile-contract"

function req(): KiloProfileContractRequest {
  return {
    v: 1,
    requestId: "req-1",
    op: "kilo/profile",
    context: { directory: "/tmp" },
    payload: {},
  }
}

function fullData() {
  return {
    profile: {
      email: "a@b.c",
      name: "n",
      organizations: [{ id: "o1", name: "O", role: "owner" }],
      selectedOrganizationId: "o1",
      hasPersonalAccount: true,
    },
    balance: { balance: 12.5 },
    kiloPass: {
      currentPeriodBaseCreditsUsd: 1,
      currentPeriodUsageUsd: 2,
      currentPeriodBonusCreditsUsd: 3,
      nextBillingAt: "2026-01-01",
    },
    currentOrgId: "o1",
  }
}

function minimalData() {
  return { profile: { email: "a@b.c" }, balance: null, kiloPass: null, currentOrgId: null }
}

function okResult(r: KiloProfileContractRequest, data: unknown) {
  return {
    v: 1,
    requestId: r.requestId,
    op: "kilo/profile",
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data,
  }
}

function failedResult(r: KiloProfileContractRequest, code: string, message: string, retryable: boolean) {
  const failure = { code, message, retryable }
  return {
    v: 1,
    requestId: r.requestId,
    op: "kilo/profile",
    status: "failed",
    outcome: { type: "failed", time: 1, failure },
    accepted: false,
    failure,
  }
}

describe("kilo/profile contract", () => {
  it("accepts minimal and full SDK-equivalent data", () => {
    expect(validateKiloProfileData(minimalData())).toEqual(minimalData())
    expect(validateKiloProfileData(fullData())).toEqual(fullData())
  })

  it("allows canonical empty strings for email and organization id/name/role", () => {
    const empty = {
      profile: { email: "", organizations: [{ id: "", name: "", role: "" }] },
      balance: null,
      kiloPass: null,
      currentOrgId: null,
    }
    expect(validateKiloProfileData(empty)).toEqual(empty)
    expect(() =>
      validateKiloProfileData({ profile: {}, balance: null, kiloPass: null, currentOrgId: null }),
    ).toThrow()
    expect(() =>
      validateKiloProfileData({
        profile: { email: "", organizations: [{ id: "", name: 1, role: "" }] },
        balance: null,
        kiloPass: null,
        currentOrgId: null,
      }),
    ).toThrow()
  })

  it("accepts null nextBillingAt and absent optionals", () => {
    const data = {
      profile: { email: "a@b.c" },
      balance: { balance: 0 },
      kiloPass: {
        currentPeriodBaseCreditsUsd: 0,
        currentPeriodUsageUsd: 0,
        currentPeriodBonusCreditsUsd: 0,
        nextBillingAt: null,
      },
      currentOrgId: null,
    }
    expect(validateKiloProfileData(data)).toEqual(data)
  })

  it("rejects unknown outer/data/profile fields and missing email", () => {
    const r = req()
    expect(() => validateKiloProfileContractRequest({ ...r, extra: 1 })).toThrow("unexpected field")
    expect(() => validateKiloProfileContractRequest({ ...r, opId: "x", idempotencyKey: "x" })).toThrow(
      "unexpected field",
    )
    expect(() => validateKiloProfileData({ ...minimalData(), extra: 1 })).toThrow("unexpected data field")
    expect(() =>
      validateKiloProfileData({ ...minimalData(), profile: { email: "a@b.c", extra: 1 } }),
    ).toThrow("unexpected profile field")
    expect(() => validateKiloProfileData({ ...minimalData(), profile: {} })).toThrow()
    expect(() =>
      validateKiloProfileData({
        ...minimalData(),
        profile: { email: "a@b.c", organizations: [{ id: "x", name: "y" }] },
      }),
    ).toThrow()
    expect(() => validateKiloProfileData({ ...minimalData(), balance: { balance: "x" } })).toThrow()
  })

  it("validates success and failure taxonomy with fixed messages", () => {
    const r = req()
    expect(validateKiloProfileResult(okResult(r, fullData()), r).status).toBe("succeeded")
    expect(
      validateKiloProfileResult(failedResult(r, "validation.failed", "invalid kilo-profile request", false), r).status,
    ).toBe("failed")
    expect(
      validateKiloProfileResult(failedResult(r, "unauthorized", "not authenticated with Kilo Gateway", false), r)
        .status,
    ).toBe("failed")
    expect(validateKiloProfileResult(failedResult(r, "upstream", "kilo gateway upstream failed", true), r).status).toBe(
      "failed",
    )
    expect(validateKiloProfileResult(failedResult(r, "internal", "internal error", false), r).status).toBe("failed")
    // Wrong retryable/message for a code is invalid wire.
    expect(
      normalizePrivateKiloProfileWire(failedResult(r, "upstream", "kilo gateway upstream failed", false), r).kind,
    ).toBe("invalid")
    expect(normalizePrivateKiloProfileWire(failedResult(r, "nope", "x", false), r).kind).toBe("invalid")
  })

  it("rejects unknown outer result fields and echoes requestId", () => {
    const r = req()
    expect(normalizePrivateKiloProfileWire({ ...okResult(r, minimalData()), extra: 1 }, r).kind).toBe("invalid")
    expect(normalizePrivateKiloProfileWire({ ...okResult(r, minimalData()), requestId: "other" }, r).kind).toBe(
      "invalid",
    )
    expect(makeKiloProfileAmbiguous(r, true).status).toBe("ambiguous")
  })

  it("requires absolute directory and empty payload", () => {
    const r = req()
    expect(() =>
      validateKiloProfileContractRequest({ ...r, context: { directory: "relative" } }),
    ).toThrow()
    expect(() => validateKiloProfileContractRequest({ ...r, payload: { x: 1 } })).toThrow()
  })
})
