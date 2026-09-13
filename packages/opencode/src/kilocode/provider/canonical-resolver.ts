// kilocode_change - typed resolver over pinned/current canonical provenance
// Does not execute or select; returns exact closed record for streaming provider/httpExecute.
// Reads pinned snapshot via CanonicalProviderSnapshotRef if present, else current provenance via Config.Service.

import { Context, Data, Effect } from "effect"
import { Config } from "@/config/config"
import { ConfigSnapshotRef, CanonicalProviderSnapshotRef } from "@/kilocode/session/config-snapshot"
import type { CanonicalProvenance, CanonicalConflict } from "./canonical-provenance"

export type ResolvedCanonicalProvider = {
  readonly providerId: string
  readonly modelId: string
  readonly scope: "global" | "project"
  readonly source: string
  readonly credentialRef: string
  readonly record: unknown
}

export class CanonicalNotFoundError extends Data.TaggedError("CanonicalNotFoundError")<{
  readonly providerId: string
}> {}

export class CanonicalConflictError extends Data.TaggedError("CanonicalConflictError")<{
  readonly providerId: string
  readonly reason: CanonicalConflict["reason"]
  readonly message: string
  readonly scopes?: readonly string[]
  readonly sources?: readonly string[]
}> {}

export class CanonicalModelNotFoundError extends Data.TaggedError("CanonicalModelNotFoundError")<{
  readonly providerId: string
  readonly modelId: string
}> {}

export type CanonicalResolveError = CanonicalNotFoundError | CanonicalConflictError | CanonicalModelNotFoundError

export namespace CanonicalResolver {
  export const resolve = (providerId: string, modelId: string): Effect.Effect<ResolvedCanonicalProvider, CanonicalResolveError, Config.Service> =>
    Effect.gen(function* () {
      const snap = yield* CanonicalProviderSnapshotRef
      if (snap) {
        return yield* resolveFromProvenance(snap, providerId, modelId)
      }
      const svc = yield* Config.Service
      const prov = yield* svc.getCanonicalProvenance()
      return yield* resolveFromProvenance(prov, providerId, modelId)
    })

  export const resolveFromSnapshot = (
    provenance: CanonicalProvenance,
    providerId: string,
    modelId: string,
  ): Effect.Effect<ResolvedCanonicalProvider, CanonicalResolveError> => resolveFromProvenance(provenance, providerId, modelId)
}

function resolveFromProvenance(
  provenance: CanonicalProvenance,
  providerId: string,
  modelId: string,
): Effect.Effect<ResolvedCanonicalProvider, CanonicalResolveError> {
  const conflict = provenance.conflicts.find((c) => c.id === providerId)
  if (conflict) {
    return Effect.fail(
      new CanonicalConflictError({
        providerId,
        reason: conflict.reason,
        message: conflict.message,
        scopes: conflict.scopes ? [...conflict.scopes] : undefined,
        sources: conflict.sources ? [...conflict.sources] : undefined,
      }),
    )
  }
  if (!Object.hasOwn(provenance.providers, providerId)) {
    return Effect.fail(new CanonicalNotFoundError({ providerId }))
  }
  const entry = provenance.providers[providerId]!
  const record = entry.record as Record<string, unknown>
  const models = record.models as Record<string, unknown> | undefined
  if (!models || !Object.hasOwn(models, modelId)) {
    return Effect.fail(new CanonicalModelNotFoundError({ providerId, modelId }))
  }
  const credentialRef = record.credential as string | undefined
  if (typeof credentialRef !== "string" || credentialRef.length === 0) {
    return Effect.fail(
      new CanonicalConflictError({
        providerId,
        reason: "missing-credential",
        message: "canonical provider missing credential",
        scopes: [entry.scope],
        sources: [entry.source],
      }),
    )
  }
  return Effect.succeed({
    providerId,
    modelId,
    scope: entry.scope,
    source: entry.source,
    credentialRef,
    record: entry.record,
  })
}

export * as CanonicalResolverService from "./canonical-resolver"
