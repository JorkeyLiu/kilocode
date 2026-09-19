import { describe, expect, test } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../src/private-worker/peer"
import {
  LEGACY_INITIALIZE_CAPABILITIES,
  SERVE_REVERSE_CAPABILITIES_MAX_COUNT,
  SERVE_REVERSE_CAPABILITY_MAX_LENGTH,
  ServePrivatePeer,
  normalizeReverseCapabilities,
} from "../../src/services/cli-backend/serve-private-peer"

interface Fixture {
  readonly clientReader: PassThrough
  readonly clientWriter: PassThrough
  readonly toClient: PassThrough
  readonly toBackend: PassThrough
  readonly backend: JsonRpcPeer
  readonly seen: { method: string; params: unknown }[]
}

function fixture(handler: (method: string, params: unknown) => unknown | Promise<unknown>): Fixture {
  const toClient = new PassThrough()
  const toBackend = new PassThrough()
  const seen: { method: string; params: unknown }[] = []
  const backend = new JsonRpcPeer({
    reader: toBackend,
    writer: toClient,
    onRequest: ((method: string, params: unknown) => {
      seen.push({ method, params })
      return handler(method, params)
    }) as unknown as (m: string, p: unknown) => unknown,
  })
  return { clientReader: toClient, clientWriter: toBackend, toClient, toBackend, backend, seen }
}

function okHandler(method: string): unknown {
  if (method === "initialize")
    return {
      protocol: { name: "kilo-private", major: 1, minor: 0 },
      serverInfo: { name: "kilo", version: "1" },
      capabilities: ["session/cancelQueued"],
    }
  throw new Error("unexpected")
}

function disposeAll(f: Fixture, peer: ServePrivatePeer): void {
  try {
    peer.dispose()
  } catch {}
  try {
    f.backend.dispose()
  } catch {}
  try {
    f.toClient.destroy()
  } catch {}
  try {
    f.toBackend.destroy()
  } catch {}
}

describe("serve private peer reverse capabilities", () => {
  test("default omitted sends legacy list and auto reverse offer", async () => {
    const f = fixture(okHandler)
    const peer = new ServePrivatePeer({ reader: f.clientReader, writer: f.clientWriter, pid: 501, epoch: 51 })
    try {
      expect(await peer.initialize(500)).toBeTrue()
      const init = f.seen.find((s) => s.method === "initialize")
      expect(init).toBeDefined()
      const params = init!.params as { capabilities: unknown; reverseCapabilities: unknown }
      expect(params.capabilities).toEqual([...LEGACY_INITIALIZE_CAPABILITIES])
      expect(params.reverseCapabilities).toEqual(["observation/changed"])
      expect(params.capabilities).not.toEqual(params.reverseCapabilities)
      expect(peer.hasCapability("session/cancelQueued")).toBeTrue()
    } finally {
      disposeAll(f, peer)
    }
  })

  test("explicit empty reverse offer sends legacy list and auto reverse", async () => {
    const f = fixture(okHandler)
    const peer = new ServePrivatePeer({
      reader: f.clientReader,
      writer: f.clientWriter,
      pid: 502,
      epoch: 52,
      reverseCapabilities: [],
    })
    try {
      expect(await peer.initialize(500)).toBeTrue()
      const init = f.seen.find((s) => s.method === "initialize")
      const params = init!.params as { capabilities: unknown; reverseCapabilities: unknown }
      expect(params.capabilities).toEqual([...LEGACY_INITIALIZE_CAPABILITIES])
      expect(params.reverseCapabilities).toEqual(["observation/changed"])
    } finally {
      disposeAll(f, peer)
    }
  })

  test("valid reverse offer is copied and immune to input mutation", async () => {
    const offered = ["reverse/a", "reverse/b"]
    const f = fixture(okHandler)
    const peer = new ServePrivatePeer({
      reader: f.clientReader,
      writer: f.clientWriter,
      pid: 503,
      epoch: 53,
      reverseCapabilities: offered,
    })
    try {
      expect(await peer.initialize(500)).toBeTrue()
      offered.push("reverse/late")
      const init = f.seen.find((s) => s.method === "initialize")
      const params = init!.params as { capabilities: unknown; reverseCapabilities: unknown }
      expect(params.reverseCapabilities).toEqual(["reverse/a", "reverse/b", "observation/changed"])
      expect(params.capabilities).toEqual([...LEGACY_INITIALIZE_CAPABILITIES])
    } finally {
      disposeAll(f, peer)
    }
  })

  test("duplicate reverse offer fails closed as unavailable", async () => {
    const f = fixture(okHandler)
    const peer = new ServePrivatePeer({
      reader: f.clientReader,
      writer: f.clientWriter,
      pid: 504,
      epoch: 54,
      reverseCapabilities: ["reverse/a", "reverse/a"],
    })
    try {
      expect(await peer.initialize(500)).toBeFalse()
      expect(peer.isAvailable()).toBeFalse()
      expect(f.seen.find((s) => s.method === "initialize")).toBeUndefined()
    } finally {
      disposeAll(f, peer)
    }
  })

  test("oversize reverse offer fails closed as unavailable", async () => {
    const f = fixture(okHandler)
    const peer = new ServePrivatePeer({
      reader: f.clientReader,
      writer: f.clientWriter,
      pid: 505,
      epoch: 55,
      reverseCapabilities: Array.from({ length: SERVE_REVERSE_CAPABILITIES_MAX_COUNT + 1 }, (_, i) => `r/${i}`),
    })
    try {
      expect(await peer.initialize(500)).toBeFalse()
      expect(peer.isAvailable()).toBeFalse()
    } finally {
      disposeAll(f, peer)
    }
  })

  test("empty, NUL, long, and reserved reverse entries fail closed", async () => {
    for (const bad of [[""], ["a\0b"], ["x".repeat(SERVE_REVERSE_CAPABILITY_MAX_LENGTH + 1)], ["initialize"]]) {
      const f = fixture(okHandler)
      const peer = new ServePrivatePeer({
        reader: f.clientReader,
        writer: f.clientWriter,
        pid: 506,
        epoch: 56,
        reverseCapabilities: bad,
      })
      try {
        expect(await peer.initialize(500)).toBeFalse()
        expect(peer.isAvailable()).toBeFalse()
      } finally {
        disposeAll(f, peer)
      }
    }
  })

  test("normalizer pins cross-endpoint contract limits and rejects duplicates", () => {
    expect(SERVE_REVERSE_CAPABILITIES_MAX_COUNT).toBe(64)
    expect(SERVE_REVERSE_CAPABILITY_MAX_LENGTH).toBe(128)
    expect(() => normalizeReverseCapabilities([""])).toThrow()
    expect(() => normalizeReverseCapabilities([1 as unknown as string])).toThrow()
    expect(() => normalizeReverseCapabilities("x" as unknown as string[])).toThrow()
    expect(() => normalizeReverseCapabilities(["a\0b"])).toThrow()
    expect(() => normalizeReverseCapabilities(["a", "a"])).toThrow()
    expect(() => normalizeReverseCapabilities(["initialize"])).toThrow()
    expect(normalizeReverseCapabilities(undefined)).toEqual([])
  })

  test("server capability gate from response is not degraded", async () => {
    const f = fixture(okHandler)
    const peer = new ServePrivatePeer({
      reader: f.clientReader,
      writer: f.clientWriter,
      pid: 507,
      epoch: 57,
      reverseCapabilities: ["reverse/only"],
    })
    try {
      expect(await peer.initialize(500)).toBeTrue()
      expect(peer.hasCapability("session/cancelQueued")).toBeTrue()
      expect(peer.hasCapability("session/missing")).toBeFalse()
    } finally {
      disposeAll(f, peer)
    }
  })
})
