import { describe, expect, test } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../private-worker/peer"
import {
  PATH_TRANSPORT_FAILURE_MESSAGE,
  ServePrivatePeer,
  canonicalPathOpId,
  comparePathParity,
  normalizePrivatePathWire,
  validatePathContractRequest,
  validatePathResult,
} from "./serve-private-peer"
import { makePathAmbiguous, PATH_FAILED_CODE, PATH_FAILED_MESSAGE, PATH_INVALID_DETAIL } from "./serve-private-path-contract"
import {
  buildPathIdentity,
  observePathParityDetached,
  sdkPathHasTerminal,
  type PathParityConnection,
} from "../../kilo-provider/path-parity"
import { failedPathResult, requestPathOutcome } from "./serve-private-path"

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
  const opId = canonicalPathOpId("tok1")
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "path/get" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp" },
    payload: {},
    ...over,
  }
}

function makePayload(over: Record<string, unknown> = {}) {
  return {
    home: "/home/u",
    state: "/home/u/.local/state/kilo",
    config: "/home/u/.config/kilo",
    worktree: "/tmp",
    directory: "/tmp",
    ...over,
  }
}

function makeSuccess(req: ReturnType<typeof makeReq>, over: Record<string, unknown> = {}) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "path/get",
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { path: makePayload(over) },
  }
}

describe("path/get private peer", () => {
  test("opId grammar is single token with idempotency equality", () => {
    expect(canonicalPathOpId("t1")).toBe("path:t1")
    const req = validatePathContractRequest(makeReq())
    expect(req.opId).toBe("path:tok1")
    expect(() => validatePathContractRequest({ ...makeReq(), idempotencyKey: canonicalPathOpId("other") })).toThrow()
    expect(() => canonicalPathOpId("/tmp/private")).toThrow()
    expect(() => validatePathContractRequest({ ...makeReq(), requestId: "/tmp/secret" })).toThrow()
    const slash = { ...makeReq(), opId: "path:/tmp/private", idempotencyKey: "path:/tmp/private" }
    expect(() => validatePathContractRequest(slash)).toThrow()
  })

  test("same-directory success carries exactly five safe fields", () => {
    const req = validatePathContractRequest(makeReq())
    const ok = validatePathResult(makeSuccess(req), req)
    expect(ok.status).toBe("succeeded")
    const payload = (ok as Extract<typeof ok, { status: "succeeded" }>).data.path
    expect(Object.keys(payload).sort()).toEqual(["config", "directory", "home", "state", "worktree"])
    // Differing worktree/directory values are shape-valid (no worktree===directory guarantee).
    expect(() => validatePathResult(makeSuccess(req, { worktree: "/repo", directory: "/repo/sub" }), req)).not.toThrow()
  })

  test("malformed request/result/failure redact without path material", () => {
    const req = validatePathContractRequest(makeReq())
    expect(() => validatePathContractRequest({ ...makeReq(), context: { directory: "relative" } })).toThrow()
    expect(() => validatePathResult({ ...makeSuccess(req), data: { path: { directory: "/tmp" } } }, req)).toThrow()
    expect(() =>
      validatePathResult(
        { ...makeSuccess(req), data: { path: { ...makePayload(), extra: 1 } } },
        req,
      ),
    ).toThrow()
    const bad = normalizePrivatePathWire({ bogus: true }, req)
    expect(bad.kind).toBe("invalid")
    expect(bad.kind === "invalid" ? bad.detail.includes("/tmp") : false).toBeFalse()
  })

  test("parity compares only worktree/directory without asserting worktree===directory", () => {
    const req = validatePathContractRequest(makeReq())
    const ok = validatePathResult(makeSuccess(req), req)
    expect(comparePathParity(ok, { data: makePayload() }).divergence).toBeNull()
    // Globals excluded: differing home/state/config never diverge.
    expect(
      comparePathParity(ok, { data: makePayload({ home: "/o", state: "/o", config: "/o" }) }).divergence,
    ).toBeNull()
    // Request directory never compared: SDK payload without globals still holds.
    expect(comparePathParity(ok, { data: { worktree: "/tmp", directory: "/tmp" } }).divergence).toBeNull()
    expect(
      comparePathParity(ok, { data: makePayload({ directory: "/other" }) }).divergence,
    ).toBe("path-directory-mismatch")
    expect(
      comparePathParity(ok, { data: makePayload({ worktree: "/other" }) }).divergence,
    ).toBe("path-worktree-mismatch")
    const split = validatePathResult(makeSuccess(req, { worktree: "/repo", directory: "/repo/sub" }), req)
    expect(comparePathParity(split, { data: makePayload({ worktree: "/repo", directory: "/repo/sub" }) }).divergence).toBeNull()
    expect(comparePathParity(makePathAmbiguous(req), { data: makePayload() }).divergence).toBe("transport-unknown")
  })

  test("peer capability gating requires path/get", () => {
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel(() => ({ v: 1 }))
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 1 })
    ;(peer as unknown as Record<string, unknown>).available = true
    ;(peer as unknown as Record<string, unknown>).peer = new JsonRpcPeer({ reader: clientReader, writer: clientWriter })
    ;(peer as unknown as Record<string, unknown>).capabilities = ["session/get"]
    const req = makeReq()
    expect(() => peer.privatePathOutcomeWithHandle(req as never)).toThrow("Private peer missing path/get capability")
    peer.dispose()
    backendPeer.dispose()
    clientReader.destroy()
    clientWriter.destroy()
  })

  test("peer unavailable/disposed fails closed", () => {
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel(() => ({ v: 1 }))
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 1 })
    const req = makeReq()
    expect(() => peer.privatePathOutcomeWithHandle(req as never)).toThrow("Private peer unavailable")
    peer.dispose()
    expect(() => peer.privatePathOutcomeWithHandle(req as never)).toThrow()
    backendPeer.dispose()
    clientReader.destroy()
    clientWriter.destroy()
  })

  test("peer outcome handle resolves normalized wire and excludes invalid wire", async () => {
    const req = makeReq()
    const success = makeSuccess(req)
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel((method) => {
      expect(method).toBe("path/get")
      return success
    })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 5 })
    ;(peer as unknown as Record<string, unknown>).available = true
    ;(peer as unknown as Record<string, unknown>).peer = new JsonRpcPeer({ reader: clientReader, writer: clientWriter })
    ;(peer as unknown as Record<string, unknown>).capabilities = ["path/get"]
    const outcome = await peer.privatePathOutcomeWithHandle(req as never).promise
    expect(outcome.kind).toBe("valid")
    if (outcome.kind === "valid") {
      expect(outcome.result.status).toBe("succeeded")
      expect(() => validatePathResult(outcome.result as unknown, req as never)).not.toThrow()
    }
    peer.dispose()
    backendPeer.dispose()
    clientReader.destroy()
    clientWriter.destroy()

    const bad = { ...success, data: { path: { directory: "/tmp" } } }
    expect(normalizePrivatePathWire(bad, req as never).kind).toBe("invalid")
  })

  test("peer transport failure uses operation-specific redaction", async () => {
    const req = makeReq()
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel(() => {
      throw Object.assign(new Error("boom /tmp/secret"), { code: 500 })
    })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 5 })
    ;(peer as unknown as Record<string, unknown>).available = true
    ;(peer as unknown as Record<string, unknown>).peer = new JsonRpcPeer({ reader: clientReader, writer: clientWriter })
    ;(peer as unknown as Record<string, unknown>).capabilities = ["path/get"]
    const outcome = await peer.privatePathOutcomeWithHandle(req as never).promise
    expect(outcome.kind).toBe("valid")
    if (outcome.kind === "valid") {
      // Handler throw surfaces as JSON-RPC transport closure (ambiguous
      // transportUnknown) or a redacted failed result; either way no raw
      // path material may leak.
      expect(JSON.stringify(outcome.result).includes("/tmp/secret")).toBeFalse()
      if (outcome.result.status === "failed") {
        const failed = outcome.result as Extract<typeof outcome.result, { status: "failed" }>
        expect(failed.failure.message).toBe(PATH_TRANSPORT_FAILURE_MESSAGE)
      } else {
        expect(outcome.result.status).toBe("ambiguous")
        expect((outcome.result as Record<string, unknown>).transportUnknown).toBeTrue()
      }
    }
    peer.dispose()
    backendPeer.dispose()
    clientReader.destroy()
    clientWriter.destroy()
  })

  test("operation-specific transport redaction on non-closed failure", async () => {
    const req = makeReq()
    const raw = {
      requestWithId: () => ({
        id: 41,
        promise: Promise.reject(Object.assign(new Error("boom /tmp/secret"), { code: 500 })),
      }),
    }
    const outcome = await requestPathOutcome(
      raw,
      { isStale: () => false, isClosed: () => false, failInfo: () => ({ code: "500", msg: "ignored" }) },
      () => () => true,
      req as never,
    ).promise
    expect(outcome.kind).toBe("valid")
    if (outcome.kind === "valid") {
      const failed = outcome.result as Extract<typeof outcome.result, { status: "failed" }>
      expect(failed.status).toBe("failed")
      expect(failed.failure.message).toBe(PATH_TRANSPORT_FAILURE_MESSAGE)
      expect(JSON.stringify(failed).includes("/tmp/secret")).toBeFalse()
    }
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
    ;(peer as unknown as Record<string, unknown>).capabilities = ["path/get"]
    const handle = peer.privatePathOutcomeWithHandle(req as never)
    expect(typeof handle.id).toBe("number")
    expect(peer.getPendingCount()).toBe(1)
    expect(handle.cancel()).toBeTrue()
    release!(makeSuccess(req))
    const outcome = await handle.promise
    expect(outcome.kind).toBe("valid")
    peer.dispose()
    backendPeer.dispose()
    clientReader.destroy()
    clientWriter.destroy()
  })

  test("untrusted path failure code/message never reaches direct or detached consumers", async () => {
    const evilDir = "/tmp/secret-evil"
    const req = validatePathContractRequest(makeReq())
    const evilFailed = {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "path/get",
      idempotencyKey: req.idempotencyKey,
      status: "failed",
      outcome: {
        type: "failed",
        time: 1,
        failure: { code: `${evilDir}/code`, message: `boom ${evilDir}/file`, retryable: false },
      },
      accepted: false,
      failure: { code: `${evilDir}/code`, message: `boom ${evilDir}/file`, retryable: false },
    }
    // Normalized outcome is invalid with fixed detail, never valid failed with leak.
    const wire = normalizePrivatePathWire(evilFailed, req as never)
    expect(wire.kind).toBe("invalid")
    if (wire.kind === "invalid") {
      expect(wire.detail).toBe(PATH_INVALID_DETAIL)
      expect(wire.detail).not.toContain(evilDir)
    }
    // Safe failed normalizes to fixed operation-specific code/message, preserving retryable.
    const safeFailed = {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "path/get",
      idempotencyKey: req.idempotencyKey,
      status: "failed",
      outcome: { type: "failed", time: 1, failure: { code: "validation.failed", message: "bad", retryable: true } },
      accepted: false,
      failure: { code: "validation.failed", message: "bad", retryable: true },
    }
    const safeWire = normalizePrivatePathWire(safeFailed, req as never)
    expect(safeWire.kind).toBe("valid")
    if (safeWire.kind === "valid" && safeWire.result.status === "failed") {
      expect(safeWire.result.failure.code).toBe(PATH_FAILED_CODE)
      expect(safeWire.result.failure.message).toBe(PATH_FAILED_MESSAGE)
      expect(safeWire.result.failure.retryable).toBeTrue()
      expect(JSON.stringify(safeWire.result)).not.toContain(evilDir)
    }
    // Malformed payload/result keys with path-like names stay fixed and non-echoing.
    const evilKey = `${evilDir}/evil-key`
    const malformed = { ...makeSuccess(req), [evilKey]: 1 }
    const malWire = normalizePrivatePathWire(malformed, req as never)
    expect(malWire.kind).toBe("invalid")
    if (malWire.kind === "invalid") {
      expect(malWire.detail).toBe(PATH_INVALID_DETAIL)
      expect(malWire.detail).not.toContain(evilDir)
    }
    // Locally constructed transport failures stay fixed and sanitized.
    const local = failedPathResult(req as never, "/tmp/evil-code", "/tmp/evil-msg")
    expect(local.status).toBe("failed")
    if (local.status === "failed") {
      expect(local.failure.message).toBe(PATH_TRANSPORT_FAILURE_MESSAGE)
      expect(local.failure.code).not.toContain(evilDir)
      expect(JSON.stringify(local)).not.toContain(evilDir)
    }
    // Direct privatePath() with untrusted failed wire throws fixed validation, never leaks.
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel(() => evilFailed)
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 5 })
    ;(peer as unknown as Record<string, unknown>).available = true
    ;(peer as unknown as Record<string, unknown>).peer = new JsonRpcPeer({ reader: clientReader, writer: clientWriter })
    ;(peer as unknown as Record<string, unknown>).capabilities = ["path/get"]
    let threw = ""
    try {
      await peer.privatePath(req as never)
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e)
    }
    expect(threw.length).toBeGreaterThan(0)
    expect(threw).not.toContain(evilDir)
    expect(threw).not.toContain("secret-evil")
    // Outcome handle for the same wire is invalid with fixed detail.
    const outcome = await peer.privatePathOutcomeWithHandle(req as never).promise
    expect(outcome.kind).toBe("invalid")
    if (outcome.kind === "invalid") {
      expect(outcome.detail).toBe(PATH_INVALID_DETAIL)
      expect(outcome.detail).not.toContain(evilDir)
    }
    peer.dispose()
    backendPeer.dispose()
    clientReader.destroy()
    clientWriter.destroy()
  })

  test("detached observer is terminal-gated, non-blocking, and SDK-authoritative", async () => {
    expect(sdkPathHasTerminal({ data: makePayload() } as never)).toBeTrue()
    expect(sdkPathHasTerminal({ error: { status: 500 }, response: { status: 500 } } as never)).toBeTrue()
    expect(sdkPathHasTerminal({ error: { message: "boom" } } as never)).toBeFalse()
    expect(sdkPathHasTerminal({} as never)).toBeFalse()
    const ident = buildPathIdentity()
    expect(ident.opId.startsWith("path:")).toBeTrue()
    expect(ident.idempotencyKey).toBe(ident.opId)

    let calls = 0
    const conn = {
      isPrivateAvailable: () => true,
      privatePathOutcomeWithHandle: () => {
        calls += 1
        return { id: 1, promise: Promise.resolve({ kind: "invalid", detail: "bad wire" }), cancel: () => true }
      },
    } as unknown as PathParityConnection
    const sdk = { data: makePayload() }
    const ret = observePathParityDetached(conn, sdk as never, "/tmp")
    expect(ret).toBeUndefined()
    expect(calls).toBe(1)
    await new Promise((r) => setTimeout(r, 25))
    // SDK snapshot unchanged by the detached invalid-wire observation.
    expect((sdk as { data: unknown }).data).toEqual(makePayload())
    // Non-terminal SDK never observes.
    const idle = { isPrivateAvailable: () => { throw new Error("must not check") } } as unknown as PathParityConnection
    expect(() => observePathParityDetached(idle, {} as never, "/tmp")).not.toThrow()
  })
})
