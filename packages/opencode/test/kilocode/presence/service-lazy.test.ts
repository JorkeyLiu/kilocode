import { describe, expect, test } from "bun:test"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { Auth } from "@/auth"
import { KiloViewers } from "@/kilocode/presence/service"
import fs from "node:fs"
import path from "node:path"

const uid = "11111111-1111-4111-8111-111111111111"
const uidB = "22222222-2222-4222-8222-222222222222"

type Snap = {
  viewer: { id: string; active: boolean; sequence: number }
  attached: readonly string[]
  visible: readonly string[]
}

const authLayer = Layer.succeed(
  Auth.Service,
  Auth.Service.of({
    get: () => Effect.succeed(undefined),
    all: () => Effect.succeed({} as never),
    set: () => Effect.void,
    remove: () => Effect.void,
  }),
)

function fakeAuthLayer() {
  return authLayer
}

function buildCtx(load: () => Promise<KiloViewers.SessionsPort>, attached: string[][], loads: { n: number }) {
  const counting = () => {
    loads.n += 1
    return load()
  }
  const layer = KiloViewers.makeLayer({ loadSessions: counting }).pipe(Layer.provide(fakeAuthLayer()))
  return layer
}

async function withScope<T>(layer: Layer.Layer<KiloViewers.Service>, body: (svc: KiloViewers.Interface) => Promise<T>) {
  const scope = Effect.runSync(Scope.make())
  try {
    const ctx = await Effect.runPromise(Layer.buildWithScope(layer, scope))
    const svc = Context.get(ctx, KiloViewers.Service)
    return await body(svc)
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
}

function runEffect<T>(effect: Effect.Effect<T>): Promise<T> {
  return Effect.runPromise(effect)
}

async function pollFor(cond: () => boolean, message: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (cond()) return
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${message}`)
    await Bun.sleep(5)
  }
}

describe("KiloViewers lazy kilo-sessions load", () => {
  test("layer build alone never loads the heavy graph", async () => {
    const attached: string[][] = []
    const loads = { n: 0 }
    const layer = buildCtx(
      async () => ({ setAttachedSessions: (ids) => void attached.push([...ids]) }),
      attached,
      loads,
    )
    await withScope(layer, async () => {})
    expect(loads.n).toBe(0)
    expect(attached).toEqual([])
  })

  test("dispose before any viewed never loads and never touches attachment", async () => {
    const attached: string[][] = []
    const loads = { n: 0 }
    const layer = buildCtx(
      async () => ({ setAttachedSessions: (ids) => void attached.push([...ids]) }),
      attached,
      loads,
    )
    const scope = Effect.runSync(Scope.make())
    const ctx = await runEffect(Layer.buildWithScope(layer, scope))
    expect(Context.get(ctx, KiloViewers.Service)).toBeDefined()
    expect(loads.n).toBe(0)
    await runEffect(Scope.close(scope, Exit.void))
    expect(loads.n).toBe(0)
    expect(attached).toEqual([])
  })

  test("first viewed loads once and retains the memo for later updates", async () => {
    const attached: string[][] = []
    const loads = { n: 0 }
    const layer = buildCtx(
      async () => ({ setAttachedSessions: (ids) => void attached.push([...ids]) }),
      attached,
      loads,
    )
    await withScope(layer, async (svc) => {
      expect(loads.n).toBe(0)
      await runEffect(svc.update({ viewer: { id: uid, active: false, sequence: 1 }, attached: ["ses_a"], visible: [] }))
      expect(loads.n).toBe(1)
      expect(attached).toEqual([["ses_a"]])
      await runEffect(svc.update({ viewer: { id: uid, active: false, sequence: 2 }, attached: ["ses_b"], visible: [] }))
      expect(loads.n).toBe(1)
      expect(attached).toEqual([["ses_a"], ["ses_b"]])
    })
    // Scope close runs the finalizer clear on the settled loader.
    expect(attached.at(-1)).toEqual([])
    expect(loads.n).toBe(1)
  })

  test("concurrent first updates singleflight one load and keep the latest sequence", async () => {
    const attached: string[][] = []
    const loads = { n: 0 }
    let release!: (api: KiloViewers.SessionsPort) => void
    const gate = new Promise<KiloViewers.SessionsPort>((res) => {
      release = res
    })
    const layer = buildCtx(() => gate, attached, loads)
    await withScope(layer, async (svc) => {
      const snap = (sequence: number, id: string): Snap => ({
        viewer: { id: uid, active: false, sequence },
        attached: [id],
        visible: [],
      })
      const both = runEffect(
        Effect.all([svc.update(snap(1, "ses_old")), svc.update(snap(2, "ses_new"))], { concurrency: 2 }),
      )
      await pollFor(() => loads.n === 1, "singleflight load started")
      expect(loads.n).toBe(1)
      release({ setAttachedSessions: (ids) => void attached.push([...ids]) })
      await both
      const nonEmpty = attached.filter((c) => c.length > 0)
      expect(nonEmpty.at(-1)).toEqual(["ses_new"])
      expect(loads.n).toBe(1)
    })
  })

  test("presence disabled still maintains attachment on first viewed", async () => {
    const prev = process.env.KILO_DISABLE_PRESENCE
    process.env.KILO_DISABLE_PRESENCE = "1"
    try {
      const attached: string[][] = []
      const loads = { n: 0 }
      const layer = buildCtx(
        async () => ({ setAttachedSessions: (ids) => void attached.push([...ids]) }),
        attached,
        loads,
      )
      await withScope(layer, async (svc) => {
        await runEffect(svc.update({ viewer: { id: uid, active: true, sequence: 1 }, attached: ["ses_a"], visible: ["ses_a"] }))
        expect(loads.n).toBe(1)
        expect(attached[0]).toEqual(["ses_a"])
      })
    } finally {
      if (prev === undefined) delete process.env.KILO_DISABLE_PRESENCE
      else process.env.KILO_DISABLE_PRESENCE = prev
    }
  })

  test("dispose during load waits owned settle, clears once, no post-dispose push", async () => {
    const attached: string[][] = []
    const loads = { n: 0 }
    let release!: (api: KiloViewers.SessionsPort) => void
    const gate = new Promise<KiloViewers.SessionsPort>((res) => {
      release = res
    })
    const layer = buildCtx(() => gate, attached, loads)
    const scope = Effect.runSync(Scope.make())
    const ctx = await runEffect(Layer.buildWithScope(layer, scope))
    const svc = Context.get(ctx, KiloViewers.Service)
    const updatePromise = runEffect(
      svc.update({ viewer: { id: uid, active: false, sequence: 1 }, attached: ["ses_a"], visible: [] }),
    )
    await pollFor(() => loads.n === 1, "load started before dispose")
    const closePromise = runEffect(Scope.close(scope, Exit.void))
    // Let the finalizer reach its owned wait on the same gate.
    await Bun.sleep(20)
    release({ setAttachedSessions: (ids) => void attached.push([...ids]) })
    await closePromise
    await updatePromise
    expect(loads.n).toBe(1)
    // Only the owned finalizer clear runs; the in-flight update skips its
    // stale push after seeing disposed.
    expect(attached).toEqual([[]])
  })

  test("load failure propagates and the memo is cleared for retry", async () => {
    const attached: string[][] = []
    const loads = { n: 0 }
    let failNext = true
    const layer = buildCtx(
      async () => {
        if (failNext) throw new Error("boom-load")
        return { setAttachedSessions: (ids) => void attached.push([...ids]) }
      },
      attached,
      loads,
    )
    await withScope(layer, async (svc) => {
      await expect(
        runEffect(svc.update({ viewer: { id: uid, active: false, sequence: 1 }, attached: ["ses_a"], visible: [] })),
      ).rejects.toThrow("boom-load")
      expect(loads.n).toBe(1)
      expect(attached).toEqual([])
      failNext = false
      await runEffect(svc.update({ viewer: { id: uid, active: false, sequence: 2 }, attached: ["ses_a"], visible: [] }))
      expect(loads.n).toBe(2)
      expect(attached).toEqual([["ses_a"]])
    })
  })

  test("invalid snapshots never load and never throw (existing error path preserved)", async () => {
    const attached: string[][] = []
    const loads = { n: 0 }
    const layer = buildCtx(
      async () => ({ setAttachedSessions: (ids) => void attached.push([...ids]) }),
      attached,
      loads,
    )
    await withScope(layer, async (svc) => {
      await runEffect(
        svc.update({ viewer: { id: uid, active: false }, attached: [], visible: [] } as unknown as Snap),
      )
      expect(loads.n).toBe(0)
      expect(attached).toEqual([])
      // Stale sequence is dropped before any load.
      await runEffect(svc.update({ viewer: { id: uid, active: false, sequence: 2 }, attached: ["ses_new"], visible: [] }))
      expect(loads.n).toBe(1)
      await runEffect(svc.update({ viewer: { id: uid, active: false, sequence: 1 }, attached: ["ses_old"], visible: [] }))
      expect(loads.n).toBe(1)
      expect(attached.filter((c) => c.length > 0).at(-1)).toEqual(["ses_new"])
      void uidB
    })
  })

  test("P0 span site precisely wraps the lazy load", async () => {
    const src = fs.readFileSync(path.join(import.meta.dir, "../../../src/kilocode/presence/service.ts"), "utf8")
    const sites = [...src.matchAll(/P0Perf\.span\("([^"]+)"\)/g)].map((m) => m[1])
    expect(sites).toEqual(["kilo_viewers_module_load"])
    // The span starts immediately before the injected/default loader call and
    // ends on success inside the same memo block.
    expect(src).toContain('P0Perf.span("kilo_viewers_module_load")')
    expect(src).toContain("const p = load().then(")
  })
})
