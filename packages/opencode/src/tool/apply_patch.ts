import * as path from "path"
import { Cause, Effect, Schema } from "effect"
import * as Tool from "./tool"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { InstanceState } from "@/effect/instance-state"
import { Patch } from "../patch"
import { assertExternalDirectoryEffect } from "./external-directory"
import { build } from "./filediff" // kilocode_change - shared formatter-final diff builder
import { FormatTarget } from "./format-target" // kilocode_change - formatter single-target regular-readable guard
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import DESCRIPTION from "./apply_patch.txt"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { filterDiagnostics } from "./diagnostics" // kilocode_change
import { ConfigValidation } from "../kilocode/config-validation" // kilocode_change
import * as EncodedIO from "../kilocode/tool/encoded-io" // kilocode_change
import { Format } from "../format"
import { SnapshotJournal } from "@/snapshot/journal" // kilocode_change - Snapshot v2 durable mutation journal
import { Snapshot } from "@/snapshot" // kilocode_change - shared worktree exclusive with revert
import { JournalWindow } from "./journal-window" // kilocode_change - shared worktree exclusive for writers
import { WriteCas } from "./write-cas" // kilocode_change - write-anchored external drift guard
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
    // kilocode_change - Snapshot v2 journal is required: ToolRegistry provides the canonical instance.
    const journal = yield* SnapshotJournal.Service
    const snap = yield* Snapshot.Service // kilocode_change - shared worktree exclusive with revert

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
        beforeBytes: Buffer | null // kilocode_change - Snapshot v2 journal before image, captured pre-write
        targetBefore?: Buffer | null // kilocode_change - move target prior (accurate overwrite baseline)
        targetEncoding?: string // kilocode_change - move target prior encoding
        targetBom?: boolean // kilocode_change - move target prior BOM
        targetExists?: boolean // kilocode_change - move target existence at validation
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
            // kilocode_change start - Snapshot v2 journal before image (existing bytes when overwriting)
            // Add-overwrite preserves the existing file encoding: decode prior
            // via EncodedIO.read and reuse its encoding for write/sync/journal
            // so legacy bytes are never re-encoded as UTF-8 (mojibake).
            const priorRead = (yield* afs.existsSafe(filePath))
              ? ((yield* EncodedIO.read(afs, filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))))
              : undefined
            const prior = priorRead?.bytes ?? null
            const priorEncoding = priorRead?.encoding
            // Align with write/edit desiredBom: a utf-8-bom prior keeps its
            // BOM even when the patch carries none; otherwise the patch
            // content (next.bom) decides. New files have no prior, so this
            // reduces to next.bom and their behavior is unchanged.
            const bom = priorEncoding === "utf-8-bom" || next.bom
            // kilocode_change end

            fileChanges.push({
              filePath,
              oldContent,
              newContent: next.text,
              final: next.text,
              type: "add",
              diff: ask.diff,
              additions: ask.filediff.additions,
              deletions: ask.filediff.deletions,
              bom, // kilocode_change - utf-8-bom prior preserved, else patch BOM; new files use patch BOM
              encoding: priorEncoding ?? "utf-8", // kilocode_change - new files default to utf-8, overwrites keep prior encoding
              beforeBytes: prior, // kilocode_change
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

            // kilocode_change start - move target prior is captured pre-write so the
            // target add/update fact preserves an accurate baseline when overwriting.
            let targetBefore: Buffer | null | undefined
            let targetEncoding: string | undefined
            let targetBom: boolean | undefined
            let targetExists: boolean | undefined
            if (movePath) {
              const targetHit = yield* afs.existsSafe(movePath)
              targetExists = targetHit
              if (targetHit) {
                const targetRead = yield* EncodedIO.read(afs, movePath).pipe(
                  Effect.catch((error) =>
                    Effect.fail(
                      new Error(
                        `apply_patch verification failed: ${error instanceof Error ? error.message : String(error)}`,
                      ),
                    ),
                  ),
                )
                targetBefore = targetRead.bytes
                targetEncoding = targetRead.encoding
                targetBom = targetRead.encoding === "utf-8-bom"
              } else {
                targetBefore = null
              }
            }
            // kilocode_change end

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
              beforeBytes: read.bytes, // kilocode_change - Snapshot v2 journal before image
              targetBefore,
              targetEncoding,
              targetBom,
              targetExists,
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
              beforeBytes: deleteRead.bytes, // kilocode_change - Snapshot v2 journal before image
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

      // kilocode_change start - Snapshot v2 journal: each file change runs its own
      // prepare -> write/format/sync -> apply in item order. Move is two prepared
      // facts (source delete + target add/update) created before any write of that
      // hunk; target write/format/sync/apply runs before source remove/apply.
      // A mid-batch failure keeps applied rows, fails current prepared rows, writes
      // nothing further, publishes the applied prefix (Watcher + LSP), and carries
      // the prefix formatter-final files/totalDiff plus journal ids in running metadata.
      // New tools never write a single-row op=move (schema keeps it for compat).
      const journalIDs: string[] = []
      const buildResultFiles = (changes: typeof fileChanges) =>
        changes.map((change) => {
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
      const prefixDiffOf = (prefix: ReturnType<typeof buildResultFiles>) => {
        let out = ""
        for (const item of prefix) out += item.patch + "\n"
        return out
      }
      const failRows = (ids: string[], message: string) =>
        Effect.forEach(ids, (id) => journal.fail({ id, error: message }).pipe(Effect.ignore), {
          concurrency: 1,
        }).pipe(Effect.ignore)
      const emitBatchFailure = (cause: unknown, doneCount: number, includeCurrent: boolean) =>
        Effect.gen(function* () {
          // Caller already failed its prepared rows; carry the honest applied prefix.
          // Watcher/LSP publishes happen outside the worktree exclusive.
          const end = includeCurrent ? doneCount + 1 : doneCount
          const prefix = buildResultFiles(fileChanges.slice(0, end))
          const totalPrefix = prefixDiffOf(prefix)
          progress.end = end
          yield* ctx
            .metadata({ metadata: { journal: { coverage: "failed", ids: [...journalIDs] }, diff: totalPrefix, files: prefix } })
            .pipe(Effect.ignore)
          return yield* Effect.failCause(cause as never)
        })
      const progress = { done: 0, end: 0 }
      // kilocode_change - batch window is interrupt-safe: every prepared id is
      // noted synchronously for runScoped's uninterruptible journal-only
      // finalizer; explicit failures keep their failRows/metadata semantics.
      const batch = (scope: JournalWindow.Scope) =>
        Effect.gen(function* () {
        let item = 0
        let done = 0
        // kilocode_change - write-anchored CAS: batch-sequential expected state so
        // the batch's own prefix never misreads as external drift.
        const expected = new Map<string, Buffer | null>()
        const want = (file: string, base: Buffer | null): Buffer | null => {
          const hit = expected.get(file)
          if (hit !== undefined) return hit
          return base
        }
        const guard = (file: string, base: Buffer | null) =>
          Effect.gen(function* () {
            const ok = yield* WriteCas.match(afs, file, want(file, base))
            if (!ok) yield* Effect.fail(WriteCas.error(file))
          })
      for (const change of fileChanges) {
        if (change.type === "move" && change.movePath) {
          // Dual-fact move: both prepares before any write of this hunk.
          const moveTarget = change.movePath
          const targetOp = change.targetExists ? "update" : "add"
          const prepared: string[] = []
          let srcID: string | undefined
          let tgtID: string | undefined
          const exit = yield* Effect.gen(function* () {
            // kilocode_change - pre-prepare CAS on both paths; drift aborts with no rows.
            yield* guard(moveTarget, change.targetBefore ?? null)
            yield* guard(change.filePath, change.beforeBytes)
            // Target sub 0 first, source sub 1 second; ids order matches list order.
            const tgt = yield* journal.prepare({
              sessionID: ctx.sessionID,
              messageID: ctx.messageID,
              callID: ctx.callID,
              tool: "apply_patch",
              item,
              sub: 0,
              directory: instance.directory,
              worktree: instance.worktree,
              path: moveTarget,
              op: targetOp,
              before: change.targetBefore ?? null,
              encoding: change.targetEncoding ?? change.encoding,
              bom: change.targetBom ?? change.bom,
            })
            scope.note(tgt.row.id)
            journalIDs.push(tgt.row.id)
            prepared.push(tgt.row.id)
            const src = yield* journal.prepare({
              sessionID: ctx.sessionID,
              messageID: ctx.messageID,
              callID: ctx.callID,
              tool: "apply_patch",
              item,
              sub: 1,
              directory: instance.directory,
              worktree: instance.worktree,
              path: change.filePath,
              op: "delete",
              before: change.beforeBytes,
              encoding: change.encoding,
              bom: change.bom,
            })
            scope.note(src.row.id)
            journalIDs.push(src.row.id)
            prepared.push(src.row.id)
            return { src, tgt }
          }).pipe(Effect.exit)
          if (exit._tag === "Failure") {
            yield* failRows(prepared, Cause.pretty(exit.cause as never))
            progress.done = done
            progress.end = done
            yield* ctx.metadata({ metadata: { journal: { coverage: "failed", ids: [...journalIDs] } } }).pipe(Effect.ignore)
            return yield* Effect.failCause(exit.cause)
          }
          srcID = exit.value.src.row.id
          tgtID = exit.value.tgt.row.id
          yield* ctx.metadata({ metadata: { journal: { coverage: "partial", ids: [...journalIDs] } } })
          const settleExit = yield* Effect.gen(function* () {
            // kilocode_change - re-check both paths before any write/remove of this hunk.
            yield* guard(moveTarget, change.targetBefore ?? null)
            yield* guard(change.filePath, change.beforeBytes)
            // Target first, then source — matches historic write order.
            yield* EncodedIO.write(afs, moveTarget, Bom.join(change.newContent, change.bom), change.encoding)
            if (yield* format.file(moveTarget)) {
              yield* FormatTarget.check(afs, moveTarget) // kilocode_change - move validates formatter target only
              change.final = yield* EncodedIO.sync(afs, moveTarget, change.bom, change.encoding)
            }
            yield* events.publish(FileSystem.Event.Edited, { file: moveTarget })
            if (tgtID) {
              const afterTarget = Buffer.from(yield* afs.readFile(moveTarget))
              yield* journal.apply({
                id: tgtID,
                after: afterTarget,
                encoding: change.encoding,
                bom: change.bom,
                beforeFallback: change.targetBefore ?? null,
              })
            }
            updates.push({ file: moveTarget, event: change.targetExists ? "change" : "add" })
            yield* afs.remove(change.filePath)
            updates.push({ file: change.filePath, event: "unlink" })
            if (srcID) {
              yield* journal.apply({
                id: srcID,
                after: null,
                encoding: change.encoding,
                bom: change.bom,
                beforeFallback: change.beforeBytes,
              })
            }
            // kilocode_change - project batch-sequential expected state on success.
            const landed = Buffer.from(yield* afs.readFile(moveTarget))
            expected.set(moveTarget, landed)
            expected.set(change.filePath, null)
          }).pipe(Effect.exit)
          if (settleExit._tag === "Failure") {
            const message = Cause.pretty(settleExit.cause as never)
            // Blind bilateral fail: prepared atomically fails, failed is
            // idempotent, applied surfaces Conflict which is ignored here to
            // keep the applied fact honest. No extra get inside the window.
            const targetLanded = updates.some((u) => u.file === moveTarget)
            if (!targetLanded && tgtID) yield* journal.fail({ id: tgtID, error: message }).pipe(Effect.ignore)
            if (srcID) yield* journal.fail({ id: srcID, error: message }).pipe(Effect.ignore)
            return yield* emitBatchFailure(settleExit.cause, done, targetLanded)
          }
          done += 1
          progress.done = done
          item += 1
          continue
        }
        // kilocode_change - pre-prepare CAS; drift aborts with no row, prefix stays applied.
        const prepExit = yield* Effect.gen(function* () {
          yield* guard(change.filePath, change.beforeBytes)
          return yield* journal.prepare({
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            callID: ctx.callID,
            tool: "apply_patch",
            item,
            sub: 0,
            directory: instance.directory,
            worktree: instance.worktree,
            path: change.filePath,
            op: change.type as "add" | "update" | "delete",
            before: change.beforeBytes,
            encoding: change.encoding,
            bom: change.bom,
          })
        }).pipe(Effect.exit)
        if (prepExit._tag === "Failure") {
          progress.done = done
          progress.end = done
          yield* ctx.metadata({ metadata: { journal: { coverage: "failed", ids: [...journalIDs] } } }).pipe(Effect.ignore)
          return yield* Effect.failCause(prepExit.cause)
        }
        const noted = prepExit.value
        scope.note(noted.row.id)
        journalIDs.push(noted.row.id)
        yield* ctx.metadata({ metadata: { journal: { coverage: "partial", ids: [...journalIDs] } } })

        const settle = Effect.gen(function* () {
          // kilocode_change - re-check before any write/remove; drift fails the prepared row.
          yield* guard(change.filePath, change.beforeBytes)
          const edited = change.type === "delete" ? undefined : change.filePath
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

            case "delete":
              yield* afs.remove(change.filePath)
              updates.push({ file: change.filePath, event: "unlink" })
              break
          }

          // kilocode_change start - capture formatter-final disk truth per file
          if (edited) {
            if (yield* format.file(edited)) {
              yield* FormatTarget.check(afs, edited) // kilocode_change - fail closed before sync/apply
              change.final = yield* EncodedIO.sync(afs, edited, change.bom, change.encoding)
            }
            yield* events.publish(FileSystem.Event.Edited, { file: edited })
          }
          const after = edited ? Buffer.from(yield* afs.readFile(edited)) : null
            yield* journal.apply({
              id: noted.row.id,
              after,
              encoding: change.encoding,
              bom: change.bom,
              beforeFallback: change.beforeBytes,
            })
            // kilocode_change - project batch-sequential expected state on success.
            expected.set(change.filePath, after)
        })
        const exit = yield* settle.pipe(Effect.exit)
        if (exit._tag === "Failure") {
          const message = Cause.pretty(exit.cause)
            yield* journal.fail({ id: noted.row.id, error: message }).pipe(Effect.ignore)
          return yield* emitBatchFailure(exit.cause, done, false)
        }
        done += 1
        progress.done = done
        item += 1
      }
      progress.done = done
        })
      // kilocode_change - whole batch holds one worktree exclusive; ask/LSP/validation stay outside.
      // Failure journal.fail already completed inside before release; prefix publishes happen below.
      // Interruption after any prepare closes still-prepared rows via runScoped's
      // uninterruptible journal-only finalizer before release.
      const batchExit = yield* JournalWindow.runScoped(snap, journal, (scope) => batch(scope)).pipe(Effect.exit)
      if (batchExit._tag === "Failure") {
        for (const update of updates) yield* events.publish(Watcher.Event.Updated, update).pipe(Effect.ignore)
        for (const prior of fileChanges.slice(0, progress.end || progress.done)) {
          if (prior.type === "delete") continue
          yield* lsp.touchFile(prior.movePath ?? prior.filePath, "document").pipe(Effect.ignore)
        }
        return yield* Effect.failCause(batchExit.cause)
      }
      // kilocode_change end

      // kilocode_change start - rebuild result metadata from formatter-final truth.
      // Move keeps the single-entry protocol but its patch header points at the
      // final target; source deletion is expressed by filePath + unlink event.
      const files = buildResultFiles(fileChanges)
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
          journal: { coverage: "full", ids: journalIDs }, // kilocode_change - success alone is full
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
