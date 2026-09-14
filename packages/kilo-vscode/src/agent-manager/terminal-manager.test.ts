import { describe, expect, it } from "bun:test"
import { TerminalManager, type TerminalManagerDeps } from "./terminal-manager"

const DIR = "/tmp/kilo-pty"
const PTY = "pty_aaaaaaaaaaaaaaaaaaaaaaaaaa"

function sdkWith(
  updateImpl?: (args: {
    directory: string
    ptyID: string
    size: { rows: number; cols: number }
  }) => Promise<{ data?: unknown; error?: unknown }>,
  removeImpl?: (args: { directory: string; ptyID: string }) => Promise<{ data?: unknown; error?: unknown }>,
  seen?: { update: number; remove: number; getClient: number },
) {
  return {
    pty: {
      create: async () => ({ data: { id: PTY, title: "t" }, error: undefined }),
      update: async (args: { directory: string; ptyID: string; size: { rows: number; cols: number } }) => {
        if (seen) seen.update += 1
        if (updateImpl) return updateImpl(args)
        return { data: {}, error: undefined }
      },
      remove: async (args: { directory: string; ptyID: string }) => {
        if (seen) seen.remove += 1
        if (removeImpl) return removeImpl(args)
        return { data: true, error: undefined }
      },
    },
  }
}

function depsFor(opts: {
  sdk?: ReturnType<typeof sdkWith>
  getClientThrows?: boolean
  connection?: unknown
  logs?: unknown[][]
}): TerminalManagerDeps {
  const logs = opts.logs ?? []
  return {
    getClient: () => {
      if (opts.getClientThrows) throw new Error("not connected")
      if (!opts.sdk) throw new Error("not connected")
      return opts.sdk as never
    },
    buildWsUrl: (ptyID: string, cwd: string) => `ws://localhost/pty/${ptyID}?directory=${encodeURIComponent(cwd)}`,
    log: (...args: unknown[]) => {
      logs.push(args)
    },
    getPrivateConnection: () => (opts.connection ?? null) as never,
  }
}

function privateOk() {
  return {
    isPrivateAvailable: () => true,
    privatePtyUpdateOutcomeWithHandle: (q: {
      requestId: string
      opId: string
      idempotencyKey: string
      op: string
    }) => ({
      id: 1,
      promise: Promise.resolve({
        kind: "valid",
        result: {
          v: 1,
          requestId: q.requestId,
          opId: q.opId,
          op: q.op,
          idempotencyKey: q.idempotencyKey,
          status: "succeeded",
          outcome: { type: "succeeded", time: 1 },
          accepted: true,
          data: { updated: true },
        },
      }),
    }),
    privatePtyRemoveOutcomeWithHandle: (q: {
      requestId: string
      opId: string
      idempotencyKey: string
      op: string
    }) => ({
      id: 2,
      promise: Promise.resolve({
        kind: "valid",
        result: {
          v: 1,
          requestId: q.requestId,
          opId: q.opId,
          op: q.op,
          idempotencyKey: q.idempotencyKey,
          status: "succeeded",
          outcome: { type: "succeeded", time: 1 },
          accepted: true,
          data: { removed: true },
        },
      }),
    }),
  }
}

function privateNotFound() {
  const failure = { code: "pty.not_found", message: "pty not found", retryable: false }
  return {
    isPrivateAvailable: () => true,
    privatePtyUpdateOutcomeWithHandle: (q: {
      requestId: string
      opId: string
      idempotencyKey: string
      op: string
    }) => ({
      id: 1,
      promise: Promise.resolve({
        kind: "valid",
        result: {
          v: 1,
          requestId: q.requestId,
          opId: q.opId,
          op: q.op,
          idempotencyKey: q.idempotencyKey,
          status: "failed",
          outcome: { type: "failed", time: 1, failure },
          accepted: false,
          failure,
        },
      }),
    }),
    privatePtyRemoveOutcomeWithHandle: (q: {
      requestId: string
      opId: string
      idempotencyKey: string
      op: string
    }) => ({
      id: 2,
      promise: Promise.resolve({
        kind: "valid",
        result: {
          v: 1,
          requestId: q.requestId,
          opId: q.opId,
          op: q.op,
          idempotencyKey: q.idempotencyKey,
          status: "failed",
          outcome: { type: "failed", time: 1, failure },
          accepted: false,
          failure,
        },
      }),
    }),
  }
}

function privateTerminal(code = "scope_mismatch") {
  const failure = { code, message: "m", retryable: false }
  return {
    isPrivateAvailable: () => true,
    privatePtyUpdateOutcomeWithHandle: (q: {
      requestId: string
      opId: string
      idempotencyKey: string
      op: string
    }) => ({
      id: 1,
      promise: Promise.resolve({
        kind: "valid",
        result: {
          v: 1,
          requestId: q.requestId,
          opId: q.opId,
          op: q.op,
          idempotencyKey: q.idempotencyKey,
          status: "failed",
          outcome: { type: "failed", time: 1, failure },
          accepted: false,
          failure,
        },
      }),
    }),
    privatePtyRemoveOutcomeWithHandle: (q: {
      requestId: string
      opId: string
      idempotencyKey: string
      op: string
    }) => ({
      id: 2,
      promise: Promise.resolve({
        kind: "valid",
        result: {
          v: 1,
          requestId: q.requestId,
          opId: q.opId,
          op: q.op,
          idempotencyKey: q.idempotencyKey,
          status: "failed",
          outcome: { type: "failed", time: 1, failure },
          accepted: false,
          failure,
        },
      }),
    }),
  }
}

async function seed(manager: TerminalManager): Promise<string> {
  const created = await manager.create({ slotId: null, cwd: DIR, title: "t" })
  return created.terminalId
}

describe("TerminalManager pty private-first", () => {
  it("create stays SDK-only with buildWsUrl passthrough and zero update/remove", async () => {
    const seen = { update: 0, remove: 0, getClient: 0 }
    const createdArgs: unknown[] = []
    const wsArgs: Array<[string, string]> = []
    const privateCalls = { update: 0, remove: 0 }
    const sdk = {
      pty: {
        create: async (args: unknown) => {
          createdArgs.push(args)
          return { data: { id: PTY, title: "t" }, error: undefined }
        },
        update: async () => {
          seen.update += 1
          return { data: {}, error: undefined }
        },
        remove: async () => {
          seen.remove += 1
          return { data: true, error: undefined }
        },
      },
    }
    const logs: unknown[][] = []
    const manager = new TerminalManager({
      getClient: () => sdk as never,
      buildWsUrl: (ptyID: string, cwd: string) => {
        wsArgs.push([ptyID, cwd])
        return `ws://localhost/pty/${ptyID}?directory=${encodeURIComponent(cwd)}`
      },
      log: (...args: unknown[]) => {
        logs.push(args)
      },
      getPrivateConnection: () =>
        ({
          isPrivateAvailable: () => true,
          privatePtyUpdateOutcomeWithHandle: () => {
            privateCalls.update += 1
            throw new Error("create must not touch pty/update")
          },
          privatePtyRemoveOutcomeWithHandle: () => {
            privateCalls.remove += 1
            throw new Error("create must not touch pty/remove")
          },
        }) as never,
    })
    const created = await manager.create({ slotId: "s1", cwd: DIR, title: "Terminal 1" })
    expect(createdArgs).toEqual([{ directory: DIR, cwd: DIR, title: "Terminal 1" }])
    expect(privateCalls).toEqual({ update: 0, remove: 0 })
    expect(wsArgs).toEqual([[PTY, DIR]])
    expect(created.wsUrl).toContain("/pty/")
    expect(created.wsUrl).toContain("directory=")
    expect(seen.update).toBe(0)
    expect(seen.remove).toBe(0)
  })

  it("resize routes only through the private helper with lazy SDK (zero SDK on private success)", async () => {
    const seen = { update: 0, remove: 0, getClient: 0 }
    const sdk = sdkWith(undefined, undefined, seen)
    const logs: unknown[][] = []
    const manager = new TerminalManager({
      ...depsFor({ sdk, connection: privateOk(), logs }),
      getClient: () => {
        seen.getClient += 1
        return sdk as never
      },
    })
    const id = await seed(manager)
    seen.getClient = 0
    await manager.resize(id, 80, 24)
    expect(seen.update).toBe(0)
    expect(seen.getClient).toBe(0)
    expect(logs).toHaveLength(1)
  })

  it("resize missing entry is a no-op", async () => {
    const seen = { update: 0, remove: 0, getClient: 0 }
    const manager = new TerminalManager(depsFor({ sdk: sdkWith(undefined, undefined, seen), connection: privateOk() }))
    await manager.resize("terminal:missing", 80, 24)
    expect(seen.update).toBe(0)
  })

  it("resize terminal failure logs fixed category with zero SDK", async () => {
    const seen = { update: 0, remove: 0, getClient: 0 }
    const logs: unknown[][] = []
    const manager = new TerminalManager(
      depsFor({ sdk: sdkWith(undefined, undefined, seen), connection: privateTerminal("scope_mismatch"), logs }),
    )
    const id = await seed(manager)
    await manager.resize(id, 80, 24)
    expect(seen.update).toBe(0)
    expect(JSON.stringify(logs)).toContain("Terminal resize failed")
    expect(JSON.stringify(logs)).toContain("scope_mismatch")
    const failure = logs.find((line) => JSON.stringify(line).includes("Terminal resize failed"))
    expect(failure).toBeDefined()
    expect(JSON.stringify(failure)).not.toContain(DIR)
  })

  it("close deletes bookkeeping before remote cleanup and always resolves", async () => {
    const seen = { update: 0, remove: 0, getClient: 0 }
    const logs: unknown[][] = []
    const manager = new TerminalManager(
      depsFor({ sdk: sdkWith(undefined, undefined, seen), connection: privateOk(), logs }),
    )
    const id = await seed(manager)
    await manager.close(id)
    await manager.close(id)
    expect(seen.remove).toBe(0)
    expect(JSON.stringify(logs)).toContain("Terminal closed")
  })

  it("close pty.not_found (private or SDK 404) has zero linger warning", async () => {
    for (const conn of [privateNotFound(), null]) {
      const seen = { update: 0, remove: 0, getClient: 0 }
      const logs: unknown[][] = []
      const sdk = sdkWith(undefined, async () => ({ data: undefined, error: { _tag: "PtyNotFoundError" } }), seen)
      const manager = new TerminalManager(depsFor({ sdk, connection: conn, logs }))
      const id = await seed(manager)
      await manager.close(id)
      expect(JSON.stringify(logs)).toContain("Terminal closed")
      expect(JSON.stringify(logs)).not.toContain("may linger")
    }
  })

  it("close terminal failure retains may-linger without SDK replay", async () => {
    const seen = { update: 0, remove: 0, getClient: 0 }
    const logs: unknown[][] = []
    const manager = new TerminalManager(
      depsFor({ sdk: sdkWith(undefined, undefined, seen), connection: privateTerminal("validation.failed"), logs }),
    )
    const id = await seed(manager)
    await manager.close(id)
    expect(seen.remove).toBe(0)
    expect(JSON.stringify(logs)).toContain("may linger")
  })

  it("dispose per-entry cleanup with process-group-kill fallback when neither is available", async () => {
    const logs: unknown[][] = []
    let available = true
    const sdk = sdkWith(undefined, undefined, { update: 0, remove: 0, getClient: 0 })
    const manager = new TerminalManager({
      getClient: () => {
        if (!available) throw new Error("torn down")
        return sdk as never
      },
      buildWsUrl: (ptyID: string, cwd: string) => `ws://localhost/pty/${ptyID}`,
      log: (...args: unknown[]) => {
        logs.push(args)
      },
      getPrivateConnection: () => null,
    })
    await manager.create({ slotId: null, cwd: DIR, title: "t" })
    available = false
    logs.length = 0
    await manager.dispose()
    expect(JSON.stringify(logs)).toContain("process-group kill")
    expect(JSON.stringify(logs)).not.toContain("may linger")
  })

  it("dispose uses process-group-kill fallback when private is unavailable and SDK is torn down", async () => {
    const logs: unknown[][] = []
    let available = true
    const sdk = sdkWith(undefined, undefined, { update: 0, remove: 0, getClient: 0 })
    const manager = new TerminalManager({
      getClient: () => {
        if (!available) throw new Error("torn down")
        return sdk as never
      },
      buildWsUrl: (ptyID: string) => `ws://localhost/pty/${ptyID}`,
      log: (...args: unknown[]) => {
        logs.push(args)
      },
      getPrivateConnection: () => ({ isPrivateAvailable: () => false }) as never,
    })
    await manager.create({ slotId: null, cwd: DIR, title: "t" })
    available = false
    logs.length = 0
    await manager.dispose()
    expect(JSON.stringify(logs)).toContain("process-group kill")
    expect(JSON.stringify(logs)).not.toContain("may linger")
  })

  it("dispose counts failure and retains summary when SDK cleanup fails", async () => {
    const seen = { update: 0, remove: 0, getClient: 0 }
    const logs: unknown[][] = []
    const sdk = sdkWith(undefined, async () => ({ data: undefined, error: new Error("boom") }), seen)
    const manager = new TerminalManager(depsFor({ sdk, connection: null, logs }))
    await manager.create({ slotId: null, cwd: DIR, title: "t" })
    await manager.dispose()
    expect(seen.remove).toBe(1)
    expect(JSON.stringify(logs)).toContain("cleanup failed")
    expect(JSON.stringify(logs)).toContain("may linger")
  })

  // No source-string assertion remains: routing is proven behaviorally —
  // private success yields zero SDK calls (lazy `getClient`, see the resize
  // test above), fallback yields exactly one same-tuple SDK call (see below),
  // and create never touches the private peer (see above). A direct
  // `client.pty.update`/`remove` call added alongside the helpers would break
  // the zero-SDK counts, so a text guard adds no signal.
  it("resize/close fall back exactly once with the same tuple when private is unavailable", async () => {
    const seen = { update: 0, remove: 0, getClient: 0 }
    let updateArgs: unknown
    let removeArgs: unknown
    const sdk = sdkWith(
      async (args) => {
        updateArgs = args
        return { data: {}, error: undefined }
      },
      async (args) => {
        removeArgs = args
        return { data: true, error: undefined }
      },
      seen,
    )
    const logs: unknown[][] = []
    const manager = new TerminalManager(depsFor({ sdk, connection: null, logs }))
    const id = await seed(manager)
    await manager.resize(id, 80, 24)
    await manager.close(id)
    expect(seen.update).toBe(1)
    expect(seen.remove).toBe(1)
    expect(updateArgs).toEqual({ directory: DIR, ptyID: PTY, size: { rows: 24, cols: 80 } })
    expect(removeArgs).toEqual({ directory: DIR, ptyID: PTY })
    expect(JSON.stringify(logs)).toContain("Terminal closed")
  })
})
