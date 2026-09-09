import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Latch, Ref, Scope } from "effect"
import { Runner } from "@/effect/runner"
import { it } from "../lib/effect"

const waitFor = <A, E>(runner: Runner.Runner<A, E>, tag: Runner.State<A, E>["_tag"]) =>
  Effect.gen(function* () {
    while (runner.state._tag !== tag) yield* Effect.yieldNow
  }).pipe(Effect.timeout("1 second"))

const waitForBusy = <A, E>(runner: Runner.Runner<A, E>) =>
  Effect.gen(function* () {
    while (!runner.busy) yield* Effect.yieldNow
  }).pipe(Effect.timeout("1 second"))

describe("Runner", () => {
  it.live(
    "plain Effect stays compatible and clears generation on idle",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const out = yield* runner.ensureRunning(Effect.succeed("hello"))
      expect(out).toBe("hello")
      expect(runner.state._tag).toBe("Idle")
      expect(runner.busy).toBe(false)
      expect(runner.generationID).toBeUndefined()
    }),
  )

  it.live(
    "factory invoked once and joiners share generation",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const gate = yield* Deferred.make<void>()
      let calls = 0
      let seen: string | undefined
      const factory = (gen: string) => {
        calls += 1
        seen = gen
        return Deferred.await(gate).pipe(Effect.as(gen))
      }
      const a = yield* runner.ensureRunning(factory).pipe(Effect.forkChild)
      yield* Effect.gen(function* () {
        while (runner.state._tag !== "Starting" && runner.state._tag !== "Running") yield* Effect.yieldNow
      }).pipe(Effect.timeout("1 second"))
      const gen = runner.generationID!
      expect(gen).toBeDefined()
      expect(gen.startsWith("gen_")).toBeTrue()
      const b = yield* runner.ensureRunning(factory).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(calls).toBe(1)
      yield* Deferred.succeed(gate, undefined)
      const [ra, rb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isSuccess(ra)).toBeTrue()
      expect(Exit.isSuccess(rb)).toBeTrue()
      if (Exit.isSuccess(ra) && Exit.isSuccess(rb)) {
        expect(ra.value).toBe(gen)
        expect(rb.value).toBe(gen)
      }
      expect(seen).toBe(gen)
      expect(runner.state._tag).toBe("Idle")
    }),
  )

  it.live(
    "Running and onBusy not observable until prelude completes",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const busyCount = yield* Ref.make(0)
      const runner = Runner.make<string>(s, { onBusy: Ref.update(busyCount, (n) => n + 1) })
      const preludeGate = yield* Deferred.make<void>()
      const preludeDone = yield* Deferred.make<void>()
      const bodyGate = yield* Deferred.make<void>()
      const fiber = yield* runner
        .ensureRunning({
          prelude: (gen) =>
            Effect.gen(function* () {
              yield* Deferred.await(preludeGate)
              yield* Deferred.succeed(preludeDone, undefined)
            }),
          body: (gen) => Deferred.await(bodyGate).pipe(Effect.as(gen)),
        })
        .pipe(Effect.forkChild)
      yield* Effect.gen(function* () {
        while (runner.state._tag !== "Starting") yield* Effect.yieldNow
      }).pipe(Effect.timeout("1 second"))
      expect(runner.state._tag).toBe("Starting")
      expect(runner.busy).toBe(true)
      expect(runner.generationID).toBeDefined()
      expect(yield* Ref.get(busyCount)).toBe(0)
      expect(yield* Deferred.isDone(preludeDone)).toBe(false)
      yield* Deferred.succeed(preludeGate, undefined)
      yield* Deferred.await(preludeDone).pipe(Effect.timeout("1 second"))
      yield* waitFor(runner, "Running")
      expect(yield* Ref.get(busyCount)).toBe(1)
      expect(runner.busy).toBe(true)
      yield* Deferred.succeed(bodyGate, undefined)
      const exit = yield* Fiber.await(fiber).pipe(Effect.timeout("1 second"))
      expect(Exit.isSuccess(exit)).toBeTrue()
      expect(runner.state._tag).toBe("Idle")
    }),
  )

  it.live(
    "cancel during Starting forces prelude then single open and close",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s, { onInterrupt: Effect.succeed("fallback") })
      const preludeGate = yield* Deferred.make<void>()
      let open = 0
      let close = 0
      let closeReason = ""
      const fiber = yield* runner
        .ensureRunning({
          prelude: (_gen) =>
            Effect.gen(function* () {
              yield* Deferred.await(preludeGate)
              open += 1
            }).pipe(Effect.uninterruptible),
          body: (gen) =>
            Effect.never.pipe(
              Effect.as(gen),
              Effect.onExit(() =>
                Effect.sync(() => {
                  close += 1
                  closeReason = "interrupted"
                }),
              ),
            ),
        })
        .pipe(Effect.forkChild)
      yield* Effect.gen(function* () {
        while (runner.state._tag !== "Starting") yield* Effect.yieldNow
      }).pipe(Effect.timeout("1 second"))
      const gen = runner.generationID!
      expect(open).toBe(0)
      const req = yield* runner.requestCancel
      expect(req.snapshot.generationID).toBe(gen)
      expect(req.snapshot.wasBusy).toBeTrue()
      expect(req.snapshot.interruptRequested).toBeTrue()
      expect(runner.state._tag).toBe("Stopping")
      expect(close).toBe(0)
      yield* Deferred.succeed(preludeGate, undefined)
      yield* req.wait.pipe(Effect.timeout("2 seconds"))
      const exit = yield* Fiber.await(fiber).pipe(Effect.timeout("2 seconds"))
      expect(Exit.isSuccess(exit)).toBeTrue()
      expect(open).toBe(1)
      yield* Effect.gen(function* () {
        while (close !== 1) yield* Effect.yieldNow
      }).pipe(Effect.timeout("2 seconds"))
      expect(close).toBe(1)
      expect(req.snapshot.generationID).toBe(gen)
      expect(runner.state._tag).toBe("Idle")
      expect(closeReason).toBe("interrupted")
      yield* Effect.gen(function* () {
        while (runner.state._tag !== "Idle") yield* Effect.yieldNow
      }).pipe(Effect.timeout("2 seconds"))
      expect(runner.state._tag).toBe("Idle")
    }),
  )

  it.live(
    "cancel Running stays Stopping and joiners share old epoch",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const idleCount = yield* Ref.make(0)
      const idleGate = yield* Deferred.make<void>()
      const runner = Runner.make<string>(s, {
        onIdle: Effect.gen(function* () {
          yield* Deferred.await(idleGate)
          yield* Ref.update(idleCount, (n) => n + 1)
        }),
        onInterrupt: Effect.succeed("fallback"),
      })
      const gate = yield* Deferred.make<void>()
      let calls = 0
      const factory = (_gen: string) => {
        calls += 1
        return Deferred.await(gate).pipe(Effect.as("old"))
      }
      const a = yield* runner.ensureRunning(factory).pipe(Effect.forkChild)
      yield* waitFor(runner, "Running")
      const gen = runner.generationID!
      const req = yield* runner.requestCancel
      expect(req.snapshot.generationID).toBe(gen)
      expect(req.snapshot.wasBusy).toBeTrue()
      expect(req.snapshot.interruptRequested).toBeTrue()
      expect(runner.state._tag).toBe("Stopping")
      expect(runner.busy).toBe(true)
      expect(runner.generationID).toBe(gen)
      const req2 = yield* runner.requestCancel
      expect(req2.snapshot.generationID).toBe(gen)
      expect(req2.snapshot.wasBusy).toBeTrue()
      const joiner = yield* runner.ensureRunning((_g: string) => Effect.succeed("new")).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      expect(calls).toBe(1)
      expect(runner.generationID).toBe(gen)
      expect(runner.state._tag).toBe("Stopping")
      const cancelA = yield* runner.cancel.pipe(Effect.forkChild)
      const cancelB = yield* runner.cancel.pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      expect(runner.state._tag).toBe("Stopping")
      expect(yield* Ref.get(idleCount)).toBe(0)
      yield* Deferred.succeed(idleGate, undefined)
      const [snap, snap2] = yield* Effect.all([Fiber.join(cancelA), Fiber.join(cancelB)]).pipe(
        Effect.timeout("2 seconds"),
      )
      expect(snap.generationID).toBe(gen)
      expect(snap2.generationID).toBe(gen)
      const [ea, ej] = yield* Effect.all([Fiber.await(a), Fiber.await(joiner)]).pipe(Effect.timeout("2 seconds"))
      expect(Exit.isSuccess(ea)).toBeTrue()
      expect(Exit.isSuccess(ej)).toBeTrue()
      if (Exit.isSuccess(ea) && Exit.isSuccess(ej)) {
        expect(ea.value).toBe("fallback")
        expect(ej.value).toBe("fallback")
      }
      yield* Effect.gen(function* () {
        while (runner.state._tag !== "Idle") yield* Effect.yieldNow
      }).pipe(Effect.timeout("2 seconds"))
      expect(runner.state._tag).toBe("Idle")
      expect(runner.generationID).toBeUndefined()
      expect(yield* Ref.get(idleCount)).toBe(1)
      yield* Deferred.succeed(gate, undefined).pipe(Effect.ignore)
    }),
  )

  it.live(
    "next admission after Idle mints different generation",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const gate = yield* Deferred.make<void>()
      const first = yield* runner.ensureRunning((gen: string) => Deferred.await(gate).pipe(Effect.as(gen))).pipe(Effect.forkChild)
      yield* waitFor(runner, "Running")
      const gen1 = runner.generationID!
      yield* Deferred.succeed(gate, undefined)
      const v1 = yield* Fiber.join(first).pipe(Effect.timeout("1 second"))
      expect(v1).toBe(gen1)
      yield* Effect.gen(function* () {
        while (runner.state._tag !== "Idle") yield* Effect.yieldNow
      }).pipe(Effect.timeout("1 second"))
      const gate2 = yield* Deferred.make<void>()
      const second = yield* runner.ensureRunning((gen: string) => Deferred.await(gate2).pipe(Effect.as(gen))).pipe(Effect.forkChild)
      yield* waitFor(runner, "Running")
      const gen2 = runner.generationID!
      expect(gen2).not.toBe(gen1)
      yield* Deferred.succeed(gate2, undefined)
      const v2 = yield* Fiber.join(second).pipe(Effect.timeout("1 second"))
      expect(v2).toBe(gen2)
    }),
  )

  it.live(
    "natural ordering is open busy close idle then Idle",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const order: string[] = []
      const runner = Runner.make<string>(s, {
        onBusy: Effect.sync(() => {
          order.push("busy")
        }),
        onIdle: Effect.sync(() => {
          order.push("idle")
          if (runner.generationID !== undefined || runner.state._tag === "Idle") {
            order.push("idle-saw-idle-or-no-gen")
          }
        }),
      })
      const out = yield* runner.ensureRunning({
        prelude: (_gen) => Effect.sync(() => { order.push("open") }),
        body: (gen) =>
          Effect.succeed(gen).pipe(
            Effect.onExit(() =>
              Effect.sync(() => {
                order.push("close")
                if (runner.generationID === undefined) order.push("close-saw-no-gen")
                if (runner.state._tag === "Idle") order.push("close-saw-idle")
              }),
            ),
          ),
      })
      expect(typeof out).toBe("string")
      expect(order[0]).toBe("open")
      expect(order[1]).toBe("busy")
      expect(order[2]).toBe("close")
      expect(order[3]).toBe("idle")
      expect(order).not.toContain("close-saw-idle")
      expect(order).not.toContain("close-saw-no-gen")
      expect(runner.state._tag).toBe("Idle")
      expect(runner.generationID).toBeUndefined()
    }),
  )

  it.live(
    "cancel on idle is noop",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const snap = yield* runner.cancel
      expect(snap.wasBusy).toBe(false)
      expect(snap.generationID).toBeUndefined()
      expect(snap.interruptRequested).toBe(false)
    }),
  )

  it.live(
    "shell runs exclusively and rejects concurrent shell",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const out = yield* runner.startShell(Effect.succeed("shell-done"))
      expect(out).toBe("shell-done")
      expect(runner.state._tag).toBe("Idle")
      const gate = yield* Deferred.make<void>()
      const sh = yield* runner.startShell(Deferred.await(gate).pipe(Effect.as("first"))).pipe(Effect.forkChild)
      yield* waitFor(runner, "Shell")
      const exit = yield* runner.startShell(Effect.succeed("second")).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Runner.Busy)
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.await(sh)
      expect(runner.state._tag).toBe("Idle")
    }),
  )

  it.live(
    "shell rejects when run active and run rejects shell",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const gate = yield* Deferred.make<void>()
      const run = yield* runner.ensureRunning(Deferred.await(gate).pipe(Effect.as("x"))).pipe(Effect.forkChild)
      yield* waitFor(runner, "Running")
      const shellExit = yield* runner.startShell(Effect.succeed("nope")).pipe(Effect.exit)
      expect(Exit.isFailure(shellExit)).toBe(true)
      yield* runner.cancel
      yield* Fiber.await(run).pipe(Effect.timeout("2 seconds"))
      yield* Deferred.succeed(gate, undefined).pipe(Effect.ignore)
    }),
  )

  it.live(
    "ensureRunning queues behind shell and promotes once",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const shellGate = yield* Deferred.make<void>()
      const runGate = yield* Deferred.make<void>()
      let calls = 0
      let seen: string | undefined
      const sh = yield* runner.startShell(Deferred.await(shellGate).pipe(Effect.as("shell"))).pipe(Effect.forkChild)
      yield* waitFor(runner, "Shell")
      const run = yield* runner
        .ensureRunning((gen: string) => {
          calls += 1
          seen = gen
          return Deferred.await(runGate).pipe(Effect.as(gen))
        })
        .pipe(Effect.forkChild)
      yield* waitFor(runner, "ShellThenRun")
      expect(calls).toBe(0)
      expect(runner.generationID).toBeUndefined()
      const joiner = yield* runner.ensureRunning((gen: string) => Effect.succeed(`other-${gen}`)).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(calls).toBe(0)
      yield* Deferred.succeed(shellGate, undefined)
      yield* Fiber.await(sh)
      yield* waitFor(runner, "Running")
      const promoted = runner.generationID!
      expect(promoted.startsWith("gen_")).toBeTrue()
      expect(calls).toBe(1)
      expect(seen).toBe(promoted)
      yield* Deferred.succeed(runGate, undefined)
      const [r1, r2] = yield* Effect.all([Fiber.await(run), Fiber.await(joiner)]).pipe(Effect.timeout("2 seconds"))
      expect(Exit.isSuccess(r1)).toBeTrue()
      expect(Exit.isSuccess(r2)).toBeTrue()
      if (Exit.isSuccess(r1) && Exit.isSuccess(r2)) {
        expect(r1.value).toBe(promoted)
        expect(r2.value).toBe(promoted)
      }
      expect(runner.state._tag).toBe("Idle")
    }),
  )

  it.live(
    "shell cancel blocks replacement until quiesce then runs new pending",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s, { onInterrupt: Effect.succeed("shell-fallback") })
      const shellGate = yield* Deferred.make<void>()
      const ready = yield* Latch.make()
      const sh = yield* runner.startShell(Deferred.await(shellGate).pipe(Effect.as("shell")), ready).pipe(Effect.forkChild)
      yield* waitFor(runner, "Shell")
      const req = yield* runner.requestCancel
      expect(req.snapshot.wasBusy).toBeTrue()
      expect(req.snapshot.generationID).toBeUndefined()
      expect(runner.state._tag).toBe("ShellStopping")
      expect(runner.busy).toBe(true)
      const runGate = yield* Deferred.make<void>()
      let started = false
      const pending = yield* runner
        .ensureRunning({
          prelude: (_gen) => Effect.void,
          body: (gen) =>
            Effect.gen(function* () {
              started = true
              yield* Deferred.await(runGate)
              return gen
            }),
        })
        .pipe(Effect.forkChild)
      yield* Effect.gen(function* () {
        while (runner.state._tag !== "ShellStoppingThenRun") yield* Effect.yieldNow
      }).pipe(Effect.timeout("1 second"))
      expect(started).toBe(false)
      const req2 = yield* runner.requestCancel
      expect(req2.snapshot.wasBusy).toBeTrue()
      expect(runner.state._tag).toBe("ShellStopping")
      const exitPending = yield* Fiber.await(pending).pipe(Effect.timeout("2 seconds"))
      expect(Exit.isSuccess(exitPending)).toBeTrue()
      if (Exit.isSuccess(exitPending)) expect(exitPending.value).toBe("shell-fallback")
      const converg = yield* runner.cancel.pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      expect(runner.state._tag).toBe("ShellStopping")
      yield* ready.open.pipe(Effect.ignore)
      const snapConverg = yield* Fiber.join(converg).pipe(Effect.timeout("2 seconds"))
      expect(snapConverg.wasBusy).toBeTrue()
      yield* Fiber.await(sh).pipe(Effect.timeout("2 seconds"))
      yield* Deferred.succeed(shellGate, undefined).pipe(Effect.ignore)
      yield* Deferred.succeed(runGate, undefined).pipe(Effect.ignore)
      yield* Effect.gen(function* () {
        while (runner.state._tag !== "Idle") yield* Effect.yieldNow
      }).pipe(Effect.timeout("2 seconds"))
      expect(runner.state._tag).toBe("Idle")
    }),
  )

  it.live(
    "new pending after shell cancel starts after quiesce",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const shellGate = yield* Deferred.make<void>()
      const enteredShell = yield* Deferred.make<void>()
      const ready = yield* Latch.make()
      const sh = yield* runner
        .startShell(
          Effect.gen(function* () {
            yield* Deferred.succeed(enteredShell, undefined)
            yield* Deferred.await(shellGate)
            return "shell"
          }),
          ready,
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(enteredShell).pipe(Effect.timeout("1 second"))
      yield* waitFor(runner, "Shell")
      const reqShell = yield* runner.requestCancel
      expect(reqShell.snapshot.wasBusy).toBeTrue()
      expect(runner.state._tag).toBe("ShellStopping")
      const runGate = yield* Deferred.make<void>()
      let bodyRan = false
      const pending = yield* runner
        .ensureRunning({
          prelude: (_gen) => Effect.void,
          body: (gen) =>
            Effect.gen(function* () {
              bodyRan = true
              yield* Deferred.await(runGate)
              return gen
            }),
        })
        .pipe(Effect.forkChild)
      yield* Effect.gen(function* () {
        while (runner.state._tag !== "ShellStoppingThenRun") yield* Effect.yieldNow
      }).pipe(Effect.timeout("1 second"))
      expect(bodyRan).toBe(false)
      yield* ready.open.pipe(Effect.ignore)
      yield* Deferred.succeed(shellGate, undefined).pipe(Effect.ignore)
      yield* Fiber.await(sh).pipe(Effect.timeout("2 seconds"))
      yield* waitFor(runner, "Running")
      yield* Effect.gen(function* () {
        while (!bodyRan) yield* Effect.yieldNow
      }).pipe(Effect.timeout("1 second"))
      expect(bodyRan).toBe(true)
      yield* reqShell.wait.pipe(Effect.timeout("2 seconds"))
      expect(runner.state._tag).toBe("Running")
      yield* Deferred.succeed(runGate, undefined)
      const exit = yield* Fiber.await(pending).pipe(Effect.timeout("2 seconds"))
      expect(Exit.isSuccess(exit)).toBeTrue()
      expect(runner.state._tag).toBe("Idle")
    }),
  )

  it.live(
    "onIdle fires once per epoch after close",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const count = yield* Ref.make(0)
      const runner = Runner.make<string>(s, { onIdle: Ref.update(count, (n) => n + 1) })
      yield* runner.ensureRunning(Effect.succeed("ok"))
      expect(yield* Ref.get(count)).toBe(1)
      yield* runner.ensureRunning(Effect.succeed("ok2"))
      expect(yield* Ref.get(count)).toBe(2)
    }),
  )

  it.live(
    "busy true for every non-Idle state",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      expect(runner.busy).toBe(false)
      const gate = yield* Deferred.make<void>()
      const run = yield* runner.ensureRunning(Deferred.await(gate).pipe(Effect.as("x"))).pipe(Effect.forkChild)
      yield* waitForBusy(runner)
      expect(runner.busy).toBe(true)
      const busyReq = yield* runner.requestCancel
      expect(busyReq.snapshot.wasBusy).toBeTrue()
      expect(runner.busy).toBe(true)
      expect(runner.state._tag).toBe("Stopping")
      const busySnap = yield* runner.cancel.pipe(Effect.timeout("2 seconds"))
      expect(busySnap.wasBusy).toBeTrue()
      expect(runner.busy).toBe(false)
      expect(runner.state._tag).toBe("Idle")
      yield* Fiber.await(run).pipe(Effect.timeout("2 seconds"), Effect.ignore)
      yield* Deferred.succeed(gate, undefined).pipe(Effect.ignore)
      const shellGate = yield* Deferred.make<void>()
      const sh = yield* runner.startShell(Deferred.await(shellGate).pipe(Effect.as("s"))).pipe(Effect.forkChild)
      yield* waitFor(runner, "Shell")
      expect(runner.busy).toBe(true)
      yield* Deferred.succeed(shellGate, undefined)
      yield* Fiber.await(sh)
      expect(runner.busy).toBe(false)
    }),
  )

  it.live(
    "fast shell body observes installed Shell and returns Idle",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      let observed: string | undefined
      const out = yield* runner.startShell(
        Effect.gen(function* () {
          observed = runner.state._tag
          return "fast"
        }),
      )
      expect(out).toBe("fast")
      expect(observed).toBe("Shell")
      expect(runner.state._tag).toBe("Idle")
      expect(runner.busy).toBe(false)
    }),
  )

  it.live(
    "startShell busy/idle ordering rejects while busy and admits after idle",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const gate = yield* Deferred.make<void>()
      const sh = yield* runner.startShell(Deferred.await(gate).pipe(Effect.as("first"))).pipe(Effect.forkChild)
      yield* waitFor(runner, "Shell")
      const busyExit = yield* runner.startShell(Effect.succeed("second")).pipe(Effect.exit)
      expect(Exit.isFailure(busyExit)).toBeTrue()
      if (Exit.isFailure(busyExit)) expect(Cause.squash(busyExit.cause)).toBeInstanceOf(Runner.Busy)
      const runGate = yield* Deferred.make<void>()
      const queued = yield* runner
        .ensureRunning((gen: string) => Deferred.await(runGate).pipe(Effect.as(gen)))
        .pipe(Effect.forkChild)
      yield* waitFor(runner, "ShellThenRun")
      const busyExit2 = yield* runner.startShell(Effect.succeed("third")).pipe(Effect.exit)
      expect(Exit.isFailure(busyExit2)).toBeTrue()
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.await(sh)
      yield* waitFor(runner, "Running")
      yield* Deferred.succeed(runGate, undefined)
      yield* Fiber.await(queued).pipe(Effect.timeout("2 seconds"))
      expect(runner.state._tag).toBe("Idle")
      const after = yield* runner.startShell(Effect.succeed("admitted"))
      expect(after).toBe("admitted")
      expect(runner.state._tag).toBe("Idle")
    }),
  )

  it.live(
    "stale shell finalizer cannot promote canceled pending",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s, { onInterrupt: Effect.succeed("fallback") })
      const shellGate = yield* Deferred.make<void>()
      const sh = yield* runner.startShell(Deferred.await(shellGate).pipe(Effect.as("shell"))).pipe(Effect.forkChild)
      yield* waitFor(runner, "Shell")
      const runGate = yield* Deferred.make<void>()
      const ran = yield* Ref.make(false)
      const pending = yield* runner
        .ensureRunning({
          prelude: (_gen) => Effect.void,
          body: (gen) =>
            Effect.gen(function* () {
              yield* Ref.set(ran, true)
              yield* Deferred.await(runGate)
              return gen
            }),
        })
        .pipe(Effect.forkChild)
      yield* waitFor(runner, "ShellThenRun")
      // Cancel removes/fails the exact pending before shell completion.
      const staleReq = yield* runner.requestCancel
      expect(staleReq.snapshot.wasBusy).toBeTrue()
      expect(runner.state._tag).toBe("ShellStopping")
      const exitPending = yield* Fiber.await(pending).pipe(Effect.timeout("2 seconds"))
      expect(Exit.isSuccess(exitPending)).toBeTrue()
      if (Exit.isSuccess(exitPending)) expect(exitPending.value).toBe("fallback")
      // Shell completes after cancellation: must go Idle without promoting.
      // Convergent cancel returns only after shell idle.
      const staleSnap = yield* runner.cancel.pipe(Effect.timeout("2 seconds"))
      expect(staleSnap.wasBusy).toBeTrue()
      yield* Deferred.succeed(shellGate, undefined).pipe(Effect.ignore)
      yield* Fiber.await(sh).pipe(Effect.timeout("2 seconds"))
      yield* Effect.gen(function* () {
        while (runner.state._tag !== "Idle") yield* Effect.yieldNow
      }).pipe(Effect.timeout("2 seconds"))
      expect(runner.state._tag).toBe("Idle")
      expect(runner.generationID).toBeUndefined()
      expect(yield* Ref.get(ran)).toBe(false)
      yield* Deferred.succeed(runGate, undefined).pipe(Effect.ignore)
    }),
  )

  it.live(
    "cancel racing shell promotion never resurrects failed pending",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s, { onInterrupt: Effect.succeed("fallback") })
      const shellGate = yield* Deferred.make<void>()
      const sh = yield* runner.startShell(Deferred.await(shellGate).pipe(Effect.as("shell"))).pipe(Effect.forkChild)
      yield* waitFor(runner, "Shell")
      const runGate = yield* Deferred.make<void>()
      const ran = yield* Ref.make(false)
      const pending = yield* runner
        .ensureRunning({
          prelude: (_gen) => Effect.void,
          body: (gen) =>
            Effect.gen(function* () {
              yield* Ref.set(ran, true)
              yield* Deferred.await(runGate)
              return gen
            }),
        })
        .pipe(Effect.forkChild)
      yield* waitFor(runner, "ShellThenRun")
      // Force the cancel-between-decision-and-promotion window without sleeps:
      // shell completion and cancellation become runnable at the same time.
      // The cancel snapshot tells which side won: undefined generation means
      // cancel observed Shell* (failed pending before promotion); defined
      // means promotion already committed to Starting (cancel now targets epoch).
      const [, snap] = yield* Effect.all(
        [Deferred.succeed(shellGate, undefined), runner.cancel],
        { concurrency: "unbounded" },
      )
      const exitPending = yield* Fiber.await(pending).pipe(Effect.timeout("2 seconds"))
      expect(Exit.isSuccess(exitPending)).toBeTrue()
      if (snap.generationID === undefined) {
        // Cancellation won: stale finalizer must not resurrect the failed pending.
        expect(Exit.isSuccess(exitPending) && exitPending.value === "fallback").toBeTrue()
        yield* Fiber.await(sh).pipe(Effect.timeout("2 seconds"))
        yield* Effect.gen(function* () {
          while (runner.state._tag !== "Idle") yield* Effect.yieldNow
        }).pipe(Effect.timeout("2 seconds"))
        expect(runner.state._tag).toBe("Idle")
        expect(yield* Ref.get(ran)).toBe(false)
      } else {
        // Promotion won then cancel interrupted the new epoch: body ran once
        // with the minted generation, waiter falls back via epoch interrupt.
        yield* Fiber.await(sh).pipe(Effect.timeout("2 seconds"))
        expect(yield* Ref.get(ran)).toBe(true)
        expect(Exit.isSuccess(exitPending) && exitPending.value === "fallback").toBeTrue()
        yield* Effect.gen(function* () {
          while (runner.state._tag !== "Idle") yield* Effect.yieldNow
        }).pipe(Effect.timeout("2 seconds"))
        expect(runner.state._tag).toBe("Idle")
      }
      yield* Deferred.succeed(runGate, undefined).pipe(Effect.ignore)
      yield* Fiber.await(sh).pipe(Effect.timeout("2 seconds"), Effect.ignore)
      yield* Fiber.await(pending).pipe(Effect.timeout("2 seconds"), Effect.ignore)
      yield* Effect.gen(function* () {
        while (runner.state._tag !== "Idle") yield* Effect.yieldNow
      }).pipe(Effect.timeout("2 seconds"), Effect.ignore)
    }),
  )

  it.live(
    "ShellStoppingThenRun promotes only the current pending",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s, { onInterrupt: Effect.succeed("fallback") })
      const shellGate = yield* Deferred.make<void>()
      const ready = yield* Latch.make()
      const sh = yield* runner
        .startShell(Deferred.await(shellGate).pipe(Effect.as("shell")), ready)
        .pipe(Effect.forkChild)
      yield* waitFor(runner, "Shell")
      const oldGate = yield* Deferred.make<void>()
      const oldRan = yield* Ref.make(false)
      const oldPending = yield* runner
        .ensureRunning({
          prelude: (_gen) => Effect.void,
          body: (gen) =>
            Effect.gen(function* () {
              yield* Ref.set(oldRan, true)
              yield* Deferred.await(oldGate)
              return gen
            }),
        })
        .pipe(Effect.forkChild)
      yield* waitFor(runner, "ShellThenRun")
      // Block shell teardown on ready so the shell stays in ShellStopping
      // while we queue the replacement pending behind it.
      const cancelFiber = yield* runner.cancel.pipe(Effect.forkChild)
      yield* Effect.gen(function* () {
        while (runner.state._tag !== "ShellStopping") yield* Effect.yieldNow
      }).pipe(Effect.timeout("1 second"))
      expect(runner.state._tag).toBe("ShellStopping")
      const exitOld = yield* Fiber.await(oldPending).pipe(Effect.timeout("2 seconds"))
      expect(Exit.isSuccess(exitOld)).toBeTrue()
      if (Exit.isSuccess(exitOld)) expect(exitOld.value).toBe("fallback")
      const newGate = yield* Deferred.make<void>()
      const newRan = yield* Ref.make(false)
      let seen: string | undefined
      const fresh = yield* runner
        .ensureRunning({
          prelude: (_gen) => Effect.void,
          body: (gen) =>
            Effect.gen(function* () {
              yield* Ref.set(newRan, true)
              seen = gen
              yield* Deferred.await(newGate)
              return gen
            }),
        })
        .pipe(Effect.forkChild)
      yield* Effect.gen(function* () {
        while (runner.state._tag !== "ShellStoppingThenRun") yield* Effect.yieldNow
      }).pipe(Effect.timeout("1 second"))
      // Repeated cancel would fail the current pending; do not cancel here so
      // the current pending must promote. Release the shell instead.
      yield* ready.open.pipe(Effect.ignore)
      yield* Deferred.succeed(shellGate, undefined)
      yield* Fiber.join(cancelFiber).pipe(Effect.ignore)
      yield* Fiber.await(sh).pipe(Effect.timeout("2 seconds"))
      yield* waitFor(runner, "Running")
      const gen = runner.generationID!
      expect(gen.startsWith("gen_")).toBeTrue()
      expect(seen).toBe(gen)
      expect(yield* Ref.get(oldRan)).toBe(false)
      expect(yield* Ref.get(newRan)).toBe(true)
      yield* Deferred.succeed(newGate, undefined)
      const exitFresh = yield* Fiber.await(fresh).pipe(Effect.timeout("2 seconds"))
      expect(Exit.isSuccess(exitFresh)).toBeTrue()
      if (Exit.isSuccess(exitFresh)) expect(exitFresh.value).toBe(gen)
      yield* Deferred.succeed(oldGate, undefined).pipe(Effect.ignore)
      expect(runner.state._tag).toBe("Idle")
    }),
  )

  it.live(
    "ShellStoppingThenRun repeated cancel resolves pending once and stale promotion loses",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const fallbackCalls = yield* Ref.make(0)
      const runner = Runner.make<string>(s, {
        onInterrupt: Effect.gen(function* () {
          yield* Ref.update(fallbackCalls, (n) => n + 1)
          return "fallback"
        }),
      })
      const shellGate = yield* Deferred.make<void>()
      const ready = yield* Latch.make()
      const sh = yield* runner
        .startShell(Deferred.await(shellGate).pipe(Effect.as("shell")), ready)
        .pipe(Effect.forkChild)
      yield* waitFor(runner, "Shell")
      // First cancel parks the shell in ShellStopping (teardown blocked on ready).
      const first = yield* runner.requestCancel
      expect(first.snapshot.wasBusy).toBeTrue()
      expect(runner.state._tag).toBe("ShellStopping")
      // Enqueue pending P behind the stopping shell.
      const factoryCalls = yield* Ref.make(0)
      const bodyRan = yield* Ref.make(false)
      const bodyGate = yield* Deferred.make<void>()
      const pending = yield* runner
        .ensureRunning({
          prelude: (_gen) => Effect.void,
          body: (gen) =>
            Effect.gen(function* () {
              yield* Ref.update(factoryCalls, (n) => n + 1)
              yield* Ref.set(bodyRan, true)
              yield* Deferred.await(bodyGate)
              return gen
            }),
        })
        .pipe(Effect.forkChild)
      const joiner = yield* runner.ensureRunning(Effect.succeed("unused")).pipe(Effect.forkChild)
      yield* Effect.gen(function* () {
        while (runner.state._tag !== "ShellStoppingThenRun") yield* Effect.yieldNow
      }).pipe(Effect.timeout("1 second"))
      // Second cancel must atomically strip P to ShellStopping and settle the
      // exact pending once via the shared fallback.
      const second = yield* runner.requestCancel
      expect(second.snapshot.wasBusy).toBeTrue()
      expect(second.snapshot.generationID).toBeUndefined()
      expect(runner.state._tag).toBe("ShellStopping")
      const exitP = yield* Fiber.await(pending).pipe(Effect.timeout("2 seconds"))
      const exitJ = yield* Fiber.await(joiner).pipe(Effect.timeout("2 seconds"))
      expect(Exit.isSuccess(exitP)).toBeTrue()
      expect(Exit.isSuccess(exitJ)).toBeTrue()
      if (Exit.isSuccess(exitP) && Exit.isSuccess(exitJ)) {
        expect(exitP.value).toBe("fallback")
        expect(exitJ.value).toBe("fallback")
      }
      // Repeated cancel is idempotent and never re-settles the pending.
      const third = yield* runner.requestCancel
      expect(third.snapshot.wasBusy).toBeTrue()
      expect(runner.state._tag).toBe("ShellStopping")
      // Shell finalizer now concurrently tries to promote the already-resolved
      // P: the defensive isDone rejection plus the exact shellID+pendingID CAS
      // must lose, interrupt the suspended spawn, and drain to Idle without
      // running body/factory or installing the resolved pending.
      yield* ready.open.pipe(Effect.ignore)
      yield* Deferred.succeed(shellGate, undefined).pipe(Effect.ignore)
      yield* Fiber.await(sh).pipe(Effect.timeout("2 seconds"))
      yield* Effect.gen(function* () {
        while (runner.state._tag !== "Idle") yield* Effect.yieldNow
      }).pipe(Effect.timeout("2 seconds"))
      expect(runner.state._tag).toBe("Idle")
      expect(runner.generationID).toBeUndefined()
      expect(yield* Ref.get(bodyRan)).toBe(false)
      expect(yield* Ref.get(factoryCalls)).toBe(0)
      // Stale spawned promotion CAS loss: hold a second shell in ShellStopping,
      // enqueue a fresh pending, then race shell release against cancel. The
      // losing spawn must be interrupted without running its body when cancel
      // wins; either winner still converges to Idle with a single shared
      // fallback and no resolved pending installed.
      const ready2 = yield* Latch.make()
      const shellGate2 = yield* Deferred.make<void>()
      const sh2 = yield* runner
        .startShell(Deferred.await(shellGate2).pipe(Effect.as("shell2")), ready2)
        .pipe(Effect.forkChild)
      yield* waitFor(runner, "Shell")
      const req2 = yield* runner.requestCancel
      expect(req2.snapshot.wasBusy).toBeTrue()
      expect(runner.state._tag).toBe("ShellStopping")
      const staleGate = yield* Deferred.make<void>()
      const staleRan = yield* Ref.make(false)
      const stalePending = yield* runner
        .ensureRunning({
          prelude: (_gen) => Effect.void,
          body: (gen) =>
            Effect.gen(function* () {
              yield* Ref.set(staleRan, true)
              yield* Deferred.await(staleGate)
              return gen
            }),
        })
        .pipe(Effect.forkChild)
      yield* Effect.gen(function* () {
        while (runner.state._tag !== "ShellStoppingThenRun") yield* Effect.yieldNow
      }).pipe(Effect.timeout("1 second"))
      const [, staleSnap] = yield* Effect.all(
        [
          Effect.gen(function* () {
            yield* ready2.open.pipe(Effect.ignore)
            yield* Deferred.succeed(shellGate2, undefined).pipe(Effect.ignore)
          }),
          runner.cancel,
        ],
        { concurrency: "unbounded" },
      )
      const exitStale = yield* Fiber.await(stalePending).pipe(Effect.timeout("5 seconds"))
      expect(Exit.isSuccess(exitStale)).toBeTrue()
      yield* Fiber.await(sh2).pipe(Effect.timeout("5 seconds"), Effect.ignore)
      if (staleSnap.generationID === undefined) {
        // Cancel won: stale spawned promotion lost exact CAS, body never ran.
        if (Exit.isSuccess(exitStale)) expect(exitStale.value).toBe("fallback")
        expect(yield* Ref.get(staleRan)).toBe(false)
        yield* Effect.gen(function* () {
          while (runner.state._tag !== "Idle") yield* Effect.yieldNow
        }).pipe(Effect.timeout("2 seconds"))
        expect(runner.state._tag).toBe("Idle")
      } else {
        // Promotion won then cancel interrupted the new epoch.
        if (Exit.isSuccess(exitStale)) expect(exitStale.value).toBe("fallback")
        expect(yield* Ref.get(staleRan)).toBe(true)
        yield* Effect.gen(function* () {
          while (runner.state._tag !== "Idle") yield* Effect.yieldNow
        }).pipe(Effect.timeout("2 seconds"))
        expect(runner.state._tag).toBe("Idle")
      }
      yield* Deferred.succeed(staleGate, undefined).pipe(Effect.ignore)
      yield* Deferred.succeed(bodyGate, undefined).pipe(Effect.ignore)
      // New admission after Idle runs with a fresh generation.
      const freshGate = yield* Deferred.make<void>()
      let freshGen: string | undefined
      const fresh = yield* runner
        .ensureRunning({
          prelude: (_gen) => Effect.void,
          body: (gen) =>
            Effect.gen(function* () {
              freshGen = gen
              yield* Deferred.await(freshGate)
              return gen
            }),
        })
        .pipe(Effect.forkChild)
      yield* waitFor(runner, "Running")
      expect(freshGen).toBeDefined()
      expect(freshGen!.startsWith("gen_")).toBeTrue()
      yield* Deferred.succeed(freshGate, undefined)
      const exitFresh = yield* Fiber.await(fresh).pipe(Effect.timeout("2 seconds"))
      expect(Exit.isSuccess(exitFresh)).toBeTrue()
      if (Exit.isSuccess(exitFresh)) expect(exitFresh.value).toBe(freshGen!)
      expect(runner.state._tag).toBe("Idle")
    }),
  )

  it.live(
    "shell promotion skips idle and idle runs while non-Idle",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const idleCount = yield* Ref.make(0)
      const idleTags: string[] = []
      const runner = Runner.make<string>(s, {
        onIdle: Effect.gen(function* () {
          idleTags.push(runner.state._tag)
          yield* Ref.update(idleCount, (n) => n + 1)
        }),
      })
      const shellGate = yield* Deferred.make<void>()
      const sh = yield* runner.startShell(Deferred.await(shellGate).pipe(Effect.as("shell"))).pipe(Effect.forkChild)
      yield* waitFor(runner, "Shell")
      const runGate = yield* Deferred.make<void>()
      const pending = yield* runner
        .ensureRunning((gen: string) => Deferred.await(runGate).pipe(Effect.as(gen)))
        .pipe(Effect.forkChild)
      yield* waitFor(runner, "ShellThenRun")
      yield* Deferred.succeed(shellGate, undefined)
      yield* Fiber.await(sh)
      yield* waitFor(runner, "Running")
      // Promotion ShellThenRun -> Starting -> Running skipped onIdle.
      expect(yield* Ref.get(idleCount)).toBe(0)
      yield* Deferred.succeed(runGate, undefined)
      yield* Fiber.await(pending).pipe(Effect.timeout("2 seconds"))
      yield* Effect.gen(function* () {
        while (runner.state._tag !== "Idle") yield* Effect.yieldNow
      }).pipe(Effect.timeout("2 seconds"))
      // Run finalization ran onIdle exactly once while non-Idle.
      expect(yield* Ref.get(idleCount)).toBe(1)
      expect(idleTags[0]).not.toBe("Idle")
      // Pure shell completion runs onIdle while ShellStopping.
      const idleBefore = yield* Ref.get(idleCount)
      const out = yield* runner.startShell(Effect.succeed("solo"))
      expect(out).toBe("solo")
      expect(yield* Ref.get(idleCount)).toBe(idleBefore + 1)
      expect(runner.state._tag).toBe("Idle")
    }),
  )

  it.live(
    "interrupted epoch evaluates fallback once with TurnClose before fallback before idle",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const order: string[] = []
      const calls = yield* Ref.make(0)
      const runner = Runner.make<string>(s, {
        onIdle: Effect.sync(() => order.push("idle")),
        onInterrupt: Effect.gen(function* () {
          yield* Ref.update(calls, (n) => n + 1)
          order.push("fallback")
          return "shared-fallback"
        }),
      })
      const gate = yield* Deferred.make<void>()
      const origin = yield* runner
        .ensureRunning({
          prelude: (_gen) => Effect.void,
          body: (_gen) =>
            Deferred.await(gate).pipe(
              Effect.onExit(() => Effect.sync(() => order.push("close"))),
              Effect.as("body-should-not-win"),
            ),
        })
        .pipe(Effect.forkChild)
      yield* waitFor(runner, "Running")
      const joiners = []
      for (let i = 0; i < 4; i++) {
        joiners.push(yield* runner.ensureRunning((_g: string) => Effect.succeed("unused")).pipe(Effect.forkChild))
      }
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      yield* Fiber.join(yield* runner.cancel.pipe(Effect.forkChild)).pipe(Effect.timeout("5 seconds"))
      const originExit = yield* Fiber.await(origin).pipe(Effect.timeout("5 seconds"))
      const joinExits = []
      for (const f of joiners) joinExits.push(yield* Fiber.await(f).pipe(Effect.timeout("5 seconds")))
      expect(Exit.isSuccess(originExit)).toBeTrue()
      for (const e of joinExits) expect(Exit.isSuccess(e)).toBeTrue()
      if (Exit.isSuccess(originExit)) {
        expect(originExit.value).toBe("shared-fallback")
        for (const e of joinExits) {
          if (Exit.isSuccess(e)) expect(e.value).toBe(originExit.value)
        }
      }
      expect(yield* Ref.get(calls)).toBe(1)
      expect(order).toEqual(["close", "fallback", "idle"])
      expect(runner.state._tag).toBe("Idle")
    }),
  )

  it.live(
    "canceled pending behind shell resolves one shared fallback for all joiners",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const calls = yield* Ref.make(0)
      const runner = Runner.make<string>(s, {
        onInterrupt: Effect.gen(function* () {
          yield* Ref.update(calls, (n) => n + 1)
          return "pending-fallback"
        }),
      })
      const shellGate = yield* Deferred.make<void>()
      const sh = yield* runner.startShell(Deferred.await(shellGate).pipe(Effect.as("shell"))).pipe(Effect.forkChild)
      yield* waitFor(runner, "Shell")
      const first = yield* runner.ensureRunning(Effect.succeed("unused")).pipe(Effect.forkChild)
      yield* waitFor(runner, "ShellThenRun")
      const extra = []
      for (let i = 0; i < 3; i++) {
        extra.push(yield* runner.ensureRunning(Effect.succeed("unused")).pipe(Effect.forkChild))
      }
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      yield* Fiber.join(yield* runner.cancel.pipe(Effect.forkChild)).pipe(Effect.timeout("5 seconds"))
      const all = [first, ...extra]
      const exits = []
      for (const f of all) exits.push(yield* Fiber.await(f).pipe(Effect.timeout("5 seconds")))
      for (const e of exits) {
        expect(Exit.isSuccess(e)).toBeTrue()
        if (Exit.isSuccess(e)) expect(e.value).toBe("pending-fallback")
      }
      // One shared pending fallback for all 4 pending joiners plus the shell's
      // own compatible interrupt return (shell work stays single-flight too).
      expect(yield* Ref.get(calls)).toBe(2)
      yield* Deferred.succeed(shellGate, undefined).pipe(Effect.ignore)
      yield* Fiber.await(sh).pipe(Effect.timeout("5 seconds"), Effect.ignore)
      yield* Effect.gen(function* () {
        while (runner.state._tag !== "Idle") yield* Effect.yieldNow
      }).pipe(Effect.timeout("2 seconds"))
      expect(runner.state._tag).toBe("Idle")
    }),
  )

  it.live(
    "concurrent Idle admissions lose one CAS without hang and share single prelude/body",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const pre = yield* Ref.make(0)
      const bodies = yield* Ref.make(0)
      const gate = yield* Deferred.make<void>()
      const start = yield* Deferred.make<void>()
      const descriptor = {
        prelude: (_gen: string) => Ref.update(pre, (n) => n + 1).pipe(Effect.asVoid),
        body: (gen: string) =>
          Effect.gen(function* () {
            yield* Ref.update(bodies, (n) => n + 1)
            yield* Deferred.await(gate)
            return gen
          }),
      }
      const call = Deferred.await(start).pipe(Effect.andThen(runner.ensureRunning(descriptor)))
      const f1 = yield* call.pipe(Effect.forkChild)
      const f2 = yield* call.pipe(Effect.forkChild)
      yield* Deferred.succeed(start, undefined)
      yield* waitFor(runner, "Running").pipe(Effect.timeoutOrElse({
        duration: "2 seconds",
        orElse: () => Effect.die(new Error("never reached Running")),
      }))
      const gen = runner.generationID!
      expect(gen.startsWith("gen_")).toBeTrue()
      yield* Deferred.succeed(gate, undefined)
      const e1 = yield* Fiber.await(f1).pipe(Effect.timeout("2 seconds"))
      const e2 = yield* Fiber.await(f2).pipe(Effect.timeout("2 seconds"))
      expect(e1).toBeDefined()
      expect(e2).toBeDefined()
      if (e1 && Exit.isSuccess(e1) && e2 && Exit.isSuccess(e2)) {
        expect(e1.value).toBe(gen)
        expect(e2.value).toBe(gen)
      } else {
        expect.unreachable("Idle losers must converge through winning epoch without hang")
      }
      expect(yield* Ref.get(pre)).toBe(1)
      expect(yield* Ref.get(bodies)).toBe(1)
      expect(runner.state._tag).toBe("Idle")
    }),
  )

  it.live(
    "shell promotion spawn loser exits without prelude/body and drain converges",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s, { onInterrupt: Effect.succeed("fallback") })
      const shellGate = yield* Deferred.make<void>()
      const sh = yield* runner.startShell(Deferred.await(shellGate).pipe(Effect.as("shell"))).pipe(Effect.forkChild)
      yield* waitFor(runner, "Shell")
      const pre = yield* Ref.make(0)
      const bodies = yield* Ref.make(0)
      const runGate = yield* Deferred.make<void>()
      const pending = yield* runner
        .ensureRunning({
          prelude: (_gen) => Ref.update(pre, (n) => n + 1).pipe(Effect.asVoid),
          body: (gen) =>
            Effect.gen(function* () {
              yield* Ref.update(bodies, (n) => n + 1)
              yield* Deferred.await(runGate)
              return gen
            }),
        })
        .pipe(Effect.forkChild)
      yield* waitFor(runner, "ShellThenRun")
      const start = yield* Deferred.make<void>()
      const releaser = Deferred.await(start).pipe(Effect.andThen(Deferred.succeed(shellGate, undefined)))
      const canceller = Deferred.await(start).pipe(Effect.andThen(runner.cancel))
      const rf = yield* releaser.pipe(Effect.forkChild)
      const cf = yield* canceller.pipe(Effect.forkChild)
      yield* Deferred.succeed(start, undefined)
      const snap = yield* Fiber.join(cf).pipe(Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () => Effect.die(new Error("cancel hung")),
      }))
      yield* Fiber.await(rf).pipe(Effect.timeout("2 seconds"), Effect.ignore)
      const exitPending = yield* Fiber.await(pending).pipe(Effect.timeout("5 seconds"))
      expect(exitPending).toBeDefined()
      expect(exitPending && Exit.isSuccess(exitPending)).toBeTrue()
      yield* Fiber.await(sh).pipe(Effect.timeout("5 seconds"), Effect.ignore)
      if (snap.generationID === undefined) {
        expect(yield* Ref.get(pre)).toBe(0)
        expect(yield* Ref.get(bodies)).toBe(0)
        if (exitPending && Exit.isSuccess(exitPending)) expect(exitPending.value).toBe("fallback")
        yield* Effect.gen(function* () {
          while (runner.state._tag !== "Idle") yield* Effect.yieldNow
        }).pipe(Effect.timeout("2 seconds"))
        expect(runner.state._tag).toBe("Idle")
      } else {
        expect(yield* Ref.get(bodies)).toBe(1)
        if (exitPending && Exit.isSuccess(exitPending)) expect(exitPending.value).toBe("fallback")
        yield* Effect.gen(function* () {
          while (runner.state._tag !== "Idle") yield* Effect.yieldNow
        }).pipe(Effect.timeout("2 seconds"))
        expect(runner.state._tag).toBe("Idle")
      }
      yield* Deferred.succeed(runGate, undefined).pipe(Effect.ignore)
    }),
  )

  it.live(
    "winning Starting cancellation keeps single paired open/close with same generation",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s, { onInterrupt: Effect.succeed("fallback") })
      const preludeGate = yield* Deferred.make<void>()
      let open = 0
      let close = 0
      let openGen: string | undefined
      let closeGen: string | undefined
      const fiber = yield* runner
        .ensureRunning({
          prelude: (gen) =>
            Effect.gen(function* () {
              yield* Deferred.await(preludeGate)
              open += 1
              openGen = gen
            }).pipe(Effect.uninterruptible),
          body: (gen) =>
            Effect.never.pipe(
              Effect.as(gen),
              Effect.onExit(() =>
                Effect.sync(() => {
                  close += 1
                  closeGen = gen
                }),
              ),
            ),
        })
        .pipe(Effect.forkChild)
      yield* Effect.gen(function* () {
        while (runner.state._tag !== "Starting") yield* Effect.yieldNow
      }).pipe(Effect.timeout("1 second"))
      const gen = runner.generationID!
      const req = yield* runner.requestCancel
      expect(req.snapshot.generationID).toBe(gen)
      yield* Deferred.succeed(preludeGate, undefined)
      yield* req.wait.pipe(Effect.timeout("2 seconds"))
      const exit = yield* Fiber.await(fiber).pipe(Effect.timeout("2 seconds"))
      expect(exit && Exit.isSuccess(exit)).toBeTrue()
      expect(open).toBe(1)
      expect(close).toBe(1)
      expect(openGen).toBe(gen)
      expect(closeGen).toBe(gen)
      expect(runner.state._tag).toBe("Idle")
    }),
  )

  it.live(
    "self-await guard lets target run and shell fibers request cancel without deadlock",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string, never>(s, { onInterrupt: Effect.succeed("fallback") })
      // Inner waits run directly on the target fiber (no timeout race, which would fork
      // and defeat fiber-identity guard); outer timeouts prove absence of deadlock.
      const runOut = yield* runner
        .ensureRunning({
          prelude: (_gen) => Effect.void as Effect.Effect<void, never>,
          body: (gen) =>
            Effect.uninterruptible(
              Effect.gen(function* () {
                const req = yield* runner.requestCancel
                expect(req.snapshot.generationID).toBe(gen)
                expect(req.snapshot.wasBusy).toBe(true)
                yield* req.wait
                const snap = yield* runner.cancel
                expect(snap.generationID).toBe(gen)
                return gen
              }),
            ) as Effect.Effect<string, never>,
        })
        .pipe(
          Effect.timeoutOrElse({
            duration: "5 seconds",
            orElse: () => Effect.die(new Error("run self-cancel timed out")),
          }),
        )
      expect(typeof runOut).toBe("string")
      expect(runner.state._tag).toBe("Idle")
      const shellOut = yield* runner
        .startShell(
          Effect.uninterruptible(
            Effect.gen(function* () {
              const req = yield* runner.requestCancel
              expect(req.snapshot.wasBusy).toBe(true)
              yield* req.wait
              const snap = yield* runner.cancel
              expect(snap.wasBusy).toBe(true)
              return "shell-self"
            }),
          ) as Effect.Effect<string, never>,
        )
        .pipe(
          Effect.timeoutOrElse({
            duration: "5 seconds",
            orElse: () => Effect.die(new Error("shell self-cancel timed out")),
          }),
        )
      expect(["shell-self", "fallback"]).toContain(shellOut)
      expect(runner.state._tag).toBe("Idle")
    }),
  )
})
