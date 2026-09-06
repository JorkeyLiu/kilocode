import { describe, expect, test } from "bun:test"
import {
  deferredProjectCurrentKey,
  observeProjectCurrentParityDetached,
  sdkProjectCurrentHasTerminal,
  type ProjectCurrentParityConnection,
} from "./kilo-provider/project-current-parity"
import { hasGit, setProjectCurrentParityConnection } from "./kilo-provider/git-status"

function validResult(req: Record<string, unknown>, data: unknown) {
  return {
    v: 1,
    requestId: (req as { requestId: string }).requestId,
    opId: (req as { opId: string }).opId,
    op: "project/current",
    idempotencyKey: (req as { idempotencyKey: string }).idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data,
  }
}

describe("project-current parity wiring (hasGit narrowest consumer)", () => {
  test("hasGit preserves SDK semantics: git true, absent false, error false", async () => {
    const git = { project: { current: async () => ({ data: { vcs: "git" } }) } }
    expect(await hasGit(git as never, "/tmp")).toBeTrue()
    const nogit = { project: { current: async () => ({ data: {} }) } }
    expect(await hasGit(nogit as never, "/tmp")).toBeFalse()
    const other = { project: { current: async () => ({ data: { vcs: "hg" } }) } }
    expect(await hasGit(other as never, "/tmp")).toBeFalse()
    const failing = {
      project: {
        current: async () => {
          throw new Error("boom")
        },
      },
    }
    expect(await hasGit(failing as never, "/tmp")).toBeFalse()
  })

  test("terminal gate admits settled record data and terminal failures only", () => {
    expect(sdkProjectCurrentHasTerminal({ data: { vcs: "git" } } as never)).toBeTrue()
    expect(sdkProjectCurrentHasTerminal({ data: {}, response: { status: 200 } } as never)).toBeTrue()
    expect(sdkProjectCurrentHasTerminal({ data: [] } as never)).toBeFalse()
    expect(sdkProjectCurrentHasTerminal({ error: { status: 500 }, response: { status: 500 } } as never)).toBeTrue()
    expect(sdkProjectCurrentHasTerminal({ error: { message: "boom" } } as never)).toBeFalse()
    expect(sdkProjectCurrentHasTerminal({} as never)).toBeFalse()
  })

  test("detached observer preserves SDK return and never throws", async () => {
    let calls = 0
    const conn = {
      isPrivateAvailable: () => true,
      privateProjectCurrentOutcomeWithHandle: (req: Record<string, unknown>) => {
        calls += 1
        expect((req as Record<string, unknown>).op).toBe("project/current")
        return {
          id: 3,
          promise: Promise.resolve({ kind: "valid", result: validResult(req, { vcs: "git" }) }),
          cancel: () => true,
        }
      },
    } as unknown as ProjectCurrentParityConnection
    const sdk = { data: { vcs: "git" }, response: { status: 200 } }
    let ret: unknown
    expect(() => {
      ret = observeProjectCurrentParityDetached(conn, sdk as never, "/tmp")
    }).not.toThrow()
    expect(ret).toBeUndefined()
    expect(calls).toBe(1)
    await new Promise((r) => setTimeout(r, 25))
    expect(sdk.data).toEqual({ vcs: "git" })
  })

  test("non-terminal SDK never touches the private transport", () => {
    const conn = {
      isPrivateAvailable: () => {
        throw new Error("must not check availability for non-terminal SDK")
      },
      privateProjectCurrentOutcomeWithHandle: () => {
        throw new Error("must not call private transport for non-terminal SDK")
      },
    } as unknown as ProjectCurrentParityConnection
    expect(() =>
      observeProjectCurrentParityDetached(conn, { error: { message: "boom" } } as never, "/tmp"),
    ).not.toThrow()
    expect(() => observeProjectCurrentParityDetached(conn, {} as never, "/tmp")).not.toThrow()
    expect(() => observeProjectCurrentParityDetached(conn, { data: { vcs: "git" } } as never, "")).not.toThrow()
  })

  test("terminal SDK error/response reaches the observer without mutating SDK state", async () => {
    let calls = 0
    const conn = {
      isPrivateAvailable: () => true,
      privateProjectCurrentOutcomeWithHandle: (req: Record<string, unknown>) => {
        calls += 1
        return {
          id: 9,
          promise: Promise.resolve({
            kind: "valid",
            result: {
              v: 1,
              requestId: (req as { requestId: string }).requestId,
              opId: (req as { opId: string }).opId,
              op: "project/current",
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
    } as unknown as ProjectCurrentParityConnection
    // Terminal failure via error+response gates the observer (not skipped).
    const sdk = { error: { status: 500 }, response: { status: 500 } }
    const before = JSON.stringify(sdk)
    observeProjectCurrentParityDetached(conn, sdk as never, "/tmp")
    await new Promise((r) => setTimeout(r, 25))
    expect(calls).toBe(1)
    expect(JSON.stringify(sdk)).toBe(before)
  })

  test("settled SDK error is forwarded so failed-vs-failed holds", async () => {
    const conn = {
      isPrivateAvailable: () => true,
      privateProjectCurrentOutcomeWithHandle: (req: Record<string, unknown>) => ({
        id: 9,
        promise: Promise.resolve({
          kind: "valid",
          result: {
            v: 1,
            requestId: (req as { requestId: string }).requestId,
            opId: (req as { opId: string }).opId,
            op: "project/current",
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
    } as unknown as ProjectCurrentParityConnection
    // With error forwarded, a failed private result agrees (no divergence).
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const sdkWithError = { data: {}, error: { status: 500 }, response: { status: 500 } }
      observeProjectCurrentParityDetached(conn, sdkWithError as never, "/tmp")
      await new Promise((r) => setTimeout(r, 25))
      expect(warns.filter((w) => String(w[0]).includes("divergence"))).toHaveLength(0)
    } finally {
      console.warn = origWarn
    }
  })

  test("hasGit mismatch on equal hasGit agrees without divergence", async () => {
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const conn = {
        isPrivateAvailable: () => true,
        privateProjectCurrentOutcomeWithHandle: (req: Record<string, unknown>) => ({
          id: 4,
          promise: Promise.resolve({ kind: "valid", result: validResult(req, {}) }),
          cancel: () => true,
        }),
      } as unknown as ProjectCurrentParityConnection
      observeProjectCurrentParityDetached(conn, { data: {} } as never, "/tmp")
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
      privateProjectCurrentOutcomeWithHandle: () => {
        calls += 1
        return { id: 1, promise: Promise.resolve({ kind: "invalid", detail: "x" }), cancel: () => true }
      },
    } as unknown as ProjectCurrentParityConnection
    observeProjectCurrentParityDetached(conn, { data: { vcs: "git" } } as never, "/tmp")
    expect(listener).not.toBeNull()
    // Backend replaced before negotiation completes: deferred fire must skip.
    epoch = 12
    listener!()
    await new Promise((r) => setTimeout(r, 25))
    expect(calls).toBe(0)
  })

  test("fallback deferred key is opaque and collision-safe across tuples", () => {
    const a = deferredProjectCurrentKey(9, "/tmp/alpha", undefined)
    const b = deferredProjectCurrentKey(9, "/tmp/beta", undefined)
    const c = deferredProjectCurrentKey(9, "/tmp/alpha", "ws-one")
    const d = deferredProjectCurrentKey(9, "/tmp/alpha", "ws-two")
    const e = deferredProjectCurrentKey(10, "/tmp/alpha", undefined)
    expect(new Set([a, b, c, d, e]).size).toBe(5)
    for (const k of [a, b, c, d, e]) {
      expect(k.startsWith("project-current:")).toBeTrue()
      expect(k).not.toContain("/tmp/alpha")
      expect(k).not.toContain("/tmp/beta")
      expect(k).not.toContain("ws-one")
      expect(k).not.toContain("ws-two")
    }
    expect(deferredProjectCurrentKey(9, "/tmp:alpha", undefined)).not.toBe(
      deferredProjectCurrentKey(9, "/tmp", "alpha"),
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
      privateProjectCurrentOutcomeWithHandle: () => {
        throw new Error("must not call while unavailable")
      },
    } as unknown as ProjectCurrentParityConnection
    const sdk = { data: { vcs: "git" } }
    expect(() => observeProjectCurrentParityDetached(conn, sdk as never, "/tmp")).not.toThrow()
    expect(seen.length).toBe(1)
    expect(sdk.data).toEqual({ vcs: "git" })
  })

  test("hasGit observes through the boundary and detaches on null", async () => {
    let calls = 0
    const conn = {
      isPrivateAvailable: () => true,
      privateProjectCurrentOutcomeWithHandle: (req: Record<string, unknown>) => {
        calls += 1
        return {
          id: 5,
          promise: Promise.resolve({ kind: "valid", result: validResult(req, { vcs: "git" }) }),
          cancel: () => true,
        }
      },
    } as unknown as ProjectCurrentParityConnection
    setProjectCurrentParityConnection(conn)
    try {
      const client = { project: { current: async () => ({ data: { vcs: "git" } }) } }
      expect(await hasGit(client as never, "/tmp")).toBeTrue()
      await new Promise((r) => setTimeout(r, 25))
      expect(calls).toBe(1)
    } finally {
      setProjectCurrentParityConnection(null)
    }
    // Detached: no connection, no work, no throw, SDK semantics preserved.
    const bare = { project: { current: async () => ({ data: { vcs: "git" } }) } }
    expect(await hasGit(bare as never, "/tmp")).toBeTrue()
    const failing = {
      project: {
        current: async () => {
          throw new Error("boom")
        },
      },
    }
    expect(await hasGit(failing as never, "/tmp")).toBeFalse()
  })
})
