// vscode mock is provided by the shared preload (tests/setup/vscode-mock.ts)
import { describe, expect, test } from "bun:test"
import { KiloConnectionService } from "../../src/services/cli-backend/connection-service"

function withFixtureEnv(): () => void {
  const prev = process.env.KILO_E2E_FIXTURE
  process.env.KILO_E2E_FIXTURE = "1"
  return () => {
    if (prev === undefined) delete process.env.KILO_E2E_FIXTURE
    else process.env.KILO_E2E_FIXTURE = prev
  }
}

type Mutable = {
  privatePeer: unknown
  privateEpoch: number | null
  privatePid: number | undefined
  liveEventSource: "private" | "sse" | null
  state: string
  sseClient: unknown
  serverManager: unknown
}

function svcWith(epoch: number | null, pid: number | undefined): { svc: KiloConnectionService; anySvc: Mutable } {
  const svc = new KiloConnectionService({} as never)
  const anySvc = svc as unknown as Mutable
  anySvc.privateEpoch = epoch
  anySvc.privatePid = pid
  anySvc.liveEventSource = "private"
  anySvc.state = "connected"
  anySvc.sseClient = null
  return { svc, anySvc }
}

function peerWith(hook?: () => void): { peer: { fixtureCloseUnderlyingTransportForEvent: () => { closed: boolean; state: string } }; calls: () => number } {
  let calls = 0
  const peer = {
    fixtureCloseUnderlyingTransportForEvent: () => {
      calls += 1
      hook?.()
      return { closed: true, state: "closed" }
    },
  }
  return { peer, calls: () => calls }
}

describe("fixturePrivateEventClosePeer owner gating (stale/no-op never disposes)", () => {
  test("stale epoch throws and never disposes borrowed peer", async () => {
    const restore = withFixtureEnv()
    try {
      const { svc, anySvc } = svcWith(8, 4343)
      const { peer, calls } = peerWith()
      anySvc.privatePeer = peer
      anySvc.serverManager = {
        closePrivatePipesForFixture: () => ({ closed: false, alreadyClosed: false, pid: 4343, port: 4124, epoch: 9 }),
      }
      const err = await svc.fixturePrivateEventClosePeer().then(
        () => null,
        (e: unknown) => e,
      )
      expect(err).not.toBeNull()
      expect(String((err as Error).message)).toContain("owner")
      expect(calls()).toBe(0)
    } finally {
      restore()
    }
  })

  test("foreign pid throws and never disposes borrowed peer", async () => {
    const restore = withFixtureEnv()
    try {
      const { svc, anySvc } = svcWith(9, 9999)
      const { peer, calls } = peerWith()
      anySvc.privatePeer = peer
      anySvc.serverManager = {
        closePrivatePipesForFixture: () => ({ closed: false, alreadyClosed: false, pid: 4343, port: 4124, epoch: 9 }),
      }
      const err = await svc.fixturePrivateEventClosePeer().then(
        () => null,
        (e: unknown) => e,
      )
      expect(err).not.toBeNull()
      expect(String((err as Error).message)).toContain("owner")
      expect(calls()).toBe(0)
    } finally {
      restore()
    }
  })

  test("already-closed no-op throws and never disposes borrowed peer", async () => {
    const restore = withFixtureEnv()
    try {
      const { svc, anySvc } = svcWith(9, 4343)
      const { peer, calls } = peerWith()
      anySvc.privatePeer = peer
      anySvc.serverManager = {
        closePrivatePipesForFixture: () => ({ closed: false, alreadyClosed: true, pid: 4343, port: 4124, epoch: 9 }),
      }
      const err = await svc.fixturePrivateEventClosePeer().then(
        () => null,
        (e: unknown) => e,
      )
      expect(err).not.toBeNull()
      expect(String((err as Error).message)).toContain("true-close")
      expect(calls()).toBe(0)
    } finally {
      restore()
    }
  })

  test("throwing owner action propagates and never disposes borrowed peer", async () => {
    const restore = withFixtureEnv()
    try {
      const { svc, anySvc } = svcWith(9, 4343)
      const { peer, calls } = peerWith()
      anySvc.privatePeer = peer
      anySvc.serverManager = {
        closePrivatePipesForFixture: () => {
          throw new Error("boom")
        },
      }
      const err = await svc.fixturePrivateEventClosePeer().then(
        () => null,
        (e: unknown) => e,
      )
      expect(err).not.toBeNull()
      expect(String((err as Error).message)).toContain("owner action threw")
      expect(calls()).toBe(0)
    } finally {
      restore()
    }
  })

  test("null owner (gate absent) throws and never claims close=true", async () => {
    const restore = withFixtureEnv()
    try {
      const { svc, anySvc } = svcWith(9, 4343)
      const { peer, calls } = peerWith()
      anySvc.privatePeer = peer
      anySvc.serverManager = { closePrivatePipesForFixture: () => null }
      const err = await svc.fixturePrivateEventClosePeer().then(
        () => null,
        (e: unknown) => e,
      )
      expect(err).not.toBeNull()
      expect(String((err as Error).message)).toContain("unavailable")
      expect(calls()).toBe(0)
    } finally {
      restore()
    }
  })

  test("true owner close disposes borrowed peer once and converges to SSE", async () => {
    const restore = withFixtureEnv()
    try {
      const { svc, anySvc } = svcWith(9, 4343)
      const { peer, calls } = peerWith(() => {
        anySvc.liveEventSource = "sse"
        anySvc.state = "connected"
        anySvc.sseClient = {}
      })
      anySvc.privatePeer = peer
      anySvc.serverManager = {
        closePrivatePipesForFixture: () => ({ closed: true, alreadyClosed: false, pid: 4343, port: 4124, epoch: 9 }),
      }
      const out = await svc.fixturePrivateEventClosePeer()
      expect(calls()).toBe(1)
      expect(out.close.closed).toBeTrue()
      expect(out.owner?.closed).toBeTrue()
      expect(out.owner?.pid).toBe(4343)
      expect(out.owner?.epoch).toBe(9)
      expect(out.after.source).toBe("sse")
    } finally {
      restore()
    }
  })
})
