import { AppLayer } from "@/effect/app-runtime"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { Context, Effect, Layer, Scope } from "effect"
import * as P0Perf from "@/kilocode/perf/instrument" // kilocode_change - P0 instrumentation

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
 * - The selected app (`AppLayer` canonical by default, or `opts.appLayer`
 *   for deterministic tests) is built once outside the fresh graph and the
 *   transport is satisfied from its already-built context, so the app is
 *   shared through the process `memoMap` — the same memoized identity
 *   global `AppRuntime` uses. Stopping a listener closes only its own
 *   scope/transport; the process owner remains responsible for final AppLayer
 *   disposal.
 * - Custom `appLayer` is supplied the same way (outside freshness) for that
 *   listener only; fd/private global `AppRuntime` parity with a custom app is
 *   unsupported as documented in `private-peer-registry.ts`.
 * - Returns both the transport context and the selected app context. The
 *   app is acquired exactly once per listener; the transport is then built
 *   from that already-built context (never referencing the app layer a
 *   second time), so the serving graph and the post-bind trigger (e.g. the
 *   retention boot gate) observe the exact same app instance even when the
 *   custom app contains `Layer.fresh` (which would rebuild on a second
 *   acquisition into a different worker).
  */
export function build<A, E, R>(
  layer: Layer.Layer<A, E, R>,
  scope: Scope.Scope,
  app: AppLayer = AppLayer,
) {
  // Order is semantically load-bearing: the app is built first (fresh nodes
  // inside a custom app construct exactly once in this listener scope;
  // canonical nodes memo-hit the process memoMap), then the fresh transport
  // is satisfied from that context via `succeedContext`. The transport never
  // references the app layer again, so `Layer.fresh` inside the app cannot
  // rebuild into a second worker. Reversing the provision (or embedding the
  // app inside `layer`) would fresh the canonical services per listener and
  // break HTTP<->fd shared ownership.
  return Effect.gen(function* () {
    const appTimer = P0Perf.span("app_layer_build") // kilocode_change - P0 instrumentation
    const appCtx = yield* Layer.buildWithMemoMap(app, memoMap, scope)
    appTimer.end()
    const transportTimer = P0Perf.span("transport_build_bind") // kilocode_change - P0 instrumentation
    const ctx = yield* Layer.buildWithMemoMap(Layer.fresh(layer), memoMap, scope).pipe(
      Effect.provide(Layer.succeedContext(appCtx as Context.Context<R>)),
    )
    transportTimer.end()
    return { ctx, appCtx } as { ctx: Context.Context<A>; appCtx: Context.Context<unknown> }
  })
}
