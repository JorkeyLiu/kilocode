import { Cause, Schema } from "effect"
import * as path from "path"
import { Effect } from "effect"
import * as Tool from "./tool"
import { LSP } from "@/lsp/lsp"
import DESCRIPTION from "./write.txt"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { Format } from "../format"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { build } from "./filediff" // kilocode_change - shared formatter-final diff builder
import { SnapshotJournal } from "@/snapshot/journal" // kilocode_change - Snapshot v2 durable mutation journal
import { assertExternalDirectoryEffect } from "./external-directory"
import { filterDiagnostics } from "./diagnostics" // kilocode_change
import { ConfigValidation } from "../kilocode/config-validation" // kilocode_change
import * as EncodedIO from "../kilocode/tool/encoded-io" // kilocode_change
import * as Bom from "@/util/bom"

const MAX_PROJECT_DIAGNOSTICS_FILES = 5

export const Parameters = Schema.Struct({
  content: Schema.String.annotate({ description: "The content to write to the file" }),
  filePath: Schema.String.annotate({
    description: "The absolute path to the file to write (must be absolute, not relative)",
  }),
})

export const WriteTool = Tool.define(
  "write",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const fs = yield* FSUtil.Service
    const events = yield* EventV2Bridge.Service
    const format = yield* Format.Service
    // kilocode_change - Snapshot v2 journal is required: ToolRegistry provides the canonical instance.
    const journal = yield* SnapshotJournal.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { content: string; filePath: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const filepath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(instance.directory, params.filePath)
          yield* assertExternalDirectoryEffect(ctx, filepath)

          const exists = yield* fs.existsSafe(filepath)
          // kilocode_change start - encoding-aware read; Encoding.read strips UTF-8 BOMs so
          // derive the BOM flag from the detected encoding label instead of the decoded text.
          const pre = exists
            ? yield* EncodedIO.read(fs, filepath)
            : { bytes: null as Buffer | null, text: "", encoding: "utf-8" }
          const source = { bom: pre.encoding === "utf-8-bom", text: pre.text, encoding: pre.encoding }
          // kilocode_change end
          const next = Bom.split(params.content)
          const desiredBom = source.bom || next.bom
          const contentOld = source.text
          const contentNew = next.text

          // kilocode_change start - ask uses the expected write diff; result uses formatter-final truth
          const ask = build(filepath, contentOld, contentNew)
          yield* ctx.ask({
            permission: "edit",
            patterns: [path.relative(instance.worktree, filepath)],
            always: ["*"],
            metadata: {
              filepath,
              diff: ask.diff,
              filediff: ask.filediff, // kilocode_change
            },
          })

          // kilocode_change - Snapshot v2 journal: prepare after ask, before any write (sub 0).
          // Any post-prepare failure marks failed (coverage failed + ids) before the cause propagates.
          let journalIDs: string[] = []
          const noted = yield* journal
            .prepare({
              sessionID: ctx.sessionID,
              messageID: ctx.messageID,
              callID: ctx.callID,
              tool: "write",
              item: 0,
              sub: 0,
              directory: instance.directory,
              worktree: instance.worktree,
              path: filepath,
              op: exists ? "update" : "add",
              before: pre.bytes,
              encoding: source.encoding,
              bom: source.bom,
            })
            .pipe(
              Effect.tapCause(() =>
                ctx.metadata({ metadata: { journal: { coverage: "failed", ids: journalIDs } } }).pipe(Effect.ignore),
              ),
            )
          journalIDs = [noted.row.id]
          yield* ctx.metadata({ metadata: { journal: { coverage: "partial", ids: journalIDs } } })

          let final = contentNew
          const exit = yield* Effect.gen(function* () {
            yield* EncodedIO.write(fs, filepath, Bom.join(contentNew, desiredBom), source.encoding) // kilocode_change - encoding-aware write (mkdirs) replaces fs.writeWithDirs
            if (yield* format.file(filepath)) {
              final = yield* EncodedIO.sync(fs, filepath, desiredBom, source.encoding)
            }
            // kilocode_change - Snapshot v2 journal: apply formatter-final raw bytes
            const written = Buffer.from(yield* fs.readFile(filepath))
            yield* journal.apply({
              id: noted.row.id,
              after: written,
              encoding: source.encoding,
              bom: desiredBom,
              beforeFallback: pre.bytes,
            })
          }).pipe(Effect.exit)
          if (exit._tag === "Failure") {
            const message = Cause.pretty(exit.cause as never)
            yield* journal.fail({ id: noted.row.id, error: message }).pipe(Effect.ignore)
            yield* ctx.metadata({ metadata: { journal: { coverage: "failed", ids: journalIDs } } }).pipe(Effect.ignore)
            return yield* Effect.failCause(exit.cause)
          }
          const result = build(filepath, contentOld, final)
          const diff = result.diff
          const filediff = result.filediff
          // kilocode_change end
          yield* events.publish(FileSystem.Event.Edited, { file: filepath })
          yield* events.publish(Watcher.Event.Updated, {
            file: filepath,
            event: exists ? "change" : "add",
          })

          let output = "Wrote file successfully."
          yield* lsp.touchFile(filepath, "document")
          const diagnostics = yield* lsp.diagnostics()
          const normalizedFilepath = FSUtil.normalizePath(filepath)
          let projectDiagnosticsCount = 0
          for (const [file, issues] of Object.entries(diagnostics)) {
            const current = file === normalizedFilepath
            if (!current && projectDiagnosticsCount >= MAX_PROJECT_DIAGNOSTICS_FILES) continue
            const block = LSP.Diagnostic.report(current ? filepath : file, issues)
            if (!block) continue
            if (current) {
              output += `\n\nLSP errors detected in this file, please fix:\n${block}`
              continue
            }
            projectDiagnosticsCount++
            output += `\n\nLSP errors detected in other files:\n${block}`
          }
          output += yield* Effect.promise(() => ConfigValidation.check(filepath)) // kilocode_change

          return {
            title: path.relative(instance.worktree, filepath),
            metadata: {
              diagnostics: filterDiagnostics(diagnostics, [normalizedFilepath]), // kilocode_change
              filepath,
              exists: exists,
              diff, // kilocode_change
              filediff, // kilocode_change
              journal: { coverage: "full", ids: journalIDs }, // kilocode_change - success alone is full
            },
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
