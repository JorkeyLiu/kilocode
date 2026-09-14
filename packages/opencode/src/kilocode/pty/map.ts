import { Context, Effect, Layer } from "effect"
import { PtyServiceMap } from "@opencode-ai/core/pty-service-map"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { registerDisposer } from "@/effect/instance-registry"

// AppLayer-owned dedicated per-directory `Pty.Service` owner. The canonical
// `PtyServiceMap.layer` node is exposed directly; the same map instance the
// layer provides registers one `runDisposers(directory)` invalidation in the
// layer's own scope (unregistered via finalizer, mirroring
// `InstanceState.make`). InstanceStore dispose/reload/cold convergence reaps
// exactly once; AppLayer scope close finalizes all entries.
export const layer = PtyServiceMap.layer.pipe(
  Layer.tap((ctx) =>
    Effect.gen(function* () {
      const map = Context.get(ctx, PtyServiceMap)
      const unregister = registerDisposer((directory) =>
        Effect.runPromise(map.invalidate({ directory: AbsolutePath.make(directory) })),
      )
      yield* Effect.addFinalizer(() => Effect.sync(unregister))
    }),
  ),
)
