import { afterEach, describe, expect, test } from "bun:test"
import { KiloConnectionService } from "../../src/services/cli-backend/connection-service"
import type { SSEPayload } from "../../src/services/cli-backend/sdk-sse-adapter"

const PREFIX = "[Kilo New][P0-Perf] "

function capture(): { logs: unknown[][]; restore: () => void } {
  const logs: unknown[][] = []
  const log = console.log
  console.log = (...args: unknown[]) => logs.push(args)
  return { logs, restore: () => (console.log = log) }
}

function records(logs: unknown[][]): Array<Record<string, unknown>> {
  return logs
    .map((args) => args.join(" "))
    .filter((line) => line.startsWith(PREFIX))
    .map((line) => JSON.parse(line.slice(PREFIX.length)))
}

const idle = (sessionID = "ses1"): SSEPayload =>
  ({ type: "session.idle", properties: { sessionID } }) as unknown as SSEPayload

const syncUpdated = (): SSEPayload =>
  ({
    type: "sync",
    name: "message.updated.1",
    id: "e1",
    seq: 1,
    aggregateID: "ses1",
    data: { info: { role: "assistant", id: "m1" } },
  }) as unknown as SSEPayload

describe("KiloConnectionService P0 per-event SSE dispatch span", () => {
  afterEach(() => {
    delete process.env.KILO_P0_PERF
  })

  test("handleSseEvent emits one sse.event start/end pair with bounded metadata", () => {
    process.env.KILO_P0_PERF = "1"
    const service = new KiloConnectionService({} as any)
    const { logs, restore } = capture()
    try {
      service.handleSseEvent(idle(), "/w", "tx-1")
    } finally {
      restore()
    }
    const recs = records(logs)
    expect(recs).toHaveLength(2)
    expect(recs[0]!.stage).toBe("sse.event")
    expect(recs[0]!.span).toBe("start")
    expect(recs[0]!.eventType).toBe("session.idle")
    expect(recs[0]!.dir).toBe("/w")
    expect(recs[0]!.transaction).toBe("tx-1")
    expect(recs[1]!.stage).toBe("sse.event")
    expect(recs[1]!.span).toBe("end")
    expect(typeof recs[1]!.dur).toBe("number")
    expect(recs[1]!.eventType).toBe("session.idle")
    expect(recs[1]!.corr).toBe(recs[0]!.corr)
    expect(recs[1]!.t).toBeGreaterThanOrEqual(recs[0]!.t as number)
  })

  test("sync events report the inner event name as eventType (no payload data)", () => {
    process.env.KILO_P0_PERF = "1"
    const service = new KiloConnectionService({} as any)
    const { logs, restore } = capture()
    try {
      service.handleSseEvent(syncUpdated())
    } finally {
      restore()
    }
    const recs = records(logs)
    expect(recs).toHaveLength(2)
    expect(recs[0]!.eventType).toBe("message.updated.1")
    // Bounded: the event payload (data.info) never appears in the record.
    expect(JSON.stringify(recs)).not.toContain("role")
  })

  test("metadata is omitted when directory/transaction are absent", () => {
    process.env.KILO_P0_PERF = "1"
    const service = new KiloConnectionService({} as any)
    const { logs, restore } = capture()
    try {
      service.handleSseEvent(idle())
    } finally {
      restore()
    }
    const recs = records(logs)
    expect(recs).toHaveLength(2)
    expect(recs[0]!.dir).toBeUndefined()
    expect(recs[0]!.transaction).toBeUndefined()
  })

  test("disabled path emits no sse.event records", () => {
    delete process.env.KILO_P0_PERF
    const service = new KiloConnectionService({} as any)
    const { logs, restore } = capture()
    try {
      service.handleSseEvent(idle(), "/w", "tx-1")
    } finally {
      restore()
    }
    expect(records(logs)).toEqual([])
  })
})
