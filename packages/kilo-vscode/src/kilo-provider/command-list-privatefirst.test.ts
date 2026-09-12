import { describe, expect, test } from "bun:test"
import {
  attemptCommandListPrivate,
  buildCommandListPrivateIdentity,
  buildCommandListPrivateReq,
  parseCommandListPrivateResult,
} from "./command-list-privatefirst"
import { canonicalCommandListOpId } from "../services/cli-backend/serve-private-command-list-contract"
import { clearCommandsCache, loadCommands } from "./commands"

function entries() {
  return [
    { name: "init", description: "guided setup", source: "command", hints: ["$1"] },
    { name: "review", source: "skill" },
  ]
}

function req() {
  return buildCommandListPrivateReq("/tmp/cmdlist")
}

function okFor(r: ReturnType<typeof req>, commands: unknown[] = entries()) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "command/list",
    idempotencyKey: r.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { commands },
  }
}

function terminalFor(r: ReturnType<typeof req>, code = "validation.failed") {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "command/list",
    idempotencyKey: r.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure: { code, message: "bad", retryable: false } },
    accepted: false,
    failure: { code, message: "bad", retryable: false },
  }
}

function retryableFor(r: ReturnType<typeof req>) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "command/list",
    idempotencyKey: r.idempotencyKey,
    status: "failed",
    outcome: {
      type: "failed",
      time: 1,
      failure: { code: "InstanceUnavailableDuringConfigRebuild", message: "busy", retryable: true },
    },
    accepted: false,
    failure: { code: "InstanceUnavailableDuringConfigRebuild", message: "busy", retryable: true },
  }
}

function ambiguousFor(r: ReturnType<typeof req>) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "command/list",
    idempotencyKey: r.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: 1 },
    accepted: false,
    transportUnknown: true,
  }
}

function connFor(result: (q: ReturnType<typeof req>) => unknown, id = 1) {
  return {
    isPrivateAvailable: () => true,
    privateCommandListOutcomeWithHandle: (q: ReturnType<typeof req>) => ({
      id,
      promise: Promise.resolve({ kind: "valid", result: result(q) }),
      cancel: () => true,
    }),
  }
}

describe("command-list private-first", () => {
  test("identity binds canonical command-list tuple", () => {
    const { opId, idempotencyKey, requestId } = buildCommandListPrivateIdentity()
    expect(opId).toBe(idempotencyKey)
    expect(opId.startsWith("command-list:")).toBeTrue()
    const token = opId.split(":")[1]!
    expect(canonicalCommandListOpId(token)).toBe(opId)
    expect(typeof requestId).toBe("string")
  })

  test("succeeded accepted parses ok preserving carrier order", () => {
    const r = req()
    const ordered = [
      { name: "b", source: "command" },
      { name: "a", source: "skill" },
    ]
    const parsed = parseCommandListPrivateResult(okFor(r, ordered), r)
    expect(parsed.kind).toBe("ok")
    if (parsed.kind === "ok") expect(parsed.commands).toEqual(ordered)
  })

  test("terminal failed closes without SDK", async () => {
    for (const code of ["validation.failed", "scope_mismatch", "internal"]) {
      const r = req()
      const out = await attemptCommandListPrivate(connFor((q) => terminalFor(q, code)) as never, r)
      expect(out.kind).toBe("terminal")
    }
  })

  test("retryable fence falls back", async () => {
    const r = req()
    const out = await attemptCommandListPrivate(connFor((q) => retryableFor(q)) as never, r)
    expect(out.kind).toBe("fallback")
  })

  test("unavailable/invalid/ambiguous/transport/timeout are fallback-eligible", async () => {
    const r1 = req()
    const unavailable = {
      isPrivateAvailable: () => false,
      privateCommandListOutcomeWithHandle: () => {
        throw new Error("must not be called")
      },
    }
    expect((await attemptCommandListPrivate(unavailable as never, r1)).kind).toBe("fallback")

    const r2 = req()
    const ambiguous = connFor((q) => ambiguousFor(q))
    expect((await attemptCommandListPrivate(ambiguous as never, r2)).kind).toBe("fallback")

    const r3 = req()
    const invalid = {
      isPrivateAvailable: () => true,
      privateCommandListOutcomeWithHandle: () => ({
        id: 3,
        promise: Promise.resolve({ kind: "invalid", detail: "bad" }),
        cancel: () => true,
      }),
    }
    expect((await attemptCommandListPrivate(invalid as never, r3)).kind).toBe("fallback")

    const r4 = req()
    const transport = {
      isPrivateAvailable: () => true,
      privateCommandListOutcomeWithHandle: () => ({
        id: 4,
        promise: Promise.reject(new Error("Private peer unavailable")),
        cancel: () => true,
      }),
    }
    expect((await attemptCommandListPrivate(transport as never, r4)).kind).toBe("fallback")

    const r5 = req()
    const hanging = {
      isPrivateAvailable: () => true,
      privateCommandListOutcomeWithHandle: () => ({
        id: 5,
        promise: new Promise(() => {}),
        cancel: () => true,
      }),
    }
    expect((await attemptCommandListPrivate(hanging as never, r5, 10)).kind).toBe("fallback")

    // Transport-synthesized failed (fixed redacted message) falls back, never terminal.
    const r6 = req()
    const transportFailed = connFor((q) => ({
      v: 1,
      requestId: q.requestId,
      opId: q.opId,
      op: "command/list",
      idempotencyKey: q.idempotencyKey,
      status: "failed",
      outcome: {
        type: "failed",
        time: 1,
        failure: { code: "-32603", message: "private command-list transport failed", retryable: false },
      },
      accepted: false,
      failure: { code: "-32603", message: "private command-list transport failed", retryable: false },
    }))
    expect((await attemptCommandListPrivate(transportFailed as never, r6)).kind).toBe("fallback")
  })

  test("timeout exact-cancels the pending by id", async () => {
    const r = req()
    let cancelled: unknown[] = []
    const hanging = {
      isPrivateAvailable: () => true,
      privateCommandListOutcomeWithHandle: () => ({
        id: 42,
        promise: new Promise(() => {}),
        cancel: (msg?: string) => {
          cancelled.push(msg)
          return true
        },
      }),
    }
    const out = await attemptCommandListPrivate(hanging as never, r, 10)
    expect(out).toEqual({ kind: "fallback", reason: "timeout" })
    expect(cancelled.length).toBe(1)
    expect(String(cancelled[0]).includes(r.opId)).toBeTrue()
  })

  test("private success returns zero SDK with exact mapped shape/order", async () => {
    clearCommandsCache()
    const ordered = [
      { name: "b", description: "second", source: "command", hints: ["$1"] },
      { name: "review", source: "skill" },
    ]
    let sdkCalls = 0
    const client = {
      command: {
        list: async () => {
          sdkCalls += 1
          return { data: entries() }
        },
      },
    } as never
    const conn = connFor((q) => okFor(q, ordered))
    try {
      const message = (await loadCommands(client, "/tmp/cmdlist-ok", conn)) as {
        type: string
        commands: unknown[]
      }
      expect(message.type).toBe("commandsLoaded")
      expect(message.commands).toEqual(ordered)
      expect(sdkCalls).toBe(0)
    } finally {
      clearCommandsCache()
    }
  })

  test("terminal failed rejects with zero SDK", async () => {
    clearCommandsCache()
    let sdkCalls = 0
    const client = {
      command: {
        list: async () => {
          sdkCalls += 1
          return { data: entries() }
        },
      },
    } as never
    const conn = connFor((q) => terminalFor(q, "validation.failed"))
    let thrown: unknown = null
    try {
      await loadCommands(client, "/tmp/cmdlist-terminal", conn)
    } catch (e) {
      thrown = e
    }
    expect(thrown instanceof Error).toBeTrue()
    expect(sdkCalls).toBe(0)
    clearCommandsCache()
  })

  test("retryable/unavailable/invalid/ambiguous/transport/timeout take exactly one SDK fallback", async () => {
    const cases: Array<{ label: string; conn: unknown; r: string }> = []
    cases.push({
      label: "retryable",
      conn: connFor((q) => retryableFor(q)),
      r: "/tmp/cmdlist-fb-retryable",
    })
    cases.push({
      label: "unavailable",
      conn: {
        isPrivateAvailable: () => false,
        privateCommandListOutcomeWithHandle: () => {
          throw new Error("must not be called")
        },
      },
      r: "/tmp/cmdlist-fb-unavailable",
    })
    cases.push({
      label: "invalid",
      conn: {
        isPrivateAvailable: () => true,
        privateCommandListOutcomeWithHandle: () => ({
          id: 1,
          promise: Promise.resolve({ kind: "invalid", detail: "bad" }),
          cancel: () => true,
        }),
      },
      r: "/tmp/cmdlist-fb-invalid",
    })
    cases.push({
      label: "ambiguous",
      conn: connFor((q) => ambiguousFor(q)),
      r: "/tmp/cmdlist-fb-ambiguous",
    })
    cases.push({
      label: "transport",
      conn: {
        isPrivateAvailable: () => true,
        privateCommandListOutcomeWithHandle: () => ({
          id: 1,
          promise: Promise.reject(new Error("Private peer unavailable")),
          cancel: () => true,
        }),
      },
      r: "/tmp/cmdlist-fb-transport",
    })
    cases.push({
      label: "timeout",
      conn: {
        isPrivateAvailable: () => true,
        privateCommandListOutcomeWithHandle: () => ({
          id: 1,
          promise: new Promise(() => {}),
          cancel: () => true,
        }),
      },
      r: "/tmp/cmdlist-fb-timeout",
    })
    for (const c of cases) {
      clearCommandsCache()
      let sdkCalls = 0
      const client = {
        command: {
          list: async () => {
            sdkCalls += 1
            return { data: entries() }
          },
        },
      } as never
      const message = (await loadCommands(client, c.r, c.conn)) as { type: string; commands: unknown[] }
      expect(message.type).toBe("commandsLoaded")
      expect(message.commands).toEqual(entries())
      expect(sdkCalls).toBe(1)
      clearCommandsCache()
    }
  })

  test("SDK retry behavior preserved on fallback", async () => {
    clearCommandsCache()
    let sdkCalls = 0
    const client = {
      command: {
        list: async () => {
          sdkCalls += 1
          if (sdkCalls < 3) throw new Error("load failed: transient boom")
          return { data: entries() }
        },
      },
    } as never
    const conn = {
      isPrivateAvailable: () => false,
      privateCommandListOutcomeWithHandle: () => {
        throw new Error("must not be called")
      },
    }
    try {
      const message = (await loadCommands(client, "/tmp/cmdlist-retry", conn)) as { commands: unknown[] }
      expect(message.commands).toEqual(entries())
      expect(sdkCalls).toBe(3)
    } finally {
      clearCommandsCache()
    }
  })

  test("concurrent callers dedupe to one private operation", async () => {
    clearCommandsCache()
    let privateCalls = 0
    const conn = {
      isPrivateAvailable: () => true,
      privateCommandListOutcomeWithHandle: (q: ReturnType<typeof req>) => {
        privateCalls += 1
        return {
          id: privateCalls,
          promise: (async () => {
            await new Promise((r) => setTimeout(r, 10))
            return { kind: "valid", result: okFor(q) }
          })(),
          cancel: () => true,
        }
      },
    }
    const client = {
      command: {
        list: async () => {
          throw new Error("must not call SDK on private success")
        },
      },
    } as never
    try {
      const [first, second] = await Promise.all([
        loadCommands(client, "/tmp/cmdlist-dedupe", conn),
        loadCommands(client, "/tmp/cmdlist-dedupe", conn),
      ])
      expect(privateCalls).toBe(1)
      expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    } finally {
      clearCommandsCache()
    }
  })

  test("cache clears after settle and failure so next call refetches", async () => {
    clearCommandsCache()
    let privateCalls = 0
    const conn = {
      isPrivateAvailable: () => true,
      privateCommandListOutcomeWithHandle: (q: ReturnType<typeof req>) => {
        privateCalls += 1
        return {
          id: privateCalls,
          promise: Promise.resolve({ kind: "valid", result: okFor(q) }),
          cancel: () => true,
        }
      },
    }
    const client = { command: { list: async () => ({ data: entries() }) } } as never
    await loadCommands(client, "/tmp/cmdlist-settle", conn)
    await loadCommands(client, "/tmp/cmdlist-settle", conn)
    expect(privateCalls).toBe(2)

    clearCommandsCache()
    const failing = connFor((q) => terminalFor(q, "internal"))
    let first = 0
    try {
      await loadCommands(client, "/tmp/cmdlist-fail", failing)
    } catch {
      first += 1
    }
    let second = 0
    try {
      await loadCommands(client, "/tmp/cmdlist-fail", failing)
    } catch {
      second += 1
    }
    expect(first).toBe(1)
    expect(second).toBe(1)
    clearCommandsCache()
  })
})
