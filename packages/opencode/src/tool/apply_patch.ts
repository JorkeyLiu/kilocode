import * as path from "path"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { InstanceState } from "@/effect/instance-state"
import { Patch } from "../patch"
import { assertExternalDirectoryEffect } from "./external-directory"
import { build } from "./filediff" // kilocode_change - shared formatter-final diff builder
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import DESCRIPTION from "./apply_patch.txt"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { filterDiagnostics } from "./diagnostics" // kilocode_change
import { ConfigValidation } from "../kilocode/config-validation" // kilocode_change
import * as EncodedIO from "../kilocode/tool/encoded-io" // kilocode_change
import { Format } from "../format"
import * as Bom from "@/util/bom"

export const Parameters = Schema.Struct({
  patchText: Schema.String.annotate({ description: "The full patch text that describes all changes to be made" }),
})

export const ApplyPatchTool = Tool.define(
  "apply_patch",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* FSUtil.Service
    const format = yield* Format.Service
    const events = yield* EventV2Bridge.Service

    const run = Effect.fn("ApplyPatchTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      if (!params.patchText) {
        return yield* Effect.fail(new Error("patchText is required"))
      }

      // Parse the patch to get hunks
      let hunks: Patch.Hunk[]
      try {
        const parseResult = Patch.parsePatch(params.patchText)
        hunks = parseResult.hunks
      } catch (error) {
        return yield* Effect.fail(new Error(`apply_patch verification failed: ${error}`))
      }

      if (hunks.length === 0) {
        const normalized = params.patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim()
        if (normalized === "*** Begin Patch\n*** End Patch") {
          return yield* Effect.fail(new Error("patch rejected: empty patch"))
        }
        return yield* Effect.fail(new Error("apply_patch verification failed: no hunks found"))
      }

      const instance = yield* InstanceState.context

      // Validate file paths and check permissions
      const fileChanges: Array<{
        filePath: string
        oldContent: string
        newContent: string
        final: string // kilocode_change - formatter-final disk truth, filled after writes
        type: "add" | "update" | "delete" | "move"
        movePath?: string
        diff: string
        additions: number
        deletions: number
        bom: boolean
        encoding: string // kilocode_change - preserved per-file encoding
      }> = []

      let askDiff = ""

      for (const hunk of hunks) {
        const filePath = path.resolve(instance.directory, hunk.path)
        yield* assertExternalDirectoryEffect(ctx, filePath)

        switch (hunk.type) {
          case "add": {
            const oldContent = ""
            const newContent =
              hunk.contents.length === 0 || hunk.contents.endsWith("\n") ? hunk.contents : `${hunk.contents}\n`
            const next = Bom.split(newContent)
            const ask = build(filePath, oldContent, next.text) // kilocode_change - unified counts

            fileChanges.push({
              filePath,
              oldContent,
              newContent: next.text,
              final: next.text,
              type: "add",
              diff: ask.diff,
              additions: ask.filediff.additions,
              deletions: ask.filediff.deletions,
              bom: next.bom,
              encoding: "utf-8", // kilocode_change - new files default to utf-8
            })

            askDiff += ask.diff + "\n"
            break
          }

          case "update": {
            // Check if file exists for update
            const stats = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!stats || stats.type === "Directory") {
              return yield* Effect.fail(
                new Error(`apply_patch verification failed: Failed to read file to update: ${filePath}`),
              )
            }

            // kilocode_change start - encoding-aware read so non-UTF-8 files decode without
            // mojibake; the resulting diff, additions/deletions counts, and permission-prompt
            // metadata shown to the user must reflect the real file contents.
            const read = yield* EncodedIO.read(afs, filePath).pipe(
              Effect.catch((error) =>
                Effect.fail(
                  new Error(
                    `apply_patch verification failed: ${error instanceof Error ? error.message : String(error)}`,
                  ),
                ),
              ),
            )
            const source = Bom.split(read.text)
            // kilocode_change end
            const oldContent = source.text
            let newContent = oldContent
            let bom = source.bom
            let encoding = read.encoding // kilocode_change - overwritten by deriveNewContentsFromChunks below

            // Apply the update chunks to get new content
            try {
              const fileUpdate = Patch.deriveNewContentsFromChunks(
                filePath,
                hunk.chunks,
                Bom.join(source.text, source.bom),
              )
              newContent = fileUpdate.content
              bom = fileUpdate.bom
            } catch (error) {
              return yield* Effect.fail(new Error(`apply_patch verification failed: ${error}`))
            }

            const movePath = hunk.move_path ? path.resolve(instance.directory, hunk.move_path) : undefined
            yield* assertExternalDirectoryEffect(ctx, movePath)

            // kilocode_change - move patch header points at the final target so the
            // single-entry protocol never misreports source state as target state.
            const ask = build(movePath ?? filePath, oldContent, newContent)

            fileChanges.push({
              filePath,
              oldContent,
              newContent,
              final: newContent,
              type: hunk.move_path ? "move" : "update",
              movePath,
              diff: ask.diff,
              additions: ask.filediff.additions,
              deletions: ask.filediff.deletions,
              bom,
              encoding, // kilocode_change
            })

            askDiff += ask.diff + "\n"
            break
          }

          case "delete": {
            // kilocode_change start - encoding-aware read so non-UTF-8 files decode without corruption
            const deleteRead = yield* EncodedIO.read(afs, filePath).pipe(
              Effect.catch((error) =>
                Effect.fail(
                  new Error(
                    `apply_patch verification failed: ${error instanceof Error ? error.message : String(error)}`,
                  ),
                ),
              ),
            )
            const contentToDelete = deleteRead.text
            const source = Bom.split(contentToDelete)
            // kilocode_change end
            const ask = build(filePath, contentToDelete, "") // kilocode_change - unified counts

            fileChanges.push({
              filePath,
              oldContent: contentToDelete,
              newContent: "",
              final: "",
              type: "delete",
              diff: ask.diff,
              additions: ask.filediff.additions,
              deletions: ask.filediff.deletions,
              bom: source.bom,
              encoding: deleteRead.encoding, // kilocode_change
            })

            askDiff += ask.diff + "\n"
            break
          }
        }
      }

      // kilocode_change - askFiles carries the pre-format expected diff for permission;
      // result files are rebuilt formatter-final below.
      const askFiles = fileChanges.map((change) => ({
        filePath: change.filePath,
        relativePath: path.relative(instance.worktree, change.movePath ?? change.filePath).replaceAll("\\", "/"),
        type: change.type,
        patch: change.diff,
        additions: change.additions,
        deletions: change.deletions,
        movePath: change.movePath,
      }))

      // Check permissions if needed
      const relativePaths = fileChanges.map((c) => path.relative(instance.worktree, c.filePath).replaceAll("\\", "/"))
      yield* ctx.ask({
        permission: "edit",
        patterns: relativePaths,
        always: ["*"],
        metadata: {
          filepath: relativePaths.join(", "),
          diff: askDiff,
          files: askFiles,
        },
      })

      // Apply the changes
      const updates: Array<{ file: string; event: "add" | "change" | "unlink" }> = []

      for (const change of fileChanges) {
        const edited = change.type === "delete" ? undefined : (change.movePath ?? change.filePath)
        switch (change.type) {
          case "add":
            // Create parent directories (recursive: true is safe on existing/root dirs)
            yield* EncodedIO.write(afs, change.filePath, Bom.join(change.newContent, change.bom), change.encoding) // kilocode_change - encoding-aware write (mkdirs) replaces afs.writeWithDirs
            updates.push({ file: change.filePath, event: "add" })
            break

          case "update":
            yield* EncodedIO.write(afs, change.filePath, Bom.join(change.newContent, change.bom), change.encoding) // kilocode_change - encoding-aware write replaces afs.writeWithDirs
            updates.push({ file: change.filePath, event: "change" })
            break

          case "move":
            if (change.movePath) {
              // Create parent directories (recursive: true is safe on existing/root dirs)
              yield* EncodedIO.write(afs, change.movePath, Bom.join(change.newContent, change.bom), change.encoding) // kilocode_change - encoding-aware write (mkdirs) replaces afs.writeWithDirs
              yield* afs.remove(change.filePath)
              updates.push({ file: change.filePath, event: "unlink" })
              updates.push({ file: change.movePath, event: "add" })
            }
            break

          case "delete":
            yield* afs.remove(change.filePath)
            updates.push({ file: change.filePath, event: "unlink" })
            break
        }

        // kilocode_change start - capture formatter-final disk truth per file
        if (edited) {
          if (yield* format.file(edited)) {
            change.final = yield* EncodedIO.sync(afs, edited, change.bom, change.encoding)
          }
          yield* events.publish(FileSystem.Event.Edited, { file: edited })
        }
      }

      // kilocode_change start - rebuild result metadata from formatter-final truth.
      // Move keeps the single-entry protocol but its patch header points at the
      // final target; source deletion is expressed by filePath + unlink event.
      const files = fileChanges.map((change) => {
        if (change.type === "delete") {
          const done = build(change.filePath, change.oldContent, "")
          return {
            filePath: change.filePath,
            relativePath: path.relative(instance.worktree, change.filePath).replaceAll("\\", "/"),
            type: change.type,
            patch: done.diff,
            additions: done.filediff.additions,
            deletions: done.filediff.deletions,
            movePath: change.movePath,
          }
        }
        if (change.type === "move" && change.movePath) {
          const done = build(change.movePath, change.oldContent, change.final)
          return {
            filePath: change.filePath,
            relativePath: path.relative(instance.worktree, change.movePath).replaceAll("\\", "/"),
            type: change.type,
            patch: done.diff,
            additions: done.filediff.additions,
            deletions: done.filediff.deletions,
            movePath: change.movePath,
          }
        }
        if (change.type === "add") {
          const done = build(change.filePath, "", change.final)
          return {
            filePath: change.filePath,
            relativePath: path.relative(instance.worktree, change.filePath).replaceAll("\\", "/"),
            type: change.type,
            patch: done.diff,
            additions: done.filediff.additions,
            deletions: done.filediff.deletions,
            movePath: change.movePath,
          }
        }
        const done = build(change.filePath, change.oldContent, change.final)
        return {
          filePath: change.filePath,
          relativePath: path.relative(instance.worktree, change.filePath).replaceAll("\\", "/"),
          type: change.type,
          patch: done.diff,
          additions: done.filediff.additions,
          deletions: done.filediff.deletions,
          movePath: change.movePath,
        }
      })
      let totalDiff = ""
      for (const item of files) totalDiff += item.patch + "\n"
      // kilocode_change end

      // Publish file change events
      for (const update of updates) {
        yield* events.publish(Watcher.Event.Updated, update)
      }

      // Notify LSP of file changes and collect diagnostics
      for (const change of fileChanges) {
        if (change.type === "delete") continue
        const target = change.movePath ?? change.filePath
        yield* lsp.touchFile(target, "document")
      }
      const diagnostics = yield* lsp.diagnostics()

      // Generate output summary
      const summaryLines = fileChanges.map((change) => {
        if (change.type === "add") {
          return `A ${path.relative(instance.worktree, change.filePath).replaceAll("\\", "/")}`
        }
        if (change.type === "delete") {
          return `D ${path.relative(instance.worktree, change.filePath).replaceAll("\\", "/")}`
        }
        const target = change.movePath ?? change.filePath
        return `M ${path.relative(instance.worktree, target).replaceAll("\\", "/")}`
      })
      let output = `Success. Updated the following files:\n${summaryLines.join("\n")}`

      // kilocode_change start
      const changedPaths = fileChanges
        .filter((c) => c.type !== "delete")
        .map((c) => FSUtil.normalizePath(c.movePath ?? c.filePath))
      // kilocode_change end

      for (const change of fileChanges) {
        if (change.type === "delete") continue
        const target = change.movePath ?? change.filePath
        const block = LSP.Diagnostic.report(target, diagnostics[FSUtil.normalizePath(target)] ?? [])
        if (!block) continue
        const rel = path.relative(instance.worktree, target).replaceAll("\\", "/")
        output += `\n\nLSP errors detected in ${rel}, please fix:\n${block}`
      }

      // kilocode_change start - append Kilo config validation warnings
      for (const changed of fileChanges) {
        if (changed.type === "delete") continue
        output += yield* Effect.promise(() => ConfigValidation.check(changed.movePath ?? changed.filePath))
      }
      // kilocode_change end

      return {
        title: output,
        metadata: {
          diff: totalDiff,
          files,
          diagnostics: filterDiagnostics(diagnostics, changedPaths), // kilocode_change
        },
        output,
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
