import { describe, expect, test } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../private-worker/peer"
import { ServePrivatePeer } from "./serve-private-peer"
import {
  canonicalSkillListOpId,
  normalizePrivateSkillListWire,
  validateSkillListContractRequest as validateSkillListRequest,
  validateSkillListResult,
} from "./serve-private-skill-list-contract"
import { buildSkillListPrivateIdentity } from "../../kilo-provider/skill-list-privatefirst"
import {
  SKILL_LIST_TRANSPORT_FAILURE_MESSAGE,
  requestSkillListOutcome,
} from "./serve-private-skill-list"

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
  const opId = canonicalSkillListOpId("tok1")
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "skill/list" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp" },
    payload: {},
    ...over,
  }
}

function makeSuccess(req: ReturnType<typeof makeReq>, skills: unknown[] = [{ name: "demo", location: "builtin" }]) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "skill/list",
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { skills },
  }
}

function makeFailed(req: ReturnType<typeof makeReq>, code: string) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "skill/list",
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure: { code, message: "x", retryable: false } },
    accepted: false,
    failure: { code, message: "x", retryable: false },
  }
}

describe("skill-list private peer", () => {
  test("canonicalSkillListOpId binds a single colon-free token with idempotency equality", () => {
    expect(canonicalSkillListOpId("t1")).toBe("skill-list:t1")
    expect(() => canonicalSkillListOpId("")).toThrow()
    expect(() => canonicalSkillListOpId("a:b")).toThrow()
    const ident = buildSkillListPrivateIdentity()
    expect(ident.opId.startsWith("skill-list:")).toBeTrue()
    expect(ident.idempotencyKey).toBe(ident.opId)
  })

  test("validateSkillListRequest accepts strict shape and rejects violations", () => {
    const req = makeReq()
    expect(() => validateSkillListRequest(req)).not.toThrow()
    expect(() => validateSkillListRequest(makeReq({ context: { directory: "/tmp", workspace: "w" } }))).not.toThrow()
    expect(() => validateSkillListRequest({ ...req, opId: "skill-list:a:b" })).toThrow()
    expect(() => validateSkillListRequest({ ...req, opId: "skill:t1", idempotencyKey: "skill:t1" })).toThrow()
    expect(() => validateSkillListRequest({ ...req, opId: "skill-remove:t1", idempotencyKey: "skill-remove:t1" })).toThrow()
    expect(() => validateSkillListRequest({ ...req, idempotencyKey: "skill-list:other" })).toThrow()
    expect(() => validateSkillListRequest({ ...req, context: { directory: "relative" } })).toThrow()
    expect(() => validateSkillListRequest({ ...req, payload: { filter: {} } })).toThrow()
    expect(() => validateSkillListRequest({ ...req, context: { directory: "/tmp", extra: 1 } })).toThrow()
    expect(() => validateSkillListRequest({ ...req, extra: 1 })).toThrow()
    expect(() => validateSkillListRequest({ ...req, op: "command/list" })).toThrow()
  })

  test("validateSkillListResult enforces per-status shape with safe projection and empty success", () => {
    const req = makeReq()
    expect(() => validateSkillListResult(makeSuccess(req), req)).not.toThrow()
    expect(() => validateSkillListResult(makeSuccess(req, []), req)).not.toThrow()
    expect(() =>
      validateSkillListResult(makeSuccess(req, [{ name: "a", description: "d", location: "builtin" }]), req),
    ).not.toThrow()
    // Forbidden content/file fields are rejected.
    expect(() => validateSkillListResult(makeSuccess(req, [{ name: "a", location: "b", content: "x" }]), req)).toThrow()
    expect(() => validateSkillListResult(makeSuccess(req, [{ name: "a", location: "b", template: "x" }]), req)).toThrow()
    expect(() => validateSkillListResult(makeSuccess(req, [{ name: "" , location: "b" }]), req)).toThrow()
    expect(() => validateSkillListResult(makeSuccess(req, [{ name: "a", location: "" }]), req)).toThrow()
    expect(() => validateSkillListResult({ ...makeSuccess(req), requestId: "r2" }, req)).toThrow()
    expect(() => validateSkillListResult({ ...makeSuccess(req), data: { skills: {} } }, req)).toThrow()
    const failed = makeFailed(req, "validation.failed")
    expect(() => validateSkillListResult(failed, req)).not.toThrow()
    const ambiguous = {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "skill/list",
      idempotencyKey: req.idempotencyKey,
      status: "ambiguous",
      outcome: { type: "ambiguous", time: 1 },
      accepted: false,
      transportUnknown: true,
    }
    expect(() => validateSkillListResult(ambiguous, req)).not.toThrow()
  })

  test("peer capability gating requires skill/list", () => {
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel(() => ({ v: 1 }))
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 1 })
    ;(peer as unknown as Record<string, unknown>).available = true
    ;(peer as unknown as Record<string, unknown>).peer = new JsonRpcPeer({ reader: clientReader, writer: clientWriter })
    ;(peer as unknown as Record<string, unknown>).capabilities = ["session/get"]
    const req = makeReq()
    expect(() => peer.privateSkillListOutcomeWithHandle(req as never)).toThrow(
      "Private peer missing skill/list capability",
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
    expect(() => peer.privateSkillListOutcomeWithHandle(req as never)).toThrow("Private peer unavailable")
    peer.dispose()
    expect(() => peer.privateSkillListOutcomeWithHandle(req as never)).toThrow()
    backendPeer.dispose()
    clientReader.destroy()
    clientWriter.destroy()
  })

  test("peer outcome handle resolves normalized wire and excludes invalid wire", async () => {
    const req = makeReq()
    const success = makeSuccess(req, [{ name: "demo", location: "builtin" }])
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel((method) => {
      expect(method).toBe("skill/list")
      return success
    })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 5 })
    ;(peer as unknown as Record<string, unknown>).available = true
    ;(peer as unknown as Record<string, unknown>).peer = new JsonRpcPeer({ reader: clientReader, writer: clientWriter })
    ;(peer as unknown as Record<string, unknown>).capabilities = ["skill/list"]
    const outcome = await peer.privateSkillListOutcomeWithHandle(req as never).promise
    expect(outcome.kind).toBe("valid")
    if (outcome.kind === "valid") {
      expect(outcome.result.status).toBe("succeeded")
      expect(() => validateSkillListResult(outcome.result as unknown, req as never)).not.toThrow()
    }
    peer.dispose()
    backendPeer.dispose()
    clientReader.destroy()
    clientWriter.destroy()

    const bad = { ...success, data: { skills: [{ name: "demo", location: "builtin", content: "x" }] } }
    expect(normalizePrivateSkillListWire(bad, req as never).kind).toBe("invalid")
  })

  test("peer outcome handle excludes content-bearing wire before any comparator", async () => {
    const req = makeReq()
    const bad = { ...makeSuccess(req, []), data: { skills: [{ name: "demo", location: "builtin", content: "x" }] } }
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel(() => bad)
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 5 })
    ;(peer as unknown as Record<string, unknown>).available = true
    ;(peer as unknown as Record<string, unknown>).peer = new JsonRpcPeer({ reader: clientReader, writer: clientWriter })
    ;(peer as unknown as Record<string, unknown>).capabilities = ["skill/list"]
    const outcome = await peer.privateSkillListOutcomeWithHandle(req as never).promise
    expect(outcome.kind).toBe("invalid")
    if (outcome.kind !== "invalid") throw new Error("expected invalid wire outcome for content-bearing entry")
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
    ;(peer as unknown as Record<string, unknown>).capabilities = ["skill/list"]
    const handle = peer.privateSkillListOutcomeWithHandle(req as never)
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

  test("skill-list transport failures are redacted to a fixed safe message", async () => {
    const req = makeReq()
    const rawErr = new Error("secret transport boom /tmp/skill-abc content=hidden")
    ;(rawErr as unknown as Record<string, unknown>).code = -32603
    const raw = {
      requestWithId: () => ({ id: 7, promise: Promise.reject(rawErr) }),
    }
    const host = {
      isStale: () => false,
      isClosed: () => false,
      failInfo: () => ({ code: "-32603", msg: "secret transport boom /tmp/skill-abc content=hidden" }),
    }
    const handle = requestSkillListOutcome(raw as never, host, () => () => true, req as never)
    const outcome = await handle.promise
    expect(outcome.kind).toBe("valid")
    if (outcome.kind !== "valid") throw new Error("expected valid failure outcome")
    expect(outcome.result.status).toBe("failed")
    const failed = outcome.result as unknown as {
      failure: { code: string; message: string; retryable: boolean }
      outcome: { failure: { code: string; message: string; retryable: boolean } }
    }
    expect(failed.failure.code).toBe("-32603")
    expect(failed.failure.message).toBe(SKILL_LIST_TRANSPORT_FAILURE_MESSAGE)
    expect(failed.outcome.failure.message).toBe(SKILL_LIST_TRANSPORT_FAILURE_MESSAGE)
    const leaked = JSON.stringify(outcome.result)
    expect(leaked.includes("secret transport boom")).toBeFalse()
    expect(leaked.includes("skill-abc")).toBeFalse()
    expect(leaked.includes("content=hidden")).toBeFalse()
  })
})
