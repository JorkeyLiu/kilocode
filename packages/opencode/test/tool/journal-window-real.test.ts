import { afterAll, beforeAll, describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Ref } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Flag } from "@opencode-ai/core/flag/flag"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { SessionRevert } from "@/session/revert"
import { Snapshot } from "@/snapshot"
import { SnapshotJournal } from "@/snapshot/journal"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "@/format"
import { LSP } from "@/lsp/lsp"
import { Truncate } from "@/tool/truncate"
import { Agent } from "@/agent/agent"
import { WriteTool } from "@/tool/write"
import { InstanceState } from "@/effect/instance-state"
import { MessageID, SessionID } from "@/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import {
  disposeAllInstances,
  provideInstance,
  provideTmpdirInstance,
  testInstanceStoreLayer,
  tmpdirScoped,
} from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { remove as cleanup } from "../kilocode/cleanup"

// kilocode_change - real-layer journal window tests: production
// Snapshot.defaultLayer (worktree gitdir key) + real SessionRevert path +
// real journal writer (WriteTool). Owns its git worktrees (tmpdirScoped /
// provideTmpdirInstance auto-clean) and its DB file (Flag.KILO_DB temp,
// removed in afterAll). No SnapshotPassthrough, no hand-built Semaphore.

const previous = Flag.KILO_DB
const dbfile = path.join(os.tmpdir(), `journal-window-real-${process.pid}-${crypto.randomUUID()}.db`)

beforeAll(async () => {
  await fs.rm(dbfile, { force: true }).catch(() => undefined)
  Flag.KILO_DB = dbfile
})

afterAll(async () => {
  await disposeAllInstances().catch(() => undefined)
  Flag.KILO_DB = previous
  await Promise.all([dbfile, `${dbfile}-wal`, `${dbfile}-shm`].map((file) => cleanup(file).catch(() => undefined)))
})

const lspQuiet = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

// Slow formatter holds the writer window open so concurrency/interrupt tests
// deterministically overlap inside the real Snapshot exclusive. Returns false
// (no formatting) after the delay; still inside the exclusive by construction.
const slowFormat = Layer.succeed(
  Format.Service,
  Format.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    file: () => Effect.sleep("200 millis").pipe(Effect.as(false)),
  }),
)

const realEnv = Layer.mergeAll(
  Session.defaultLayer,
  SessionRevert.defaultLayer,
  Snapshot.defaultLayer,
  SnapshotJournal.defaultLayer,
  FSUtil.defaultLayer,
  EventV2Bridge.defaultLayer,
  lspQuiet,
  slowFormat,
  Truncate.defaultLayer,
  Agent.defaultLayer,
  testInstanceStoreLayer,
  CrossSpawnSpawner.defaultLayer,
)

const it = testEffect(realEnv)

const ctxFor = (session: string, message: string) => ({
  sessionID: SessionID.make(session),
  messageID: MessageID.make(message),
  callID: `call-${Math.random().toString(36).slice(2)}`,
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

const user = Effect.fn("test.user")(function* (sid: string) {
  const session = yield* Session.Service
  return yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: sid as never,
    agent: "default",
    model: { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("gpt-4") },
    time: { created: Date.now() },
  })
})

const writeFile = (file: string, text: string) => Effect.promise(() => fs.writeFile(file, text))
const readFile = (file: string) => Effect.promise(() => fs.readFile(file, "utf-8"))

const preparedOf = Effect.fn("test.prepared")(function* (sessionID: string) {
  const journal = yield* SnapshotJournal.Service
  const rows = yield* journal.list({ sessionID })
  return rows.filter((row) => row.status === "prepared")
})

const waitPrepared = Effect.fn("test.waitPrepared")(function* (sessionID: string) {
  for (let i = 0; i < 100; i++) {
    const hit = yield* preparedOf(sessionID)
    if (hit.length > 0) return hit
    yield* Effect.sleep("20 millis")
  }
  throw new Error(`prepared row never appeared for ${sessionID}`)
})

describe("journal window real Snapshot exclusive", () => {
  it.live(
    "real writer and unrevert share one worktree exclusive without overlap",
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const revert = yield* SessionRevert.Service
        const snap = yield* Snapshot.Service
        const journal = yield* SnapshotJournal.Service
        const file = path.join(dir, "shared.txt")
        yield* writeFile(file, "base")
        const h0 = yield* snap.track()
        expect(h0).toBeTruthy()
        yield* writeFile(file, "dirty")

        const info = yield* session.create({})
        const sid = info.id
        const u = yield* user(sid)
        yield* session.setRevert({
          sessionID: sid,
          revert: { messageID: u.id, snapshot: h0! },
          summary: { additions: 0, deletions: 0, files: 0 },
        })

        const writerSid = (yield* session.create({})).id
        const writerMid = MessageID.ascending()
        const tool = yield* WriteTool
        const def = yield* tool.init()
        const writerCtx = ctxFor(writerSid, writerMid)
        const writer = def.execute({ filePath: file, content: "writer-final" }, writerCtx as never)
        const unreverting = revert.unrevert({ sessionID: sid })
        const [writerExit, unrevertExit] = yield* Effect.all([writer.pipe(Effect.exit), unreverting.pipe(Effect.exit)], {
          concurrency: "unbounded",
        })
        // Both sides use the real worktree exclusive; neither may die with a
        // lock defect. Writer execute is orDie-wrapped so check exits.
        // Unrevert always lands. The writer either won the race (applied) or
        // lost it and failed closed on the write-anchored drift guard instead
        // of silently overwriting the restore; either way nothing is torn.
        if (unrevertExit._tag === "Failure") throw new Error(`unrevert failed: ${Cause.pretty(unrevertExit.cause)}`)
        if (writerExit._tag === "Failure") {
          expect(Cause.pretty(writerExit.cause)).toContain("changed on disk")
          const rows = yield* journal.list({ sessionID: writerSid })
          expect(rows.filter((row) => row.status === "applied")).toEqual([])
          expect(yield* preparedOf(writerSid)).toEqual([])
          expect((yield* session.get(sid)).revert).toBeUndefined()
          expect(yield* readFile(file)).toBe("base")
          return
        }

        // Writer window was atomic: its journal after image is exactly what
        // the writer wrote, even though unrevert ran concurrently. Without
        // the shared exclusive, unrevert could land between the writer FS
        // write and journal.apply and the after image would read back base.
        const rows = yield* journal.list({ sessionID: writerSid })
        expect(rows.length).toBe(1)
        expect(rows[0]!.status).toBe("applied")
        const afterRef = rows[0]!.after_blob ?? rows[0]!.after_hash
        expect(afterRef).toBeTruthy()
        const after = yield* journal.readBlob(afterRef!)
        expect(after?.toString("utf-8")).toBe("writer-final")

        // No prepared leak, marker cleared, file is one of the two valid
        // end states (writer-final when writer ran last, base when unrevert
        // ran last) — never torn.
        expect(yield* preparedOf(writerSid)).toEqual([])
        expect((yield* session.get(sid)).revert).toBeUndefined()
        const final = yield* readFile(file)
        expect(["writer-final", "base"].includes(final)).toBe(true)
      }),
    { git: true }),
  )

  it.live(
    "same worktree slow writers serialize on the real gitdir key",
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const journal = yield* SnapshotJournal.Service
        const tool = yield* WriteTool
        const def = yield* tool.init()
        const run = (name: string, content: string) =>
          Effect.gen(function* () {
            const sid = (yield* session.create({})).id
            const ctx = ctxFor(sid, MessageID.ascending())
            yield* def.execute({ filePath: path.join(dir, name), content }, ctx as never)
            return sid
          })
        const start = Date.now()
        const [a, b] = yield* Effect.all([run("a.txt", "aaa"), run("b.txt", "bbb")], { concurrency: "unbounded" })
        const elapsed = Date.now() - start
        // Two 200ms windows on the same gitdir must serialize (~400ms).
        expect(elapsed).toBeGreaterThanOrEqual(300)
        for (const sid of [a, b]) {
          const rows = yield* journal.list({ sessionID: sid })
          expect(rows.length).toBe(1)
          expect(rows[0]!.status).toBe("applied")
          expect(yield* preparedOf(sid)).toEqual([])
        }
        expect(yield* readFile(path.join(dir, "a.txt"))).toBe("aaa")
        expect(yield* readFile(path.join(dir, "b.txt"))).toBe("bbb")
        void Database
      }),
    { git: true }),
  )

  it.live("different worktrees stay parallel on the real gitdir key", () =>
    Effect.gen(function* () {
      const dirA = yield* tmpdirScoped({ git: true })
      const dirB = yield* tmpdirScoped({ git: true })
      const enteredA = yield* Deferred.make<void>()
      const enteredB = yield* Deferred.make<void>()
      const active = yield* Ref.make(0)
      const max = yield* Ref.make(0)
      const worktrees: string[] = []
      const run = (dir: string, enteredSelf: Deferred.Deferred<void>, enteredOther: Deferred.Deferred<void>) =>
        provideInstance(dir)(
          Effect.gen(function* () {
            const ctx = yield* InstanceState.context
            worktrees.push(ctx.worktree)
            const snap = yield* Snapshot.Service
            yield* snap.exclusive(() =>
              Effect.gen(function* () {
                const cur = yield* Ref.updateAndGet(active, (n) => n + 1)
                yield* Ref.update(max, (m) => Math.max(m, cur))
                yield* Deferred.succeed(enteredSelf, void 0)
                // Rendezvous inside the real gitdir window: the other worktree
                // must enter its own window while we hold ours. Same-key
                // serialization would deadlock here and hit the timeout.
                yield* Deferred.await(enteredOther).pipe(
                  Effect.timeoutOrElse({
                    duration: "10 seconds",
                    orElse: () =>
                      Effect.fail(new Error("other worktree never entered exclusive; windows did not overlap")),
                  }),
                )
              }).pipe(Effect.ensuring(Ref.update(active, (n) => n - 1))),
            )
          }),
        )
      yield* Effect.all([run(dirA, enteredA, enteredB), run(dirB, enteredB, enteredA)], { concurrency: "unbounded" })
      expect(worktrees[0]).not.toBe(worktrees[1])
      // Both gitdir windows overlapped: max active inside exclusive was 2.
      expect(yield* Ref.get(max)).toBe(2)
      expect(yield* Ref.get(active)).toBe(0)
    }).pipe(Effect.provide(realEnv)),
  )

  it.live(
    "explicit writer failure marks failed and releases the real window",
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const journal = yield* SnapshotJournal.Service
        const tool = yield* WriteTool
        const def = yield* tool.init()
        const badSid = (yield* session.create({})).id
        const bad = yield* def.execute({ filePath: dir, content: "x" }, ctxFor(badSid, MessageID.ascending()) as never).pipe(
          Effect.exit,
        )
        expect(Exit.isFailure(bad)).toBe(true)
        const badRows = yield* journal.list({ sessionID: badSid })
        expect(badRows.length).toBeGreaterThanOrEqual(0)
        // A failed prepare leaves no prepared row behind; a failed
        // write/apply leaves a failed (never prepared) row.
        for (const row of badRows) expect(row.status).not.toBe("prepared")
        const okSid = (yield* session.create({})).id
        const target = path.join(dir, "recovered.txt")
        yield* def.execute({ filePath: target, content: "recovered" }, ctxFor(okSid, MessageID.ascending()) as never)
        expect(yield* readFile(target)).toBe("recovered")
        const okRows = yield* journal.list({ sessionID: okSid })
        expect(okRows.length).toBe(1)
        expect(okRows[0]!.status).toBe("applied")
      }),
    { git: true }),
  )

  it.live(
    "interruption after prepare fails the row uninterruptibly and releases",
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const journal = yield* SnapshotJournal.Service
        const tool = yield* WriteTool
        const def = yield* tool.init()
        const sid = (yield* session.create({})).id
        const target = path.join(dir, "interrupt.txt")
        const fiber = yield* def.execute({ filePath: target, content: "partial" }, ctxFor(sid, MessageID.ascending()) as never).pipe(
          Effect.forkDetach,
        )
        // Wait until prepare committed, then interrupt mid-format (inside the
        // real exclusive, after prepare, before apply).
        yield* waitPrepared(sid)
        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true)
        const rows = yield* journal.list({ sessionID: sid })
        expect(rows.length).toBe(1)
        expect(rows[0]!.status).toBe("failed")
        expect(rows[0]!.error).toContain("interrupted")
        // Exclusive released: the next writer on the same worktree proceeds.
        const nextSid = (yield* session.create({})).id
        yield* def.execute({ filePath: target, content: "recovered" }, ctxFor(nextSid, MessageID.ascending()) as never)
        expect(yield* readFile(target)).toBe("recovered")
        const next = yield* journal.list({ sessionID: nextSid })
        expect(next.length).toBe(1)
        expect(next[0]!.status).toBe("applied")
      }),
    { git: true }),
  )
})

describe("journal window wrapper guard", () => {
  it.live("edit/write/apply_patch go through JournalWindow, never snap.exclusive directly", () =>
    Effect.gen(function* () {
      const files = yield* Effect.promise(() =>
        Promise.all([
          fs.readFile("src/tool/edit.ts", "utf-8"),
          fs.readFile("src/tool/write.ts", "utf-8"),
          fs.readFile("src/tool/apply_patch.ts", "utf-8"),
          fs.readFile("src/tool/journal-window.ts", "utf-8"),
        ]),
      )
      const [edit, write, patch, window] = files
      for (const src of [edit, write, patch]) {
        expect(src.includes("JournalWindow.runScoped")).toBe(true)
        expect(src.includes("snap.exclusive(")).toBe(false)
        expect(src.includes("Snapshot.defaultLayer")).toBe(false)
      }
      expect(window.includes("uninterruptibleMask")).toBe(true)
      expect(window.includes("onInterrupt")).toBe(true)
    }),
  )
})
