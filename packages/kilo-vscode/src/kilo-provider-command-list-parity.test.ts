import { describe, expect, test } from "bun:test"
import {
  deferredCommandListKey,
  observeCommandListParityDetached,
  sdkCommandListHasTerminal,
  type CommandListParityConnection,
} from "./kilo-provider/command-list-parity"
import { clearCommandsCache, loadCommands, setCommandListParityConnection } from "./kilo-provider/commands"

function entries() {
  return [{ name: "init", description: "guided setup", source: "command", hints: [] }]
}

describe("command-list parity wiring (commands narrowest consumer)", () => {
  test("terminal gate admits settled SDK arrays and terminal failures only", () => {
    expect(sdkCommandListHasTerminal({ data: entries() } as never)).toBeTrue()
    expect(sdkCommandListHasTerminal({ data: entries(), response: { status: 200 } } as never)).toBeTrue()
    expect(sdkCommandListHasTerminal({ data: {} } as never)).toBeFalse()
    expect(sdkCommandListHasTerminal({ error: { status: 500 }, response: { status: 500 } } as never)).toBeTrue()
    expect(sdkCommandListHasTerminal({ error: { message: "boom" } } as never)).toBeFalse()
    expect(sdkCommandListHasTerminal({} as never)).toBeFalse()
  })

  test("detached observer preserves SDK return and never throws", async () => {
    let calls = 0
    const conn = {
      isPrivateAvailable: () => true,
      privateCommandListOutcomeWithHandle: (req: Record<string, unknown>) => {
        calls += 1
        expect((req as Record<string, unknown>).op).toBe("command/list")
        return {
          id: 3,
          promise: Promise.resolve({
            kind: "valid",
            result: {
              v: 1,
              requestId: (req as { requestId: string }).requestId,
              opId: (req as { opId: string }).opId,
              op: "command/list",
              idempotencyKey: (req as { idempotencyKey: string }).idempotencyKey,
              status: "succeeded",
              outcome: { type: "succeeded", time: 1 },
              accepted: true,
              data: { commands: entries() },
            },
          }),
          cancel: () => true,
        }
      },
    } as unknown as CommandListParityConnection
    const sdk = { data: entries(), response: { status: 200 } }
    let ret: unknown
    expect(() => {
      ret = observeCommandListParityDetached(conn, sdk as never, "/tmp")
    }).not.toThrow()
    expect(ret).toBeUndefined()
    expect(calls).toBe(1)
    await new Promise((r) => setTimeout(r, 25))
    expect(sdk.data).toEqual(entries())
  })

  test("non-terminal SDK never touches the private transport", () => {
    const conn = {
      isPrivateAvailable: () => {
        throw new Error("must not check availability for non-terminal SDK")
      },
      privateCommandListOutcomeWithHandle: () => {
        throw new Error("must not call private transport for non-terminal SDK")
      },
    } as unknown as CommandListParityConnection
    expect(() => observeCommandListParityDetached(conn, { error: { message: "boom" } } as never, "/tmp")).not.toThrow()
    expect(() => observeCommandListParityDetached(conn, {} as never, "/tmp")).not.toThrow()
    expect(() => observeCommandListParityDetached(conn, { data: entries() } as never, "")).not.toThrow()
  })

  test("terminal SDK error/response reaches the observer without mutating SDK state", async () => {
    let calls = 0
    const conn = {
      isPrivateAvailable: () => true,
      privateCommandListOutcomeWithHandle: (req: Record<string, unknown>) => {
        calls += 1
        return {
          id: 9,
          promise: Promise.resolve({
            kind: "valid",
            result: {
              v: 1,
              requestId: (req as { requestId: string }).requestId,
              opId: (req as { opId: string }).opId,
              op: "command/list",
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
    } as unknown as CommandListParityConnection
    // Terminal failure via error+response gates the observer (not skipped).
    const sdk = { error: { status: 500 }, response: { status: 500 } }
    const before = JSON.stringify(sdk)
    observeCommandListParityDetached(conn, sdk as never, "/tmp")
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
      privateCommandListOutcomeWithHandle: () => {
        calls += 1
        return { id: 1, promise: Promise.resolve({ kind: "invalid", detail: "x" }), cancel: () => true }
      },
    } as unknown as CommandListParityConnection
    observeCommandListParityDetached(conn, { data: entries() } as never, "/tmp")
    expect(listener).not.toBeNull()
    // Backend replaced before negotiation completes: deferred fire must skip.
    epoch = 12
    listener!()
    await new Promise((r) => setTimeout(r, 25))
    expect(calls).toBe(0)
  })

  test("fallback deferred key is opaque and collision-safe across tuples", () => {
    const a = deferredCommandListKey(9, "/tmp/alpha", undefined)
    const b = deferredCommandListKey(9, "/tmp/beta", undefined)
    const c = deferredCommandListKey(9, "/tmp/alpha", "ws-one")
    const d = deferredCommandListKey(9, "/tmp/alpha", "ws-two")
    const e = deferredCommandListKey(10, "/tmp/alpha", undefined)
    expect(new Set([a, b, c, d, e]).size).toBe(5)
    for (const k of [a, b, c, d, e]) {
      expect(k.startsWith("command-list:")).toBeTrue()
      expect(k).not.toContain("/tmp/alpha")
      expect(k).not.toContain("/tmp/beta")
      expect(k).not.toContain("ws-one")
      expect(k).not.toContain("ws-two")
    }
    expect(deferredCommandListKey(9, "/tmp:alpha", undefined)).not.toBe(deferredCommandListKey(9, "/tmp", "alpha"))
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
      privateCommandListOutcomeWithHandle: () => {
        throw new Error("must not call while unavailable")
      },
    } as unknown as CommandListParityConnection
    const sdk = { data: entries() }
    expect(() => observeCommandListParityDetached(conn, sdk as never, "/tmp")).not.toThrow()
    expect(seen.length).toBe(1)
    expect(sdk.data).toEqual(entries())
  })

  test("loadCommands keeps SDK authority while observing detached parity", async () => {
    clearCommandsCache()
    let calls = 0
    const conn = {
      isPrivateAvailable: () => true,
      privateCommandListOutcomeWithHandle: (req: Record<string, unknown>) => {
        calls += 1
        return {
          id: 3,
          promise: Promise.resolve({
            kind: "valid",
            result: {
              v: 1,
              requestId: (req as { requestId: string }).requestId,
              opId: (req as { opId: string }).opId,
              op: "command/list",
              idempotencyKey: (req as { idempotencyKey: string }).idempotencyKey,
              status: "succeeded",
              outcome: { type: "succeeded", time: 1 },
              accepted: true,
              data: { commands: entries() },
            },
          }),
          cancel: () => true,
        }
      },
    } as unknown as CommandListParityConnection
    setCommandListParityConnection(conn)
    try {
      const client = {
        command: {
          list: async () => ({ data: entries(), response: { status: 200 } }),
        },
      } as never
      const message = (await loadCommands(client, "/tmp/cmdlist-a")) as { type: string; commands: unknown[] }
      expect(message.type).toBe("commandsLoaded")
      expect(message.commands).toEqual(entries())
      await new Promise((r) => setTimeout(r, 25))
      expect(calls).toBe(1)
      // Per-directory dedupe: concurrent loads share one SDK call.
      clearCommandsCache()
      let sdkCalls = 0
      const shared = {
        command: {
          list: async () => {
            sdkCalls += 1
            await new Promise((r) => setTimeout(r, 10))
            return { data: entries(), response: { status: 200 } }
          },
        },
      } as never
      const [first, second] = await Promise.all([loadCommands(shared, "/tmp/cmdlist-b"), loadCommands(shared, "/tmp/cmdlist-b")])
      expect(sdkCalls).toBe(1)
      expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    } finally {
      setCommandListParityConnection(null)
      clearCommandsCache()
    }
  })

  test("loadCommands failure stays SDK-terminal without becoming carrier authority", async () => {
    clearCommandsCache()
    let calls = 0
    const conn = {
      isPrivateAvailable: () => true,
      privateCommandListOutcomeWithHandle: () => {
        calls += 1
        return { id: 3, promise: Promise.resolve({ kind: "invalid", detail: "x" }), cancel: () => true }
      },
    } as unknown as CommandListParityConnection
    setCommandListParityConnection(conn)
    try {
      const failure = Object.assign(new Error("Request failed with status 500"), { status: 500, response: { status: 500 } })
      const client = {
        command: {
          list: async () => {
            throw failure
          },
        },
      } as never
      let thrown: unknown = null
      try {
        await loadCommands(client, "/tmp/cmdlist-c")
      } catch (e) {
        thrown = e
      }
      expect(thrown).toBe(failure)
      await new Promise((r) => setTimeout(r, 25))
      expect(calls).toBe(1)
    } finally {
      setCommandListParityConnection(null)
      clearCommandsCache()
    }
  })
})
