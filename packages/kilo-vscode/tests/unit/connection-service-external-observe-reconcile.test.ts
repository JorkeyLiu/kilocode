// vscode mock is provided by the shared preload (tests/setup/vscode-mock.ts)
import { describe, expect, it } from "bun:test"
import { KiloConnectionService } from "../../src/services/cli-backend/connection-service"

type Mutable = {
  privateEpoch: number | null
  privateAvailable: boolean
  privatePeer: unknown
  completePrivateNegotiation: (peer: unknown, ok: boolean, pid: number | undefined, epoch: number) => void
  failPrivateNegotiation: (epoch: number, pid: number | undefined) => void
  disposePrivatePeer: () => void
}

function svcWithReconcile() {
  const svc = new KiloConnectionService({} as never)
  const anySvc = svc as unknown as Mutable
  let calls = 0
  const fake = { reconcileExternalObserve: () => void (calls += 1) }
  svc.setCanonicalConfigService(fake as never)
  return { svc, anySvc, calls: () => calls }
}

describe("connection-service external observe reconcile on FD-ready", () => {
  it("FD-ready negotiation success notifies and reconciles even with no listeners", () => {
    const { svc, anySvc, calls } = svcWithReconcile()
    anySvc.privateEpoch = 7
    const peer = { isAvailable: () => true }
    anySvc.completePrivateNegotiation(peer, true, 123, 7)
    expect(anySvc.privateAvailable).toBeTrue()
    expect(calls()).toBe(1)
  })

  it("HTTP-only definitive failure never reconciles", () => {
    const { anySvc, calls } = svcWithReconcile()
    anySvc.privateEpoch = 7
    anySvc.failPrivateNegotiation(7, 123)
    expect(calls()).toBe(0)
  })

  it("quarantine recovery reconciles once; repeat ready does not duplicate", async () => {
    const { svc, anySvc, calls } = svcWithReconcile()
    const peer = {
      ensureRecovered: async () => true,
      isAvailable: () => true,
    }
    anySvc.privatePeer = peer
    anySvc.privateEpoch = 9
    anySvc.privateAvailable = false
    expect(await svc.ensurePrivateRecovered()).toBeTrue()
    expect(calls()).toBe(1)
    // Already available: early return, no second notify/reconcile.
    expect(await svc.ensurePrivateRecovered()).toBeTrue()
    expect(calls()).toBe(1)
  })

  it("stale epoch completion and close never reconcile", () => {
    const { anySvc, calls } = svcWithReconcile()
    anySvc.privateEpoch = 10
    anySvc.privateAvailable = true
    const stale = { isAvailable: () => true }
    anySvc.completePrivateNegotiation(stale, true, 123, 9)
    expect(calls()).toBe(0)
    expect(anySvc.privateAvailable).toBeTrue()
    anySvc.disposePrivatePeer()
    expect(calls()).toBe(0)
  })

  it("throwing listener does not block other sessions or reconcile", () => {
    const { svc, anySvc, calls } = svcWithReconcile()
    let second = 0
    svc.onPrivateAvailable(() => {
      throw new Error("boom")
    })
    svc.onPrivateAvailable(() => void (second += 1))
    anySvc.privateEpoch = 11
    const peer = { isAvailable: () => true }
    anySvc.completePrivateNegotiation(peer, true, 123, 11)
    expect(second).toBe(1)
    expect(calls()).toBe(1)
  })
})
