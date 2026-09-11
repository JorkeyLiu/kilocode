import { Context, Effect } from "effect"
import type { Config } from "@/config/config"
import type { CanonicalProvenance } from "@/kilocode/provider/canonical-provenance"

/**
 * Generation-scoped config snapshot (LOCK-004).
 *
 * A config PATCH persists immediately and invalidates the shared per-directory
 * config cache. Work that is already generating on a pre-patch instance must
 * keep reading the config it started with, while the next request must see the
 * new config. The rebuild coordinator does not interrupt in-flight generation
 * work, so the cache invalidation would otherwise leak new values into a
 * mid-turn `Config.get`.
 *
 * `withConfigSnapshot` captures the effective `Config.Info` once at generation
 * entry (SessionPrompt prompt/loop/shell) and provides it through
 * `ConfigSnapshotRef`. The canonical `Config.get` prefers the reference when it
 * is present, so every `Config.get` inside the generation returns the startup
 * snapshot. Context references propagate through `EffectBridge` and `forkIn`,
 * so subagents and queued work keep the same snapshot. `getGlobal` is never
 * snapshotted — explicit live-global reads stay live (LOCK-004).
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

/**
 * Capture the current effective config and canonical provenance together from
 * the same loaded State/instance generation and run `effect` with both pinned.
 * Requires atomic `getWithCanonical` — no fallback to separate reads to avoid
 * refresh/invalidation race. `Config.get` and `getCanonicalProvenance` still
 * honor their separate snapshot refs; the atomic pair returns both from one
 * `InstanceState.use` generation.
 */
export const withConfigSnapshot = <A, E, R>(config: Config.Interface, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const snap = yield* config.getWithCanonical()
    return yield* effect.pipe(
      Effect.provideService(ConfigSnapshotRef, snap.info),
      Effect.provideService(CanonicalProviderSnapshotRef, snap.canonical),
    )
  })

export * as KiloConfigSnapshot from "./config-snapshot"
