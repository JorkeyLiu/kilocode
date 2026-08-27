/**
 * Canonical provider-auth mutation coordinator (LOCK-002/003/004).
 *
 * Every provider-auth mutation — root auth set/remove, provider OAuth callback,
 * Anaconda Desktop sync — routes through `invalidateAfterProviderAuthChange`,
 * which runs the caller's persistence step under one cold-config convergence
 * fence so no generation can observe a partially-applied auth change.
 *
 * Lifecycle model: packages/kilo-docs/pages/contributing/architecture/cli-runtime.md#config-update-lifecycle;
 * withColdMutation owns the fence/pass (and the deferred ConfigUpdated event), so this header only states local invariants.
 *
 * Local contract (auth-specific only):
 * 1. Snapshot first (LOCK-004): capture the exact auth-file artifact (bytes +
 *    mode) BEFORE the mutation, so any post-capture failure — mutation or
 *    cleanup commit — can restore it.
 * 2. Read-then-write (LOCK-002): callers that derive a new credential from the
 *    CURRENT auth record (e.g. the organization switch) must perform the read
 *    inside `mutate`, immediately before the write, so a concurrent newer
 *    credential is never overwritten by a pre-fence snapshot.
 * 3. Optional disabled_providers cleanup (LOCK-003, root auth set + OAuth
 *    callback only): prepare/commit removal of `providerID` from the global
 *    `disabled_providers` list under the same fence and the canonical global
 *    discovery lock, with emit:false; unrelated IDs are preserved. A single
 *    deferred ConfigUpdated event (cleanup only) is returned and published only
 *    after the obligation commit registered the rebuild. Auth remove/Anaconda/
 *    org callers do not request cleanup.
 * 4. Failure semantics (LOCK-004): a snapshot failure aborts the fence and
 *    propagates — no mutation, no success claim. ANY failure after the snapshot
 *    was captured (including one that persisted part of the mutation) restores
 *    the exact auth artifact AND every committed config target, then
 *    invalidates config caches, before the fence aborts. A failed compensation
 *    surfaces as ConfigRollbackFailed carrying both the primary and the
 *    rollback detail.
 *
 * Returns `true` after persistence + rebuild registration, before generation
 * drain.
 */

import { randomUUID } from "crypto"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { KilocodeConfig } from "@/kilocode/config/config"
import { Cause, Effect, Option } from "effect"
import { ConfigRollbackFailed } from "./config-transaction"
import { restoreTarget } from "./config-rollback"
import { withColdMutation } from "./config-convergence"

/**
 * LOCK-003: prepare/commit removal of `providerID` from the global
 * `disabled_providers` list under the canonical global discovery lock, with
 * emit:false. Returns the committed `PreparedConfig` artifact immediately after
 * commit (so the coordinator can compensate it exactly on any later failure)
 * plus the deferred ConfigUpdated event when the config actually changed, or
 * `{}` when the target was not disabled / the config did not change (the auth
 * mutation itself still counts as the change). Failures surface as defects so
 * the endpoint contracts (authSet BadRequest, callback ProviderAuthApiError)
 * are unchanged — the coordinator compensates the exact auth/config before the
 * defect propagates.
 */
const cleanupDisabled = (
  config: Config.Interface,
  fs: FSUtil.Interface,
  providerID: string,
): Effect.Effect<
  { artifact?: Config.PreparedConfig; event?: Effect.Effect<void, never, never> },
  never,
  never
> =>
  config.withLock(
    KilocodeConfig.configDiscoveryGlobalKey(),
    Effect.gen(function* () {
      const globalTarget = KilocodeConfig.globalConfigTarget()
      const current = yield* config.getGlobal()
      const disabled = current.disabled_providers ?? []
      if (!disabled.includes(providerID)) return {}
      const artifact = yield* config.prepareGlobal(
        { disabled_providers: disabled.filter((item) => item !== providerID) } as Config.Info,
        { file: globalTarget },
      )
      if (!artifact.changed) return {}
      yield* config.commitGlobal(artifact, { emit: false })
      return { artifact, event: config.emitUpdated("global", randomUUID()) }
    }),
  )

/**
 * Mutate provider auth and invalidate the runtime under one canonical global
 * convergence fence (LOCK-001/002/003). `mutate` is the caller's persistence
 * step (auth set/remove, OAuth callback, Anaconda auth sync); it runs under
 * the fence so no generation can observe a partially-applied auth change.
 *
 * LOCK-002: callers that derive a new credential from the CURRENT auth record
 * (e.g. the organization switch) must perform the read inside `mutate`,
 * immediately before the write, so a concurrent newer credential is never
 * overwritten by a pre-fence snapshot.
 *
 * LOCK-003: when `options.cleanupDisabled` is set (root auth set and OAuth
 * callback only), the coordinator additionally removes `providerID` from the
 * global `disabled_providers` list under the same fence and the canonical
 * global discovery lock — one backend mutation with exactly one rebuild. The
 * config is prepared/committed with emit:false; any commit/auth failure
 * compensates the exact auth artifact and every committed config target before
 * the fence aborts. A single deferred ConfigUpdated event is returned and
 * published only after the obligation commit registered the rebuild. Auth
 * remove/Anaconda/org callers do not request cleanup.
 *
 * Returns `true` after persistence + rebuild registration, before generation
 * drain.
 */
export const invalidateAfterProviderAuthChange = <E, R>(
  providerID: string,
  mutate: Effect.Effect<unknown, E, R>,
  options?: { cleanupDisabled?: boolean },
): Effect.Effect<true, E, R | FSUtil.Service> =>
  Effect.fn("KiloServer.invalidateAfterProviderAuthChange")(function* (
    providerID: string,
    mutate: Effect.Effect<unknown, E, R>,
    options?: { cleanupDisabled?: boolean },
  ) {
    // kilocode_change - LOCK-003: Config.Service is required only when a caller
    // requests disabled_providers cleanup; Anaconda/org/auth-remove callers
    // stay free of the dependency (serviceOption adds no env requirement).
    const config = Option.getOrElse(yield* Effect.serviceOption(Config.Service), () => undefined)
    const fs = yield* FSUtil.Service

    return yield* withColdMutation({
      scope: "global",
      run: () =>
        Effect.gen(function* () {
          const snap = yield* Auth.snapshotFile(fs).pipe(Effect.orDie)
          // LOCK-003: committed config targets from the disabled-provider
          // cleanup, restored by compensation on any later failure.
          const committed: Config.PreparedConfig[] = []
          let cleanupEvent: Effect.Effect<void, never, never> | undefined

          // LOCK-002/003: ANY failure after the snapshot was captured
          // (mutation or cleanup commit) restores the exact auth
          // artifact and every committed config target before the fence
          // aborts. A failed compensation surfaces as ConfigRollbackFailed
          // carrying both the primary and the rollback detail.
          const compensate = (primary: Cause.Cause<unknown>) =>
            Effect.gen(function* () {
              let first: Cause.Cause<unknown> | undefined
              const authExit = yield* Effect.exit(Auth.restoreFile(fs, snap))
              if (authExit._tag === "Failure") first ??= authExit.cause
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
              if (committed.length > 0 && config) {
                const inv = yield* Effect.exit(config.invalidate())
                if (inv._tag === "Failure") first ??= inv.cause
                const invp = yield* Effect.exit(config.invalidateProject())
                if (invp._tag === "Failure") first ??= invp.cause
              }
              if (first) {
                return yield* Effect.die(
                  new ConfigRollbackFailed({
                    detail: "provider-auth compensation failed after a mutation or cleanup failure",
                    cause: `${Cause.pretty(primary)}\nrollback: ${Cause.pretty(first)}`,
                  }),
                )
              }
            })

          // LOCK-002: ANY mutation failure after snapshot capture restores the
          // exact artifact — a mutation can persist auth and then fail, and the
          // caller must not observe a half-applied auth file.
          const mutateExit = yield* Effect.exit(mutate)
          if (mutateExit._tag === "Failure") {
            yield* compensate(mutateExit.cause)
            return yield* Effect.failCause(mutateExit.cause)
          }

          // LOCK-003: disabled_providers cleanup (auth set/OAuth only). Under
          // the same fence and the canonical global discovery lock, prepare/
          // commit removal of the target ID with emit:false; unrelated IDs are
          // preserved.
          if (options?.cleanupDisabled) {
            if (!config) {
              yield* compensate(
                Cause.die(new Error("disabled-provider cleanup requested but Config.Service is unavailable")),
              )
              return yield* Effect.die(
                new Error("disabled-provider cleanup requested but Config.Service is unavailable"),
              )
            }
            const cleanupExit = yield* Effect.exit(cleanupDisabled(config, fs, providerID))
            if (cleanupExit._tag === "Failure") {
              yield* compensate(cleanupExit.cause)
              return yield* Effect.failCause(cleanupExit.cause)
            }
            if (cleanupExit.value.artifact) committed.push(cleanupExit.value.artifact)
            cleanupEvent = cleanupExit.value.event
          }

          // LOCK-001/002/003: the obligation commit registers exactly one
          // ControlLease-aware global convergence pass; the response returns
          // before active generations drain. Without a store the coordinator
          // has no instances to dispose, so the pass only boots fresh state.
          return { changed: true, value: true as const, event: cleanupEvent }
        }),
    })
  })(providerID, mutate, options)
