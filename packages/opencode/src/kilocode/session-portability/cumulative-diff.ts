import fs from "node:fs/promises"
import { Effect } from "effect"
import { Snapshot } from "@/snapshot"
import { NotFoundError, Storage } from "@/storage/storage"
import { makeRuntime } from "@opencode-ai/core/effect/runtime"
import type { SessionID } from "@/session/schema"
import { isClaimedWriteError, storageFileForKey, writeExclusiveJson } from "@/storage/claimed-file"

export type PortableDiff = Snapshot.FileDiff & {
  after?: string
}

export const baseKey = (id: SessionID | string) => ["session_diff_base", String(id)]

function equal(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function starts(base: PortableDiff[], local: PortableDiff[]) {
  if (local.length < base.length) return false
  return base.every((diff, index) => equal(diff, local[index]))
}

function ends(base: PortableDiff[], local: PortableDiff[]) {
  if (base.length < local.length) return false
  const start = base.length - local.length
  return local.every((diff, index) => equal(diff, base[start + index]))
}

export function mergeSessionDiffs(input: { base: PortableDiff[]; local: PortableDiff[] }) {
  if (input.base.length === 0) return input.local
  if (input.local.length === 0) return input.base
  if (starts(input.base, input.local)) return input.local
  return [...input.base, ...input.local]
}

export function appendSessionDiffs(input: { existing: PortableDiff[]; next: PortableDiff[] }) {
  if (input.existing.length === 0) return input.next
  if (input.next.length === 0) return input.existing
  if (starts(input.existing, input.next)) return input.next
  if (starts(input.next, input.existing)) return input.existing
  if (ends(input.existing, input.next)) return input.existing
  return [...input.existing, ...input.next]
}

export function readSessionDiffBase(storage: Storage.Interface, id: SessionID | string) {
  return storage.read<PortableDiff[]>(baseKey(id)).pipe(
    Effect.catchIf(
      (err) => err instanceof NotFoundError || (err as unknown as { _tag?: string })?._tag === "NotFoundError",
      () => Effect.succeed([] as PortableDiff[]),
    ),
  )
}

export function cumulativeSessionDiff(storage: Storage.Interface, id: SessionID | string, local: PortableDiff[]) {
  return readSessionDiffBase(storage, id).pipe(Effect.map((base) => mergeSessionDiffs({ base, local })))
}

// Self-contained Storage runtime so shared callers (Session.fork) can carry fork diffs without taking a
// legacy Storage dependency in their layer. Mirrors the Database runtime pattern in session/session.ts.
const runtime = makeRuntime(Storage.Service, Storage.defaultLayer)

function isNotFound(err: unknown): boolean {
  return err instanceof NotFoundError || (err as unknown as { _tag?: string })?._tag === "NotFoundError"
}

/**
 * Carry a source session's cumulative diff base onto a freshly forked session, so imported/cumulative
 * diffs survive the fork. Returns a plain Effect with no Storage requirement.
 * Read failures other than NotFound and all write failures propagate as fork failure (fail-closed);
 * partial writes are cleaned up only for artifacts owned by this attempt (exclusive claim via wx);
 * cross-resource crash between FS write and DB commit remains an explicit unclaimed residual.
 */
export function carryForkDiff(sourceID: SessionID | string, targetID: SessionID | string): Effect.Effect<void> {
  return Effect.promise(() =>
    runtime.runPromise((storage) =>
      Effect.gen(function* () {
        const local = yield* storage.read<PortableDiff[]>(["session_diff", String(sourceID)]).pipe(
          Effect.catchIf(isNotFound, () => Effect.succeed([] as PortableDiff[])),
        )
        const base = yield* cumulativeSessionDiff(storage, sourceID, local)
        if (base.length === 0) return
        const firstKey = baseKey(targetID)
        const secondKey = ["session_diff", String(targetID)] as unknown as string[]
        // Deterministic failure injection for tests (uses global seam, no production effect)
        const seam = (() => {
          try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            return require("@/kilocode/session/fork-seam").ForkSeam as {
              failFirstDiffWrite: boolean
              failSecondDiffWrite: boolean
            }
          } catch {
            return { failFirstDiffWrite: false, failSecondDiffWrite: false }
          }
        })()
        let ownedFirst = false
        let ownedSecond = false
        yield* Effect.gen(function* () {
          if (seam.failFirstDiffWrite) return yield* Effect.fail(new Error("injected first diff write failure"))
          yield* Effect.promise(() => writeExclusiveJson(storageFileForKey(firstKey), base)).pipe(
            Effect.catch((e) => {
              if (isClaimedWriteError(e)) {
                ownedFirst = true
                const claimed = e as unknown as { handle: { cleanup: () => Promise<boolean> }; cause: unknown; target: string }
                const original = claimed.cause ?? e
                return Effect.promise(() => claimed.handle.cleanup()).pipe(
                  Effect.flatMap((ok) => {
                    if (ok) ownedFirst = false
                    else Effect.logWarning("carryForkDiff claimed first cleanup failed (retained)", { target: claimed.target, cause: String(original) })
                    return Effect.fail(original)
                  }),
                  Effect.catch(() => Effect.fail(original)),
                  Effect.catchDefect(() => Effect.fail(original)),
                )
              }
              return Effect.fail(e)
            }),
          )
          ownedFirst = true
          if (seam.failSecondDiffWrite) return yield* Effect.fail(new Error("injected second diff write failure"))
          yield* Effect.promise(() => writeExclusiveJson(storageFileForKey(secondKey), base)).pipe(
            Effect.catch((e) => {
              if (isClaimedWriteError(e)) {
                ownedSecond = true
                const claimed = e as unknown as { handle: { cleanup: () => Promise<boolean> }; cause: unknown; target: string }
                const original = claimed.cause ?? e
                return Effect.promise(() => claimed.handle.cleanup()).pipe(
                  Effect.flatMap((ok) => {
                    if (ok) ownedSecond = false
                    return Effect.fail(original)
                  }),
                  Effect.catch(() => Effect.fail(original)),
                  Effect.catchDefect(() => Effect.fail(original)),
                )
              }
              return Effect.fail(e)
            }),
          )
          ownedSecond = true
        }).pipe(
          Effect.catch((err: unknown) =>
            Effect.gen(function* () {
              // If err was already a claimed error that was handled above, owned flags already reflect cleanup; but we still need to handle partial ownedFirst cleanup for second failure
              if (isClaimedWriteError(err)) {
                const claimed = err as unknown as { handle: { cleanup: () => Promise<boolean> }; cause: unknown; target: string }
                const original = claimed.cause ?? err
                // This path is for unexpected claimed errors not already handled (e.g., second write claimed)
                const isSecond = claimed.target.includes(String(secondKey[1] ?? ""))
                if (isSecond) ownedSecond = true
                else ownedFirst = true
                const okClaimed = yield* Effect.promise(() => claimed.handle.cleanup()).pipe(
                  Effect.map((v) => v as boolean),
                  Effect.catch((e) => Effect.logWarning("carryForkDiff claimed cleanup failed", { target: claimed.target, cause: String(e) }).pipe(Effect.as(false as const))),
                  Effect.catchDefect((e) => Effect.logWarning("carryForkDiff claimed cleanup defect", { target: claimed.target, cause: String(e) }).pipe(Effect.as(false as const))),
                )
                if (okClaimed) {
                  if (isSecond) ownedSecond = false
                  else ownedFirst = false
                }
                // For second failure, also clean ownedFirst if any
                if (isSecond && ownedFirst) {
                  const ok = yield* Effect.promise(() => fs.rm(storageFileForKey(firstKey), { force: true })).pipe(
                    Effect.map(() => true as const),
                    Effect.catch((e) => Effect.logWarning("carryForkDiff cleanup first failed", { target: String(firstKey), cause: String(e) }).pipe(Effect.as(false as const))),
                    Effect.catchDefect((e) => Effect.logWarning("carryForkDiff cleanup first defect", { target: String(firstKey), cause: String(e) }).pipe(Effect.as(false as const))),
                  )
                  if (ok) ownedFirst = false
                }
                return yield* Effect.fail(original)
              }
              if (ownedFirst) {
                const ok = yield* Effect.promise(() => fs.rm(storageFileForKey(firstKey), { force: true })).pipe(
                  Effect.map(() => true as const),
                  Effect.catch((e) => Effect.logWarning("carryForkDiff cleanup first failed", { target: String(firstKey), cause: String(e) }).pipe(Effect.as(false as const))),
                  Effect.catchDefect((e) => Effect.logWarning("carryForkDiff cleanup first defect", { target: String(firstKey), cause: String(e) }).pipe(Effect.as(false as const))),
                )
                if (ok) ownedFirst = false
              }
              if (ownedSecond) {
                const ok = yield* Effect.promise(() => fs.rm(storageFileForKey(secondKey), { force: true })).pipe(
                  Effect.map(() => true as const),
                  Effect.catch((e) => Effect.logWarning("carryForkDiff cleanup second failed", { target: String(secondKey), cause: String(e) }).pipe(Effect.as(false as const))),
                  Effect.catchDefect((e) => Effect.logWarning("carryForkDiff cleanup second defect", { target: String(secondKey), cause: String(e) }).pipe(Effect.as(false as const))),
                )
                if (ok) ownedSecond = false
              }
              return yield* Effect.fail(err)
            }),
          ),
        )
      }),
    ),
  )
}
