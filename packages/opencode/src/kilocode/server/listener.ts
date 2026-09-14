import { AppLayer } from "@/effect/app-runtime"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { Layer, Scope } from "effect"

/**
 * Build one standalone listener.
 *
 * Topology contract (standalone listener root fix):
 * - `layer` MUST be the raw transport graph only: listener routes WITHOUT a
 *   provided AppLayer (`createListenerRoutesUnprovided`), `HttpRouter.serve`,
 *   `WebSocketTracker`, Node `HttpServer`, `ListenerServerService`, and the
 *   per-listener `ConfigProvider` snapshot. It must NOT already contain or
 *   provide AppLayer.
 * - `Layer.fresh(layer)` keeps exactly that transport state fresh per
 *   listener (distinct ports, distinct WebSocketTracker ownership, distinct
 *   router/middleware instances).
 * - `.pipe(Layer.provide(app))` runs OUTSIDE the fresh graph so the selected
 *   app (`AppLayer` canonical by default, or `opts.appLayer` for deterministic
 *   tests) is shared through the process `memoMap` — the same memoized
 *   identity global `AppRuntime` uses. Stopping a listener closes only its own
 *   scope/transport; the process owner remains responsible for final AppLayer
 *   disposal.
 * - Custom `appLayer` is supplied the same way (outside freshness) for that
 *   listener only; fd/private global `AppRuntime` parity with a custom app is
 *   unsupported as documented in `private-peer-registry.ts`.
 */
export function build<A, E, R>(
  layer: Layer.Layer<A, E, R>,
  scope: Scope.Scope,
  app: AppLayer = AppLayer,
) {
  // Order is semantically load-bearing: fresh(transport) THEN provide(app).
  // Reversing it (or embedding the app inside `layer`) would fresh the
  // canonical services per listener and break HTTP<->fd shared ownership.
  return Layer.buildWithMemoMap(Layer.fresh(layer).pipe(Layer.provide(app)), memoMap, scope)
}
