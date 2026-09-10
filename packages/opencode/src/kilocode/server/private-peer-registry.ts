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
 * never closes streams. No epoch, no generation method: replacement is
 * allowed only after the old identity released or closed.
 *
 * Capability model: the reverse capability set (wire
 * `reverseCapabilities`) binds the exact fd carrier peer via one-time
 * `negotiate` publication. Install claims identity only; the initialize
 * handler publishes the normalized reverse offer through the exact
 * registration lease exactly once, before `peer.markInitialized`/handler
 * success commits. `request` is gated on initialized + negotiated and on
 * method-in-offered-set (one-to-one binding: method name is the
 * capability, avoiding a generic bypass). Transport-reserved names
 * (`initialize`, `$/cancelRequest`, any `$/` prefix) are never
 * negotiable and never callable; they are rejected at the parser and
 * re-checked here so a future generic caller cannot bypass. Unknown
 * non-reserved offered methods may still be sent; the host answers
 * MethodNotFound (forward compat). No metadata is added to the generic
 * `JsonRpcPeer` layer.
 *
 * `request` is a generic transport primitive for the single installed
 * peer. Domain services must enforce their own capability/method contracts
 * on top of it; the registry itself does not negotiate methods beyond the
 * offered-set gate. Requests run only on the current open *initialized*
 * *negotiated* peer — an uninitialized or unnegotiated peer fails
 * `Unavailable` without sending; a negotiated-but-unoffered method fails
 * `Unsupported` without allocating an id or emitting a frame.
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

export class Unsupported extends Data.TaggedError("PrivatePeerUnsupported")<{
  readonly capability: string
}> {}

export interface Call {
  readonly id: JsonRpcId
  /** Consumers must observe this (await/catch): `drop` rejects it. */
  readonly done: Promise<unknown>
  readonly drop: () => boolean
}

export interface Scope {
  readonly request: (method: string, params?: unknown) => Effect.Effect<Call, Unavailable | Unsupported>
  readonly drop: (id: JsonRpcId) => boolean
  readonly supports: (capability: string) => boolean
  readonly capabilities: readonly string[]
}

export interface Lease {
  readonly release: Effect.Effect<void>
  /** Single-use exact-peer capability publication; stale/closed fails closed. */
  readonly negotiate: (caps: readonly string[]) => Effect.Effect<void, Conflict | Closed>
}

export interface PrivatePeer {
  readonly install: (peer: JsonRpcPeer) => Effect.Effect<Lease, Conflict | Closed>
  readonly release: (peer: JsonRpcPeer) => Effect.Effect<void>
  /** Exact-peer one-time capability publication for the current holder. */
  readonly negotiate: (peer: JsonRpcPeer, caps: readonly string[]) => Effect.Effect<void, Conflict | Closed>
  readonly current: Effect.Effect<Option.Option<Scope>>
  readonly request: (method: string, params?: unknown) => Effect.Effect<Call, Unavailable | Unsupported>
  readonly supports: (capability: string) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, PrivatePeer>()("@kilocode/PrivatePeer") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    let held: JsonRpcPeer | null = null
    let caps: ReadonlySet<string> | null = null
    let capsList: readonly string[] = []
    let negotiated = false

    const alive = (peer: JsonRpcPeer | null): peer is JsonRpcPeer => !!peer && peer.getState() === "open"

    const sweep = (): void => {
      if (held && held.getState() !== "open") {
        held = null
        caps = null
        capsList = []
        negotiated = false
      }
    }

    const release = (peer: JsonRpcPeer): Effect.Effect<void> =>
      Effect.sync(() => {
        if (held === peer) {
          held = null
          caps = null
          capsList = []
          negotiated = false
        }
      })

    const isReserved = (name: string): boolean => {
      if (name === "initialize") return true
      if (name === "$/cancelRequest") return true
      if (name.startsWith("$/")) return true
      return false
    }

    const isWellFormedOffer = (offered: readonly string[]): boolean => {
      if (offered.length > 64) return false
      const seen = new Set<string>()
      for (const entry of offered) {
        if (typeof entry !== "string" || entry.length === 0 || entry.length > 128) return false
        if (entry.includes("\0")) return false
        if (isReserved(entry)) return false
        if (seen.has(entry)) return false
        seen.add(entry)
      }
      return true
    }

    const negotiate = (peer: JsonRpcPeer, offered: readonly string[]): Effect.Effect<void, Conflict | Closed> =>
      Effect.suspend((): Effect.Effect<void, Conflict | Closed> => {
        if (peer.getState() !== "open") return Effect.fail(new Closed())
        if (held !== peer) {
          if (held !== null && held.getState() !== "open") {
            held = null
            caps = null
            capsList = []
            negotiated = false
          }
          return Effect.fail(new Conflict())
        }
        if (held.getState() !== "open") {
          held = null
          caps = null
          capsList = []
          negotiated = false
          return Effect.fail(new Closed())
        }
        if (negotiated) return Effect.fail(new Conflict())
        if (!isWellFormedOffer(offered)) return Effect.fail(new Conflict())
        const copy = [...offered]
        caps = new Set(copy)
        capsList = Object.freeze(copy)
        negotiated = true
        return Effect.succeed(undefined)
      })

    const supportsFor = (owner: JsonRpcPeer, capability: string): boolean => {
      if (held !== owner || owner.getState() !== "open") return false
      if (!negotiated || !caps) return false
      return caps.has(capability)
    }

    const dial = (
      owner: JsonRpcPeer,
      method: string,
      params?: unknown,
    ): Effect.Effect<Call, Unavailable | Unsupported> =>
      Effect.suspend((): Effect.Effect<Call, Unavailable | Unsupported> => {
        if (held !== owner || owner.getState() !== "open") return Effect.fail(new Unavailable())
        // Transport needs the extension handshake: an uninitialized or
        // unnegotiated peer must never emit. No frame is allocated and no
        // id is consumed.
        if (!owner.isInitialized()) return Effect.fail(new Unavailable())
        if (!negotiated || !caps) return Effect.fail(new Unavailable())
        // Transport-reserved methods are never callable, even if offered.
        if (method === "initialize" || method === "$/cancelRequest" || method.startsWith("$/"))
          return Effect.fail(new Unsupported({ capability: method }))
        // One-to-one binding: the reverse method name is the capability.
        // Offered-but-unknown methods still send; the host answers
        // MethodNotFound. Unoffered methods fail here without an id/frame.
        if (!caps.has(method)) return Effect.fail(new Unsupported({ capability: method }))
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
      supports: (capability: string) => supportsFor(owner, capability),
      get capabilities(): readonly string[] {
        if (held !== owner || owner.getState() !== "open") return []
        if (!negotiated) return []
        return capsList
      },
    })

    const install = (peer: JsonRpcPeer): Effect.Effect<Lease, Conflict | Closed> =>
      Effect.suspend((): Effect.Effect<Lease, Conflict | Closed> => {
        if (peer.getState() !== "open") return Effect.fail(new Closed())
        if (held !== null) {
          // Single owner: any open holder — same peer or not — fails the
          // install closed. A closed holder is swept so its replacement can
          // install without waiting on an explicit release.
          if (held.getState() !== "open") {
            held = null
            caps = null
            capsList = []
            negotiated = false
          } else return Effect.fail(new Conflict())
        }
        held = peer
        caps = null
        capsList = []
        negotiated = false
        return Effect.succeed({ release: release(peer), negotiate: (offered) => negotiate(peer, offered) })
      })

    const current: Effect.Effect<Option.Option<Scope>> = Effect.suspend(() => {
      sweep()
      if (!held) return Effect.succeed(Option.none())
      return Effect.succeed(Option.some(scopeFor(held)))
    })

    const request = (method: string, params?: unknown): Effect.Effect<Call, Unavailable | Unsupported> =>
      Effect.suspend((): Effect.Effect<Call, Unavailable | Unsupported> => {
        sweep()
        const owner = held
        if (!alive(owner)) {
          held = null
          caps = null
          capsList = []
          negotiated = false
          return Effect.fail(new Unavailable())
        }
        return dial(owner, method, params)
      })

    const supports = (capability: string): Effect.Effect<boolean> =>
      Effect.sync(() => {
        sweep()
        const owner = held
        if (!owner) return false
        return supportsFor(owner, capability)
      })

    return Service.of({ install, release, negotiate, current, request, supports })
  }),
)

export const defaultLayer = layer
export * as PrivatePeer from "./private-peer-registry"
