import { describe, it, expect } from "bun:test"
import { PassThrough } from "node:stream"
import { JsonRpcPeer } from "../../src/private-worker/peer"
import {
  ServePrivatePeer,
  isValidObservationChangedNotification,
  OBSERVATION_CHANGED_REVERSE_CAPABILITY,
} from "../../src/services/cli-backend/serve-private-peer"
import { OBSERVATION_NOTIFICATION, OBSERVATION_VERSION } from "../../src/private-worker/observation"

function pair() {
  const aToB = new PassThrough()
  const bToA = new PassThrough()
  const a = new JsonRpcPeer({ reader: bToA, writer: aToB })
  const b = new JsonRpcPeer({ reader: aToB, writer: bToA })
  return { a, b, aToB, bToA }
}

describe("serve-private-peer observation/changed producer forwarding", () => {
  it("advertises observation/changed reverse capability", async () => {
    const cliToHost = new PassThrough()
    const hostToCli = new PassThrough()
    // CLI side peer that will receive initialize and capture reverseCapabilities
    let captured: unknown = null
    const cli = new JsonRpcPeer({
      reader: cliToHost,
      writer: hostToCli,
      onRequest: async (method, params) => {
        if (method === "initialize") {
          captured = params
          return {
            protocol: { name: "kilo-private", major: 1, minor: 0 },
            protocolVersion: "1.0",
            serverInfo: { name: "kilo", version: "7.4.11" },
            capabilities: [
              "session/create",
              "session/cancelQueued",
              "session/update",
              "session/fork",
              "session/delete",
              "session/status",
              "session/get",
              "session/messages",
              "session/children",
              "remote/status",
              "experimental/session/list",
              "path/get",
            ],
          }
        }
        throw new Error("unexpected")
      },
    })
    const hostPeer = new ServePrivatePeer({
      reader: hostToCli as unknown as NodeJS.ReadableStream,
      writer: cliToHost as unknown as NodeJS.WritableStream,
      epoch: 1,
      pid: 123,
    })
    const ok = await hostPeer.initialize()
    expect(ok).toBeTrue()
    const params = captured as { reverseCapabilities?: string[] } | null
    expect(params).not.toBeNull()
    expect(params!.reverseCapabilities).toContain(OBSERVATION_CHANGED_REVERSE_CAPABILITY)
    expect(params!.reverseCapabilities).toContain(OBSERVATION_NOTIFICATION)
    hostPeer.dispose()
    cli.dispose()
  })

  it("valid observation/changed notification is strictly validated and forwarded", async () => {
    const cliToHost = new PassThrough()
    const hostToCli = new PassThrough()
    let forwarded: unknown[] = []
    const cli = new JsonRpcPeer({
      reader: cliToHost,
      writer: hostToCli,
      onRequest: async (method) => {
        if (method === "initialize") {
          return {
            protocol: { name: "kilo-private", major: 1, minor: 0 },
            protocolVersion: "1.0",
            serverInfo: { name: "kilo", version: "7.4.11" },
            capabilities: ["session/create", "session/status"],
          }
        }
        throw new Error("unexpected")
      },
    })
    const hostPeer = new ServePrivatePeer({
      reader: hostToCli as unknown as NodeJS.ReadableStream,
      writer: cliToHost as unknown as NodeJS.WritableStream,
      epoch: 2,
      pid: 124,
      onObservationChanged: (m, p) => forwarded.push({ m, p }),
    })
    const ok = await hostPeer.initialize()
    expect(ok).toBeTrue()
    // send valid notification from CLI side (simulating fd-carrier notify)
    const valid = {
      v: OBSERVATION_VERSION,
      cursor: 5,
      entries: [{ seq: 5, session_id: "ses_abc123", revision: 0, kind: "changed", time: 1000 }],
    }
    // Ensure strict validation passes and payload has exactly 5 keys
    expect(isValidObservationChangedNotification(valid)).toBeTrue()
    const keys = Object.keys(valid.entries[0] as Record<string, unknown>).sort()
    expect(keys).toEqual(["kind", "revision", "seq", "session_id", "time"].sort())
    cli.notify(OBSERVATION_NOTIFICATION, valid)
    // wait a tick for framing
    await new Promise((r) => setTimeout(r, 30))
    expect(forwarded.length).toBe(1)
    const f = forwarded[0] as { m: string; p: unknown }
    expect(f.m).toBe(OBSERVATION_NOTIFICATION)
    expect((f.p as { cursor: number }).cursor).toBe(5)
    hostPeer.dispose()
    cli.dispose()
  })

  it("invalid notification is fail-closed not forwarded", async () => {
    const cliToHost = new PassThrough()
    const hostToCli = new PassThrough()
    let forwarded: unknown[] = []
    const cli = new JsonRpcPeer({
      reader: cliToHost,
      writer: hostToCli,
      onRequest: async (method) => {
        if (method === "initialize") {
          return {
            protocol: { name: "kilo-private", major: 1, minor: 0 },
            protocolVersion: "1.0",
            serverInfo: { name: "kilo", version: "7.4.11" },
            capabilities: ["session/create"],
          }
        }
        throw new Error("unexpected")
      },
    })
    const hostPeer = new ServePrivatePeer({
      reader: hostToCli as unknown as NodeJS.ReadableStream,
      writer: cliToHost as unknown as NodeJS.WritableStream,
      epoch: 3,
      pid: 125,
      onObservationChanged: (m, p) => forwarded.push({ m, p }),
    })
    await hostPeer.initialize()
    const invalids: unknown[] = [
      { v: "9.9", cursor: 1, entries: [{ seq: 1, session_id: "ses_a", revision: 0, kind: "changed", time: 1 }] },
      { v: "1.0", cursor: 1, entries: [{ seq: 1, session_id: "ses_a", revision: 0, kind: "bogus", time: 1 }] },
      {
        v: "1.0",
        cursor: 1,
        entries: [{ seq: 1, session_id: "ses_a", revision: 0, kind: "changed", time: 1, title: "leak" }],
      },
      { v: "1.0", cursor: 2, entries: [{ seq: 1, session_id: "ses_a", revision: 0, kind: "changed", time: 1 }] }, // cursor != seq
      null,
      { v: "1.0", cursor: 1, entries: "not-array" },
    ]
    for (const bad of invalids) {
      expect(isValidObservationChangedNotification(bad)).toBeFalse()
      cli.notify(OBSERVATION_NOTIFICATION, bad)
      await new Promise((r) => setTimeout(r, 10))
      expect(forwarded.length).toBe(0)
    }
    hostPeer.dispose()
    cli.dispose()
  })

  it("setObservationChangedHandler wiring reaches consumer", async () => {
    const cliToHost = new PassThrough()
    const hostToCli = new PassThrough()
    const cli = new JsonRpcPeer({
      reader: cliToHost,
      writer: hostToCli,
      onRequest: async (method) => {
        if (method === "initialize") {
          return {
            protocol: { name: "kilo-private", major: 1, minor: 0 },
            protocolVersion: "1.0",
            serverInfo: { name: "kilo", version: "7.4.11" },
            capabilities: ["session/create"],
          }
        }
        throw new Error("unexpected")
      },
    })
    const hostPeer = new ServePrivatePeer({
      reader: hostToCli as unknown as NodeJS.ReadableStream,
      writer: cliToHost as unknown as NodeJS.WritableStream,
      epoch: 4,
      pid: 126,
    })
    await hostPeer.initialize()
    let called = 0
    hostPeer.setObservationChangedHandler(() => called++)
    const valid = {
      v: "1.0",
      cursor: 7,
      entries: [{ seq: 7, session_id: "ses_xyz", revision: 0, kind: "changed", time: 123 }],
    }
    cli.notify(OBSERVATION_NOTIFICATION, valid)
    await new Promise((r) => setTimeout(r, 20))
    expect(called).toBe(1)
    hostPeer.dispose()
    cli.dispose()
  })

  it("dedup via handler not required but valid payload reaches existing consumer shape", async () => {
    // This test proves the extension peer notification can reach the existing consumer handler shape
    // used by AgentManagerProvider (strict validation already proven above).
    // We simulate the handler that AgentManagerProvider would use.
    let handlerCalls = 0
    const handler = (method: string, params: unknown): void => {
      if (method !== OBSERVATION_NOTIFICATION) return
      if (!isValidObservationChangedNotification(params)) return
      handlerCalls++
    }
    const cliToHost = new PassThrough()
    const hostToCli = new PassThrough()
    const cli = new JsonRpcPeer({
      reader: cliToHost,
      writer: hostToCli,
      onRequest: async (method) => {
        if (method === "initialize") {
          return {
            protocol: { name: "kilo-private", major: 1, minor: 0 },
            protocolVersion: "1.0",
            serverInfo: { name: "kilo", version: "7.4.11" },
            capabilities: ["session/create"],
          }
        }
        throw new Error("unexpected")
      },
    })
    const hostPeer = new ServePrivatePeer({
      reader: hostToCli as unknown as NodeJS.ReadableStream,
      writer: cliToHost as unknown as NodeJS.WritableStream,
      epoch: 5,
      pid: 127,
      onObservationChanged: handler,
    })
    await hostPeer.initialize()
    const valid = {
      v: "1.0",
      cursor: 9,
      entries: [{ seq: 9, session_id: "ses_dedup", revision: 0, kind: "changed", time: 999 }],
    }
    cli.notify(OBSERVATION_NOTIFICATION, valid)
    cli.notify(OBSERVATION_NOTIFICATION, valid) // duplicate
    await new Promise((r) => setTimeout(r, 30))
    // Both valid notifications would be forwarded; dedup is at coordinator level (singleflight).
    // This test at least proves forwarding works; coordinator dedup is covered in agent-manager-observation-changed.test.ts
    expect(handlerCalls).toBe(2)
    hostPeer.dispose()
    cli.dispose()
  })
})
