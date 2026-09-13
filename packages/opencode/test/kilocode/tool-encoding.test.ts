// Integration tests verifying that the agent file tools (read, write, edit,
// apply_patch) detect and preserve the original encoding of files on disk.
// Tests exercise the real tool pipeline rather than the Encoding helper
// directly so we validate end-to-end behaviour.

import { afterEach, describe, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import path from "path"
import fs from "fs/promises"
import iconv from "iconv-lite"
import { Agent } from "../../src/agent/agent"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { Bus } from "../../src/bus"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { EditTool } from "../../src/tool/edit"
import { Format } from "../../src/format"
import { Instance } from "../../src/kilocode/instance"
import { Instruction } from "../../src/session/instruction"
import { LSP } from "../../src/lsp/lsp"
import { MessageID, SessionID } from "../../src/session/schema"
import { ReadTool } from "../../src/tool/read"
import * as Tool from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"
import { WriteTool } from "../../src/tool/write"
import * as EncodedIO from "../../src/kilocode/tool/encoded-io"
import { Hash } from "@opencode-ai/core/util/hash"
import { SnapshotJournal } from "../../src/snapshot/journal"
import { SnapshotJournalCas } from "../../src/snapshot/journal-cas"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { JournalMemory, ensureJournalSession } from "../fixture/journal" // kilocode_change - file tools require canonical journal

const ctx = {
  sessionID: SessionID.make("ses_test-encoding"),
  messageID: MessageID.make("msg_test-encoding"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

let seq = 0 // kilocode_change - unique call per run keeps journal keys distinct

const it = testEffect(
  Layer.mergeAll(JournalMemory,
    Agent.defaultLayer,
    FSUtil.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Instruction.defaultLayer,
    LSP.defaultLayer,
    Bus.layer,
    Format.defaultLayer,
    Truncate.defaultLayer,
    EventV2Bridge.defaultLayer,
  ),
)

const runRead = (args: Tool.InferParameters<typeof ReadTool>, next: Tool.Context = ctx) =>
  Effect.gen(function* () {
    const info = yield* ReadTool
    const tool = yield* info.init()
    return yield* tool.execute(args, next)
  })

const runWrite = (args: Tool.InferParameters<typeof WriteTool>) =>
  Effect.gen(function* () {
    const fresh = { ...ctx, callID: `${ctx.callID || "call"}-${(seq += 1)}` }
    yield* ensureJournalSession(fresh.sessionID as string)
    const info = yield* WriteTool
    const tool = yield* info.init()
    return yield* tool.execute(args, fresh)
  })

const runEdit = (args: Tool.InferParameters<typeof EditTool>) =>
  Effect.gen(function* () {
    const fresh = { ...ctx, callID: `${ctx.callID || "call"}-${(seq += 1)}` }
    yield* ensureJournalSession(fresh.sessionID as string)
    const info = yield* EditTool
    const tool = yield* info.init()
    return yield* tool.execute(args, fresh)
  })

const runPatch = (args: Tool.InferParameters<typeof ApplyPatchTool>) =>
  Effect.gen(function* () {
    const fresh = { ...ctx, callID: `${ctx.callID || "call"}-${(seq += 1)}` }
    yield* ensureJournalSession(fresh.sessionID as string)
    const info = yield* ApplyPatchTool
    const tool = yield* info.init()
    return yield* tool.execute(args, fresh)
  })

// FileTime was removed upstream; edit/write no longer require a prior read.
const markRead = (_filepath: string) => Effect.void

// iconv-lite's UTF codecs don't emit BOMs, but this codebase supports
// "UTF-X with BOM" as a distinct variant. Prepend one here for fixture files
// that are meant to have one.
const UTF8_BOM = "utf-8-bom"
const encodeBytes = (text: string, encoding: string): Buffer => {
  if (encoding === UTF8_BOM) return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), iconv.encode(text, "utf-8")])
  const lower = encoding.toLowerCase()
  if (lower === "utf-16le") return Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode(text, encoding)])
  if (lower === "utf-16be") return Buffer.concat([Buffer.from([0xfe, 0xff]), iconv.encode(text, encoding)])
  if (lower === "utf-32le") return Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x00]), iconv.encode(text, encoding)])
  if (lower === "utf-32be") return Buffer.concat([Buffer.from([0x00, 0x00, 0xfe, 0xff]), iconv.encode(text, encoding)])
  return iconv.encode(text, encoding)
}

// Create a file with the given encoding by writing raw bytes.
const putEncoded = (filepath: string, text: string, encoding: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(filepath), { recursive: true })
    await fs.writeFile(filepath, encodeBytes(text, encoding))
  })

const loadDecoded = (filepath: string, encoding: string) =>
  Effect.promise(async () => {
    const bytes = await fs.readFile(filepath)
    if (encoding === UTF8_BOM) {
      const stripped = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
      return iconv.decode(stripped ? bytes.subarray(3) : bytes, "utf-8")
    }
    return iconv.decode(bytes, encoding)
  })

const loadBytes = (filepath: string) => Effect.promise(() => fs.readFile(filepath))

// Sample phrases chosen to exercise each encoding's characteristic byte patterns.
const samples = {
  utf8: "Hello, world! — £100",
  shiftJis: "こんにちは、世界！日本語のテストです。",
  eucJp: "日本語のEUC-JPテスト文字列です。",
  gb2312: "你好，世界！这是简体中文测试。",
  big5: "你好，世界！這是繁體中文測試。",
  eucKr: "안녕하세요, 세계! 한국어 테스트입니다.",
  windows1251: "Привет, мир! Это тест кириллицы.",
  koi8r: "Привет, мир! КОИ-8 Р тест.",
}

describe("tool encoding preservation", () => {
  describe("ReadTool decodes files with non-UTF-8 encodings", () => {
    const cases: Array<[string, string, string]> = [
      ["UTF-8", "utf-8", samples.utf8],
      ["UTF-8 with BOM", UTF8_BOM, samples.utf8],
      ["UTF-16 LE with BOM", "utf-16le", samples.utf8],
      ["UTF-16 BE with BOM", "utf-16be", samples.utf8],
      ["UTF-32 LE with BOM", "utf-32le", samples.utf8],
      ["UTF-32 BE with BOM", "utf-32be", samples.utf8],
      ["Shift_JIS", "Shift_JIS", samples.shiftJis],
      ["EUC-JP", "euc-jp", samples.eucJp],
      ["GB2312", "gb2312", samples.gb2312],
      ["Big5", "big5", samples.big5],
      ["EUC-KR", "euc-kr", samples.eucKr],
      ["Windows-1251", "windows-1251", samples.windows1251],
      ["KOI8-R", "koi8-r", samples.koi8r],
    ]

    for (const [label, encoding, text] of cases) {
      it.live(`decodes ${label} content for the model`, () =>
        provideEncoded(encoding, text, (filepath) =>
          Effect.gen(function* () {
            const result = yield* runRead({ filePath: filepath })
            expect(result.output).toContain(text)
          }),
        ),
      )
    }
  })

  describe("ReadTool does not flag non-Latin text files as binary", () => {
    it.live("accepts Shift_JIS", () =>
      provideEncoded("Shift_JIS", samples.shiftJis, (filepath) =>
        Effect.gen(function* () {
          const result = yield* runRead({ filePath: filepath })
          expect(result.output).toContain(samples.shiftJis)
        }),
      ),
    )

    it.live("accepts UTF-16 LE with BOM (contains NUL bytes)", () =>
      provideEncoded("utf-16le", samples.utf8, (filepath) =>
        Effect.gen(function* () {
          const result = yield* runRead({ filePath: filepath })
          expect(result.output).toContain(samples.utf8)
        }),
      ),
    )

    it.live("accepts UTF-32 LE with BOM (3 of every 4 bytes are NUL)", () =>
      provideEncoded("utf-32le", samples.utf8, (filepath) =>
        Effect.gen(function* () {
          const result = yield* runRead({ filePath: filepath })
          expect(result.output).toContain(samples.utf8)
        }),
      ),
    )
  })

  describe("ReadTool streaming and pagination", () => {
    it.live("releases a truncated UTF-8 file before atomic replacement", () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const filepath = path.join(dir, "large.txt")
          const temp = `${filepath}.tmp`
          const content = `${"x".repeat(80)}\n`.repeat(50_000)
          yield* Effect.promise(() => fs.writeFile(filepath, content))

          const result = yield* runRead({ filePath: filepath })

          expect(result.metadata.truncated).toBe(true)
          expect(result.output).not.toContain(content.slice(-1_000))
          yield* Effect.promise(async () => {
            await fs.writeFile(temp, "replacement\n")
            await fs.rename(temp, filepath)
          })
          expect(yield* Effect.promise(() => fs.readFile(filepath, "utf8"))).toBe("replacement\n")
        }),
      ),
    )

    it.live("closes the source stream when the read is aborted", () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const filepath = path.join(dir, "abort.txt")
          const temp = `${filepath}.tmp`
          yield* Effect.promise(() => fs.writeFile(filepath, `${"x".repeat(80)}\n`.repeat(50_000)))

          const controller = new AbortController()
          controller.abort()
          const exit = yield* runRead({ filePath: filepath }, { ...ctx, abort: controller.signal }).pipe(Effect.exit)

          expect(Exit.isFailure(exit)).toBe(true)
          yield* Effect.promise(async () => {
            await fs.writeFile(temp, "replacement\n")
            await fs.rename(temp, filepath)
          })
          expect(yield* Effect.promise(() => fs.readFile(filepath, "utf8"))).toBe("replacement\n")
        }),
      ),
    )

    it.live("releases a fallback-decoded file before atomic replacement", () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const filepath = path.join(dir, "legacy.txt")
          const temp = `${filepath}.tmp`
          const lines = Array.from({ length: 1_000 }, (_, i) => `valid-${i + 1}-${"x".repeat(70)}`)
          const content = Buffer.concat([
            Buffer.from(lines.join("\n") + "\n"),
            iconv.encode(samples.shiftJis, "Shift_JIS"),
            Buffer.from("\nlast"),
          ])
          yield* Effect.promise(() => fs.writeFile(filepath, content))

          const result = yield* runRead({ filePath: filepath, offset: 999, limit: 5 })

          expect(result.output.match(/999: valid-999-/g)?.length).toBe(1)
          expect(result.output).toContain(`1001: ${samples.shiftJis}`)
          expect(result.output).toContain("1002: last")
          yield* Effect.promise(async () => {
            await fs.writeFile(temp, "replacement\n")
            await fs.rename(temp, filepath)
          })
          expect(yield* Effect.promise(() => fs.readFile(filepath, "utf8"))).toBe("replacement\n")
        }),
      ),
    )

    it.live("clamps a zero line limit and advances pagination", () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const filepath = path.join(dir, "lines.txt")
          yield* Effect.promise(() => fs.writeFile(filepath, "first\nsecond"))

          const result = yield* runRead({ filePath: filepath, limit: 0 })

          expect(result.output).toContain("1: first")
          expect(result.output).not.toContain("2: second")
          expect(result.output).toContain("Use offset=2")
        }),
      ),
    )

    it.live("keeps truncated lines valid when an emoji crosses the boundary", () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const filepath = path.join(dir, "emoji.txt")
          yield* Effect.promise(() => fs.writeFile(filepath, "x".repeat(1999) + "📁" + "tail"))

          const result = yield* runRead({ filePath: filepath })
          const isolated = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

          expect(isolated.test(result.output)).toBe(false)
          expect(result.output).toContain("(line truncated to 1999 chars)")
        }),
      ),
    )
  })

  describe("WriteTool preserves existing file encoding when overwriting", () => {
    const cases: Array<[string, string, string]> = [
      ["UTF-8 with BOM", UTF8_BOM, samples.utf8],
      ["Shift_JIS", "Shift_JIS", samples.shiftJis],
      ["GB2312", "gb2312", samples.gb2312],
      ["Windows-1251", "windows-1251", samples.windows1251],
      ["UTF-16 LE", "utf-16le", samples.utf8],
      ["UTF-32 LE", "utf-32le", samples.utf8],
      ["UTF-32 BE", "utf-32be", samples.utf8],
    ]

    for (const [label, encoding, original] of cases) {
      it.live(`preserves ${label} encoding on overwrite`, () =>
        provideTmpdirInstance((dir) =>
          Effect.gen(function* () {
            const filepath = path.join(dir, "file.txt")
            yield* putEncoded(filepath, original, encoding)
            yield* markRead(filepath)

            const replacement = original + " updated"
            yield* runWrite({ filePath: filepath, content: replacement })

            const decoded = yield* loadDecoded(filepath, encoding)
            expect(decoded).toBe(replacement)

            // Bytes should still match the original encoding (and differ from UTF-8).
            const bytes = yield* loadBytes(filepath)
            expect(bytes.equals(encodeBytes(replacement, encoding))).toBe(true)
          }),
        ),
      )
    }

    it.live("defaults new files to UTF-8", () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const filepath = path.join(dir, "new.txt")
          yield* runWrite({ filePath: filepath, content: samples.utf8 })

          const bytes = yield* loadBytes(filepath)
          expect(bytes.equals(Buffer.from(samples.utf8, "utf-8"))).toBe(true)
        }),
      ),
    )

    // Guard against double-BOM regressions: if the model ever hands back content
    // that already starts with U+FEFF (e.g. by round-tripping literal bytes),
    // writing it to a BOM-encoded file must still produce exactly one BOM.
    const bomCases: Array<[string, string, Buffer]> = [
      ["UTF-8 with BOM", UTF8_BOM, Buffer.from([0xef, 0xbb, 0xbf])],
      ["UTF-16 LE", "utf-16le", Buffer.from([0xff, 0xfe])],
      ["UTF-16 BE", "utf-16be", Buffer.from([0xfe, 0xff])],
      ["UTF-32 LE", "utf-32le", Buffer.from([0xff, 0xfe, 0x00, 0x00])],
      ["UTF-32 BE", "utf-32be", Buffer.from([0x00, 0x00, 0xfe, 0xff])],
    ]
    for (const [label, encoding, bom] of bomCases) {
      it.live(`does not emit a double BOM for ${label} when content starts with U+FEFF`, () =>
        provideTmpdirInstance((dir) =>
          Effect.gen(function* () {
            const filepath = path.join(dir, "file.txt")
            yield* putEncoded(filepath, "hello", encoding)
            yield* markRead(filepath)

            yield* runWrite({ filePath: filepath, content: "\uFEFFgoodbye" })

            const bytes = yield* loadBytes(filepath)
            // Exactly one BOM prefix, immediately followed by encoded payload.
            expect(bytes.subarray(0, bom.length).equals(bom)).toBe(true)
            expect(bytes.subarray(bom.length, bom.length * 2).equals(bom)).toBe(false)
            const decoded = yield* loadDecoded(filepath, encoding)
            expect(decoded).toBe("goodbye")
          }),
        ),
      )
    }
  })

  describe("EditTool preserves existing file encoding across edits", () => {
    const cases: Array<[string, string, string, string, string]> = [
      ["UTF-8 with BOM", UTF8_BOM, samples.utf8 + "\n second line", "world", "earth"],
      ["Shift_JIS", "Shift_JIS", samples.shiftJis, "日本語", "ニホンゴ"],
      ["GB2312", "gb2312", samples.gb2312, "简体中文", "中文简体"],
      ["Windows-1251", "windows-1251", samples.windows1251, "мир", "планета"],
      ["UTF-16 LE", "utf-16le", samples.utf8 + "\n second line", "world", "earth"],
      ["UTF-32 LE", "utf-32le", samples.utf8 + "\n second line", "world", "earth"],
    ]

    for (const [label, encoding, original, oldString, newString] of cases) {
      it.live(`preserves ${label} through edit`, () =>
        provideTmpdirInstance((dir) =>
          Effect.gen(function* () {
            const filepath = path.join(dir, "doc.txt")
            yield* putEncoded(filepath, original, encoding)
            yield* markRead(filepath)

            yield* runEdit({ filePath: filepath, oldString, newString })

            const decoded = yield* loadDecoded(filepath, encoding)
            const expected = original.replace(oldString, newString)
            expect(decoded).toBe(expected)

            const bytes = yield* loadBytes(filepath)
            expect(bytes.equals(encodeBytes(expected, encoding))).toBe(true)
          }),
        ),
      )
    }
  })

  describe("ApplyPatchTool preserves encoding", () => {
    it.live("preserves Shift_JIS through an update hunk", () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const filepath = path.join(dir, "doc.txt")
          const replacement = "日本語"
          const original = "line1\n" + samples.shiftJis + "\nline3\n"
          const expected = original.replace(samples.shiftJis, replacement)
          yield* putEncoded(filepath, original, "Shift_JIS")

          const patch = [
            "*** Begin Patch",
            "*** Update File: doc.txt",
            "@@",
            " line1",
            "-" + samples.shiftJis,
            "+" + replacement,
            " line3",
            "*** End Patch",
          ].join("\n")

          yield* runPatch({ patchText: patch })

          const decoded = yield* loadDecoded(filepath, "Shift_JIS")
          expect(decoded).toBe(expected)

          // Bytes must still be Shift_JIS, not silently promoted to UTF-8.
          const bytes = yield* loadBytes(filepath)
          expect(bytes.equals(encodeBytes(expected, "Shift_JIS"))).toBe(true)
        }),
      ),
    )

    // Regression guard: the diff and additions/deletions counts surfaced to the
    // user (and to the permission prompt) are derived from the pre-patch read
    // of the file. A previous version reused a hard-coded UTF-8 decoder for
    // that read, producing mojibake for any non-UTF-8 file. The bytes ended up
    // correct because the patch helper does its own encoding-aware read, so
    // tests that only checked final file bytes (above) missed the bug.
    it.live("returns a non-mojibake diff for a Shift_JIS update", () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const filepath = path.join(dir, "doc.txt")
          const replacement = "日本語"
          const original = "line1\n" + samples.shiftJis + "\nline3\n"
          yield* putEncoded(filepath, original, "Shift_JIS")

          const patch = [
            "*** Begin Patch",
            "*** Update File: doc.txt",
            "@@",
            " line1",
            "-" + samples.shiftJis,
            "+" + replacement,
            " line3",
            "*** End Patch",
          ].join("\n")

          const result = (yield* runPatch({ patchText: patch })) as {
            metadata: {
              diff: string
              files: Array<{ additions: number; deletions: number }>
            }
          }

          // The diff must contain the real decoded old/new lines, not a UTF-8
          // misread of the Shift_JIS bytes (which would surface as U+FFFD).
          expect(result.metadata.diff).toContain(samples.shiftJis)
          expect(result.metadata.diff).toContain(replacement)
          expect(result.metadata.diff).not.toContain("\uFFFD")

          // Per-file stats are derived from the same diff, so a mojibake read
          // would inflate both additions and deletions.
          expect(result.metadata.files).toHaveLength(1)
          expect(result.metadata.files[0].additions).toBe(1)
          expect(result.metadata.files[0].deletions).toBe(1)
        }),
      ),
    )

    it.live("new files added via apply_patch are UTF-8", () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const patch = ["*** Begin Patch", "*** Add File: new.txt", "+hello world", "*** End Patch"].join("\n")
          const result = (yield* runPatch({ patchText: patch })) as {
            metadata: { journal: { coverage: string; ids: string[] } }
          }
          const bytes = yield* loadBytes(path.join(dir, "new.txt"))
          expect(bytes.equals(Buffer.from("hello world\n", "utf-8"))).toBe(true)
          // New-file journal fact stays UTF-8 with no before image.
          const journal = yield* SnapshotJournal.Service
          const row = yield* journal.get(result.metadata.journal.ids[0]!).pipe(Effect.orDie)
          expect(row).toBeDefined()
          expect(row!.op).toBe("add")
          expect(row!.encoding).toBe("utf-8")
          expect(row!.before_blob).toBeNull()
          expect(row!.after_hash).toBe(Hash.sha256(bytes))
          expect(Buffer.from((yield* journal.readBlob(row!.after_hash!).pipe(Effect.orDie))!).equals(bytes)).toBe(true)
        }),
      ),
    )

    // Add-overwrite must preserve the existing file encoding instead of
    // hard-coding UTF-8: the parser allows Add to replace an existing file,
    // and the tool already captures the prior bytes for the journal/CAS
    // baseline. A UTF-8 re-encode would corrupt legacy bytes (mojibake) and
    // record a false journal encoding fact.
    it.live("preserves latin1 encoding when Add overwrites an existing file", () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const filepath = path.join(dir, "legacy.txt")
          const priorText = "café legacy ñandú\n"
          const nextText = "café updated águila\n"
          yield* putEncoded(filepath, priorText, "iso-8859-1")
          const priorBytes = yield* loadBytes(filepath)

          const patch = ["*** Begin Patch", "*** Add File: legacy.txt", `+${nextText.trimEnd()}`, "*** End Patch"].join(
            "\n",
          )
          const result = (yield* runPatch({ patchText: patch })) as {
            metadata: { journal: { coverage: string; ids: string[] } }
          }

          const bytes = yield* loadBytes(filepath)
          const decoded = iconv.decode(bytes, "iso-8859-1")
          expect(decoded).toBe(nextText)
          // Byte-exact legacy encoding, not silently promoted to UTF-8.
          expect(bytes.equals(iconv.encode(nextText, "iso-8859-1"))).toBe(true)
          expect(bytes.equals(Buffer.from(nextText, "utf-8"))).toBe(false)
          // No UTF-8 mojibake: single-byte é stays 0xE9, never C3 A9, and no
          // replacement characters or latin1-misread UTF-8 pairs surface.
          expect(decoded).toContain("café")
          expect(decoded).not.toContain("\uFFFD")
          expect(decoded).not.toContain("Ã©")
          expect(bytes.includes(Buffer.from([0xc3, 0xa9]))).toBe(false)

          // Journal fact uses the real prior encoding for prepare and apply.
          const journal = yield* SnapshotJournal.Service
          expect(result.metadata.journal.coverage).toBe("full")
          expect(result.metadata.journal.ids).toHaveLength(1)
          const row = yield* journal.get(result.metadata.journal.ids[0]!).pipe(Effect.orDie)
          expect(row).toBeDefined()
          expect(row!.op).toBe("add")
          expect(row!.status).toBe("applied")
          expect(row!.encoding).not.toBe("utf-8")
          expect(row!.encoding).not.toBe("utf-8-bom")
          expect(iconv.encodingExists(row!.encoding!)).toBe(true)
          expect(iconv.decode(bytes, row!.encoding!)).toBe(nextText)
          expect(row!.bom).toBe(0)
          expect(row!.before_hash).toBe(Hash.sha256(priorBytes))
          expect(row!.after_hash).toBe(Hash.sha256(bytes))
          expect(Buffer.from((yield* journal.readBlob(row!.before_hash!).pipe(Effect.orDie))!).equals(priorBytes)).toBe(
            true,
          )
          expect(Buffer.from((yield* journal.readBlob(row!.after_hash!).pipe(Effect.orDie))!).equals(bytes)).toBe(true)

          // Undo/redo round-trips raw bytes through the journal CAS executor.
          // Scope to the row's own session/worktree (tmpdir symlinks resolve
          // differently from the instance worktree string).
          yield* SnapshotJournalCas.run({
            sessionID: row!.session_id,
            worktree: row!.worktree,
            segments: [{ applyOrder: [row!.id], direction: "undo" }],
          })
          expect((yield* loadBytes(filepath)).equals(priorBytes)).toBe(true)
          yield* SnapshotJournalCas.run({
            sessionID: row!.session_id,
            worktree: row!.worktree,
            segments: [{ applyOrder: [row!.id], direction: "redo" }],
          })
          expect((yield* loadBytes(filepath)).equals(bytes)).toBe(true)
        }),
      ),
    )

    // utf-8-bom overwrite without a patch BOM must keep the BOM (write/edit
    // desiredBom rule): stripping it would corrupt the file signature while
    // the journal still claims utf-8-bom.
    it.live("preserves utf-8-bom when Add overwrites without a patch BOM", () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const filepath = path.join(dir, "bom.txt")
          const priorText = "café legacy\n"
          const nextText = "café updated\n"
          yield* putEncoded(filepath, priorText, UTF8_BOM)
          const priorBytes = yield* loadBytes(filepath)
          expect(priorBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true)

          const patch = ["*** Begin Patch", "*** Add File: bom.txt", `+${nextText.trimEnd()}`, "*** End Patch"].join(
            "\n",
          )
          const result = (yield* runPatch({ patchText: patch })) as {
            metadata: { journal: { coverage: string; ids: string[] } }
          }

          const bytes = yield* loadBytes(filepath)
          expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true)
          expect(bytes.equals(encodeBytes(nextText, UTF8_BOM))).toBe(true)
          expect(yield* loadDecoded(filepath, UTF8_BOM)).toBe(nextText)

          const journal = yield* SnapshotJournal.Service
          expect(result.metadata.journal.coverage).toBe("full")
          expect(result.metadata.journal.ids).toHaveLength(1)
          const row = yield* journal.get(result.metadata.journal.ids[0]!).pipe(Effect.orDie)
          expect(row).toBeDefined()
          expect(row!.op).toBe("add")
          expect(row!.status).toBe("applied")
          expect(row!.encoding).toBe(UTF8_BOM)
          expect(row!.bom).toBe(1)
          expect(row!.before_hash).toBe(Hash.sha256(priorBytes))
          expect(row!.after_hash).toBe(Hash.sha256(bytes))
          expect(Buffer.from((yield* journal.readBlob(row!.before_hash!).pipe(Effect.orDie))!).equals(priorBytes)).toBe(
            true,
          )
          expect(Buffer.from((yield* journal.readBlob(row!.after_hash!).pipe(Effect.orDie))!).equals(bytes)).toBe(true)

          yield* SnapshotJournalCas.run({
            sessionID: row!.session_id,
            worktree: row!.worktree,
            segments: [{ applyOrder: [row!.id], direction: "undo" }],
          })
          expect((yield* loadBytes(filepath)).equals(priorBytes)).toBe(true)
          yield* SnapshotJournalCas.run({
            sessionID: row!.session_id,
            worktree: row!.worktree,
            segments: [{ applyOrder: [row!.id], direction: "redo" }],
          })
          expect((yield* loadBytes(filepath)).equals(bytes)).toBe(true)
        }),
      ),
    )

    // Plain UTF-8 overwrite with an explicit patch BOM keeps next.bom
    // semantics (same as new files and the pre-fix utf-8 path): the BOM is
    // added and the journal records encoding utf-8 with bom set.
    it.live("adds a patch BOM when Add overwrites a plain utf-8 file", () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const filepath = path.join(dir, "plain.txt")
          const priorText = "hello legacy\n"
          const nextText = "hello updated\n"
          yield* putEncoded(filepath, priorText, "utf-8")
          const priorBytes = yield* loadBytes(filepath)
          expect(priorBytes[0]).not.toBe(0xef)

          const patch = ["*** Begin Patch", "*** Add File: plain.txt", `+\uFEFF${nextText.trimEnd()}`, "*** End Patch"].join(
            "\n",
          )
          const result = (yield* runPatch({ patchText: patch })) as {
            metadata: { journal: { coverage: string; ids: string[] } }
          }

          const bytes = yield* loadBytes(filepath)
          expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true)
          expect(bytes.equals(encodeBytes(nextText, UTF8_BOM))).toBe(true)
          expect(yield* loadDecoded(filepath, UTF8_BOM)).toBe(nextText)

          const journal = yield* SnapshotJournal.Service
          const row = yield* journal.get(result.metadata.journal.ids[0]!).pipe(Effect.orDie)
          expect(row).toBeDefined()
          expect(row!.op).toBe("add")
          expect(row!.encoding).toBe("utf-8")
          expect(row!.bom).toBe(1)
          expect(row!.before_hash).toBe(Hash.sha256(priorBytes))
          expect(row!.after_hash).toBe(Hash.sha256(bytes))
        }),
      ),
    )

    // Deletes exercise a code path in patch/index.ts that doesn't write bytes
    // back — verify it still works when the target file is non-UTF-8, because
    // the deletion code has to decode the old contents to confirm match.
    it.live("deletes a Windows-1251 file without UTF-8 corruption errors", () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const filepath = path.join(dir, "legacy.txt")
          yield* putEncoded(filepath, samples.windows1251, "windows-1251")
          const patch = ["*** Begin Patch", "*** Delete File: legacy.txt", "*** End Patch"].join("\n")
          yield* runPatch({ patchText: patch })
          const exists = yield* Effect.promise(() =>
            fs
              .access(filepath)
              .then(() => true)
              .catch(() => false),
          )
          expect(exists).toBe(false)
        }),
      ),
    )
  })

  // EditTool's replaceAll path rewrites the entire buffer and re-encodes it
  // in one shot — regression guard that re-encoding a multi-occurrence edit in
  // a legacy encoding yields byte-exact output.
  describe("EditTool replaceAll preserves non-UTF-8 encoding", () => {
    it.live("replaces every occurrence in Shift_JIS", () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const filepath = path.join(dir, "doc.txt")
          // Pad with additional Shift_JIS text so chardet has enough bytes
          // to confidently identify the encoding.
          const pad = samples.shiftJis + "\n"
          const original = pad + "日本語\n日本語\n日本語\n" + pad
          yield* putEncoded(filepath, original, "Shift_JIS")
          yield* markRead(filepath)

          yield* runEdit({ filePath: filepath, oldString: "日本語", newString: "ニホンゴ", replaceAll: true })

          const expected =
            pad.replaceAll("日本語", "ニホンゴ") +
            "ニホンゴ\nニホンゴ\nニホンゴ\n" +
            pad.replaceAll("日本語", "ニホンゴ")
          const decoded = yield* loadDecoded(filepath, "Shift_JIS")
          expect(decoded).toBe(expected)
          const bytes = yield* loadBytes(filepath)
          expect(bytes.equals(encodeBytes(expected, "Shift_JIS"))).toBe(true)
        }),
      ),
    )
  })

  describe("formatter output preserves the source encoding", () => {
    const cases: Array<[string, string, boolean]> = [
      ["UTF-16 LE", "utf-16le", false],
      ["Windows-1251", "windows-1251", false],
      ["UTF-8 with BOM", UTF8_BOM, true],
    ]

    for (const [label, encoding, bom] of cases) {
      it.live(`re-encodes formatted ${label} content`, () =>
        provideTmpdirInstance((dir) =>
          Effect.gen(function* () {
            const filepath = path.join(dir, "formatted.txt")
            const content = encoding === "windows-1251" ? samples.windows1251 : samples.utf8
            const afs = yield* FSUtil.Service

            // Formatters commonly rewrite through UTF-8 regardless of the source encoding.
            yield* afs.writeFile(filepath, Buffer.from(content, "utf-8"))
            const synced = yield* EncodedIO.sync(afs, filepath, bom, encoding)

            expect(synced).toBe(content)
            const bytes = yield* loadBytes(filepath)
            expect(bytes.equals(encodeBytes(content, encoding))).toBe(true)
          }),
        ),
      )
    }
  })
})

// Shared helper to set up a temp instance with an encoded file at `file.txt`.
function provideEncoded<A, E, R>(encoding: string, text: string, body: (filepath: string) => Effect.Effect<A, E, R>) {
  return provideTmpdirInstance((dir) =>
    Effect.gen(function* () {
      const filepath = path.join(dir, "file.txt")
      yield* putEncoded(filepath, text, encoding)
      yield* markRead(filepath)
      return yield* body(filepath)
    }),
  )
}
