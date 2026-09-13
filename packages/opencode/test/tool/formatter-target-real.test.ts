import { afterEach, describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Cause, Effect, Exit, Layer } from "effect"
import { WriteTool } from "../../src/tool/write"
import { EditTool } from "../../src/tool/edit"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Format } from "../../src/format"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { SnapshotJournal } from "@/snapshot/journal"
import { SessionID, MessageID } from "../../src/session/schema"
import { TestInstance, disposeAllInstances } from "../fixture/fixture"
import { JournalMemory, ensureJournalSession } from "../fixture/journal"
import { testEffect } from "../lib/effect"

// kilocode_change - formatter single-target contract with real child
// processes: custom formatter commands run as real subprocesses via
// Format.defaultLayer + per-test kilo.jsonc (no mocks, no test hooks).
// Each behavior is a real `node -e` command against $FILE.

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

const ctxWith = (sessionID: string, metas: any[]) => ({
  ...base,
  sessionID: SessionID.make(sessionID),
  messageID: MessageID.make(`msg-${sessionID}`),
  callID: `call-${(seq += 1)}`,
  ask: () => Effect.void,
  metadata: (input: any) => Effect.sync(() => metas.push(input)),
})

const ready = (ctx: any) =>
  Effect.gen(function* () {
    yield* ensureJournalSession(ctx.sessionID)
    return ctx
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
const isDir = (p: string) =>
  Effect.promise(() =>
    fs
      .stat(p)
      .then((s) => s.isDirectory())
      .catch(() => false),
  )

const rowsOf = (sessionID: string) =>
  Effect.gen(function* () {
    const journal = yield* SnapshotJournal.Service
    return yield* journal.list({ sessionID })
  })

const failText = (exit: Exit.Exit<unknown, unknown>) => {
  expect(Exit.isFailure(exit)).toBe(true)
  if (!Exit.isFailure(exit)) throw new Error("expected failure")
  return Cause.pretty(exit.cause)
}

const fmt = (name: string, script: string) => ({
  formatter: {
    [name]: {
      command: ["node", "-e", script, "$FILE"],
      extensions: [".txt"],
    },
  },
})

const APPEND = "const fs=require('fs');const f=process.argv[1];fs.writeFileSync(f,fs.readFileSync(f,'utf8').trimEnd()+'\\n# ok\\n')"
const ATOMIC =
  "const fs=require('fs');const f=process.argv[1];const t=f+'.tmp';fs.writeFileSync(t,fs.readFileSync(f,'utf8')+'# atomic\\n');fs.renameSync(t,f)"
const DEL = "require('fs').rmSync(process.argv[1],{force:true,recursive:true})"
const TODIR =
  "const fs=require('fs');const f=process.argv[1];fs.rmSync(f,{force:true,recursive:true});fs.mkdirSync(f)"
const SIDE =
  "const fs=require('fs');const f=process.argv[1];fs.writeFileSync(f+'.cache','side');fs.writeFileSync(f,fs.readFileSync(f,'utf8')+'# side\\n')"
const BATCH =
  "const fs=require('fs');const f=process.argv[1];if(f.includes('bad.txt')){fs.rmSync(f)}else{fs.writeFileSync(f,fs.readFileSync(f,'utf8')+'# ok\\n')}"

describe("formatter single-target real child processes", () => {
  it.instance(
    "edit in-place formatter success records formatter-final",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const file = path.join(test.directory, "ok.txt")
        yield* put(file, "hello\n")
        const sid = "ses_fmt-ok"
        const metas: any[] = []
        yield* runEdit({ filePath: file, oldString: "hello", newString: "world" }, ctxWith(sid, metas))
        expect(yield* load(file)).toContain("# ok")
        const rows = yield* rowsOf(sid)
        expect(rows).toHaveLength(1)
        expect(rows[0]!.status).toBe("applied")
        const last = metas[metas.length - 1]
        expect(last.metadata.journal.coverage).toBe("full")
      }),
    { config: fmt("okfmt", APPEND) },
  )

  it.instance(
    "write atomic rename replace success allows inode change",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const file = path.join(test.directory, "atomic.txt")
        const sid = "ses_fmt-atomic"
        const metas: any[] = []
        const out = (yield* runWrite({ filePath: file, content: "base\n" }, ctxWith(sid, metas))) as any
        expect(yield* load(file)).toContain("# atomic")
        const rows = yield* rowsOf(sid)
        expect(rows).toHaveLength(1)
        expect(rows[0]!.status).toBe("applied")
        expect(out.metadata.journal.coverage).toBe("full")
      }),
    { config: fmt("atomicfmt", ATOMIC) },
  )

  it.instance(
    "edit formatter delete fails closed with failed row and no restore",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const file = path.join(test.directory, "gone.txt")
        yield* put(file, "hello\n")
        const sid = "ses_fmt-del"
        const metas: any[] = []
        const exit = yield* runEdit({ filePath: file, oldString: "hello", newString: "world" }, ctxWith(sid, metas)).pipe(
          Effect.exit,
        )
        expect(failText(exit)).toContain("not a readable file")
        expect(yield* exists(file)).toBe(false)
        const rows = yield* rowsOf(sid)
        expect(rows).toHaveLength(1)
        expect(rows[0]!.status).toBe("failed")
        expect(rows.filter((row) => row.status === "prepared")).toEqual([])
        expect(rows.filter((row) => row.status === "applied")).toEqual([])
        const last = metas[metas.length - 1]
        expect(last.metadata.journal.coverage).toBe("failed")
        expect(last.metadata.journal.ids).toHaveLength(1)
      }),
    { config: fmt("delfmt", DEL) },
  )

  it.instance(
    "write formatter directory replace fails closed with failed row",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const file = path.join(test.directory, "todir.txt")
        const sid = "ses_fmt-dir"
        const metas: any[] = []
        const exit = yield* runWrite({ filePath: file, content: "base\n" }, ctxWith(sid, metas)).pipe(Effect.exit)
        expect(failText(exit)).toContain("not a readable file")
        expect(yield* isDir(file)).toBe(true)
        const rows = yield* rowsOf(sid)
        expect(rows).toHaveLength(1)
        expect(rows[0]!.status).toBe("failed")
        expect(rows.filter((row) => row.status === "prepared")).toEqual([])
        const last = metas[metas.length - 1]
        expect(last.metadata.journal.coverage).toBe("failed")
      }),
    { config: fmt("dirfmt", TODIR) },
  )

  it.instance(
    "edit symlink to regular file stays allowed",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const target = path.join(test.directory, "target.txt")
        const link = path.join(test.directory, "link.txt")
        yield* put(target, "hello\n")
        yield* Effect.promise(() => fs.symlink(target, link))
        const sid = "ses_fmt-link"
        const metas: any[] = []
        yield* runEdit({ filePath: link, oldString: "hello", newString: "world" }, ctxWith(sid, metas))
        expect(yield* load(target)).toContain("# ok")
        const rows = yield* rowsOf(sid)
        expect(rows).toHaveLength(1)
        expect(rows[0]!.status).toBe("applied")
        const last = metas[metas.length - 1]
        expect(last.metadata.journal.coverage).toBe("full")
      }),
    { config: fmt("linkfmt", APPEND) },
  )

  it.instance(
    "formatter sidecar stays on disk but out of metadata and journal",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const file = path.join(test.directory, "side.txt")
        const sid = "ses_fmt-side"
        const metas: any[] = []
        const out = (yield* runWrite({ filePath: file, content: "base\n" }, ctxWith(sid, metas))) as any
        const side = `${file}.cache`
        expect(yield* exists(side)).toBe(true)
        expect(yield* load(side)).toBe("side")
        const rows = yield* rowsOf(sid)
        expect(rows).toHaveLength(1)
        expect(rows[0]!.path.endsWith("side.txt")).toBe(true)
        expect(JSON.stringify(metas)).not.toContain(".cache")
        expect(JSON.stringify(rows)).not.toContain(".cache")
        expect(JSON.stringify(out.metadata)).not.toContain(".cache")
        expect(out.metadata.journal.coverage).toBe("full")
      }),
    { config: fmt("sidefmt", SIDE) },
  )

  it.instance(
    "apply_patch keeps applied prefix and stops after formatter violation",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const a = path.join(test.directory, "a.txt")
        const bad = path.join(test.directory, "bad.txt")
        const c = path.join(test.directory, "c.txt")
        yield* put(a, "a1\n")
        yield* put(bad, "b1\n")
        yield* put(c, "c1\n")
        const sid = "ses_fmt-batch"
        const metas: any[] = []
        const patch =
          "*** Begin Patch\n*** Update File: a.txt\n@@\n-a1\n+a2\n*** Update File: bad.txt\n@@\n-b1\n+b2\n*** Update File: c.txt\n@@\n-c1\n+c2\n*** End Patch"
        const exit = yield* runPatch({ patchText: patch }, ctxWith(sid, metas)).pipe(Effect.exit)
        expect(failText(exit)).toContain("not a readable file")
        expect(yield* load(a)).toContain("# ok")
        expect(yield* exists(bad)).toBe(false)
        expect(yield* load(c)).toBe("c1\n")
        const rows = yield* rowsOf(sid)
        expect(rows.filter((row) => row.status === "applied")).toHaveLength(1)
        expect(rows.filter((row) => row.status === "failed")).toHaveLength(1)
        expect(rows.filter((row) => row.status === "prepared")).toEqual([])
        expect(rows).toHaveLength(2)
        const last = metas[metas.length - 1]
        expect(last.metadata.journal.coverage).toBe("failed")
      }),
    { config: fmt("batchfmt", BATCH) },
  )

  it.instance(
    "apply_patch move validates formatter target only",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const src = path.join(test.directory, "src.txt")
        yield* put(src, "moving\n")
        const sid = "ses_fmt-move"
        const metas: any[] = []
        const patch = ["*** Begin Patch", "*** Update File: src.txt", "*** Move to: dest.txt", "@@", "-moving", "+moved", "*** End Patch"].join("\n")
        const out = (yield* runPatch({ patchText: patch }, ctxWith(sid, metas))) as any
        const dest = path.join(test.directory, "dest.txt")
        expect(yield* load(dest)).toContain("# ok")
        expect(yield* exists(src)).toBe(false)
        const rows = yield* rowsOf(sid)
        expect(rows).toHaveLength(2)
        for (const row of rows) expect(row.status).toBe("applied")
        expect(out.metadata.journal.coverage).toBe("full")
      }),
    { config: fmt("movefmt", APPEND) },
  )
})
