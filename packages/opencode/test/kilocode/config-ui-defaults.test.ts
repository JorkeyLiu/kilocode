import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect } from "effect"
import {
  configUiDefaultsPrivate,
  fetchUiDefaultsData,
  projectUiDefaults,
  validateConfigUiDefaultsRequest,
  validateConfigUiDefaultsResult,
  validateUiDefaultsData,
  isSettledConfigUiDefaultsResult,
} from "../../src/kilocode/config-ui-defaults"
import { TestConfig } from "../fixture/config"

async function repoText(rel: string) {
  return Bun.file(path.join(import.meta.dir, rel)).text()
}

function req(overrides: Record<string, unknown> = {}) {
  return {
    v: 1 as const,
    requestId: "req-ui-defaults-1",
    op: "config/ui-defaults" as const,
    context: { directory: "/tmp/ui-defaults" },
    payload: {},
    ...overrides,
  }
}

function data(overrides: Record<string, unknown> = {}) {
  return {
    workStyle: { hasPermission: false },
    sandbox: { enabled: false },
    ...overrides,
  }
}

function okFor(r: ReturnType<typeof req>, d: unknown = data()) {
  return {
    v: 1,
    requestId: r.requestId,
    op: "config/ui-defaults",
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: d,
  }
}

function failedFor(r: ReturnType<typeof req>, code: string, message: string, retryable: boolean) {
  const failure = { code, message, retryable }
  return {
    v: 1,
    requestId: r.requestId,
    op: "config/ui-defaults",
    status: "failed",
    outcome: { type: "failed", time: 1, failure },
    accepted: false,
    failure,
  }
}

describe("config/ui-defaults projection", () => {
  test("defaults: no permission, no scalars, sandbox disabled", () => {
    expect(projectUiDefaults({})).toEqual({
      workStyle: { hasPermission: false },
      sandbox: { enabled: false },
    })
  })

  test("explicit scalars pass through; explicit false stays false", () => {
    expect(
      projectUiDefaults({ terminal_command_display: "collapsed", auto_collapse_reasoning: false, sandbox: {} }),
    ).toEqual({
      workStyle: { hasPermission: false, terminalCommandDisplay: "collapsed", autoCollapseReasoning: false },
      sandbox: { enabled: false },
    })
    expect(projectUiDefaults({ terminal_command_display: "expanded", auto_collapse_reasoning: true })).toEqual({
      workStyle: { hasPermission: false, terminalCommandDisplay: "expanded", autoCollapseReasoning: true },
      sandbox: { enabled: false },
    })
  })

  test("hasPermission is presence-only: empty object and full rulesets are both true", () => {
    expect(projectUiDefaults({ permission: {} }).workStyle.hasPermission).toBe(true)
    expect(projectUiDefaults({ permission: { edit: "ask" } }).workStyle.hasPermission).toBe(true)
    expect(
      projectUiDefaults({ permission: { "*": "ask", bash: { "*": "ask", "cat *": "allow" } } }).workStyle
        .hasPermission,
    ).toBe(true)
    expect(projectUiDefaults({}).workStyle.hasPermission).toBe(false)
  })

  test("sandbox reads strictly enabled === true", () => {
    expect(projectUiDefaults({ sandbox: { enabled: true } }).sandbox).toEqual({ enabled: true })
    expect(projectUiDefaults({ sandbox: { enabled: false } }).sandbox).toEqual({ enabled: false })
    expect(projectUiDefaults({ sandbox: {} }).sandbox).toEqual({ enabled: false })
    expect(projectUiDefaults({ sandbox: { enabled: 1 as never } }).sandbox).toEqual({ enabled: false })
  })

  test("malformed whitelisted scalars fail closed", () => {
    expect(() => projectUiDefaults({ terminal_command_display: "huge" })).toThrow()
    expect(() => projectUiDefaults({ auto_collapse_reasoning: "yes" as never })).toThrow()
  })
})

describe("config/ui-defaults closed validation", () => {
  test("minimal and full shapes validate", () => {
    const r = req()
    expect(() => validateConfigUiDefaultsResult(okFor(r), r)).not.toThrow()
    expect(() =>
      validateConfigUiDefaultsResult(
        okFor(r, {
          workStyle: { hasPermission: true, terminalCommandDisplay: "collapsed", autoCollapseReasoning: true },
          sandbox: { enabled: true },
        }),
        r,
      ),
    ).not.toThrow()
    expect(() => validateUiDefaultsData(data())).not.toThrow()
  })

  test("secret and unknown fields are rejected fail-closed", () => {
    const secrets = [
      // Permission rule content must never cross, even though the source has it.
      { workStyle: { hasPermission: true, permission: { edit: "allow" } }, sandbox: { enabled: false } },
      { workStyle: { hasPermission: false }, sandbox: { enabled: false }, permission: { edit: "ask" } },
      { workStyle: { hasPermission: false }, sandbox: { enabled: false }, provider: { openai: {} } },
      { workStyle: { hasPermission: false }, sandbox: { enabled: false }, mcp: {} },
      { workStyle: { hasPermission: false }, sandbox: { enabled: false }, apiKey: "sk-live" },
      { workStyle: { hasPermission: false }, sandbox: { enabled: false }, options: {}, headers: {} },
      { workStyle: { hasPermission: false, terminalCommandDisplay: "sideways" }, sandbox: { enabled: false } },
      { workStyle: { hasPermission: false }, sandbox: { enabled: "yes" } },
      { workStyle: { hasPermission: "yes" }, sandbox: { enabled: false } },
      { workStyle: { hasPermission: false, extra: 1 }, sandbox: { enabled: false } },
      { workStyle: { hasPermission: false }, sandbox: { enabled: false, network: "allow" } },
      { unknown: true },
    ]
    for (const d of secrets) {
      expect(() => validateUiDefaultsData(d), JSON.stringify(d)).toThrow()
    }
  })

  test("request is strict v1 requestId-only payload{}", () => {
    const r = req()
    expect(() => validateConfigUiDefaultsRequest(r)).not.toThrow()
    expect(() => validateConfigUiDefaultsRequest({ ...r, opId: "x" })).toThrow()
    expect(() => validateConfigUiDefaultsRequest({ ...r, idempotencyKey: "x" })).toThrow()
    expect(() => validateConfigUiDefaultsRequest({ ...r, context: { directory: "relative" } })).toThrow()
    expect(() => validateConfigUiDefaultsRequest({ ...r, payload: { q: 1 } })).toThrow()
    expect(() => validateConfigUiDefaultsRequest({ ...r, op: "provider/auth" })).toThrow()
    expect(() => validateConfigUiDefaultsRequest({ ...r, v: 2 })).toThrow()
  })

  test("result strictness: identity mismatch and cross-field leaks rejected", () => {
    const r = req()
    expect(() => validateConfigUiDefaultsResult({ ...okFor(r), requestId: "other" }, r)).toThrow()
    expect(() => validateConfigUiDefaultsResult({ ...okFor(r), op: "provider/auth" }, r)).toThrow()
    expect(() => validateConfigUiDefaultsResult({ ...okFor(r), extra: 1 }, r)).toThrow()
    expect(() =>
      validateConfigUiDefaultsResult(failedFor(r, "validation.failed", "invalid config-ui-defaults request", false), r),
    ).not.toThrow()
    // Backend failure taxonomy is loose (any non-empty code/message); the
    // strict fixed code/message/retryable mapping is enforced extension-side.
    expect(() => validateConfigUiDefaultsResult(failedFor(r, "nope", "invalid config-ui-defaults request", false), r)).not.toThrow()
    expect(() => validateConfigUiDefaultsResult(failedFor(r, "validation.failed", "other message", false), r)).not.toThrow()
    expect(isSettledConfigUiDefaultsResult(okFor(r), r)).toBe(true)
    expect(
      isSettledConfigUiDefaultsResult(
        failedFor(r, "validation.failed", "invalid config-ui-defaults request", false),
        r,
      ),
    ).toBe(true)
    expect(
      isSettledConfigUiDefaultsResult(
        failedFor(
          r,
          "InstanceUnavailableDuringConfigRebuild",
          "Instance is unavailable during config rebuild; no active runtime for this request",
          true,
        ),
        r,
      ),
    ).toBe(false)
  })
})

describe("config/ui-defaults effective config read", () => {
  test("fetchUiDefaultsData projects the merged effective config and strips secrets", async () => {
    const permissionToken = "UIDEFAULTS-SECRET-permission-rule-8f31"
    const providerToken = "UIDEFAULTS-SECRET-provider-key-4ab2"
    const mcpToken = "UIDEFAULTS-SECRET-mcp-token-77cc"
    const effective = {
      permission: { edit: permissionToken },
      terminal_command_display: "collapsed",
      auto_collapse_reasoning: true,
      sandbox: { enabled: true, network: "allow", writable_paths: ["/tmp"] },
      provider: { openai: { key: providerToken } },
      mcp: { local: { token: mcpToken } },
    }
    const out = await Effect.runPromise(
      fetchUiDefaultsData().pipe(Effect.provide(TestConfig.layer({ get: () => Effect.succeed(effective as never) }))),
    )
    expect(out).toEqual({
      workStyle: { hasPermission: true, terminalCommandDisplay: "collapsed", autoCollapseReasoning: true },
      sandbox: { enabled: true },
    })
    const wire = JSON.stringify(out)
    expect(wire).not.toContain(permissionToken)
    expect(wire).not.toContain(providerToken)
    expect(wire).not.toContain(mcpToken)
  })

  test("fetchUiDefaultsData defaults on an empty effective config", async () => {
    const out = await Effect.runPromise(
      fetchUiDefaultsData().pipe(Effect.provide(TestConfig.layer({ get: () => Effect.succeed({}) }))),
    )
    expect(out).toEqual({ workStyle: { hasPermission: false }, sandbox: { enabled: false } })
  })

  test("configUiDefaultsPrivate rejects malformed requests without touching the lane", async () => {
    // Malformed requests fail before any service is touched; the lane
    // requirements never resolve, so the early return is awaited unprovided.
    const out = (await Effect.runPromise(
      configUiDefaultsPrivate({ v: 1, requestId: "req-bad", op: "config/ui-defaults", context: { directory: "/tmp" }, payload: { q: 1 } }) as unknown as Effect.Effect<
        { status: string; failure: { code: string; message: string; retryable: boolean }; data?: unknown },
        never,
        never
      >,
    ))
    expect(out.status).toBe("failed")
    if (out.status === "failed") {
      expect(out.failure.code).toBe("validation.failed")
      expect(out.failure.message).toBe("invalid config-ui-defaults request")
      expect(out.failure.retryable).toBe(false)
      expect((out as { data?: unknown }).data).toBeUndefined()
    }
  })
})

describe("config/ui-defaults shared owner parity", () => {
  test("fd reuses the shared fetch; same lane, no new mechanism", async () => {
    const carrier = await repoText("../../src/kilocode/server/fd-carrier.ts")
    expect(carrier).toContain("configUiDefaultsPrivate")
    expect(carrier).toContain("config/ui-defaults")
    const shared = await repoText("../../src/kilocode/config-ui-defaults.ts")
    expect(shared).toContain("fetchUiDefaultsData")
    expect(shared).toContain("Config.Service")
    expect(shared).toContain("acquireDrainControl")
    expect(shared).toContain("InstanceRef")
    expect(shared).not.toContain("global.config.update")
    expect(shared).not.toContain("Effect.acquireRelease")
  })
})
