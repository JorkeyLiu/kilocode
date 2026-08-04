import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { Effect, Layer, Option } from "effect" // kilocode_change
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http" // kilocode_change
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { WorkspaceRouteContext } from "./workspace-routing"
// kilocode_change start - BLOCKER 1: gate instance load during writer barriers
import { GenerationGate } from "@/kilocode/server/generation-gate"
// kilocode_change end
// kilocode_change start - LOCK-004/006: drain-control bypass during writer barriers
import { classifyDrainControl, serveControlFromSnapshot, unavailable } from "@/kilocode/server/drain-control"
import { ControlLease } from "@/kilocode/server/control-lease"
// kilocode_change end
// kilocode_change start - LOCK-001/006: write-intent intake classification
import { isConfigWrite } from "@/kilocode/server/config-write-intent"
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

// kilocode_change start - LOCK-001/006 write-intent intake classification
// Config/auth write-intent routes never take ordinary reader admission
// (LOCK-001/006): their handlers register their own convergence fence and the
// save must never wait on an active fence, while the middleware load must never
// boot an unseen directory from pre-rebuild config. Exact route shapes are
// classified in `isConfigWrite` (src/kilocode/server/config-write-intent.ts);
// fail-closed on malformed shapes, so a near-match can never widen into a
// different route.
// kilocode_change end

// kilocode_change start - LOCK-006 write-lifetime refusal. A write-intent
// request whose loaded identity is already sealed by convergence for disposal
// is refused deterministically: the identity cannot remain valid until handler
// completion, and running against it would race the disposer. This is a
// decision, not a wait — LOCK-001/006 (writes never wait on a convergence
// fence) are unchanged, and the retry acquires the replacement identity.
const writeUnavailable = () =>
  HttpServerResponse.jsonUnsafe(
    {
      _tag: "InstanceUnavailableDuringConfigRebuild",
      lane: "write-intent",
      message: "Instance is unavailable during config rebuild; the loaded runtime is being converged, retry the save",
    },
    { status: 409 },
  )
// kilocode_change end

// kilocode_change start - BLOCKER 1: short-lease gate admission for store.load
// The reader lease covers ONLY the store.load phase. It is released
// immediately after load succeeds or fails via Effect.ensuring, before the
// handler runs. This prevents long-lived handlers (SSE, streaming) from
// holding the load gate and blocking writer barrier drain.
//
// Config PATCHes (/config, /config/overlay, /config/transaction) and the other
// config/auth write-intent routes must not take a reader lease: their handlers
// register their own convergence fence right after the load, and a held reader
// lease would either self-deadlock or block the save behind an active fence
// (LOCK-001/006). Instead they use `gate.prepareWrite`, a write-preparation
// admission that waits behind any active/queued global writer and holds a
// per-directory write intent only for the duration of the load — it never
// waits on a convergence fence, so hot and joining writes stay admission-free
// (LOCK-006). This closes the race where a PATCH for an unseen directory
// booted an instance from pre-rebuild config while a global writer barrier was
// active after it had captured its rebuild identities.
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
    if (isConfigWrite(request.method, path)) {
      const release = yield* gate.prepareWrite(dir)
      const ctx = yield* store.load({ directory: dir }).pipe(Effect.ensuring(release))
      // LOCK-006 (write lifetime): the prep admission covers ONLY the load —
      // it is released before the handler runs, so convergence (which waits
      // readers and control leases only) could dispose this exact runtime while
      // a hot/joining write handler is still using it. Acquire an
      // identity-keyed WRITE lifetime lease for the loaded InstanceRef right
      // after the load and hold it through the complete downstream handler
      // effect (`Effect.ensuring` releases on success, failure, and
      // interruption). Convergence seals and drains BOTH control and write
      // lifetimes before disposing an identity, so the loaded identity stays
      // valid until handler completion (LOCK-006) without any fence wait.
      // A sealed identity is already doomed for disposal — the loaded identity
      // cannot remain valid — so it is refused deterministically (never served);
      // the replacement identity acquires fine on retry.
      const writeLease = yield* Effect.sync(() => leases.acquireWrite(ctx))
      if (writeLease._tag === "None") return writeUnavailable()
      return yield* effect.pipe(
        Effect.provideService(InstanceRef, ctx),
        Effect.provideService(WorkspaceRef, route.workspaceID),
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        Effect.ensuring(writeLease.value),
      )
    }
    // LOCK-003/004/006: drain-control lane.
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
    // End of drain-control lane; fall through to the standard gate path below.
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
