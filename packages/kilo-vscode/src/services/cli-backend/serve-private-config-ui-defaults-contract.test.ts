import { describe, expect, test } from "bun:test"
import {
  makeConfigUiDefaultsAmbiguous,
  normalizePrivateConfigUiDefaultsWire,
  validateConfigUiDefaultsContractRequest,
  validateConfigUiDefaultsResult,
  validateUiDefaultsData,
} from "./serve-private-config-ui-defaults-contract"

function req() {
  return { v: 1 as const, requestId: "r-ui-defaults", op: "config/ui-defaults" as const, context: { directory: "/tmp" }, payload: {} }
}

function data(overrides: Record<string, unknown> = {}) {
  return {
    workStyle: { hasPermission: false, permissionPreset: "absent" },
    sandbox: { enabled: false },
    ...overrides,
  }
}

function ok(r: ReturnType<typeof req>, d: unknown = data()) {
  return { v: 1, requestId: r.requestId, op: "config/ui-defaults", status: "succeeded", outcome: { type: "succeeded", time: 1 }, accepted: true, data: d }
}

function failed(r: ReturnType<typeof req>, code: string, message: string, retryable: boolean) {
  const failure = { code, message, retryable }
  return { v: 1, requestId: r.requestId, op: "config/ui-defaults", status: "failed", outcome: { type: "failed", time: 1, failure }, accepted: false, failure }
}

describe("config-ui-defaults contract", () => {
  test("request strict: unknown fields rejected", () => {
    const r = req()
    expect(() => validateConfigUiDefaultsContractRequest(r)).not.toThrow()
    expect(() => validateConfigUiDefaultsContractRequest({ ...r, opId: "x" })).toThrow()
    expect(() => validateConfigUiDefaultsContractRequest({ ...r, context: { directory: "relative" } })).toThrow()
    expect(() => validateConfigUiDefaultsContractRequest({ ...r, payload: { q: 1 } })).toThrow()
    expect(() => validateConfigUiDefaultsContractRequest({ ...r, op: "provider/auth" })).toThrow()
  })

  test("minimal and full shapes validate", () => {
    const r = req()
    expect(() => validateConfigUiDefaultsResult(ok(r), r)).not.toThrow()
    expect(() =>
      validateConfigUiDefaultsResult(
        ok(r, {
          workStyle: { hasPermission: true, permissionPreset: "custom", terminalCommandDisplay: "collapsed", autoCollapseReasoning: true },
          sandbox: { enabled: true },
        }),
        r,
      ),
    ).not.toThrow()
    expect(() => validateUiDefaultsData(data())).not.toThrow()
    expect(() => validateUiDefaultsData(data({ workStyle: { hasPermission: true, permissionPreset: "custom" } }))).not.toThrow()
    expect(() =>
      validateUiDefaultsData(data({ workStyle: { hasPermission: true, permissionPreset: "review", permissionLevel: "review" } })),
    ).not.toThrow()
  })

  test("secret and unknown fields rejected fail-closed", () => {
    const r = req()
    const cases: unknown[] = [
      // Permission rule content must never cross, even beside a true presence bit.
      { workStyle: { hasPermission: true, permission: { edit: "allow" } }, sandbox: { enabled: false } },
      { workStyle: { hasPermission: false }, sandbox: { enabled: false }, permission: { edit: "ask" } },
      { workStyle: { hasPermission: false }, sandbox: { enabled: false }, provider: { openai: {} } },
      { workStyle: { hasPermission: false }, sandbox: { enabled: false }, mcp: {} },
      { workStyle: { hasPermission: false }, sandbox: { enabled: false }, apiKey: "sk-live" },
      { workStyle: { hasPermission: false }, sandbox: { enabled: false }, options: {}, headers: {} },
      { workStyle: { hasPermission: false, terminalCommandDisplay: "sideways" }, sandbox: { enabled: false } },
      { workStyle: { hasPermission: "yes" }, sandbox: { enabled: false } },
      { workStyle: { hasPermission: false, permissionPreset: "everything" }, sandbox: { enabled: false } },
      { workStyle: { hasPermission: false, extra: 1 }, sandbox: { enabled: false } },
      { workStyle: { hasPermission: false }, sandbox: { enabled: false, network: "allow" } },
      { workStyle: { hasPermission: false }, sandbox: { enabled: "yes" } },
      { unknown: true },
    ]
    for (const bad of cases) {
      expect(() => validateUiDefaultsData(bad)).toThrow()
      expect(normalizePrivateConfigUiDefaultsWire(ok(r, bad), r).kind).toBe("invalid")
    }
  })

  test("strict result schema", () => {
    const r = req()
    expect(() => validateConfigUiDefaultsResult({ ...ok(r), extra: 1 }, r)).toThrow()
    expect(normalizePrivateConfigUiDefaultsWire({ v: 1, bad: true }, r).kind).toBe("invalid")
    expect(normalizePrivateConfigUiDefaultsWire(ok(r), { ...r, requestId: "other" } as never).kind).toBe("invalid")
  })

  test("failure taxonomy fixed messages", () => {
    const r = req()
    const terminal = failed(r, "validation.failed", "invalid config-ui-defaults request", false)
    expect(() => validateConfigUiDefaultsResult(terminal, r)).not.toThrow()
    const fence = failed(r, "InstanceUnavailableDuringConfigRebuild", "Instance is unavailable during config rebuild; no active runtime for this request", true)
    expect(() => validateConfigUiDefaultsResult(fence, r)).not.toThrow()
    const badMsg = failed(r, "validation.failed", "wrong", false)
    expect(() => validateConfigUiDefaultsResult(badMsg, r)).toThrow()
    const badCode = failed(r, "nope", "internal error", false)
    expect(() => validateConfigUiDefaultsResult(badCode, r)).toThrow()
    expect(makeConfigUiDefaultsAmbiguous(r).status).toBe("ambiguous")
  })
})
