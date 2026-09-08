import { describe, expect, it } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../src/private-worker/peer"
import { ErrorCode } from "../../src/private-worker/json-rpc"
import {
  OBSERVATION_METHODS,
  ObservationController,
  type ObservationDeps,
  type ObservationMessagesResult,
} from "../../src/private-worker/observation"
import { encodeMessageCursor } from "@opencode-ai/core/session/message-read"

function ctrlWith(fake?: ObservationDeps["messages"]): ObservationController {
  const deps: ObservationDeps = {
    getSnapshot: async () => ({ cursor: 0, snapshot: null }),
    readAfter: async () => ({ type: "deltas" as const, cursor: 0, entries: [] }),
    ack: async () => {},
    ...(fake ? { messages: fake } : {}),
  }
  return new ObservationController(deps)
}

function pair(ctrl: ObservationController) {
  const aToB = new PassThrough()
  const bToA = new PassThrough()
  const server = new JsonRpcPeer({ reader: aToB, writer: bToA, onRequest: (m, p) => ctrl.handle(m, p) })
  const client = new JsonRpcPeer({ reader: bToA, writer: aToB })
  return { client, server }
}

const dir = "/tmp/ws"
const sid = "ses_m1"

function validMessage(id: string, time = 100): { info: unknown; parts: unknown[] } {
  return {
    info: { id, sessionID: sid, role: "user", time: { created: time }, agent: "a", model: { providerID: "p", modelID: "m" } },
    parts: [{ id: `prt_${id}`, sessionID: sid, messageID: id, type: "text", text: "hi" }],
  }
}

describe("observation/messages wire validation", () => {
  it("found delegates and returns messages with nextCursor iff truncated", async () => {
    const msgs = [validMessage("msg_a", 100), validMessage("msg_b", 200)]
    const next = encodeMessageCursor({ id: "msg_a", time: 100 })
    const c = ctrlWith(async () => ({ v: "1.0", status: "found", messages: msgs as never, nextCursor: next }))
    const p = pair(c)
    const res = (await p.client.request(OBSERVATION_METHODS.MESSAGES, { v: "1.0", directory: dir, sessionId: sid, limit: 2, cursor: next })) as ObservationMessagesResult
    expect(res.status).toBe("found")
    p.client.dispose()
    p.server.dispose()
  })

  it("not_found/scope_mismatch resolve with exact keys", async () => {
    for (const status of ["not_found", "scope_mismatch"] as const) {
      const c = ctrlWith(async () => ({ v: "1.0", status }))
      const p = pair(c)
      const res = (await p.client.request(OBSERVATION_METHODS.MESSAGES, { v: "1.0", directory: dir, sessionId: sid, limit: 10 })) as Record<string, unknown>
      expect(res).toEqual({ v: "1.0", status })
      p.client.dispose()
      p.server.dispose()
    }
  })

  it("rejects version/keys/missing limit/cap/zero/cursor", async () => {
    const c = ctrlWith(async () => ({ v: "1.0", status: "not_found" }))
    const p = pair(c)
    const bad: unknown[] = [
      { v: "9.9", directory: dir, sessionId: sid, limit: 10 },
      { v: "1.0", directory: dir, sessionId: sid, limit: 10, extra: 1 },
      { v: "1.0", directory: dir, sessionId: sid },
      { v: "1.0", directory: dir, sessionId: sid, limit: 0 },
      { v: "1.0", directory: dir, sessionId: sid, limit: 101 },
      { v: "1.0", directory: dir, sessionId: sid, limit: 1.5 },
      { v: "1.0", directory: dir, sessionId: sid, limit: "10" },
      { v: "1.0", directory: dir, sessionId: sid, limit: 10, cursor: "bad!!!" },
      { v: "1.0", directory: dir, sessionId: sid, limit: 10, cursor: 123 },
      { v: "1.0", directory: "relative", sessionId: sid, limit: 10 },
      { v: "1.0", directory: dir, sessionId: "bad", limit: 10 },
      null,
      {},
    ]
    for (const params of bad) {
      try {
        await p.client.request(OBSERVATION_METHODS.MESSAGES, params)
        expect(false).toBe(true)
      } catch (e) {
        expect((e as { code?: number }).code).toBe(ErrorCode.InvalidParams)
      }
    }
    p.client.dispose()
    p.server.dispose()
  })

  it("MethodNotFound when deps absent", async () => {
    const c = ctrlWith()
    const p = pair(c)
    try {
      await p.client.request(OBSERVATION_METHODS.MESSAGES, { v: "1.0", directory: dir, sessionId: sid, limit: 10 })
      expect(false).toBe(true)
    } catch (e) {
      expect((e as { code?: number }).code).toBe(ErrorCode.MethodNotFound)
    }
    p.client.dispose()
    p.server.dispose()
  })

  it("malformed found message/part/nextCursor and non-found extras -> InternalError", async () => {
    const cases: unknown[] = [
      { v: "1.0", status: "found", messages: [{ info: { id: "bad" }, parts: [] }] },
      { v: "1.0", status: "found", messages: [{ parts: [] }] },
      { v: "1.0", status: "found", messages: [{ info: validMessage("msg_a").info, parts: [{ type: "text" }] }] },
      { v: "1.0", status: "found", messages: [validMessage("msg_a")], nextCursor: "bad!!!" },
      { v: "1.0", status: "found", messages: [validMessage("msg_a")], extra: 1 },
      { v: "1.0", status: "found", messages: "x" },
      { v: "1.0", status: "not_found", extra: 1 },
      { v: "1.0", status: "not_found", messages: [] },
      { v: "1.0", status: "scope_mismatch", nextCursor: encodeMessageCursor({ id: "msg_a", time: 1 }) },
      { v: "9.9", status: "not_found" },
    ]
    for (const fake of cases) {
      const c = ctrlWith(async () => fake as ObservationMessagesResult)
      const p = pair(c)
      try {
        await p.client.request(OBSERVATION_METHODS.MESSAGES, { v: "1.0", directory: dir, sessionId: sid, limit: 10 })
        expect(false).toBe(true)
      } catch (e) {
        expect((e as { code?: number }).code).toBe(ErrorCode.InternalError)
      }
      p.client.dispose()
      p.server.dispose()
    }
  })

  it("page/cursor invariants: short/empty+cursor, mismatch, too many, out-of-order", async () => {
    const ok2 = [validMessage("msg_a", 100), validMessage("msg_b", 200)]
    const anchorA = encodeMessageCursor({ id: "msg_a", time: 100 })
    const stale = encodeMessageCursor({ id: "msg_zzz", time: 100 })
    const badPages: unknown[] = [
      // short page with cursor
      { v: "1.0", status: "found", messages: [validMessage("msg_a", 100)], nextCursor: anchorA },
      // empty page with cursor
      { v: "1.0", status: "found", messages: [], nextCursor: anchorA },
      // stale/unrelated cursor anchor
      { v: "1.0", status: "found", messages: ok2, nextCursor: stale },
      // wrong time anchor
      { v: "1.0", status: "found", messages: ok2, nextCursor: encodeMessageCursor({ id: "msg_a", time: 999 }) },
      // too many messages
      { v: "1.0", status: "found", messages: [...ok2, validMessage("msg_c", 300)] },
      // out-of-order DESC page
      { v: "1.0", status: "found", messages: [validMessage("msg_b", 200), validMessage("msg_a", 100)] },
      // equal-time tie out of order (id DESC instead of ASC)
      { v: "1.0", status: "found", messages: [validMessage("msg_b", 100), validMessage("msg_a", 100)] },
    ]
    for (const fake of badPages) {
      const c = ctrlWith(async () => fake as ObservationMessagesResult)
      const p = pair(c)
      try {
        await p.client.request(OBSERVATION_METHODS.MESSAGES, { v: "1.0", directory: dir, sessionId: sid, limit: 2 })
        expect(false).toBe(true)
      } catch (e) {
        expect((e as { code?: number }).code).toBe(ErrorCode.InternalError)
      }
      p.client.dispose()
      p.server.dispose()
    }
  })

  it("full page accepts valid cursor or terminal no-cursor; preserves legacy extras", async () => {
    const withLegacy = {
      info: { ...(validMessage("msg_a", 100).info as Record<string, unknown>), variant: "legacy-user-variant" },
      parts: [{ id: "prt_msg_a", sessionID: sid, messageID: "msg_a", type: "text", text: "hi", legacyNote: "keep" }],
    }
    const full = [withLegacy, validMessage("msg_b", 200)]
    const anchor = encodeMessageCursor({ id: "msg_a", time: 100 })
    for (const fake of [
      { v: "1.0", status: "found", messages: full, nextCursor: anchor },
      { v: "1.0", status: "found", messages: full },
    ]) {
      const c = ctrlWith(async () => fake as unknown as ObservationMessagesResult)
      const p = pair(c)
      const res = (await p.client.request(OBSERVATION_METHODS.MESSAGES, { v: "1.0", directory: dir, sessionId: sid, limit: 2 })) as {
        status: string
        messages: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>
      }
      expect(res.status).toBe("found")
      expect((res.messages[0]!.info as Record<string, unknown>).variant).toBe("legacy-user-variant")
      expect(res.messages[0]!.parts[0]!["legacyNote"]).toBe("keep")
      p.client.dispose()
      p.server.dispose()
    }
  })
})
