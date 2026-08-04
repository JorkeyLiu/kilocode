// kilocode_change - new file
/**
 * Deterministic ConfigConvergence coordinator lifecycle tests for the accepted
 * audit races and correctness blockers:
 *
 * 1. LOCK-007 (audit race 1): `begin` raises the fence before snapshotting, and
 *    `withColdMutation` installs the abort only after begin returns. Interrupting
 *    the save during a blocked snapshot must NOT leak the fence — begin is one
 *    uninterruptible region, so the obligation is always returned and the
 *    ensuring-abort always releases the fence.
 *
 * 2. LOCK-005 (audit race 2): a directory loaded through write intent while a
 *    global fence is active is registered for that global convergence before the
 *    fence can release. Covers the load racing (a) before commit, (b) during
 *    drain/pass, and (c) near release, plus the release atomicity (a load racing
 *    the final release either converges first or starts after the fence against
 *    the post-global disk).
 *
 * 3. LOCK-004 (latest identity): an explicit reload replacing old1 with old2
 *    between two coalesced obligations must converge the LATEST captured
 *    identity — disposing the first-captured old would be an identity-safe
 *    no-op while the store keeps serving stale old2. And a second obligation
 *    committed AFTER the first pass already took its pending set and parked
 *    mid-boot must force ANOTHER pass — the fence and rebuild tracker release
 *    only after the latest (second) boot, never behind or before it.
 *
 * 4. LOCK-005 (reload hook): an explicit reload that replaces a cached instance
 *    while a convergence fence is active registers with the fence BEFORE the
 *    cache replacement and confirms after the replacement boot (success,
 *    failure, interruption), so the coordinator converges the replacement
 *    before the fence releases. Covers the reload before the fence (captured as
 *    the pre-mutation identity by the pass), during the fence (registered and
 *    converged — disposed + rebooted from current disk), and after the fence
 *    (no registration — the replacement survives untouched).
 *
 * 5. LOCK-006/007 (write lifetime): a hot/joining write handler holds an
 *    identity-keyed write lease from load through handler completion, so
 *    convergence (which is otherwise ready) can never dispose the runtime the
 *    handler is using; the lease releases on success, failure, and interruption.
 *
 * No sleeps: every race is sequenced through Deferreds and synchronous
 * admission side-effects. The store hook in `InstanceStore.load`/`reload` is
 * simulated by the canonical register → load/reload → confirm sequence, and one
 * test drives the REAL InstanceStore (with mocked Project/InstanceBootstrap) to
 * prove the hook wires the gate registration into an actual load and reload.
 */
import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, ManagedRuntime, Option } from "effect"
import { ProjectV2 } from "@opencode-ai/core/project"
import { GenerationGate } from "../../../src/kilocode/server/generation-gate"
import { ConfigConvergence, withColdMutation } from "../../../src/kilocode/server/config-convergence"
import { ControlLease } from "../../../src/kilocode/server/control-lease"
import { InstanceStore, type LoadInput } from "../../../src/project/instance-store"
import { InstanceRef } from "../../../src/effect/instance-ref"
import type { InstanceContext } from "../../../src/project/instance-context"
import { Project } from "../../../src/project/project"
import { InstanceBootstrap } from "../../../src/project/bootstrap-service"
import { awaitRebuilds } from "../../../src/kilocode/server/config-rebuild"
import { awaitWithTimeout, pollWithTimeout } from "../../lib/effect"

const isDone = <A>(deferred: Deferred.Deferred<A>) => Effect.map(Deferred.poll(deferred), (opt) => opt._tag === "Some")

/** Narrow a Some option or fail the test. */
const someValue = <A>(opt: Option.Option<A>): A => {
  if (opt._tag === "None") throw new Error("expected Some option")
  return opt.value
}

/** Project info shape used by InstanceContext mocks. */
const projectOf = (directory: string) => ({
  id: ProjectV2.ID.make(directory),
  worktree: directory,
  time: { created: 0, updated: 0 },
  sandboxes: [] as string[],
})

/**
 * Controllable InstanceStore: per-directory load holds, identity-tracked cache,
 * disposal log, and a `loads` log for deterministic race sequencing.
 */
function makeMockStore(snapshot?: (directory: string) => Effect.Effect<Option.Option<InstanceContext>>) {
  const cache = new Map<string, InstanceContext>()
  const held = new Map<string, Deferred.Deferred<void>>()
  const disposed: InstanceContext[] = []
  const loads: string[] = []
  const mk = (directory: string): InstanceContext => ({
    directory,
    worktree: "",
    project: projectOf(directory),
  })
  const store: InstanceStore.Interface = {
    load: (input: LoadInput) =>
      Effect.gen(function* () {
        // Faithful to the real InstanceStore: a cached identity is returned
        // without re-booting (disposing the cached identity is what removes it).
        const cached = cache.get(input.directory)
        if (cached) return cached
        loads.push(input.directory)
        const hold = held.get(input.directory)
        if (hold) yield* Deferred.await(hold)
        const ctx = mk(input.directory)
        cache.set(input.directory, ctx)
        return ctx
      }),
    reload: (input: LoadInput) =>
      Effect.gen(function* () {
        const previous = cache.get(input.directory)
        if (previous) {
          cache.delete(input.directory)
          disposed.push(previous)
        }
        const ctx = mk(input.directory)
        cache.set(input.directory, ctx)
        return ctx
      }),
    dispose: (ctx: InstanceContext) =>
      Effect.sync(() => {
        if (cache.get(ctx.directory) === ctx) cache.delete(ctx.directory)
        disposed.push(ctx)
      }),
    disposeSafe: (ctx: InstanceContext) => store.dispose(ctx), // kilocode_change - LOCK-007: mock has no leases to drain
    disposeDirectory: (directory: string) =>
      Effect.gen(function* () {
        const current = cache.get(directory)
        if (current) yield* store.dispose(current)
      }),
    disposeAll: () =>
      Effect.forEach([...cache.values()], (ctx) => store.dispose(ctx).pipe(Effect.asVoid), { discard: true }),
    provide: <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      store.load(input).pipe(Effect.flatMap((ctx) => effect.pipe(Effect.provideService(InstanceRef, ctx)))),
    snapshot:
      snapshot ??
      ((directory: string) =>
        Effect.sync(() => (cache.has(directory) ? Option.some(cache.get(directory)!) : Option.none()))),
    directories: () => Effect.sync(() => [...cache.keys()]),
  }
  return { store, held, disposed, loads, cache }
}

/** Runtime with the real gate + coordinator + lease service and the given InstanceStore. */
const runtime = (store: InstanceStore.Interface) =>
  ManagedRuntime.make(
    Layer.mergeAll(
      GenerationGate.defaultLayer,
      ConfigConvergence.defaultLayer,
      ControlLease.defaultLayer,
      Layer.succeed(InstanceStore.Service, store),
    ).pipe(Layer.provideMerge(GenerationGate.defaultLayer)),
  )

/**
 * Canonical write-intent load sequence under an active fence — exactly what
 * `InstanceStore.load` does via `registerFenceLoad` + `ensuring(confirm)`.
 */
const writeLoad = (gate: GenerationGate, store: InstanceStore.Interface, directory: string) =>
  Effect.gen(function* () {
    const lease = yield* gate.registerFenceLoad(directory)
    const ctx = yield* store.load({ directory })
    if (lease._tag === "Some") yield* someValue(lease)
    return { ctx, registered: lease._tag === "Some" } as const
  })

describe("LOCK-007: begin interruption cannot leak the fence (audit race 1)", () => {
  test("interrupting withColdMutation while begin is blocked in a snapshot releases the fence", async () => {
    const entered = Deferred.makeUnsafe<void>()
    const blocked = Deferred.makeUnsafe<void>()
    const run = Deferred.makeUnsafe<void>()
    const admitted = Deferred.makeUnsafe<boolean>()
    // The snapshot blocks until `blocked` resolves — a first-boot in flight.
    const mock = makeMockStore((directory: string) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(entered, void 0)
        yield* Deferred.await(blocked)
        return Option.none<InstanceContext>()
      }),
    )
    const rt = runtime(mock.store)
    try {
      const gate = await rt.runPromise(GenerationGate.Service)
      const save = rt.runFork(
        withColdMutation({
          scope: { directory: "d" },
          run: () => Deferred.succeed(run, void 0).pipe(Effect.as({ changed: true, value: 1 })),
        }),
      )
      // begin raised the fence, then blocked inside the snapshot.
      await rt.runPromise(awaitWithTimeout(Deferred.await(entered), "begin never entered the snapshot"))
      expect(gate.isBarrierActive("d")).toBe(true)

      // A later reader is parked behind the fence (the leak would strand it).
      const reader = rt.runFork(
        Effect.gen(function* () {
          const release = yield* gate.acquire("d")
          yield* Deferred.succeed(admitted, true)
          yield* release
        }),
      )
      expect(await rt.runPromise(isDone(admitted))).toBe(false)

      // Interrupt the save while begin is blocked mid-snapshot. begin is
      // uninterruptible, so the interrupt is queued (fire-and-forget — awaiting
      // Fiber.interrupt here would deadlock on the blocked snapshot).
      rt.runFork(Fiber.interrupt(save))
      // begin is uninterruptible: the snapshot resolves, the obligation is
      // returned, the save exits interrupted, and the ensuring-abort releases
      // the fence. The run() persist step must never have started.
      await rt.runPromise(Deferred.succeed(blocked, void 0))
      await rt.runPromise(
        awaitWithTimeout(Deferred.await(admitted), "reader was never admitted after interrupted begin"),
      )
      expect(gate.isBarrierActive("d")).toBe(false)
      expect(await rt.runPromise(isDone(run))).toBe(false)
      await rt.runPromise(Fiber.join(reader))
    } finally {
      await rt.dispose()
    }
  })
})

describe("LOCK-005: write-loaded directories converge under an active global fence (audit race 2)", () => {
  test("race (a): a write-load before commit is converged before the fence releases", async () => {
    const mock = makeMockStore()
    const rt = runtime(mock.store)
    try {
      const gate = await rt.runPromise(GenerationGate.Service)
      const svc = await rt.runPromise(ConfigConvergence.Service)
      await rt.runPromise(mock.store.load({ directory: "A" }))

      // Global cold save begins: fence up, olds captured WITHOUT B.
      const obligation = await rt.runPromise(svc.begin("global"))
      expect(gate.isBarrierActive("B")).toBe(true)

      // Write-intent load of the unseen directory B while the fence is active
      // (before the save commits/persists).
      const { ctx: b1, registered } = await rt.runPromise(writeLoad(gate, mock.store, "B"))
      expect(registered).toBe(true)

      // Commit: the pass must converge B (dispose b1, reboot from current
      // disk) before the fence can drop.
      await rt.runPromise(svc.commit(obligation))
      await rt.runPromise(
        pollWithTimeout(
          Effect.sync(() => (gate.isBarrierActive("B") ? undefined : true)),
          "fence never released",
        ),
      )
      const b2 = await rt.runPromise(mock.store.snapshot("B"))
      expect(someValue(b2)).not.toBe(b1)
      expect(mock.disposed).toContain(b1)

      // After release, the same write-load no longer registers: it starts
      // against the post-global disk (acceptance: starts after release).
      const after = await rt.runPromise(writeLoad(gate, mock.store, "C"))
      expect(after.registered).toBe(false)
    } finally {
      await rt.dispose()
    }
  })

  test("race (b): a write-load landing while the pass drains a held directory is converged before release", async () => {
    const mock = makeMockStore()
    const rt = runtime(mock.store)
    try {
      const gate = await rt.runPromise(GenerationGate.Service)
      const svc = await rt.runPromise(ConfigConvergence.Service)
      await rt.runPromise(mock.store.load({ directory: "A" }))
      // Hold A's drain with a PRE-fence reader: once the fence is up the pass
      // parks at convergeOne(A) BEFORE it can release the fence.
      const releaseA = await rt.runPromise(gate.acquire("A"))
      const obligation = await rt.runPromise(svc.begin("global"))
      await rt.runPromise(svc.commit(obligation))

      // The write-load of B lands while the pass is mid-drain.
      const { ctx: b1, registered } = await rt.runPromise(writeLoad(gate, mock.store, "B"))
      expect(registered).toBe(true)
      expect(gate.isBarrierActive("B")).toBe(true)

      // Release the drain: the pass converges A, then must converge B before
      // the fence drops.
      await rt.runPromise(releaseA)
      await rt.runPromise(
        pollWithTimeout(
          Effect.sync(() => (gate.isBarrierActive("B") ? undefined : true)),
          "fence never released",
        ),
      )
      const b2 = await rt.runPromise(mock.store.snapshot("B"))
      expect(someValue(b2)).not.toBe(b1)
      expect(mock.disposed).toContain(b1)
    } finally {
      await rt.dispose()
    }
  })

  test("race (c): a write-load landing while the pass is mid-boot (near release) is converged before release", async () => {
    const mock = makeMockStore()
    const rt = runtime(mock.store)
    try {
      const gate = await rt.runPromise(GenerationGate.Service)
      const svc = await rt.runPromise(ConfigConvergence.Service)
      await rt.runPromise(mock.store.load({ directory: "A" }))

      // Hold the pass's SECOND load of A (the reboot) so the pass is parked
      // inside convergeOne(A), immediately before the release step.
      const holdA = Deferred.makeUnsafe<void>()
      mock.held.set("A", holdA)
      const obligation = await rt.runPromise(svc.begin("global"))
      await rt.runPromise(svc.commit(obligation))
      await rt.runPromise(
        pollWithTimeout(
          Effect.sync(() => (mock.loads.filter((directory) => directory === "A").length === 2 ? true : undefined)),
          "pass never entered the A reboot",
        ),
      )

      // Write-load of B while the pass is parked one step from releasing.
      const { ctx: b1, registered } = await rt.runPromise(writeLoad(gate, mock.store, "B"))
      expect(registered).toBe(true)

      // Let the pass finish A's reboot: the deferred release must converge B
      // before the fence drops.
      await rt.runPromise(Deferred.succeed(holdA, void 0))
      await rt.runPromise(
        pollWithTimeout(
          Effect.sync(() => (gate.isBarrierActive("B") ? undefined : true)),
          "fence never released",
        ),
      )
      const b2 = await rt.runPromise(mock.store.snapshot("B"))
      expect(someValue(b2)).not.toBe(b1)
      expect(mock.disposed).toContain(b1)
    } finally {
      await rt.dispose()
    }
  })

  test("an in-flight write-load holds the fence open until it confirms and converges", async () => {
    const mock = makeMockStore()
    const rt = runtime(mock.store)
    try {
      const gate = await rt.runPromise(GenerationGate.Service)
      const svc = await rt.runPromise(ConfigConvergence.Service)
      await rt.runPromise(mock.store.load({ directory: "A" }))

      const obligation = await rt.runPromise(svc.begin("global"))
      // Hold B's boot so the load is IN FLIGHT when the pass reaches release.
      const holdB = Deferred.makeUnsafe<void>()
      mock.held.set("B", holdB)
      const lease = await rt.runPromise(gate.registerFenceLoad("B"))
      expect(lease._tag).toBe("Some")
      const loadingB = rt.runFork(
        Effect.gen(function* () {
          const ctx = yield* mock.store.load({ directory: "B" })
          yield* someValue(lease)
          return ctx
        }),
      )

      await rt.runPromise(svc.commit(obligation))
      // The pass converges A, then tries to release; the unconfirmed B load
      // defers the release (the fence stays up).
      await rt.runPromise(
        pollWithTimeout(
          Effect.sync(() => (mock.loads.filter((directory) => directory === "A").length === 2 ? true : undefined)),
          "pass never rebooted A",
        ),
      )
      expect(gate.isBarrierActive("B")).toBe(true)

      // The write-load completes: the pass wakes, converges B, and releases.
      await rt.runPromise(Deferred.succeed(holdB, void 0))
      const b1 = await rt.runPromise(Fiber.join(loadingB))
      await rt.runPromise(
        pollWithTimeout(
          Effect.sync(() => (gate.isBarrierActive("B") ? undefined : true)),
          "fence never released",
        ),
      )
      const b2 = await rt.runPromise(mock.store.snapshot("B"))
      expect(someValue(b2)).not.toBe(b1)
      expect(mock.disposed).toContain(b1)
    } finally {
      await rt.dispose()
    }
  })

  test("a write-load of the fenced directory during a project fence is converged before release", async () => {
    const mock = makeMockStore()
    const rt = runtime(mock.store)
    try {
      const gate = await rt.runPromise(GenerationGate.Service)
      const svc = await rt.runPromise(ConfigConvergence.Service)
      // Project cold save for an UNSEEN directory: olds is empty, but a
      // write-intent load of the same directory races in under the fence.
      const obligation = await rt.runPromise(svc.begin({ directory: "A" }))
      expect(gate.isBarrierActive("A")).toBe(true)
      const { ctx: a1, registered } = await rt.runPromise(writeLoad(gate, mock.store, "A"))
      expect(registered).toBe(true)

      await rt.runPromise(svc.commit(obligation))
      await rt.runPromise(
        pollWithTimeout(
          Effect.sync(() => (gate.isBarrierActive("A") ? undefined : true)),
          "project fence never released",
        ),
      )
      const a2 = await rt.runPromise(mock.store.snapshot("A"))
      expect(someValue(a2)).not.toBe(a1)
      expect(mock.disposed).toContain(a1)
    } finally {
      await rt.dispose()
    }
  })

  test("an aborted last fence ref with an in-flight load converges it before dropping", async () => {
    const mock = makeMockStore()
    const rt = runtime(mock.store)
    try {
      const gate = await rt.runPromise(GenerationGate.Service)
      const svc = await rt.runPromise(ConfigConvergence.Service)
      await rt.runPromise(mock.store.load({ directory: "A" }))

      // The ONLY global save begins, then ABORTS (persist failure) — but the
      // fence cannot drop while B's load is unconverged: the abort forks a
      // release pass.
      const obligation = await rt.runPromise(svc.begin("global"))

      // A load registers under the fence and stays IN FLIGHT.
      const holdB = Deferred.makeUnsafe<void>()
      mock.held.set("B", holdB)
      const lease = await rt.runPromise(gate.registerFenceLoad("B"))
      expect(lease._tag).toBe("Some")
      const loadingB = rt.runFork(
        Effect.gen(function* () {
          const ctx = yield* mock.store.load({ directory: "B" })
          yield* someValue(lease)
          return ctx
        }),
      )

      await rt.runPromise(svc.abort(obligation))
      expect(gate.isBarrierActive("B")).toBe(true)

      // Complete the load: the release pass converges B, then drops the fence.
      await rt.runPromise(Deferred.succeed(holdB, void 0))
      const b1 = await rt.runPromise(Fiber.join(loadingB))
      await rt.runPromise(
        pollWithTimeout(
          Effect.sync(() => (gate.isBarrierActive("B") ? undefined : true)),
          "fence never released after aborted save",
        ),
      )
      const b2 = await rt.runPromise(mock.store.snapshot("B"))
      expect(someValue(b2)).not.toBe(b1)
      expect(mock.disposed).toContain(b1)
    } finally {
      await rt.dispose()
    }
  })
})

describe("LOCK-005: the real InstanceStore load hook registers under an active fence", () => {
  const realStoreLayer = InstanceStore.layer.pipe(
    Layer.provideMerge(
      Layer.mock(Project.Service, {
        fromDirectory: (directory: string) =>
          Effect.succeed({ sandbox: `${directory}-worktree`, project: projectOf(directory) }),
      }),
    ),
    Layer.provideMerge(Layer.mock(InstanceBootstrap.Service, { run: Effect.void })),
  )

  test("a first load during a global fence is disposed and rebooted by the pass", async () => {
    const rt = ManagedRuntime.make(
      Layer.mergeAll(GenerationGate.defaultLayer, ConfigConvergence.defaultLayer, realStoreLayer).pipe(
        Layer.provideMerge(GenerationGate.defaultLayer),
      ),
    )
    try {
      const gate = await rt.runPromise(GenerationGate.Service)
      const svc = await rt.runPromise(ConfigConvergence.Service)
      const store = await rt.runPromise(InstanceStore.Service)
      await rt.runPromise(store.load({ directory: "A" }))

      const obligation = await rt.runPromise(svc.begin("global"))
      // Real-store write-intent load: the hook registers with the active fence.
      const ctx1 = await rt.runPromise(store.load({ directory: "B" }))
      await rt.runPromise(svc.commit(obligation))
      await rt.runPromise(
        pollWithTimeout(
          Effect.sync(() => (gate.isBarrierActive("B") ? undefined : true)),
          "fence never released",
        ),
      )
      // B's pre-global runtime was disposed and rebooted by the convergence.
      const b2 = await rt.runPromise(store.snapshot("B"))
      expect(someValue(b2)).not.toBe(ctx1)

      // A load after the fence (no registration) is never converged: it starts
      // against the current config and keeps its identity.
      const ctx3 = await rt.runPromise(store.load({ directory: "C" }))
      await rt.runPromise(awaitRebuilds())
      const c2 = await rt.runPromise(store.snapshot("C"))
      expect(someValue(c2)).toBe(ctx3)
    } finally {
      await rt.runPromise(awaitRebuilds().pipe(Effect.ignore))
      await rt.dispose()
    }
  })
})

describe("LOCK-005: the real InstanceStore reload hook registers under an active fence", () => {
  const realStoreLayer = InstanceStore.layer.pipe(
    Layer.provideMerge(
      Layer.mock(Project.Service, {
        fromDirectory: (directory: string) =>
          Effect.succeed({ sandbox: `${directory}-worktree`, project: projectOf(directory) }),
      }),
    ),
    Layer.provideMerge(Layer.mock(InstanceBootstrap.Service, { run: Effect.void })),
  )

  const realRuntime = () =>
    ManagedRuntime.make(
      Layer.mergeAll(GenerationGate.defaultLayer, ConfigConvergence.defaultLayer, realStoreLayer).pipe(
        Layer.provideMerge(GenerationGate.defaultLayer),
      ),
    )

  test("a reload before the fence is captured as the pre-mutation identity and converged", async () => {
    const rt = realRuntime()
    try {
      const gate = await rt.runPromise(GenerationGate.Service)
      const svc = await rt.runPromise(ConfigConvergence.Service)
      const store = await rt.runPromise(InstanceStore.Service)
      await rt.runPromise(store.load({ directory: "A" }))
      // Explicit reload BEFORE the fence: no fence is active, so no
      // registration — the reloaded identity is captured as the pre-mutation
      // runtime by the fence and converged by the pass like any cached runtime.
      const replaced = await rt.runPromise(store.reload({ directory: "A" }))
      const obligation = await rt.runPromise(svc.begin("global"))
      await rt.runPromise(svc.commit(obligation))
      await rt.runPromise(
        pollWithTimeout(
          Effect.sync(() => (gate.isBarrierActive("A") ? undefined : true)),
          "fence never released after reload-before-fence convergence",
        ),
      )
      const after = await rt.runPromise(store.snapshot("A"))
      expect(someValue(after)).not.toBe(replaced)
    } finally {
      await rt.runPromise(awaitRebuilds().pipe(Effect.ignore))
      await rt.dispose()
    }
  })

  test("a reload during a global fence is converged (disposed + rebooted from disk) before release", async () => {
    const rt = realRuntime()
    try {
      const gate = await rt.runPromise(GenerationGate.Service)
      const svc = await rt.runPromise(ConfigConvergence.Service)
      const store = await rt.runPromise(InstanceStore.Service)
      await rt.runPromise(store.load({ directory: "A" }))

      // Fence raises with old1 captured; the reload REPLACES the cached
      // runtime while the fence is active and registers with it (the hook).
      const obligation = await rt.runPromise(svc.begin("global"))
      expect(gate.isBarrierActive("A")).toBe(true)
      const replaced = await rt.runPromise(store.reload({ directory: "A" }))
      // Commit: the pass cannot release while the registered reload replacement
      // is unconverged — it is disposed and rebooted from current disk before
      // the fence drops.
      await rt.runPromise(svc.commit(obligation))
      await rt.runPromise(
        pollWithTimeout(
          Effect.sync(() => (gate.isBarrierActive("A") ? undefined : true)),
          "fence never released after reload-during-fence convergence",
        ),
      )
      const after = await rt.runPromise(store.snapshot("A"))
      expect(someValue(after)).not.toBe(replaced)
    } finally {
      await rt.runPromise(awaitRebuilds().pipe(Effect.ignore))
      await rt.dispose()
    }
  })

  test("a reload after the fence released survives untouched (no registration)", async () => {
    const rt = realRuntime()
    try {
      const gate = await rt.runPromise(GenerationGate.Service)
      const svc = await rt.runPromise(ConfigConvergence.Service)
      const store = await rt.runPromise(InstanceStore.Service)
      await rt.runPromise(store.load({ directory: "A" }))
      // A cold save completes fully (fence releases, pass settles).
      const obligation = await rt.runPromise(svc.begin("global"))
      await rt.runPromise(svc.commit(obligation))
      await rt.runPromise(
        pollWithTimeout(
          Effect.sync(() => (gate.isBarrierActive("A") ? undefined : true)),
          "fence never released after plain convergence",
        ),
      )
      await rt.runPromise(awaitRebuilds())

      // Reload AFTER the fence: no registration (the registry is cleared at
      // release), so the replacement is served and never converged.
      const replaced = await rt.runPromise(store.reload({ directory: "A" }))
      await rt.runPromise(awaitRebuilds())
      const after = await rt.runPromise(store.snapshot("A"))
      expect(someValue(after)).toBe(replaced)
    } finally {
      await rt.runPromise(awaitRebuilds().pipe(Effect.ignore))
      await rt.dispose()
    }
  })
})

describe("LOCK-004: the latest captured identity per directory converges", () => {
  test("a reload replacing old1 with old2 between two global obligations disposes old2 before release", async () => {
    const mock = makeMockStore()
    const rt = runtime(mock.store)
    try {
      const gate = await rt.runPromise(GenerationGate.Service)
      const svc = await rt.runPromise(ConfigConvergence.Service)
      // Load A → old1, then a global save captures old1.
      const old1 = await rt.runPromise(mock.store.load({ directory: "A" }))
      const obligation1 = await rt.runPromise(svc.begin("global"))

      // An explicit reload replaces the cached runtime old1 → old2.
      const old2 = await rt.runPromise(mock.store.reload({ directory: "A" }))
      expect(old2).not.toBe(old1)

      // A second global obligation captures the NEWEST identity.
      const obligation2 = await rt.runPromise(svc.begin("global"))

      // Both commits run in one synchronous fiber turn so the detached pass
      // coalesces them into ONE pass (LOCK-004): the pass must converge the
      // LATEST captured identity (old2), not the first (old1 — whose dispose
      // would be an identity-safe no-op, leaving stale old2 cached).
      await rt.runPromise(
        Effect.gen(function* () {
          yield* svc.commit(obligation1)
          yield* svc.commit(obligation2)
        }),
      )
      await rt.runPromise(
        pollWithTimeout(
          Effect.sync(() => (gate.isBarrierActive("A") ? undefined : true)),
          "global fence never released",
        ),
      )
      // The latest identity was disposed/rebooted by the pass before the fence
      // released — the pre-mutation runtime is never left cached.
      expect(mock.disposed).toContain(old2)
      const after = await rt.runPromise(mock.store.snapshot("A"))
      expect(someValue(after)).not.toBe(old2)
      expect(someValue(after)).not.toBe(old1)
    } finally {
      await rt.dispose()
    }
  })

  test("a reload replacing old1 with old2 between two project obligations disposes old2 before release", async () => {
    const mock = makeMockStore()
    const rt = runtime(mock.store)
    try {
      const gate = await rt.runPromise(GenerationGate.Service)
      const svc = await rt.runPromise(ConfigConvergence.Service)
      const old1 = await rt.runPromise(mock.store.load({ directory: "A" }))
      const obligation1 = await rt.runPromise(svc.begin({ directory: "A" }))
      const old2 = await rt.runPromise(mock.store.reload({ directory: "A" }))
      const obligation2 = await rt.runPromise(svc.begin({ directory: "A" }))

      await rt.runPromise(
        Effect.gen(function* () {
          yield* svc.commit(obligation1)
          yield* svc.commit(obligation2)
        }),
      )
      await rt.runPromise(
        pollWithTimeout(
          Effect.sync(() => (gate.isBarrierActive("A") ? undefined : true)),
          "project fence never released",
        ),
      )
      expect(mock.disposed).toContain(old2)
      const after = await rt.runPromise(mock.store.snapshot("A"))
      expect(someValue(after)).not.toBe(old2)
      expect(someValue(after)).not.toBe(old1)
    } finally {
      await rt.dispose()
    }
  })

  test("a second cold obligation committed while the first pass is parked mid-boot forces another pass; the fence releases only after the latest boot", async () => {
    const mock = makeMockStore()
    const rt = runtime(mock.store)
    // holdB parks pass 1's reboot of B (between its dispose and boot) so pass 1
    // stays ACTIVE after it already booted A at seq 1. holdA2 parks pass 2's
    // reboot of A so the fence/tracker release is observable AFTER pass 2's
    // latest boot, never before it.
    const holdB = Deferred.makeUnsafe<void>()
    const holdA2 = Deferred.makeUnsafe<void>()
    try {
      const gate = await rt.runPromise(GenerationGate.Service)
      const svc = await rt.runPromise(ConfigConvergence.Service)
      const old1A = await rt.runPromise(mock.store.load({ directory: "A" }))
      const old1B = await rt.runPromise(mock.store.load({ directory: "B" }))
      mock.held.set("B", holdB)

      // First global obligation: begin raises the fence, commit returns the
      // response immediately and forks the serialized pass.
      const obligation1 = await rt.runPromise(svc.begin("global"))
      expect(gate.isBarrierActive("A")).toBe(true)
      await rt.runPromise(svc.commit(obligation1))

      // Pass 1 is ACTIVE and parked at the controlled dispose/boot boundary:
      // A was fully converged (disposed old1A, rebooted → old2A, booted[A] = 1)
      // and B is parked mid-reboot on holdB. Reaching the reboot proves the
      // pass already took its pending set and passed its A convergence.
      await rt.runPromise(
        pollWithTimeout(
          Effect.sync(
            () =>
              mock.loads.filter((directory) => directory === "A").length === 2 &&
              mock.loads.filter((directory) => directory === "B").length === 2
                ? true
                : undefined,
          ),
          "first pass never reached the B reboot park",
        ),
      )
      expect(mock.disposed).toContain(old1A)
      expect(mock.disposed).toContain(old1B)
      expect(mock.cache.has("B")).toBe(false)
      const old2A = someValue(await rt.runPromise(mock.store.snapshot("A")))
      expect(old2A).not.toBe(old1A)

      // A SECOND cold obligation commits while pass 1 is still parked. Its
      // begin captures the CURRENT identity (old2A — pass 1's boot) as the
      // pre-mutation runtime; its seq (2) exceeds booted[A] (1), so it can
      // never be coalesced into pass 1 or released behind it — only a second
      // pass can converge it.
      mock.held.set("A", holdA2)
      const obligation2 = await rt.runPromise(svc.begin("global"))
      await rt.runPromise(svc.commit(obligation2))
      // Both commits were immediate: pass 1 is STILL parked at B's reboot.
      expect(mock.cache.has("B")).toBe(false)
      expect(gate.isBarrierActive("A")).toBe(true)
      // The rebuild tracker holds both obligation starts — quiescence must
      // not settle while pass 1 is still active.
      const rebuildDone = Deferred.makeUnsafe<void>()
      const rebuildSettled = rt.runFork(
        awaitRebuilds().pipe(Effect.ensuring(Deferred.succeed(rebuildDone, void 0))),
      )
      expect(await rt.runPromise(isDone(rebuildDone))).toBe(false)

      // Release pass 1's park: pass 1 finishes B, then pass 2 (serialized)
      // runs and parks at ITS reboot of A. The fence is still up and the
      // tracker still open, proving release is gated on pass 2's boot.
      await rt.runPromise(Deferred.succeed(holdB, void 0))
      await rt.runPromise(
        pollWithTimeout(
          Effect.sync(
            () => (mock.loads.filter((directory) => directory === "A").length === 3 ? true : undefined),
          ),
          "second pass never reached the A reboot park",
        ),
      )
      // Pass 2 really disposed pass 1's boot (old2A) before its own reboot.
      expect(mock.disposed).toContain(old2A)
      expect(mock.cache.has("A")).toBe(false)
      expect(gate.isBarrierActive("A")).toBe(true)
      expect(await rt.runPromise(isDone(rebuildDone))).toBe(false)

      // Release pass 2's park: only now does the fence drop, the tracker
      // settle, and the final identity be pass 2's boot (the newest).
      await rt.runPromise(Deferred.succeed(holdA2, void 0))
      await rt.runPromise(
        pollWithTimeout(
          Effect.sync(() => (gate.isBarrierActive("A") ? undefined : true)),
          "fence never released after the second boot",
        ),
      )
      await rt.runPromise(awaitWithTimeout(Deferred.await(rebuildDone), "rebuild tracker never settled"))
      await rt.runPromise(Fiber.join(rebuildSettled))

      // Second disposal/boot occurred: exactly three disposals (old1A, old1B
      // by pass 1; old2A by pass 2) and A was booted three times, the last by
      // pass 2 — the newest identity is the one the fence released behind.
      expect(mock.disposed).toContain(old2A)
      expect(mock.disposed).toHaveLength(3)
      expect(mock.loads.filter((directory) => directory === "A").length).toBe(3)
      const finalA = someValue(await rt.runPromise(mock.store.snapshot("A")))
      expect(finalA).not.toBe(old1A)
      expect(finalA).not.toBe(old2A)
      const finalB = someValue(await rt.runPromise(mock.store.snapshot("B")))
      expect(finalB).not.toBe(old1B)
    } finally {
      // Release both parks so shutdown can always preempt the passes — a pass
      // parked inside its uninterruptible boot would block Fiber.interrupt.
      await rt.runPromise(Deferred.succeed(holdB, void 0))
      await rt.runPromise(Deferred.succeed(holdA2, void 0))
      await rt.dispose()
    }
  })
})

describe("LOCK-006/007: write lifetime leases hold convergence until handler completion", () => {
  test("a held write handler after load blocks disposal until release; the save response returns first", async () => {
    const mock = makeMockStore()
    const rt = runtime(mock.store)
    try {
      const gate = await rt.runPromise(GenerationGate.Service)
      const svc = await rt.runPromise(ConfigConvergence.Service)
      const leases = await rt.runPromise(ControlLease.Service)
      const old1 = await rt.runPromise(mock.store.load({ directory: "A" }))

      // A hot/joining write handler loads A (cache hit → old1), acquires its
      // identity-keyed write lifetime lease, and parks (held) before completing.
      // This is exactly the middleware write-intent flow: load → acquireWrite →
      // handler effect, with the lease held through the whole handler.
      const writeLease = await rt.runPromise(Effect.sync(() => leases.acquireWrite(old1)))
      expect(writeLease._tag).toBe("Some")
      const hold = Deferred.makeUnsafe<void>()
      const entered = Deferred.makeUnsafe<void>()
      const handler = rt.runFork(
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, void 0)
          yield* Deferred.await(hold)
        }).pipe(Effect.ensuring(someValue(writeLease))),
      )
      await rt.runPromise(awaitWithTimeout(Deferred.await(entered), "write handler never entered"))

      // The cold save commits and returns its response (LOCK-001: the response
      // never waits on the drain). The pass parks at the write lease.
      const response = await rt.runPromise(
        awaitWithTimeout(
          withColdMutation({
            scope: "global",
            run: () => Effect.succeed({ changed: true, value: "saved" }),
          }),
          "save response never returned",
        ),
      )
      expect(response).toBe("saved")

      // The rebuild tracker must NOT settle while the handler holds the lease:
      // the registered convergence pass only completes after the
      // drain→dispose→boot pass finishes. Forked AFTER the commit so the
      // counter is already 1 — if the pass were NOT blocked by the write lease
      // it would dispose+reboot and settle the tracker now.
      const rebuildDone = Deferred.makeUnsafe<void>()
      const rebuildSettled = rt.runFork(awaitRebuilds().pipe(Effect.ensuring(Deferred.succeed(rebuildDone, void 0))))
      await rt.runPromise(Effect.yieldNow)
      await rt.runPromise(Effect.yieldNow)
      await rt.runPromise(Effect.yieldNow)
      // The write handler is still held: convergence is otherwise ready (the
      // only drain is the write lifetime), so NO disposal has happened and the
      // fence is still up.
      expect(await rt.runPromise(isDone(rebuildDone))).toBe(false)
      expect(gate.isBarrierActive("A")).toBe(true)
      expect(mock.disposed).not.toContain(old1)
      const still = await rt.runPromise(mock.store.snapshot("A"))
      expect(someValue(still)).toBe(old1)

      // Release the handler: its ensuring releases the write lease, the pass
      // seals+drains+disposes old1, reboots, and the fence drops.
      await rt.runPromise(Deferred.succeed(hold, void 0))
      await rt.runPromise(awaitWithTimeout(Fiber.join(handler), "write handler never completed"))
      await rt.runPromise(
        pollWithTimeout(
          Effect.sync(() => (gate.isBarrierActive("A") ? undefined : true)),
          "fence never released after write handler release",
        ),
      )
      await rt.runPromise(awaitWithTimeout(Fiber.join(rebuildSettled), "rebuild never settled"))
      expect(mock.disposed).toContain(old1)
      const fresh = await rt.runPromise(mock.store.snapshot("A"))
      expect(someValue(fresh)).not.toBe(old1)
    } finally {
      await rt.dispose()
    }
  })

  test("interrupting a held write handler releases the lease and convergence completes", async () => {
    const mock = makeMockStore()
    const rt = runtime(mock.store)
    try {
      const gate = await rt.runPromise(GenerationGate.Service)
      const svc = await rt.runPromise(ConfigConvergence.Service)
      const leases = await rt.runPromise(ControlLease.Service)
      const old1 = await rt.runPromise(mock.store.load({ directory: "A" }))

      const writeLease = await rt.runPromise(Effect.sync(() => leases.acquireWrite(old1)))
      expect(writeLease._tag).toBe("Some")
      const hold = Deferred.makeUnsafe<void>()
      const entered = Deferred.makeUnsafe<void>()
      const handler = rt.runFork(
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, void 0)
          yield* Deferred.await(hold)
        }).pipe(Effect.ensuring(someValue(writeLease))),
      )
      await rt.runPromise(awaitWithTimeout(Deferred.await(entered), "write handler never entered"))

      const obligation = await rt.runPromise(svc.begin("global"))
      await rt.runPromise(svc.commit(obligation))

      // Interrupt the held write handler: LOCK-007 — the ensuring release runs
      // on interruption, so the pass can drain and dispose.
      await rt.runPromise(Fiber.interrupt(handler))
      await rt.runPromise(
        pollWithTimeout(
          Effect.sync(() => (gate.isBarrierActive("A") ? undefined : true)),
          "fence never released after interrupted write handler",
        ),
      )
      expect(mock.disposed).toContain(old1)
      const fresh = await rt.runPromise(mock.store.snapshot("A"))
      expect(someValue(fresh)).not.toBe(old1)
    } finally {
      await rt.dispose()
    }
  })
})

describe("LOCK-007: coordinator shutdown owns workers, fences, and the rebuild tracker", () => {
  test("shutdown interrupts a committed pass waiting on a held reader, settles the tracker, and never reboots", async () => {
    const mock = makeMockStore()
    const rt = runtime(mock.store)
    try {
      const gate = await rt.runPromise(GenerationGate.Service)
      const svc = await rt.runPromise(ConfigConvergence.Service)
      await rt.runPromise(mock.store.load({ directory: "A" }))

      // Hold A's reader: the committed global pass parks at A's drain BEFORE
      // any disposal/boot — the fence stays up and nothing has been touched.
      const releaseA = await rt.runPromise(gate.acquire("A"))
      const obligation = await rt.runPromise(svc.begin("global"))
      await rt.runPromise(svc.commit(obligation))
      expect(gate.isBarrierActive("A")).toBe(true)
      await rt.runPromise(Effect.yieldNow)
      await rt.runPromise(Effect.yieldNow)
      expect(mock.loads.filter((directory) => directory === "A").length).toBe(1)
      expect(mock.disposed).toHaveLength(0)

      // Shutdown while the pass is parked on the held reader: workers are
      // interrupted/joined, the tracker settles, and the fence is released.
      await rt.runPromise(awaitWithTimeout(svc.shutdown, "shutdown never completed"))
      await rt.runPromise(awaitWithTimeout(awaitRebuilds(), "tracker never settled after shutdown"))
      expect(gate.isBarrierActive("A")).toBe(false)
      // Shutdown itself must not reboot or dispose anything.
      expect(mock.loads.filter((directory) => directory === "A").length).toBe(1)
      expect(mock.disposed).toHaveLength(0)

      // Releasing the held reader afterwards must not resume convergence work
      // against the disposed runtime — no boot, no dispose.
      await rt.runPromise(releaseA)
      await rt.runPromise(Effect.yieldNow)
      await rt.runPromise(Effect.yieldNow)
      expect(mock.loads.filter((directory) => directory === "A").length).toBe(1)
      expect(mock.disposed).toHaveLength(0)
    } finally {
      await rt.dispose()
    }
  })

  test("an abort-triggered release pass is tracked and shutdown settles it without converging", async () => {
    const mock = makeMockStore()
    const rt = runtime(mock.store)
    try {
      const gate = await rt.runPromise(GenerationGate.Service)
      const svc = await rt.runPromise(ConfigConvergence.Service)
      await rt.runPromise(mock.store.load({ directory: "A" }))

      // The ONLY global save begins then aborts — but B's in-flight load
      // defers the fence release, so abort forks a tracked release-only pass.
      const obligation = await rt.runPromise(svc.begin("global"))
      const holdB = Deferred.makeUnsafe<void>()
      mock.held.set("B", holdB)
      const lease = await rt.runPromise(gate.registerFenceLoad("B"))
      expect(lease._tag).toBe("Some")
      const loadingB = rt.runFork(
        Effect.gen(function* () {
          const ctx = yield* mock.store.load({ directory: "B" })
          yield* someValue(lease)
          return ctx
        }),
      )

      await rt.runPromise(svc.abort(obligation))
      // The release pass is canonical tracker work: awaitRebuilds must NOT
      // settle while it is parked on B's load confirmation.
      const settled = Deferred.makeUnsafe<void>()
      const awaiting = rt.runFork(awaitRebuilds().pipe(Effect.ensuring(Deferred.succeed(settled, void 0))))
      await rt.runPromise(Effect.yieldNow)
      await rt.runPromise(Effect.yieldNow)
      expect(await rt.runPromise(isDone(settled))).toBe(false)

      // Shutdown interrupts the release pass and settles its tracker start.
      await rt.runPromise(awaitWithTimeout(svc.shutdown, "shutdown never completed"))
      await rt.runPromise(awaitWithTimeout(Fiber.join(awaiting), "release-pass tracker never settled"))

      // B's load completes after shutdown; no convergence pass remains to
      // dispose or reboot anything.
      await rt.runPromise(Deferred.succeed(holdB, void 0))
      await rt.runPromise(Fiber.join(loadingB))
      await rt.runPromise(Effect.yieldNow)
      expect(mock.disposed).toHaveLength(0)
      expect(mock.loads.filter((directory) => directory === "B").length).toBe(1)
    } finally {
      await rt.dispose()
    }
  })
})
