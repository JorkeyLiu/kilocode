/**
 * Canonical provider-auth mutation coordinator (LOCK-001..004).
 *
 * Every provider-auth mutation (root auth set/remove, provider OAuth callback,
 * Anaconda Desktop sync) routes through `invalidateAfterProviderAuthChange`.
 * The coordinator owns the GenerationGate/ConfigRebuild lifecycle so no caller
 * can dispose an active instance outside generation drain:
 *
 * 1. Acquire ONE global writer ticket (LOCK-001) before any mutation — new work
 *    waits behind the barrier while the mutation is persisted.
 * 2. Capture loaded instance snapshots after ticket acquisition, before
 *    persistence visibility — the exact pre-barrier identities the rebuild
 *    disposes only once their readers and control leases drain.
 * 3. Capture the exact auth-file artifact (bytes + mode) BEFORE the mutation
 *    (LOCK-004) so any post-capture failure — mutation, cleanup commit, OR
 *    cache-clear — can restore it.
 * 4. Run the caller's mutation under the ticket (LOCK-002: reads of the
 *    current credential must happen here, immediately before the write), then
 *    optionally prepare/commit the disabled_providers cleanup under the same
 *    ticket and the canonical global discovery lock (LOCK-003), then clear the
 *    ModelCache immediately.
 * 5. Register exactly one ControlLease-aware global rebuild and return BEFORE
 *    active generations drain (LOCK-002): the forked rebuild disposes old
 *    instances after their readers drain; control operations stay usable
 *    against the pre-barrier runtime. A deferred ConfigUpdated event (cleanup
 *    only) is published by withWriteTicket after rebuild registration.
 *
 * Failure semantics (LOCK-004): a snapshot failure aborts the ticket and
 * propagates — no mutation, no disposal, no success claim. ANY mutation
 * failure AFTER the snapshot was captured (including a failure that persisted
 * part of the mutation) restores the exact auth artifact (via the canonical
 * byte snapshot/restore API) before the ticket aborts and the defect
 * propagates. A cleanup-commit or cache-clear failure after a successful
 * mutation restores the exact auth artifact AND every committed config target,
 * then invalidates config caches. If the compensation itself fails, the
 * surfaced defect is `ConfigRollbackFailed` carrying both the primary and the
 * rollback detail. Rebuild registration failure surfaces as a request failure
 * via the ticket handoff in `withWriteTicket`.
 */

import { randomUUID } from "crypto"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { KiloViewers } from "@/kilocode/presence/service"
import { KilocodeConfig } from "@/kilocode/config/config"
import { InstanceStore } from "@/project/instance-store"
import { ModelCache } from "@/provider/model-cache"
import { Cause, Effect, Option } from "effect"
import { ConfigRebuild } from "./config-rebuild"
import { ConfigRollbackFailed } from "./config-transaction"
import { restoreTarget } from "./config-rollback"
import { withWriteTicket } from "./config-ticket"
import { GenerationGate } from "./generation-gate"

// kilocode_change - drop the old presence socket; callers invoke this for the "kilo" provider only
export const invalidatePresence = Effect.fn("KiloServer.invalidatePresence")(function* () {
  const viewers = yield* KiloViewers.Service
  yield* viewers.invalidateAuth()
})

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
 * writer ticket (LOCK-001/002/003). `mutate` is the caller's persistence step
 * (auth set/remove, OAuth callback, Anaconda auth sync); it runs under the
 * ticket so no generation can observe a partially-applied auth change.
 *
 * LOCK-002: callers that derive a new credential from the CURRENT auth record
 * (e.g. the organization switch) must perform the read inside `mutate`,
 * immediately before the write, so a concurrent newer credential is never
 * overwritten by a pre-ticket snapshot.
 *
 * LOCK-003: when `options.cleanupDisabled` is set (root auth set and OAuth
 * callback only), the coordinator additionally removes `providerID` from the
 * global `disabled_providers` list under the same ticket and the canonical
 * global discovery lock — one backend mutation with exactly one rebuild. The
 * config is prepared/committed with emit:false; any commit/auth/cache failure
 * compensates the exact auth artifact and every committed config target before
 * the ticket aborts. A single deferred ConfigUpdated event is returned and
 * published only after rebuild registration. Auth remove/Anaconda/org callers
 * do not request cleanup.
 *
 * Returns `true` after persistence + rebuild registration, before generation
 * drain.
 */
export const invalidateAfterProviderAuthChange = <E, R>(
  providerID: string,
  mutate: Effect.Effect<unknown, E, R>,
  options?: { cleanupDisabled?: boolean },
): Effect.Effect<true, E, R | FSUtil.Service | ModelCache.Service> =>
  Effect.fn("KiloServer.invalidateAfterProviderAuthChange")(function* (
    providerID: string,
    mutate: Effect.Effect<unknown, E, R>,
    options?: { cleanupDisabled?: boolean },
  ) {
    const gate = Option.getOrElse(yield* Effect.serviceOption(GenerationGate.Service), () => GenerationGate.noop)
    const store = Option.getOrElse(yield* Effect.serviceOption(InstanceStore.Service), () => undefined)
    // kilocode_change - LOCK-003: Config.Service is required only when a caller
    // requests disabled_providers cleanup; Anaconda/org/auth-remove callers
    // stay free of the dependency (serviceOption adds no env requirement).
    const config = Option.getOrElse(yield* Effect.serviceOption(Config.Service), () => undefined)
    const cache = yield* ModelCache.Service
    const fs = yield* FSUtil.Service

    return yield* withWriteTicket({
      acquire: gate.beginWriteGlobal(),
      run: (ticket) =>
        Effect.gen(function* () {
          // LOCK-001/003: pre-barrier identities captured after ticket
          // acquisition and before persistence visibility.
          const dirs = store ? yield* store.directories() : []
          const olds = yield* Effect.forEach(dirs, (directory) =>
            store!.snapshot(directory).pipe(Effect.map((old) => ({ directory, old }))),
          )
          // LOCK-004: exact auth-file artifact captured before the mutation.
          const snap = yield* Auth.snapshotFile(fs).pipe(Effect.orDie)
          // LOCK-003: committed config targets from the disabled-provider
          // cleanup, restored by compensation on any later failure.
          const committed: Config.PreparedConfig[] = []
          let cleanupEvent: Effect.Effect<void, never, never> | undefined

          // LOCK-002/003: ANY failure after the snapshot was captured
          // (mutation, cleanup commit, or cache clear) restores the exact auth
          // artifact and every committed config target before the ticket
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
          // the same ticket and the canonical global discovery lock, prepare/
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
            // LOCK-003: record the committed config artifact immediately after
            // commit so a later cache-clear failure compensates it exactly —
            // reverse-restore the target, invalidate config caches, and let the
            // ticket abort with zero events (the deferred ConfigUpdated is only
            // published by withWriteTicket after a successful rebuild handoff).
            if (cleanupExit.value.artifact) committed.push(cleanupExit.value.artifact)
            cleanupEvent = cleanupExit.value.event
          }

          // LOCK-001: clear the model cache immediately, still under the ticket.
          const clearExit = yield* Effect.exit(cache.clear(providerID))
          if (clearExit._tag === "Failure") {
            yield* compensate(clearExit.cause)
            return yield* Effect.failCause(clearExit.cause)
          }
          // LOCK-001/002/003: register exactly one ControlLease-aware global
          // rebuild; the response returns before active generations drain.
          // The store instance was resolved above; without a store there are
          // no instances to dispose, so no rebuild is registered and the
          // ticket is simply released.
          const rebuild = store
            ? ConfigRebuild.rebuildGlobal(ticket, olds).pipe(Effect.provideService(InstanceStore.Service, store))
            : undefined
          return { changed: true, value: true as const, rebuild, event: cleanupEvent }
        }),
    })
  })(providerID, mutate, options)
