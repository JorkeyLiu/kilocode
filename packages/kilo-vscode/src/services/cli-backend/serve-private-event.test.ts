import { describe, expect, test } from "bun:test"
import * as vscode from "vscode"
import { KiloConnectionService } from "./connection-service"
import {
  PRIVATE_EVENT_MAX_BYTES,
  normalizePrivateEventEnvelope,
} from "./serve-private-event"

function svc(): KiloConnectionService {
  return new KiloConnectionService({} as unknown as vscode.ExtensionContext)
}

describe("private event envelope validation", () => {
  test("preserves directory/transaction/payload", () => {
    const out = normalizePrivateEventEnvelope({
      directory: "/repo",
      transaction: "tx-1",
      payload: { type: "message.part.updated", properties: {} },
    })
    expect(out?.directory).toBe("/repo")
    expect(out?.transaction).toBe("tx-1")
    expect(out?.payload.type).toBe("message.part.updated")
  })

  test("drops synthetic connected/heartbeat and malformed", () => {
    expect(
      normalizePrivateEventEnvelope({ directory: "global", payload: { type: "server.connected", properties: {} } }),
    ).toBeNull()
    expect(
      normalizePrivateEventEnvelope({ directory: "global", payload: { type: "server.heartbeat", properties: {} } }),
    ).toBeNull()
    expect(normalizePrivateEventEnvelope(null)).toBeNull()
    expect(normalizePrivateEventEnvelope({ directory: "/a", payload: { properties: {} } })).toBeNull()
    expect(normalizePrivateEventEnvelope({ directory: "/a", payload: { type: "x", properties: {} }, extra: 1 })).toBeNull()
    const big = "p".repeat(PRIVATE_EVENT_MAX_BYTES)
    expect(
      normalizePrivateEventEnvelope({ directory: "/a", payload: { type: "message.part.updated", big } }),
    ).toBeNull()
  })
})

describe("connection-service private event lifecycle", () => {
  test("private-live delivers to onEvent with directory routing; sse-live ignores private", () => {
    const service = svc()
    const seen: Array<{ type: string; dir?: string; tx?: string }> = []
    service.onEvent((event, dir, tx) => {
      seen.push({ type: (event as { type: string }).type, dir, tx })
    })
    // Before any source is live, private frames are ignored (single-source guard).
    service.handlePrivateEvent({ directory: "/a", payload: { type: "permission.asked", properties: { id: "p1" } } })
    expect(seen.length).toBe(0)

    // Force private-live for the unit (production sets this via markPrivateEventLive).
    ;(service as unknown as Record<string, unknown>).liveEventSource = "private"
    service.handlePrivateEvent({
      directory: "/repo",
      transaction: "tx-9",
      payload: { id: "e1", type: "message.part.updated", properties: {} },
    })
    expect(seen.length).toBe(1)
    expect(seen[0]?.dir).toBe("/repo")
    expect(seen[0]?.tx).toBe("tx-9")

    // Switching to SSE makes private frames inert: exactly one live source.
    ;(service as unknown as Record<string, unknown>).liveEventSource = "sse"
    service.handlePrivateEvent({ directory: "/repo", payload: { type: "message.part.updated", properties: {} } })
    expect(seen.length).toBe(1)
  })

  test("onEventFiltered sees the same transaction as onEvent", () => {
    const service = svc()
    ;(service as unknown as Record<string, unknown>).liveEventSource = "private"
    const filtered: Array<string | undefined> = []
    service.onEventFiltered(
      (event) => (event as { type: string }).type === "global.config.updated",
      (_event, _dir, tx) => {
        filtered.push(tx)
      },
    )
    service.handlePrivateEvent({
      directory: "/repo",
      transaction: "tx-cfg",
      payload: { id: "e2", type: "global.config.updated", properties: {} },
    })
    expect(filtered).toEqual(["tx-cfg"])
    expect(service.getConfigRevision()).toBe(1)
  })

  test("invalid private frames never reach subscribers and never throw", () => {
    const service = svc()
    ;(service as unknown as Record<string, unknown>).liveEventSource = "private"
    let calls = 0
    service.onEvent(() => {
      calls += 1
    })
    service.handlePrivateEvent(null)
    service.handlePrivateEvent({ directory: "global", payload: { type: "server.connected", properties: {} } })
    service.handlePrivateEvent({ directory: "/a", payload: { type: "x", properties: {} }, extra: 1 })
    expect(calls).toBe(0)
  })

  test("observation/changed never mixes into event payload", () => {
    expect(
      normalizePrivateEventEnvelope({
        directory: "/repo",
        payload: {
          v: "1.0",
          cursor: 1,
          entries: [{ seq: 1, session_id: "ses1", revision: 0, kind: "changed", time: 1 }],
        },
      }),
    ).toBeNull()
  })

  test("private loss without a client leaves a transitional non-connected state (no connected-without-source)", async () => {
    const service = svc()
    const states: string[] = []
    service.onStateChange((state) => states.push(state))
    ;(service as unknown as Record<string, unknown>).liveEventSource = "private"
    ;(service as unknown as Record<string, unknown>).state = "connected"
    ;(service as unknown as Record<string, unknown>).privateEpoch = 7
    ;(service as unknown as Record<string, unknown>).client = null
    await (service as unknown as { fallbackToSseAfterPrivateLoss: (e: number, r: string) => Promise<void> })
      .fallbackToSseAfterPrivateLoss(7, "test-no-client")
    expect(service.getLiveEventSource()).toBeNull()
    expect(service.getConnectionState()).toBe("connecting")
    expect(states).toContain("connecting")
    // Private frames are inert while no source is live.
    let calls = 0
    service.onEvent(() => {
      calls += 1
    })
    service.handlePrivateEvent({ directory: "/a", payload: { type: "message.part.updated", properties: {} } })
    expect(calls).toBe(0)
  })

  test("private-live fires the existing connected refresh consumers (state + synthetic connected)", () => {
    const service = svc()
    const states: string[] = []
    service.onStateChange((state) => states.push(state))
    const connected: string[] = []
    service.onEvent((event) => {
      if ((event as { type: string }).type === "server.connected") connected.push("server.connected")
    })
    ;(service as unknown as Record<string, unknown>).liveEventSource = null
    ;(service as unknown as Record<string, unknown>).state = "connecting"
    ;(service as unknown as { markPrivateEventLive: () => void }).markPrivateEventLive()
    expect(service.getLiveEventSource()).toBe("private")
    expect(service.getConnectionState()).toBe("connected")
    expect(states).toContain("connected")
    // The synthetic connected is the trigger downstream `onEvent` refresh
    // consumers already subscribe to; no extra polling was added.
    expect(connected.length).toBe(1)
  })
})
