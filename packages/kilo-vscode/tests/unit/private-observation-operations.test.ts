import { describe, expect, it } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../src/private-worker/peer"
import { ErrorCode } from "../../src/private-worker/json-rpc"
import {
  OBSERVATION_METHODS,
  ObservationController,
  type ObservationDeps,
  type ObservationOperationsResult,
} from "../../src/private-worker/observation"

function ctrlWith(fake?: ObservationDeps["operations"]): ObservationController {
  const deps: ObservationDeps = {
    getSnapshot: async () => ({ cursor: 0, snapshot: null }),
    readAfter: async () => ({ type: "deltas" as const, cursor: 0, entries: [] }),
    ack: async () => {},
    ...(fake ? { operations: fake } : {}),
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
const sid = "ses_op1"

describe("observation/operations wire validation (vscode mirror)", () => {
  it("found delegates and returns panel-safe operations with finite time, no detail/stack/raw leak", async () => {
    const fakeOps: ObservationOperationsResult = {
      v: "1.0",
      status: "found",
      operations: [
        { opId: "prompt:msg_a", outcome: "failed", code: "E", message: "boom", time: 123456 },
        { opId: "prompt:msg_b", outcome: "succeeded", code: "C", message: "ok", time: 999, cancel: { source: "user_stop" } },
      ],
    }
    const c = ctrlWith(async () => fakeOps)
    const p = pair(c)
    const res = (await p.client.request(OBSERVATION_METHODS.OPERATIONS, { v: "1.0", directory: dir, sessionId: sid, limit: 2 })) as ObservationOperationsResult
    expect(res.status).toBe("found")
    if (res.status !== "found") throw new Error("expected found")
    expect(res.operations.length).toBe(2)
    for (const op of res.operations) {
      expect(Number.isFinite(op.time)).toBe(true)
      expect(typeof op.opId).toBe("string")
      expect(Object.keys(op).sort()).toEqual(op.cancel ? ["cancel", "code", "message", "opId", "outcome", "time"] : ["code", "message", "opId", "outcome", "time"])
      expect("detail" in op).toBe(false)
      expect("stack" in op).toBe(false)
      expect("opKind" in op).toBe(false)
      expect("idempotencyHash" in op).toBe(false)
      expect("requestId" in op).toBe(false)
      expect("revision" in op).toBe(false)
    }
    expect(res.operations[0]!.time).toBe(123456)
    p.client.dispose()
    p.server.dispose()
  })

  it("not_found/scope_mismatch resolve with exact keys", async () => {
    for (const status of ["not_found", "scope_mismatch"] as const) {
      const c = ctrlWith(async () => ({ v: "1.0", status }))
      const p = pair(c)
      const res = (await p.client.request(OBSERVATION_METHODS.OPERATIONS, { v: "1.0", directory: dir, sessionId: sid, limit: 5 })) as Record<string, unknown>
      expect(res).toEqual({ v: "1.0", status })
      p.client.dispose()
      p.server.dispose()
    }
  })

  it("rejects version/unknown fields/missing/limit bounds/directory/sessionId", async () => {
    const c = ctrlWith(async () => ({ v: "1.0", status: "not_found" }))
    const p = pair(c)
    const bad: unknown[] = [
      { v: "9.9", directory: dir, sessionId: sid, limit: 1 },
      { v: "1.0", directory: dir, sessionId: sid, limit: 1, extra: 1 },
      { v: "1.0", directory: dir, sessionId: sid, limit: 0 },
      { v: "1.0", directory: dir, sessionId: sid, limit: 21 },
      { v: "1.0", directory: dir, sessionId: sid, limit: 1.5 },
      { v: "1.0", directory: dir, sessionId: sid, limit: "1" },
      { v: "1.0", directory: "relative", sessionId: sid, limit: 1 },
      { v: "1.0", directory: dir, sessionId: "bad", limit: 1 },
      { v: "1.0", directory: dir, sessionId: "", limit: 1 },
      { v: "1.0", directory: "", sessionId: sid, limit: 1 },
      null,
      {},
      { v: "1.0", sessionId: sid, limit: 1 },
      { v: "1.0", directory: dir, limit: 1 },
    ]
    for (const params of bad) {
      try {
        await p.client.request(OBSERVATION_METHODS.OPERATIONS, params)
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
      await p.client.request(OBSERVATION_METHODS.OPERATIONS, { v: "1.0", directory: dir, sessionId: sid, limit: 1 })
      expect(false).toBe(true)
    } catch (e) {
      expect((e as { code?: number }).code).toBe(ErrorCode.MethodNotFound)
    }
    p.client.dispose()
    p.server.dispose()
  })

  it("malformed found shapes -> InternalError", async () => {
    const cases: unknown[] = [
      { v: "1.0", status: "found", operations: [{ opId: "prompt:msg_a", outcome: "failed", code: "E", message: "m" }] },
      { v: "1.0", status: "found", operations: [{ opId: "prompt:msg_a", outcome: "failed", code: "E", message: "m", time: Infinity }] },
      { v: "1.0", status: "found", operations: [{ opId: "prompt:msg_a", outcome: "failed", code: "E", message: "m", time: 1, detail: "x" }] },
      { v: "1.0", status: "found", operations: [{ opId: "prompt:msg_a", outcome: "failed", code: "E", message: "m", time: 1, stack: "s" }] },
      { v: "1.0", status: "found", operations: [{ opId: "prompt:msg_a", outcome: "failed", code: "E", message: "m", time: 1, opKind: "prompt" }] },
      { v: "1.0", status: "found", operations: [{ opId: "prompt:msg_a", outcome: "failed", code: "E", message: "m", time: 1, idempotencyHash: "h" }] },
      { v: "1.0", status: "found", operations: [{ opId: "prompt:msg_a", outcome: "failed", code: "E", message: "m", time: 1, requestId: "r" }] },
      { v: "1.0", status: "found", operations: [{ opId: "prompt:msg_a", outcome: "failed", code: "E", message: "m", time: 1, revision: 1 }] },
      { v: "1.0", status: "found", operations: [{ opId: "", outcome: "failed", code: "E", message: "m", time: 1 }] },
      { v: "1.0", status: "found", operations: [{ opId: "prompt:msg_a", outcome: "unknown", code: "E", message: "m", time: 1 }] },
      { v: "1.0", status: "found", operations: [{ opId: "prompt:msg_a", outcome: "failed", code: "", message: "m", time: 1 }] },
      { v: "1.0", status: "found", operations: [{ opId: "prompt:msg_a", outcome: "failed", code: "E", message: "m", time: 1, cancel: { source: "bad" } }] },
      { v: "1.0", status: "found", operations: "x" },
      { v: "1.0", status: "not_found", operations: [] },
      { v: "1.0", status: "found", extra: 1, operations: [{ opId: "prompt:msg_a", outcome: "failed", code: "E", message: "m", time: 1 }] },
      { v: "9.9", status: "found", operations: [{ opId: "prompt:msg_a", outcome: "failed", code: "E", message: "m", time: 1 }] },
      null,
      { v: "1.0", status: "found" },
    ]
    for (const fake of cases) {
      const c = ctrlWith(async () => fake as ObservationOperationsResult)
      const p = pair(c)
      try {
        await p.client.request(OBSERVATION_METHODS.OPERATIONS, { v: "1.0", directory: dir, sessionId: sid, limit: 1 })
        expect(false).toBe(true)
      } catch (e) {
        expect((e as { code?: number }).code).toBe(ErrorCode.InternalError)
      }
      p.client.dispose()
      p.server.dispose()
    }
  })

  it("valid cancel shapes pass", async () => {
    const good: ObservationOperationsResult = {
      v: "1.0",
      status: "found",
      operations: [{ opId: "prompt:msg_a", outcome: "abandoned", code: "C", message: "m", time: 1, cancel: { source: "timeout" } }],
    }
    const c = ctrlWith(async () => good)
    const p = pair(c)
    const res = (await p.client.request(OBSERVATION_METHODS.OPERATIONS, { v: "1.0", directory: dir, sessionId: sid, limit: 1 })) as ObservationOperationsResult
    expect(res.status).toBe("found")
    p.client.dispose()
    p.server.dispose()
  })

  it("valid recovery for failed/abandoned with exact shape passes, invalid recovery/mismatched outcome fails", async () => {
    const goodFailed: ObservationOperationsResult = {
      v: "1.0",
      status: "found",
      operations: [{ opId: "prompt:msg_a", outcome: "failed", code: "E", message: "m", time: 1, recovery: { budget: 0, nextAt: null, provenance: "terminal" } }],
    }
    const goodAbandoned: ObservationOperationsResult = {
      v: "1.0",
      status: "found",
      operations: [{ opId: "prompt:msg_a", outcome: "abandoned", code: "C", message: "m", time: 1, cancel: { source: "user_stop" }, recovery: { budget: 0, nextAt: null, provenance: "terminal" } }],
    }
    for (const good of [goodFailed, goodAbandoned]) {
      const c = ctrlWith(async () => good)
      const p = pair(c)
      const res = (await p.client.request(OBSERVATION_METHODS.OPERATIONS, { v: "1.0", directory: dir, sessionId: sid, limit: 1 })) as ObservationOperationsResult
      expect(res.status).toBe("found")
      if (res.status === "found") {
        expect(res.operations[0]!.recovery).toEqual({ budget: 0, nextAt: null, provenance: "terminal" })
        expect(new Set(Object.keys(res.operations[0]!))).toEqual(new Set(["opId", "outcome", "code", "message", "time", ...(res.operations[0]!.cancel ? ["cancel"] : []), "recovery"]))
      }
      p.client.dispose()
      p.server.dispose()
    }
    const bad: unknown[] = [
      { v: "1.0", status: "found", operations: [{ opId: "prompt:msg_a", outcome: "failed", code: "E", message: "m", time: 1, recovery: { budget: 1, nextAt: null, provenance: "terminal" } }] },
      { v: "1.0", status: "found", operations: [{ opId: "prompt:msg_a", outcome: "failed", code: "E", message: "m", time: 1, recovery: { budget: 0, nextAt: 123, provenance: "terminal" } }] },
      { v: "1.0", status: "found", operations: [{ opId: "prompt:msg_a", outcome: "failed", code: "E", message: "m", time: 1, recovery: { budget: 0, nextAt: null, provenance: "terminal", extra: 1 } }] },
      { v: "1.0", status: "found", operations: [{ opId: "prompt:msg_a", outcome: "succeeded", code: "C", message: "m", time: 1, recovery: { budget: 0, nextAt: null, provenance: "terminal" } }] },
      { v: "1.0", status: "found", operations: [{ opId: "prompt:msg_a", outcome: "in-flight", code: "C", message: "m", time: 1, recovery: { budget: 0, nextAt: null, provenance: "terminal" } }] },
    ]
    for (const fake of bad) {
      const c = ctrlWith(async () => fake as ObservationOperationsResult)
      const p = pair(c)
      try {
        await p.client.request(OBSERVATION_METHODS.OPERATIONS, { v: "1.0", directory: dir, sessionId: sid, limit: 1 })
        expect(false).toBe(true)
      } catch (e) {
        expect((e as { code?: number }).code).toBe(ErrorCode.InternalError)
      }
      p.client.dispose()
      p.server.dispose()
    }
  })
})
