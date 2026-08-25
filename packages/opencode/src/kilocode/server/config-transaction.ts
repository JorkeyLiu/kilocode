/**
 * Combined global+project config transaction coordinator (LOCK-002/003/005/006).
 *
 * One logical save = one backend mutation spanning both scopes:
 * prepare-before-write, atomic temp-file + rename commits under shared locks,
 * reverse-order compensation, and exactly one convergence obligation when any
 * changed field is cold.
 *
 * Lifecycle model: packages/kilo-docs/pages/contributing/architecture/cli-runtime.md#config-update-lifecycle;
 * withColdMutation owns the fence/pass, so this header only states local invariants.
 *
 * Local contract (transaction-specific only):
 * 1. Lock ordering (LOCK-001): the shared flock for the global target is
 *    acquired first, then the project target's flock inside it. Single-scope
 *    writes acquire only their own target's lock and never take
 *    project-then-global, so the global-first canonical order cannot deadlock.
 *    Hot transactions take config locks only, never a fence.
 * 2. Prepare both scopes in memory before the first write (LOCK-002): read the
 *    exact target content, apply the existing JSONC/merge/writable/schema
 *    behavior, validate, and produce `{path, existed, original, next, info,
 *    changed}` artifacts without writing, invalidating, disposing, or emitting.
 *    Targets are resolved under the locks, exactly once, so the locked key is
 *    always the written path.
 * 3. Semantic no-op (LOCK-005): when neither scope changed, nothing is
 *    persisted, no event is emitted, no convergence pass runs.
 * 4. Commit + response (LOCK-003): commit each prepared target atomically
 *    (temp-file + rename) while the shared locks are held, then construct the
 *    authoritative global/project/effective response while still inside the
 *    compensatable region. If the second commit OR the response construction
 *    fails, every committed target is restored exactly — deleting newly created
 *    targets — and the config caches are invalidated before the error
 *    propagates; a failed compensating rollback surfaces as the dedicated
 *    `ConfigRollbackFailed` structured error.
 * 5. Events (LOCK-003/004): ConfigUpdated publishes happen only after ALL
 *    targets committed AND the response was constructed, each carrying the same
 *    logical transaction id. No precommit or stale rollback events are ever
 *    emitted.
 * 6. Hot/cold (LOCK-005): an all-hot changed transaction persists without a
 *    convergence fence and without a rebuild; any changed cold transaction
 *    registers exactly one convergence obligation (global scope when a cold
 *    global change exists, project scope otherwise); a no-op registers none. A
 *    global cold change fences/rebuilds every loaded directory; a project-only
 *    cold change only its directory.
 * 7. Response contract (LOCK-006): the response carries the authoritative
 *    global config, the canonical project overlay (NOT effective config), and
 *    the effective config, computed after commit/rebuild registration and
 *    before generation drain. Every lock, fence, and temp file has ensuring
 *    cleanup on typed error, defect, interruption, and response construction
 *    failure.
 *
 * The only residual risk is a process crash between two atomic renames, which
 * a durable crash journal would close in a later phase; normal failures and
 * interruptions leave runtime and disk fully consistent.
 */

import { randomUUID } from "crypto"
import { Cause, Effect, Option, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import * as Log from "@opencode-ai/core/util/log"
import type { Config } from "@/config/config"
import { Config as ConfigService } from "@/config/config"
import { isHotPatch } from "@/kilocode/config/hot-keys"
import { KilocodeAtomicWrite } from "@/kilocode/config/atomic-write"
import { KilocodeConfig } from "@/kilocode/config/config"
import { KilocodeConfigOverlay } from "@/kilocode/config/overlay"
import { withColdMutation } from "@/kilocode/server/config-convergence"
import { configFailure } from "@/kilocode/server/config-failure"
import { InstanceRef } from "@/effect/instance-ref"

const log = Log.create({ service: "config-transaction" })

type ScopePatch = {
  set?: Record<string, unknown>
  unset?: readonly (readonly string[])[]
}

type TransactionInput = {
  global?: ScopePatch
  project?: ScopePatch
}

export type TransactionResult = {
  global: Config.Info
  project: Config.Info
  effective: Config.Info
}

/**
 * Dedicated structured error for a failed compensating rollback (LOCK-003).
 * A rollback failure is never silently swallowed: it surfaces as this tagged
 * error instead of the original commit failure.
 */
export class ConfigRollbackFailed extends Schema.TaggedErrorClass<ConfigRollbackFailed>()("ConfigRollbackFailed", {
  detail: Schema.String,
  cause: Schema.String,
}) {}

/** A prepared artifact plus its scope, tracked for commit/rollback. */
type ScopeTarget = {
  scope: "global" | "project"
  artifact: Config.PreparedConfig
}

/**
 * Convert a scope patch to a Config.Info patch using the same logic as the overlay.
 */
function scopeToPatch(input: ScopePatch | undefined): Config.Info {
  if (!input) return {} as Config.Info
  return KilocodeConfigOverlay.patch({
    scope: "project", // scope field is ignored for patch computation
    set: input.set,
    unset: input.unset?.map((item) => [...item]),
  })
}

/**
 * Read the authoritative project overlay for the response (LOCK-006: the
 * `project` field is the canonical overlay, NOT effective config).
 */
function readProjectOverlay(directory: string, worktree?: string): Effect.Effect<Config.Info> {
  return Effect.promise(() => KilocodeConfigOverlay.project({ directory, worktree }))
}

/**
 * Restore a committed target to its exact pre-transaction state (LOCK-003):
 * write the original content back atomically, or delete a newly created
 * target. Deletion tolerates an already-missing file; every other failure
 * surfaces as a rollback failure.
 */
const restoreTarget = (fs: FSUtil.Interface, artifact: Config.PreparedConfig) =>
  artifact.original === undefined
    ? fs.remove(artifact.path).pipe(
        Effect.catchIf((error) => error.reason._tag === "NotFound", () => Effect.void),
        Effect.orDie,
      )
    : KilocodeAtomicWrite.write(fs, artifact.path, artifact.original)

/**
 * Execute a combined global+project config transaction.
 *
 * Locking: the shared flock for the global target is acquired first, then the
 * project target's flock is acquired inside it. Single-scope writes acquire
 * only their own target's lock and never take project-then-global, so the
 * global-first canonical order cannot deadlock (LOCK-001).
 */
export const executeTransaction = Effect.fn("ConfigTransaction.execute")(
  function* (input: TransactionInput) {
    const config = yield* ConfigService.Service
    const fs = yield* FSUtil.Service
    const ref = yield* InstanceRef

    const globalPatch = scopeToPatch(input.global)
    const projectPatch = scopeToPatch(input.project)
    const hasGlobalPatch = Object.keys(globalPatch).length > 0
    const hasProjectPatch = Object.keys(projectPatch).length > 0
    if (hasProjectPatch && !ref) {
      return yield* Effect.die(new Error("project config patch requires an instance context"))
    }

    // Classify the combined mutation once (LOCK-005).
    const globalHot = hasGlobalPatch ? isHotPatch(globalPatch as Record<string, unknown>) : true
    const projectHot = hasProjectPatch ? isHotPatch(projectPatch as Record<string, unknown>) : true
    const allHot = globalHot && projectHot
    const transactionID = randomUUID()

    const projectOverlay = ref ? readProjectOverlay(ref.directory, ref.worktree) : Effect.succeed({} as Config.Info)

    const readResponse = Effect.gen(function* () {
      return {
        global: yield* config.getGlobal(),
        project: yield* projectOverlay,
        effective: yield* config.get(),
      }
    })

    // LOCK-001: the discovery locks are the canonical serialization for each
    // config domain — one key per global domain and one per project
    // directory/worktree, independent of the eventual target file. They are
    // acquired BEFORE target resolution, and the targets are resolved exactly
    // once under them; prepare/commit use those exact resolved paths, so the
    // locked key is always the written path and a concurrent
    // higher-precedence file creation can never make the save invisible.

    // Targets committed so far in this transaction, for compensating rollback.
    const committed: Config.PreparedConfig[] = []

    /** Restore every committed target exactly, then invalidate caches. */
    const rollbackCommitted = Effect.gen(function* () {
      let first: Cause.Cause<unknown> | undefined
      yield* Effect.forEach(
        [...committed].reverse(),
        (artifact) =>
          Effect.exit(restoreTarget(fs, artifact)).pipe(
            Effect.flatMap((exit) => {
              if (exit._tag === "Failure") first ??= exit.cause
              return Effect.void
            }),
          ),
        { discard: true },
      )
      // Restore/invalidate caches so in-memory config reflects the restored
      // disk state (LOCK-003).
      yield* config.invalidate()
      yield* config.invalidateProject()
      if (first) {
        const detail = "compensating rollback of a committed config target failed"
        log.error(detail, { cause: String(first) })
        return yield* Effect.fail(new ConfigRollbackFailed({ detail, cause: String(first) }))
      }
    })

    /**
     * Commit all prepared targets atomically while the shared locks are held.
     * On any commit failure every already-committed target is restored before
     * the original cause propagates. LOCK-003: the authoritative response is
     * constructed BEFORE any final event is emitted — a read/response failure
     * restores every target, invalidates caches, emits nothing, and (via
     * withColdMutation) releases the fence. The ConfigUpdated publishes are
     * DEFERRED (LOCK-002/003/004): the caller emits them only after all targets
     * committed, the response succeeded, and the convergence rebuild
     * registration owns the fence, each tagged with the logical transaction id.
     */
    const commitAll = (targets: ScopeTarget[]) =>
      Effect.gen(function* () {
        for (const target of targets) {
          const exit =
            target.scope === "global"
              ? yield* Effect.exit(config.commitGlobal(target.artifact, { dispose: !allHot, emit: false }))
              : yield* Effect.exit(config.commit(target.artifact, { emit: false }))
          if (exit._tag === "Failure") {
            yield* rollbackCommitted
            return yield* Effect.failCause(exit.cause)
          }
          committed.push(target.artifact)
        }
        const response = yield* Effect.exit(readResponse)
        if (response._tag === "Failure") {
          yield* rollbackCommitted
          return yield* Effect.failCause(response.cause)
        }
        return response.value
      })

    /** Deferred final ConfigUpdated publishes, one per committed scope (LOCK-004). */
    const emitTargets = (targets: ScopeTarget[]) =>
      Effect.forEach(
        targets,
        (target) => config.emitUpdated(target.scope === "global" ? "global" : ref!.directory, transactionID),
        { discard: true },
      )

    /**
     * Prepare both scopes and classify the result (LOCK-002/005): validation
     * failures surface here — nothing has been persisted, invalidated,
     * disposed, or emitted (`configFailure` maps ConfigInvalidError defects to
     * the typed 400 the route declares). Semantic no-op comes from the
     * prepared artifacts — no persistence, no events, no convergence pass, no
     * rebuild. Runs under the canonical acquisition order (convergence fence
     * first for cold, then the deterministic global→project flocks), so the
     * no-op/recheck decision is never racy with a concurrent writer.
     */
    const run = Effect.gen(function* () {
      // LOCK-001: targets are resolved under the discovery locks — never
      // before them — so discovery and the write are one stable decision.
      const globalTargetFile = KilocodeConfig.globalConfigTarget()
      const projectTargetFile = hasProjectPatch
        ? yield* KilocodeConfig.projectConfigUpdateTarget({
            fs,
            directory: ref!.directory,
            worktree: ref!.worktree,
          })
        : undefined
      const globalTarget: ScopeTarget | undefined = hasGlobalPatch
        ? { scope: "global", artifact: yield* configFailure(config.prepareGlobal(globalPatch, { file: globalTargetFile })) }
        : undefined
      const projectTarget: ScopeTarget | undefined = hasProjectPatch
        ? { scope: "project", artifact: yield* configFailure(config.prepare(projectPatch, { file: projectTargetFile })) }
        : undefined
      const changed = (globalTarget?.artifact.changed ?? false) || (projectTarget?.artifact.changed ?? false)
      if (!changed) return { changed: false as const, value: yield* readResponse, targets: [] as ScopeTarget[] }
      const targets = [globalTarget, projectTarget].filter((t): t is ScopeTarget => t !== undefined)
      return { changed: true as const, value: yield* commitAll(targets), targets }
    })

    // LOCK-001: canonical cold acquisition order — the ConfigConvergence fence
    // is raised FIRST (via withColdMutation), then the deterministic
    // global→project discovery flocks. The legacy cold overlay/config/global
    // paths share this order, so no cold path ever waits for the gate while
    // holding a config lock. Hot transactions take discovery locks only, never
    // a fence. A semantic no-op returns `changed: false`, so withColdMutation
    // aborts the fence and no rebuild is registered. Lock failures are defects
    // (mapped inside the Config service), so the only typed failure channel is
    // the declared 400; a failed compensating rollback surfaces as the
    // ConfigRollbackFailed defect.
    //
    // LOCK-005 scope: a cold transaction with any cold GLOBAL change fences and
    // rebuilds every loaded directory (a global cold patch present), exactly
    // like the legacy global paths; a project-only cold transaction fences and
    // rebuilds only its directory.
    const discoveryProjectKey = hasProjectPatch
      ? KilocodeConfig.configDiscoveryProjectKey(ref!.directory, ref!.worktree)
      : undefined
    const globalCold = hasGlobalPatch ? !globalHot : false
    // LOCK-002/003/004: the ConfigUpdated publishes are DEFERRED after the
    // response. Hot transactions emit immediately under the discovery locks
    // (hot semantics unchanged — no fence, no rebuild); cold transactions hand
    // the deferred event to withColdMutation, which publishes it only after
    // commit synchronously registered the convergence rebuild.
    const outcome = allHot
      ? config
          .withLock(
            KilocodeConfig.configDiscoveryGlobalKey(),
            discoveryProjectKey ? config.withLock(discoveryProjectKey, run) : run,
          )
          .pipe(
            Effect.flatMap((result) =>
              result.changed ? emitTargets(result.targets).pipe(Effect.as(result.value)) : Effect.succeed(result.value),
            ),
          )
      : withColdMutation({
          scope: globalCold ? "global" : { directory: ref!.directory },
          run: () =>
            config
              .withLock(
                KilocodeConfig.configDiscoveryGlobalKey(),
                discoveryProjectKey ? config.withLock(discoveryProjectKey, run) : run,
              )
              .pipe(
                Effect.map((result) => ({
                  changed: result.changed,
                  value: result.value,
                  event: result.changed ? emitTargets(result.targets) : undefined,
                })),
              ),
        })

    return yield* outcome.pipe(Effect.catchTag("ConfigRollbackFailed", (error) => Effect.die(error)))
  },
)

export * as ConfigTransaction from "./config-transaction"
