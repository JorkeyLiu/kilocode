import { afterEach, describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Cause, Effect, Exit, Layer } from "effect"
import { WriteTool } from "../../src/tool/write"
import { EditTool } from "../../src/tool/edit"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { WriteCas } from "../../src/tool/write-cas"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Format } from "../../src/format"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { SnapshotJournal } from "@/snapshot/journal"
import { SessionID, MessageID } from "../../src/session/schema"
import { TestInstance, disposeAllInstances } from "../fixture/fixture"
import { JournalMemory, ensureJournalSession } from "../fixture/journal"
import { testEffect } from "../lib/effect"

// kilocode_change - write-anchored external drift CAS: direct drift verification
// with real tools + real FS + canonical journal. External changes are injected
// deterministically in the real permission `ask` hook (after the tool pre-read,
// before the worktree window), which is the stable equivalent of an
// approval/validation-period external writer. No production hook, no mock,
// no copied guard logic.

afterEach(async () => {
  await disposeAllInstances()
})

const layer = Layer.mergeAll(
  LSP.defaultLayer,
  FSUtil.defaultLayer,
  Format.defaultLayer,
  EventV2Bridge.defaultLayer,
  Truncate.defaultLayer,
  Agent.defaultLayer,
  JournalMemory,
)

const it = testEffect(layer)

let seq = 0

const base = {
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
}

const ctxWith = (
  sessionID: string,
  ask: (input: any) => Effect.Effect<void>,
  metas: any[],
) => ({
  ...base,
  sessionID: SessionID.make(sessionID),
  messageID: MessageID.make(`msg-${sessionID}`),
  callID: "",
  ask,
  metadata: (input: any) => Effect.sync(() => metas.push(input)),
})

const ready = (ctx: any) =>
  Effect.gen(function* () {
    yield* ensureJournalSession(ctx.sessionID)
    return { ...ctx, callID: `call-${(seq += 1)}` }
  })

const runWrite = (args: any, ctx: any) =>
  Effect.gen(function* () {
    const info = yield* WriteTool
    const tool = yield* info.init()
    return yield* tool.execute(args, yield* ready(ctx))
  })

const runEdit = (args: any, ctx: any) =>
  Effect.gen(function* () {
    const info = yield* EditTool
    const tool = yield* info.init()
    return yield* tool.execute(args, yield* ready(ctx))
  })

const runPatch = (args: any, ctx: any) =>
  Effect.gen(function* () {
    const info = yield* ApplyPatchTool
    const tool = yield* info.init()
    return yield* tool.execute(args, yield* ready(ctx))
  })

const put = (p: string, content: string) => Effect.promise(() => fs.writeFile(p, content, "utf-8"))
const load = (p: string) => Effect.promise(() => fs.readFile(p, "utf-8"))
const exists = (p: string) =>
  Effect.promise(() =>
    fs
      .access(p)
      .then(() => true)
      .catch(() => false),
  )

const rowsOf = (sessionID: string) =>
  Effect.gen(function* () {
    const journal = yield* SnapshotJournal.Service
    return yield* journal.list({ sessionID })
  })

const failMessage = (exit: Exit.Exit<unknown, unknown>) => {
  expect(Exit.isFailure(exit)).toBe(true)
  if (!Exit.isFailure(exit)) throw new Error("expected failure")
  return Cause.pretty(exit.cause)
}

describe("write-cas external drift real tools", () => {
  it.instance("write update fails closed when approval-window external content drifted", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "write-drift.txt")
      yield* put(file, "base")
      const sid = "ses_write-cas-write"
      const metas: any[] = []
      const ctx = ctxWith(
        sid,
        () => Effect.promise(() => fs.writeFile(file, "external", "utf-8")),
        metas,
      )
      const exit = yield* runWrite({ filePath: file, content: "writer" }, ctx).pipe(Effect.exit)
      expect(failMessage(exit)).toContain("changed on disk")
      expect(yield* load(file)).toBe("external")
      const rows = yield* rowsOf(sid)
      expect(rows.filter((row) => row.status === "applied")).toEqual([])
      expect(rows.filter((row) => row.status === "prepared")).toEqual([])
      expect(rows).toEqual([])
      const last = metas[metas.length - 1]
      expect(last.metadata.journal.coverage).toBe("failed")
      expect(last.metadata.journal.ids).toEqual([])
    }),
  )

  it.instance("edit update fails closed on approval-window external delete without recreating", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "edit-drift.txt")
      yield* put(file, "old content here")
      const sid = "ses_write-cas-edit"
      const metas: any[] = []
      const ctx = ctxWith(
        sid,
        () => Effect.promise(() => fs.rm(file, { force: true })),
        metas,
      )
      const exit = yield* runEdit({ filePath: file, oldString: "old content", newString: "new content" }, ctx).pipe(
        Effect.exit,
      )
      expect(failMessage(exit)).toContain("changed on disk")
      expect(yield* exists(file)).toBe(false)
      const rows = yield* rowsOf(sid)
      expect(rows.filter((row) => row.status === "applied")).toEqual([])
      expect(rows.filter((row) => row.status === "prepared")).toEqual([])
      expect(rows).toEqual([])
      const last = metas[metas.length - 1]
      expect(last.metadata.journal.coverage).toBe("failed")
    }),
  )

  it.instance("apply_patch batch keeps applied prefix and stops on middle-file drift", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const a = path.join(test.directory, "a.txt")
      const b = path.join(test.directory, "b.txt")
      const c = path.join(test.directory, "c.txt")
      yield* put(a, "a1\n")
      yield* put(b, "b1\n")
      yield* put(c, "c1\n")
      const sid = "ses_write-cas-batch"
      const metas: any[] = []
      const ctx = ctxWith(
        sid,
        () => Effect.promise(() => fs.writeFile(b, "external\n", "utf-8")),
        metas,
      )
      const patch =
        "*** Begin Patch\n*** Update File: a.txt\n@@\n-a1\n+a2\n*** Update File: b.txt\n@@\n-b1\n+b2\n*** Update File: c.txt\n@@\n-c1\n+c2\n*** End Patch"
      const exit = yield* runPatch({ patchText: patch }, ctx).pipe(Effect.exit)
      expect(failMessage(exit)).toContain("changed on disk")
      expect(yield* load(a)).toBe("a2\n")
      expect(yield* load(b)).toBe("external\n")
      expect(yield* load(c)).toBe("c1\n")
      const rows = yield* rowsOf(sid)
      const applied = rows.filter((row) => row.status === "applied")
      expect(applied).toHaveLength(1)
      expect(applied[0]!.path.endsWith("a.txt")).toBe(true)
      expect(applied[0]!.path).not.toContain("..")
      expect(rows.filter((row) => row.status === "prepared")).toEqual([])
      expect(rows).toHaveLength(1)
      const last = metas[metas.length - 1]
      expect(last.metadata.journal.coverage).toBe("failed")
      expect(last.metadata.journal.ids).toEqual(applied.map((row) => row.id))
    }),
  )

  it.instance("apply_patch same-path sequential writes pass via expected projection", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "same.txt")
      yield* put(file, "base\n")
      const sid = "ses_write-cas-same"
      const metas: any[] = []
      const ctx = ctxWith(sid, () => Effect.void, metas)
      const patch =
        "*** Begin Patch\n*** Update File: same.txt\n@@\n-base\n+mid\n*** Delete File: same.txt\n*** End Patch"
      yield* runPatch({ patchText: patch }, ctx)
      expect(yield* exists(file)).toBe(false)
      const rows = yield* rowsOf(sid)
      expect(rows).toHaveLength(2)
      for (const row of rows) expect(row.status).toBe("applied")
      expect(rows.filter((row) => row.status === "prepared")).toEqual([])
      for (const row of rows) expect(row.path.endsWith("same.txt")).toBe(true)
    }),
  )
})

describe("write-cas helper real fs", () => {
  it.instance("same distinguishes null vs bytes", () =>
    Effect.gen(function* () {
      expect(WriteCas.same(null, null)).toBe(true)
      expect(WriteCas.same(null, Buffer.from("x"))).toBe(false)
      expect(WriteCas.same(Buffer.from("x"), null)).toBe(false)
      expect(WriteCas.same(Buffer.from("abc"), Buffer.from("abc"))).toBe(true)
      expect(WriteCas.same(Buffer.from("abc"), Buffer.from("abd"))).toBe(false)
    }),
  )

  it.instance("match covers absent, bytes, directory mismatch, and error path hygiene", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fsUtil = yield* FSUtil.Service
      const missing = path.join(test.directory, "missing.txt")
      expect(yield* WriteCas.match(fsUtil, missing, null)).toBe(true)
      expect(yield* WriteCas.match(fsUtil, missing, Buffer.from("x"))).toBe(false)

      const file = path.join(test.directory, "bytes.txt")
      yield* put(file, "hello")
      const base = Buffer.from("hello")
      expect(yield* WriteCas.match(fsUtil, file, base)).toBe(true)
      expect(yield* WriteCas.match(fsUtil, file, Buffer.from("other"))).toBe(false)
      expect(yield* WriteCas.match(fsUtil, file, null)).toBe(false)

      const dir = path.join(test.directory, "adir")
      yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))
      expect(yield* WriteCas.match(fsUtil, dir, null)).toBe(false)
      expect(yield* WriteCas.match(fsUtil, dir, Buffer.from("hello"))).toBe(false)

      const err = WriteCas.error(file)
      expect(err.message).toContain(file)
      expect(err.message).toContain("changed on disk")
      expect(err.message).not.toContain("hello-secret-marker")
    }),
  )

  it.instance("match follows symlink target bytes", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fsUtil = yield* FSUtil.Service
      const target = path.join(test.directory, "target.txt")
      const link = path.join(test.directory, "link.txt")
      yield* put(target, "hello")
      yield* Effect.promise(() => fs.symlink(target, link))
      expect(yield* WriteCas.match(fsUtil, link, Buffer.from("hello"))).toBe(true)
      yield* put(target, "world")
      expect(yield* WriteCas.match(fsUtil, link, Buffer.from("hello"))).toBe(false)
      expect(yield* WriteCas.match(fsUtil, link, Buffer.from("world"))).toBe(true)
    }),
  )

  it.instance("match returns false on unreadable file without throwing", () =>
    Effect.gen(function* () {
      if (typeof process.geteuid === "function" && process.geteuid() === 0) return
      const test = yield* TestInstance
      const fsUtil = yield* FSUtil.Service
      const file = path.join(test.directory, "locked.txt")
      yield* put(file, "secret")
      const base = Buffer.from(yield* Effect.promise(() => fs.readFile(file)))
      yield* Effect.promise(() => fs.chmod(file, 0o000))
      try {
        const probe = yield* Effect.promise(() =>
          fs
            .readFile(file)
            .then(() => true)
            .catch(() => false),
        )
        if (probe) return
        expect(yield* WriteCas.match(fsUtil, file, base)).toBe(false)
        expect(yield* WriteCas.match(fsUtil, file, null)).toBe(false)
      } finally {
        yield* Effect.promise(() => fs.chmod(file, 0o644)).pipe(Effect.ignore)
      }
    }),
  )
})
