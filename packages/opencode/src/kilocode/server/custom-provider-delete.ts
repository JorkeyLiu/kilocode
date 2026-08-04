/**
 * Canonical custom provider deletion (LOCK-001/002/003/004/005/006/007).
 *
 * Lifecycle (single global writer ticket, exactly one rebuild):
 * 1. Fast-path validation (LOCK-003) before any ticket/lock/auth/cache/config
 *    mutation: an entry is custom only when its npm package is one of the
 *    accepted AI SDK packages, checked independently in each canonical scope —
 *    global via Config.getGlobal, project via KilocodeConfigOverlay.project
 *    (raw file read, no cached discovery). Reject when neither scope is custom.
 * 2. Canonical cold acquisition order (LOCK-001): the ConfigConvergence global
 *    admission fence is raised FIRST (via withColdMutation), then the
 *    deterministic global→project config flocks. Deletion never waits for a
 *    convergence fence while holding a flock. A not-custom revalidation or
 *    prepared no-op aborts the fence cleanly without a rebuild.
 * 3. LOCK-002: each global/project target is resolved exactly once after
 *    ticket acquisition and before lock acquisition; prepare/commit use those
 *    exact resolved paths (Config.prepare/prepareGlobal accept the resolved
 *    file), so the locked key is always the written path.
 * 4. Under locks: re-read/validate scopes; prepare ALL config artifacts in
 *    memory (no writes/events). A valid custom validation that prepares no
 *    change means a concurrent mutation removed the provider — reject cleanly.
 * 5. Mutate under locks + fence: capture the exact persisted auth-file
 *    artifact (bytes + mode) before any auth mutation (LOCK-003), commit
 *    changed artifacts with emit:false (global then project), remove auth,
 *    clear the model cache LAST, then commit the obligation — the convergence
 *    pass drains readers, disposes the captured pre-fence instances, and boots
 *    replacements. The transaction events are DEFERRED into the result
 *    (LOCK-003): the HTTP handler emits them at the response acknowledgement
 *    boundary via HttpEffect.appendPreResponseHandler, so they are never
 *    observable before persistence, rebuild registration, and the success
 *    response value are all finalized. The response returns after persistence
 *    + registration, before generation drain (LOCK-007); the forked pass
 *    disposes old instances only after their readers and control leases drain.
 *
 * Event contract (LOCK-003, framework evidence): the Effect HttpApi writes the
 * HTTP response after the handler Effect completes — `HttpEffect.toHandled`
 * runs any registered pre-response handler BEFORE `handleResponse` converts/
 * sends the response bytes, and there is no post-send hook on the web-handler
 * path. True byte-on-wire response-before-event therefore requires request
 * lifecycle support that does not exist here; the truthful maximum is: persist
 * → rebuild registration → handler result finalization → final events → bytes
 * on wire. `execute` (the service) never emits; direct service callers observe
 * zero events until they run the returned `events` effect at their own
 * acknowledgement boundary.
 * 6. Compensation (LOCK-006): any failure after mutation begins restores in
 *    reverse order while locks + fence remain held — the exact auth file
 *    artifact first (byte/mode-exact, covering Auth.remove's write-then-
 *    chmod/telemetry partial mutation), then every committed artifact exactly
 *    (write original back, or delete a newly created target), then invalidate
 *    global/project caches. A failed compensating rollback surfaces as
 *    ConfigRollbackFailed (a defect, not a validation error). Auth
 *    read/remove/set, commit, cache clear, and rollback errors are never
 *    swallowed; auth removal state is never inferred from method success.
 *
 * Project scope requires the canonical instance context (InstanceRef):
 * Config.prepare/commit derive the project target from InstanceRef, and the
 * trusted directory/worktree inputs are asserted to match it.
 */

import { randomUUID } from "crypto"
import { Cause, Effect, Option, Schema } from "effect"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { FSUtil } from "@opencode-ai/core/fs-util"
import * as Log from "@opencode-ai/core/util/log"
import { InstanceRef } from "@/effect/instance-ref"
import { ModelCache } from "@/provider/model-cache"
import { KilocodeConfig } from "@/kilocode/config/config"
import { KilocodeConfigOverlay } from "@/kilocode/config/overlay"
import { isCustomProviderPackage, isProviderID } from "@/kilocode/custom-provider"
import { withColdMutation } from "./config-convergence"
import { ConfigRollbackFailed } from "./config-transaction"
import { configFailure } from "./config-failure"
import { restoreTarget } from "./config-rollback"

const log = Log.create({ service: "custom-provider-delete" })

/**
 * Trusted deletion input (LOCK-002/004). `providerID` is the canonical
 * contract for the instance handler; the transitional `id` alias was dropped
 * when the route migrated onto trusted instance context (LOCK-004). The
 * service never reads an HTTP query itself — directory/worktree are derived
 * from the canonical `InstanceRef` by the handler or provided programmatically.
 */
export type CustomProviderDeleteInput = {
  readonly providerID: string
  readonly directory?: string
  readonly worktree?: string
}

/** Structured deletion failure for later HTTP mapping. */
export class CustomProviderDeleteError extends Schema.TaggedErrorClass<CustomProviderDeleteError>()(
  "CustomProviderDeleteError",
  {
    message: Schema.String,
    providerID: Schema.String,
    code: Schema.String,
  },
) {}

/**
 * Successful deletion result (LOCK-003). `events` carries the deferred final
 * ConfigUpdated emissions: persistence + rebuild registration complete inside
 * `execute`, but the transaction events are NOT published here. The HTTP
 * handler emits them at the response acknowledgement boundary
 * (HttpEffect.appendPreResponseHandler), so they are never observable before
 * the success response value is finalized.
 */
export type CustomProviderDeleteResult = {
  readonly success: true
  readonly events: Effect.Effect<void, never, never>
}

type ScopeTarget = {
  readonly scope: "global" | "project"
  readonly artifact: Config.PreparedConfig
}

/** True when a provider entry is custom per the product predicate (LOCK-003). */
const scopeCustom = (info: Config.Info, providerID: string): boolean => {
  const entry = info.provider?.[providerID]
  return entry != null && isCustomProviderPackage(entry.npm)
}

export const execute = Effect.fn("CustomProviderDelete.execute")(function* (input: CustomProviderDeleteInput) {
  const providerID = input.providerID

  // LOCK-002: the provider ID must satisfy the shared product predicate
  // (lowercase alphanumeric start, then `[a-z0-9-_]`) before ANY
  // ticket/lock/auth/cache/config work. A route-matching but invalid ID gets a
  // structured validation 400; slashed IDs never route and stay 404.
  if (!isProviderID(providerID)) {
    return yield* Effect.fail(
      new CustomProviderDeleteError({
        message: `Provider "${providerID}" id is invalid`,
        providerID,
        code: "validation",
      }),
    )
  }

  const config = yield* Config.Service
  const fs = yield* FSUtil.Service
  const auth = yield* Auth.Service
  const modelCache = Option.getOrElse(yield* Effect.serviceOption(ModelCache.Service), () => undefined)
  const ref = yield* InstanceRef

  // LOCK-002: the trusted directory/worktree must match the canonical instance
  // context, because Config.prepare/commit derive the project target from it.
  if (input.directory && ref && ref.directory !== input.directory) {
    return yield* Effect.die(
      new Error(`custom provider deletion directory mismatch: ${input.directory} vs ${ref.directory}`),
    )
  }
  if (input.worktree && ref && ref.worktree !== input.worktree) {
    return yield* Effect.die(
      new Error(`custom provider deletion worktree mismatch: ${input.worktree} vs ${ref.worktree}`),
    )
  }
  const directory = input.directory ?? ref?.directory
  const worktree = input.worktree ?? ref?.worktree

  const validate = Effect.fn("CustomProviderDelete.validate")(function* () {
    const globalConfig = yield* config.getGlobal()
    const hasGlobalCustom = scopeCustom(globalConfig, providerID)
    let hasProjectCustom = false
    if (directory) {
      const overlay = yield* Effect.promise(() => KilocodeConfigOverlay.project({ directory, worktree }))
      hasProjectCustom = scopeCustom(overlay, providerID)
    }
    return { global: hasGlobalCustom, project: hasProjectCustom, globalConfig }
  })

  const notCustom = (detail: string) =>
    new CustomProviderDeleteError({
      message: `Provider "${providerID}" ${detail}`,
      providerID,
      code: "not-custom",
    })

  // LOCK-003: fast-path rejection before ticket/locks/auth/cache/config mutation.
  const fast = yield* validate()
  if (!fast.global && !fast.project) {
    return yield* Effect.fail(notCustom("is not a custom provider in any config scope"))
  }
  if (fast.project && !ref) {
    return yield* Effect.die(new Error("custom provider project deletion requires an instance context"))
  }

  const transactionID = randomUUID()

  // LOCK-001: canonical cold acquisition order — the ConfigConvergence global
  // admission fence is raised FIRST (via withColdMutation), then the
  // deterministic global→project config flocks. Deletion never waits for a
  // convergence fence while holding a flock. A not-custom revalidation or
  // prepared no-op aborts the fence cleanly without a rebuild.
  const discoveryProjectKey = directory
    ? KilocodeConfig.configDiscoveryProjectKey(directory)
    : undefined

  const body = Effect.gen(function* () {
    // LOCK-002: each global/project target is resolved exactly once after
    // fence acquisition and before lock acquisition; prepare/commit use those
    // exact resolved paths (Config.prepare/prepareGlobal accept the resolved
    // file), so the locked key is always the written path.
    const globalTarget = KilocodeConfig.globalConfigTarget()
    const projectTarget = directory
      ? yield* KilocodeConfig.projectConfigUpdateTarget({ fs, directory, worktree })
      : undefined

    // LOCK-005: re-read/validate scopes under the locks before any mutation.
    const current = yield* validate()
    if (!current.global && !current.project) {
      return yield* Effect.fail(notCustom("is not a custom provider in any config scope"))
    }
    if (current.project && !ref) {
      return yield* Effect.die(new Error("custom provider project deletion requires an instance context"))
    }

    // LOCK-003/005: prepare all config artifacts in memory against the
    // resolved targets before the first write.
    const disabled = current.globalConfig.disabled_providers ?? []
    const targets: ScopeTarget[] = []
    if (current.global || disabled.includes(providerID)) {
      const patch = {
        ...(disabled.includes(providerID)
          ? { disabled_providers: disabled.filter((item) => item !== providerID) }
          : {}),
        provider: { [providerID]: null },
      } as Config.Info
      const artifact = yield* configFailure(config.prepareGlobal(patch, { file: globalTarget }))
      if (artifact.changed) targets.push({ scope: "global", artifact })
    }
    if (current.project) {
      const artifact = yield* configFailure(
        config.prepare({ provider: { [providerID]: null } } as Config.Info, { file: projectTarget }),
      )
      if (artifact.changed) targets.push({ scope: "project", artifact })
    }

    // LOCK-005: a valid custom validation that prepares no change means a
    // concurrent mutation already removed the provider — reject cleanly.
    if (targets.length === 0) {
      return yield* Effect.fail(notCustom("is no longer a custom provider"))
    }

    const committed: Config.PreparedConfig[] = []
    // LOCK-003: the exact persisted auth-file artifact captured BEFORE any
    // auth mutation; compensation restores it regardless of how remove fails.
    let authSnap: Auth.AuthSnapshot | undefined

    // LOCK-006: compensate in reverse order while locks + fence are held.
    const compensate = Effect.gen(function* () {
      let first: Cause.Cause<unknown> | undefined
      if (authSnap) {
        const exit = yield* Effect.exit(Auth.restoreFile(fs, authSnap))
        if (exit._tag === "Failure") first ??= exit.cause
      }
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
      yield* config.invalidate()
      yield* config.invalidateProject()
      if (first) {
        const detail = "compensating rollback after custom provider deletion failed"
        log.error(detail, { cause: String(first) })
        return yield* Effect.fail(new ConfigRollbackFailed({ detail, cause: String(first) }))
      }
    })

    // LOCK-005/006: commit config (emit:false), remove auth, clear cache last.
    const mutate = Effect.gen(function* () {
      authSnap = yield* Auth.snapshotFile(fs)
      for (const target of targets) {
        const exit =
          target.scope === "global"
            ? yield* Effect.exit(config.commitGlobal(target.artifact, { emit: false }))
            : yield* Effect.exit(config.commit(target.artifact, { emit: false }))
        if (exit._tag === "Failure") {
          yield* compensate
          return yield* Effect.failCause(exit.cause)
        }
        committed.push(target.artifact)
      }
      const removeExit = yield* Effect.exit(auth.remove(providerID))
      if (removeExit._tag === "Failure") {
        yield* compensate
        return yield* Effect.failCause(removeExit.cause)
      }
      const clearExit = yield* Effect.exit(modelCache ? modelCache.clear(providerID) : Effect.void)
      if (clearExit._tag === "Failure") {
        yield* compensate
        return yield* Effect.failCause(clearExit.cause)
      }
      // LOCK-003: the final ConfigUpdated events are DEFERRED — one per
      // committed scope, all tagged with the logical transaction id —
      // and returned to the caller (HTTP handler) for emission at the
      // response acknowledgement boundary. Nothing observable is
      // published here, so no client can observe the transaction before
      // persistence and rebuild registration are complete.
      const events = Effect.forEach(
        targets,
        (target) => config.emitUpdated(target.scope === "global" ? "global" : ref!.directory, transactionID),
        { discard: true },
      )
      return { success: true as const, events }
    })

    return { changed: true as const, value: yield* mutate }
  })

  // LOCK-001/007: discovery locks are acquired after the fence; the response
  // is returned after persistence + rebuild registration, before generation
  // drain; exactly one rebuild is registered for the changed mutation.
  return yield* withColdMutation({
    scope: "global",
    run: () =>
      config.withLock(
        KilocodeConfig.configDiscoveryGlobalKey(),
        discoveryProjectKey ? config.withLock(discoveryProjectKey, body) : body,
      ),
  }).pipe(Effect.catchTag("ConfigRollbackFailed", (error) => Effect.die(error)))
})
