import { Effect } from "effect"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Hash } from "@opencode-ai/core/util/hash"
import * as Log from "@opencode-ai/core/util/log"
import { SnapshotJournal } from "./journal"

// kilocode_change - Snapshot v2 bounded journal CAS executor for revert/unrevert.
// Runs only inside a caller-held Snapshot.exclusive window: it never takes the
// Snapshot lock and never calls public track/restore/revert/diff. It reads
// journal rows/blobs plus the filesystem, prechecks without writing, then
// applies per-step CAS writes with reverse-order CAS compensation. Journal
// capture rows are never mutated by undo/redo.

const log = Log.create({ service: "snapshot-journal-cas" })

export namespace SnapshotJournalCas {
  export type Direction = "undo" | "redo"

  export interface Segment {
    readonly applyOrder: readonly string[]
    readonly direction: Direction
  }

  export interface Input {
    readonly sessionID: string
    readonly worktree: string
    readonly segments: readonly Segment[]
  }

  export const MAX_STEPS = 2000

  const eqBytes = (a: Buffer | null, b: Buffer | null) => {
    if (a === null && b === null) return true
    if (a === null || b === null) return false
    return a.equals(b)
  }

  const failApply = (id: string, message: string, recovered: boolean) =>
    new SnapshotJournal.ApplyError({ id, message, recovered })

  interface Step {
    readonly id: string
    readonly rel: string
    readonly abs: string
    readonly expected: Buffer | null
    readonly next: Buffer | null
  }

  const readCurrent = (fs: FSUtil.Interface, abs: string) =>
    fs.readFile(abs).pipe(
      Effect.map((data) => Buffer.from(data as Uint8Array)),
      Effect.catch(() => Effect.succeed(undefined as Buffer | undefined)),
      Effect.catchDefect(() => Effect.succeed(undefined as Buffer | undefined)),
    )

    export const run = (input: Input) =>    Effect.gen(function* () {
      const journal = yield* SnapshotJournal.Service
      const fs = yield* FSUtil.Service
      const worktree = FSUtil.resolve(input.worktree)
      const flat: { id: string; direction: Direction }[] = []
      for (const seg of input.segments) {
        const ids = seg.direction === "redo" ? seg.applyOrder : [...seg.applyOrder].reverse()
        for (const id of ids) flat.push({ id, direction: seg.direction })
      }
      if (flat.length === 0) return
      if (flat.length > MAX_STEPS)
        return yield* new SnapshotJournal.Conflict({
          message: `journal cas batch too large: ${flat.length}`,
          id: flat[0]!.id,
          status: "applied",
        })

      // Bounded batch read: single load for all rows+blobs (chunked
      // internally under the SQLite variable limit). Per-step validation
      // order and error priority below are unchanged; missing rows still fail
      // on the first missing id in flat order, blob checks still fail per
      // step/side with the same Conflict wording.
      const facts = yield* journal.load(flat.map((item) => item.id)).pipe(
        Effect.catch((cause) => Effect.fail(cause as SnapshotJournal.DbError)),
        Effect.catchDefect((def) =>
          Effect.fail(new SnapshotJournal.DbError({ op: "cas-load", message: String(def) })),
        ),
      )
      const steps: Step[] = []
      for (const item of flat) {
        const row = facts.rows.get(item.id)
        if (!row)
          return yield* new SnapshotJournal.NotFound({ message: `journal mutation not found: ${item.id}`, id: item.id })
        if (row.status !== "applied")
          return yield* new SnapshotJournal.Conflict({
            message: `journal cas row not applied: ${item.id}`,
            id: row.id,
            status: row.status,
          })
        if (row.op === "move")
          return yield* new SnapshotJournal.Conflict({
            message: `journal cas legacy move refused: ${item.id}`,
            id: row.id,
            status: row.status,
          })
        if (row.session_id !== input.sessionID)
          return yield* new SnapshotJournal.Conflict({
            message: `journal cas scope mismatch: ${item.id}`,
            id: row.id,
            status: row.status,
          })
        if (FSUtil.resolve(row.worktree) !== worktree)
          return yield* new SnapshotJournal.Conflict({
            message: `journal cas worktree mismatch: ${item.id}`,
            id: row.id,
            status: row.status,
          })
        const abs = path.join(worktree, row.path)
        if (!FSUtil.contains(worktree, abs))
          return yield* new SnapshotJournal.PathError({
            message: `journal cas path escapes worktree: ${row.path}`,
            file: abs,
            worktree,
          })

        const resolveSide = function* (label: string, ref: string | null, hash: string | null, size: number | null) {
          if (ref === null && hash === null && size === null) return null as Buffer | null
          if (ref === null || hash === null || size === null)
            return yield* new SnapshotJournal.Conflict({
              message: `journal cas ${label} fact incomplete: ${row.id}`,
              id: row.id,
              status: row.status,
            })
          if (ref !== hash)
            return yield* new SnapshotJournal.Conflict({
              message: `journal cas ${label} blob/hash mismatch: ${row.id}`,
              id: row.id,
              status: row.status,
            })
          const bytes = facts.blobs.get(ref)
          if (!bytes)
            return yield* new SnapshotJournal.Conflict({
              message: `journal cas ${label} blob missing: ${row.id}`,
              id: row.id,
              status: row.status,
            })
          const buf = Buffer.from(bytes)
          if (buf.length !== size)
            return yield* new SnapshotJournal.Conflict({
              message: `journal cas ${label} size mismatch: ${row.id}`,
              id: row.id,
              status: row.status,
            })
          if (Hash.sha256(buf) !== hash)
            return yield* new SnapshotJournal.Conflict({
              message: `journal cas ${label} hash mismatch: ${row.id}`,
              id: row.id,
              status: row.status,
            })
          return buf as Buffer | null
        }

        const before: Buffer | null = yield* resolveSide("before", row.before_blob, row.before_hash, row.before_size)
        const after: Buffer | null = yield* resolveSide("after", row.after_blob, row.after_hash, row.after_size)
        const expected = item.direction === "undo" ? after : before
        const next = item.direction === "undo" ? before : after
        steps.push({ id: row.id, rel: row.path, abs, expected, next })
      }

      // Precheck: no writes. From actual disk state, simulate the global
      // sequence; first expected per path must match disk, later expected
      // must match the projected state (which enforces chain continuity).
      const disk = new Map<string, Buffer | null>()
      for (const step of steps) {
        if (disk.has(step.rel)) continue
        const cur = yield* readCurrent(fs, step.abs)
        disk.set(step.rel, cur ?? null)
      }
      const projected = new Map<string, Buffer | null>()
      for (const step of steps) {
        const cur = projected.has(step.rel) ? projected.get(step.rel)! : disk.get(step.rel)!
        if (!eqBytes(cur, step.expected)) {
          if (projected.has(step.rel)) {
            return yield* new SnapshotJournal.Conflict({
              message: `journal cas chain discontinuity at ${step.rel}`,
              id: step.id,
              status: "applied",
            })
          }
          log.warn("journal cas precheck drift, zero writes", { id: step.id, path: step.rel })
          return yield* failApply(step.id, `journal cas disk drift at ${step.rel}`, true)
        }
        projected.set(step.rel, step.next)
      }

      // Execute with per-step CAS; forward reads/writes/deletes stay
      // interruptible. On any mismatch/FS failure stop and compensate
      // completed steps in reverse with their own CAS guards. The
      // compensation body is uninterruptible, never calls raw restore, and
      // never overwrites/deletes data not equal to this batch's just-written
      // state. On fiber interrupt the same CAS-guarded minimal compensation
      // runs uninterruptibly before Snapshot.exclusive releases: the active
      // step is included only when current equals its just-written next,
      // treated as not effected when current equals expected, and otherwise
      // left untouched with unrecovered logged. Interruption still propagates
      // so the marker is never updated on interrupt.
      const done: Step[] = []
      const holder: { current?: Step } = {}
      const restoreOne = (prev: Step) =>
        Effect.gen(function* () {
          const cur = yield* readCurrent(fs, prev.abs)
          const current = cur ?? null
          if (!eqBytes(current, prev.next)) {
            log.warn("journal cas compensation refused: disk changed", { id: prev.id, path: prev.rel })
            return false
          }
          const undo: Effect.Effect<void, unknown> =
            prev.expected === null
              ? fs.remove(prev.abs).pipe(
                  Effect.catch(() => Effect.void),
                  Effect.catchDefect(() => Effect.void),
                )
              : fs.writeFile(prev.abs, prev.expected).pipe(Effect.asVoid)
          const out = yield* undo.pipe(Effect.exit)
          if (out._tag === "Failure") {
            log.warn("journal cas compensation failed", { id: prev.id, path: prev.rel })
            return false
          }
          if (prev.expected === null) {
            const gone = yield* fs.exists(prev.abs).pipe(Effect.orElseSucceed(() => true))
            if (gone) return false
          }
          return true
        })
      const compensate = (failedID: string, message: string) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            let recovered = true
            for (let i = done.length - 1; i >= 0; i--) {
              const ok = yield* restoreOne(done[i]!)
              if (!ok) recovered = false
            }
            return yield* failApply(failedID, message, recovered)
          }),
        )
      const compensateInterrupt = Effect.uninterruptible(
        Effect.gen(function* () {
          const active = holder.current
          const extra: Step[] = []
          let unknown = false
          if (active) {
            const cur = yield* readCurrent(fs, active.abs)
            const current = cur ?? null
            if (eqBytes(current, active.next)) extra.push(active)
            else if (!eqBytes(current, active.expected)) {
              log.warn("journal cas interrupt: active step unknown, refusing overwrite", {
                id: active.id,
                path: active.rel,
              })
              unknown = true
            }
          }
          const list = [...done, ...extra]
          let recovered = !unknown
          for (let i = list.length - 1; i >= 0; i--) {
            const ok = yield* restoreOne(list[i]!)
            if (!ok) recovered = false
          }
          if (!recovered) log.warn("journal cas interrupt compensation incomplete", { steps: list.length })
        }),
      )
      const execute = Effect.gen(function* () {
        for (const step of steps) {
          holder.current = step
          const cur = yield* readCurrent(fs, step.abs)
          const current = cur ?? null
          if (!eqBytes(current, step.expected)) {
            log.warn("journal cas execute drift, compensating", { id: step.id, path: step.rel })
            holder.current = undefined
            return yield* compensate(step.id, `journal cas disk drift at ${step.rel}`)
          }
          if (eqBytes(step.expected, step.next)) {
            holder.current = undefined
            continue
          }
          const op: Effect.Effect<void, unknown> =
            step.next === null
              ? fs.remove(step.abs).pipe(
                  Effect.asVoid,
                  Effect.catch(() => Effect.fail("io" as const)),
                )
              : Effect.gen(function* () {
                  yield* fs.ensureDir(path.dirname(step.abs))
                  yield* fs.writeFile(step.abs, step.next!)
                }).pipe(Effect.catch(() => Effect.fail("io" as const)))
          const out = yield* Effect.exit(op)
          if (out._tag === "Failure") {
            log.warn("journal cas write failed, compensating", { id: step.id, path: step.rel })
            holder.current = undefined
            return yield* compensate(step.id, `journal cas write failed at ${step.rel}`)
          }
          if (step.next === null) {
            const gone = yield* fs.exists(step.abs).pipe(Effect.orElseSucceed(() => true))
            if (gone) {
              log.warn("journal cas delete unverified, compensating", { id: step.id, path: step.rel })
              holder.current = undefined
              return yield* compensate(step.id, `journal cas delete failed at ${step.rel}`)
            }
          }
          done.push(step)
          holder.current = undefined
        }
      }).pipe(Effect.onInterrupt(() => compensateInterrupt))
      yield* Effect.uninterruptibleMask((restore) => restore(execute))
    }).pipe(
      Effect.catchTag("SnapshotJournalPathError", (err) => Effect.fail(err)),
      Effect.catchTag("SnapshotJournalConflict", (err) => Effect.fail(err)),
      Effect.catchTag("SnapshotJournalNotFound", (err) => Effect.fail(err)),
      Effect.catchTag("SnapshotJournalDbError", (err) => Effect.fail(err)),
      Effect.catchTag("SnapshotJournalApplyError", (err) => Effect.fail(err)),
    )
}
