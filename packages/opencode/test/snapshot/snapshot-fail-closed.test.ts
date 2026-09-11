import { expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Snapshot } from "../../src/snapshot"
import { disposeAllInstances, TestInstance, provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { afterEach } from "bun:test"
import { testEffect } from "../lib/effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"

const it = testEffect(
  Layer.mergeAll(Snapshot.defaultLayer, FSUtil.defaultLayer, testInstanceStoreLayer, CrossSpawnSpawner.defaultLayer),
)

afterEach(async () => {
  await disposeAllInstances()
})

const fwd = (...parts: string[]) => path.join(...parts).replaceAll("\\", "/")
const write = (file: string, content: string) => FSUtil.Service.use((fs) => fs.writeWithDirs(file, content))
const read = (file: string) => FSUtil.Service.use((fs) => fs.readFileString(file))
const exists = (file: string) => FSUtil.Service.use((fs) => fs.existsSafe(file))

const bootstrap = Effect.fn("FailClosed.bootstrap")(function* () {
  const tmp = yield* TestInstance
  yield* write(`${tmp.directory}/a.txt`, "A")
  yield* write(`${tmp.directory}/b.txt`, "B")
  return tmp
})

it.instance("restore with invalid hash fails typed and keeps files", () =>
  Effect.gen(function* () {
    const tmp = yield* bootstrap()
    const snap = yield* Snapshot.Service
    const before = yield* snap.track()
    expect(before).toBeTruthy()
    yield* write(`${tmp.directory}/a.txt`, "MUT")
    const err = yield* snap.restore("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef").pipe(Effect.flip)
    expect(err._tag).toBe("SnapshotRestoreError")
    if (err._tag === "SnapshotRestoreError") {
      expect(err.op).toBe("read-tree")
      expect(err.snapshot).toContain("deadbeef")
      expect(err.cwd).toBeTruthy()
    }
    expect(yield* read(`${tmp.directory}/a.txt`)).toBe("MUT")
  }),
  { git: true },
)

it.instance("revert rejects worktree-escape paths typed without mutation", () =>
  Effect.gen(function* () {
    const tmp = yield* bootstrap()
    const snap = yield* Snapshot.Service
    const before = yield* snap.track()
    expect(before).toBeTruthy()
    const outside = fwd(path.resolve(tmp.directory, ".."), "escape.txt")
    yield* write(`${tmp.directory}/victim.txt`, "V")
    const err = yield* snap.revert([{ hash: before!, files: [outside] }]).pipe(Effect.flip)
    expect(err._tag).toBe("SnapshotPathError")
    expect(yield* read(`${tmp.directory}/victim.txt`)).toBe("V")
  }),
  { git: true },
)

it.instance("revert with invalid hash fails typed and does not delete tracked file", () =>
  Effect.gen(function* () {
    const tmp = yield* bootstrap()
    const snap = yield* Snapshot.Service
    const before = yield* snap.track()
    expect(before).toBeTruthy()
    expect(before).toBeTruthy()
    yield* write(`${tmp.directory}/a.txt`, "MUT")
    const target = fwd(tmp.directory, "a.txt")
    const err = yield* snap
      .revert([{ hash: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", files: [target] }])
      .pipe(Effect.flip)
    expect(err._tag).toBe("SnapshotRevertError")
    expect(yield* read(`${tmp.directory}/a.txt`)).toBe("MUT")
  }),
  { git: true },
)

it.instance("revert deletes snapshot-absent file and empty patches succeed", () =>
  Effect.gen(function* () {
    const tmp = yield* bootstrap()
    const snap = yield* Snapshot.Service
    const before = yield* snap.track()
    expect(before).toBeTruthy()
    yield* write(`${tmp.directory}/new.txt`, "NEW")
    const patch = yield* snap.patch(before!)
    expect(patch.files).toContain(fwd(tmp.directory, "new.txt"))
    yield* snap.revert([patch])
    expect(yield* exists(`${tmp.directory}/new.txt`)).toBe(false)
    yield* snap.revert([])
    yield* snap.revert([{ hash: before!, files: [] }])
  }),
  { git: true },
)

it.instance("revert aggregates batch failures without swallowing", () =>
  Effect.gen(function* () {
    const tmp = yield* bootstrap()
    const snap = yield* Snapshot.Service
    const before = yield* snap.track()
    expect(before).toBeTruthy()
    yield* write(`${tmp.directory}/good.txt`, "GOOD")
    const good = fwd(tmp.directory, "good.txt")
    const bad = fwd(tmp.directory, "a.txt")
    const err = yield* snap
      .revert([
        { hash: before!, files: [good] },
        { hash: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", files: [bad] },
      ])
      .pipe(Effect.flip)
    expect(err._tag).toBe("SnapshotRevertError")
    if (err._tag === "SnapshotRevertError") expect(err.files).toContain(bad)
  }),
  { git: true },
)

it.instance("remove failure on snapshot-absent file fails typed", () =>
  Effect.gen(function* () {
    const tmp = yield* bootstrap()
    const snap = yield* Snapshot.Service
    const before = yield* snap.track()
    expect(before).toBeTruthy()
    yield* write(`${tmp.directory}/gone/extra.txt`, "EXTRA")
    yield* Effect.promise(() => import("fs/promises").then((fs) => fs.chmod(`${tmp.directory}/gone`, 0o555)))
    try {
      const target = fwd(tmp.directory, "gone", "extra.txt")
      const err = yield* snap.revert([{ hash: before!, files: [target] }]).pipe(Effect.flip)
      expect(err._tag).toBe("SnapshotRevertError")
      expect(yield* exists(target)).toBe(true)
    } finally {
      yield* Effect.promise(() => import("fs/promises").then((fs) => fs.chmod(`${tmp.directory}/gone`, 0o755)))
    }
  }),
  { git: true },
)

it.instance("checkout failure on tracked file fails typed and keeps on-disk content", () =>
  Effect.gen(function* () {
    const tmp = yield* bootstrap()
    const snap = yield* Snapshot.Service
    yield* write(`${tmp.directory}/locked/f.txt`, "ORIG")
    const before = yield* snap.track()
    expect(before).toBeTruthy()
    yield* write(`${tmp.directory}/locked/f.txt`, "MUT")
    yield* Effect.promise(() => import("fs/promises").then((fs) => fs.chmod(`${tmp.directory}/locked`, 0o555)))
    try {
      const target = fwd(tmp.directory, "locked", "f.txt")
      const err = yield* snap.revert([{ hash: before!, files: [target] }]).pipe(Effect.flip)
      expect(err._tag).toBe("SnapshotRevertError")
      expect(yield* read(`${tmp.directory}/locked/f.txt`)).toBe("MUT")
    } finally {
      yield* Effect.promise(() => import("fs/promises").then((fs) => fs.chmod(`${tmp.directory}/locked`, 0o755)))
    }
  }),
  { git: true },
)

// kilocode_change start - worktree-keyed exclusive window: same worktree serializes, failure releases.
it.instance("same worktree exclusive serializes file window", () =>
  Effect.gen(function* () {
    yield* bootstrap()
    const snap = yield* Snapshot.Service
    const probe = { cur: 0, max: 0 }
    const work = snap.exclusive(() =>
      Effect.gen(function* () {
        probe.cur += 1
        probe.max = Math.max(probe.max, probe.cur)
        yield* Effect.sleep("50 millis")
        probe.cur -= 1
      }),
    )
    yield* Effect.all([work, work], { concurrency: "unbounded" })
    expect(probe.max).toBe(1)
  }),
  { git: true },
)

it.instance("exclusive failure releases lock for next operation", () =>
  Effect.gen(function* () {
    yield* bootstrap()
    const snap = yield* Snapshot.Service
    const err = yield* snap
      .exclusive(() => Effect.fail(new Snapshot.RevertError({ message: "boom", files: ["x"] })))
      .pipe(Effect.flip)
    expect(err._tag).toBe("SnapshotRevertError")
    const probe = { cur: 0, max: 0 }
    const work = snap.exclusive(() =>
      Effect.gen(function* () {
        probe.cur += 1
        probe.max = Math.max(probe.max, probe.cur)
        yield* Effect.sleep("20 millis")
        probe.cur -= 1
      }),
    )
    yield* Effect.all([work, work], { concurrency: "unbounded" })
    expect(probe.max).toBe(1)
  }),
  { git: true },
)

it.live("different worktrees exclusive runs in parallel", () =>
  Effect.gen(function* () {
    const dirA = yield* tmpdirScoped({ git: true })
    const dirB = yield* tmpdirScoped({ git: true })
    const probe = { cur: 0, max: 0 }
    const work = (dir: string) =>
      provideInstance(dir)(
        Effect.gen(function* () {
          const snap = yield* Snapshot.Service
          return yield* snap.exclusive(() =>
            Effect.gen(function* () {
              probe.cur += 1
              probe.max = Math.max(probe.max, probe.cur)
              yield* Effect.sleep("50 millis")
              probe.cur -= 1
            }),
          )
        }),
      )
    yield* Effect.all([work(dirA), work(dirB)], { concurrency: "unbounded" })
    expect(probe.max).toBe(2)
  }),
)
// kilocode_change end
