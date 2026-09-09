import type { ServePrivatePeer } from "./serve-private-peer"

interface EpochConn {
  peer: ServePrivatePeer | null
  live: boolean
  epoch: number | null
  invalidate: (reason: string) => void
}

type OwnedHandle<TRes> = { id: number; promise: Promise<TRes>; cancel: (msg?: string) => boolean }

// Epoch-guarded private handle shared by private-first carriers. Allocates the
// exact request id synchronously, maps epoch drift or peer replacement to the
// caller-supplied `vague` outcome, and cancels the exact pending on timeout.
// A stale captured handle cleans only its captured peer; only a current-epoch
// exact-cancel miss invalidates the owner connection.
export function wrapEpochHandle<TReq extends { opId: string }, TRes>(input: {
  conn: EpochConn
  cap: string
  req: TReq
  call: (peer: ServePrivatePeer) => OwnedHandle<TRes>
  vague: (req: TReq) => TRes
}): OwnedHandle<TRes> {
  const at = input.conn.epoch
  const peer = input.conn.peer
  if (!peer || !input.conn.live || !peer.isAvailable()) throw new Error("Private peer unavailable")
  if (!peer.hasCapability(input.cap)) throw new Error(`Private peer missing ${input.cap} capability`)
  const handle = input.call(peer)
  const promise = handle.promise.then((result) => {
    if (at !== null && input.conn.epoch !== at) return input.vague(input.req)
    if (input.conn.peer !== peer) return input.vague(input.req)
    return result
  })
  const cancel = (msg = "private parity timeout"): boolean => {
    if (input.conn.peer !== peer || input.conn.epoch !== at) {
      try {
        peer.invalidateOnObserverTimeout(`stale observer timeout opId=${input.req.opId}`)
      } catch (err) {
        console.warn("[Kilo] stale observer cleanup failed:", String(err).slice(0, 200), { opId: input.req.opId })
      }
      return false
    }
    let ok = false
    try {
      ok = peer.tryCancelPending(handle.id as unknown as number, msg)
    } catch (err) {
      console.warn("[Kilo] observer timeout cancel failed:", String(err).slice(0, 200), { opId: input.req.opId })
      input.conn.invalidate(`observer timeout cancel throw opId=${input.req.opId}`)
      return false
    }
    if (!ok) input.conn.invalidate(`observer timeout exact cancel miss opId=${input.req.opId}`)
    return ok
  }
  return { id: handle.id, promise, cancel }
}
