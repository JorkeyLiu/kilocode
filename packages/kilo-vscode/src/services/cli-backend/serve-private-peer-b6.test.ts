import { describe, expect, test } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../private-worker/peer"
import {
  ServePrivatePeer,
  canonicalGetOpId,
  validateGetRequest,
  validateGetResult,
  normalizePrivateGetWire,
  compareGetParity,
  isPrivateGetValidationError,
} from "./serve-private-peer"
import {
  buildSessionGetIdentity,
  observeSessionGetParityDetached,
  sdkGetHasTerminal,
  SESSION_GET_PARITY_TIMEOUT_MS,
  getSessionGetParityDiagnostics,
  resetSessionGetParityDiagnostics,
  type GetParityConnection,
} from "../../kilo-provider/session-get-parity"

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
  const sessionId = "ses_abc"
  const opId = canonicalGetOpId(sessionId, "tok1")
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "session/get" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp", sessionId },
    payload: {},
    ...over,
  }
}

function makeSuccess(req: ReturnType<typeof makeReq>, session: Record<string, unknown> = {}) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/get",
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { session: { id: "ses_abc", directory: "/tmp", title: "hello", ...session } },
  }
}

function makeFailed(req: ReturnType<typeof makeReq>, code: string) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/get",
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure: { code, message: "x", retryable: false } },
    accepted: false,
    failure: { code, message: "x", retryable: false },
  }
}

describe("B6 session/get private peer", () => {
  test("canonicalGetOpId binds session and token strictly", () => {
    expect(canonicalGetOpId("ses_a", "t1")).toBe("get:ses_a:t1")
    expect(() => canonicalGetOpId("ses_a", "")).toThrow()
    expect(() => canonicalGetOpId("ses_a", "a:b")).toThrow()
    expect(() => canonicalGetOpId("", "t1")).toThrow()
    expect(() => canonicalGetOpId("ses:a", "t1")).toThrow()
    expect(buildSessionGetIdentity("ses_a").opId.startsWith("get:ses_a:")).toBeTrue()
    const ident = buildSessionGetIdentity("ses_a")
    expect(ident.idempotencyKey).toBe(ident.opId)
  })

  test("validateGetRequest accepts strict shape and rejects violations", () => {
    const req = makeReq()
    expect(() => validateGetRequest(req)).not.toThrow()
    expect(() => validateGetRequest({ ...req, opId: "get:ses_other:tok1" })).toThrow()
    expect(() => validateGetRequest({ ...req, idempotencyKey: "get:ses_abc:other" })).toThrow()
    expect(() => validateGetRequest({ ...req, context: { directory: "relative", sessionId: "ses_abc" } })).toThrow()
    expect(() => validateGetRequest({ ...req, context: { directory: "/tmp", sessionId: "bad" } })).toThrow()
    expect(() => validateGetRequest({ ...req, payload: { extra: 1 } })).toThrow()
    expect(() => validateGetRequest({ ...req, context: { directory: "/tmp", sessionId: "ses_abc", extra: 1 } })).toThrow()
    expect(() => validateGetRequest({ ...req, extra: 1 })).toThrow()
  })

  test("validateGetResult enforces identity and per-status shape", () => {
    const req = makeReq()
    expect(() => validateGetResult(makeSuccess(req), req)).not.toThrow()
    expect(() => validateGetResult({ ...makeSuccess(req), requestId: "r2" }, req)).toThrow()
    expect(() => validateGetResult({ ...makeSuccess(req), opId: "get:ses_abc:other" }, req)).toThrow()
    expect(() => validateGetResult({ ...makeSuccess(req), data: { session: { id: "ses_abc" } } }, req)).toThrow()
    const failed = makeFailed(req, "session.not_found")
    expect(() => validateGetResult(failed, req)).not.toThrow()
    const ambiguous = {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "session/get",
      idempotencyKey: req.idempotencyKey,
      status: "ambiguous",
      outcome: { type: "ambiguous", time: 1 },
      accepted: false,
      transportUnknown: true,
    }
    expect(() => validateGetResult(ambiguous, req)).not.toThrow()
  })

  test("normalizePrivateGetWire separates valid from invalid without throwing", () => {
    const req = makeReq()
    const good = normalizePrivateGetWire(makeSuccess(req), req)
    expect(good.kind).toBe("valid")
    const bad = normalizePrivateGetWire({ ...makeSuccess(req), data: { session: { id: 1 } } }, req)
    expect(bad.kind).toBe("invalid")
    if (bad.kind === "invalid") expect(bad.detail.length).toBeGreaterThan(0)
  })

  test("compareGetParity success compares exactly id, canonical directory, title", () => {
    const req = makeReq()
    const sdk = { data: { id: "ses_abc", directory: "/tmp", title: "hello" }, error: undefined, response: { status: 200 } }
    const match = compareGetParity(makeSuccess(req) as unknown as never, sdk as unknown as never)
    expect(match.divergence).toBeNull()
    const idMismatch = compareGetParity(
      makeSuccess(req, { id: "ses_other" }) as unknown as never,
      sdk as unknown as never,
    )
    expect(idMismatch.divergence).toBe("get-id-mismatch")
    const dirMismatch = compareGetParity(
      makeSuccess(req, { directory: "/other" }) as unknown as never,
      sdk as unknown as never,
    )
    expect(dirMismatch.divergence).toBe("get-directory-mismatch")
    const titleMismatch = compareGetParity(
      makeSuccess(req, { title: "other" }) as unknown as never,
      sdk as unknown as never,
    )
    expect(titleMismatch.divergence).toBe("get-title-mismatch")
    // Volatile/sensitive extras never diverge and never leak into details.
    const volatile = makeSuccess(req, {
      time: { created: 999, updated: 999 },
      cost: 999,
      tokens: { input: 1 },
      summary: "secret",
      metadata: { k: "v" },
      permission: { allow: [] },
      model: { providerID: "x", modelID: "y" },
      agent: "other",
      share: { url: "secret" },
      revert: { diff: "secret" },
    })
    const vres = compareGetParity(volatile as unknown as never, sdk as unknown as never)
    expect(vres.divergence).toBeNull()
    expect(JSON.stringify(vres.details)).not.toContain("secret")
    // Canonicalized directory agrees across symlinked spellings.
    const canon = compareGetParity(
      makeSuccess(req, { directory: "/tmp/" }) as unknown as never,
      { data: { id: "ses_abc", directory: "/tmp", title: "hello" } } as unknown as never,
    )
    expect(canon.divergence).toBeNull()
  })

  test("compareGetParity failure classes 400/404/500 plus config-fence 409", () => {
    const req = makeReq()
    const sdk400 = { data: undefined, error: { status: 400 }, response: { status: 400 } }
    expect(compareGetParity(makeFailed(req, "validation.failed") as unknown as never, sdk400 as unknown as never).divergence).toBeNull()
    expect(compareGetParity(makeFailed(req, "scope_mismatch") as unknown as never, sdk400 as unknown as never).divergence).toBeNull()
    expect(compareGetParity(makeFailed(req, "internal") as unknown as never, sdk400 as unknown as never).divergence).toContain("failure-class-mismatch")
    const sdk404 = { data: undefined, error: { status: 404 }, response: { status: 404 } }
    expect(compareGetParity(makeFailed(req, "session.not_found") as unknown as never, sdk404 as unknown as never).divergence).toBeNull()
    expect(compareGetParity(makeFailed(req, "validation.failed") as unknown as never, sdk404 as unknown as never).divergence).toContain("failure-class-mismatch")
    const sdk500 = { data: undefined, error: { status: 500 }, response: { status: 500 } }
    expect(compareGetParity(makeFailed(req, "internal") as unknown as never, sdk500 as unknown as never).divergence).toBeNull()
    const sdk409 = { data: undefined, error: { status: 409 }, response: { status: 409 } }
    expect(
      compareGetParity(makeFailed(req, "InstanceUnavailableDuringConfigRebuild") as unknown as never, sdk409 as unknown as never).divergence,
    ).toBeNull()
    const ambiguous = {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "session/get",
      idempotencyKey: req.idempotencyKey,
      status: "ambiguous",
      outcome: { type: "ambiguous", time: 1 },
      accepted: false,
      transportUnknown: true,
    }
    expect(compareGetParity(ambiguous as unknown as never, { data: { id: "x" } } as unknown as never).divergence).toBe("transport-unknown")
    const ambiguousPlain = { ...ambiguous, transportUnknown: undefined }
    delete (ambiguousPlain as Record<string, unknown>).transportUnknown
    expect(
      compareGetParity(ambiguousPlain as unknown as never, sdk409 as unknown as never).divergence,
    ).toBeNull()
    expect(
      compareGetParity(ambiguousPlain as unknown as never, { data: { id: "x" } } as unknown as never).divergence,
    ).toContain("status-mismatch")
  })

  test("sdkGetHasTerminal gates observer to terminal results only", () => {
    expect(sdkGetHasTerminal({ data: { id: "ses_a" } })).toBeTrue()
    expect(sdkGetHasTerminal({ error: { status: 404 }, response: { status: 404 } })).toBeTrue()
    expect(sdkGetHasTerminal({ error: { status: 500 }, response: { status: 500 } })).toBeTrue()
    expect(sdkGetHasTerminal({ error: new Error("aborted"), response: undefined })).toBeFalse()
    expect(SESSION_GET_PARITY_TIMEOUT_MS).toBe(3000)
  })

  test("capability gating: session/get negotiates independently of B1-B5", async () => {
    const onlyGet = createLinkedChannel(async (method) => {
      if (method === "initialize")
        return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/get"] }
      throw new Error("unexpected")
    })
    const peerGet = new ServePrivatePeer({ reader: onlyGet.clientReader, writer: onlyGet.clientWriter, pid: 601, epoch: 61, initializeTimeoutMs: 300 })
    expect(await peerGet.initialize(300)).toBeTrue()
    expect(peerGet.hasCapability("session/get")).toBeTrue()
    expect(peerGet.hasCapability("session/status")).toBeFalse()
    peerGet.dispose()
    onlyGet.backendPeer.dispose()

    const legacy = createLinkedChannel(async (method) => {
      if (method === "initialize")
        return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/status"] }
      throw new Error("unexpected")
    })
    const peerLegacy = new ServePrivatePeer({ reader: legacy.clientReader, writer: legacy.clientWriter, pid: 602, epoch: 62, initializeTimeoutMs: 300 })
    expect(await peerLegacy.initialize(300)).toBeTrue()
    expect(peerLegacy.hasCapability("session/get")).toBeFalse()
    expect(peerLegacy.hasCapability("session/status")).toBeTrue()
    const req = makeReq()
    await expect(peerLegacy.privateGet(req as unknown as never)).rejects.toThrow("missing session/get capability")
    peerLegacy.dispose()
    legacy.backendPeer.dispose()
  })

  test("privateGet success round-trips and invalid wire rejects without comparator", async () => {
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel(async (method, params) => {
      if (method === "initialize")
        return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/get"] }
      if (method === "session/get") {
        const req = params as { requestId: string; opId: string; idempotencyKey: string }
        return {
          v: 1,
          requestId: req.requestId,
          opId: req.opId,
          op: "session/get",
          idempotencyKey: req.idempotencyKey,
          status: "succeeded",
          outcome: { type: "succeeded", time: Date.now() },
          accepted: true,
          data: { session: { id: "ses_abc", directory: "/tmp", title: "hello", time: { created: 1, updated: 2 } } },
        }
      }
      throw new Error("unexpected")
    })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, pid: 603, epoch: 63, initializeTimeoutMs: 300 })
    expect(await peer.initialize(300)).toBeTrue()
    const req = makeReq()
    const res = await peer.privateGet(req as unknown as never)
    expect(res.status).toBe("succeeded")
    // Outcome handle resolves the same valid result for the observer path.
    const out = await peer.privateGetOutcomeWithHandle(req as unknown as never).promise
    expect(out.kind).toBe("valid")
    peer.dispose()
    backendPeer.dispose()
  })

  test("privateGetOutcomeWithHandle surfaces invalid wire without entering comparator", async () => {
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel(async (method, params) => {
      if (method === "initialize")
        return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/get"] }
      if (method === "session/get") {
        const req = params as { requestId: string; opId: string; idempotencyKey: string }
        return {
          v: 1,
          requestId: req.requestId,
          opId: req.opId,
          op: "session/get",
          idempotencyKey: req.idempotencyKey,
          status: "succeeded",
          outcome: { type: "succeeded", time: Date.now() },
          accepted: true,
          data: { session: { id: 1 } },
        }
      }
      throw new Error("unexpected")
    })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, pid: 604, epoch: 64, initializeTimeoutMs: 300 })
    expect(await peer.initialize(300)).toBeTrue()
    const req = makeReq()
    const outcome = await peer.privateGetOutcomeWithHandle(req as unknown as never).promise
    expect(outcome.kind).toBe("invalid")
    // Legacy handle rejects with a typed validation error (never a normal failed result).
    let threw = false
    try {
      await peer.privateGet(req as unknown as never)
    } catch (e) {
      threw = isPrivateGetValidationError(e)
    }
    expect(threw).toBeTrue()
    peer.dispose()
    backendPeer.dispose()
  })

  test("privateGet exact cancel owns pending; second miss fail-closed invalidates", async () => {
    const toClient = new PassThrough()
    const toBackend = new PassThrough()
    const backendPeer = new JsonRpcPeer({
      reader: toBackend,
      writer: toClient,
      onRequest: async (method) => {
        if (method === "initialize")
          return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/get"] }
        return new Promise(() => {})
      },
    })
    const peer = new ServePrivatePeer({ reader: toClient, writer: toBackend, pid: 605, epoch: 65, initializeTimeoutMs: 300 })
    expect(await peer.initialize(300)).toBeTrue()
    const req = makeReq()
    const handle = peer.privateGetWithHandle(req as unknown as never)
    expect(peer.getPendingCount()).toBe(1)
    expect(handle.cancel("private parity timeout")).toBeTrue()
    expect(peer.getPendingCount()).toBe(0)
    const res = await handle.promise
    expect(res.status).toBe("ambiguous")
    expect((res as unknown as { transportUnknown?: boolean }).transportUnknown).toBeTrue()
    expect(handle.cancel("private parity timeout")).toBeFalse()
    expect(peer.isAvailable()).toBeFalse()
    peer.dispose()
    backendPeer.dispose()
  })

  test("observer is SDK-first, non-blocking, warn-only with no state mutation", async () => {
    const sdk = { data: { id: "ses_abc", directory: "/tmp", title: "hello" }, error: undefined, response: { status: 200 } }
    const calls: string[] = []
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const conn: GetParityConnection = {
        isPrivateAvailable: () => true,
        privateGet: async () => {
          throw new Error("must use handle path")
        },
        privateGetWithHandle: (req) => {
          calls.push(`private:${req.opId}`)
          return {
            id: 7,
            promise: Promise.resolve({
              v: 1,
              requestId: req.requestId,
              opId: req.opId,
              op: "session/get",
              idempotencyKey: req.idempotencyKey,
              status: "succeeded",
              outcome: { type: "succeeded", time: 1 },
              accepted: true,
              data: { session: { id: "ses_abc", directory: "/tmp", title: "hello" } },
            }),
          }
        },
        privateGetOutcomeWithHandle: (req) => {
          calls.push(`outcome:${req.opId}`)
          return {
            id: 7,
            promise: Promise.resolve({
              kind: "valid",
              result: {
                v: 1,
                requestId: req.requestId,
                opId: req.opId,
                op: "session/get",
                idempotencyKey: req.idempotencyKey,
                status: "succeeded",
                outcome: { type: "succeeded", time: 1 },
                accepted: true,
                data: { session: { id: "ses_abc", directory: "/tmp", title: "hello" } },
              },
            }),
          }
        },
      }
      const before = JSON.stringify(sdk.data)
      const ret = observeSessionGetParityDetached(conn, sdk as unknown as never, "ses_abc", "/tmp", 200)
      expect(ret).toBeUndefined()
      // Non-blocking: private work is detached, SDK snapshot untouched.
      expect(JSON.stringify(sdk.data)).toBe(before)
      await new Promise((r) => setTimeout(r, 50))
      expect(calls.length).toBe(1)
      expect(calls[0]!.startsWith("outcome:get:ses_abc:")).toBeTrue()
      expect(warns.length).toBe(0)
    } finally {
      console.warn = origWarn
    }
  })

  test("observer divergence is warn-only and invalid wire never reaches comparator", async () => {
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const sdk = { data: { id: "ses_abc", directory: "/tmp", title: "hello" } }
      const divergent: GetParityConnection = {
        isPrivateAvailable: () => true,
        privateGet: async () => {
          throw new Error("unused")
        },
        privateGetWithHandle: () => {
          throw new Error("unused")
        },
        privateGetOutcomeWithHandle: (req) => ({
          id: 1,
          promise: Promise.resolve({
            kind: "valid",
            result: {
              v: 1,
              requestId: req.requestId,
              opId: req.opId,
              op: "session/get",
              idempotencyKey: req.idempotencyKey,
              status: "succeeded",
              outcome: { type: "succeeded", time: 1 },
              accepted: true,
              data: { session: { id: "ses_abc", directory: "/tmp", title: "other" } },
            },
          }),
        }),
      }
      observeSessionGetParityDetached(divergent, sdk as unknown as never, "ses_abc", "/tmp", 200)
      await new Promise((r) => setTimeout(r, 50))
      expect(warns.some((w) => String(w[0]).includes("parity divergence") && String(w[1]).includes("get-title-mismatch"))).toBeTrue()

      warns.length = 0
      const invalid: GetParityConnection = {
        isPrivateAvailable: () => true,
        privateGet: async () => {
          throw new Error("unused")
        },
        privateGetWithHandle: () => {
          throw new Error("unused")
        },
        privateGetOutcomeWithHandle: () => ({
          id: 2,
          promise: Promise.resolve({ kind: "invalid", detail: "succeeded data.session must be object" }),
        }),
      }
      observeSessionGetParityDetached(invalid, sdk as unknown as never, "ses_abc", "/tmp", 200)
      await new Promise((r) => setTimeout(r, 50))
      expect(warns.some((w) => String(w[0]).includes("validation divergence"))).toBeTrue()
      expect(warns.some((w) => String(w[1] ?? "").includes("get-"))).toBeFalse()
    } finally {
      console.warn = origWarn
    }
  })

  test("observer timeout uses exact cancel; miss fail-closed invalidates without SDK impact", async () => {
    let cancelled: number[] = []
    let invalidated: string[] = []
    const sdk = { data: { id: "ses_abc", directory: "/tmp", title: "hello" } }
    const conn: GetParityConnection = {
      isPrivateAvailable: () => true,
      privateGet: async () => {
        throw new Error("unused")
      },
      privateGetWithHandle: () => {
        throw new Error("unused")
      },
      privateGetOutcomeWithHandle: () => ({
        id: 42,
        promise: new Promise(() => {}),
        cancel: () => {
          cancelled.push(42)
          return true
        },
      }),
      tryCancelPrivatePending: () => false,
      invalidatePrivatePeerOnObserverTimeout: (r) => {
        invalidated.push(r)
      },
      getPrivateEpoch: () => 9,
    }
    observeSessionGetParityDetached(conn, sdk as unknown as never, "ses_abc", "/tmp", 20)
    await new Promise((r) => setTimeout(r, 80))
    expect(cancelled).toEqual([42])
    expect(invalidated).toEqual([])
    expect(JSON.stringify(sdk.data)).toBe(JSON.stringify({ id: "ses_abc", directory: "/tmp", title: "hello" }))
  })

  test("observer defers while negotiating and skips stale epochs", async () => {
    const sdk = { data: { id: "ses_abc", directory: "/tmp", title: "hello" } }
    let observed = 0
    let listener: (() => void) | null = null
    const conn: GetParityConnection = {
      isPrivateAvailable: () => false,
      privateGet: async () => {
        throw new Error("unused")
      },
      privateGetWithHandle: () => {
        throw new Error("unused")
      },
      getPrivateEpoch: () => 3,
      onPrivateAvailable: (fn) => {
        listener = fn
        return () => {
          listener = null
        }
      },
    }
    observeSessionGetParityDetached(conn, sdk as unknown as never, "ses_abc", "/tmp", 50)
    // Deferred, not observed yet.
    expect(listener).not.toBeNull()
    // Epoch drift before notify skips without observing.
    ;(conn as { getPrivateEpoch: () => number }).getPrivateEpoch = () => 4
    listener!()
    await new Promise((r) => setTimeout(r, 30))
    expect(observed).toBe(0)
  })

  test("LOCK-003 strict payload identity: mismatched id/directory wire is invalid and bypasses comparator", () => {
    const req = makeReq()
    const badId = makeSuccess(req, { id: "ses_other" })
    expect(() => validateGetResult(badId, req)).toThrow("payload session id mismatch")
    const badIdWire = normalizePrivateGetWire(badId, req)
    expect(badIdWire.kind).toBe("invalid")
    const badDir = makeSuccess(req, { directory: "/other" })
    expect(() => validateGetResult(badDir, req)).toThrow("payload directory mismatch")
    const badDirWire = normalizePrivateGetWire(badDir, req)
    expect(badDirWire.kind).toBe("invalid")
    // Canonical equivalence still passes (/tmp/ vs /tmp).
    const canonOk = makeSuccess(req, { directory: "/tmp/" })
    expect(() => validateGetResult(canonOk, req)).not.toThrow()
    expect(normalizePrivateGetWire(canonOk, req).kind).toBe("valid")
    // Failed results carry no payload identity and stay valid.
    expect(normalizePrivateGetWire(makeFailed(req, "session.not_found"), req).kind).toBe("valid")
  })

  test("LOCK-003 invalid identity wire never reaches comparator (observer logs validation only)", async () => {
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const sdk = { data: { id: "ses_abc", directory: "/tmp", title: "hello" } }
      const conn: GetParityConnection = {
        isPrivateAvailable: () => true,
        privateGet: async () => {
          throw new Error("unused")
        },
        privateGetWithHandle: () => {
          throw new Error("unused")
        },
        privateGetOutcomeWithHandle: () => ({
          id: 9,
          promise: Promise.resolve({ kind: "invalid", detail: "payload session id mismatch" }),
        }),
      }
      observeSessionGetParityDetached(conn, sdk as unknown as never, "ses_abc", "/tmp", 50)
      await new Promise((r) => setTimeout(r, 50))
      expect(warns.some((w) => String(w[0]).includes("validation divergence"))).toBeTrue()
      expect(warns.some((w) => String(w[1] ?? "").includes("get-"))).toBeFalse()
    } finally {
      console.warn = origWarn
    }
  })

  test("LOCK-005 owner-managed deferred get keys dedupe without suppressing current availability", async () => {
    const sdk = { data: { id: "ses_abc", directory: "/tmp", title: "hello" } }
    let observed = 0
    const listeners = new Map<string, () => void>()
    const conn: GetParityConnection = {
      isPrivateAvailable: () => false,
      privateGet: async () => {
        throw new Error("unused")
      },
      privateGetWithHandle: () => {
        throw new Error("unused")
      },
      getPrivateEpoch: () => 11,
      addDeferredGetObserver: (dir: string, sessionId: string, fn: () => void) => {
        const key = `get:11:${dir}:${sessionId}`
        if (listeners.has(key)) return () => {}
        listeners.set(key, () => {
          listeners.delete(key)
          fn()
        })
        return () => {
          listeners.delete(key)
        }
      },
      onPrivateAvailable: () => () => {},
    }
    // Two seeds for the same epoch/dir/session share one deferred observation.
    observeSessionGetParityDetached(conn, sdk as unknown as never, "ses_abc", "/tmp", 50)
    observeSessionGetParityDetached(conn, sdk as unknown as never, "ses_abc", "/tmp", 50)
    expect(listeners.size).toBe(1)
    // A different session does not suppress the first.
    observeSessionGetParityDetached(conn, sdk as unknown as never, "ses_other", "/tmp", 50)
    expect(listeners.size).toBe(2)
    void observed
  })

  test("LOCK-005 fallback deferred keys clear on fire and do not suppress a new epoch", async () => {
    const sdk = { data: { id: "ses_abc", directory: "/tmp", title: "hello" } }
    let calls = 0
    let listener: (() => void) | null = null
    const conn: GetParityConnection = {
      isPrivateAvailable: () => false,
      privateGet: async () => {
        throw new Error("unused")
      },
      privateGetWithHandle: () => {
        throw new Error("unused")
      },
      getPrivateEpoch: () => 21,
      onPrivateAvailable: (fn) => {
        listener = fn
        return () => {
          listener = null
        }
      },
    }
    // First defer registers; firing releases the key.
    observeSessionGetParityDetached(conn, sdk as unknown as never, "ses_abc", "/tmp", 50)
    expect(listener).not.toBeNull()
    const first = listener!
    // Second seed for the same epoch/dir/session is absorbed while pending.
    observeSessionGetParityDetached(conn, sdk as unknown as never, "ses_abc", "/tmp", 50)
    // Epoch drift skips without observing and releases the key.
    ;(conn as { getPrivateEpoch: () => number }).getPrivateEpoch = () => 22
    first()
    await new Promise((r) => setTimeout(r, 30))
    expect(calls).toBe(0)
    void calls
  })

  test("LOCK-011 production get handle cancel path is observable (no copied logging)", async () => {
    const { KiloConnectionService } = await import("./connection-service")
    const svc = new KiloConnectionService({} as never)
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const stalePeer = {
        isAvailable: () => true,
        hasCapability: (cap: string) => cap === "session/get",
        privateGetWithHandle: () => ({ id: 7, promise: new Promise(() => {}) }),
        tryCancelPending: () => true,
        invalidateOnObserverTimeout: () => {
          throw new Error("stale-cleanup-boom")
        },
      }
      const anySvc = svc as unknown as {
        privatePeer: unknown
        privateAvailable: boolean
        privateEpoch: number | null
      }
      anySvc.privatePeer = stalePeer
      anySvc.privateAvailable = true
      anySvc.privateEpoch = 31
      const req = makeReq()
      const handle = svc.privateGetWithHandle(req as unknown as never)
      // Supersede after handle capture so the production cancel takes the stale path.
      anySvc.privatePeer = null
      anySvc.privateEpoch = 32
      const ok = handle.cancel("private parity timeout")
      expect(ok).toBeFalse()
      expect(warns.some((w) => String(w[0]).includes("stale observer cleanup failed"))).toBeTrue()
      expect(warns.some((w) => String(w[0]).includes("stale observer cleanup failed") && String(JSON.stringify(w[2] ?? {})).includes("session/get"))).toBeTrue()
    } finally {
      console.warn = origWarn
      try {
        svc.dispose()
      } catch {}
    }
  })

  test("LOCK-005 failed get epoch rejects late registrations without suppressing renewal", async () => {
    const { KiloConnectionService } = await import("./connection-service")
    const svc = new KiloConnectionService({} as never)
    try {
      const anySvc = svc as unknown as {
        privateEpoch: number | null
        privateFailedGetEpoch: number | null
        deferredGetObservers: Map<string, () => void>
        setPrivateEpoch: (server: unknown) => void
        failPrivateNegotiation: (epoch: number, pid: number | undefined) => void
      }
      anySvc.setPrivateEpoch({ epoch: 51, pid: 511 })
      let fired = 0
      svc.addDeferredGetObserver("/tmp", "ses_abc", () => {
        fired += 1
      })
      expect(anySvc.deferredGetObservers.size).toBe(1)
      anySvc.failPrivateNegotiation(51, 511)
      expect(anySvc.deferredGetObservers.size).toBe(0)
      expect(anySvc.privateFailedGetEpoch).toBe(51)
      // Late registration for the already-failed epoch retains nothing.
      svc.addDeferredGetObserver("/tmp", "ses_abc", () => {
        fired += 1
      })
      expect(anySvc.deferredGetObservers.size).toBe(0)
      expect(fired).toBe(0)
      // Renewed/superseding negotiation permits a valid current-epoch observer.
      anySvc.setPrivateEpoch({ epoch: 52, pid: 512 })
      svc.addDeferredGetObserver("/tmp", "ses_abc", () => {
        fired += 1
      })
      expect(anySvc.deferredGetObservers.size).toBe(1)
      expect(fired).toBe(0)
    } finally {
      try {
        svc.dispose()
      } catch {}
    }
  })

  test("LOCK-005/012 null transition clears failed get epoch guard", async () => {
    const { KiloConnectionService } = await import("./connection-service")
    const svc = new KiloConnectionService({} as never)
    try {
      const anySvc = svc as unknown as {
        privateEpoch: number | null
        privateFailedGetEpoch: number | null
        deferredGetObservers: Map<string, () => void>
        setPrivateEpoch: (server: unknown) => void
        failPrivateNegotiation: (epoch: number, pid: number | undefined) => void
        disposePrivatePeer: () => void
      }
      anySvc.setPrivateEpoch({ epoch: 61, pid: 611 })
      anySvc.failPrivateNegotiation(61, 611)
      expect(anySvc.privateFailedGetEpoch).toBe(61)
      svc.addDeferredGetObserver("/tmp", "ses_abc", () => {})
      expect(anySvc.deferredGetObservers.size).toBe(0)
      // Pre-init/null transitional cleanup reinitializes the guard.
      anySvc.disposePrivatePeer()
      expect(anySvc.privateEpoch).toBeNull()
      expect(anySvc.privateFailedGetEpoch).toBeNull()
      svc.addDeferredGetObserver("/tmp", "ses_abc", () => {})
      expect(anySvc.deferredGetObservers.size).toBe(0)
      // Next backend epoch starts clean and permits registration.
      anySvc.setPrivateEpoch({ epoch: 62, pid: 612 })
      expect(anySvc.privateFailedGetEpoch).toBeNull()
      svc.addDeferredGetObserver("/tmp", "ses_abc", () => {})
      expect(anySvc.deferredGetObservers.size).toBe(1)
    } finally {
      try {
        svc.dispose()
      } catch {}
    }
  })
})

describe("B6 session/get parity diagnostics (bounded)", () => {
  function matchResult(req: { requestId: string; opId: string; idempotencyKey: string }) {
    return {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "session/get",
      idempotencyKey: req.idempotencyKey,
      status: "succeeded",
      outcome: { type: "succeeded", time: 1 },
      accepted: true,
      data: { session: { id: "ses_abc", directory: "/tmp", title: "hello" } },
    }
  }

  function zeros() {
    return {
      match: 0,
      divergence: 0,
      transportUnknown: 0,
      validationDivergence: 0,
      timeout: 0,
      staleSkipped: 0,
      failClosed: 0,
    }
  }

  test("diagnostics count match once; SDK-first and comparator unchanged", async () => {
    const sdk = { data: { id: "ses_abc", directory: "/tmp", title: "hello" } }
    const before = JSON.stringify(sdk.data)
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const conn: GetParityConnection = {
        isPrivateAvailable: () => true,
        privateGet: async () => {
          throw new Error("unused")
        },
        privateGetWithHandle: () => {
          throw new Error("unused")
        },
        privateGetOutcomeWithHandle: (req) => ({
          id: 1,
          promise: Promise.resolve({ kind: "valid", result: matchResult(req) }),
        }),
      }
      const ret = observeSessionGetParityDetached(conn, sdk as unknown as never, "ses_abc", "/tmp", 200)
      expect(ret).toBeUndefined()
      await new Promise((r) => setTimeout(r, 50))
      expect(JSON.stringify(sdk.data)).toBe(before)
      expect(warns.length).toBe(0)
      expect({ ...getSessionGetParityDiagnostics(conn) }).toEqual({ ...zeros(), match: 1 })
      const parity = compareGetParity(matchResult({ requestId: "r", opId: "o", idempotencyKey: "o" }) as unknown as never, sdk as unknown as never)
      expect(parity.divergence).toBeNull()
    } finally {
      console.warn = origWarn
    }
  })

  test("diagnostics count divergence; parity warn and comparator unchanged", async () => {
    const sdk = { data: { id: "ses_abc", directory: "/tmp", title: "hello" } }
    const before = JSON.stringify(sdk.data)
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const conn: GetParityConnection = {
        isPrivateAvailable: () => true,
        privateGet: async () => {
          throw new Error("unused")
        },
        privateGetWithHandle: () => {
          throw new Error("unused")
        },
        privateGetOutcomeWithHandle: (req) => ({
          id: 1,
          promise: Promise.resolve({
            kind: "valid",
            result: {
              ...matchResult(req),
              data: { session: { id: "ses_abc", directory: "/tmp", title: "other" } },
            },
          }),
        }),
      }
      observeSessionGetParityDetached(conn, sdk as unknown as never, "ses_abc", "/tmp", 200)
      await new Promise((r) => setTimeout(r, 50))
      expect(JSON.stringify(sdk.data)).toBe(before)
      expect(warns.some((w) => String(w[0]).includes("parity divergence") && String(w[1]).includes("get-title-mismatch"))).toBeTrue()
      expect({ ...getSessionGetParityDiagnostics(conn) }).toEqual({ ...zeros(), divergence: 1 })
      const parity = compareGetParity(
        { ...matchResult({ requestId: "r", opId: "o", idempotencyKey: "o" }), data: { session: { id: "ses_abc", directory: "/tmp", title: "other" } } } as unknown as never,
        sdk as unknown as never,
      )
      expect(parity.divergence).toBe("get-title-mismatch")
    } finally {
      console.warn = origWarn
    }
  })

  test("diagnostics count transport-unknown separately from divergence", async () => {
    const sdk = { data: { id: "ses_abc", directory: "/tmp", title: "hello" } }
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const conn: GetParityConnection = {
        isPrivateAvailable: () => true,
        privateGet: async () => {
          throw new Error("unused")
        },
        privateGetWithHandle: () => {
          throw new Error("unused")
        },
        privateGetOutcomeWithHandle: (req) => ({
          id: 1,
          promise: Promise.resolve({
            kind: "valid",
            result: {
              v: 1,
              requestId: req.requestId,
              opId: req.opId,
              op: "session/get",
              idempotencyKey: req.idempotencyKey,
              status: "ambiguous",
              outcome: { type: "ambiguous", time: 1 },
              accepted: false,
              transportUnknown: true,
            },
          }),
        }),
      }
      observeSessionGetParityDetached(conn, sdk as unknown as never, "ses_abc", "/tmp", 200)
      await new Promise((r) => setTimeout(r, 50))
      expect(warns.some((w) => String(w[1] ?? "").includes("transport-unknown"))).toBeTrue()
      expect({ ...getSessionGetParityDiagnostics(conn) }).toEqual({ ...zeros(), transportUnknown: 1 })
    } finally {
      console.warn = origWarn
    }
  })

  test("diagnostics count validation divergence without comparator codes", async () => {
    const sdk = { data: { id: "ses_abc", directory: "/tmp", title: "hello" } }
    const before = JSON.stringify(sdk.data)
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const conn: GetParityConnection = {
        isPrivateAvailable: () => true,
        privateGet: async () => {
          throw new Error("unused")
        },
        privateGetWithHandle: () => {
          throw new Error("unused")
        },
        privateGetOutcomeWithHandle: () => ({
          id: 2,
          promise: Promise.resolve({ kind: "invalid", detail: "succeeded data.session must be object" }),
        }),
      }
      observeSessionGetParityDetached(conn, sdk as unknown as never, "ses_abc", "/tmp", 200)
      await new Promise((r) => setTimeout(r, 50))
      expect(JSON.stringify(sdk.data)).toBe(before)
      expect(warns.some((w) => String(w[0]).includes("validation divergence"))).toBeTrue()
      expect(warns.some((w) => String(w[1] ?? "").includes("get-"))).toBeFalse()
      expect({ ...getSessionGetParityDiagnostics(conn) }).toEqual({ ...zeros(), validationDivergence: 1 })
    } finally {
      console.warn = origWarn
    }
  })

  test("diagnostics count observer timeout; SDK snapshot untouched", async () => {
    const sdk = { data: { id: "ses_abc", directory: "/tmp", title: "hello" } }
    const before = JSON.stringify(sdk.data)
    const invalidated: string[] = []
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const conn: GetParityConnection = {
        isPrivateAvailable: () => true,
        privateGet: async () => {
          throw new Error("unused")
        },
        privateGetWithHandle: () => {
          throw new Error("unused")
        },
        privateGetOutcomeWithHandle: () => ({
          id: 42,
          promise: new Promise(() => {}),
          cancel: () => true,
        }),
        tryCancelPrivatePending: () => false,
        invalidatePrivatePeerOnObserverTimeout: (r) => {
          invalidated.push(r)
        },
        getPrivateEpoch: () => 9,
      }
      observeSessionGetParityDetached(conn, sdk as unknown as never, "ses_abc", "/tmp", 20)
      await new Promise((r) => setTimeout(r, 100))
      expect(JSON.stringify(sdk.data)).toBe(before)
      expect(invalidated).toEqual([])
      expect(warns.some((w) => String(w[0]).includes("private parity timeout"))).toBeTrue()
      // The timed-out observation still resolves to the existing ambiguous
      // transport-unknown result, so both counters move; timeout exactly once.
      expect({ ...getSessionGetParityDiagnostics(conn) }).toEqual({ ...zeros(), timeout: 1, transportUnknown: 1 })
    } finally {
      console.warn = origWarn
    }
  })

  test("diagnostics count stale epoch invalidation without timeout", async () => {
    const sdk = { data: { id: "ses_abc", directory: "/tmp", title: "hello" } }
    const invalidated: string[] = []
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const conn: GetParityConnection = {
        isPrivateAvailable: () => true,
        privateGet: async () => {
          throw new Error("unused")
        },
        privateGetWithHandle: () => {
          throw new Error("unused")
        },
        privateGetOutcomeWithHandle: () => ({
          id: 43,
          promise: new Promise(() => {}),
          cancel: () => "stale" as const,
        }),
        tryCancelPrivatePending: () => false,
        invalidatePrivatePeerOnObserverTimeout: (r) => {
          invalidated.push(r)
        },
        getPrivateEpoch: () => 9,
      }
      observeSessionGetParityDetached(conn, sdk as unknown as never, "ses_abc", "/tmp", 20)
      await new Promise((r) => setTimeout(r, 100))
      expect(invalidated).toEqual([])
      expect(warns.some((w) => String(w[0]).includes("stale observer timeout skipped"))).toBeTrue()
      expect({ ...getSessionGetParityDiagnostics(conn) }).toEqual({ ...zeros(), staleSkipped: 1, transportUnknown: 1 })
    } finally {
      console.warn = origWarn
    }
  })

  test("diagnostics count deferred stale skip; snapshot frozen, resettable, per-connection", async () => {
    const sdk = { data: { id: "ses_abc", directory: "/tmp", title: "hello" } }
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      let listener: (() => void) | null = null
      const conn: GetParityConnection = {
        isPrivateAvailable: () => false,
        privateGet: async () => {
          throw new Error("unused")
        },
        privateGetWithHandle: () => {
          throw new Error("unused")
        },
        getPrivateEpoch: () => 3,
        onPrivateAvailable: (fn) => {
          listener = fn
          return () => {
            listener = null
          }
        },
      }
      const other: GetParityConnection = {
        isPrivateAvailable: () => false,
        privateGet: async () => {
          throw new Error("unused")
        },
        privateGetWithHandle: () => {
          throw new Error("unused")
        },
        getPrivateEpoch: () => 3,
        onPrivateAvailable: () => () => {},
      }
      observeSessionGetParityDetached(conn, sdk as unknown as never, "ses_abc", "/tmp", 50)
      expect(listener).not.toBeNull()
      ;(conn as { getPrivateEpoch: () => number }).getPrivateEpoch = () => 4
      listener!()
      await new Promise((r) => setTimeout(r, 30))
      expect(warns.some((w) => String(w[0]).includes("stale deferred parity skipped"))).toBeTrue()
      const snap = getSessionGetParityDiagnostics(conn)
      expect({ ...snap }).toEqual({ ...zeros(), staleSkipped: 1 })
      expect(Object.isFrozen(snap)).toBeTrue()
      // Reading diagnostics never warns and never changes behavior.
      const warnCount = warns.length
      expect({ ...getSessionGetParityDiagnostics(conn) }).toEqual({ ...zeros(), staleSkipped: 1 })
      expect(warns.length).toBe(warnCount)
      // Per-connection isolation and reset.
      expect({ ...getSessionGetParityDiagnostics(other) }).toEqual(zeros())
      resetSessionGetParityDiagnostics(conn)
      expect({ ...getSessionGetParityDiagnostics(conn) }).toEqual(zeros())
    } finally {
      console.warn = origWarn
    }
  })

  test("diagnostics ignore non-terminal SDK results without observing", async () => {
    const sdk = { error: new Error("aborted"), response: undefined }
    let calls = 0
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const conn: GetParityConnection = {
        isPrivateAvailable: () => true,
        privateGet: async () => {
          throw new Error("unused")
        },
        privateGetWithHandle: () => {
          calls += 1
          throw new Error("must not observe")
        },
        privateGetOutcomeWithHandle: () => {
          calls += 1
          throw new Error("must not observe")
        },
      }
      const ret = observeSessionGetParityDetached(conn, sdk as unknown as never, "ses_abc", "/tmp", 50)
      expect(ret).toBeUndefined()
      await new Promise((r) => setTimeout(r, 30))
      expect(calls).toBe(0)
      expect(warns.length).toBe(0)
      expect({ ...getSessionGetParityDiagnostics(conn) }).toEqual(zeros())
    } finally {
      console.warn = origWarn
    }
  })
})
