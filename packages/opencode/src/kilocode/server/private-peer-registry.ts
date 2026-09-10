// kilocode_change - new file
/**
 * Process-owned private peer registry (CLI -> Extension discoverability).
 *
 * Single-owner exact-identity registration: while an open peer holds the
 * registry, every install fails closed with `Conflict` — same peer or
 * different peer alike. There is no refcount and no same-peer idempotent
 * lease. Each successful install owns exactly one exact release; release
 * is idempotent and clears only the current same peer. The fd carrier owns
 * the `JsonRpcPeer`/reader/writer lifecycle; this service owns only
 * discoverability and exact identity. It never calls `peer.dispose` and
 * never closes streams. No epoch, no generation method, no capability:
 * replacement is allowed only after the old identity released or closed.
 *
 * `request` is a generic transport primitive for the single installed
 * peer. Domain services must enforce their own capability/method contracts
 * on top of it; the registry itself does not negotiate methods or
 * capabilities. Requests run only on the current open *initialized* peer —
 * an uninitialized peer fails `Unavailable` without sending.
 *
 * Scope: production serve uses the default `AppLayer` only. Custom
 * `Server.listen(appLayer)` layers are not supported by this unit; the
 * carrier installs through the global `AppRuntime` identity.
 */

import { Context, Data, Effect, Layer, Option } from "effect"
import type { JsonRpcPeer } from "@/private-worker/peer"
import type { JsonRpcId } from "@/private-worker/json-rpc"

export class Unavailable extends Data.TaggedError("PrivatePeerUnavailable") {}

export class Conflict extends Data.TaggedError("PrivatePeerConflict") {}

export class Closed extends Data.TaggedError("PrivatePeerClosed") {}

export interface Call {
  readonly id: JsonRpcId
  /** Consumers must observe this (await/catch): `drop` rejects it. */
  readonly done: Promise<unknown>
  readonly drop: () => boolean
}

export interface Scope {
  readonly request: (method: string, params?: unknown) => Effect.Effect<Call, Unavailable>
  readonly drop: (id: JsonRpcId) => boolean
}

export interface Lease {
  readonly release: Effect.Effect<void>
}

export interface PrivatePeer {
  readonly install: (peer: JsonRpcPeer) => Effect.Effect<Lease, Conflict | Closed>
  readonly release: (peer: JsonRpcPeer) => Effect.Effect<void>
  readonly current: Effect.Effect<Option.Option<Scope>>
  readonly request: (method: string, params?: unknown) => Effect.Effect<Call, Unavailable>
}

export class Service extends Context.Service<Service, PrivatePeer>()("@kilocode/PrivatePeer") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    let held: JsonRpcPeer | null = null

    const alive = (peer: JsonRpcPeer | null): peer is JsonRpcPeer => !!peer && peer.getState() === "open"

    const sweep = (): void => {
      if (held && held.getState() !== "open") held = null
    }

    const release = (peer: JsonRpcPeer): Effect.Effect<void> =>
      Effect.sync(() => {
        if (held === peer) held = null
      })

    const dial = (owner: JsonRpcPeer, method: string, params?: unknown): Effect.Effect<Call, Unavailable> =>
      Effect.suspend(() => {
        if (held !== owner || owner.getState() !== "open") return Effect.fail(new Unavailable())
        // Transport needs the extension handshake: an uninitialized peer
        // must never emit. No frame is allocated and no id is consumed.
        if (!owner.isInitialized()) return Effect.fail(new Unavailable())
        const handle = owner.requestWithId(method, params)
        if (typeof handle.id === "number" && handle.id === -1) {
          sweep()
          return Effect.fail(new Unavailable())
        }
        const call: Call = {
          id: handle.id,
          done: handle.promise,
          drop: () => owner.cancel(handle.id),
        }
        return Effect.succeed(call)
      })

    const scopeFor = (owner: JsonRpcPeer): Scope => ({
      request: (method: string, params?: unknown) => dial(owner, method, params),
      drop: (id: JsonRpcId) => {
        if (held !== owner || owner.getState() !== "open") return false
        return owner.cancel(id)
      },
    })

    const install = (peer: JsonRpcPeer): Effect.Effect<Lease, Conflict | Closed> =>
      Effect.suspend((): Effect.Effect<Lease, Conflict | Closed> => {
        if (peer.getState() !== "open") return Effect.fail(new Closed())
        if (held !== null) {
          // Single owner: any open holder — same peer or not — fails the
          // install closed. A closed holder is swept so its replacement can
          // install without waiting on an explicit release.
          if (held.getState() !== "open") held = null
          else return Effect.fail(new Conflict())
        }
        held = peer
        return Effect.succeed({ release: release(peer) })
      })

    const current: Effect.Effect<Option.Option<Scope>> = Effect.suspend(() => {
      sweep()
      if (!held) return Effect.succeed(Option.none())
      return Effect.succeed(Option.some(scopeFor(held)))
    })

    const request = (method: string, params?: unknown): Effect.Effect<Call, Unavailable> =>
      Effect.suspend(() => {
        sweep()
        const owner = held
        if (!alive(owner)) {
          held = null
          return Effect.fail(new Unavailable())
        }
        return dial(owner, method, params)
      })

    return Service.of({ install, release, current, request })
  }),
)

export const defaultLayer = layer
export * as PrivatePeer from "./private-peer-registry"
