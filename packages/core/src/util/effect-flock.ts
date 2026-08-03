import path from "path"
import os from "os"
import { randomUUID } from "crypto"
import { Context, Effect, Function, Layer, Option, Schedule, Schema } from "effect"
import type { FileSystem, Scope } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { Hash } from "./hash"

export namespace EffectFlock {
  // ---------------------------------------------------------------------------
  // Errors
  // ---------------------------------------------------------------------------

  export class LockTimeoutError extends Schema.TaggedErrorClass<LockTimeoutError>()("LockTimeoutError", {
    key: Schema.String,
  }) {}

  export class LockCompromisedError extends Schema.TaggedErrorClass<LockCompromisedError>()("LockCompromisedError", {
    detail: Schema.String,
  }) {}

  class ReleaseError extends Schema.TaggedErrorClass<ReleaseError>()("ReleaseError", {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  }) {
    override get message() {
      return this.detail
    }
  }

  /** Internal: signals "lock is held, retry later". Never leaks to callers. */
  class NotAcquired extends Schema.TaggedErrorClass<NotAcquired>()("NotAcquired", {}) {}

  export type LockError = LockTimeoutError | LockCompromisedError

  // ---------------------------------------------------------------------------
  // Timing (baked in — no caller ever overrides these)
  // ---------------------------------------------------------------------------

  const STALE_MS = 60_000
  const TIMEOUT_MS = 5 * 60_000
  const BASE_DELAY_MS = 100
  const MAX_DELAY_MS = 2_000
  const HEARTBEAT_MS = Math.max(100, Math.floor(STALE_MS / 3))

  const retrySchedule = Schedule.exponential(BASE_DELAY_MS, 1.7).pipe(
    Schedule.either(Schedule.spaced(MAX_DELAY_MS)),
    Schedule.jittered,
    Schedule.while((meta) => meta.elapsed < TIMEOUT_MS),
  )

  // ---------------------------------------------------------------------------
  // Lock metadata schema
  // ---------------------------------------------------------------------------

  const LockMetaJson = Schema.fromJsonString(
    Schema.Struct({
      token: Schema.String,
      pid: Schema.Number,
      hostname: Schema.String,
      createdAt: Schema.String,
    }),
  )

  const decodeMeta = Schema.decodeUnknownSync(LockMetaJson)
  const encodeMeta = Schema.encodeSync(LockMetaJson)

  // ---------------------------------------------------------------------------
  // Service
  // ---------------------------------------------------------------------------

  export interface Interface {
    readonly acquire: (key: string, dir?: string) => Effect.Effect<void, LockError, Scope.Scope>
    readonly withLock: {
      (key: string, dir?: string): <A, E, R>(body: Effect.Effect<A, E, R>) => Effect.Effect<A, E | LockError, R>
      <A, E, R>(body: Effect.Effect<A, E, R>, key: string, dir?: string): Effect.Effect<A, E | LockError, R>
    }
  }

  export class Service extends Context.Service<Service, Interface>()("EffectFlock") {}

  // kilocode_change start
  /**
   * In-process lock ownership (LOCK-002/003). Shared by every EffectFlock layer
   * instance in this process: keyed by the lock directory path so distinct
   * (root, key) spaces never collide. Each entry carries the unique handle
   * token that created it, so a release compare-deletes only its OWN owner — a
   * replacement owner that re-acquired the fs lock after this holder's removal
   * is never removed. A fiber that already owns a lock may re-acquire it — a
   * nested same-key `withLock`/`acquire` in the same fiber is a depth-tracked
   * pass-through instead of a 5-minute `NotAcquired` retry — and a lock owned
   * by a live in-process fiber is never judged stale, so one EffectFlock
   * instance can never stale-reap another instance's held lock in the same
   * process even when the heartbeat lags under scheduler pressure.
   */
  const owners = new Map<string, { fiber: number; depth: number; token: string }>()
  // kilocode_change end

  // ---------------------------------------------------------------------------
  // Layer
  // ---------------------------------------------------------------------------

  function wall() {
    return performance.timeOrigin + performance.now()
  }

  const mtimeMs = (info: FileSystem.File.Info) => Option.getOrElse(info.mtime, () => new Date(0)).getTime()

  const isPathGone = (e: PlatformError) => e.reason._tag === "NotFound" || e.reason._tag === "Unknown"

  export const layer: Layer.Layer<Service, never, Global.Service | FSUtil.Service> = Layer.effect(
    Service,
    Effect.gen(function* () {
      const global = yield* Global.Service
      const fs = yield* FSUtil.Service
      const lockRoot = path.join(global.state, "locks")
      const hostname = os.hostname()
      const ensuredDirs = new Set<string>()

      // -- helpers (close over fs) --

      const safeStat = (file: string) =>
        fs.stat(file).pipe(
          Effect.catchIf(isPathGone, () => Effect.void),
          Effect.orDie,
        )

      const forceRemove = (target: string) => fs.remove(target, { recursive: true }).pipe(Effect.ignore)

      /** Atomic mkdir — returns true if created, false if already exists, dies on other errors. */
      const atomicMkdir = (dir: string) =>
        fs.makeDirectory(dir, { mode: 0o700 }).pipe(
          Effect.as(true),
          Effect.catchIf(
            (e) => e.reason._tag === "AlreadyExists",
            () => Effect.succeed(false),
          ),
          Effect.orDie,
        )

      /** Write with exclusive create — compromised error if file already exists. */
      const exclusiveWrite = (filePath: string, content: string, lockDir: string, detail: string) =>
        fs.writeFileString(filePath, content, { flag: "wx" }).pipe(
          Effect.catch(() =>
            Effect.gen(function* () {
              yield* forceRemove(lockDir)
              return yield* new LockCompromisedError({ detail })
            }),
          ),
        )

      const cleanStaleBreaker = Effect.fnUntraced(function* (breakerPath: string) {
        const bs = yield* safeStat(breakerPath)
        if (bs && wall() - mtimeMs(bs) > STALE_MS) yield* forceRemove(breakerPath)
        return false
      })

      const ensureDir = Effect.fnUntraced(function* (dir: string) {
        if (ensuredDirs.has(dir)) return
        yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.orDie)
        ensuredDirs.add(dir)
      })

      const isStale = Effect.fnUntraced(function* (lockDir: string, heartbeatPath: string, metaPath: string) {
        // kilocode_change start
        // A lock owned by a live in-process fiber is never stale: the heartbeat
        // can lag under scheduler pressure, but the owner is demonstrably alive.
        // This closes the same-process compromise where one EffectFlock instance
        // could stale-reap another instance's held lock (LOCK-003) — the breaker
        // must only ever recover locks whose owner really is gone.
        if (owners.has(lockDir)) return false
        // kilocode_change end

        const now = wall()

        const hb = yield* safeStat(heartbeatPath)
        if (hb) return now - mtimeMs(hb) > STALE_MS

        const meta = yield* safeStat(metaPath)
        if (meta) return now - mtimeMs(meta) > STALE_MS

        const dir = yield* safeStat(lockDir)
        if (!dir) return false

        return now - mtimeMs(dir) > STALE_MS
      })

      // -- single lock attempt --

      type Handle = { token: string; metaPath: string; heartbeatPath: string; lockDir: string }

      const tryAcquireLockDir = (lockDir: string, key: string) =>
        Effect.gen(function* () {
          const token = randomUUID()
          const metaPath = path.join(lockDir, "meta.json")
          const heartbeatPath = path.join(lockDir, "heartbeat")

          // Atomic mkdir — the POSIX lock primitive
          const created = yield* atomicMkdir(lockDir)

          if (!created) {
            if (!(yield* isStale(lockDir, heartbeatPath, metaPath))) return yield* new NotAcquired()

            // Stale — race for breaker ownership
            const breakerPath = lockDir + ".breaker"

            const claimed = yield* fs.makeDirectory(breakerPath, { mode: 0o700 }).pipe(
              Effect.as(true),
              Effect.catchIf(
                (e) => e.reason._tag === "AlreadyExists",
                () => cleanStaleBreaker(breakerPath),
              ),
              Effect.catchIf(isPathGone, () => Effect.succeed(false)),
              Effect.orDie,
            )

            if (!claimed) return yield* new NotAcquired()

            // We own the breaker — double-check staleness, nuke, recreate
            const recreated = yield* Effect.gen(function* () {
              if (!(yield* isStale(lockDir, heartbeatPath, metaPath))) return false
              yield* forceRemove(lockDir)
              return yield* atomicMkdir(lockDir)
            }).pipe(Effect.ensuring(forceRemove(breakerPath)))

            if (!recreated) return yield* new NotAcquired()
          }

          // We own the lock dir — write heartbeat + meta with exclusive create
          yield* exclusiveWrite(heartbeatPath, "", lockDir, "heartbeat already existed")

          const metaJson = encodeMeta({ token, pid: process.pid, hostname, createdAt: new Date().toISOString() })
          yield* exclusiveWrite(metaPath, metaJson, lockDir, "meta.json already existed")

          return { token, metaPath, heartbeatPath, lockDir } satisfies Handle
        }).pipe(
          Effect.withSpan("EffectFlock.tryAcquire", {
            attributes: { key },
          }),
        )

      // -- retry wrapper (preserves Handle type) --
      // kilocode_change start
      //
      // LOCK-003: the retry loop lives OUTSIDE acquireRelease. Each single
      // attempt (atomic mkdir + exclusive writes) is an uninterruptible
      // critical section, but the WAIT between attempts must be interruptible —
      // an aborted request must not pin an uninterruptible 5-minute retry.

      const acquireHandle = (lockfile: string, key: string): Effect.Effect<Handle, LockError, Scope.Scope> =>
        Effect.acquireRelease(tryAcquireLockDir(lockfile, key), (handle) => release(handle)).pipe(
      // kilocode_change end
          Effect.retry({
            while: (err) => err._tag === "NotAcquired",
            schedule: retrySchedule,
          }),
          Effect.catchTag("NotAcquired", () => Effect.fail(new LockTimeoutError({ key }))),
        )
      // -- release --

      const release = (handle: Handle) =>
        Effect.gen(function* () {
          const raw = yield* fs.readFileString(handle.metaPath).pipe(
            Effect.catch((err) => {
              if (isPathGone(err)) return Effect.die(new ReleaseError({ detail: "metadata missing" }))
              return Effect.die(err)
            }),
          )

          const parsed = yield* Effect.try({
            try: () => decodeMeta(raw),
            catch: (cause) => new ReleaseError({ detail: "metadata invalid", cause }),
          }).pipe(Effect.orDie)

          if (parsed.token !== handle.token) return yield* Effect.die(new ReleaseError({ detail: "token mismatch" }))

          yield* forceRemove(handle.lockDir)
        }).pipe(
          // kilocode_change start
          // LOCK-002: the owners entry is cleared only after the fs release
          // attempt, and only if it still carries THIS handle's unique token.
          // On success the lock dir is already gone, so clearing is safe. On
          // failure (metadata missing / token mismatch after a cross-process
          // reap) the fs lock either belongs to a replacement or is abandoned
          // garbage — clearing our own identity lets it be reaped after
          // staleness instead of wedging the key forever. A replacement owner
          // that re-acquired the fs lock has a different token and is never
          // deleted. Clearing the entry before the fs release would open the
          // stale-reap window for the still-held lock (LOCK-003), so this runs
          // strictly after the release attempt.
          Effect.ensuring(
            Effect.sync(() => {
              const current = owners.get(handle.lockDir)
              if (current && current.token === handle.token) owners.delete(handle.lockDir)
            }),
          ),
          // kilocode_change end
        )

      // -- build service --

      const acquire = Effect.fn("EffectFlock.acquire")(function* (key: string, dir?: string) {
        const lockDir = dir ?? lockRoot
        yield* ensureDir(lockDir)

        const lockfile = path.join(lockDir, Hash.fast(key) + ".lock")
        // kilocode_change start
        const id = yield* Effect.fiberId

        // Reentrant same-fiber acquire: this fiber already owns the lock, so
        // run as a depth-tracked pass-through. Never block in the NotAcquired
        // retry loop — a nested same-key withLock must not deadlock for the
        // full TIMEOUT_MS window (LOCK-003: no reentrant deadlock).
        const owner = owners.get(lockfile)
        if (owner?.fiber === id) {
          owner.depth += 1
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              owner.depth -= 1
            }),
          )
          return
        }

        // acquireRelease: each attempt is uninterruptible, the wait between
        // attempts is interruptible, and release is guaranteed on scope close.
        const handle = yield* acquireHandle(lockfile, key)

        // Record in-process ownership before the heartbeat starts so a
        // competing acquire in this process can never reap a live holder
        // (LOCK-003). The entry carries this handle's unique token so release
        // compare-deletes only its own identity (LOCK-002); it is removed only
        // after the fs release attempt — never by a scope finalizer that could
        // run before the fs release.
        owners.set(lockfile, { fiber: id, depth: 1, token: handle.token })
        // kilocode_change end

        // Heartbeat fiber — scoped, so it's interrupted before release runs
        yield* fs
          .utimes(handle.heartbeatPath, new Date(), new Date())
          .pipe(Effect.ignore, Effect.repeat(Schedule.spaced(HEARTBEAT_MS)), Effect.forkScoped)
      })

      const withLock: Interface["withLock"] = Function.dual(
        (args) => Effect.isEffect(args[0]),
        <A, E, R>(body: Effect.Effect<A, E, R>, key: string, dir?: string): Effect.Effect<A, E | LockError, R> =>
          Effect.scoped(
            Effect.gen(function* () {
              yield* acquire(key, dir)
              return yield* body
            }),
          ),
      )

      return Service.of({ acquire, withLock })
    }),
  )

  export const defaultLayer = layer.pipe(Layer.provide(FSUtil.defaultLayer), Layer.provide(Global.layer))
}
