import { describe, expect, test } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../private-worker/peer"
import { ServePrivatePeer } from "./serve-private-peer"
import {
  canonicalProjectCurrentOpId,
  compareProjectCurrentParity,
  normalizePrivateProjectCurrentWire,
  validateProjectCurrentContractRequest as validateProjectCurrentRequest,
  validateProjectCurrentResult,
} from "./serve-private-project-current-contract"
import {
  buildProjectCurrentIdentity,
  observeProjectCurrentParityDetached,
  sdkProjectCurrentHasTerminal,
  type ProjectCurrentParityConnection,
} from "../../kilo-provider/project-current-parity"
import {
  PROJECT_CURRENT_TRANSPORT_FAILURE_MESSAGE,
  requestProjectCurrentOutcome,
} from "./serve-private-project-current"

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
  const opId = canonicalProjectCurrentOpId("tok1")
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "project/current" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp" },
    payload: {},
    ...over,
  }
}

function makeSuccess(req: ReturnType<typeof makeReq>, data: unknown = {}) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "project/current",
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data,
  }
}

function makeFailed(req: ReturnType<typeof makeReq>, code: string) {
  const fixed: Record<string, { message: string; retryable: boolean }> = {
    "validation.failed": { message: "invalid project-current request", retryable: false },
    internal: { message: "internal error", retryable: false },
    transport: { message: "private project-current transport failed", retryable: false },
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
    op: "project/current",
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

function sdkSuccess(data: unknown) {
  return { data, error: undefined, response: { status: 200 } }
}

describe("project-current vcs-only private peer", () => {
  test("canonicalProjectCurrentOpId binds a single colon-free token with idempotency equality", () => {
    expect(canonicalProjectCurrentOpId("t1")).toBe("project-current:t1")
    expect(() => canonicalProjectCurrentOpId("")).toThrow()
    expect(() => canonicalProjectCurrentOpId("a:b")).toThrow()
    const ident = buildProjectCurrentIdentity()
    expect(ident.opId.startsWith("project-current:")).toBeTrue()
    expect(ident.idempotencyKey).toBe(ident.opId)
  })

  test("validateProjectCurrentRequest accepts strict shape and rejects violations", () => {
    const req = makeReq()
    expect(() => validateProjectCurrentRequest(req)).not.toThrow()
    expect(() =>
      validateProjectCurrentRequest(makeReq({ context: { directory: "/tmp", workspace: "w" } })),
    ).not.toThrow()
    expect(() => validateProjectCurrentRequest({ ...req, opId: "project-current:a:b" })).toThrow()
    expect(() =>
      validateProjectCurrentRequest({ ...req, opId: "project:tok1", idempotencyKey: "project:tok1" }),
    ).toThrow()
    expect(() => validateProjectCurrentRequest({ ...req, idempotencyKey: "project-current:other" })).toThrow()
    expect(() => validateProjectCurrentRequest({ ...req, context: { directory: "relative" } })).toThrow()
    expect(() => validateProjectCurrentRequest({ ...req, payload: { filter: {} } })).toThrow()
    expect(() => validateProjectCurrentRequest({ ...req, context: { directory: "/tmp", extra: 1 } })).toThrow()
    expect(() => validateProjectCurrentRequest({ ...req, extra: 1 })).toThrow()
    expect(() => validateProjectCurrentRequest({ ...req, op: "project/list" })).toThrow()
  })

  test("validateProjectCurrentResult enforces per-status shape with vcs-only projection", () => {
    const req = makeReq()
    expect(() => validateProjectCurrentResult(makeSuccess(req), req)).not.toThrow()
    expect(() => validateProjectCurrentResult(makeSuccess(req, { vcs: "git" }), req)).not.toThrow()
    // Non-git vcs values are rejected.
    expect(() => validateProjectCurrentResult(makeSuccess(req, { vcs: "hg" }), req)).toThrow()
    // Path-bearing and out-of-scope fields are rejected.
    expect(() => validateProjectCurrentResult(makeSuccess(req, { worktree: "/tmp" }), req)).toThrow()
    expect(() => validateProjectCurrentResult(makeSuccess(req, { sandboxes: [] }), req)).toThrow()
    expect(() => validateProjectCurrentResult(makeSuccess(req, { id: "x" }), req)).toThrow()
    expect(() => validateProjectCurrentResult({ ...makeSuccess(req), requestId: "r2" }, req)).toThrow()
    expect(() => validateProjectCurrentResult({ ...makeSuccess(req), data: { vcs: "git", extra: 1 } }, req)).toThrow()
    const failed = makeFailed(req, "validation.failed")
    expect(() => validateProjectCurrentResult(failed, req)).not.toThrow()
    const ambiguous = {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "project/current",
      idempotencyKey: req.idempotencyKey,
      status: "ambiguous",
      outcome: { type: "ambiguous", time: 1 },
      accepted: false,
      transportUnknown: true,
    }
    expect(() => validateProjectCurrentResult(ambiguous, req)).not.toThrow()
  })

  test("compareProjectCurrentParity compares derived hasGit only", () => {
    const req = makeReq()
    const privGit = makeSuccess(req, { vcs: "git" }) as unknown as Parameters<typeof compareProjectCurrentParity>[0]
    const privNoGit = makeSuccess(req, {}) as unknown as Parameters<typeof compareProjectCurrentParity>[0]
    expect(compareProjectCurrentParity(privGit, sdkSuccess({ vcs: "git" }) as never).divergence).toBeNull()
    expect(compareProjectCurrentParity(privNoGit, sdkSuccess({}) as never).divergence).toBeNull()
    expect(compareProjectCurrentParity(privGit, sdkSuccess({}) as never).divergence).toBe(
      "project-current-hasgit-mismatch",
    )
    expect(compareProjectCurrentParity(privNoGit, sdkSuccess({ vcs: "git" }) as never).divergence).toBe(
      "project-current-hasgit-mismatch",
    )
    expect(compareProjectCurrentParity(privNoGit, sdkSuccess({ vcs: "hg" }) as never).divergence).toBe(
      "project-current-shape-mismatch",
    )
    const sdk404 = { error: { status: 404 }, response: { status: 404 } } as unknown as Parameters<
      typeof compareProjectCurrentParity
    >[1]
    const privFailed = makeFailed(req, "internal") as unknown as Parameters<typeof compareProjectCurrentParity>[0]
    expect(compareProjectCurrentParity(privFailed, sdk404).divergence).toBeNull()
  })

  test("peer capability gating requires project/current", () => {
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel(() => ({ v: 1 }))
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 1 })
    ;(peer as unknown as Record<string, unknown>).available = true
    ;(peer as unknown as Record<string, unknown>).peer = new JsonRpcPeer({ reader: clientReader, writer: clientWriter })
    ;(peer as unknown as Record<string, unknown>).capabilities = ["command/list"]
    const req = makeReq()
    expect(() => peer.privateProjectCurrentOutcomeWithHandle(req as never)).toThrow(
      "Private peer missing project/current capability",
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
    expect(() => peer.privateProjectCurrentOutcomeWithHandle(req as never)).toThrow("Private peer unavailable")
    peer.dispose()
    expect(() => peer.privateProjectCurrentOutcomeWithHandle(req as never)).toThrow()
    backendPeer.dispose()
    clientReader.destroy()
    clientWriter.destroy()
  })

  test("peer outcome handle resolves normalized wire and excludes invalid wire", async () => {
    const req = makeReq()
    const success = makeSuccess(req, { vcs: "git" })
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel((method) => {
      expect(method).toBe("project/current")
      return success
    })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 5 })
    ;(peer as unknown as Record<string, unknown>).available = true
    ;(peer as unknown as Record<string, unknown>).peer = new JsonRpcPeer({ reader: clientReader, writer: clientWriter })
    ;(peer as unknown as Record<string, unknown>).capabilities = ["project/current"]
    const outcome = await peer.privateProjectCurrentOutcomeWithHandle(req as never).promise
    expect(outcome.kind).toBe("valid")
    if (outcome.kind === "valid") {
      expect(outcome.result.status).toBe("succeeded")
      expect(() => validateProjectCurrentResult(outcome.result as unknown, req as never)).not.toThrow()
      const wire = JSON.stringify(outcome.result)
      expect(wire.includes("/tmp")).toBeFalse()
      expect(wire.includes("worktree")).toBeFalse()
      expect(wire.includes("sandboxes")).toBeFalse()
    }
    peer.dispose()
    backendPeer.dispose()
    clientReader.destroy()
    clientWriter.destroy()

    const bad = { ...success, data: { vcs: "hg" } }
    expect(normalizePrivateProjectCurrentWire(bad, req as never).kind).toBe("invalid")
  })

  test("peer outcome handle excludes path-bearing wire before any comparator", async () => {
    const req = makeReq()
    const bad = { ...makeSuccess(req, {}), data: { worktree: "/tmp/x", vcs: "git" } }
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel(() => bad)
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 5 })
    ;(peer as unknown as Record<string, unknown>).available = true
    ;(peer as unknown as Record<string, unknown>).peer = new JsonRpcPeer({ reader: clientReader, writer: clientWriter })
    ;(peer as unknown as Record<string, unknown>).capabilities = ["project/current"]
    const outcome = await peer.privateProjectCurrentOutcomeWithHandle(req as never).promise
    expect(outcome.kind).toBe("invalid")
    if (outcome.kind !== "invalid") throw new Error("expected invalid wire outcome for path-bearing entry")
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
    ;(peer as unknown as Record<string, unknown>).capabilities = ["project/current"]
    const handle = peer.privateProjectCurrentOutcomeWithHandle(req as never)
    expect(typeof handle.id).toBe("number")
    expect(peer.getPendingCount()).toBe(1)
    expect(handle.cancel()).toBeTrue()
    release!({ kind: "valid", result: makeSuccess(req, {}) })
    const outcome = await handle.promise
    expect(outcome.kind).toBe("valid")
    peer.dispose()
    backendPeer.dispose()
    clientReader.destroy()
    clientWriter.destroy()
  })

  test("sdkProjectCurrentHasTerminal gates record data and terminal failures only", () => {
    expect(sdkProjectCurrentHasTerminal({ data: { vcs: "git" } } as never)).toBeTrue()
    expect(sdkProjectCurrentHasTerminal(sdkSuccess({}) as never)).toBeTrue()
    expect(sdkProjectCurrentHasTerminal({ data: [] } as never)).toBeFalse()
    expect(sdkProjectCurrentHasTerminal({ error: { status: 500 }, response: { status: 500 } } as never)).toBeTrue()
    expect(sdkProjectCurrentHasTerminal({ error: { message: "boom" } } as never)).toBeFalse()
    expect(sdkProjectCurrentHasTerminal({ error: { code: "ECONNRESET" } } as never)).toBeFalse()
    expect(sdkProjectCurrentHasTerminal({ data: undefined } as never)).toBeFalse()
    expect(sdkProjectCurrentHasTerminal({} as never)).toBeFalse()
  })

  test("project-current transport failures are redacted to a fixed safe message", async () => {
    const req = makeReq()
    const rawErr = new Error("secret transport boom /tmp/proj-abc detail=hidden")
    ;(rawErr as unknown as Record<string, unknown>).code = -32603
    const raw = {
      requestWithId: () => ({ id: 7, promise: Promise.reject(rawErr) }),
    }
    const host = {
      isStale: () => false,
      isClosed: () => false,
      failInfo: () => ({ code: "-32603", msg: "secret transport boom /tmp/proj-abc detail=hidden" }),
    }
    const handle = requestProjectCurrentOutcome(raw as never, host, () => () => true, req as never)
    const outcome = await handle.promise
    expect(outcome.kind).toBe("valid")
    if (outcome.kind !== "valid") throw new Error("expected valid failure outcome")
    expect(outcome.result.status).toBe("failed")
    const failed = outcome.result as unknown as {
      failure: { code: string; message: string; retryable: boolean }
      outcome: { failure: { code: string; message: string; retryable: boolean } }
    }
    expect(failed.failure.code).toBe("transport")
    expect(failed.failure.message).toBe(PROJECT_CURRENT_TRANSPORT_FAILURE_MESSAGE)
    expect(failed.failure.retryable).toBeFalse()
    expect(failed.outcome.failure.message).toBe(PROJECT_CURRENT_TRANSPORT_FAILURE_MESSAGE)
    expect(failed.outcome.failure.code).toBe("transport")
    const leaked = JSON.stringify(outcome.result)
    expect(leaked.includes("secret transport boom")).toBeFalse()
    expect(leaked.includes("proj-abc")).toBeFalse()
    expect(leaked.includes("detail=hidden")).toBeFalse()
    expect(leaked.includes("-32603")).toBeFalse()
  })

  test("failed accepted:true is rejected and arbitrary backend failures are invalid", () => {
    const req = makeReq()
    const failed = makeFailed(req, "internal")
    expect(() => validateProjectCurrentResult({ ...failed, accepted: true }, req as never)).toThrow()
    const arbitrary = {
      ...failed,
      failure: { code: "-32603", message: "boom /tmp/x", retryable: false },
      outcome: { type: "failed", time: 1, failure: { code: "-32603", message: "boom /tmp/x", retryable: false } },
    }
    expect(() => validateProjectCurrentResult(arbitrary, req as never)).toThrow()
    expect(normalizePrivateProjectCurrentWire(arbitrary, req as never).kind).toBe("invalid")
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
      ;(peer as unknown as Record<string, unknown>).capabilities = ["project/current"]
      const handle = peer.privateProjectCurrentOutcomeWithHandle(req as never)
      expect(handle.cancel("private parity timeout")).toBeTrue()
      await handle.promise
      peer.invalidateOnObserverTimeout("project-current observer timeout exact cancel miss")
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

  test("observer is detached, warn-only, and never mutates SDK state", async () => {
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const sdk = sdkSuccess({ vcs: "git" })
      const before = JSON.stringify(sdk)
      const conn: ProjectCurrentParityConnection = {
        isPrivateAvailable: () => true,
        privateProjectCurrentOutcomeWithHandle: (req) => ({
          id: 1,
          promise: Promise.resolve({
            kind: "valid",
            result: {
              v: 1,
              requestId: req.requestId,
              opId: req.opId,
              op: "project/current",
              idempotencyKey: req.idempotencyKey,
              status: "succeeded",
              outcome: { type: "succeeded", time: 1 },
              accepted: true,
              data: { vcs: "git" },
            },
          }),
        }),
        getPrivateEpoch: () => 1,
      }
      const ret = observeProjectCurrentParityDetached(conn, sdk as never, "/tmp", undefined)
      expect(ret).toBeUndefined()
      expect(JSON.stringify(sdk)).toBe(before)
      await new Promise((r) => setTimeout(r, 50))
      expect(JSON.stringify(sdk)).toBe(before)
      expect(warns.filter((w) => String(w[0]).includes("divergence"))).toHaveLength(0)
    } finally {
      console.warn = origWarn
    }
  })

  test("observer never launches private work for non-terminal SDK input", async () => {
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const calls: string[] = []
      const conn: ProjectCurrentParityConnection = {
        isPrivateAvailable: () => true,
        privateProjectCurrentOutcomeWithHandle: (req) => {
          calls.push(req.opId)
          return { id: 1, promise: Promise.resolve({ kind: "valid", result: {} }) }
        },
        getPrivateEpoch: () => 1,
      }
      observeProjectCurrentParityDetached(conn, { error: { message: "boom" } } as never, "/tmp", undefined)
      await new Promise((r) => setTimeout(r, 30))
      expect(calls).toHaveLength(0)
      expect(warns).toHaveLength(0)
    } finally {
      console.warn = origWarn
    }
  })

  test("hasGit mismatch logs carry booleans only, never vcs material", async () => {
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const sdk = sdkSuccess({ vcs: "git" })
      const conn: ProjectCurrentParityConnection = {
        isPrivateAvailable: () => true,
        privateProjectCurrentOutcomeWithHandle: (req) => ({
          id: 1,
          promise: Promise.resolve({
            kind: "valid",
            result: {
              v: 1,
              requestId: req.requestId,
              opId: req.opId,
              op: "project/current",
              idempotencyKey: req.idempotencyKey,
              status: "succeeded",
              outcome: { type: "succeeded", time: 1 },
              accepted: true,
              data: {},
            },
          }),
        }),
        getPrivateEpoch: () => 1,
      }
      observeProjectCurrentParityDetached(conn, sdk as never, "/tmp", undefined)
      await new Promise((r) => setTimeout(r, 50))
      expect(warns.length).toBeGreaterThan(0)
      const wire = JSON.stringify(warns)
      expect(wire.includes("project-current-hasgit-mismatch")).toBe(true)
      expect(wire.includes("/tmp")).toBe(false)
    } finally {
      console.warn = origWarn
    }
  })

  test("observer defers without work while the peer negotiates", async () => {
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const calls: string[] = []
      let deferred: (() => void) | null = null
      const conn: ProjectCurrentParityConnection = {
        isPrivateAvailable: () => false,
        privateProjectCurrentOutcomeWithHandle: (req) => {
          calls.push(req.opId)
          return { id: 1, promise: Promise.resolve({ kind: "valid", result: {} }) }
        },
        getPrivateEpoch: () => 3,
        addDeferredProjectCurrentObserver: (_d, _w, listener) => {
          deferred = listener
          return () => {
            deferred = null
          }
        },
      }
      observeProjectCurrentParityDetached(conn, sdkSuccess({}) as never, "/tmp", undefined)
      await new Promise((r) => setTimeout(r, 20))
      expect(calls).toHaveLength(0)
      expect(deferred).not.toBeNull()
    } finally {
      console.warn = origWarn
    }
  })
})
