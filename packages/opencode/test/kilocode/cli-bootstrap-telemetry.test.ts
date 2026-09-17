import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { KiloCli } from "../../src/kilocode/cli/setup"
// Direct source imports (not the mocked package specifiers): bun runs all
// test files in one process and cli-shutdown.test.ts mock.modules the
// telemetry/gateway package ids, so package-id imports here would resolve to
// those mocks in a full-suite run. Relative sources always hit the real impl.
import { Identity } from "../../../kilo-telemetry/src/identity"
import { fetchProfile } from "../../../kilo-gateway/src/api/profile"

function deferred<T>() {
  const out = {} as { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void }
  out.promise = new Promise<T>((resolve, reject) => {
    out.resolve = resolve
    out.reject = reject
  })
  return out
}

const noop = () => Promise.resolve()

describe("KiloCli bootstrap telemetry ownership", () => {
  const savedLevel = process.env.KILO_TELEMETRY_LEVEL

  beforeEach(async () => {
    await KiloCli.__resetForTests()
    Identity.reset()
    delete process.env.KILO_TELEMETRY_LEVEL
  })

  afterEach(async () => {
    await KiloCli.__resetForTests()
    Identity.reset()
    if (savedLevel === undefined) delete process.env.KILO_TELEMETRY_LEVEL
    if (savedLevel !== undefined) process.env.KILO_TELEMETRY_LEVEL = savedLevel
  })

  test("explicit all/off skips global config read and forces enabled", async () => {
    for (const level of ["all", "off"] as const) {
      await KiloCli.__resetForTests()
      process.env.KILO_TELEMETRY_LEVEL = level
      const calls: string[] = []
      const seen: boolean[] = []
      await KiloCli.bootstrap({
        jsonBootstrap: noop,
        migrateLegacy: noop,
        getGlobalConfig: () => {
          calls.push("config")
          return Promise.resolve({ experimental: {} })
        },
        getKiloAuth: () => Promise.resolve(undefined),
        initTelemetry: (opts) => {
          seen.push(opts.enabled)
          return Promise.resolve()
        },
        trackStart: () => {},
      })
      expect(calls).toEqual([])
      expect(seen).toEqual([level === "all"])
    }
  })

  test("unset and illegal values keep config fallback semantics", async () => {
    await KiloCli.__resetForTests()
    delete process.env.KILO_TELEMETRY_LEVEL
    const seen: boolean[] = []
    await KiloCli.bootstrap({
      jsonBootstrap: noop,
      migrateLegacy: noop,
      getGlobalConfig: () => Promise.resolve({ experimental: { openTelemetry: false } }),
      getKiloAuth: () => Promise.resolve(undefined),
      initTelemetry: (opts) => {
        seen.push(opts.enabled)
        return Promise.resolve()
      },
      trackStart: () => {},
    })
    expect(seen).toEqual([false])

    await KiloCli.__resetForTests()
    process.env.KILO_TELEMETRY_LEVEL = "maybe"
    const seen2: boolean[] = []
    let configCalls = 0
    await KiloCli.bootstrap({
      jsonBootstrap: noop,
      migrateLegacy: noop,
      getGlobalConfig: () => {
        configCalls += 1
        return Promise.resolve({ experimental: {} })
      },
      getKiloAuth: () => Promise.resolve(undefined),
      initTelemetry: (opts) => {
        seen2.push(opts.enabled)
        return Promise.resolve()
      },
      trackStart: () => {},
    })
    expect(configCalls).toBe(1)
    expect(seen2).toEqual([true])
  })

  test("no auth records CLI_START immediately with no background task", async () => {
    process.env.KILO_TELEMETRY_LEVEL = "all"
    let starts = 0
    await KiloCli.bootstrap({
      jsonBootstrap: noop,
      migrateLegacy: noop,
      getKiloAuth: () => Promise.resolve(undefined),
      initTelemetry: () => Promise.resolve(),
      trackStart: () => {
        starts += 1
      },
    })
    expect(starts).toBe(1)
    expect(KiloCli.__stateForTests().hasTask).toBe(false)
    await KiloCli.waitForIdentityForTests()
    expect(starts).toBe(1)
  })

  test("auth bootstrap does not wait; single CLI_START after settle", async () => {
    process.env.KILO_TELEMETRY_LEVEL = "all"
    const gate = deferred<void>()
    let starts = 0
    let entered = false
    const update = (_token: string, _account?: string, opts?: { signal?: AbortSignal }) => {
      entered = true
      return gate.promise.then(() => {
        if (opts?.signal?.aborted) throw new DOMException("Aborted", "AbortError")
      })
    }
    await KiloCli.bootstrap({
      jsonBootstrap: noop,
      migrateLegacy: noop,
      getKiloAuth: () => Promise.resolve({ token: "tok", account: "acc" }),
      initTelemetry: () => Promise.resolve(),
      updateIdentity: update,
      trackStart: () => {
        starts += 1
      },
    })
    expect(entered).toBe(true)
    expect(starts).toBe(0)
    expect(KiloCli.__stateForTests().hasTask).toBe(true)
    gate.resolve()
    await KiloCli.waitForIdentityForTests()
    expect(starts).toBe(1)
    await KiloCli.waitForIdentityForTests()
    expect(starts).toBe(1)
    expect(KiloCli.__stateForTests().hasTask).toBe(false)
  })

  test("shutdown aborts owned task and settles before exit/export/telemetry shutdown", async () => {
    process.env.KILO_TELEMETRY_LEVEL = "all"
    const order: string[] = []
    const gate = deferred<void>()
    let sawAbort = false
    const update = (_token: string, _account?: string, opts?: { signal?: AbortSignal }) => {
      const sig = opts?.signal
      if (!sig) return gate.promise
      return new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          sawAbort = true
          order.push("identity-settle")
          reject(new DOMException("Aborted", "AbortError"))
        }
        if (sig.aborted) {
          onAbort()
          return
        }
        sig.addEventListener("abort", onAbort, { once: true })
        gate.promise.then(
          () => {
            sig.removeEventListener("abort", onAbort)
            resolve()
          },
          (err: unknown) => {
            sig.removeEventListener("abort", onAbort)
            reject(err)
          },
        )
      })
    }
    await KiloCli.bootstrap({
      jsonBootstrap: noop,
      migrateLegacy: noop,
      getKiloAuth: () => Promise.resolve({ token: "tok" }),
      initTelemetry: () => Promise.resolve(),
      updateIdentity: update,
      trackStart: () => {
        order.push("start")
      },
    })
    expect(KiloCli.__stateForTests().hasTask).toBe(true)
    await KiloCli.shutdown({
      trackExit: () => {
        order.push("exit")
      },
      exportShutdown: () => {
        order.push("export")
        return Promise.resolve()
      },
      telemetryShutdown: () => {
        order.push("telemetry-shutdown")
        return Promise.resolve()
      },
      dispose: () => Promise.resolve(),
      settleTimeoutMs: 1000,
    })
    expect(sawAbort).toBe(true)
    // Abort settles first; CLI_START never fires after shutdown began.
    expect(order).toEqual(["identity-settle", "exit", "export", "telemetry-shutdown"])
    expect(KiloCli.__stateForTests().hasTask).toBe(false)
  })

  test("fetchProfile receives signal and aborts fast", async () => {
    const prior = globalThis.fetch
    const seen: Array<AbortSignal | undefined> = []
    globalThis.fetch = ((...args: unknown[]) => {
      const init = args[1] as { signal?: AbortSignal }
      seen.push(init?.signal)
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
          once: true,
        })
      }) as unknown as Promise<Response>
    }) as typeof fetch
    try {
      const owner = new AbortController()
      const run = fetchProfile("tok", { signal: owner.signal })
      expect(seen.length).toBe(1)
      expect(seen[0]).toBe(owner.signal)
      owner.abort()
      await run.then(
        () => {
          throw new Error("expected abort")
        },
        (err: unknown) => {
          expect(err instanceof DOMException && err.name === "AbortError").toBe(true)
        },
      )
    } finally {
      globalThis.fetch = prior
    }
  })

  test("Identity abort does not enrich; login/logout await keeps order", async () => {
    const prior = globalThis.fetch
    globalThis.fetch = ((...args: unknown[]) => {
      const init = args[1] as { signal?: AbortSignal }
      return new Promise((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"))
          return
        }
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
          once: true,
        })
      }) as unknown as Promise<Response>
    }) as typeof fetch
    try {
      Identity.reset()
      const owner = new AbortController()
      const run = Identity.updateFromKiloAuth("tok", "acc", { signal: owner.signal })
      owner.abort()
      await run.then(
        () => {
          throw new Error("expected abort")
        },
        (err: unknown) => {
          expect(err instanceof DOMException && err.name === "AbortError").toBe(true)
        },
      )
      expect(Identity.getUserId()).toBeNull()
    } finally {
      globalThis.fetch = prior
      Identity.reset()
    }

    // Real login/logout path: awaited, ordered, enrich then clear.
    const prior2 = globalThis.fetch
    const events: string[] = []
    globalThis.fetch = ((...args: unknown[]) => {
      const url = String(args[0])
      expect(url).toContain("/api/profile")
      const body = JSON.stringify({ user: { email: "owner@example.com" } })
      return Promise.resolve(new Response(body, { status: 200 })) as unknown as Promise<Response>
    }) as typeof fetch
    try {
      Identity.reset()
      await Identity.updateFromKiloAuth("tok", "acc")
      events.push("updated")
      expect(Identity.getUserId()).toBe("owner@example.com")
      await Identity.updateFromKiloAuth(null)
      events.push("cleared")
      expect(Identity.getUserId()).toBeNull()
      expect(events).toEqual(["updated", "cleared"])
    } finally {
      globalThis.fetch = prior2
      Identity.reset()
    }
  })
})
