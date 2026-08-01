import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { Effect, Layer, Option } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { WorkspaceRouteContext } from "./workspace-routing"
// kilocode_change start - BLOCKER 1: gate instance load during writer barriers
import { GenerationGate } from "@/kilocode/server/generation-gate"
// kilocode_change end

export class InstanceContextMiddleware extends HttpApiMiddleware.Service<
  InstanceContextMiddleware,
  {
    requires: WorkspaceRouteContext
  }
>()("@opencode/ExperimentalHttpApiInstanceContext") {}

function decode(input: string): string {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

// kilocode_change start - BLOCKER 1: short-lease gate admission for store.load
// The reader lease covers ONLY the store.load phase. It is released
// immediately after load succeeds or fails via Effect.ensuring, before the
// handler runs. This prevents long-lived handlers (SSE, streaming) from
// holding the load gate and blocking writer barrier drain.
//
// Config PATCHes (/config, /config/overlay) must not take a reader lease: the
// handler acquires its own local write ticket right after the load, and a held
// reader lease would self-deadlock against that writer. Instead they use
// `gate.prepareWrite`, a write-preparation admission that waits behind any
// active/queued global writer and holds a per-directory write intent only for
// the duration of the load. This closes the race where a PATCH for an unseen
// directory booted an instance from pre-rebuild config while a global writer
// barrier was active after it had captured its rebuild identities.
//
// The environment is the route context plus the raw request the middleware
// reads to identify config PATCHes; `HttpServerRequest` is part of
// `HttpRouter.Provided`, so the middleware contract absorbs it.
function provideInstanceContext<E>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E>,
  store: InstanceStore.Interface,
  gate: GenerationGate,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, WorkspaceRouteContext | HttpServerRequest.HttpServerRequest> {
  return Effect.gen(function* () {
    const route = yield* WorkspaceRouteContext
    const dir = decode(route.directory)
    const request = yield* HttpServerRequest.HttpServerRequest
    const path = new URL(request.url, "http://localhost").pathname
    const patch = request.method === "PATCH" && (path === "/config" || path === "/config/overlay")
    if (patch) {
      const release = yield* gate.prepareWrite(dir)
      const ctx = yield* store.load({ directory: dir }).pipe(Effect.ensuring(release))
      return yield* effect.pipe(
        Effect.provideService(InstanceRef, ctx),
        Effect.provideService(WorkspaceRef, route.workspaceID),
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
      )
    }
    const release = yield* gate.acquire(dir)
    const ctx = yield* store.load({ directory: dir }).pipe(Effect.ensuring(release))
    return yield* effect.pipe(
      Effect.provideService(InstanceRef, ctx),
      Effect.provideService(WorkspaceRef, route.workspaceID),
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
    )
  })
}
// kilocode_change end

export const instanceContextLayer = Layer.effect(
  InstanceContextMiddleware,
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    const gate = Option.getOrElse(yield* Effect.serviceOption(GenerationGate.Service), () => GenerationGate.noop) // kilocode_change
    return InstanceContextMiddleware.of((effect) => provideInstanceContext(effect, store, gate)) // kilocode_change
  }),
)
