import { describe, it, expect } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../src/private-worker/peer"
import { ErrorCode } from "../../src/private-worker/json-rpc"
import {
  OBSERVATION_METHODS,
  OBSERVATION_VERSION,
  ObservationController,
  type ObservationDeps,
  type ObservationListResult,
} from "../../src/private-worker/observation"

function makeController(fakeList?: (input: { cursor?: string; limit: number }) => Promise<ObservationListResult>): {
  ctrl: ObservationController
  deps: ObservationDeps
} {
  const deps: ObservationDeps = {
    getSnapshot: async () => ({ cursor: 0, snapshot: null }),
    readAfter: async () => ({ type: "deltas" as const, cursor: 0, entries: [] }),
    ack: async () => {},
    ...(fakeList ? { list: fakeList } : {}),
  }
  const ctrl = new ObservationController(deps)
  return { ctrl, deps }
}

function makePair(ctrl: ObservationController) {
  const aToB = new PassThrough()
  const bToA = new PassThrough()
  const server = new JsonRpcPeer({ reader: aToB, writer: bToA, onRequest: (m, p) => ctrl.handle(m, p) })
  const client = new JsonRpcPeer({ reader: bToA, writer: aToB })
  return { client, server, aToB, bToA }
}

describe("observation/list wire validation", () => {
  it("valid request delegates with version 1.0 and returns projection", async () => {
    let captured: { cursor?: string; limit: number } | undefined
    const fake: ObservationListResult = {
      v: "1.0",
      entries: [
        { id: "ses_a", title: "hello", parentID: null, directory: "/tmp/ws", createdAt: 100, updatedAt: 200 },
      ],
    }
    const { ctrl } = makeController(async (input) => {
      captured = input
      return fake
    })
    const pair = makePair(ctrl)
    const res = (await pair.client.request(OBSERVATION_METHODS.LIST, { v: "1.0", limit: 2 })) as ObservationListResult
    expect(res.v).toBe("1.0")
    expect(res.entries.length).toBe(1)
    expect(res.entries[0]!.id).toBe("ses_a")
    expect(captured!.limit).toBe(2)
    expect(captured!.cursor).toBeUndefined()
    expect(Object.keys(res.entries[0]!).sort()).toEqual(["createdAt", "directory", "id", "parentID", "title", "updatedAt"])
    pair.client.dispose()
    pair.server.dispose()
  })

  it("default limit 100 when omitted", async () => {
    let captured: number | undefined
    const { ctrl } = makeController(async (input) => {
      captured = input.limit
      return { v: "1.0", entries: [] }
    })
    const pair = makePair(ctrl)
    const res = (await pair.client.request(OBSERVATION_METHODS.LIST, { v: "1.0" })) as ObservationListResult
    expect(res.v).toBe("1.0")
    expect(captured).toBe(100)
    pair.client.dispose()
    pair.server.dispose()
  })

  it("rejects invalid limit and version and unknown fields", async () => {
    const { ctrl } = makeController(async () => ({ v: "1.0", entries: [] }))
    const pair = makePair(ctrl)
    const bad: unknown[] = [
      { v: "9.9", limit: 10 },
      { v: "1.0", limit: 0 },
      { v: "1.0", limit: 501 },
      { v: "1.0", limit: 2.5 },
      { v: "1.0", limit: "2" },
      { v: "1.0", unexpected: 1 },
      { v: "1.0", cursor: "bad" },
      { v: "1.0", cursor: 123 },
      { v: "1.0", cursor: null },
      {},
      { limit: 10 },
      null,
      "string",
      { v: "1.0", cursor: Buffer.from(JSON.stringify({ v: 2, updated: 1, id: "ses_a" }), "utf8").toString("base64url") },
      { v: "1.0", cursor: Buffer.from(JSON.stringify({ v: 1, updated: 1, id: "ses_a", extra: 1 }), "utf8").toString("base64url") },
    ]
    for (const params of bad) {
      try {
        await pair.client.request(OBSERVATION_METHODS.LIST, params)
        expect(false).toBe(true)
      } catch (e) {
        expect((e as { code?: number }).code).toBe(ErrorCode.InvalidParams)
      }
    }
    pair.client.dispose()
    pair.server.dispose()
  })

  it("returns nextCursor only when truncated", async () => {
    const fakeTruncated: ObservationListResult = {
      v: "1.0",
      entries: [{ id: "ses_b", title: "b", parentID: null, directory: "/tmp", createdAt: 1, updatedAt: 2 }],
      nextCursor: Buffer.from(JSON.stringify({ v: 1, updated: 2, id: "ses_b" }), "utf8").toString("base64url"),
    }
    const { ctrl } = makeController(async () => fakeTruncated)
    const pair = makePair(ctrl)
    const res = (await pair.client.request(OBSERVATION_METHODS.LIST, { v: "1.0", limit: 1 })) as ObservationListResult
    expect(res.nextCursor).toBeDefined()
    const { ctrl: ctrl2 } = makeController(async () => ({ v: "1.0", entries: [] }))
    const pair2 = makePair(ctrl2)
    const res2 = (await pair2.client.request(OBSERVATION_METHODS.LIST, { v: "1.0" })) as ObservationListResult
    expect(res2.nextCursor).toBeUndefined()
    pair.client.dispose()
    pair.server.dispose()
    pair2.client.dispose()
    pair2.server.dispose()
  })

  it("MethodNotFound when list deps absent", async () => {
    const { ctrl } = makeController()
    delete (ctrl as unknown as { deps: ObservationDeps }).deps.list
    const pair = makePair(ctrl)
    try {
      await pair.client.request(OBSERVATION_METHODS.LIST, { v: "1.0" })
      expect(false).toBe(true)
    } catch (e) {
      expect((e as { code?: number }).code).toBe(ErrorCode.MethodNotFound)
    }
    pair.client.dispose()
    pair.server.dispose()
  })

  it("cursor opaque validation uses global cursor codec strictly", async () => {
    const { ctrl } = makeController(async () => ({ v: "1.0", entries: [] }))
    const pair = makePair(ctrl)
    const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64url")
    const badCursors = [
      enc({ v: 1, updated: 7, id: "x_bad" }),
      enc({ v: 1, updated: -1, id: "ses_a" }),
      enc({ v: 1, updated: 7, id: "ses_ab\0c" }),
      "not_base64!",
    ]
    for (const cursor of badCursors) {
      try {
        await pair.client.request(OBSERVATION_METHODS.LIST, { v: "1.0", cursor })
        expect(false).toBe(true)
      } catch (e) {
        expect((e as { code?: number }).code).toBe(ErrorCode.InvalidParams)
      }
    }
    pair.client.dispose()
    pair.server.dispose()
  })
})
