import { describe, expect, test } from "bun:test"
import {
  attemptConfigUiDefaultsPrivate,
  buildConfigUiDefaultsReq,
  fetchConfigUiDefaultsPrivateFirst,
  parseConfigUiDefaultsResult,
  projectUiDefaultsFromSdk,
  requireUiDefaults,
  toWorkStyleConfig,
} from "./config-ui-defaults-privatefirst"
import { buildWorkStyleApplyPlan, hasPermissionConfig } from "./work-style-presets"

function uiData(overrides: Record<string, unknown> = {}) {
  return {
    workStyle: { hasPermission: false },
    sandbox: { enabled: false },
    ...overrides,
  }
}

function req() {
  return buildConfigUiDefaultsReq("/tmp/ui-defaults")
}

function okFor(r: ReturnType<typeof req>, d: unknown = uiData()) {
  return { v: 1, requestId: r.requestId, op: "config/ui-defaults", status: "succeeded", outcome: { type: "succeeded", time: 1 }, accepted: true, data: d }
}

function failedFor(r: ReturnType<typeof req>, code: string, message: string, retryable: boolean) {
  const failure = { code, message, retryable }
  return { v: 1, requestId: r.requestId, op: "config/ui-defaults", status: "failed", outcome: { type: "failed", time: 1, failure }, accepted: false, failure }
}

function ambiguousFor(r: ReturnType<typeof req>) {
  return { v: 1, requestId: r.requestId, op: "config/ui-defaults", status: "ambiguous", outcome: { type: "ambiguous", time: 1 }, accepted: false, transportUnknown: true }
}

function connFor(result: (q: ReturnType<typeof req>) => unknown, id = 1) {
  return {
    isPrivateAvailable: () => true,
    privateConfigUiDefaultsOutcomeWithHandle: (q: ReturnType<typeof req>) => ({ id, promise: Promise.resolve({ kind: "valid", result: result(q) }), cancel: () => true }),
  }
}

describe("config-ui-defaults private-first", () => {
  test("success returns private with zero SDK", async () => {
    const out = await fetchConfigUiDefaultsPrivateFirst({
      connection: connFor((q) => okFor(q)) as never,
      client: { config: { get: async () => { throw new Error("must not call SDK") } } } as never,
      directory: "/tmp/ui-defaults",
    })
    expect(out.kind).toBe("ok")
    if (out.kind === "ok") {
      expect(out.via).toBe("private")
      expect(out.data).toEqual(uiData())
    }
  })

  test("terminal closes with zero SDK", async () => {
    let sdk = 0
    const out = await fetchConfigUiDefaultsPrivateFirst({
      connection: connFor((q) => failedFor(q, "validation.failed", "invalid config-ui-defaults request", false)) as never,
      client: { config: { get: async () => { sdk += 1; return { data: uiData() } } } } as never,
      directory: "/tmp/ui-defaults",
    })
    expect(out.kind).toBe("terminal")
    expect(sdk).toBe(0)
  })

  test("retryable/invalid/ambiguous/transport/timeout take exactly one SDK fallback", async () => {
    for (const maker of [
      (q: ReturnType<typeof req>) => failedFor(q, "InstanceUnavailableDuringConfigRebuild", "Instance is unavailable during config rebuild; no active runtime for this request", true),
      (q: ReturnType<typeof req>) => ambiguousFor(q),
      (_q: ReturnType<typeof req>) => ({ v: 1, bad: true }),
    ]) {
      let sdk = 0
      const out = await fetchConfigUiDefaultsPrivateFirst({
        connection: connFor(maker as never) as never,
        client: { config: { get: async () => { sdk += 1; return { data: { sandbox: { enabled: true } } } } } } as never,
        directory: "/tmp/ui-defaults",
      })
      expect(out.kind).toBe("ok")
      if (out.kind === "ok") {
        expect(out.via).toBe("sdk")
        expect(out.data.sandbox.enabled).toBe(true)
      }
      expect(sdk).toBe(1)
    }
  })

  test("unavailable private takes exactly one SDK fallback", async () => {
    let sdk = 0
    const out = await fetchConfigUiDefaultsPrivateFirst({
      connection: { isPrivateAvailable: () => false } as never,
      client: { config: { get: async () => { sdk += 1; return { data: {} } } } } as never,
      directory: "/tmp/ui-defaults",
    })
    expect(out.kind).toBe("ok")
    if (out.kind === "ok") expect(out.via).toBe("sdk")
    expect(sdk).toBe(1)
  })

  test("timeout exact-cancels and falls back once", async () => {
    const r = buildConfigUiDefaultsReq("/tmp/ui-defaults")
    let cancelled = 0
    const conn = {
      isPrivateAvailable: () => true,
      privateConfigUiDefaultsOutcomeWithHandle: () => ({ id: 9, promise: new Promise(() => {}), cancel: () => { cancelled += 1; return true } }),
    }
    const attempt = await attemptConfigUiDefaultsPrivate(conn as never, r, 10)
    expect(attempt.kind).toBe("fallback")
    expect(attempt.kind === "fallback" ? attempt.reason : "").toBe("timeout")
    expect(cancelled).toBe(1)
  })

  test("SDK fallback projects locally to the same closed shape", async () => {
    const out = await fetchConfigUiDefaultsPrivateFirst({
      connection: { isPrivateAvailable: () => false } as never,
      client: {
        config: {
          get: async () => ({
            data: {
              permission: { edit: "ask", bash: { "*": "ask" } },
              terminal_command_display: "collapsed",
              auto_collapse_reasoning: true,
              sandbox: { enabled: true, network: "allow" },
              provider: { openai: { key: "sk-live" } },
              mcp: { local: {} },
            },
          }),
        },
      } as never,
      directory: "/tmp/ui-defaults",
    })
    expect(out.kind).toBe("ok")
    if (out.kind === "ok") {
      expect(out.via).toBe("sdk")
      expect(out.data).toEqual({
        workStyle: { hasPermission: true, terminalCommandDisplay: "collapsed", autoCollapseReasoning: true },
        sandbox: { enabled: true },
      })
      expect(JSON.stringify(out.data)).not.toContain("sk-live")
    }
  })

  test("SDK absent-permission reads hasPermission false; explicit false/collapsed preserved", async () => {
    const out = await fetchConfigUiDefaultsPrivateFirst({
      connection: { isPrivateAvailable: () => false } as never,
      client: {
        config: {
          get: async () => ({ data: { terminal_command_display: "collapsed", auto_collapse_reasoning: false } }),
        },
      } as never,
      directory: "/tmp/ui-defaults",
    })
    expect(out.kind).toBe("ok")
    if (out.kind === "ok") {
      expect(out.data).toEqual({
        workStyle: { hasPermission: false, terminalCommandDisplay: "collapsed", autoCollapseReasoning: false },
        sandbox: { enabled: false },
      })
    }
  })

  test("missing SDK method or malformed SDK payload degrades to unavailable", async () => {
    const missing = await fetchConfigUiDefaultsPrivateFirst({
      connection: { isPrivateAvailable: () => false } as never,
      client: { config: {} } as never,
      directory: "/tmp/ui-defaults",
    })
    expect(missing.kind).toBe("unavailable")
    const malformed = await fetchConfigUiDefaultsPrivateFirst({
      connection: { isPrivateAvailable: () => false } as never,
      client: { config: { get: async () => ({ data: { terminal_command_display: "sideways" } }) } } as never,
      directory: "/tmp/ui-defaults",
    })
    expect(malformed.kind).toBe("unavailable")
    const thrown = await fetchConfigUiDefaultsPrivateFirst({
      connection: { isPrivateAvailable: () => false } as never,
      client: { config: { get: async () => { throw new Error("http down") } } } as never,
      directory: "/tmp/ui-defaults",
    })
    expect(thrown.kind).toBe("unavailable")
  })

  test("parse maps settled-first correctly", () => {
    const r = req()
    expect(parseConfigUiDefaultsResult(okFor(r), r).kind).toBe("ok")
    expect(parseConfigUiDefaultsResult(failedFor(r, "validation.failed", "invalid config-ui-defaults request", false), r).kind).toBe("terminal")
    expect(
      parseConfigUiDefaultsResult(
        failedFor(r, "InstanceUnavailableDuringConfigRebuild", "Instance is unavailable during config rebuild; no active runtime for this request", true),
        r,
      ).kind,
    ).toBe("fallback")
    expect(parseConfigUiDefaultsResult(ambiguousFor(r), r).kind).toBe("fallback")
    expect(parseConfigUiDefaultsResult({ v: 1, bad: true }, r).kind).toBe("fallback")
  })

  test("requireUiDefaults preserves throw propagation", () => {
    expect(requireUiDefaults({ kind: "ok", data: uiData(), via: "private" }, "sandbox default").sandbox.enabled).toBe(false)
    expect(() => requireUiDefaults({ kind: "terminal", code: "internal" }, "sandbox default")).toThrow("sandbox default unavailable: internal")
    expect(() => requireUiDefaults({ kind: "unavailable" }, "work-style config")).toThrow("work-style config unavailable")
    expect(() => requireUiDefaults({ kind: "unavailable", cause: new Error("http down") }, "work-style config")).toThrow("http down")
  })

  test("projectUiDefaultsFromSdk never carries secret content", () => {
    const projected = projectUiDefaultsFromSdk({
      permission: { edit: "allow" },
      provider: { openai: { key: "sk-live" } },
      mcp: { local: { token: "mcp-secret" } },
      terminal_command_display: "expanded",
    })
    expect(projected?.workStyle.hasPermission).toBe(true)
    expect(JSON.stringify(projected)).not.toContain("allow")
    expect(JSON.stringify(projected)).not.toContain("sk-live")
    expect(JSON.stringify(projected)).not.toContain("mcp-secret")
    expect(projectUiDefaultsFromSdk({})?.workStyle.hasPermission).toBe(false)
    expect(projectUiDefaultsFromSdk(null)).toBeNull()
  })

  test("toWorkStyleConfig feeds the untouched plan builder with identical decisions", () => {
    // Present permission suppresses the preset permission write.
    const present = toWorkStyleConfig({
      workStyle: { hasPermission: true, terminalCommandDisplay: "collapsed", autoCollapseReasoning: true },
      sandbox: { enabled: true },
    })
    expect(hasPermissionConfig(present)).toBe(true)
    const skipPlan = buildWorkStyleApplyPlan({ style: "human-in-the-loop", config: present })
    expect(skipPlan.config.permission).toBeUndefined()
    expect(skipPlan.config.terminal_command_display).toBeUndefined()
    expect(skipPlan.config.auto_collapse_reasoning).toBeUndefined()
    // Absent permission plus unset scalars fill from the preset.
    const absent = toWorkStyleConfig({ workStyle: { hasPermission: false }, sandbox: { enabled: false } })
    expect(hasPermissionConfig(absent)).toBe(false)
    const fillPlan = buildWorkStyleApplyPlan({ style: "human-in-the-loop", config: absent })
    expect(fillPlan.config.permission).toBeDefined()
    expect(fillPlan.config.terminal_command_display).toBe("expanded")
    expect(fillPlan.config.auto_collapse_reasoning).toBe(false)
  })
})
