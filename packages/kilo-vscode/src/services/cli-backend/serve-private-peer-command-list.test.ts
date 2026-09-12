import { describe, expect, test } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../private-worker/peer"
import { ServePrivatePeer } from "./serve-private-peer"
import {
  canonicalCommandListOpId,
  normalizePrivateCommandListWire,
  validateCommandListContractRequest as validateCommandListRequest,
  validateCommandListResult,
} from "./serve-private-command-list-contract"
import { buildCommandListPrivateIdentity } from "../../kilo-provider/command-list-privatefirst"
import {
  COMMAND_LIST_TRANSPORT_FAILURE_MESSAGE,
  requestCommandListOutcome,
} from "./serve-private-command-list"

function createLinkedChannel(handler: (method: string, params: unknown) => unknown | Promise<unknown>) {
  const toClient = new PassThrough()
  const toBackend = new PassThrough()
  const backendPeer = new JsonRpcPeer({
    reader: toBackend,
    writer: toClient,
    onRequest: handler as unknown as (m: string, p: unknown) => unknown,
  })
  return { clientReader: toClient, clientWriter: toBackend, backendPeer }
}

function makeReq(over: Record<string, unknown> = {}) {
  const opId = canonicalCommandListOpId("tok1")
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "command/list" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp" },
    payload: {},
    ...over,
  }
}

function makeSuccess(req: ReturnType<typeof makeReq>, commands: unknown[] = [{ name: "init", source: "command" }]) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "command/list",
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { commands },
  }
}

function makeFailed(req: ReturnType<typeof makeReq>, code: string) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "command/list",
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure: { code, message: "x", retryable: false } },
    accepted: false,
    failure: { code, message: "x", retryable: false },
  }
}

describe("command-list private peer", () => {
  test("canonicalCommandListOpId binds a single colon-free token with idempotency equality", () => {
    expect(canonicalCommandListOpId("t1")).toBe("command-list:t1")
    expect(() => canonicalCommandListOpId("")).toThrow()
    expect(() => canonicalCommandListOpId("a:b")).toThrow()
    const ident = buildCommandListPrivateIdentity()
    expect(ident.opId.startsWith("command-list:")).toBeTrue()
    expect(ident.idempotencyKey).toBe(ident.opId)
  })

  test("validateCommandListRequest accepts strict shape and rejects violations", () => {
    const req = makeReq()
    expect(() => validateCommandListRequest(req)).not.toThrow()
    expect(() => validateCommandListRequest(makeReq({ context: { directory: "/tmp", workspace: "w" } }))).not.toThrow()
    expect(() => validateCommandListRequest({ ...req, opId: "command-list:a:b" })).toThrow()
    expect(() => validateCommandListRequest({ ...req, opId: "command:t1", idempotencyKey: "command:t1" })).toThrow()
    expect(() => validateCommandListRequest({ ...req, opId: "session/command:t1", idempotencyKey: "session/command:t1" })).toThrow()
    expect(() => validateCommandListRequest({ ...req, idempotencyKey: "command-list:other" })).toThrow()
    expect(() => validateCommandListRequest({ ...req, context: { directory: "relative" } })).toThrow()
    expect(() => validateCommandListRequest({ ...req, payload: { filter: {} } })).toThrow()
    expect(() => validateCommandListRequest({ ...req, context: { directory: "/tmp", extra: 1 } })).toThrow()
    expect(() => validateCommandListRequest({ ...req, extra: 1 })).toThrow()
    expect(() => validateCommandListRequest({ ...req, op: "session/command" })).toThrow()
  })

  test("validateCommandListResult enforces per-status shape with safe projection", () => {
    const req = makeReq()
    expect(() => validateCommandListResult(makeSuccess(req), req)).not.toThrow()
    expect(() =>
      validateCommandListResult(makeSuccess(req, [{ name: "a", description: "d", source: "skill", hints: ["$1"] }]), req),
    ).not.toThrow()
    // Legal duplicate pair: same name, different source.
    expect(() =>
      validateCommandListResult(makeSuccess(req, [{ name: "a", source: "command" }, { name: "a", source: "skill" }]), req),
    ).not.toThrow()
    // Forbidden lazy/model/agent/subtask fields are rejected.
    expect(() => validateCommandListResult(makeSuccess(req, [{ name: "a", template: "x" }]), req)).toThrow()
    expect(() => validateCommandListResult(makeSuccess(req, [{ name: "a", agent: "x" }]), req)).toThrow()
    expect(() => validateCommandListResult(makeSuccess(req, [{ name: "a", model: "x" }]), req)).toThrow()
    expect(() => validateCommandListResult(makeSuccess(req, [{ name: "a", subtask: true }]), req)).toThrow()
    expect(() => validateCommandListResult(makeSuccess(req, [{ name: "a", source: "agent" }]), req)).toThrow()
    expect(() => validateCommandListResult(makeSuccess(req, [{ name: "" }]), req)).toThrow()
    expect(() => validateCommandListResult(makeSuccess(req, [{ name: "a", hints: [1] }]), req)).toThrow()
    expect(() => validateCommandListResult({ ...makeSuccess(req), requestId: "r2" }, req)).toThrow()
    expect(() => validateCommandListResult({ ...makeSuccess(req), data: { commands: {} } }, req)).toThrow()
    const failed = makeFailed(req, "validation.failed")
    expect(() => validateCommandListResult(failed, req)).not.toThrow()
    const ambiguous = {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "command/list",
      idempotencyKey: req.idempotencyKey,
      status: "ambiguous",
      outcome: { type: "ambiguous", time: 1 },
      accepted: false,
      transportUnknown: true,
    }
    expect(() => validateCommandListResult(ambiguous, req)).not.toThrow()
  })

  test("peer capability gating requires command/list", () => {
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel(() => ({ v: 1 }))
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 1 })
    ;(peer as unknown as Record<string, unknown>).available = true
    ;(peer as unknown as Record<string, unknown>).peer = new JsonRpcPeer({ reader: clientReader, writer: clientWriter })
    ;(peer as unknown as Record<string, unknown>).capabilities = ["session/get"]
    const req = makeReq()
    expect(() => peer.privateCommandListOutcomeWithHandle(req as never)).toThrow(
      "Private peer missing command/list capability",
    )
    peer.dispose()
    backendPeer.dispose()
    clientReader.destroy()
    clientWriter.destroy()
  })

  test("peer unavailable/disposed fails closed without mutation", () => {
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel(() => ({ v: 1 }))
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 1 })
    const req = makeReq()
    expect(() => peer.privateCommandListOutcomeWithHandle(req as never)).toThrow("Private peer unavailable")
    peer.dispose()
    expect(() => peer.privateCommandListOutcomeWithHandle(req as never)).toThrow()
    backendPeer.dispose()
    clientReader.destroy()
    clientWriter.destroy()
  })

  test("peer outcome handle resolves normalized wire and excludes invalid wire", async () => {
    const req = makeReq()
    const success = makeSuccess(req, [{ name: "init", source: "command" }])
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel((method) => {
      expect(method).toBe("command/list")
      return success
    })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 5 })
    ;(peer as unknown as Record<string, unknown>).available = true
    ;(peer as unknown as Record<string, unknown>).peer = new JsonRpcPeer({ reader: clientReader, writer: clientWriter })
    ;(peer as unknown as Record<string, unknown>).capabilities = ["command/list"]
    const outcome = await peer.privateCommandListOutcomeWithHandle(req as never).promise
    expect(outcome.kind).toBe("valid")
    if (outcome.kind === "valid") {
      expect(outcome.result.status).toBe("succeeded")
      expect(() => validateCommandListResult(outcome.result as unknown, req as never)).not.toThrow()
    }
    peer.dispose()
    backendPeer.dispose()
    clientReader.destroy()
    clientWriter.destroy()

    const bad = { ...success, data: { commands: [{ name: "init", template: "x" }] } }
    expect(normalizePrivateCommandListWire(bad, req as never).kind).toBe("invalid")
  })

  test("peer outcome handle excludes invalid wire before any comparator", async () => {
    const req = makeReq()
    const bad = { ...makeSuccess(req, []), data: { commands: [{ name: "init", template: "x" }] } }
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel(() => bad)
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 5 })
    ;(peer as unknown as Record<string, unknown>).available = true
    ;(peer as unknown as Record<string, unknown>).peer = new JsonRpcPeer({ reader: clientReader, writer: clientWriter })
    ;(peer as unknown as Record<string, unknown>).capabilities = ["command/list"]
    const outcome = await peer.privateCommandListOutcomeWithHandle(req as never).promise
    expect(outcome.kind).toBe("invalid")
    if (outcome.kind !== "invalid") throw new Error("expected invalid wire outcome for template-bearing entry")
    expect(outcome.detail.length).toBeGreaterThan(0)
    peer.dispose()
    backendPeer.dispose()
    clientReader.destroy()
    clientWriter.destroy()
  })

  test("peer exact cancel owns the allocated id", async () => {
    const req = makeReq()
    let release: ((v: unknown) => void) | null = null
    const gate = new Promise<unknown>((resolve) => {
      release = resolve
    })
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel(() => gate)
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 5 })
    ;(peer as unknown as Record<string, unknown>).available = true
    ;(peer as unknown as Record<string, unknown>).peer = new JsonRpcPeer({ reader: clientReader, writer: clientWriter })
    ;(peer as unknown as Record<string, unknown>).capabilities = ["command/list"]
    const handle = peer.privateCommandListOutcomeWithHandle(req as never)
    expect(typeof handle.id).toBe("number")
    expect(peer.getPendingCount()).toBe(1)
    expect(handle.cancel()).toBeTrue()
    release!({ kind: "valid", result: makeSuccess(req, []) })
    const outcome = await handle.promise
    expect(outcome.kind).toBe("valid")
    peer.dispose()
    backendPeer.dispose()
    clientReader.destroy()
    clientWriter.destroy()
  })

  test("command-list transport failures are redacted to a fixed safe message", async () => {
    const req = makeReq()
    const rawErr = new Error("secret transport boom /tmp/cmd-abc template=hidden")
    ;(rawErr as unknown as Record<string, unknown>).code = -32603
    const raw = {
      requestWithId: () => ({ id: 7, promise: Promise.reject(rawErr) }),
    }
    const host = {
      isStale: () => false,
      isClosed: () => false,
      failInfo: () => ({ code: "-32603", msg: "secret transport boom /tmp/cmd-abc template=hidden" }),
    }
    const handle = requestCommandListOutcome(raw as never, host, () => () => true, req as never)
    const outcome = await handle.promise
    expect(outcome.kind).toBe("valid")
    if (outcome.kind !== "valid") throw new Error("expected valid failure outcome")
    expect(outcome.result.status).toBe("failed")
    const failed = outcome.result as unknown as {
      failure: { code: string; message: string; retryable: boolean }
      outcome: { failure: { code: string; message: string; retryable: boolean } }
    }
    expect(failed.failure.code).toBe("-32603")
    expect(failed.failure.message).toBe(COMMAND_LIST_TRANSPORT_FAILURE_MESSAGE)
    expect(failed.outcome.failure.message).toBe(COMMAND_LIST_TRANSPORT_FAILURE_MESSAGE)
    const leaked = JSON.stringify(outcome.result)
    expect(leaked.includes("secret transport boom")).toBeFalse()
    expect(leaked.includes("cmd-abc")).toBeFalse()
    expect(leaked.includes("template=hidden")).toBeFalse()
  })

})
