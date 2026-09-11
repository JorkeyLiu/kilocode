import { describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect, Layer } from "effect"
import { createTwoFilesPatch, diffLines } from "diff"
import { EditTool } from "../../src/tool/edit"
import { WriteTool } from "../../src/tool/write"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Format } from "../../src/format"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { MessageV2 } from "../../src/session/message-v2"
import { Snapshot } from "../../src/snapshot"
import { MAX_MESSAGE_PATCH_SIZE } from "@opencode-ai/core/session/message-read"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { TestInstance, disposeAllInstances } from "../fixture/fixture"
import { JournalMemory, ensureJournalSession } from "../fixture/journal" // kilocode_change - Snapshot v2 journal
import { testEffect } from "../lib/effect"
import { afterEach } from "bun:test"

const MARK = "# formatted"

const formatLayer = Layer.mock(Format.Service, {
  file: (p: string) =>
    Effect.promise(async () => {
      if (p.includes("plain")) return false
      let text: string | null = null
      try {
        text = await fs.readFile(p, "utf-8")
      } catch {
        return false
      }
      if (text.includes(MARK)) return true
      await fs.writeFile(p, `${text.trimEnd()}\n${MARK}\n`, "utf-8")
      return true
    }),
})

const layer = Layer.mergeAll(
  LSP.defaultLayer,
  FSUtil.defaultLayer,
  formatLayer,
  EventV2Bridge.defaultLayer,
  Truncate.defaultLayer,
  Agent.defaultLayer,
  JournalMemory, // kilocode_change - Snapshot v2 journal
)

const it = testEffect(layer)

afterEach(async () => {
  await disposeAllInstances()
})

const base = {
  sessionID: SessionID.make("ses_filefinal"),
  messageID: MessageID.make("msg_filefinal"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
}

function ctxWithAsk(ask: (input: any) => Effect.Effect<void>, meta?: (input: any) => Effect.Effect<void>) {
  return { ...base, ask, metadata: meta ?? (() => Effect.void) }
}

function tally(before: string, after: string) {
  let additions = 0
  let deletions = 0
  for (const change of diffLines(before, after)) {
    if (change.added) additions += change.count || 0
    if (change.removed) deletions += change.count || 0
  }
  return { additions, deletions }
}

let seq = 0 // kilocode_change - unique call per run keeps journal idempotency keys distinct
const fresh = (ctx: any) => ({ ...ctx, callID: `${ctx.callID ?? "call"}-${(seq += 1)}` })
const ready = (ctx: any) =>
  Effect.gen(function* () {
    yield* ensureJournalSession(ctx.sessionID)
    return fresh(ctx)
  })

const runEdit = (args: any, ctx: any) =>
  Effect.gen(function* () {
    const info = yield* EditTool
    const tool = yield* info.init()
    return yield* tool.execute(args, yield* ready(ctx))
  })

const runWrite = (args: any, ctx: any) =>
  Effect.gen(function* () {
    const info = yield* WriteTool
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

describe("formatter-final declared diffs", () => {
  it.instance("edit reports formatter-final filediff while ask keeps expected diff", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "edit.txt")
      yield* put(file, "hello\n")
      const asks: any[] = []
      const metas: any[] = []
      const ctx = ctxWithAsk(
        (input) => Effect.sync(() => asks.push(input)),
        (input) => Effect.sync(() => metas.push(input)),
      )
      const result: any = yield* runEdit({ filePath: file, oldString: "hello", newString: "world" }, ctx)
      const final = yield* load(file)
      expect(final).toContain("world")
      expect(final).toContain(MARK)
      const want = tally("hello\n", final)
      expect(result.metadata.filediff.additions).toBe(want.additions)
      expect(result.metadata.filediff.deletions).toBe(want.deletions)
      expect(result.metadata.filediff.patch).toContain(MARK)
      expect(result.metadata.diff).toContain(MARK)
      expect(asks).toHaveLength(1)
      expect(asks[0].metadata.diff).not.toContain(MARK)
      expect(asks[0].metadata.filediff.patch).not.toContain(MARK)
      expect(metas).toHaveLength(2)
      expect(metas[0].metadata.journal.coverage).toBe("partial")
      expect(metas[0].metadata.journal.ids).toHaveLength(1)
      expect(metas[1].metadata.filediff.patch).toContain(MARK)
      expect(metas[1].metadata.journal.coverage).toBe("full")
      expect(metas[1].metadata.journal.ids).toEqual(metas[0].metadata.journal.ids)
      // patch header points at the edited file
      expect(result.metadata.filediff.file).toBe(file)
    }),
  )

  it.instance("edit new file reports formatter-final truth", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "fresh.txt")
      const asks: any[] = []
      const ctx = ctxWithAsk((input) => Effect.sync(() => asks.push(input)))
      const result: any = yield* runEdit({ filePath: file, oldString: "", newString: "seed" }, ctx)
      const final = yield* load(file)
      expect(final).toContain(MARK)
      const want = tally("", final)
      expect(result.metadata.filediff.additions).toBe(want.additions)
      expect(result.metadata.filediff.deletions).toBe(want.deletions)
      expect(result.metadata.filediff.patch).toContain(MARK)
      expect(asks[0].metadata.filediff.patch).not.toContain(MARK)
    }),
  )

  it.instance("write reports formatter-final filediff while ask keeps expected diff", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "w.txt")
      yield* put(file, "old\n")
      const asks: any[] = []
      const ctx = ctxWithAsk((input) => Effect.sync(() => asks.push(input)))
      const result: any = yield* runWrite({ filePath: file, content: "new\n" }, ctx)
      const final = yield* load(file)
      expect(final).toContain(MARK)
      const want = tally("old\n", final)
      expect(result.metadata.filediff.additions).toBe(want.additions)
      expect(result.metadata.filediff.deletions).toBe(want.deletions)
      expect(result.metadata.filediff.patch).toContain(MARK)
      expect(asks[0].metadata.diff).not.toContain(MARK)
    }),
  )

  it.instance("write without formatter stays consistent with disk", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "plain-write.txt")
      yield* put(file, "old\n")
      const asks: any[] = []
      const ctx = ctxWithAsk((input) => Effect.sync(() => asks.push(input)))
      const result: any = yield* runWrite({ filePath: file, content: "new\n" }, ctx)
      const final = yield* load(file)
      expect(final).toBe("new\n")
      expect(result.metadata.diff).toBe(asks[0].metadata.diff)
      expect(result.metadata.filediff.patch).toBe(asks[0].metadata.filediff.patch)
    }),
  )

  it.instance("apply_patch multi-file rebuilds each entry formatter-final", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const one = path.join(test.directory, "one.txt")
      const two = path.join(test.directory, "two.txt")
      yield* put(one, "a\n")
      yield* put(two, "b\n")
      const asks: any[] = []
      const ctx = ctxWithAsk((input) => Effect.sync(() => asks.push(input)))
      const patch =
        "*** Begin Patch\n*** Update File: one.txt\n@@\n-a\n+A\n*** Update File: two.txt\n@@\n-b\n+B\n*** End Patch"
      const result: any = yield* runPatch({ patchText: patch }, ctx)
      const first = yield* load(one)
      const second = yield* load(two)
      expect(result.metadata.files).toHaveLength(2)
      for (const [entry, before, after] of [
        [result.metadata.files.find((f: any) => f.filePath === one), "a\n", first],
        [result.metadata.files.find((f: any) => f.filePath === two), "b\n", second],
      ] as const) {
        const want = tally(before as string, after as string)
        expect(entry.additions).toBe(want.additions)
        expect(entry.deletions).toBe(want.deletions)
        expect(entry.patch).toContain(MARK)
      }
      expect(asks[0].metadata.files[0].patch).not.toContain(MARK)
      expect(result.metadata.diff).toContain(MARK)
    }),
  )

  it.instance("apply_patch move points patch at final target and delete stays truthful", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const src = path.join(test.directory, "src.txt")
      const gone = path.join(test.directory, "gone.txt")
      yield* put(src, "old\n")
      yield* put(gone, "bye\n")
      const ctx = ctxWithAsk(() => Effect.void)
      const patch =
        "*** Begin Patch\n*** Update File: src.txt\n*** Move to: dest.txt\n@@\n-old\n+new\n*** Delete File: gone.txt\n*** End Patch"
      const result: any = yield* runPatch({ patchText: patch }, ctx)
      const dest = path.join(test.directory, "dest.txt")
      const final = yield* load(dest)
      expect(final).toContain("new")
      expect(final).toContain(MARK)
      const move = result.metadata.files.find((f: any) => f.type === "move")
      expect(move.movePath).toBe(dest)
      expect(move.relativePath.replaceAll("\\", "/")).toContain("dest.txt")
      expect(move.patch).toContain(MARK)
      expect(move.patch).toContain(dest)
      const wantMove = tally("old\n", final)
      expect(move.additions).toBe(wantMove.additions)
      expect(move.deletions).toBe(wantMove.deletions)
      const del = result.metadata.files.find((f: any) => f.type === "delete")
      expect(del.additions).toBe(0)
      expect(del.patch).toContain("-bye")
      const goneExists = yield* Effect.promise(() =>
        fs
          .access(gone)
          .then(() => true)
          .catch(() => false),
      )
      expect(goneExists).toBe(false)
      const srcExists = yield* Effect.promise(() =>
        fs
          .access(src)
          .then(() => true)
          .catch(() => false),
      )
      expect(srcExists).toBe(false)
    }),
  )

  it.instance("permission failure produces no completed metadata", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "deny.txt")
      yield* put(file, "keep\n")
      let metas = 0
      const ctx = {
        ...base,
        ask: () => Effect.fail(new Error("denied")),
        metadata: () => Effect.sync(() => metas++),
      }
      const exit = yield* runEdit({ filePath: file, oldString: "keep", newString: "change" }, ctx).pipe(Effect.exit)
      expect(exit._tag).not.toBe("Success")
      expect(metas).toBe(0)
      expect(yield* load(file)).toBe("keep\n")
    }),
  )

  it.instance("message metadata strip keeps bounded patches and drops oversized", () =>
    Effect.gen(function* () {
      const small = createTwoFilesPatch("a", "a", "one\n", "two\n")
      const big = `Index: a\n--- a\n+++ a\n@@ -1,1 +1,1 @@\n-${"x".repeat(MAX_MESSAGE_PATCH_SIZE)}\n+${"y".repeat(MAX_MESSAGE_PATCH_SIZE)}\n`
      const mk = (metadata: Record<string, unknown>) =>
        ({
          id: PartID.make("prt-strip"),
          sessionID: SessionID.make("ses_strip"),
          messageID: MessageID.make("msg_strip"),
          type: "tool",
          callID: "call",
          tool: "edit",
          state: { status: "completed", input: {}, output: "ok", title: "t", metadata, time: { start: 0, end: 1 } },
        }) as unknown as MessageV2.Part
      const kept = MessageV2.stripPartMetadata(
        mk({ filediff: { file: "a", patch: small, before: "b", after: "a", additions: 1, deletions: 1 } }),
      ) as any
      expect(kept.state.metadata.filediff.patch).toBe(small)
      expect(kept.state.metadata.filediff.before).toBeUndefined()
      const dropped = MessageV2.stripPartMetadata(
        mk({ filediff: { file: "a", patch: big, additions: 1, deletions: 1 } }),
      ) as any
      expect(dropped.state.metadata.filediff.patch).toBeUndefined()
      const files = MessageV2.stripPartMetadata(
        mk({ files: [{ filePath: "a", patch: small, additions: 1, deletions: 1 }, { filePath: "b", patch: big }] }),
      ) as any
      expect(files.state.metadata.files[0].patch).toBe(small)
      expect(files.state.metadata.files[1].patch).toBeUndefined()
      expect(Snapshot.MAX_DIFF_SIZE).toBe(MAX_MESSAGE_PATCH_SIZE)
    }),
  )
})
