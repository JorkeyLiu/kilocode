import { describe, expect, test } from "bun:test"
import {
  deferredConfigWarningsKey,
  observeConfigWarningsParityDetached,
  sdkConfigWarningsHasTerminal,
  type ConfigWarningsParityConnection,
} from "./kilo-provider/config-warnings-parity"
import { observeConfigWarningsParity, setConfigWarningsParityConnection } from "./kilo-provider/config-warnings"

function rawWarning(path: string, message: string) {
  return { path, message }
}

function safeEntry(pathCategory = "agent-file", messageCategory = "invalid-file") {
  return { pathCategory, messageCategory }
}

function validResult(req: Record<string, unknown>, warnings: unknown[]) {
  return {
    v: 1,
    requestId: (req as { requestId: string }).requestId,
    opId: (req as { opId: string }).opId,
    op: "config/warnings",
    idempotencyKey: (req as { idempotencyKey: string }).idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { warnings },
  }
}

describe("config-warnings parity wiring (checkConfigWarnings narrowest consumer)", () => {
  test("terminal gate admits settled SDK arrays and terminal failures only", () => {
    expect(sdkConfigWarningsHasTerminal({ data: [rawWarning("/p", "m")] } as never)).toBeTrue()
    expect(
      sdkConfigWarningsHasTerminal({ data: [rawWarning("/p", "m")], response: { status: 200 } } as never),
    ).toBeTrue()
    expect(sdkConfigWarningsHasTerminal({ data: {} } as never)).toBeFalse()
    expect(sdkConfigWarningsHasTerminal({ error: { status: 500 }, response: { status: 500 } } as never)).toBeTrue()
    expect(sdkConfigWarningsHasTerminal({ error: { message: "boom" } } as never)).toBeFalse()
    expect(sdkConfigWarningsHasTerminal({} as never)).toBeFalse()
  })

  test("detached observer preserves SDK return and never throws", async () => {
    let calls = 0
    const conn = {
      isPrivateAvailable: () => true,
      privateConfigWarningsOutcomeWithHandle: (req: Record<string, unknown>) => {
        calls += 1
        expect((req as Record<string, unknown>).op).toBe("config/warnings")
        return {
          id: 3,
          promise: Promise.resolve({ kind: "valid", result: validResult(req, [safeEntry()]) }),
          cancel: () => true,
        }
      },
    } as unknown as ConfigWarningsParityConnection
    const sdk = {
      data: [rawWarning("/w/agent/a.md", "Config file at /w/agent/a.md is invalid: bad")],
      response: { status: 200 },
    }
    let ret: unknown
    expect(() => {
      ret = observeConfigWarningsParityDetached(conn, sdk as never, "/tmp")
    }).not.toThrow()
    expect(ret).toBeUndefined()
    expect(calls).toBe(1)
    await new Promise((r) => setTimeout(r, 25))
    expect(sdk.data).toEqual([rawWarning("/w/agent/a.md", "Config file at /w/agent/a.md is invalid: bad")])
  })

  test("non-terminal SDK never touches the private transport", () => {
    const conn = {
      isPrivateAvailable: () => {
        throw new Error("must not check availability for non-terminal SDK")
      },
      privateConfigWarningsOutcomeWithHandle: () => {
        throw new Error("must not call private transport for non-terminal SDK")
      },
    } as unknown as ConfigWarningsParityConnection
    expect(() =>
      observeConfigWarningsParityDetached(conn, { error: { message: "boom" } } as never, "/tmp"),
    ).not.toThrow()
    expect(() => observeConfigWarningsParityDetached(conn, {} as never, "/tmp")).not.toThrow()
    expect(() =>
      observeConfigWarningsParityDetached(conn, { data: [rawWarning("/p", "m")] } as never, ""),
    ).not.toThrow()
  })

  test("terminal SDK error/response reaches the observer without mutating SDK state", async () => {
    let calls = 0
    const conn = {
      isPrivateAvailable: () => true,
      privateConfigWarningsOutcomeWithHandle: (req: Record<string, unknown>) => {
        calls += 1
        return {
          id: 9,
          promise: Promise.resolve({
            kind: "valid",
            result: {
              v: 1,
              requestId: (req as { requestId: string }).requestId,
              opId: (req as { opId: string }).opId,
              op: "config/warnings",
              idempotencyKey: (req as { idempotencyKey: string }).idempotencyKey,
              status: "failed",
              outcome: {
                type: "failed",
                time: 1,
                failure: { code: "internal", message: "internal error", retryable: false },
              },
              accepted: false,
              failure: { code: "internal", message: "internal error", retryable: false },
            },
          }),
          cancel: () => true,
        }
      },
    } as unknown as ConfigWarningsParityConnection
    // Terminal failure via error+response gates the observer (not skipped).
    const sdk = { error: { status: 500 }, response: { status: 500 } }
    const before = JSON.stringify(sdk)
    observeConfigWarningsParityDetached(conn, sdk as never, "/tmp")
    await new Promise((r) => setTimeout(r, 25))
    expect(calls).toBe(1)
    expect(JSON.stringify(sdk)).toBe(before)
  })

  test("settled SDK error is forwarded so failed-vs-failed holds (F-003)", async () => {
    const seen: Array<Record<string, unknown>> = []
    const conn = {
      isPrivateAvailable: () => true,
      privateConfigWarningsOutcomeWithHandle: (req: Record<string, unknown>) => ({
        id: 9,
        promise: Promise.resolve({
          kind: "valid",
          result: {
            v: 1,
            requestId: (req as { requestId: string }).requestId,
            opId: (req as { opId: string }).opId,
            op: "config/warnings",
            idempotencyKey: (req as { idempotencyKey: string }).idempotencyKey,
            status: "failed",
            outcome: {
              type: "failed",
              time: 1,
              failure: { code: "internal", message: "internal error", retryable: false },
            },
            accepted: false,
            failure: { code: "internal", message: "internal error", retryable: false },
          },
        }),
        cancel: () => true,
      }),
    } as unknown as ConfigWarningsParityConnection
    // Simulates KiloProvider success-path forwarding: list stays
    // `result.data ?? []` while the settled `error` field is passed through.
    // With error forwarded, a failed private result agrees (no divergence);
    // without it, the same private failure would status-mismatch.
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const sdkWithError = { data: [], error: { status: 500 }, response: { status: 500 } }
      observeConfigWarningsParityDetached(conn, sdkWithError as never, "/tmp")
      await new Promise((r) => setTimeout(r, 25))
      expect(warns.filter((w) => String(w[0]).includes("divergence"))).toHaveLength(0)
      void seen
    } finally {
      console.warn = origWarn
    }
  })

  test("duplicate-aware projected parity agrees on equal duplicates", async () => {
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const conn = {
        isPrivateAvailable: () => true,
        privateConfigWarningsOutcomeWithHandle: (req: Record<string, unknown>) => ({
          id: 4,
          promise: Promise.resolve({ kind: "valid", result: validResult(req, [safeEntry(), safeEntry()]) }),
          cancel: () => true,
        }),
      } as unknown as ConfigWarningsParityConnection
      const dup = rawWarning("/w/agent/a.md", "Config file at /w/agent/a.md is invalid: bad")
      observeConfigWarningsParityDetached(conn, { data: [dup, { ...dup }] } as never, "/tmp")
      await new Promise((r) => setTimeout(r, 25))
      expect(warns.filter((w) => String(w[0]).includes("divergence"))).toHaveLength(0)
    } finally {
      console.warn = origWarn
    }
  })

  test("stale deferred parity skipped when the epoch changes before availability", async () => {
    let calls = 0
    let epoch = 11
    let listener: (() => void) | null = null
    const conn = {
      isPrivateAvailable: () => false,
      onPrivateAvailable: (fn: () => void) => {
        listener = fn
        return () => {}
      },
      getPrivateEpoch: () => epoch,
      privateConfigWarningsOutcomeWithHandle: () => {
        calls += 1
        return { id: 1, promise: Promise.resolve({ kind: "invalid", detail: "x" }), cancel: () => true }
      },
    } as unknown as ConfigWarningsParityConnection
    observeConfigWarningsParityDetached(conn, { data: [rawWarning("/p", "m")] } as never, "/tmp")
    expect(listener).not.toBeNull()
    // Backend replaced before negotiation completes: deferred fire must skip.
    epoch = 12
    listener!()
    await new Promise((r) => setTimeout(r, 25))
    expect(calls).toBe(0)
  })

  test("fallback deferred key is opaque and collision-safe across tuples", () => {
    const a = deferredConfigWarningsKey(9, "/tmp/alpha", undefined)
    const b = deferredConfigWarningsKey(9, "/tmp/beta", undefined)
    const c = deferredConfigWarningsKey(9, "/tmp/alpha", "ws-one")
    const d = deferredConfigWarningsKey(9, "/tmp/alpha", "ws-two")
    const e = deferredConfigWarningsKey(10, "/tmp/alpha", undefined)
    expect(new Set([a, b, c, d, e]).size).toBe(5)
    for (const k of [a, b, c, d, e]) {
      expect(k.startsWith("config-warnings:")).toBeTrue()
      expect(k).not.toContain("/tmp/alpha")
      expect(k).not.toContain("/tmp/beta")
      expect(k).not.toContain("ws-one")
      expect(k).not.toContain("ws-two")
    }
    expect(deferredConfigWarningsKey(9, "/tmp:alpha", undefined)).not.toBe(
      deferredConfigWarningsKey(9, "/tmp", "alpha"),
    )
  })

  test("unavailable peer defers without throwing and stays SDK-authoritative", () => {
    const seen: Array<() => void> = []
    const conn = {
      isPrivateAvailable: () => false,
      onPrivateAvailable: (listener: () => void) => {
        seen.push(listener)
        return () => {}
      },
      getPrivateEpoch: () => 9,
      privateConfigWarningsOutcomeWithHandle: () => {
        throw new Error("must not call while unavailable")
      },
    } as unknown as ConfigWarningsParityConnection
    const sdk = { data: [rawWarning("/p", "m")] }
    expect(() => observeConfigWarningsParityDetached(conn, sdk as never, "/tmp")).not.toThrow()
    expect(seen.length).toBe(1)
    expect(sdk.data).toEqual([rawWarning("/p", "m")])
  })

  test("consumer boundary observes without mutating SDK input and detaches on null", async () => {
    let calls = 0
    const conn = {
      isPrivateAvailable: () => true,
      privateConfigWarningsOutcomeWithHandle: (req: Record<string, unknown>) => {
        calls += 1
        return {
          id: 5,
          promise: Promise.resolve({ kind: "valid", result: validResult(req, []) }),
          cancel: () => true,
        }
      },
    } as unknown as ConfigWarningsParityConnection
    setConfigWarningsParityConnection(conn)
    try {
      const sdk = { data: [rawWarning("/p", "m")] }
      observeConfigWarningsParity(sdk as never, "/tmp")
      await new Promise((r) => setTimeout(r, 25))
      expect(calls).toBe(1)
      expect(sdk.data).toEqual([rawWarning("/p", "m")])
    } finally {
      setConfigWarningsParityConnection(null)
    }
    // Detached: no connection, no work, no throw.
    let idle = 0
    const idleConn = {
      isPrivateAvailable: () => {
        idle += 1
        return false
      },
      privateConfigWarningsOutcomeWithHandle: () => {
        throw new Error("must not call after detach")
      },
    } as unknown as ConfigWarningsParityConnection
    void idleConn
    expect(() => observeConfigWarningsParity({ data: [] } as never, "/tmp")).not.toThrow()
    expect(idle).toBe(0)
  })
})
