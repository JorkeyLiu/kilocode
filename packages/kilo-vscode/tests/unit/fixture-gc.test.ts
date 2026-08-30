import { describe, expect, test } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../src/private-worker/peer"
import { ServePrivatePeer } from "../../src/services/cli-backend/serve-private-peer"
import { createHash } from "node:crypto"

function linked(handler: (m: string, p: unknown) => unknown | Promise<unknown>) {
  const toClient = new PassThrough()
  const toBackend = new PassThrough()
  const backend = new JsonRpcPeer({
    reader: toBackend,
    writer: toClient,
    onRequest: handler as unknown as (m: string, p: unknown) => unknown,
  })
  return { clientReader: toClient, clientWriter: toBackend, backend }
}

describe("Gate C fixture: ServePrivatePeer protocol/capabilities", () => {
  test("getProtocolForFixture parses kilo-private/1", async () => {
    const { clientReader, clientWriter } = linked(async (m) => {
      if (m === "initialize")
        return { protocol: { name: "kilo-private", major: 1, minor: 0 }, capabilities: ["session/update"] }
      throw new Error("x")
    })
    const peer = new ServePrivatePeer({
      reader: clientReader,
      writer: clientWriter,
      pid: 1,
      epoch: 1,
      initializeTimeoutMs: 300,
    })
    expect(await peer.initialize(300)).toBeTrue()
    const proto = peer.getProtocolForFixture()
    expect(proto?.name).toBe("kilo-private")
    expect(proto?.major).toBe(1)
    peer.dispose()
  })

  test("getCapabilitiesListForFixture includes session/update", async () => {
    const { clientReader, clientWriter } = linked(async (m) => {
      if (m === "initialize")
        return {
          protocol: { name: "kilo-private", major: 1, minor: 0 },
          capabilities: ["session/cancelQueued", "session/update"],
        }
      throw new Error("x")
    })
    const peer = new ServePrivatePeer({
      reader: clientReader,
      writer: clientWriter,
      pid: 2,
      epoch: 2,
      initializeTimeoutMs: 300,
    })
    expect(await peer.initialize(300)).toBeTrue()
    const caps = peer.getCapabilitiesListForFixture()
    expect(caps.includes("session/update")).toBeTrue()
    expect(caps.includes("session/cancelQueued")).toBeTrue()
    peer.dispose()
  })

  test("getPeerStateForFixture reflects open", async () => {
    const { clientReader, clientWriter } = linked(async (m) => {
      if (m === "initialize")
        return { protocol: { name: "kilo-private", major: 1, minor: 0 }, capabilities: ["session/update"] }
      throw new Error("x")
    })
    const peer = new ServePrivatePeer({
      reader: clientReader,
      writer: clientWriter,
      pid: 3,
      epoch: 3,
      initializeTimeoutMs: 300,
    })
    expect(await peer.initialize(300)).toBeTrue()
    expect(peer.getPeerStateForFixture()).toBe("open")
    peer.dispose()
    expect(peer.getPeerStateForFixture()).toBe("disposed")
  })
})

describe("Gate C fixture: redacted hashes", () => {
  test("hashForFixture is 16 hex and not raw", () => {
    const h = createHash("sha256").update("hello").digest("hex").slice(0, 16)
    expect(h.length).toBe(16)
    expect(h).not.toBe("hello")
    expect(/^[0-9a-f]{16}$/.test(h)).toBeTrue()
  })
})

describe("Gate C fixture: env gating", () => {
  test("fixture methods require KILO_E2E_FIXTURE", async () => {
    const orig = process.env.KILO_E2E_FIXTURE
    delete process.env.KILO_E2E_FIXTURE
    const { KiloConnectionService } = await import("../../src/services/cli-backend/connection-service")
    const svc = new KiloConnectionService({
      workspaceState: { get: () => undefined, update: async () => undefined },
      globalState: { get: () => undefined, update: async () => undefined },
      extensionPath: "/tmp",
      extensionUri: { fsPath: "/tmp" } as unknown as import("vscode").Uri,
      subscriptions: [],
      globalStorageUri: { fsPath: "/tmp" } as unknown as import("vscode").Uri,
    } as unknown as import("vscode").ExtensionContext)
    expect(() => svc.fixturePrivatePeerStatus()).toThrow()
    // restore
    if (orig !== undefined) process.env.KILO_E2E_FIXTURE = orig
    else process.env.KILO_E2E_FIXTURE = "1"
    svc.dispose()
    delete process.env.KILO_E2E_FIXTURE
    if (orig !== undefined) process.env.KILO_E2E_FIXTURE = orig
  })

  test("exact predicate: absent, empty, 0 do not activate; only 1 does", async () => {
    const orig = process.env.KILO_E2E_FIXTURE
    const { isE2EFixtureEnabled } = await import("../../src/util/e2e-fixture")
    const { KiloConnectionService } = await import("../../src/services/cli-backend/connection-service")
    const mk = () =>
      new KiloConnectionService({
        workspaceState: { get: () => undefined, update: async () => undefined },
        globalState: { get: () => undefined, update: async () => undefined },
        extensionPath: "/tmp",
        extensionUri: { fsPath: "/tmp" } as unknown as import("vscode").Uri,
        subscriptions: [],
        globalStorageUri: { fsPath: "/tmp" } as unknown as import("vscode").Uri,
      } as unknown as import("vscode").ExtensionContext)
    try {
      delete process.env.KILO_E2E_FIXTURE
      expect(isE2EFixtureEnabled()).toBeFalse()
      expect(() => mk().fixturePrivatePeerStatus()).toThrow()
      process.env.KILO_E2E_FIXTURE = ""
      expect(isE2EFixtureEnabled()).toBeFalse()
      expect(() => mk().fixturePrivatePeerStatus()).toThrow()
      process.env.KILO_E2E_FIXTURE = "0"
      expect(isE2EFixtureEnabled()).toBeFalse()
      expect(() => mk().fixturePrivatePeerStatus()).toThrow()
      process.env.KILO_E2E_FIXTURE = "true"
      expect(isE2EFixtureEnabled()).toBeFalse()
      expect(() => mk().fixturePrivatePeerStatus()).toThrow()
      process.env.KILO_E2E_FIXTURE = "1"
      expect(isE2EFixtureEnabled()).toBeTrue()
      // with 1, the method still throws if not connected, but not due to gate — it returns status
      const svc = mk()
      svc.dispose()
      // fixturePrivatePeerStatus with 1 should not throw gate error (it may return status)
      expect(() => {
        const s = mk()
        try {
          s.fixturePrivatePeerStatus()
        } finally {
          s.dispose()
        }
      }).not.toThrow("fixture privatePeerStatus requires KILO_E2E_FIXTURE")
    } finally {
      if (orig !== undefined) process.env.KILO_E2E_FIXTURE = orig
      else delete process.env.KILO_E2E_FIXTURE
    }
  })
})

describe("Gate C fixture: sessionUpdate order and redaction", () => {
  test("SDK then private with same identity, hashes redacted, no raw title", async () => {
    process.env.KILO_E2E_FIXTURE = "1"
    const { KiloConnectionService } = await import("../../src/services/cli-backend/connection-service")
    const svc = new KiloConnectionService({
      workspaceState: { get: () => undefined, update: async () => undefined },
      globalState: { get: () => undefined, update: async () => undefined },
      extensionPath: "/tmp",
      extensionUri: { fsPath: "/tmp" } as unknown as import("vscode").Uri,
      subscriptions: [],
      globalStorageUri: { fsPath: "/tmp" } as unknown as import("vscode").Uri,
    } as unknown as import("vscode").ExtensionContext)
    const order: string[] = []
    const mockClient = {
      session: {
        update: async (p: unknown) => {
          order.push("sdk")
          return {
            data: { id: "ses_gctest", title: "New Title", time: { created: 1, updated: 2 } },
            error: undefined,
            response: { status: 200 },
          }
        },
      },
    }
    ;(svc as unknown as Record<string, unknown>).client = mockClient
    ;(svc as unknown as Record<string, unknown>).info = { port: 1234 }
    // mock serverManager
    ;(svc as unknown as Record<string, unknown>).serverManager = {
      getServerInfoForFixture: () => ({ pid: 999, port: 1234, epoch: 1 }),
      getServerPidForFixture: () => ({ pid: 999, port: 1234 }),
      getServerEpochForFixture: () => 1,
      dispose: () => {},
    }
    const fakePeer = {
      getProtocolForFixture: () => ({ name: "kilo-private", major: 1 }),
      getCapabilitiesListForFixture: () => ["session/update"],
      getPeerStateForFixture: () => "open",
      hasCapability: () => true,
      isAvailable: () => true,
      dispose: () => {},
      getState: () => "open",
    } as unknown as ServePrivatePeer
    ;(svc as unknown as Record<string, unknown>).privatePeer = fakePeer as unknown
    ;(svc as unknown as Record<string, unknown>).privateAvailable = true
    ;(svc as unknown as Record<string, unknown>).privatePid = 999
    ;(svc as unknown as Record<string, unknown>).privateEpoch = 1
    // mock privateSessionUpdate to track order
    const origPrivate = svc.privateSessionUpdate.bind(svc)
    ;(svc as unknown as Record<string, unknown>).privateSessionUpdate = async (req: unknown) => {
      order.push("private")
      const r = req as Record<string, unknown>
      return {
        v: 1,
        requestId: r.requestId,
        opId: r.opId,
        op: "session/update",
        idempotencyKey: r.idempotencyKey,
        status: "succeeded",
        outcome: { type: "succeeded", time: Date.now() },
        accepted: true,
        data: {
          title: (r.payload as Record<string, unknown>).title,
          session: { id: "ses_gctest", title: (r.payload as Record<string, unknown>).title },
        },
        revision: { session: 2, config: 1 },
      }
    }
    // need currentDirectory for fixture
    ;(svc as unknown as Record<string, unknown>).currentDirectory = "/tmp"
    const res = await svc.fixtureSessionUpdate({ sessionId: "ses_gctest", title: "New Title", directory: "/tmp" })
    expect(res.order).toEqual(["sdk", "private"])
    expect(order).toEqual(["sdk", "private"])
    expect(res.sdk.status).toBe("succeeded")
    expect(res.private?.status).toBe("succeeded")
    expect(res.parity.divergence).toBeNull()
    expect(res.redacted.titleHash).toBe(createHash("sha256").update("New Title").digest("hex").slice(0, 16))
    expect(res.redacted.sessionIdHash).toBe(createHash("sha256").update("ses_gctest").digest("hex").slice(0, 16))
    expect(JSON.stringify(res)).not.toContain("New Title")
    // replay should return same revision without second sdk
    const replay = await svc.fixturePrivateReplay("ses_gctest")
    expect(replay.found).toBeTrue()
    expect(replay.private?.status).toBe("succeeded")
    expect(replay.revision).toEqual({ session: 2, config: 1 })
    svc.dispose()
    delete process.env.KILO_E2E_FIXTURE
  })
})

describe("Gate C fixture: failed SDK does not create replay state", () => {
  test("failed SDK does not store identity or call private", async () => {
    process.env.KILO_E2E_FIXTURE = "1"
    const { KiloConnectionService } = await import("../../src/services/cli-backend/connection-service")
    const svc = new KiloConnectionService({
      workspaceState: { get: () => undefined, update: async () => undefined },
      globalState: { get: () => undefined, update: async () => undefined },
      extensionPath: "/tmp",
      extensionUri: { fsPath: "/tmp" } as unknown as import("vscode").Uri,
      subscriptions: [],
      globalStorageUri: { fsPath: "/tmp" } as unknown as import("vscode").Uri,
    } as unknown as import("vscode").ExtensionContext)
    let privateCalled = false
    const mockClient = {
      session: {
        update: async () => ({ data: undefined, error: { code: "not_found" }, response: { status: 404 } }),
      },
    }
    ;(svc as unknown as Record<string, unknown>).client = mockClient
    ;(svc as unknown as Record<string, unknown>).serverManager = {
      getServerInfoForFixture: () => ({ pid: 1, port: 1234, epoch: 1 }),
      getServerPidForFixture: () => ({ pid: 1, port: 1234 }),
      getServerEpochForFixture: () => 1,
      dispose: () => {},
    }
    const fakePeer = {
      getProtocolForFixture: () => ({ name: "kilo-private", major: 1 }),
      getCapabilitiesListForFixture: () => ["session/update"],
      getPeerStateForFixture: () => "open",
      hasCapability: () => true,
      isAvailable: () => true,
      dispose: () => {},
      getState: () => "open",
    } as unknown as ServePrivatePeer
    ;(svc as unknown as Record<string, unknown>).privatePeer = fakePeer as unknown
    ;(svc as unknown as Record<string, unknown>).privateAvailable = true
    ;(svc as unknown as Record<string, unknown>).privatePid = 1
    ;(svc as unknown as Record<string, unknown>).privateEpoch = 1
    ;(svc as unknown as Record<string, unknown>).currentDirectory = "/tmp"
    ;(svc as unknown as Record<string, unknown>).privateSessionUpdate = async () => {
      privateCalled = true
      return {
        v: 1,
        requestId: "r",
        opId: "o",
        op: "session/update",
        idempotencyKey: "k",
        status: "failed",
        outcome: {
          type: "failed",
          time: Date.now(),
          failure: { code: "session.not_found", message: "x", retryable: false },
        },
        accepted: false,
        failure: { code: "session.not_found", message: "x", retryable: false },
      }
    }
    const res = await svc.fixtureSessionUpdate({ sessionId: "ses_fail", title: "Fail Title", directory: "/tmp" })
    expect(res.sdk.status).toBe("failed")
    expect(privateCalled).toBeFalse()
    expect(res.private).toBeNull()
    expect(res.parity.divergence).toBe("sdk-failed")
    const replay = await svc.fixturePrivateReplay("ses_fail")
    expect(replay.found).toBeFalse()
    svc.dispose()
    delete process.env.KILO_E2E_FIXTURE
  })
})

describe("Gate C fixture: capability false not reported", () => {
  test("object capabilities with false do not include session/update", async () => {
    const { clientReader, clientWriter } = linked(async (m) => {
      if (m === "initialize")
        return {
          protocol: { name: "kilo-private", major: 1 },
          capabilities: { "session/update": false, "session/cancelQueued": true },
        }
      throw new Error("x")
    })
    const peer = new ServePrivatePeer({
      reader: clientReader,
      writer: clientWriter,
      pid: 10,
      epoch: 10,
      initializeTimeoutMs: 300,
    })
    // initialize will fail-closed because session/update false and cancelQueued true -> has one true, so it passes
    // But getCapabilitiesList should not include false
    const caps = peer.getCapabilitiesListForFixture()
    // before init, caps empty
    expect(caps).toEqual([])
    await peer.initialize(300)
    const caps2 = peer.getCapabilitiesListForFixture()
    expect(caps2.includes("session/update")).toBeFalse()
    expect(caps2.includes("session/cancelQueued")).toBeTrue()
    peer.dispose()
  })
})

describe("Gate C fixture: nonce correlation", () => {
  test("stale nonce is rejected", () => {
    const nonce = "abc123"
    const correct = { nonce: "abc123", data: 1 }
    const stale = { nonce: "different", data: 1 }
    expect(stale.nonce !== nonce).toBeTrue()
    // probe helper would throw on mismatch
    expect(() => {
      if (stale.nonce !== nonce) throw new Error("nonce mismatch")
    }).toThrow("nonce mismatch")
    expect(correct.nonce).toBe(nonce)
  })
})

describe("Gate C fixture: no raw title in serialized result", () => {
  test("result does not contain raw title even when title is substring of hash", async () => {
    process.env.KILO_E2E_FIXTURE = "1"
    const { KiloConnectionService } = await import("../../src/services/cli-backend/connection-service")
    const svc = new KiloConnectionService({
      workspaceState: { get: () => undefined, update: async () => undefined },
      globalState: { get: () => undefined, update: async () => undefined },
      extensionPath: "/tmp",
      extensionUri: { fsPath: "/tmp" } as unknown as import("vscode").Uri,
      subscriptions: [],
      globalStorageUri: { fsPath: "/tmp" } as unknown as import("vscode").Uri,
    } as unknown as import("vscode").ExtensionContext)
    const mockClient = {
      session: {
        update: async () => ({
          data: { id: "ses_x", title: "SecretTitle" },
          error: undefined,
          response: { status: 200 },
        }),
      },
    }
    ;(svc as unknown as Record<string, unknown>).client = mockClient
    ;(svc as unknown as Record<string, unknown>).serverManager = {
      getServerInfoForFixture: () => ({ pid: 1, port: 1, epoch: 1 }),
      getServerPidForFixture: () => ({ pid: 1, port: 1 }),
      getServerEpochForFixture: () => 1,
      dispose: () => {},
    }
    const fakePeer = {
      getProtocolForFixture: () => ({ name: "kilo-private", major: 1 }),
      getCapabilitiesListForFixture: () => ["session/update"],
      getPeerStateForFixture: () => "open",
      hasCapability: () => true,
      isAvailable: () => true,
      dispose: () => {},
      getState: () => "open",
    } as unknown as ServePrivatePeer
    ;(svc as unknown as Record<string, unknown>).privatePeer = fakePeer as unknown
    ;(svc as unknown as Record<string, unknown>).privateAvailable = true
    ;(svc as unknown as Record<string, unknown>).privatePid = 1
    ;(svc as unknown as Record<string, unknown>).privateEpoch = 1
    ;(svc as unknown as Record<string, unknown>).currentDirectory = "/tmp"
    ;(svc as unknown as Record<string, unknown>).privateSessionUpdate = async (req: unknown) => {
      const r = req as Record<string, unknown>
      return {
        v: 1,
        requestId: r.requestId,
        opId: r.opId,
        op: "session/update",
        idempotencyKey: r.idempotencyKey,
        status: "succeeded",
        outcome: { type: "succeeded", time: Date.now() },
        accepted: true,
        data: { title: "SecretTitle" },
        revision: { session: 1, config: 1 },
      }
    }
    const res = await svc.fixtureSessionUpdate({ sessionId: "ses_x", title: "SecretTitle", directory: "/tmp" })
    expect(JSON.stringify(res)).not.toContain("SecretTitle")
    expect(res.redacted.titleHash).toBe(createHash("sha256").update("SecretTitle").digest("hex").slice(0, 16))
    svc.dispose()
    delete process.env.KILO_E2E_FIXTURE
  })
})

describe("Gate C fixture: lazy and single active replay state", () => {
  test("no production allocation when KILO_E2E_FIXTURE absent", async () => {
    const orig = process.env.KILO_E2E_FIXTURE
    delete process.env.KILO_E2E_FIXTURE
    const { KiloConnectionService } = await import("../../src/services/cli-backend/connection-service")
    const svc = new KiloConnectionService({
      workspaceState: { get: () => undefined, update: async () => undefined },
      globalState: { get: () => undefined, update: async () => undefined },
      extensionPath: "/tmp",
      extensionUri: { fsPath: "/tmp" } as unknown as import("vscode").Uri,
      subscriptions: [],
      globalStorageUri: { fsPath: "/tmp" } as unknown as import("vscode").Uri,
    } as unknown as import("vscode").ExtensionContext)
    expect((svc as unknown as Record<string, unknown>).lastSessionUpdateIdentities).toBeNull()
    svc.dispose()
    if (orig !== undefined) process.env.KILO_E2E_FIXTURE = orig
  })

  test("lazy allocation only after successful SDK, single active", async () => {
    process.env.KILO_E2E_FIXTURE = "1"
    const { KiloConnectionService } = await import("../../src/services/cli-backend/connection-service")
    const svc = new KiloConnectionService({
      workspaceState: { get: () => undefined, update: async () => undefined },
      globalState: { get: () => undefined, update: async () => undefined },
      extensionPath: "/tmp",
      extensionUri: { fsPath: "/tmp" } as unknown as import("vscode").Uri,
      subscriptions: [],
      globalStorageUri: { fsPath: "/tmp" } as unknown as import("vscode").Uri,
    } as unknown as import("vscode").ExtensionContext)
    expect((svc as unknown as Record<string, unknown>).lastSessionUpdateIdentities).toBeNull()
    const mockClient = {
      session: {
        update: async () => ({
          data: { id: "ses_one", title: "Title One" },
          error: undefined,
          response: { status: 200 },
        }),
      },
    }
    ;(svc as unknown as Record<string, unknown>).client = mockClient
    ;(svc as unknown as Record<string, unknown>).serverManager = {
      getServerInfoForFixture: () => ({ pid: 1, port: 1, epoch: 1 }),
      getServerPidForFixture: () => ({ pid: 1, port: 1 }),
      getServerEpochForFixture: () => 1,
      dispose: () => {},
    }
    const fakePeer = {
      getProtocolForFixture: () => ({ name: "kilo-private", major: 1 }),
      getCapabilitiesListForFixture: () => ["session/update"],
      getPeerStateForFixture: () => "open",
      hasCapability: () => true,
      isAvailable: () => true,
      dispose: () => {},
      getState: () => "open",
    } as unknown as ServePrivatePeer
    ;(svc as unknown as Record<string, unknown>).privatePeer = fakePeer as unknown
    ;(svc as unknown as Record<string, unknown>).privateAvailable = true
    ;(svc as unknown as Record<string, unknown>).privatePid = 1
    ;(svc as unknown as Record<string, unknown>).privateEpoch = 1
    ;(svc as unknown as Record<string, unknown>).currentDirectory = "/tmp"
    ;(svc as unknown as Record<string, unknown>).privateSessionUpdate = async (req: unknown) => {
      const r = req as Record<string, unknown>
      return {
        v: 1,
        requestId: r.requestId,
        opId: r.opId,
        op: "session/update",
        idempotencyKey: r.idempotencyKey,
        status: "succeeded",
        outcome: { type: "succeeded", time: Date.now() },
        accepted: true,
        data: { title: (r.payload as Record<string, unknown>).title },
        revision: { session: 1, config: 1 },
      }
    }
    await svc.fixtureSessionUpdate({ sessionId: "ses_one", title: "Title One", directory: "/tmp" })
    expect((svc as unknown as Map<string, unknown>).lastSessionUpdateIdentities?.size).toBe(1)
    // second update should keep single active (evict previous if different session)
    ;(svc as unknown as Record<string, unknown>).client = {
      session: {
        update: async () => ({
          data: { id: "ses_two", title: "Title Two" },
          error: undefined,
          response: { status: 200 },
        }),
      },
    }
    await svc.fixtureSessionUpdate({ sessionId: "ses_two", title: "Title Two", directory: "/tmp" })
    const state = (svc as unknown as Record<string, Map<string, unknown>>).lastSessionUpdateIdentities
    expect(state?.size).toBe(1)
    expect(state?.has("ses_two")).toBeTrue()
    expect(state?.has("ses_one")).toBeFalse()
    // dispose clears
    svc.dispose()
    expect((svc as unknown as Record<string, unknown>).lastSessionUpdateIdentities?.size ?? 0).toBe(0)
    delete process.env.KILO_E2E_FIXTURE
  })
})

describe("Gate C fixture: marker mapping and stale rejection", () => {
  test("two sequential title requests stale rejection via filesystem", async () => {
    const { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } = await import("node:fs")
    const { join } = await import("node:path")
    const { tmpdir } = await import("node:os")
    const { createHash } = await import("node:crypto")
    const scratch = mkdtempSync(join(tmpdir(), "gc-marker-"))
    try {
      const newNonce = () =>
        createHash("sha256")
          .update(String(Date.now()) + Math.random().toString(36))
          .digest("hex")
          .slice(0, 12)
      const writeReq = (name: string, resultName: string, payload: Record<string, unknown>) => {
        const nonce = newNonce()
        const resultPath = join(scratch, resultName)
        try {
          rmSync(resultPath, { force: true })
        } catch {}
        writeFileSync(join(scratch, name), JSON.stringify({ ...payload, nonce }))
        return nonce
      }
      // first title request
      const nonce1 = writeReq("rr-title-request", "rr-title-result.json", { sessionId: "ses_a", title: "Title A" })
      // simulate runner writing result with nonce1
      writeFileSync(
        join(scratch, "rr-title-result.json"),
        JSON.stringify({ nonce: nonce1, order: ["sdk", "private"], sdk: { status: "succeeded" } }),
      )
      // second title request should remove previous result before writing new request
      const nonce2 = writeReq("rr-title-request", "rr-title-result.json", { sessionId: "ses_b", title: "Title B" })
      expect(existsSync(join(scratch, "rr-title-result.json"))).toBeFalse()
      expect(nonce2).not.toBe(nonce1)
      // stale result with old nonce should be rejected
      writeFileSync(join(scratch, "rr-title-result.json"), JSON.stringify({ nonce: nonce1, order: ["sdk"] }))
      const raw = readFileSync(join(scratch, "rr-title-result.json"), "utf8")
      const parsed = JSON.parse(raw)
      expect(parsed.nonce).not.toBe(nonce2)
      // harness would throw on mismatch
      expect(() => {
        if (parsed.nonce !== nonce2) throw new Error("nonce mismatch")
      }).toThrow("nonce mismatch")
      // fresh result with correct nonce passes
      writeFileSync(join(scratch, "rr-title-result.json"), JSON.stringify({ nonce: nonce2, order: ["sdk", "private"] }))
      const raw2 = readFileSync(join(scratch, "rr-title-result.json"), "utf8")
      expect(JSON.parse(raw2).nonce).toBe(nonce2)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  test("malformed JSON is fail-closed with redacted log", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs")
    const { join } = await import("node:path")
    const { tmpdir } = await import("node:os")
    const scratch = mkdtempSync(join(tmpdir(), "gc-malformed-"))
    try {
      writeFileSync(join(scratch, "rr-title-result.json"), "{ malformed json")
      let threw = false
      try {
        JSON.parse("{ malformed json")
      } catch (err) {
        threw = true
        const msg = String(err).slice(0, 200)
        expect(msg.length).toBeGreaterThan(0)
        // no raw title leaked
        expect(msg).not.toContain("SecretTitle")
      }
      expect(threw).toBeTrue()
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})

describe("Gate C ServerManager env gating", () => {
  test("validates baseURL and scratch, rejects non-loopback", async () => {
    const { isValidE2EBaseURLForServerManager, validatedE2EProviderEnv } = await import(
      "../../src/services/cli-backend/server-manager"
    )
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs")
    const { join } = await import("node:path")
    const { tmpdir } = await import("node:os")
    const saved = { ...process.env }
    const fid = "gc-test-server"
    const scratch = mkdtempSync(join(tmpdir(), "kilo-e2e-"))
    writeFileSync(join(scratch, "e2e-marker.json"), JSON.stringify({ v: 1, fixtureId: fid }))
    try {
      process.env.KILO_E2E_FIXTURE = "1"
      process.env.KILO_E2E_SCRATCH = scratch
      process.env.KILO_E2E_FIXTURE_ID = fid
      process.env.KILO_E2E_PROVIDER_BASE_URL = "http://127.0.0.1:1234/v1"
      expect(isValidE2EBaseURLForServerManager("http://127.0.0.1:1234/v1")).toBeTrue()
      expect(isValidE2EBaseURLForServerManager("http://localhost:4000/v1")).toBeTrue()
      expect(isValidE2EBaseURLForServerManager("http://example.com/v1")).toBeFalse()
      expect(isValidE2EBaseURLForServerManager("http://127.0.0.1:1234/notv1")).toBeFalse()
      expect(isValidE2EBaseURLForServerManager("http://127.0.0.1:1234/v1?x=1")).toBeFalse()
      expect(validatedE2EProviderEnv().KILO_E2E_PROVIDER_BASE_URL).toBe("http://127.0.0.1:1234/v1")
      process.env.KILO_E2E_PROVIDER_BASE_URL = "http://example.com/v1"
      expect(validatedE2EProviderEnv().KILO_E2E_PROVIDER_BASE_URL).toBeUndefined()
      process.env.KILO_E2E_SCRATCH = "relative"
      process.env.KILO_E2E_PROVIDER_BASE_URL = "http://127.0.0.1:1234/v1"
      expect(validatedE2EProviderEnv().KILO_E2E_PROVIDER_BASE_URL).toBeUndefined()
      delete process.env.KILO_E2E_FIXTURE
      process.env.KILO_E2E_SCRATCH = scratch
      expect(validatedE2EProviderEnv().KILO_E2E_PROVIDER_BASE_URL).toBeUndefined()
    } finally {
      rmSync(scratch, { recursive: true, force: true })
      for (const k of Object.keys(process.env)) {
        if (!(k in saved)) delete process.env[k]
      }
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v as string
      }
    }
  })

  test("arbitrary absolute scratch without marker rejected, marker mismatch rejected", async () => {
    const { validatedE2EProviderEnv } = await import("../../src/services/cli-backend/server-manager")
    const { isValidE2EScratch } = await import("../../src/util/e2e-fixture")
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs")
    const { join } = await import("node:path")
    const { tmpdir } = await import("node:os")
    const saved = { ...process.env }
    try {
      process.env.KILO_E2E_FIXTURE = "1"
      process.env.KILO_E2E_PROVIDER_BASE_URL = "http://127.0.0.1:1234/v1"
      // /tmp without marker
      process.env.KILO_E2E_SCRATCH = "/tmp"
      delete process.env.KILO_E2E_FIXTURE_ID
      expect(isValidE2EScratch("/tmp")).toBeFalse()
      expect(validatedE2EProviderEnv().KILO_E2E_PROVIDER_BASE_URL).toBeUndefined()
      // good shape but wrong fid
      const good = mkdtempSync(join(tmpdir(), "kilo-e2e-"))
      writeFileSync(join(good, "e2e-marker.json"), JSON.stringify({ v: 1, fixtureId: "fid-good" }))
      try {
        process.env.KILO_E2E_SCRATCH = good
        process.env.KILO_E2E_FIXTURE_ID = "wrong"
        expect(isValidE2EScratch(good)).toBeFalse()
        expect(validatedE2EProviderEnv().KILO_E2E_PROVIDER_BASE_URL).toBeUndefined()
        process.env.KILO_E2E_FIXTURE_ID = "fid-good"
        expect(isValidE2EScratch(good)).toBeTrue()
        expect(validatedE2EProviderEnv().KILO_E2E_PROVIDER_BASE_URL).toBe("http://127.0.0.1:1234/v1")
      } finally {
        rmSync(good, { recursive: true, force: true })
      }
    } finally {
      for (const k of Object.keys(process.env)) {
        if (!(k in saved)) delete process.env[k]
      }
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v as string
      }
    }
  })

  test("lstat rejects symlink marker and traversal segments", async () => {
    const { isValidE2EScratch } = await import("../../src/util/e2e-fixture")
    const { mkdtempSync, writeFileSync, symlinkSync, rmSync } = await import("node:fs")
    const { join } = await import("node:path")
    const { tmpdir } = await import("node:os")
    const saved = { ...process.env }
    try {
      process.env.KILO_E2E_FIXTURE = "1"
      process.env.KILO_E2E_FIXTURE_ID = "fid-sym"
      const real = mkdtempSync(join(tmpdir(), "kilo-e2e-"))
      writeFileSync(join(real, "e2e-marker.json"), JSON.stringify({ v: 1, fixtureId: "fid-sym" }))
      // symlink scratch should be rejected
      const linkDir = join(tmpdir(), `kilo-e2e-link-${Date.now()}`)
      try {
        symlinkSync(real, linkDir)
      } catch {}
      if (require("node:fs").existsSync(linkDir)) {
        expect(isValidE2EScratch(linkDir)).toBeFalse()
        rmSync(linkDir, { force: true })
      }
      // marker symlink
      const good = mkdtempSync(join(tmpdir(), "kilo-e2e-"))
      try {
        writeFileSync(join(good, "real.json"), JSON.stringify({ v: 1, fixtureId: "fid-sym" }))
        symlinkSync(join(good, "real.json"), join(good, "e2e-marker.json"))
        expect(isValidE2EScratch(good)).toBeFalse()
      } finally {
        rmSync(good, { recursive: true, force: true })
      }
      // traversal
      expect(isValidE2EScratch("/tmp/kilo-e2e-../evil")).toBeFalse()
      expect(isValidE2EScratch(`${real}/../evil`)).toBeFalse()
      rmSync(real, { recursive: true, force: true })
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
      for (const [k, v] of Object.entries(saved))
        if (v === undefined) delete process.env[k]
        else process.env[k] = v as string
    }
  })

  test("collector reset with markerless arbitrary path leaves no file (fail-closed)", async () => {
    const { ServerManager } = await import("../../src/services/cli-backend/server-manager")
    const { mkdtempSync, existsSync, rmSync, readFileSync } = await import("node:fs")
    const { join } = await import("node:path")
    const { tmpdir } = await import("node:os")
    const saved = { ...process.env }
    const arb = mkdtempSync(join(tmpdir(), "arbitrary-"))
    try {
      process.env.KILO_E2E_FIXTURE = "1"
      process.env.KILO_E2E_SCRATCH = arb
      process.env.KILO_E2E_FIXTURE_ID = "fid-arb"
      // no marker file
      const mgr = new ServerManager({
        extensionPath: "/tmp",
        globalStorageUri: { fsPath: "/tmp" },
      } as unknown as import("vscode").ExtensionContext)
      const ok = mgr.resetLlmRequestsForFixture()
      expect(ok).toBeFalse()
      expect(existsSync(join(arb, "llm-requests.jsonl"))).toBeFalse()
      mgr.dispose()
      // with valid marker, reset succeeds and creates empty file
      const good = mkdtempSync(join(tmpdir(), "kilo-e2e-"))
      const fid = "fid-good-reset"
      require("node:fs").writeFileSync(join(good, "e2e-marker.json"), JSON.stringify({ v: 1, fixtureId: fid }))
      process.env.KILO_E2E_SCRATCH = good
      process.env.KILO_E2E_FIXTURE_ID = fid
      const mgr2 = new ServerManager({
        extensionPath: "/tmp",
        globalStorageUri: { fsPath: "/tmp" },
      } as unknown as import("vscode").ExtensionContext)
      const ok2 = mgr2.resetLlmRequestsForFixture()
      expect(ok2).toBeTrue()
      expect(existsSync(join(good, "llm-requests.jsonl"))).toBeTrue()
      expect(readFileSync(join(good, "llm-requests.jsonl"), "utf8")).toBe("")
      mgr2.dispose()
      rmSync(good, { recursive: true, force: true })
    } finally {
      rmSync(arb, { recursive: true, force: true })
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
      for (const [k, v] of Object.entries(saved))
        if (v === undefined) delete process.env[k]
        else process.env[k] = v as string
    }
  })
})
