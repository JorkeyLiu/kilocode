import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { KiloClient } from "@kilocode/sdk/v2/client"
import { clearPathCacheForTest, setPathPrivateConnection } from "./kilo-provider/model-state"
import * as ModelState from "./kilo-provider/model-state"
import type { PathResolveConnection } from "./kilo-provider/model-state"

const routingA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kilo-ms-path-routing-a-")))
const routingB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kilo-ms-path-routing-b-")))
const stateA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kilo-ms-path-state-a-")))
const stateB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kilo-ms-path-state-b-")))

beforeEach(() => {
  clearPathCacheForTest()
  setPathPrivateConnection(null)
})

afterAll(() => {
  clearPathCacheForTest()
  setPathPrivateConnection(null)
  for (const dir of [routingA, routingB, stateA, stateB]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
})

function memCache() {
  const value: Record<string, string> = {}
  return {
    read: () => value,
    write: (next: Record<string, string>) => {
      for (const k of Object.keys(value)) delete value[k]
      Object.assign(value, next)
    },
  }
}

function successOutcome(req: { requestId: string; opId: string; idempotencyKey: string }, state: string, dir: string) {
  return {
    kind: "valid" as const,
    result: {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "path/get",
      idempotencyKey: req.idempotencyKey,
      status: "succeeded",
      outcome: { type: "succeeded", time: 1 },
      accepted: true,
      data: { path: { home: "/h", state, config: "/c", worktree: dir, directory: dir } },
    },
  }
}

function failedOutcome(
  req: { requestId: string; opId: string; idempotencyKey: string },
  retryable: boolean,
) {
  return {
    kind: "valid" as const,
    result: {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "path/get",
      idempotencyKey: req.idempotencyKey,
      status: "failed",
      outcome: { type: "failed", time: 1, failure: { code: "validation.failed", message: "bad", retryable } },
      accepted: false,
      failure: { code: "validation.failed", message: "bad", retryable },
    },
  }
}

function ambiguousOutcome(req: { requestId: string; opId: string; idempotencyKey: string }) {
  return {
    kind: "valid" as const,
    result: {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "path/get",
      idempotencyKey: req.idempotencyKey,
      status: "ambiguous",
      outcome: { type: "ambiguous", time: 1 },
      accepted: false,
      transportUnknown: true,
    },
  }
}

type ConnOpts = {
  routing: string | undefined
  epoch?: number | null
  available?: boolean
  onPrivate?: (req: { requestId: string; opId: string; idempotencyKey: string; context: { directory: string } }) => unknown
}

function conn(opts: ConnOpts, seen: { privateCalls: number; dir?: unknown }): PathResolveConnection {
  return {
    isPrivateAvailable: () => opts.available ?? true,
    getPrivateEpoch: () => opts.epoch ?? 7,
    getPathRoutingDirectory: () => opts.routing,
    privatePathOutcomeWithHandle: (req: unknown) => {
      seen.privateCalls += 1
      const typed = req as { requestId: string; opId: string; idempotencyKey: string; context: { directory: string } }
      seen.dir = typed.context.directory
      const out = opts.onPrivate?.(typed) ?? successOutcome(typed, stateA, opts.routing ?? "/tmp")
      return { id: 7, promise: Promise.resolve(out), cancel: () => true }
    },
  } as unknown as PathResolveConnection
}

function sdkClient(opts: {
  data?: unknown
  calls: { count: number; args: unknown[] | null }
  throwErr?: unknown
}): KiloClient {
  return {
    path: {
      get: async (...args: unknown[]) => {
        opts.calls.count += 1
        opts.calls.args = args
        if (opts.throwErr) throw opts.throwErr
        return { data: opts.data }
      },
    },
  } as unknown as KiloClient
}

describe("model-state path/get private-first", () => {
  test("private success returns model.json path with zero SDK", async () => {
    const seen = { privateCalls: 0 }
    setPathPrivateConnection(conn({ routing: routingA }, seen))
    const sdkCalls = { count: 0, args: null as unknown[] | null }
    const client = sdkClient({
      calls: sdkCalls,
      data: { home: "/h", state: "/should/not/use", config: "/c", worktree: "x", directory: "x" },
    })
    const posted: unknown[] = []
    await ModelState.handleMessage("requestVariants", {}, client, (m) => posted.push(m), memCache())
    expect(seen.privateCalls).toBe(1)
    expect(seen.dir).toBe(routingA)
    expect(sdkCalls.count).toBe(0)
    expect(posted[0]).toMatchObject({ type: "variantsLoaded" })
    const file = path.join(stateA, "model.json")
    expect(fs.existsSync(file) || !fs.existsSync(file)).toBeTrue()
    fs.rmSync(file, { force: true })
  })

  test("private terminal closes with zero SDK and empty UI without cache pollution", async () => {
    const seen = { privateCalls: 0 }
    setPathPrivateConnection(
      conn({ routing: routingA, onPrivate: (r) => failedOutcome(r, false) }, seen),
    )
    const sdkCalls = { count: 0, args: null as unknown[] | null }
    const client = sdkClient({ calls: sdkCalls, data: { state: stateA } })
    const posted: unknown[] = []
    await ModelState.handleMessage("requestVariants", {}, client, (m) => posted.push(m), memCache())
    expect(seen.privateCalls).toBe(1)
    expect(sdkCalls.count).toBe(0)
    expect(posted[0]).toMatchObject({ type: "variantsLoaded", variants: {} })
    // Failure must not populate the cache: a later success re-reads.
    clearPathCacheForTest()
    const seen2 = { privateCalls: 0 }
    setPathPrivateConnection(conn({ routing: routingA }, seen2))
    const posted2: unknown[] = []
    await ModelState.handleMessage("requestVariants", {}, client, (m) => posted2.push(m), memCache())
    expect(seen2.privateCalls).toBe(1)
    fs.rmSync(path.join(stateA, "model.json"), { force: true })
  })

  test("retryable/invalid/ambiguous/transport fall back exactly once with same spawn cwd", async () => {
    const cases: Array<{ name: string; build: (r: never) => unknown; available?: boolean }> = [
      { name: "retryable", build: (r) => failedOutcome(r as never, true) },
      { name: "invalid", build: () => ({ kind: "invalid", detail: "bad" }) },
      { name: "ambiguous", build: (r) => ambiguousOutcome(r as never) },
      {
        name: "transport",
        build: () => {
          throw new Error("Private peer unavailable")
        },
      },
    ]
    for (const c of cases) {
      clearPathCacheForTest()
      const seen = { privateCalls: 0 }
      setPathPrivateConnection(
        conn(
          {
            routing: routingA,
            available: c.available,
            onPrivate: (r) => c.build(r as never) as never,
          },
          seen,
        ),
      )
      const sdkCalls = { count: 0, args: null as unknown[] | null }
      const payload = { home: "/h", state: stateA, config: "/c", worktree: routingA, directory: routingA }
      const client = sdkClient({ calls: sdkCalls, data: payload })
      const posted: unknown[] = []
      await ModelState.handleMessage("requestVariants", {}, client, (m) => posted.push(m), memCache())
      expect(seen.privateCalls).toBe(1)
      expect(sdkCalls.count).toBe(1)
      expect(sdkCalls.args).toEqual([{ directory: routingA }])
      expect(posted[0]).toMatchObject({ type: "variantsLoaded" })
      fs.rmSync(path.join(stateA, "model.json"), { force: true })
    }
  })

  test("unavailable private takes exactly one same-cwd SDK fallback", async () => {
    const seen = { privateCalls: 0 }
    setPathPrivateConnection(conn({ routing: routingA, available: false }, seen))
    const sdkCalls = { count: 0, args: null as unknown[] | null }
    const payload = { home: "/h", state: stateA, config: "/c", worktree: routingA, directory: routingA }
    const client = sdkClient({ calls: sdkCalls, data: payload })
    await ModelState.handleMessage("requestVariants", {}, client, () => undefined, memCache())
    expect(seen.privateCalls).toBe(0)
    expect(sdkCalls.count).toBe(1)
    expect(sdkCalls.args).toEqual([{ directory: routingA }])
    fs.rmSync(path.join(stateA, "model.json"), { force: true })
  })

  test("absent routing uses exactly one SDK read with no args and no private request", async () => {
    const seen = { privateCalls: 0 }
    setPathPrivateConnection(conn({ routing: undefined }, seen))
    const sdkCalls = { count: 0, args: null as unknown[] | null }
    const client = sdkClient({ calls: sdkCalls, data: {} })
    const posted: unknown[] = []
    await ModelState.handleMessage("requestVariants", {}, client, (m) => posted.push(m), memCache())
    expect(sdkCalls.args).toEqual([])
    expect(sdkCalls.count).toBe(1)
    expect(seen.privateCalls).toBe(0)
    expect(posted[0]).toMatchObject({ type: "variantsLoaded" })
  })

  test("no connection uses exactly one SDK read with no private request", async () => {
    setPathPrivateConnection(null)
    const sdkCalls = { count: 0, args: null as unknown[] | null }
    const client = sdkClient({ calls: sdkCalls, data: {} })
    await ModelState.handleMessage("requestVariants", {}, client, () => undefined, memCache())
    expect(sdkCalls.count).toBe(1)
    expect(sdkCalls.args).toEqual([])
  })

  test("same backend identity caches; epoch or routing change re-reads", async () => {
    let epoch = 7
    let routing: string | undefined = routingA
    const seen = { privateCalls: 0 }
    const c: PathResolveConnection = {
      isPrivateAvailable: () => true,
      getPrivateEpoch: () => epoch,
      getPathRoutingDirectory: () => routing,
      privatePathOutcomeWithHandle: (req: unknown) => {
        seen.privateCalls += 1
        const typed = req as { requestId: string; opId: string; idempotencyKey: string }
        return { id: 7, promise: Promise.resolve(successOutcome(typed, stateA, routingA)), cancel: () => true }
      },
    } as unknown as PathResolveConnection
    setPathPrivateConnection(c)
    const sdkCalls = { count: 0, args: null as unknown[] | null }
    const client = sdkClient({ calls: sdkCalls, data: { state: "/unused" } })
    await ModelState.handleMessage("requestVariants", {}, client, () => undefined, memCache())
    expect(seen.privateCalls).toBe(1)
    await ModelState.handleMessage("requestVariants", {}, client, () => undefined, memCache())
    expect(seen.privateCalls).toBe(1)
    expect(sdkCalls.count).toBe(0)
    epoch = 8
    await ModelState.handleMessage("requestVariants", {}, client, () => undefined, memCache())
    expect(seen.privateCalls).toBe(2)
    routing = routingB
    await ModelState.handleMessage("requestVariants", {}, client, () => undefined, memCache())
    expect(seen.privateCalls).toBe(3)
    fs.rmSync(path.join(stateA, "model.json"), { force: true })
  })

  test("model.json path derives only from state", async () => {
    const seen = { privateCalls: 0 }
    setPathPrivateConnection(
      conn({ routing: routingA, onPrivate: (r) => successOutcome(r, stateB, "/other-dir") }, seen),
    )
    const sdkCalls = { count: 0, args: null as unknown[] | null }
    const client = sdkClient({ calls: sdkCalls, data: { state: "/unused" } })
    const posted: Array<{ type: string; variants: Record<string, string> }> = []
    await ModelState.handleMessage(
      "persistVariant",
      { key: "openai/gpt-4.1", value: "high" },
      client,
      () => undefined,
      memCache(),
    )
    expect(seen.privateCalls).toBe(1)
    expect(sdkCalls.count).toBe(0)
    const raw = JSON.parse(fs.readFileSync(path.join(stateB, "model.json"), "utf-8"))
    expect(raw.variant).toEqual({ "openai/gpt-4.1": "high" })
    expect(posted).toEqual([])
    fs.rmSync(path.join(stateB, "model.json"), { force: true })
  })

  test("SDK failure returns empty UI and never caches", async () => {
    const seen = { privateCalls: 0 }
    setPathPrivateConnection(conn({ routing: routingA, available: false }, seen))
    const sdkCalls = { count: 0, args: null as unknown[] | null }
    const client = sdkClient({ calls: sdkCalls, data: {}, throwErr: new Error("sdk down") })
    const posted: unknown[] = []
    await ModelState.handleMessage("requestVariants", {}, client, (m) => posted.push(m), memCache())
    expect(sdkCalls.count).toBe(1)
    expect(posted[0]).toMatchObject({ type: "variantsLoaded", variants: {} })
    const client2 = sdkClient({
      calls: { count: 0, args: null },
      data: { home: "/h", state: stateA, config: "/c", worktree: routingA, directory: routingA },
    })
    await ModelState.handleMessage("requestVariants", {}, client2, () => undefined, memCache())
    fs.rmSync(path.join(stateA, "model.json"), { force: true })
  })
})
