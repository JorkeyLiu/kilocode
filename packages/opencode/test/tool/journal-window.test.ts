import { describe, expect, afterEach } from "bun:test"
import path from "path"
import { Cause, Effect, Exit, Layer, Semaphore } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Snapshot } from "@/snapshot"
import { SnapshotJournal } from "@/snapshot/journal"
import { JournalWindow } from "@/tool/journal-window"
import { InstanceState } from "@/effect/instance-state"
import { LSP } from "@/lsp/lsp"
import { Format } from "@/format"
import { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { EditTool } from "@/tool/edit"
import { WriteTool } from "@/tool/write"
import { ApplyPatchTool } from "@/tool/apply_patch"
import { SessionID, MessageID } from "@/session/schema"
import {
  disposeAllInstances,
  provideInstance,
  TestInstance,
  tmpdirScoped,
  testInstanceStoreLayer,
} from "../fixture/fixture"
import { ensureJournalSession } from "../fixture/journal"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const probe = { cur: 0, max: 0 }
const calls = { exclusive: 0 }
const order: string[] = []
const locks = new Map<string, Semaphore.Semaphore>()

const seen = (key: string) => {
  const hit = locks.get(key)
  if (hit) return hit
  const next = Semaphore.makeUnsafe(1)
  locks.set(key, next)
  return next
}

const keyed = Layer.succeed(
  Snapshot.Service,
  Snapshot.Service.of({
    init: () => Effect.void,
    cleanup: () => Effect.void,
    track: () => Effect.succeed(undefined),
    patch: (hash: string) => Effect.succeed({ hash, files: [] }),
    restore: () => Effect.void,
    revert: () => Effect.void,
    diff: () => Effect.succeed(""),
    diffFull: () => Effect.succeed([]),
    exclusive: (fn) =>
      Effect.gen(function* () {
        const ctx = yield* InstanceState.context
        calls.exclusive += 1
        order.push("enter")
        const out = yield* seen(ctx.worktree).withPermits(1)(
          Effect.gen(function* () {
            probe.cur += 1
            probe.max = Math.max(probe.max, probe.cur)
            return yield* fn({
              track: () => Effect.succeed(undefined),
              restore: () => Effect.void,
              revert: () => Effect.void,
            })
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                probe.cur -= 1
                order.push("leave")
              }),
            ),
          ),
        )
        return out
      }),
  }),
)

const memory = Database.layerFromPath(":memory:")
const journal = SnapshotJournal.layer.pipe(Layer.provide(memory), Layer.provide(FSUtil.defaultLayer))
const env = Layer.mergeAll(
  memory,
  journal,
  keyed,
  LSP.defaultLayer,
  FSUtil.defaultLayer,
  Format.defaultLayer,
  EventV2Bridge.defaultLayer,
  Truncate.defaultLayer,
  Agent.defaultLayer,
  testInstanceStoreLayer,
  CrossSpawnSpawner.defaultLayer,
)

const it = testEffect(env)

const ctxFor = (session: string, extra?: { ask?: () => Effect.Effect<void> }) => ({
  sessionID: SessionID.make(session),
  messageID: MessageID.make("msg_window"),
  callID: `call-${Math.random().toString(36).slice(2)}`,
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: extra?.ask ?? (() => Effect.void),
})

describe("tool journal window", () => {
  it.instance("same worktree writer and revert windows serialize", () =>
    Effect.gen(function* () {
      probe.cur = 0
      probe.max = 0
      const snap = yield* Snapshot.Service
      const slow = JournalWindow.run(
        snap,
        Effect.gen(function* () {
          yield* Effect.sleep("50 millis")
        }),
      )
      yield* Effect.all([slow, slow], { concurrency: "unbounded" })
      expect(probe.max).toBe(1)
    }),
  )

  it.instance("failure releases the worktree window", () =>
    Effect.gen(function* () {
      probe.cur = 0
      probe.max = 0
      const snap = yield* Snapshot.Service
      const boom = yield* JournalWindow.run(snap, Effect.fail(new Error("boom"))).pipe(Effect.exit)
      expect(Exit.isFailure(boom)).toBe(true)
      const slow = JournalWindow.run(
        snap,
        Effect.gen(function* () {
          yield* Effect.sleep("20 millis")
        }),
      )
      yield* Effect.all([slow, slow], { concurrency: "unbounded" })
      expect(probe.max).toBe(1)
    }),
  )

  it.live("different worktrees run in parallel", () =>
    Effect.gen(function* () {
      probe.cur = 0
      probe.max = 0
      const dirA = yield* tmpdirScoped({ git: true })
      const dirB = yield* tmpdirScoped({ git: true })
      const seenWorktree: string[] = []
      const work = (dir: string) =>
        provideInstance(dir)(
          Effect.gen(function* () {
            const ctx = yield* InstanceState.context
            seenWorktree.push(ctx.worktree)
            const snap = yield* Snapshot.Service
            return yield* JournalWindow.run(
              snap,
              Effect.gen(function* () {
                yield* Effect.sleep("50 millis")
              }),
            )
          }),
        )
      yield* Effect.all([work(dirA), work(dirB)], { concurrency: "unbounded" })
      expect(seenWorktree[0]).not.toBe(seenWorktree[1])
      expect(probe.max).toBe(2)
    }).pipe(Effect.provide(env)),
  )

  it.instance("edit write and apply_patch each hold one exclusive per operation", () =>
    Effect.gen(function* () {
      calls.exclusive = 0
      order.length = 0
      const test = yield* TestInstance
      const dir = test.directory
      const editFile = path.join(dir, "shared-edit.txt")
      const writeFile = path.join(dir, "shared-write.txt")
      const patchA = path.join(dir, "patch-a.txt")
      const patchB = path.join(dir, "patch-b.txt")
      const fs = yield* FSUtil.Service
      yield* fs.writeWithDirs(editFile, "hello")
      const journalSvc = yield* SnapshotJournal.Service

      const editInfo = yield* EditTool
      const edit = yield* editInfo.init()
      const editCtx = ctxFor("ses_window-edit", {
        ask: () =>
          Effect.gen(function* () {
            order.push("ask")
          }),
      })
      yield* ensureJournalSession(editCtx.sessionID as string)
      yield* edit.execute({ filePath: editFile, oldString: "hello", newString: "hello edit" }, editCtx as never)
      const afterEdit = calls.exclusive

      const writeInfo = yield* WriteTool
      const write = yield* writeInfo.init()
      const writeCtx = ctxFor("ses_window-write")
      yield* ensureJournalSession(writeCtx.sessionID as string)
      yield* write.execute({ filePath: writeFile, content: "written" }, writeCtx as never)
      const afterWrite = calls.exclusive

      const patchInfo = yield* ApplyPatchTool
      const patch = yield* patchInfo.init()
      const patchCtx = ctxFor("ses_window-patch")
      yield* ensureJournalSession(patchCtx.sessionID as string)
      const text =
        "*** Begin Patch\n*** Add File: patch-a.txt\n+one\n*** Add File: patch-b.txt\n+two\n*** End Patch"
      yield* patch.execute({ patchText: text }, patchCtx as never)
      const afterPatch = calls.exclusive

      expect(afterEdit).toBe(1)
      expect(afterWrite).toBe(2)
      expect(afterPatch).toBe(3)
      const askAt = order.indexOf("ask")
      const enterAt = order.indexOf("enter")
      expect(askAt).toBeGreaterThanOrEqual(0)
      expect(enterAt).toBeGreaterThanOrEqual(0)
      expect(askAt).toBeLessThan(enterAt)

      const rows = yield* journalSvc.list({})
      const applied = rows.filter((row) => row.status === "applied")
      expect(applied.length).toBeGreaterThanOrEqual(4)
      expect(yield* fs.readFileString(editFile)).toContain("hello edit")
      expect(yield* fs.readFileString(writeFile)).toBe("written")
      expect(yield* fs.readFileString(patchA)).toContain("one")
      expect(yield* fs.readFileString(patchB)).toContain("two")
    }),
  )

  it.instance("writer failure releases the window for the next write", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = test.directory
      const target = path.join(dir, "exists.txt")
      const fs = yield* FSUtil.Service
      yield* fs.writeWithDirs(target, "base")
      const writeInfo = yield* WriteTool
      const write = yield* writeInfo.init()
      const before = calls.exclusive
      const dirCtx = ctxFor("ses_window-fail-dir")
      yield* ensureJournalSession(dirCtx.sessionID as string)
      const exit = yield* write.execute({ filePath: dir, content: "x" }, dirCtx as never).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause).length).toBeGreaterThan(0)
      const okCtx = ctxFor("ses_window-recover")
      yield* ensureJournalSession(okCtx.sessionID as string)
      yield* write.execute({ filePath: target, content: "recovered" }, okCtx as never)
      expect(yield* fs.readFileString(target)).toBe("recovered")
      expect(calls.exclusive).toBeGreaterThan(before)
    }),
  )
})
