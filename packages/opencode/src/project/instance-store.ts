import { GlobalBus } from "@/bus/global"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { InstanceRef } from "@/effect/instance-ref"
import { disposeInstance as runDisposers } from "@/effect/instance-registry"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Context, Deferred, Duration, Effect, Exit, Layer, Option, Scope } from "effect" // kilocode_change
import { context as instanceContext, type InstanceContext } from "./instance-context" // kilocode_change
import { InstanceBootstrap } from "./bootstrap-service"
import * as Project from "./project"
import { GenerationGate } from "@/kilocode/server/generation-gate" // kilocode_change - LOCK-005: fence load registration
import { ControlLease } from "@/kilocode/server/control-lease" // kilocode_change - LOCK-007: lease-aware disposal

export interface LoadInput {
  directory: string
  worktree?: string
  project?: Project.Info
}

export interface Interface {
  readonly load: (input: LoadInput) => Effect.Effect<InstanceContext>
  readonly reload: (input: LoadInput) => Effect.Effect<InstanceContext>
  readonly dispose: (ctx: InstanceContext) => Effect.Effect<void>
  // kilocode_change start - LOCK-007: lease-aware disposal. Identical identity
  // and event semantics to `dispose`, but seals and drains the exact
  // identity's control + write leases before any disposer runs.
  readonly disposeSafe: (ctx: InstanceContext) => Effect.Effect<void>
  // kilocode_change end
  readonly disposeDirectory: (directory: string) => Effect.Effect<void>
  readonly disposeAll: () => Effect.Effect<void>
  readonly provide: <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly snapshot: (directory: string) => Effect.Effect<Option.Option<InstanceContext>> // kilocode_change
  readonly directories: () => Effect.Effect<string[]> // kilocode_change
}

export class Service extends Context.Service<Service, Interface>()("@opencode/InstanceStore") {}

export const use = serviceUse(Service)

interface Entry {
  readonly deferred: Deferred.Deferred<InstanceContext>
}

export const layer: Layer.Layer<Service, never, Project.Service | InstanceBootstrap.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const project = yield* Project.Service
    const bootstrap = yield* InstanceBootstrap.Service
    const scope = yield* Scope.Scope
    const cache = new Map<string, Entry>()

    const boot = (input: LoadInput & { directory: string }) =>
      Effect.gen(function* () {
        const ctx: InstanceContext =
          input.project && input.worktree
            ? {
                directory: input.directory,
                worktree: input.worktree,
                project: input.project,
              }
            : yield* project.fromDirectory(input.directory).pipe(
                Effect.map((result) => ({
                  directory: input.directory,
                  worktree: result.sandbox,
                  project: result.project,
                })),
              )
        // kilocode_change start - run bootstrap inside the Instance ALS so KilocodeBootstrap
        // (and anything it forks via Effect.forkDetach) sees Instance.directory.
        const ready = bootstrap.run.pipe(Effect.provideService(InstanceRef, ctx)) as Effect.Effect<void>
        yield* Effect.promise(() => instanceContext.provide(ctx, () => Effect.runPromise(ready)))
        // kilocode_change end
        return ctx
      }).pipe(Effect.withSpan("InstanceStore.boot"))

    const removeEntry = (directory: string, entry: Entry) =>
      Effect.sync(() => {
        if (cache.get(directory) !== entry) return false
        cache.delete(directory)
        return true
      })

    const completeLoad = (directory: string, input: LoadInput, entry: Entry) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(boot({ ...input, directory }))
        if (Exit.isFailure(exit)) yield* removeEntry(directory, entry)
        yield* Deferred.done(entry.deferred, exit).pipe(Effect.asVoid)
      })

    const emitDisposed = (input: { directory: string; project?: string }) =>
      Effect.sync(() =>
        GlobalBus.emit("event", {
          directory: input.directory,
          project: input.project,
          workspace: WorkspaceContext.workspaceID,
          payload: {
            type: "server.instance.disposed",
            properties: {
              directory: input.directory,
            },
          },
        }),
      )

    const disposeContext = Effect.fn("InstanceStore.disposeContext")(function* (ctx: InstanceContext) {
      yield* Effect.logInfo("disposing instance").pipe(Effect.annotateLogs("directory", ctx.directory))
      yield* Effect.promise(() => instanceContext.provide(ctx, () => runDisposers(ctx.directory))) // kilocode_change
      yield* emitDisposed({ directory: ctx.directory, project: ctx.project.id })
    })

    // kilocode_change start - LOCK-007: seal and drain the exact identity's
    // control + write leases before its disposers run. Resolved optionally so
    // stores layered without the lease coordinator (non-AppRuntime test
    // stores) keep the direct-disposal behavior — the seal is a no-op there.
    const sealLeases = (ctx: InstanceContext) =>
      Effect.gen(function* () {
        const leases = Option.getOrElse(yield* Effect.serviceOption(ControlLease.Service), () => ControlLease.noop)
        yield* leases.sealAndDrain(ctx)
      })
    // kilocode_change end

    const disposeEntry = Effect.fnUntraced(function* (directory: string, entry: Entry, ctx: InstanceContext) {
      if (cache.get(directory) !== entry) return false
      // kilocode_change start - remove disposed entries even when event publication fails
      const exit = yield* Effect.exit(disposeContext(ctx))
      const removed = yield* removeEntry(directory, entry)
      yield* exit
      return removed
      // kilocode_change end
    })

    // kilocode_change start - LOCK-005: resolve the convergence fence-load
    // registration for a load/reload admitted while a convergence fence is
    // active (config-write paths bypass the fence, so a first load OR an
    // explicit reload during a cold save would otherwise cache a pre-mutation
    // runtime the pass never sees). Resolves `Some(confirm)` when the global
    // fence or the directory's per-directory fence is active; the caller MUST
    // run `confirm` after the boot completes — success, failure, interruption —
    // so the coordinator converges the cached runtime before the fence drops.
    // The gate is resolved lazily (serviceOption), so non-server contexts and
    // tests without the gate are unaffected. The ConvergenceLoad marker skips
    // registration for the coordinator's own reboots, which would otherwise
    // re-register the directory in a loop.
    const fenceLoadConfirm = (directory: string) =>
      Effect.gen(function* () {
        const gate = Option.getOrElse(yield* Effect.serviceOption(GenerationGate.Service), () => undefined)
        const marker = yield* GenerationGate.ConvergenceLoad
        return !gate || marker ? Option.none<Effect.Effect<void>>() : yield* gate.registerFenceLoad(directory)
      })
    // kilocode_change end

    const load = (input: LoadInput): Effect.Effect<InstanceContext> => {
      const directory = FSUtil.resolve(input.directory)
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const existing = cache.get(directory)
          if (existing) return yield* restore(Deferred.await(existing.deferred))

          // kilocode_change start - LOCK-005: register loads admitted under an
          // active convergence fence (see fenceLoadConfirm above).
          const confirm = yield* fenceLoadConfirm(directory)
          // kilocode_change end

          const entry: Entry = { deferred: Deferred.makeUnsafe<InstanceContext>() }
          cache.set(directory, entry)
          yield* Effect.gen(function* () {
            yield* Effect.logInfo("creating instance").pipe(Effect.annotateLogs("directory", directory))
            yield* completeLoad(directory, input, entry)
          }).pipe(Effect.forkIn(scope, { startImmediately: true }))
          // kilocode_change start - confirm the fence load registration (LOCK-005)
          return yield* restore(Deferred.await(entry.deferred)).pipe(
            Effect.ensuring(confirm._tag === "Some" ? confirm.value : Effect.void),
          )
          // kilocode_change end
        }),
      ).pipe(Effect.withSpan("InstanceStore.load"))
    }

    const reload = (input: LoadInput): Effect.Effect<InstanceContext> => {
      const directory = FSUtil.resolve(input.directory)
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          // kilocode_change start - LOCK-005 (reload handshake): mirror the load
          // hook. An explicit reload that replaces a cached instance while a
          // convergence fence is active registers with the fence BEFORE the
          // cache replacement, so the coordinator converges the replacement
          // (dispose + reboot from current disk) before the fence releases — a
          // pre-mutation runtime can never survive a cold save via an explicit
          // reload. The confirm runs on every exit of the reload await —
          // success, failure, interruption — exactly like the load hook.
          const confirm = yield* fenceLoadConfirm(directory)
          // kilocode_change end

          const previous = cache.get(directory)
          const entry: Entry = { deferred: Deferred.makeUnsafe<InstanceContext>() }
          cache.set(directory, entry)
          yield* Effect.gen(function* () {
            yield* Effect.logInfo("reloading instance").pipe(Effect.annotateLogs("directory", directory))
            if (previous) {
              // kilocode_change start - LOCK-007: dispose reloads under the
              // previous instance context AFTER sealing and draining the
              // previous identity's control + write leases, so an active
              // snapshot control or write-intent handler on the replaced
              // identity is awaited before its disposers run (LOCK-001: the
              // reload may await exactly the leases for the identity it
              // replaces). A previous boot that failed has no identity to seal;
              // disposers still run and the disposed event still fires.
              const exit = yield* Deferred.await(previous.deferred).pipe(Effect.exit)
              if (Exit.isSuccess(exit)) {
                yield* sealLeases(exit.value)
                yield* Effect.promise(() => instanceContext.provide(exit.value, () => runDisposers(directory)))
              } else {
                yield* Effect.promise(() => runDisposers(directory))
              }
              // kilocode_change end
              yield* emitDisposed({ directory, project: input.project?.id })
            }
            yield* completeLoad(directory, input, entry)
          }).pipe(Effect.forkIn(scope, { startImmediately: true }))
          // kilocode_change start - confirm the fence load registration after
          // the replacement boot completes (LOCK-005 reload handshake)
          return yield* restore(Deferred.await(entry.deferred)).pipe(
            Effect.ensuring(confirm._tag === "Some" ? confirm.value : Effect.void),
          )
          // kilocode_change end
        }),
      ).pipe(Effect.withSpan("InstanceStore.reload"))
    }

    const dispose = Effect.fn("InstanceStore.dispose")(function* (ctx: InstanceContext) {
      const entry = cache.get(ctx.directory)
      if (!entry) return yield* disposeContext(ctx)

      const exit = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
      if (Exit.isFailure(exit)) return yield* removeEntry(ctx.directory, entry).pipe(Effect.asVoid)
      if (exit.value !== ctx) return
      yield* disposeEntry(ctx.directory, entry, ctx).pipe(Effect.asVoid)
    })

    // kilocode_change start - LOCK-007: lease-aware disposal primitive. Mirrors
    // `dispose` exactly — entry lookup, boot-failure removal, identity check,
    // disposed event — but seals and drains the exact identity's control +
    // write leases BEFORE any disposer runs, so an active snapshot control or
    // write-intent handler on the identity is awaited, never raced. Used by the
    // response-lifecycle explicit dispose path (lifecycle.ts) and any caller
    // that does not own a prior seal. The identity-mismatch branch stays a pure
    // no-op: a replaced identity is owned by the reload that replaced it.
    const disposeSafe = Effect.fn("InstanceStore.disposeSafe")(function* (ctx: InstanceContext) {
      const entry = cache.get(ctx.directory)
      if (!entry) {
        yield* sealLeases(ctx)
        return yield* disposeContext(ctx)
      }

      const exit = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
      if (Exit.isFailure(exit)) return yield* removeEntry(ctx.directory, entry).pipe(Effect.asVoid)
      if (exit.value !== ctx) return
      yield* sealLeases(ctx)
      yield* disposeEntry(ctx.directory, entry, ctx).pipe(Effect.asVoid)
    })
    // kilocode_change end

    const disposeDirectory = Effect.fn("InstanceStore.disposeDirectory")(function* (input: string) {
      const directory = FSUtil.resolve(input)
      const entry = cache.get(directory)
      if (!entry) return
      const exit = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
      if (Exit.isFailure(exit)) return yield* removeEntry(directory, entry).pipe(Effect.asVoid)
      yield* disposeEntry(directory, entry, exit.value).pipe(Effect.asVoid)
    })

    const disposeAllOnce = Effect.fnUntraced(function* () {
      yield* Effect.logInfo("disposing all instances")
      // kilocode_change start - dispose independent worktrees concurrently without interrupting siblings
      const entries = [...cache.entries()]
      const exits = yield* Effect.forEach(
        entries,
        (item) =>
          Effect.gen(function* () {
            const exit = yield* Deferred.await(item[1].deferred).pipe(Effect.exit)
            if (Exit.isFailure(exit)) {
              yield* Effect.logWarning("instance dispose failed").pipe(
                Effect.annotateLogs({ key: item[0], cause: exit.cause }),
              )
              yield* removeEntry(item[0], item[1])
              return
            }
            yield* disposeEntry(item[0], item[1], exit.value)
          }).pipe(Effect.exit),
        { concurrency: 4 },
      ).pipe(Effect.uninterruptible)
      for (const [index, exit] of exits.entries()) {
        if (Exit.isSuccess(exit)) continue
        yield* Effect.logWarning("instance dispose failed").pipe(
          Effect.annotateLogs({ key: entries[index]![0], cause: exit.cause }),
        )
      }
      const failure = exits.find(Exit.isFailure)
      if (failure) yield* failure
      // kilocode_change end
    })

    const cachedDisposeAll = yield* Effect.cachedWithTTL(disposeAllOnce(), Duration.zero)
    const disposeAll = Effect.fn("InstanceStore.disposeAll")(function* () {
      return yield* cachedDisposeAll
    })

    const provide = <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      load(input).pipe(Effect.flatMap((ctx) => effect.pipe(Effect.provideService(InstanceRef, ctx))))

    const snapshot = Effect.fn("InstanceStore.snapshot")(function* (input: string) { // kilocode_change start
      const directory = FSUtil.resolve(input)
      const current = cache.get(directory)
      if (!current) return Option.none<InstanceContext>()
      const exit = yield* Deferred.await(current.deferred).pipe(Effect.exit)
      return Exit.isSuccess(exit) ? Option.some(exit.value) : Option.none<InstanceContext>()
    })

    const directories = Effect.fn("InstanceStore.directories")(function* () {
      return [...cache.keys()]
    }) // kilocode_change end

    yield* Effect.addFinalizer(() => disposeAll().pipe(Effect.ignore))

    return Service.of({
      load,
      reload,
      dispose,
      disposeSafe, // kilocode_change - LOCK-007
      disposeDirectory,
      disposeAll,
      provide,
      snapshot, // kilocode_change
      directories, // kilocode_change
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Project.defaultLayer))

export * as InstanceStore from "./instance-store"
