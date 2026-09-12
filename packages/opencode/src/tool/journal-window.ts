import { Effect } from "effect"
import type { Snapshot } from "@/snapshot"
import type { SnapshotJournal } from "@/snapshot/journal"

// kilocode_change - shared worktree exclusive for journal writers.
// Lock order: edit per-file lock (outer) -> Snapshot worktree exclusive (inner);
// write/apply_patch take only the worktree exclusive. Permission ask, LSP
// diagnostics, and final metadata/config validation stay outside exclusive.
// The exclusive callback never calls public Snapshot.track/restore/revert/diff
// (outer Semaphore is not reentrant); writers need no raw capability.
// Writers must go through run/runScoped (never snap.exclusive directly in
// tools); a test guard asserts edit/write/apply_patch call JournalWindow and
// never snap.exclusive(.
export namespace JournalWindow {
  export interface Scope {
    // kilocode_change - synchronous note: call immediately after prepare
    // success in the same tick so an interrupt between prepare and note
    // cannot leak a prepared row. No Effect gap.
    readonly note: (id: string) => void
  }
  export const run = <A, E>(snap: Snapshot.Interface, work: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    snap.exclusive(() => work)
  // kilocode_change - interrupt-safe writer window. The whole window stays
  // interruptible (format/FS/write never uninterruptible): restore() re-enables
  // interruption for use(). Only the minimal interruption cleanup runs
  // uninterruptible via onInterrupt: fail still-prepared rows (best-effort
  // journal-only, no metadata/events/LSP/FS) before the exclusive releases.
  // Explicit failures never trigger onInterrupt so their existing
  // markFailed/failRows + metadata/event semantics are unchanged.
  // fail() is idempotent for already-failed rows and Conflicts on applied
  // rows, so blind fail-then-ignore is safe and never overwrites explicit errors.
  export const runScoped = <A, E>(
    snap: Snapshot.Interface,
    journal: Pick<SnapshotJournal.Interface, "fail">,
    use: (scope: Scope) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E> =>
    snap.exclusive(() =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const ids: string[] = []
          const scope: Scope = {
            note: (id: string) => {
              ids.push(id)
            },
          }
          return yield* restore(use(scope)).pipe(
            Effect.onInterrupt(() =>
              Effect.forEach(ids, (id) => Effect.exit(journal.fail({ id, error: "interrupted" })).pipe(Effect.asVoid), {
                discard: true,
              }).pipe(Effect.uninterruptible),
            ),
          )
        }),
      ),
    )
}
