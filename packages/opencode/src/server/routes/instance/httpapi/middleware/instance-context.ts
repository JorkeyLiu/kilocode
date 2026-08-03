import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { Effect, Layer, Option } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { WorkspaceRouteContext } from "./workspace-routing"
// kilocode_change start - BLOCKER 1: gate instance load during writer barriers
import { GenerationGate } from "@/kilocode/server/generation-gate"
// kilocode_change end
// kilocode_change start - LOCK-004/006: drain-control bypass during writer barriers
import { classifyDrainControl, serveControlFromSnapshot, unavailable } from "@/kilocode/server/drain-control"
import { ControlLease } from "@/kilocode/server/control-lease"
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
  leases: ControlLease,
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
    // kilocode_change start - LOCK-003/004/006: drain-control lane.
    // Pre-barrier lifecycle controls (abort / cancelQueued / permission reply /
    // question reply+reject) are a separate admission lane: they serve from the
    // pre-barrier InstanceStore.snapshot and NEVER gate.acquire / store.load /
    // boot a runtime. Snapshot-first admission removes the racy
    // `isBarrierActive` engagement — a control with a cached instance completes
    // whether or not a writer barrier is observable at request time.
    //
    // LOCK-002/003: a control served from a cached instance holds an
    // identity-keyed ControlLease until its handler fully completes
    // (`Effect.ensuring` releases on success/failure/interruption). A writer
    // seals the identity and drains outstanding leases before disposing it, so
    // the control can never race old-instance disposal. If the identity is
    // already sealed (writer is draining and about to dispose), the request is
    // refused deterministically — the same semantics as the no-snapshot case.
    // The barrier check survives only to refuse deterministically (409) when a
    // barrier is active and the directory has no cached instance — no synthetic
    // InstanceContext is ever built. Without a barrier and without a snapshot,
    // the control falls through to the normal gate path so never-booted
    // directories keep their existing boot + process semantics. Classification
    // is exact segment matching in the Kilo helper (fail-closed decoding and
    // route ID schemas); no near-match, traversal, or encoded shape can match.
    const control = classifyDrainControl(request.method, path)
    if (control) {
      const snap = yield* store.snapshot(dir)
      if (snap._tag === "Some") {
        const lease = yield* Effect.sync(() => leases.acquire(snap.value))
        if (lease._tag === "Some") {
          return yield* serveControlFromSnapshot(effect, snap.value, route.workspaceID, request).pipe(
            Effect.ensuring(lease.value),
          )
        }
        return unavailable(control)
      }
      if (gate.isBarrierActive(dir)) return unavailable(control)
    }
    // kilocode_change end
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
    const leases = Option.getOrElse(yield* Effect.serviceOption(ControlLease.Service), () => ControlLease.noop) // kilocode_change
    return InstanceContextMiddleware.of((effect) => provideInstanceContext(effect, store, gate, leases)) // kilocode_change
  }),
)
