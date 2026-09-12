import { describe, expect, test } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../private-worker/peer"
import { ServePrivatePeer } from "./serve-private-peer"
import {
  canonicalConfigWarningsOpId,
  compareConfigWarningsParity,
  normalizePrivateConfigWarningsWire,
  validateConfigWarningsContractRequest as validateConfigWarningsRequest,
  validateConfigWarningsResult,
} from "./serve-private-config-warnings-contract"
import { buildConfigWarningsIdentity } from "../../kilo-provider/config-warnings-privatefirst"
import {
  CONFIG_WARNINGS_TRANSPORT_FAILURE_MESSAGE,
  requestConfigWarningsOutcome,
} from "./serve-private-config-warnings"

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
  const opId = canonicalConfigWarningsOpId("tok1")
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "config/warnings" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp" },
    payload: {},
    ...over,
  }
}

function safeEntry(pathCategory = "agent-file", messageCategory = "invalid-file") {
  return { pathCategory, messageCategory }
}

function makeSuccess(req: ReturnType<typeof makeReq>, warnings: unknown[] = [safeEntry()]) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "config/warnings",
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { warnings },
  }
}

function makeFailed(req: ReturnType<typeof makeReq>, code: string) {
  const fixed: Record<string, { message: string; retryable: boolean }> = {
    "validation.failed": { message: "invalid config-warnings request", retryable: false },
    internal: { message: "internal error", retryable: false },
    transport: { message: "private config-warnings transport failed", retryable: false },
    InstanceUnavailableDuringConfigRebuild: {
      message: "Instance is unavailable during config rebuild; no active runtime for this request",
      retryable: true,
    },
  }
  const entry = fixed[code] ?? { message: "internal error", retryable: false }
  const safeCode = fixed[code] ? code : "internal"
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "config/warnings",
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: {
      type: "failed",
      time: 1,
      failure: { code: safeCode, message: entry.message, retryable: entry.retryable },
    },
    accepted: false,
    failure: { code: safeCode, message: entry.message, retryable: entry.retryable },
  }
}

function sdkSuccess(items: unknown[]) {
  return { data: items, error: undefined, response: { status: 200 } }
}

function rawWarning(path: string, message: string) {
  return { path, message }
}

describe("config-warnings private peer", () => {
  test("canonicalConfigWarningsOpId binds a single colon-free token with idempotency equality", () => {
    expect(canonicalConfigWarningsOpId("t1")).toBe("config-warnings:t1")
    expect(() => canonicalConfigWarningsOpId("")).toThrow()
    expect(() => canonicalConfigWarningsOpId("a:b")).toThrow()
    const ident = buildConfigWarningsIdentity()
    expect(ident.opId.startsWith("config-warnings:")).toBeTrue()
    expect(ident.idempotencyKey).toBe(ident.opId)
  })

  test("validateConfigWarningsRequest accepts strict shape and rejects violations", () => {
    const req = makeReq()
    expect(() => validateConfigWarningsRequest(req)).not.toThrow()
    expect(() =>
      validateConfigWarningsRequest(makeReq({ context: { directory: "/tmp", workspace: "w" } })),
    ).not.toThrow()
    expect(() => validateConfigWarningsRequest({ ...req, opId: "config-warnings:a:b" })).toThrow()
    expect(() =>
      validateConfigWarningsRequest({ ...req, opId: "config:tok1", idempotencyKey: "config:tok1" }),
    ).toThrow()
    expect(() => validateConfigWarningsRequest({ ...req, idempotencyKey: "config-warnings:other" })).toThrow()
    expect(() => validateConfigWarningsRequest({ ...req, context: { directory: "relative" } })).toThrow()
    expect(() => validateConfigWarningsRequest({ ...req, payload: { filter: {} } })).toThrow()
    expect(() => validateConfigWarningsRequest({ ...req, context: { directory: "/tmp", extra: 1 } })).toThrow()
    expect(() => validateConfigWarningsRequest({ ...req, extra: 1 })).toThrow()
    expect(() => validateConfigWarningsRequest({ ...req, op: "config/get" })).toThrow()
  })

  test("validateConfigWarningsResult enforces per-status shape with safe projection", () => {
    const req = makeReq()
    expect(() => validateConfigWarningsResult(makeSuccess(req), req)).not.toThrow()
    expect(() =>
      validateConfigWarningsResult(makeSuccess(req, [safeEntry("config-file", "invalid-json"), safeEntry()]), req),
    ).not.toThrow()
    expect(() => validateConfigWarningsResult({ ...makeSuccess(req), data: { warnings: [] } }, req)).not.toThrow()
    // Duplicate safe entries are legal (multiset parity).
    expect(() => validateConfigWarningsResult(makeSuccess(req, [safeEntry(), safeEntry()]), req)).not.toThrow()
    // Raw warning fields are rejected.
    expect(() => validateConfigWarningsResult(makeSuccess(req, [{ path: "/p", message: "m" }]), req)).toThrow()
    expect(() => validateConfigWarningsResult(makeSuccess(req, [{ ...safeEntry(), detail: "x" }]), req)).toThrow()
    expect(() => validateConfigWarningsResult(makeSuccess(req, [{ pathCategory: "other" }]), req)).toThrow()
    expect(() =>
      validateConfigWarningsResult(makeSuccess(req, [{ pathCategory: "nope", messageCategory: "unknown" }]), req),
    ).toThrow()
    expect(() =>
      validateConfigWarningsResult(makeSuccess(req, [{ pathCategory: "other", messageCategory: "nope" }]), req),
    ).toThrow()
    expect(() => validateConfigWarningsResult({ ...makeSuccess(req), requestId: "r2" }, req)).toThrow()
    expect(() => validateConfigWarningsResult({ ...makeSuccess(req), data: { warnings: {} } }, req)).toThrow()
    const failed = makeFailed(req, "validation.failed")
    expect(() => validateConfigWarningsResult(failed, req)).not.toThrow()
    const ambiguous = {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "config/warnings",
      idempotencyKey: req.idempotencyKey,
      status: "ambiguous",
      outcome: { type: "ambiguous", time: 1 },
      accepted: false,
      transportUnknown: true,
    }
    expect(() => validateConfigWarningsResult(ambiguous, req)).not.toThrow()
  })

  test("compareConfigWarningsParity projects SDK raw entries and stays order-free", () => {
    const req = makeReq()
    const priv = makeSuccess(req, [safeEntry(), safeEntry("config-file", "invalid-json")]) as unknown as Parameters<
      typeof compareConfigWarningsParity
    >[0]
    const sdk = sdkSuccess([
      rawWarning("/w/kilo.jsonc", "Config file at /w/kilo.jsonc is not valid JSON(C)"),
      rawWarning("/w/agent/a.md", "Config file at /w/agent/a.md is invalid: bad"),
    ])
    expect(compareConfigWarningsParity(priv, sdk as never).divergence).toBeNull()
    const missing = compareConfigWarningsParity(
      priv,
      sdkSuccess([rawWarning("/w/agent/a.md", "Config file at /w/agent/a.md is invalid: bad")]) as never,
    )
    expect(missing.divergence).toBe("config-warnings-membership-unknown")
    const sdk404 = { error: { status: 404 }, response: { status: 404 } } as unknown as Parameters<
      typeof compareConfigWarningsParity
    >[1]
    const privFailed = makeFailed(req, "internal") as unknown as Parameters<typeof compareConfigWarningsParity>[0]
    expect(compareConfigWarningsParity(privFailed, sdk404).divergence).toBeNull()
  })

  test("peer capability gating requires config/warnings", () => {
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel(() => ({ v: 1 }))
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 1 })
    ;(peer as unknown as Record<string, unknown>).available = true
    ;(peer as unknown as Record<string, unknown>).peer = new JsonRpcPeer({ reader: clientReader, writer: clientWriter })
    ;(peer as unknown as Record<string, unknown>).capabilities = ["command/list"]
    const req = makeReq()
    expect(() => peer.privateConfigWarningsOutcomeWithHandle(req as never)).toThrow(
      "Private peer missing config/warnings capability",
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
    expect(() => peer.privateConfigWarningsOutcomeWithHandle(req as never)).toThrow("Private peer unavailable")
    peer.dispose()
    expect(() => peer.privateConfigWarningsOutcomeWithHandle(req as never)).toThrow()
    backendPeer.dispose()
    clientReader.destroy()
    clientWriter.destroy()
  })

  test("peer outcome handle resolves normalized wire and excludes invalid wire", async () => {
    const req = makeReq()
    const success = makeSuccess(req, [safeEntry()])
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel((method) => {
      expect(method).toBe("config/warnings")
      return success
    })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 5 })
    ;(peer as unknown as Record<string, unknown>).available = true
    ;(peer as unknown as Record<string, unknown>).peer = new JsonRpcPeer({ reader: clientReader, writer: clientWriter })
    ;(peer as unknown as Record<string, unknown>).capabilities = ["config/warnings"]
    const outcome = await peer.privateConfigWarningsOutcomeWithHandle(req as never).promise
    expect(outcome.kind).toBe("valid")
    if (outcome.kind === "valid") {
      expect(outcome.result.status).toBe("succeeded")
      expect(() => validateConfigWarningsResult(outcome.result as unknown, req as never)).not.toThrow()
      const wire = JSON.stringify(outcome.result)
      expect(wire.includes("/tmp")).toBeFalse()
      expect(wire.includes("detail")).toBeFalse()
    }
    peer.dispose()
    backendPeer.dispose()
    clientReader.destroy()
    clientWriter.destroy()

    const bad = { ...success, data: { warnings: [{ path: "/p", message: "m" }] } }
    expect(normalizePrivateConfigWarningsWire(bad, req as never).kind).toBe("invalid")
  })

  test("peer outcome handle excludes invalid wire before any comparator", async () => {
    const req = makeReq()
    const bad = { ...makeSuccess(req, []), data: { warnings: [{ path: "/p", message: "m", detail: "x" }] } }
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel(() => bad)
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 5 })
    ;(peer as unknown as Record<string, unknown>).available = true
    ;(peer as unknown as Record<string, unknown>).peer = new JsonRpcPeer({ reader: clientReader, writer: clientWriter })
    ;(peer as unknown as Record<string, unknown>).capabilities = ["config/warnings"]
    const outcome = await peer.privateConfigWarningsOutcomeWithHandle(req as never).promise
    expect(outcome.kind).toBe("invalid")
    if (outcome.kind !== "invalid") throw new Error("expected invalid wire outcome for raw-bearing entry")
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
    ;(peer as unknown as Record<string, unknown>).capabilities = ["config/warnings"]
    const handle = peer.privateConfigWarningsOutcomeWithHandle(req as never)
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

  test("config-warnings transport failures are redacted to a fixed safe message", async () => {
    const req = makeReq()
    const rawErr = new Error("secret transport boom /tmp/cfg-abc detail=hidden")
    ;(rawErr as unknown as Record<string, unknown>).code = -32603
    const raw = {
      requestWithId: () => ({ id: 7, promise: Promise.reject(rawErr) }),
    }
    const host = {
      isStale: () => false,
      isClosed: () => false,
      failInfo: () => ({ code: "-32603", msg: "secret transport boom /tmp/cfg-abc detail=hidden" }),
    }
    const handle = requestConfigWarningsOutcome(raw as never, host, () => () => true, req as never)
    const outcome = await handle.promise
    expect(outcome.kind).toBe("valid")
    if (outcome.kind !== "valid") throw new Error("expected valid failure outcome")
    expect(outcome.result.status).toBe("failed")
    const failed = outcome.result as unknown as {
      failure: { code: string; message: string; retryable: boolean }
      outcome: { failure: { code: string; message: string; retryable: boolean } }
    }
    expect(failed.failure.code).toBe("transport")
    expect(failed.failure.message).toBe(CONFIG_WARNINGS_TRANSPORT_FAILURE_MESSAGE)
    expect(failed.failure.retryable).toBeFalse()
    expect(failed.outcome.failure.message).toBe(CONFIG_WARNINGS_TRANSPORT_FAILURE_MESSAGE)
    expect(failed.outcome.failure.code).toBe("transport")
    const leaked = JSON.stringify(outcome.result)
    expect(leaked.includes("secret transport boom")).toBeFalse()
    expect(leaked.includes("cfg-abc")).toBeFalse()
    expect(leaked.includes("detail=hidden")).toBeFalse()
    expect(leaked.includes("-32603")).toBeFalse()
  })

  test("failed accepted:true is rejected and arbitrary backend failures are invalid", () => {
    const req = makeReq()
    const failed = makeFailed(req, "internal")
    expect(() => validateConfigWarningsResult({ ...failed, accepted: true }, req as never)).toThrow()
    const arbitrary = {
      ...failed,
      failure: { code: "-32603", message: "boom /tmp/x", retryable: false },
      outcome: { type: "failed", time: 1, failure: { code: "-32603", message: "boom /tmp/x", retryable: false } },
    }
    expect(() => validateConfigWarningsResult(arbitrary, req as never)).toThrow()
    expect(normalizePrivateConfigWarningsWire(arbitrary, req as never).kind).toBe("invalid")
  })

  test("peer cancel and invalidation never echo op or routing material", async () => {
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const req = makeReq()
      const { clientReader, clientWriter, backendPeer } = createLinkedChannel(() => makeFailed(req, "internal"))
      const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 5 })
      ;(peer as unknown as Record<string, unknown>).available = true
      ;(peer as unknown as Record<string, unknown>).peer = new JsonRpcPeer({
        reader: clientReader,
        writer: clientWriter,
      })
      ;(peer as unknown as Record<string, unknown>).capabilities = ["config/warnings"]
      const handle = peer.privateConfigWarningsOutcomeWithHandle(req as never)
      expect(handle.cancel("private parity timeout")).toBeTrue()
      await handle.promise
      peer.invalidateOnObserverTimeout("config-warnings observer timeout exact cancel miss")
      const wire = JSON.stringify(warns)
      expect(wire.includes(req.opId)).toBeFalse()
      expect(wire.includes(req.requestId)).toBeFalse()
      expect(wire.includes("/tmp")).toBeFalse()
      peer.dispose()
      backendPeer.dispose()
      clientReader.destroy()
      clientWriter.destroy()
    } finally {
      console.warn = origWarn
    }
  })
})
