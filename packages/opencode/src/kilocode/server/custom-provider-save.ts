/**
 * Canonical custom provider save (LOCK-001..008).
 *
 * Replaces the extension's split global-config + auth mutations with ONE
 * backend mutation that cannot leave partial state and rebuilds once without
 * interrupting active sessions.
 *
 * Lifecycle (single global convergence obligation, exactly one rebuild):
 * 1. Fast-path validation before any fence/lock/auth/cache/config mutation:
 *    the config body must satisfy the backend schema (npm exactly one of the
 *    accepted AI SDK packages, nonempty name, nonempty models, http(s)
 *    baseURL) and an existing same-ID entry must not be a non-custom provider
 *    (LOCK-002 — an existing non-custom same-ID cannot be overwritten).
 * 2. Canonical cold acquisition order (LOCK-001): the ConfigConvergence global
 *    admission fence is raised FIRST (via withColdMutation), then the
 *    deterministic global discovery flock. The save never waits for a
 *    convergence fence while holding a flock.
 * 3. Under the lock: re-read the exact global target, compute the provider
 *    patch — the null deletions are derived from the OLD global entry and the
 *    NEW config, so removed model/variant/reasoning keys never persist after
 *    the merge (LOCK-002) — and prepare the global artifact in memory (no
 *    writes/events). `disabled_providers` removes the target ID only.
 * 4. No-op semantics (LOCK-006): when the prepared artifact is unchanged AND
 *    the auth mode is preserve, return success without auth/cache/rebuild/
 *    event — the existing UI expects save success when nothing changed. An
 *    auth set/clear counts as a change even when the config is a no-op.
 * 5. Mutate under locks + fence: capture the exact persisted auth-file
 *    artifact (bytes + mode) before the auth mutation (LOCK-003), commit the
 *    config with emit:false, apply the auth set/clear, clear the model cache
 *    LAST, then commit the obligation — the convergence pass drains readers,
 *    disposes the captured pre-fence instances, and boots replacements from
 *    the latest disk state. The transaction event is DEFERRED into the result:
 *    the HTTP handler emits it at the response acknowledgement boundary via
 *    HttpEffect.appendPreResponseHandler, so it is never observable before
 *    persistence, rebuild registration, and the success response are all
 *    finalized. The response returns after persistence + registration, before
 *    generation drain.
 * 6. Compensation (LOCK-004/006): any failure after mutation begins restores
 *    in reverse order while locks + fence remain held — the exact auth file
 *    artifact first (byte/mode-exact, covering Auth.set/remove's write-then-
 *    chmod/telemetry partial mutation), then every committed config artifact
 *    exactly, then invalidates global/project caches. A failed compensating
 *    rollback surfaces as ConfigRollbackFailed (a defect, not a validation
 *    error). Auth read/set/remove, commit, cache clear, and rollback errors
 *    are never swallowed; auth state is never inferred from method success.
 *
 * The save is GLOBAL-only (LOCK-002): it never touches a project config scope
 * and never requires an instance context for the write itself; the trusted
 * directory/worktree inputs are only asserted to match the canonical instance
 * context when both are present.
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
import { CUSTOM_PROVIDER_PACKAGES, isCustomProviderPackage, isProviderID } from "@/kilocode/custom-provider"
import { withColdMutation } from "./config-convergence"
import { ConfigRollbackFailed } from "./config-transaction"
import { configFailure } from "./config-failure"
import { restoreTarget } from "./config-rollback"

const log = Log.create({ service: "custom-provider-save" })

// ── request schema (LOCK-001/002) ─────────────────────────────────────

const Modalities = Schema.Struct({
  input: Schema.optional(Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"]))),
  output: Schema.optional(Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"]))),
})

const Model = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  reasoning: Schema.optional(Schema.Boolean),
  modalities: Schema.optional(Modalities),
  variants: Schema.optional(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown))),
})

/**
 * Backend custom-provider config schema (LOCK-002: backend validation matches
 * the UI constraints sufficiently — npm exact, nonempty name/models, http(s)
 * baseURL, reasonable shapes). The route reuses this exact schema so HTTP and
 * direct service callers validate identically.
 */
export const CustomProviderSaveConfigSchema = Schema.Struct({
  npm: Schema.Literals(CUSTOM_PROVIDER_PACKAGES),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  env: Schema.optional(Schema.Array(Schema.String.check(Schema.isMaxLength(128)))),
  options: Schema.Struct({
    baseURL: Schema.String.check(
      Schema.makeFilter((value: string) =>
        value.startsWith("http://") || value.startsWith("https://")
          ? undefined
          : "Base URL must start with http:// or https://",
      ),
    ),
    headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
  models: Schema.Record(Schema.String, Model).pipe(
    Schema.check(
      Schema.makeFilter((models: Record<string, unknown>) =>
        Object.keys(models).length > 0 ? undefined : "At least one model is required",
      ),
    ),
  ),
})
export type CustomProviderSaveConfig = Schema.Schema.Type<typeof CustomProviderSaveConfigSchema>

/** Auth mutation union: preserve | set(key) | clear (LOCK-001). */
export const CustomProviderSaveAuthSchema = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("preserve") }),
  Schema.Struct({ mode: Schema.Literal("set"), key: Schema.String }),
  Schema.Struct({ mode: Schema.Literal("clear") }),
])
export type CustomProviderSaveAuth = Schema.Schema.Type<typeof CustomProviderSaveAuthSchema>

/**
 * Trusted save input (LOCK-002). `providerID` is the canonical contract for
 * the instance handler; directory/worktree are derived from the canonical
 * `InstanceRef` by the handler or provided programmatically and only asserted
 * to match the ref when both are present.
 */
export type CustomProviderSaveInput = {
  readonly providerID: string
  readonly config: CustomProviderSaveConfig
  readonly auth: CustomProviderSaveAuth
  readonly directory?: string
  readonly worktree?: string
}

/** Structured save failure for later HTTP mapping. */
export class CustomProviderSaveError extends Schema.TaggedErrorClass<CustomProviderSaveError>()(
  "CustomProviderSaveError",
  {
    message: Schema.String,
    providerID: Schema.String,
    code: Schema.String,
  },
) {}

/**
 * Successful save result (LOCK-003). `events` carries the deferred final
 * ConfigUpdated emission: persistence + rebuild registration complete inside
 * `execute`, but the transaction event is NOT published here. The HTTP handler
 * emits it at the response acknowledgement boundary
 * (HttpEffect.appendPreResponseHandler), so it is never observable before the
 * success response value is finalized. A semantic no-op returns
 * `{ success: true }` with a no-op event effect (LOCK-006).
 */
export type CustomProviderSaveResult = {
  readonly success: true
  readonly events: Effect.Effect<void, never, never>
}

type AnyRecord = Record<string, unknown>

const isRecord = (value: unknown): value is AnyRecord =>
  !!value && typeof value === "object" && !Array.isArray(value)

/**
 * LOCK-002: compute the provider patch — the new config plus `null` deletion
 * sentinels derived from the OLD global entry — so removed model IDs, variant
 * names, and variant option keys never persist after the config merge. The
 * merge layer strips nulls (or deletes the key for jsonc targets), so the
 * backend is the single authority that keeps deletions durable even when a
 * client sends a config without explicit nulls.
 */
function computeCustomProviderPatch(oldEntry: unknown, next: CustomProviderSaveConfig): AnyRecord {
  if (!isRecord(oldEntry)) return { ...next, models: { ...next.models } }
  const oldModels = isRecord(oldEntry.models) ? (oldEntry.models as AnyRecord) : {}
  const patched: Record<string, unknown> = { ...next.models }
  for (const id of Object.keys(oldModels)) {
    if (!(id in patched)) {
      patched[id] = null
      continue
    }
    const oldModel = oldModels[id]
    const newModel = patched[id]
    if (!isRecord(oldModel) || !isRecord(newModel)) continue
    const out: Record<string, unknown> = { ...newModel }
    const oldVariants = isRecord(oldModel.variants) ? (oldModel.variants as AnyRecord) : {}
    const newVariants = isRecord(newModel.variants) ? (newModel.variants as AnyRecord) : {}
    if (newModel.variants === undefined) {
      // The new config dropped the variants field entirely: remove the whole
      // key when the old entry had variants (a `null` patch deletes the key for
      // jsonc targets and strips for json targets).
      if (Object.keys(oldVariants).length > 0) out.variants = null
    } else {
      const changes: Record<string, unknown> = {}
      for (const [name, oldVariant] of Object.entries(oldVariants)) {
        if (!(name in newVariants)) {
          changes[name] = null
          continue
        }
        const newVariant = newVariants[name]
        if (!isRecord(oldVariant) || !isRecord(newVariant)) continue
        const removed = Object.keys(oldVariant).filter((key) => !(key in newVariant))
        if (removed.length === 0) continue
        changes[name] = { ...newVariant, ...Object.fromEntries(removed.map((key) => [key, null])) }
      }
      if (Object.keys(changes).length > 0) out.variants = { ...newVariants, ...changes }
    }
    if (oldModel.reasoning !== undefined && newModel.reasoning === undefined) out.reasoning = null
    if (oldModel.modalities !== undefined && newModel.modalities === undefined) out.modalities = null
    patched[id] = out
  }
  return { ...next, models: patched }
}

const notCustom = (providerID: string) =>
  new CustomProviderSaveError({
    message: `Provider "${providerID}" is not a custom provider and cannot be overwritten`,
    providerID,
    code: "not-custom",
  })

export const execute = Effect.fn("CustomProviderSave.execute")(function* (input: CustomProviderSaveInput) {
  const providerID = input.providerID

  // LOCK-002: the provider ID must satisfy the shared product predicate
  // (lowercase alphanumeric start, then `[a-z0-9-_]`) before ANY
  // ticket/lock/auth/cache/config work. A route-matching but invalid ID gets
  // the same structured validation 400 as an invalid config body; slashed IDs
  // never route and stay 404.
  if (!isProviderID(providerID)) {
    return yield* Effect.fail(
      new CustomProviderSaveError({
        message: `Provider "${providerID}" id is invalid`,
        providerID,
        code: "validation",
      }),
    )
  }

  // LOCK-002: the backend schema is authoritative — the route reuses it and
  // direct service callers get the same validation.
  const config = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(CustomProviderSaveConfigSchema)(input.config),
    catch: () =>
      new CustomProviderSaveError({
        message: `Provider "${providerID}" config is invalid`,
        providerID,
        code: "validation",
      }),
  })
  const configSvc = yield* Config.Service
  const fs = yield* FSUtil.Service
  const auth = yield* Auth.Service
  const modelCache = Option.getOrElse(yield* Effect.serviceOption(ModelCache.Service), () => undefined)
  const ref = yield* InstanceRef

  // LOCK-002: the trusted directory/worktree must match the canonical instance
  // context when provided.
  if (input.directory && ref && ref.directory !== input.directory) {
    return yield* Effect.die(new Error(`custom provider save directory mismatch: ${input.directory} vs ${ref.directory}`))
  }
  if (input.worktree && ref && ref.worktree !== input.worktree) {
    return yield* Effect.die(new Error(`custom provider save worktree mismatch: ${input.worktree} vs ${ref.worktree}`))
  }

  const authChanged = input.auth.mode !== "preserve"

  const validate = Effect.fn("CustomProviderSave.validate")(function* () {
    const globalConfig = yield* configSvc.getGlobal()
    const existing = globalConfig.provider?.[providerID]
    if (existing != null && !isCustomProviderPackage(existing.npm)) {
      return yield* Effect.fail(notCustom(providerID))
    }
    return { globalConfig, existing }
  })

  // LOCK-003: fast-path rejection before ticket/locks/auth/cache/config mutation.
  yield* validate()

  const transactionID = randomUUID()

  // LOCK-001: canonical cold acquisition order — the ConfigConvergence global
  // fence is raised FIRST (via withColdMutation), then the global discovery
  // flock. Revalidation and prepare happen only under this order, so the save
  // never waits for a convergence fence while holding a flock; a no-op result
  // aborts the fence cleanly without a rebuild (withColdMutation aborts on
  // failure).
  const body = Effect.gen(function* () {
    // LOCK-002: the global target is resolved exactly once under the
    // discovery lock, before prepare/commit.
    const globalTarget = KilocodeConfig.globalConfigTarget()

    // LOCK-005: re-read/validate the scope under the locks.
    const current = yield* validate()

    // LOCK-002: provider patch with null deletions computed backend from
    // the old global entry and the new config; disabled_providers removes
    // the target ID only.
    const patch = computeCustomProviderPatch(current.existing, config)
    const disabled = current.globalConfig.disabled_providers ?? []
    const nextDisabled = disabled.includes(providerID)
      ? disabled.filter((item) => item !== providerID)
      : undefined
    const globalPatch = {
      ...(nextDisabled !== undefined ? { disabled_providers: nextDisabled } : {}),
      provider: { [providerID]: patch },
    } as unknown as Config.Info
    const artifact = yield* configFailure(configSvc.prepareGlobal(globalPatch, { file: globalTarget }))
    const configChanged = artifact.changed

    // LOCK-006: no-op semantics — identical config AND auth preserve
    // returns success with no auth/cache/rebuild/event (the existing UI
    // expects save success). Auth set/clear counts as a change even when
    // the config is a no-op.
    if (!configChanged && !authChanged) {
      return { changed: false as const, value: { success: true as const, events: Effect.void } }
    }

    const committed: Config.PreparedConfig[] = []
    let authSnap: Auth.AuthSnapshot | undefined

    // LOCK-004/006: compensate in reverse order while locks + fence are held.
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
      yield* configSvc.invalidate()
      yield* configSvc.invalidateProject()
      if (first) {
        const detail = "compensating rollback after custom provider save failed"
        log.error(detail, { cause: String(first) })
        return yield* Effect.fail(new ConfigRollbackFailed({ detail, cause: String(first) }))
      }
    })

    // LOCK-005/006: commit config (emit:false), apply auth, clear cache last.
    const mutate = Effect.gen(function* () {
      // LOCK-003: the exact persisted auth-file artifact captured BEFORE
      // any mutation that can touch auth; compensation restores it
      // regardless of how set/remove fails.
      if (authChanged) {
        authSnap = yield* Auth.snapshotFile(fs).pipe(Effect.orDie)
      }
      if (configChanged) {
        const exit = yield* Effect.exit(configSvc.commitGlobal(artifact, { emit: false }))
        if (exit._tag === "Failure") {
          yield* compensate
          return yield* Effect.failCause(exit.cause)
        }
        committed.push(artifact)
      }
      if (authChanged) {
        const mutation =
          input.auth.mode === "set"
            ? auth.set(providerID, { type: "api", key: input.auth.key })
            : auth.remove(providerID)
        const authExit = yield* Effect.exit(mutation)
        if (authExit._tag === "Failure") {
          yield* compensate
          return yield* Effect.failCause(authExit.cause)
        }
      }
      const clearExit = yield* Effect.exit(modelCache ? modelCache.clear(providerID) : Effect.void)
      if (clearExit._tag === "Failure") {
        yield* compensate
        return yield* Effect.failCause(clearExit.cause)
      }
      // LOCK-003: the final ConfigUpdated event is DEFERRED — tagged with
      // the logical transaction id — and returned to the caller (HTTP
      // handler) for emission at the response acknowledgement boundary.
      // Nothing observable is published here, so no client can observe
      // the transaction before persistence and rebuild registration are
      // complete.
      const events = configSvc.emitUpdated("global", transactionID)
      return { success: true as const, events }
    })

    return { changed: true as const, value: yield* mutate }
  })

  // LOCK-001/003: the discovery lock is acquired after the fence; the
  // response returns after persistence + rebuild registration, before
  // generation drain; exactly one rebuild is registered for the change.
  return yield* withColdMutation({
    scope: "global",
    run: () => configSvc.withLock(KilocodeConfig.configDiscoveryGlobalKey(), body),
  }).pipe(Effect.catchTag("ConfigRollbackFailed", (error) => Effect.die(error)))
})
