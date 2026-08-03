import { describe, expect, it } from "bun:test"
import type { Config } from "@kilocode/sdk/v2/client"
import { KiloConnectionService } from "../../src/services/cli-backend/connection-service"

// vscode mock is provided by the shared preload (tests/setup/vscode-mock.ts)
const { KiloProvider } = await import("../../src/KiloProvider")

type UpdateMsg = {
  type: "configUpdated" | "configUpdateFailed" | string
  config?: Config
  globalConfig?: Config
  projectConfig?: Config
  saveID?: string
  message?: string
}

type Internals = {
  connectionState: "connecting" | "connected" | "disconnected" | "error"
  connectionGeneration: number
  disposed: boolean
  postMessage: (message: unknown) => void
  handleUpdateConfig: (
    partial: Partial<Config>,
    project?: Partial<Config>,
    globalUnset?: string[][],
    projectUnset?: string[][],
    saveID?: string,
  ) => Promise<void>
  handleEvent: (event: unknown, directory?: string) => void
  cachedConfigMessage: unknown
  cachedGlobalConfig: Config | null
  pending: number
  fetchAndSendConfig: () => Promise<void>
  fetchAndSendProviders: () => Promise<void>
  fetchAndSendAgents: () => Promise<void>
  queueReconcile: () => void
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * Deterministic fake clock for the injected retry scheduler (LOCK-003) —
 * no real-time sleeps. `tick` fires only timers due at or before the new time,
 * matching setTimeout semantics; timers scheduled during a tick are not fired
 * until a later tick.
 */
function fakeClock() {
  let now = 0
  let nextID = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    schedule: (delay: number, fn: () => void) => {
      const id = nextID++
      timers.set(id, { at: now + delay, fn })
      return () => {
        timers.delete(id)
      }
    },
    tick(ms: number) {
      now += ms
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id)
          t.fn()
        }
      }
    },
    pending: () => timers.size,
  }
}

type MockOpts = {
  /** Thrown by transaction for the config save. */
  failTransaction?: unknown
  /** Data returned by the transaction. */
  transactionData?: { global: Config; project: Config; effective: Config }
  /** Per-call merged config GET; defaults to resolved data. */
  configGet?: () => Promise<{ data: Config }>
  /** Per-call global config GET. */
  globalGet?: () => Promise<{ data: Config }>
}

/**
 * Real KiloConnectionService with an injected SDK client, driven through its
 * actual SSE dispatch (handleSseEvent) so tests exercise the production
 * revision/coalescing ownership (LOCK-001/002) rather than a mock.
 */
function createConnection(opts: MockOpts = {}) {
  const transactions: Array<Record<string, unknown>> = []
  let getCalls = 0
  const client = {
    global: {
      config: {
        get: async () => (opts.globalGet ? opts.globalGet() : { data: { username: "g" } }),
        update: async () => ({ data: {} }),
      },
    },
    config: {
      get: async () => {
        getCalls += 1
        return opts.configGet ? opts.configGet() : { data: { model: "m", username: "g" } }
      },
      update: async () => ({ data: {} }),
      overlay: async () => ({ data: { project: { model: "m" } } }),
      transaction: async (params: Record<string, unknown>) => {
        transactions.push(params)
        if (opts.failTransaction !== undefined) throw opts.failTransaction
        return {
          data: opts.transactionData ?? {
            global: { username: "g" },
            project: { model: "m" },
            effective: { model: "m", username: "g" },
          },
        }
      },
    },
  }
  const service = new KiloConnectionService({} as never)
  ;(service as { client: unknown }).client = client
  ;(service as { state: string }).state = "connected"
  return {
    transactions,
    service,
    client,
    getCalls: () => getCalls,
    /**
     * Simulate the backend SSE echo of one logical transaction: the backend
     * emits one global.config.updated per changed scope (project + global),
     * all tagged with the same transaction id, delivered through the real
     * connection-service dispatch (LOCK-004).
     */
    sseConfigUpdated: (scopes: string[] = ["global", "/repo"]) => {
      const tx = crypto.randomUUID()
      for (const scope of scopes) {
        // The transaction id travels on the SSE envelope (third dispatch arg),
        // mirroring how the SDK's GlobalEvent exposes it next to the payload.
        service.handleSseEvent({ id: crypto.randomUUID(), type: "global.config.updated", properties: {} }, scope, tx)
      }
    },
    /** Flush microtask queues deterministically (coalesced advance + async fetch). */
    flush: async (times = 30) => {
      for (let i = 0; i < times; i++) await Promise.resolve()
    },
  }
}

function makeProvider(conn: ReturnType<typeof createConnection>, clock?: ReturnType<typeof fakeClock>) {
  const opts = clock ? { scheduleRetry: clock.schedule } : {}
  const provider = new KiloProvider({} as never, conn.service as never, undefined, opts as never)
  const internal = provider as unknown as Internals
  internal.connectionState = "connected"
  const messages: UpdateMsg[] = []
  internal.postMessage = (msg) => messages.push(msg as UpdateMsg)
  internal.fetchAndSendProviders = async () => {}
  internal.fetchAndSendAgents = async () => {}
  // Subscribe to config revision advances like initializeConnection does.
  // This is needed for reconciliation to trigger on SSE-driven revision advances.
  conn.service.onConfigRevision(() => internal.queueReconcile())
  return { provider, internal, messages, conn, clock }
}

describe("KiloProvider config save lifecycle", () => {
  it("acknowledges a mixed global/project save immediately from one transaction", async () => {
    const conn = createConnection({
      transactionData: {
        global: { snapshot: true },
        project: { model: "new-model", snapshot: true },
        effective: { model: "new-model", snapshot: true },
      },
    })
    const { internal, messages } = makeProvider(conn)

    await internal.handleUpdateConfig({ snapshot: true }, { model: "new-model" }, [], [], "s1")

    // Exactly one transaction request
    expect(conn.transactions).toHaveLength(1)
    const tx = conn.transactions[0]
    expect(tx.global).toEqual({ set: { snapshot: true }, unset: [] })
    expect(tx.project).toEqual({ set: { model: "new-model" }, unset: [] })
    const ack = messages.find((m) => m.type === "configUpdated")
    // Authoritative transaction response
    expect(ack?.config).toEqual({ model: "new-model", snapshot: true })
    expect(ack?.globalConfig).toEqual({ snapshot: true })
    expect(ack?.projectConfig).toEqual({ model: "new-model", snapshot: true })
    expect(ack?.saveID).toBe("s1")
    expect(messages.some((m) => m.type === "configUpdateFailed")).toBe(false)
  })

  it("global-only saves send only the global scope in the transaction", async () => {
    const conn = createConnection({
      transactionData: {
        global: { username: "new" },
        project: {},
        effective: { model: "m", username: "new" },
      },
    })
    const { internal, messages } = makeProvider(conn)

    await internal.handleUpdateConfig({ username: "new" }, {}, [], [], "s1")

    expect(conn.transactions).toHaveLength(1)
    const tx = conn.transactions[0]
    expect(tx.global).toEqual({ set: { username: "new" }, unset: [] })
    // project is not sent for global-only saves
    expect(tx.project).toBeUndefined()
    const ack = messages.find((m) => m.type === "configUpdated")
    expect(ack?.config).toEqual({ model: "m", username: "new" })
    expect(ack?.globalConfig).toEqual({ username: "new" })
  })

  it("project-only saves send only the project scope in the transaction", async () => {
    const conn = createConnection({
      transactionData: {
        global: { username: "g" },
        project: { model: "new-model" },
        effective: { model: "new-model", username: "g" },
      },
    })
    const { internal, messages } = makeProvider(conn)

    await internal.handleUpdateConfig({}, { model: "new-model" }, [], [], "s1")

    expect(conn.transactions).toHaveLength(1)
    const tx = conn.transactions[0]
    expect(tx.global).toBeUndefined()
    expect(tx.project).toEqual({ set: { model: "new-model" }, unset: [] })
    const ack = messages.find((m) => m.type === "configUpdated")
    expect(ack?.config).toEqual({ model: "new-model", username: "g" })
    expect(ack?.projectConfig).toEqual({ model: "new-model" })
  })

  it("does not drain or reject pending permissions/questions before saving", async () => {
    const conn = createConnection({
      transactionData: { global: { snapshot: true }, project: {}, effective: { snapshot: true } },
    })
    const { internal, messages } = makeProvider(conn)

    await internal.handleUpdateConfig({ snapshot: true }, {}, [], [], "s1")

    expect(messages.some((m) => m.type === "configUpdated")).toBe(true)
    expect(messages.some((m) => m.type === "configUpdateFailed")).toBe(false)
  })

  it("sends the save acknowledgement and returns even when reconciliation is held forever", async () => {
    const held = deferred<{ data: Config }>()
    const conn = createConnection({
      transactionData: { global: { snapshot: true }, project: {}, effective: { snapshot: true } },
      configGet: () => held.promise,
    })
    const { internal, messages } = makeProvider(conn)

    await internal.handleUpdateConfig({ snapshot: true }, {}, [], [], "s1")

    const ack = messages.find((m) => m.type === "configUpdated")
    expect(ack?.config).toEqual({ snapshot: true })
    expect(ack?.saveID).toBe("s1")
    expect(internal.cachedConfigMessage).toBeNull() // reconciliation never resolved
  })

  it("posts configUpdateFailed with the real backend detail and never claims success", async () => {
    const err = new Error("schema validation failed")
    ;(err as { data?: unknown }).data = { issues: [{ code: "invalid_type" }] }
    const conn = createConnection({ failTransaction: err })
    const { internal, messages } = makeProvider(conn)

    await internal.handleUpdateConfig({ model: "bad" }, {}, [], [], "s1")

    const failed = messages.find((m) => m.type === "configUpdateFailed")
    expect(failed?.message).toBe("schema validation failed")
    expect(failed?.saveID).toBe("s1")
    expect(messages.some((m) => m.type === "configUpdated")).toBe(false)
  })

  it("does not advance the shared revision or reconcile when the transaction fails (LOCK-001)", async () => {
    const conn = createConnection({ failTransaction: new Error("boom") })
    let revisions = 0
    conn.service.onConfigRevision(() => {
      revisions += 1
    })
    const { internal, messages } = makeProvider(conn)

    await internal.handleUpdateConfig({ model: "bad" }, {}, [], [], "s1")
    await conn.flush()

    expect(revisions).toBe(0)
    expect(conn.getCalls()).toBe(0)
    expect(messages.some((m) => m.type === "configUpdateFailed")).toBe(true)
  })

  it("decrements pending exactly once in finally even when the ack post throws (LOCK-004)", async () => {
    const conn = createConnection({
      transactionData: { global: { snapshot: true }, project: {}, effective: { snapshot: true } },
    })
    const { provider, internal, messages } = makeProvider(conn)
    const origPost = internal.postMessage
    internal.postMessage = (msg) => {
      if ((msg as { type?: string }).type === "configUpdated") throw new Error("synchronous post failure")
      return origPost(msg)
    }

    await internal.handleUpdateConfig({ snapshot: true }, {}, [], [], "s1")

    expect(internal.pending).toBe(0)
    expect(messages.some((m) => m.type === "configUpdateFailed")).toBe(true)
    expect(provider).toBeTruthy()
  })

  it("drops the first save's reconciliation once a second save supersedes it", async () => {
    const firstGet = deferred<{ data: Config }>()
    const conn = createConnection({
      transactionData: { global: { model: "a" }, project: {}, effective: { model: "a" } },
      configGet: () => {
        if (conn.getCalls() === 1) return firstGet.promise
        return Promise.resolve({ data: { model: "b" } })
      },
    })
    const { internal, messages } = makeProvider(conn)

    await internal.handleUpdateConfig({ model: "a" }, {}, [], [], "s1")
    // Canonical SSE echo of save 1 — one coalesced logical revision.
    conn.sseConfigUpdated()
    await conn.flush()
    expect(conn.getCalls()).toBe(1) // one fetch sequence for revision 1

    await internal.handleUpdateConfig({ model: "b" }, {}, [], [], "s2")
    conn.sseConfigUpdated()
    await conn.flush()

    // Release save 1's held reconciliation — it must not overwrite save 2.
    firstGet.resolve({ data: { model: "a" } })
    await conn.flush()

    const updates = messages.filter((m) => m.type === "configUpdated")
    // ack s1, ack s2, reconcile of save 2 only
    expect(updates.map((u) => u.saveID)).toEqual(["s1", "s2", undefined])
    expect(updates.some((u) => u.saveID === undefined && u.config?.model === "a")).toBe(false)
    expect(updates.some((u) => u.saveID === undefined && u.config?.model === "b")).toBe(true)
  })

  it("coalesces SSE echoes into the in-flight reconciliation and drops stale results", async () => {
    const held = deferred<{ data: Config }>()
    const conn = createConnection({
      transactionData: { global: { model: "a" }, project: {}, effective: { model: "a" } },
      configGet: () => {
        if (conn.getCalls() === 1) return held.promise
        return Promise.resolve({ data: { model: "b" } })
      },
    })
    const { internal, messages } = makeProvider(conn)

    await internal.handleUpdateConfig({ model: "a" }, {}, [], [], "s1")
    // The canonical SSE echo drives exactly one revision advance and one fetch.
    conn.sseConfigUpdated()
    await conn.flush()
    expect(conn.getCalls()).toBe(1) // deduped — no duplicate fetch

    // A newer save supersedes; the held stale fetch must not post.
    await internal.handleUpdateConfig({ model: "b" }, {}, [], [], "s2")
    conn.sseConfigUpdated()
    await conn.flush()
    held.resolve({ data: { model: "a" } })
    await conn.flush()

    const updates = messages.filter((m) => m.type === "configUpdated")
    expect(updates.some((u) => u.saveID === undefined && u.config?.model === "a")).toBe(false)
    expect(updates.some((u) => u.saveID === undefined && u.config?.model === "b")).toBe(true)
  })

  it("coalesces one transaction's per-scope echoes into one revision and one fetch (LOCK-001/002)", async () => {
    const conn = createConnection({
      transactionData: { global: { model: "a" }, project: { model: "a" }, effective: { model: "a" } },
      configGet: () => Promise.resolve({ data: { model: "a" } }),
    })
    const revisions: number[] = []
    conn.service.onConfigRevision(() => revisions.push(conn.service.getConfigRevision()))
    const { internal, messages } = makeProvider(conn)

    await internal.handleUpdateConfig({ model: "a" }, { model: "a" }, [], [], "s1")

    // Backend emits one global.config.updated per changed scope (project + global)
    // for the single transaction; the real dispatch coalesces the burst.
    conn.sseConfigUpdated(["global", "/repo"])
    await conn.flush()

    expect(revisions).toEqual([1]) // exactly one logical revision
    expect(conn.getCalls()).toBe(1) // one fetch sequence per revision
    const updates = messages.filter((m) => m.type === "configUpdated")
    expect(updates.some((u) => u.saveID === undefined && u.config?.model === "a")).toBe(true)
  })

  it("does not drop unrelated external edits arriving in a separate task", async () => {
    const conn = createConnection()
    const revisions: number[] = []
    conn.service.onConfigRevision(() => revisions.push(conn.service.getConfigRevision()))

    // One logical transaction → one revision.
    conn.sseConfigUpdated()
    await conn.flush()
    expect(revisions).toEqual([1])

    // A later, unrelated external edit (separate task) → a fresh revision.
    conn.sseConfigUpdated()
    await conn.flush()
    expect(revisions).toEqual([1, 2])
  })

  it("reconciles a foreign save from a second provider sharing the connection (LOCK-005)", async () => {
    const conn = createConnection({
      transactionData: {
        global: { username: "new" },
        project: {},
        effective: { username: "new", model: "m" },
      },
      configGet: () => Promise.resolve({ data: { username: "new", model: "m" } }),
    })
    // Provider A (sidebar) saves; provider B (settings panel) shares the
    // connection and must converge via the shared revision advance.
    const a = makeProvider(conn)
    const b = makeProvider(conn)
    a.internal.cachedConfigMessage = { config: { username: "old", model: "m" }, projectConfig: { model: "m" } }
    b.internal.cachedConfigMessage = { config: { username: "old", model: "m" }, projectConfig: { model: "m" } }

    await a.internal.handleUpdateConfig({ username: "new" }, {}, [], [], "uuid-a")

    // The SSE echo reaches the connection service which advances the shared
    // revision; both providers' onConfigRevision subscriptions trigger reconcile.
    conn.sseConfigUpdated()
    await conn.flush()

    const aPosts = a.messages.filter((m) => m.type === "configUpdated")
    const bPosts = b.messages.filter((m) => m.type === "configUpdated")
    // Both windows converge on the reconciled config (no saveID = reconcile).
    expect(aPosts.some((m) => m.saveID === undefined && m.config?.username === "new")).toBe(true)
    expect(bPosts.some((m) => m.saveID === undefined && m.config?.username === "new")).toBe(true)
    expect(conn.getCalls()).toBeGreaterThanOrEqual(2)
  })

  it("drops a foreign window's stale reconciliation once the shared revision advances", async () => {
    const held = deferred<{ data: Config }>()
    const conn = createConnection({
      transactionData: {
        global: { username: "first" },
        project: {},
        effective: { username: "first" },
      },
      configGet: () => {
        if (conn.getCalls() <= 2) return held.promise // Both A and B reconcile when A saves
        return Promise.resolve({ data: { username: "second" } })
      },
    })
    const a = makeProvider(conn)
    const b = makeProvider(conn)

    // Window A saves (revision 1) — both A and B reconcile (revision advance
    // notifies all subscribers), but A's fetch is held.
    await a.internal.handleUpdateConfig({ username: "first" }, {}, [], [], "uuid-a")
    conn.sseConfigUpdated()
    await conn.flush()
    expect(conn.getCalls()).toBe(2) // one fetch per provider

    // Window B saves (revision 2) — this advances the SHARED revision, so A's
    // held fetch must be dropped and re-run against the latest revision.
    await b.internal.handleUpdateConfig({ username: "second" }, {}, [], [], "uuid-b")
    conn.sseConfigUpdated()
    await conn.flush()
    held.resolve({ data: { username: "first" } })
    await conn.flush()

    const aPosts = a.messages.filter((m) => m.type === "configUpdated")
    const bPosts = b.messages.filter((m) => m.type === "configUpdated")
    expect(aPosts.some((m) => m.saveID === undefined && m.config?.username === "first")).toBe(false)
    expect(aPosts.some((m) => m.saveID === undefined && m.config?.username === "second")).toBe(true)
    expect(bPosts.some((m) => m.saveID === undefined && m.config?.username === "second")).toBe(true)
  })

  it("reflects the transaction response data for project/global mixed saves in one ack", async () => {
    const conn = createConnection({
      transactionData: {
        global: { commit_message: { prompt: "global" } },
        project: { commit_message: { prompt: "project" }, model: "pm" },
        effective: { commit_message: { prompt: "project" }, model: "pm" },
      },
    })
    const { internal, messages } = makeProvider(conn)

    await internal.handleUpdateConfig(
      { commit_message: { prompt: "global" } },
      { commit_message: { prompt: "project" } },
      [],
      [],
      "s1",
    )

    const ack = messages.find((m) => m.type === "configUpdated")
    // Authoritative transaction response
    expect(ack?.config).toEqual({ commit_message: { prompt: "project" }, model: "pm" })
    expect(ack?.globalConfig).toEqual({ commit_message: { prompt: "global" } })
    expect(ack?.projectConfig).toEqual({ commit_message: { prompt: "project" }, model: "pm" })
  })

  it("propagates the failure saveID to configUpdateFailed", async () => {
    const conn = createConnection({ failTransaction: new Error("boom") })
    const { internal, messages } = makeProvider(conn)

    await internal.handleUpdateConfig({ snapshot: true }, {}, [], [], "uuid-1")

    const failed = messages.find((m) => m.type === "configUpdateFailed")
    expect(failed?.saveID).toBe("uuid-1")
  })

  it("sends unset paths in the transaction request", async () => {
    const conn = createConnection({
      transactionData: {
        global: { disabled_providers: ["openai"] },
        project: {},
        effective: { disabled_providers: ["openai"] },
      },
    })
    const { internal, messages } = makeProvider(conn)

    await internal.handleUpdateConfig(
      { disabled_providers: ["openai"] },
      {},
      [["provider", "myprovider"]],
      [],
      "s1",
    )

    expect(conn.transactions).toHaveLength(1)
    const tx = conn.transactions[0]
    expect(tx.global).toEqual({ set: { disabled_providers: ["openai"] }, unset: [["provider", "myprovider"]] })
    const ack = messages.find((m) => m.type === "configUpdated")
    expect(ack?.saveID).toBe("s1")
  })
})

describe("KiloProvider reconciliation retry state machine (LOCK-003/004/005)", () => {
  it("failure enters exactly one bounded backoff and succeeds on retry — no immediate loop", async () => {
    const clock = fakeClock()
    let fail = true
    const conn = createConnection({
      transactionData: { global: { model: "m" }, project: {}, effective: { model: "m" } },
      configGet: () => {
        if (fail) return Promise.reject(new Error("reconcile boom"))
        return Promise.resolve({ data: { model: "m" } })
      },
    })
    const { internal, messages } = makeProvider(conn, clock)

    await internal.handleUpdateConfig({ model: "m" }, {}, [], [], "s1")
    conn.sseConfigUpdated()
    await conn.flush()

    // One fetch attempt; the failure scheduled exactly one bounded backoff — no immediate re-fetch.
    expect(conn.getCalls()).toBe(1)
    expect(clock.pending()).toBe(1)

    fail = false
    clock.tick(1_000) // 1s backoff elapses
    await conn.flush()

    expect(conn.getCalls()).toBe(2)
    expect(clock.pending()).toBe(0) // success canceled/consumed the retry
    const updates = messages.filter((m) => m.type === "configUpdated")
    expect(updates.some((u) => u.saveID === undefined)).toBe(true)
    // Nothing fires after the successful reconcile.
    clock.tick(60_000)
    await conn.flush()
    expect(conn.getCalls()).toBe(2)
  })

  it("escalates backoff across repeated failures (1s, 2s, 5s, 10s)", async () => {
    const clock = fakeClock()
    const conn = createConnection({
      transactionData: { global: { model: "m" }, project: {}, effective: { model: "m" } },
      configGet: () => Promise.reject(new Error("reconcile boom")),
    })
    const { internal } = makeProvider(conn, clock)

    await internal.handleUpdateConfig({ model: "m" }, {}, [], [], "s1")
    conn.sseConfigUpdated()
    await conn.flush()
    expect(conn.getCalls()).toBe(1)

    clock.tick(999)
    await conn.flush()
    expect(conn.getCalls()).toBe(1) // 1s not yet due

    clock.tick(1)
    await conn.flush()
    expect(conn.getCalls()).toBe(2) // 1s retry fired → next delay is 2s

    clock.tick(1_999)
    await conn.flush()
    expect(conn.getCalls()).toBe(2) // 2s not yet due

    clock.tick(1)
    await conn.flush()
    expect(conn.getCalls()).toBe(3) // 2s retry fired → next delay is 5s

    clock.tick(4_999)
    await conn.flush()
    expect(conn.getCalls()).toBe(3) // 5s not yet due

    clock.tick(1)
    await conn.flush()
    expect(conn.getCalls()).toBe(4) // 5s retry fired → next delay is 10s

    clock.tick(9_999)
    await conn.flush()
    expect(conn.getCalls()).toBe(4) // 10s not yet due

    clock.tick(1)
    await conn.flush()
    expect(conn.getCalls()).toBe(5) // 10s retry fired → next delay caps at 30s
    expect(clock.pending()).toBe(1) // next backoff already scheduled
  })

  it("a newer revision cancels the obsolete retry timer and resets the backoff", async () => {
    const clock = fakeClock()
    let failFirst = true
    const conn = createConnection({
      transactionData: { global: { model: "b" }, project: {}, effective: { model: "b" } },
      configGet: () => {
        if (failFirst) {
          failFirst = false
          return Promise.reject(new Error("reconcile boom"))
        }
        return Promise.resolve({ data: { model: "b" } })
      },
    })
    const { internal, messages } = makeProvider(conn, clock)

    await internal.handleUpdateConfig({ model: "a" }, {}, [], [], "s1")
    conn.sseConfigUpdated() // revision 1
    await conn.flush()
    expect(conn.getCalls()).toBe(1) // fetch failed
    expect(clock.pending()).toBe(1) // 1s retry timer pending

    // Second save supersedes — its echo advances the revision, which cancels
    // the old retry timer and reconciles immediately for the latest revision.
    await internal.handleUpdateConfig({ model: "b" }, {}, [], [], "s2")
    conn.sseConfigUpdated() // revision 2
    await conn.flush()

    expect(clock.pending()).toBe(0) // obsolete timer canceled
    // Advancing far past the old deadline fires nothing extra.
    clock.tick(60_000)
    await conn.flush()
    const after = conn.getCalls()
    clock.tick(60_000)
    await conn.flush()
    expect(conn.getCalls()).toBe(after)
    expect(messages.some((m) => m.type === "configUpdated" && m.saveID === undefined)).toBe(true)
  })

  it("dispose invalidates a held result, prevents post, and makes queueReconcile a no-op (LOCK-004)", async () => {
    const held = deferred<{ data: Config }>()
    const conn = createConnection({
      transactionData: { global: { model: "a" }, project: {}, effective: { model: "a" } },
      configGet: () => held.promise,
    })
    const { provider, internal, messages } = makeProvider(conn)

    await internal.handleUpdateConfig({ model: "a" }, {}, [], [], "s1")
    conn.sseConfigUpdated()
    await conn.flush()
    expect(conn.getCalls()).toBe(1) // held fetch in flight

    provider.dispose()
    held.resolve({ data: { model: "a" } })
    await conn.flush()

    const updates = messages.filter((m) => m.type === "configUpdated")
    expect(updates.some((u) => u.saveID === undefined)).toBe(false) // held result never posted
    expect(internal.disposed).toBe(true)

    // queueReconcile after disposal is a no-op.
    internal.queueReconcile()
    await conn.flush()
    expect(conn.getCalls()).toBe(1)
  })

  it("reconnect epoch invalidation drops a held result and schedules only the latest attempt (LOCK-004/005)", async () => {
    const held = deferred<{ data: Config }>()
    const conn = createConnection({
      transactionData: { global: { model: "a" }, project: {}, effective: { model: "a" } },
      configGet: () => {
        if (conn.getCalls() === 1) return held.promise
        return Promise.resolve({ data: { model: "m" } })
      },
    })
    const { internal, messages } = makeProvider(conn)

    await internal.handleUpdateConfig({ model: "a" }, {}, [], [], "s1")
    conn.sseConfigUpdated()
    await conn.flush()
    expect(conn.getCalls()).toBe(1) // held fetch (epoch 0) in flight

    // Backend reconnect: provider lifecycle epoch advances.
    internal.connectionGeneration += 1
    held.resolve({ data: { model: "a" } })
    await conn.flush()

    // The held fetch (epoch 0) never posts; the latest attempt re-fetches.
    const updates = messages.filter((m) => m.type === "configUpdated")
    expect(updates.some((u) => u.saveID === undefined && u.config?.model === "a")).toBe(false)
    expect(updates.some((u) => u.saveID === undefined && u.config?.model === "m")).toBe(true)
  })

  it("backoff retry is a no-op after dispose — the timer callback never re-runs the fetch", async () => {
    const clock = fakeClock()
    let fail = true
    const conn = createConnection({
      transactionData: { global: { model: "m" }, project: {}, effective: { model: "m" } },
      configGet: () => {
        if (fail) return Promise.reject(new Error("reconcile boom"))
        return Promise.resolve({ data: { model: "m" } })
      },
    })
    const { provider, internal, messages } = makeProvider(conn, clock)

    await internal.handleUpdateConfig({ model: "m" }, {}, [], [], "s1")
    conn.sseConfigUpdated()
    await conn.flush()
    expect(clock.pending()).toBe(1)

    provider.dispose() // cancels the retry timer
    expect(clock.pending()).toBe(0)

    clock.tick(60_000)
    await conn.flush()
    expect(conn.getCalls()).toBe(1) // no retry after dispose
    expect(internal.disposed).toBe(true)
  })
})

describe("fetchAndSendConfig lifecycle guards (LOCK-002)", () => {
  it("dispose during a held fetch prevents the post and cache mutation", async () => {
    const held = deferred<{ data: Config }>()
    const conn = createConnection({ configGet: () => held.promise })
    const { provider, internal, messages } = makeProvider(conn)

    const run = internal.fetchAndSendConfig()
    await conn.flush()
    expect(conn.getCalls()).toBe(1) // held fetch in flight

    provider.dispose()
    held.resolve({ data: { model: "m" } })
    await run
    await conn.flush()

    // The held result never posts and never mutates the cache.
    expect(messages.some((m) => m.type === "configLoaded")).toBe(false)
    expect(internal.cachedConfigMessage).toBeNull()
  })

  it("reconnect during a held fetch drops the stale result (epoch + client replaced)", async () => {
    const held = deferred<{ data: Config }>()
    const conn = createConnection({
      configGet: () => {
        if (conn.getCalls() === 1) return held.promise
        return Promise.resolve({ data: { model: "second" } })
      },
    })
    const { internal, messages } = makeProvider(conn)

    const run = internal.fetchAndSendConfig()
    await conn.flush()
    expect(conn.getCalls()).toBe(1) // held fetch (epoch 0, old client) in flight

    // Backend reconnect: lifecycle epoch advances and the client is replaced.
    internal.connectionGeneration += 1
    ;(conn.service as { client: unknown }).client = { ...conn.client }
    held.resolve({ data: { model: "first" } })
    await run
    await conn.flush()

    // The held fetch from the old lifecycle never posts its stale result.
    expect(
      messages.some((m) => m.type === "configLoaded" && (m as { config?: Config }).config?.model === "first"),
    ).toBe(false)
  })

  it("revision advance during a held fetch drops the stale result; reconcile owns the refetch", async () => {
    const held = deferred<{ data: Config }>()
    const conn = createConnection({
      configGet: () => {
        if (conn.getCalls() === 1) return held.promise
        return Promise.resolve({ data: { model: "second" } })
      },
    })
    const { internal, messages } = makeProvider(conn)

    const run = internal.fetchAndSendConfig()
    await conn.flush()
    expect(conn.getCalls()).toBe(1) // held fetch in flight

    // Shared config revision advances while the ordinary fetch is held; the
    // reconcile path (subscribed in makeProvider) refetches the new revision.
    conn.service.advanceConfigRevision()
    held.resolve({ data: { model: "first" } })
    await run
    await conn.flush()

    // The stale ordinary fetch never posts its held result...
    expect(
      messages.some((m) => m.type === "configLoaded" && (m as { config?: Config }).config?.model === "first"),
    ).toBe(false)
    // ...and the reconcile/connect path owns the refetch (cache reflects the new revision).
    expect((internal.cachedConfigMessage as { config?: Config } | null)?.config?.model).toBe("second")
  })
})
