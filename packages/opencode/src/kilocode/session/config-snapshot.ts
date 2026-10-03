import { Context, Effect } from "effect"
import type { Config } from "@/config/config"
import type { CanonicalProvenance } from "@/kilocode/provider/canonical-provenance"
import type { PolicySnapshot } from "@/config/config"

/**
 * Generation-scoped config snapshot.
 *
 * A config PATCH persists immediately and invalidates the shared per-directory
 * config cache. Work that is already generating on a pre-patch instance must
 * keep reading the config it started with, while the next request must see the
 * new config. The rebuild coordinator does not interrupt in-flight generation
 * work, so the cache invalidation would otherwise leak new values into a
 * mid-turn `Config.get`.
 *
 * `withConfigSnapshot` captures the versioned generation policy once at
 * generation admission (SessionPrompt prompt/loop/shell) and provides it
 * through `ConfigSnapshotRef`, `CanonicalProviderSnapshotRef`, and
 * `PolicySnapshotRef`. The canonical `Config.get` prefers the reference when
 * it is present, so every `Config.get` inside the generation returns the
 * admission snapshot; permission policy assembly prefers `PolicySnapshotRef`
 * so global/project authored permission layers, permission level,
 * trusted-skill inputs, and protected-file constraints stay pinned to the same
 * version. Context references propagate through `EffectBridge` and `forkIn`,
 * so same-directory subagents and child work keep the same snapshot.
 * Explicit live-global reads for writes/admin/Settings (`getGlobal`) stay
 * live and never read the snapshot.
 */
export const ConfigSnapshotRef = Context.Reference<Config.Info | undefined>("@kilocode/ConfigSnapshot", {
  defaultValue: () => undefined,
})

export const CanonicalProviderSnapshotRef = Context.Reference<CanonicalProvenance | undefined>(
  "@kilocode/CanonicalProviderSnapshot",
  {
    defaultValue: () => undefined,
  },
)

export const PolicySnapshotRef = Context.Reference<PolicySnapshot | undefined>("@kilocode/PolicySnapshot", {
  defaultValue: () => undefined,
})

/**
 * Capture the current versioned generation policy together with the effective
 * config and canonical provenance from the same loaded State generation and
 * run `effect` with all three pinned. Requires the atomic capture path — no
 * fallback to separate reads to avoid refresh/invalidation race. `Config.get`
 * and `getCanonicalProvenance` still honor their separate snapshot refs, and
 * permission policy assembly honors `PolicySnapshotRef`; the atomic capture
 * returns all three from one `InstanceState.use` generation. The capture
 * bypasses existing snapshot refs so a fresh admission for a different
 * directory never inherits the parent snapshot.
 */
export const withConfigSnapshot = <A, E, R>(config: Config.Interface, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const snap = yield* config.captureFreshPolicySnapshot()
    return yield* effect.pipe(
      Effect.provideService(ConfigSnapshotRef, snap.info),
      Effect.provideService(CanonicalProviderSnapshotRef, snap.canonical),
      Effect.provideService(PolicySnapshotRef, snap),
    )
  })

export * as KiloConfigSnapshot from "./config-snapshot"
