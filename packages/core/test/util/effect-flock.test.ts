import { describe, expect } from "bun:test"
import { spawn } from "child_process"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect" // kilocode_change - Deferred/Fiber used by LOCK-003 ownership tests
import { testEffect } from "../lib/effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Global } from "@opencode-ai/core/global"
import { Hash } from "@opencode-ai/core/util/hash"

function lock(dir: string, key: string) {
  return path.join(dir, Hash.fast(key) + ".lock")
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function exists(file: string) {
  return fs
    .stat(file)
    .then(() => true)
    .catch(() => false)
}

async function readJson<T>(p: string): Promise<T> {
  return JSON.parse(await fs.readFile(p, "utf8"))
}

// ---------------------------------------------------------------------------
// Worker subprocess helpers
// ---------------------------------------------------------------------------

type Msg = {
  key: string
  dir: string
  holdMs?: number
  ready?: string
  active?: string
  done?: string
}

const root = path.join(import.meta.dir, "../..")
const worker = path.join(import.meta.dir, "../fixture/effect-flock-worker.ts")

function run(msg: Msg) {
  return new Promise<{ code: number; stdout: Buffer; stderr: Buffer }>((resolve) => {
    const proc = spawn(process.execPath, [worker, JSON.stringify(msg)], { cwd: root })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    proc.stdout?.on("data", (data) => stdout.push(Buffer.from(data)))
    proc.stderr?.on("data", (data) => stderr.push(Buffer.from(data)))
    proc.on("close", (code) => {
      resolve({ code: code ?? 1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) })
    })
  })
}

// kilocode_change start - make worker finalization await the process close event without a Windows race
const closed = new WeakMap<ReturnType<typeof spawn>, Promise<void>>()

function spawnWorker(msg: Msg) {
  const proc = spawn(process.execPath, [worker, JSON.stringify(msg)], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  })
  closed.set(proc, new Promise((resolve) => proc.once("close", () => resolve())))
  return proc
}

async function stopWorker(proc: ReturnType<typeof spawnWorker>) {
  const close = closed.get(proc) ?? Promise.resolve()
  if (proc.exitCode !== null || proc.signalCode !== null) return close
  if (process.platform !== "win32" || !proc.pid) {
    proc.kill()
    return close
  }
  await new Promise<void>((resolve) => {
    const kill = spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true })
    kill.once("error", () => resolve())
    kill.once("close", () => resolve())
  })
  proc.kill()
  return close
}
// kilocode_change end

async function waitForFile(file: string, timeout = 3_000) {
  const stop = Date.now() + timeout
  while (Date.now() < stop) {
    if (await exists(file)) return
    await sleep(20)
  }
  throw new Error(`Timed out waiting for file: ${file}`)
}

// ---------------------------------------------------------------------------
// Test layer
// ---------------------------------------------------------------------------

const testGlobal = Global.layerWith({
  home: os.homedir(),
  data: os.tmpdir(),
  cache: os.tmpdir(),
  config: os.tmpdir(),
  state: os.tmpdir(),
  bin: os.tmpdir(),
  log: os.tmpdir(),
})

const testLayer = EffectFlock.layer.pipe(Layer.provide(testGlobal), Layer.provide(FSUtil.defaultLayer))

// kilocode_change start
// LOCK-002: a gated FSUtil layer that pauses the flock's `remove` on the lock
// dir AFTER the directory is gone but BEFORE the effect returns. That pause is
// the exact interleaving window of the owner-replacement race: the releasing
// holder has dropped the fs lock but has not yet finished its release, so a
// competing fiber can re-acquire and register as the new owner.
let gate: { lockDir: string; removed: Deferred.Deferred<void>; proceed: Deferred.Deferred<void> } | undefined

const gatedFSLayer = Layer.effect(
  FSUtil.Service,
  Effect.gen(function* () {
    const real = yield* FSUtil.Service
    return FSUtil.Service.of({
      ...real,
      remove: (target: string, options?: Parameters<FSUtil.Interface["remove"]>[1]) =>
        real.remove(target, options).pipe(
          Effect.flatMap((out) =>
            Effect.gen(function* () {
              const g = gate
              if (!g || target !== g.lockDir) return out
              yield* Deferred.succeed(g.removed, void 0)
              yield* Deferred.await(g.proceed)
              return out
            }),
          ),
        ),
    })
  }),
)

const gatedLayer = EffectFlock.layer.pipe(
  Layer.provide(testGlobal),
  Layer.provide(gatedFSLayer.pipe(Layer.provide(FSUtil.defaultLayer))),
)
const gatedIt = testEffect(gatedLayer)
// kilocode_change end

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("util.effect-flock", () => {
  const it = testEffect(testLayer)

  it.live(
    "acquire and release via scoped Effect",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")
      const lockDir = lock(dir, "eflock:acquire")

      yield* Effect.scoped(flock.acquire("eflock:acquire", dir))

      expect(yield* Effect.promise(() => exists(lockDir))).toBe(false)
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  it.live(
    "withLock data-first",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")

      let hit = false
      yield* flock.withLock(
        Effect.sync(() => {
          hit = true
        }),
        "eflock:df",
        dir,
      )
      expect(hit).toBe(true)
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  it.live(
    "withLock pipeable",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")

      let hit = false
      yield* Effect.sync(() => {
        hit = true
      }).pipe(flock.withLock("eflock:pipe", dir))
      expect(hit).toBe(true)
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  it.live(
    "writes owner metadata",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")
      const key = "eflock:meta"
      const file = path.join(lock(dir, key), "meta.json")

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* flock.acquire(key, dir)
          const json = yield* Effect.promise(() =>
            readJson<{ token?: unknown; pid?: unknown; hostname?: unknown; createdAt?: unknown }>(file),
          )
          expect(typeof json.token).toBe("string")
          expect(typeof json.pid).toBe("number")
          expect(typeof json.hostname).toBe("string")
          expect(typeof json.createdAt).toBe("string")
        }),
      )
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  it.live(
    "breaks stale lock dirs",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")
      const key = "eflock:stale"
      const lockDir = lock(dir, key)

      yield* Effect.promise(async () => {
        await fs.mkdir(lockDir, { recursive: true })
        const old = new Date(Date.now() - 120_000)
        await fs.utimes(lockDir, old, old)
      })

      let hit = false
      yield* flock.withLock(
        Effect.sync(() => {
          hit = true
        }),
        key,
        dir,
      )
      expect(hit).toBe(true)
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  it.live(
    "recovers from stale breaker",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")
      const key = "eflock:stale-breaker"
      const lockDir = lock(dir, key)
      const breaker = lockDir + ".breaker"

      yield* Effect.promise(async () => {
        await fs.mkdir(lockDir, { recursive: true })
        await fs.mkdir(breaker)
        const old = new Date(Date.now() - 120_000)
        await fs.utimes(lockDir, old, old)
        await fs.utimes(breaker, old, old)
      })

      let hit = false
      yield* flock.withLock(
        Effect.sync(() => {
          hit = true
        }),
        key,
        dir,
      )
      expect(hit).toBe(true)
      expect(yield* Effect.promise(() => exists(breaker))).toBe(false)
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  it.live(
    "detects compromise when lock dir removed",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")
      const key = "eflock:compromised"
      const lockDir = lock(dir, key)

      const result = yield* flock
        .withLock(
          Effect.promise(() => fs.rm(lockDir, { recursive: true, force: true })),
          key,
          dir,
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(result)).toBe(true)
      expect(Exit.isFailure(result) ? Cause.pretty(result.cause) : "").toContain("missing")
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  it.live(
    "detects token mismatch",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")
      const key = "eflock:token"
      const lockDir = lock(dir, key)
      const meta = path.join(lockDir, "meta.json")

      const result = yield* flock
        .withLock(
          Effect.promise(async () => {
            const json = await readJson<{ token?: string }>(meta)
            json.token = "tampered"
            await fs.writeFile(meta, JSON.stringify(json, null, 2))
          }),
          key,
          dir,
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(result)).toBe(true)
      expect(Exit.isFailure(result) ? Cause.pretty(result.cause) : "").toContain("token mismatch")
      expect(yield* Effect.promise(() => exists(lockDir))).toBe(true)
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  it.live(
    "fails on unwritable lock roots",
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")

      yield* Effect.promise(async () => {
        await fs.mkdir(dir, { recursive: true })
        await fs.chmod(dir, 0o500)
      })

      const result = yield* flock.withLock(Effect.void, "eflock:perm", dir).pipe(Effect.exit)
      // oxlint-disable-next-line no-base-to-string -- Exit has a useful toString for test assertions
      expect(String(result)).toContain("PermissionDenied")
      yield* Effect.promise(() => fs.chmod(dir, 0o700).then(() => fs.rm(tmp, { recursive: true, force: true })))
    }),
  )

  it.live(
    "enforces mutual exclusion under process contention",
    () =>
      Effect.promise(async () => {
        const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "eflock-stress-"))
        const dir = path.join(tmp, "locks")
        const done = path.join(tmp, "done.log")
        const active = path.join(tmp, "active")
        const n = 16

        try {
          const out = await Promise.all(
            Array.from({ length: n }, () => run({ key: "eflock:stress", dir, done, active, holdMs: 30 })),
          )

          expect(out.map((x) => x.code)).toEqual(Array.from({ length: n }, () => 0))
          expect(out.map((x) => x.stderr.toString()).filter(Boolean)).toEqual([])

          const lines = (await fs.readFile(done, "utf8"))
            .split("\n")
            .map((x) => x.trim())
            .filter(Boolean)
          expect(lines.length).toBe(n)
        } finally {
          await fs.rm(tmp, { recursive: true, force: true })
        }
      }),
    60_000,
  )

  it.live(
    "recovers after a crashed lock owner",
    () =>
      Effect.promise(async () => {
        const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "eflock-crash-"))
        const dir = path.join(tmp, "locks")
        const ready = path.join(tmp, "ready")

        const proc = spawnWorker({ key: "eflock:crash", dir, ready, holdMs: 120_000 })

        try {
          await waitForFile(ready, 20_000) // kilocode_change - hosted macOS can start this worker slowly after stress tests
          await stopWorker(proc) // kilocode_change - stopWorker now awaits close before returning

          // Backdate lock files so they're past STALE_MS (60s)
          const lockDir = lock(dir, "eflock:crash")
          const old = new Date(Date.now() - 120_000)
          await fs.utimes(lockDir, old, old).catch(() => {})
          await fs.utimes(path.join(lockDir, "heartbeat"), old, old).catch(() => {})
          await fs.utimes(path.join(lockDir, "meta.json"), old, old).catch(() => {})

          const done = path.join(tmp, "done.log")
          const result = await run({ key: "eflock:crash", dir, done, holdMs: 10 })
          expect(result.code).toBe(0)
          expect(result.stderr.toString()).toBe("")
        } finally {
          await stopWorker(proc).catch(() => {})
          await fs.rm(tmp, { recursive: true, force: true })
        }
      }),
    60_000, // kilocode_change - match the wider worker readiness window
  )

  // kilocode_change start
  // ─── LOCK-003: same-process lock ownership ───────────────────────────

  it.live(
    "same-fiber nested same-key acquire is reentrant, not a deadlock",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")
      const key = "eflock:reentrant"

      let inner = false
      // Must complete immediately: a nested same-key withLock in the same
      // fiber is a depth-tracked pass-through (LOCK-003), never a 5-minute
      // NotAcquired retry.
      const exit = yield* Effect.exit(
        Effect.timeout(
          flock.withLock(
            Effect.gen(function* () {
              yield* flock.withLock(
                Effect.sync(() => {
                  inner = true
                }),
                key,
                dir,
              )
            }),
            key,
            dir,
          ),
          "2 seconds",
        ),
      )
      expect(exit._tag).toBe("Success")
      expect(inner).toBe(true)
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  it.live(
    "nested different keys both acquire (transaction lock shape)",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")
      const global = "eflock:global-target"
      const project = "eflock:project-target"

      const exit = yield* Effect.exit(
        Effect.timeout(
          flock.withLock(
            Effect.gen(function* () {
              return yield* flock.withLock(Effect.succeed("project-ok"), project, dir)
            }),
            global,
            dir,
          ),
          "2 seconds",
        ),
      )
      expect(exit._tag).toBe("Success")
      if (exit._tag === "Success") expect(exit.value).toBe("project-ok")
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  it.live(
    "different fibers on the same key still serialize",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")
      const key = "eflock:serialize"
      let concurrent = 0
      let max = 0

      const enter = Effect.gen(function* () {
        yield* Effect.sync(() => {
          concurrent += 1
          max = Math.max(max, concurrent)
        })
        yield* Effect.sleep("60 millis")
        yield* Effect.sync(() => {
          concurrent -= 1
        })
      })

      const a = yield* Effect.forkScoped(flock.withLock(enter, key, dir))
      const b = yield* Effect.forkScoped(flock.withLock(enter, key, dir))
      yield* Fiber.join(a)
      yield* Fiber.join(b)
      expect(max).toBe(1)
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  it.live(
    "a live in-process holder is never reaped as stale (LOCK-003)",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")
      const key = "eflock:live-stale"
      const lockDir = lock(dir, key)
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()

      // Holder A acquires, backdates its own lock files to simulate a lagged
      // heartbeat, then parks until released.
      const holder = yield* Effect.forkScoped(
        flock.withLock(
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, void 0)
            const old = new Date(Date.now() - 120_000)
            yield* Effect.promise(() =>
              Promise.all([
                fs.utimes(lockDir, old, old),
                fs.utimes(path.join(lockDir, "heartbeat"), old, old),
                fs.utimes(path.join(lockDir, "meta.json"), old, old),
              ]),
            )
            yield* Deferred.await(release)
          }),
          key,
          dir,
        ),
      )
      yield* Deferred.await(entered)

      // Competitor B: the lock looks stale on disk, but A is a live in-process
      // owner — B must wait, never reap (no LockCompromisedError).
      const blocked = yield* Effect.exit(
        Effect.timeout(flock.withLock(Effect.void, key, dir), "500 millis"),
      )
      expect(blocked._tag).toBe("Failure")

      // Release A: B acquires cleanly afterwards, and A's release must not
      // surface a ReleaseError (metadata was never reaped away).
      yield* Deferred.succeed(release, void 0)
      yield* Fiber.join(holder)
      const acquired = yield* Effect.exit(
        Effect.timeout(flock.withLock(Effect.succeed(true), key, dir), "3 seconds"),
      )
      expect(acquired._tag).toBe("Success")
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  // ─── LOCK-002: owner replacement race ────────────────────────────────

  gatedIt.live(
    "release/reacquire interleaving cannot delete the replacement owner (LOCK-002)",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")
      const key = "eflock:replace"
      const lockDir = lock(dir, key)

      const removed = yield* Deferred.make<void>()
      const proceed = yield* Deferred.make<void>()
      gate = { lockDir, removed, proceed }

      // A holds the lock; its release pauses inside `remove` right after the
      // lock dir is gone (the exact window the audit found: forceRemove then
      // an unconditional owners.delete).
      const a = yield* Effect.forkScoped(
        flock.withLock(Effect.sync(() => {}), key, dir).pipe(Effect.exit),
      )
      yield* Deferred.await(removed)

      // B re-acquires the now-free fs lock and registers as the new owner
      // before A's release finishes.
      const bEntered = yield* Deferred.make<void>()
      const bGo = yield* Deferred.make<void>()
      const b = yield* Effect.forkScoped(
        flock.withLock(
          Effect.gen(function* () {
            yield* Deferred.succeed(bEntered, void 0)
            yield* Deferred.await(bGo)
          }),
          key,
          dir,
        ),
      )
      yield* Deferred.await(bEntered)

      // Let A's release complete: its compare-delete must NOT remove B's entry.
      yield* Deferred.succeed(proceed, void 0)
      const aExit = yield* Effect.exit(Fiber.join(a))
      expect(aExit._tag).toBe("Success")

      // Make B's lock look stale on disk. B's owner entry is the only thing
      // keeping it alive: if A's release had removed B's entry, the competitor
      // would stale-reap B's still-held lock and acquire. With the entry
      // intact, the competitor must stay blocked (B's heartbeat only fires
      // every HEARTBEAT_MS ≈ 20s, so the files stay stale for the whole
      // 500ms competitor window — deterministic for both outcomes).
      const old = new Date(Date.now() - 120_000)
      yield* Effect.promise(() =>
        Promise.all([
          fs.utimes(lockDir, old, old).catch(() => {}),
          fs.utimes(path.join(lockDir, "heartbeat"), old, old).catch(() => {}),
          fs.utimes(path.join(lockDir, "meta.json"), old, old).catch(() => {}),
        ]),
      )
      const blocked = yield* Effect.exit(Effect.timeout(flock.withLock(Effect.void, key, dir), "500 millis"))
      expect(blocked._tag).toBe("Failure")

      // B still releases cleanly: its fs lock was never reaped away.
      yield* Deferred.succeed(bGo, void 0)
      const bExit = yield* Effect.exit(Fiber.join(b))
      expect(bExit._tag).toBe("Success")
      gate = undefined
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  it.live(
    "release failure after a cross-process reap leaves no stale owner (LOCK-002)",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")
      const key = "eflock:reap-fail"
      const lockDir = lock(dir, key)
      const meta = path.join(lockDir, "meta.json")

      const entered = yield* Deferred.make<void>()
      const go = yield* Deferred.make<void>()
      const holder = yield* Effect.forkScoped(
        flock.withLock(
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, void 0)
            yield* Deferred.await(go)
          }),
          key,
          dir,
        ),
      )
      yield* Deferred.await(entered)

      // Simulate another process reaping the lock and re-creating it with its
      // own token (the fs lock no longer belongs to this holder).
      yield* Effect.promise(async () => {
        await fs.rm(lockDir, { recursive: true, force: true })
        await fs.mkdir(lockDir, { recursive: true })
        await fs.writeFile(
          meta,
          JSON.stringify({ token: "replaced", pid: 9999, hostname: "other-host", createdAt: new Date().toISOString() }),
        )
      })

      // Release: reads the replaced meta, dies with token mismatch — and the
      // ensuring path must clear ONLY the releasing owner's identity.
      yield* Deferred.succeed(go, void 0)
      const holderExit = yield* Effect.exit(Fiber.join(holder))
      expect(Exit.isFailure(holderExit)).toBe(true)

      // A stale owner entry would make isStale return false forever, wedging
      // the key: backdate the recreated lock files and a fresh acquire must be
      // able to reap and recover them.
      const old = new Date(Date.now() - 120_000)
      yield* Effect.promise(() =>
        Promise.all([
          fs.utimes(lockDir, old, old).catch(() => {}),
          fs.utimes(meta, old, old).catch(() => {}),
        ]),
      )
      const acquired = yield* Effect.exit(
        Effect.timeout(flock.withLock(Effect.succeed("recovered"), key, dir), "3 seconds"),
      )
      expect(acquired._tag).toBe("Success")
      if (acquired._tag === "Success") expect(acquired.value).toBe("recovered")
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )
  // kilocode_change end
})
