import { describe, expect, test } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../../src/private-worker/peer"
import { createFdCarrier } from "../../../src/kilocode/server/fd-carrier"
import { FD_CAPABILITIES } from "../../../src/kilocode/server/fd-carrier-protocol"

function linked() {
  const extToCarrier = new PassThrough()
  const carrierToExt = new PassThrough()
  const carrier = createFdCarrier(extToCarrier, carrierToExt)
  const ext = new JsonRpcPeer({ reader: carrierToExt, writer: extToCarrier })
  return { carrier, ext }
}

describe("transport/health pure capability", () => {
  test("capability advertised", () => {
    expect((FD_CAPABILITIES as readonly string[]).includes("transport/health")).toBeTrue()
  })

  test("strict success exact {ok:true}", async () => {
    const { carrier, ext } = linked()
    try {
      await ext.request("initialize", {
        protocol: { name: "kilo-private", major: 1, minor: 0 },
        clientInfo: { name: "kilo-vscode", version: "7.4.11" },
        capabilities: ["session/cancelQueued"],
      })
      const res = (await ext.request("transport/health", {
        v: 1,
        requestId: "health-1",
        op: "transport/health",
        context: {},
        payload: {},
      })) as Record<string, unknown>
      expect(res.status).toBe("succeeded")
      expect(res.accepted).toBeTrue()
      expect(res.requestId).toBe("health-1")
      expect(res.op).toBe("transport/health")
      expect((res.data as Record<string, unknown>).ok).toBeTrue()
      expect(Object.keys(res.data as object).sort()).toEqual(["ok"])
    } finally {
      carrier.dispose()
      ext.dispose()
    }
  })

  test("strict request rejects directory/opId/unknown fields", async () => {
    const { carrier, ext } = linked()
    try {
      await ext.request("initialize", {
        protocol: { name: "kilo-private", major: 1, minor: 0 },
        clientInfo: { name: "kilo-vscode", version: "7.4.11" },
        capabilities: ["session/cancelQueued"],
      })
      const bad = [
        { v: 1, requestId: "h2", op: "transport/health", context: { directory: "/tmp" }, payload: {} },
        { v: 1, requestId: "h3", op: "transport/health", opId: "x", idempotencyKey: "x", context: {}, payload: {} },
        { v: 1, requestId: "h4", op: "transport/health", context: {}, payload: {}, extra: 1 },
        { v: 1, requestId: "h5", op: "transport/health", context: {}, payload: { q: 1 } },
      ]
      for (const params of bad) {
        const res = (await ext.request("transport/health", params)) as Record<string, unknown>
        expect(res.status).toBe("failed")
        const failure = res.failure as Record<string, unknown>
        expect(failure.code).toBe("validation.failed")
        expect(failure.retryable).toBeFalse()
      }
    } finally {
      carrier.dispose()
      ext.dispose()
    }
  })

  test("works with no drain lane (no instance needed)", async () => {
    // Pure handler proves no lane: no provideInstance, no drain acquisition,
    // no InstanceRef — direct linked carrier still succeeds.
    const { carrier, ext } = linked()
    try {
      await ext.request("initialize", {
        protocol: { name: "kilo-private", major: 1, minor: 0 },
        clientInfo: { name: "kilo-vscode", version: "7.4.11" },
        capabilities: ["session/cancelQueued"],
      })
      const res = (await ext.request("transport/health", {
        v: 1,
        requestId: "health-nolane",
        op: "transport/health",
        context: {},
        payload: {},
      })) as Record<string, unknown>
      expect(res.status).toBe("succeeded")
    } finally {
      carrier.dispose()
      ext.dispose()
    }
  })
})
