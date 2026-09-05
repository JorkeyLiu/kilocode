import { describe, expect, test } from "bun:test"
import {
  deferredPathKey,
  observePathParityDetached,
  sdkPathHasTerminal,
  type PathParityConnection,
} from "./kilo-provider/path-parity"

function payload() {
  return {
    home: "/home/u",
    state: "/home/u/.local/state/kilo",
    config: "/home/u/.config/kilo",
    worktree: "/tmp",
    directory: "/tmp",
  }
}

describe("path parity wiring (model-state narrowest consumer)", () => {
  test("terminal gate admits settled SDK data and terminal failures only", () => {
    expect(sdkPathHasTerminal({ data: payload() } as never)).toBeTrue()
    expect(sdkPathHasTerminal({ data: payload(), response: { status: 200 } } as never)).toBeTrue()
    expect(sdkPathHasTerminal({ error: { status: 500 }, response: { status: 500 } } as never)).toBeTrue()
    expect(sdkPathHasTerminal({ error: { message: "boom" } } as never)).toBeFalse()
    expect(sdkPathHasTerminal({} as never)).toBeFalse()
  })

  test("detached observer preserves SDK return and never throws", async () => {
    let calls = 0
    const conn = {
      isPrivateAvailable: () => true,
      privatePathOutcomeWithHandle: (req: Record<string, unknown>) => {
        calls += 1
        expect((req as Record<string, unknown>).op).toBe("path/get")
        return {
          id: 3,
          promise: Promise.resolve({
            kind: "valid",
            result: {
              v: 1,
              requestId: (req as { requestId: string }).requestId,
              opId: (req as { opId: string }).opId,
              op: "path/get",
              idempotencyKey: (req as { idempotencyKey: string }).idempotencyKey,
              status: "succeeded",
              outcome: { type: "succeeded", time: 1 },
              accepted: true,
              data: { path: payload() },
            },
          }),
          cancel: () => true,
        }
      },
    } as unknown as PathParityConnection
    const sdk = { data: payload(), response: { status: 200 } }
    let ret: unknown
    expect(() => {
      ret = observePathParityDetached(conn, sdk as never, "/tmp")
    }).not.toThrow()
    expect(ret).toBeUndefined()
    expect(calls).toBe(1)
    await new Promise((r) => setTimeout(r, 25))
    expect(sdk.data).toEqual(payload())
  })

  test("non-terminal SDK never touches the private transport", () => {
    const conn = {
      isPrivateAvailable: () => {
        throw new Error("must not check availability for non-terminal SDK")
      },
      privatePathOutcomeWithHandle: () => {
        throw new Error("must not call private transport for non-terminal SDK")
      },
    } as unknown as PathParityConnection
    expect(() => observePathParityDetached(conn, { error: { message: "boom" } } as never, "/tmp")).not.toThrow()
    expect(() => observePathParityDetached(conn, {} as never, "/tmp")).not.toThrow()
  })

  test("terminal SDK error/response reaches the observer without mutating SDK state", async () => {
    let calls = 0
    const conn = {
      isPrivateAvailable: () => true,
      privatePathOutcomeWithHandle: (req: Record<string, unknown>) => {
        calls += 1
        return {
          id: 9,
          promise: Promise.resolve({
            kind: "valid",
            result: {
              v: 1,
              requestId: (req as { requestId: string }).requestId,
              opId: (req as { opId: string }).opId,
              op: "path/get",
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
    } as unknown as PathParityConnection
    // Terminal failure via error+response gates the observer (not skipped).
    const sdk = { error: { status: 500 }, response: { status: 500 } }
    const before = JSON.stringify(sdk)
    observePathParityDetached(conn, sdk as never, "/tmp")
    await new Promise((r) => setTimeout(r, 25))
    expect(calls).toBe(1)
    expect(JSON.stringify(sdk)).toBe(before)
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
      privatePathOutcomeWithHandle: () => {
        calls += 1
        return { id: 1, promise: Promise.resolve({ kind: "invalid", detail: "x" }), cancel: () => true }
      },
    } as unknown as PathParityConnection
    observePathParityDetached(conn, { data: payload() } as never, "/tmp")
    expect(listener).not.toBeNull()
    // Backend replaced before negotiation completes: deferred fire must skip.
    epoch = 12
    listener!()
    await new Promise((r) => setTimeout(r, 25))
    expect(calls).toBe(0)
  })

  test("fallback deferred key is opaque and collision-safe across tuples", () => {
    const a = deferredPathKey(9, "/tmp/alpha", undefined)
    const b = deferredPathKey(9, "/tmp/beta", undefined)
    const c = deferredPathKey(9, "/tmp/alpha", "ws-one")
    const d = deferredPathKey(9, "/tmp/alpha", "ws-two")
    const e = deferredPathKey(10, "/tmp/alpha", undefined)
    expect(new Set([a, b, c, d, e]).size).toBe(5)
    for (const k of [a, b, c, d, e]) {
      expect(k.startsWith("path:")).toBeTrue()
      expect(k).not.toContain("/tmp/alpha")
      expect(k).not.toContain("/tmp/beta")
      expect(k).not.toContain("ws-one")
      expect(k).not.toContain("ws-two")
    }
    expect(deferredPathKey(9, "/tmp:alpha", undefined)).not.toBe(deferredPathKey(9, "/tmp", "alpha"))
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
      privatePathOutcomeWithHandle: () => {
        throw new Error("must not call while unavailable")
      },
    } as unknown as PathParityConnection
    const sdk = { data: payload() }
    expect(() => observePathParityDetached(conn, sdk as never, "/tmp")).not.toThrow()
    expect(seen.length).toBe(1)
    expect(sdk.data).toEqual(payload())
  })
})
