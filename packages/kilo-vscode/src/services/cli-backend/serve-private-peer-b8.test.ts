import { describe, expect, test } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../private-worker/peer"
import {
  ServePrivatePeer,
  canonicalChildrenOpId,
  validateChildrenRequest,
  validateChildrenResult,
  normalizePrivateChildrenWire,
  compareChildrenParity,
} from "./serve-private-peer"
import {
  buildSessionChildrenIdentity,
  getSessionChildrenParityDiagnostics,
  observeSessionChildrenParityDetached,
  resetSessionChildrenParityDiagnostics,
  sdkChildrenHasTerminal,
  SESSION_CHILDREN_PARITY_TIMEOUT_MS,
  type ChildrenParityConnection,
} from "../../kilo-provider/session-children-parity"

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

const PARENT = "ses_parent00000000000000001"
const KID_A = "ses_kid000000000000000000a"
const KID_B = "ses_kid000000000000000000b"

function makeReq(over: Record<string, unknown> = {}) {
  const opId = canonicalChildrenOpId(PARENT, "tok1")
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "session/children" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp", parentSessionId: PARENT },
    payload: {},
    ...over,
  }
}

function kid(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    slug: `slug-${id.slice(-4)}`,
    projectID: "prj_000000000000000000000001",
    directory: "/tmp",
    parentID: PARENT,
    title: `title-${id.slice(-4)}`,
    version: "v1",
    time: { created: 1, updated: 2 },
    ...over,
  }
}

function makeSuccess(req: ReturnType<typeof makeReq>, kids: Record<string, unknown>[] = [kid(KID_A), kid(KID_B)]) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/children",
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { children: kids },
  }
}

function makeFailed(req: ReturnType<typeof makeReq>, code: string) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/children",
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure: { code, message: "x", retryable: false } },
    accepted: false,
    failure: { code, message: "x", retryable: false },
  }
}

function leaked(text: string): string | null {
  for (const secret of [
    PARENT,
    KID_A,
    KID_B,
    "ses_kid000000000000000000c",
    "ses_other00000000000000001",
    "tok1",
    "r1",
    "title-000",
    "/tmp",
    "/other",
    "children:",
    "changed",
  ]) {
    if (text.includes(secret)) return secret
  }
  return null
}

function assertSafe(divergence: string | null, details: Record<string, unknown>): void {
  const text = JSON.stringify({ divergence, details })
  const hit = leaked(text)
  expect(hit).toBeNull()
}

describe("B8 session/children private peer", () => {
  test("canonicalChildrenOpId binds parent and token strictly", () => {
    expect(canonicalChildrenOpId(PARENT, "t1")).toBe(`children:${PARENT}:t1`)
    expect(() => canonicalChildrenOpId(PARENT, "")).toThrow()
    expect(() => canonicalChildrenOpId(PARENT, "a:b")).toThrow()
    expect(() => canonicalChildrenOpId("", "t1")).toThrow()
    expect(buildSessionChildrenIdentity(PARENT).opId.startsWith(`children:${PARENT}:`)).toBeTrue()
    const ident = buildSessionChildrenIdentity(PARENT)
    expect(ident.idempotencyKey).toBe(ident.opId)
  })

  test("validateChildrenRequest accepts strict shape and rejects violations", () => {
    const req = makeReq()
    expect(() => validateChildrenRequest(req)).not.toThrow()
    expect(() =>
      validateChildrenRequest({ ...req, opId: canonicalChildrenOpId("ses_other00000000000000001", "tok1") }),
    ).toThrow()
    expect(() => validateChildrenRequest({ ...req, idempotencyKey: canonicalChildrenOpId(PARENT, "other") })).toThrow()
    expect(() =>
      validateChildrenRequest({ ...req, context: { directory: "relative", parentSessionId: PARENT } }),
    ).toThrow()
    expect(() => validateChildrenRequest({ ...req, context: { directory: "/tmp", parentSessionId: "bad" } })).toThrow()
    expect(() => validateChildrenRequest({ ...req, payload: { filter: "x" } })).toThrow()
    expect(() =>
      validateChildrenRequest({ ...req, context: { directory: "/tmp", parentSessionId: PARENT, extra: 1 } }),
    ).toThrow()
    expect(() => validateChildrenRequest({ ...req, extra: 1 })).toThrow()
    expect(() =>
      validateChildrenRequest({ ...req, opId: `children:${PARENT}`, idempotencyKey: `children:${PARENT}` }),
    ).toThrow()
    expect(() =>
      validateChildrenRequest({ ...req, opId: `children:${PARENT}:a:b`, idempotencyKey: `children:${PARENT}:a:b` }),
    ).toThrow()
  })

  test("validateChildrenResult enforces identity and per-status shape", () => {
    const req = makeReq()
    expect(() => validateChildrenResult(makeSuccess(req), req)).not.toThrow()
    expect(() => validateChildrenResult({ ...makeSuccess(req), requestId: "r2" }, req)).toThrow()
    expect(() => validateChildrenResult({ ...makeSuccess(req), data: { children: [{ id: KID_A }] } }, req)).toThrow()
    expect(() =>
      validateChildrenResult(
        { ...makeSuccess(req), data: { children: [kid(KID_A, { parentID: "ses_other00000000000000001" })] } },
        req,
      ),
    ).toThrow()
    // Child entries may carry their own canonical directory differing from the parent scope.
    expect(() => validateChildrenResult(makeSuccess(req, [kid(KID_A, { directory: "/other" })]), req)).not.toThrow()
    const failed = makeFailed(req, "session.not_found")
    expect(() => validateChildrenResult(failed, req)).not.toThrow()
    const ambiguous = {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "session/children",
      idempotencyKey: req.idempotencyKey,
      status: "ambiguous",
      outcome: { type: "ambiguous", time: 1 },
      accepted: false,
      transportUnknown: true,
    }
    expect(() => validateChildrenResult(ambiguous, req)).not.toThrow()
  })

  test("validateChildrenResult requires full Session.Info entries and rejects malformed directories/duplicates", () => {
    const req = makeReq()
    // Unknown entry field rejected.
    expect(() =>
      validateChildrenResult(makeSuccess(req, [kid(KID_A, { cost: 1, bogus: 1 })]), req),
    ).toThrow()
    // Missing required Session.Info fields rejected.
    const missingSlug = { ...kid(KID_A) } as Record<string, unknown>
    delete missingSlug.slug
    expect(() => validateChildrenResult(makeSuccess(req, [missingSlug]), req)).toThrow()
    const missingTime = { ...kid(KID_A) } as Record<string, unknown>
    delete missingTime.time
    expect(() => validateChildrenResult(makeSuccess(req, [missingTime]), req)).toThrow()
    const missingVersion = { ...kid(KID_A) } as Record<string, unknown>
    delete missingVersion.version
    expect(() => validateChildrenResult(makeSuccess(req, [missingVersion]), req)).toThrow()
    // Malformed entry fields rejected.
    expect(() => validateChildrenResult(makeSuccess(req, [kid(KID_A, { id: 1 })]), req)).toThrow()
    expect(() => validateChildrenResult(makeSuccess(req, [kid(KID_A, { id: "bad" })]), req)).toThrow()
    expect(() => validateChildrenResult(makeSuccess(req, [kid(KID_A, { title: 1 })]), req)).toThrow()
    expect(() => validateChildrenResult(makeSuccess(req, [kid(KID_A, { time: "x" })]), req)).toThrow()
    expect(() =>
      validateChildrenResult(makeSuccess(req, [kid(KID_A, { time: { created: 1 } })]), req),
    ).toThrow()
    expect(() => validateChildrenResult(makeSuccess(req, [kid(KID_A, { cost: "x" })]), req)).toThrow()
    // Relative entry directory rejected.
    expect(() => validateChildrenResult(makeSuccess(req, [kid(KID_A, { directory: "relative" })]), req)).toThrow()
    // NUL-bearing entry directory rejected.
    expect(() => validateChildrenResult(makeSuccess(req, [kid(KID_A, { directory: "/tmp\0x" })]), req)).toThrow()
    // Empty entry directory rejected.
    expect(() => validateChildrenResult(makeSuccess(req, [kid(KID_A, { directory: "" })]), req)).toThrow()
    // Duplicate child ids rejected.
    expect(() => validateChildrenResult(makeSuccess(req, [kid(KID_A), kid(KID_A)]), req)).toThrow()
    // Malformed entries normalize to invalid and bypass the comparator.
    for (const kids of [
      [kid(KID_A, { bogus: 1 })],
      [{ ...kid(KID_A), slug: undefined }],
      [kid(KID_A, { directory: "relative" })],
      [kid(KID_A), kid(KID_A)],
    ]) {
      const wire = normalizePrivateChildrenWire(makeSuccess(req, kids), req)
      expect(wire.kind).toBe("invalid")
    }
  })

  test("validateChildrenResult requires failed accepted===false", () => {
    const req = makeReq()
    const failedTrue = { ...makeFailed(req, "internal"), accepted: true }
    expect(() => validateChildrenResult(failedTrue, req)).toThrow()
    const wire = normalizePrivateChildrenWire(failedTrue, req)
    expect(wire.kind).toBe("invalid")
    if (wire.kind === "invalid") expect(wire.detail).toContain("failed accepted must be false")
  })

  test("normalizePrivateChildrenWire separates valid from invalid without throwing", () => {
    const req = makeReq()
    const good = normalizePrivateChildrenWire(makeSuccess(req), req)
    expect(good.kind).toBe("valid")
    const bad = normalizePrivateChildrenWire({ ...makeSuccess(req), data: { children: [{ id: 1 }] } }, req)
    expect(bad.kind).toBe("invalid")
    if (bad.kind === "invalid") expect(bad.detail.length).toBeGreaterThan(0)
  })

  test("compareChildrenParity is unordered keyed-by-id over stable fields plus full payload", () => {
    const req = makeReq()
    const sdk = { data: [kid(KID_A), kid(KID_B)], error: undefined, response: { status: 200 } }
    const match = compareChildrenParity(makeSuccess(req) as unknown as never, sdk as unknown as never, PARENT)
    expect(match.divergence).toBeNull()
    assertSafe(match.divergence, match.details)
    // Reversed order agrees: no ordering contract.
    const reversed = compareChildrenParity(
      makeSuccess(req, [kid(KID_B), kid(KID_A)]) as unknown as never,
      sdk as unknown as never,
      PARENT,
    )
    expect(reversed.divergence).toBeNull()
    // Membership divergence is warning-only and safe.
    const missing = compareChildrenParity(
      makeSuccess(req, [kid(KID_A)]) as unknown as never,
      sdk as unknown as never,
      PARENT,
    )
    expect(missing.divergence).toContain("observation-divergence")
    assertSafe(missing.divergence, missing.details)
    const extra = compareChildrenParity(
      makeSuccess(req, [kid(KID_A), kid(KID_B), kid("ses_kid000000000000000000c")]) as unknown as never,
      sdk as unknown as never,
      PARENT,
    )
    expect(extra.divergence).toContain("observation-divergence")
    assertSafe(extra.divergence, extra.details)
    // Stable field divergences never leak values.
    const parent = compareChildrenParity(
      makeSuccess(req, [kid(KID_A), kid(KID_B, { parentID: "ses_other00000000000000001" })]) as unknown as never,
      sdk as unknown as never,
      PARENT,
    )
    expect(parent.divergence).toContain("observation-divergence")
    assertSafe(parent.divergence, parent.details)
    const dir = compareChildrenParity(
      makeSuccess(req, [kid(KID_A), kid(KID_B, { directory: "/other" })]) as unknown as never,
      sdk as unknown as never,
      PARENT,
    )
    expect(dir.divergence).toContain("observation-divergence")
    assertSafe(dir.divergence, dir.details)
    const title = compareChildrenParity(
      makeSuccess(req, [kid(KID_A), kid(KID_B, { title: "changed" })]) as unknown as never,
      sdk as unknown as never,
      PARENT,
    )
    expect(title.divergence).toContain("observation-divergence")
    assertSafe(title.divergence, title.details)
    // Volatile extras outside stable fields diverge only via full-payload comparison, safely.
    const volatile = compareChildrenParity(
      makeSuccess(req, [kid(KID_A), { ...kid(KID_B), cost: 999 }]) as unknown as never,
      sdk as unknown as never,
      PARENT,
    )
    expect(volatile.divergence).toContain("observation-divergence")
    assertSafe(volatile.divergence, volatile.details)
    // Canonicalized directory agrees across spellings for the stable-field
    // layer: a raw spelling difference surfaces only as full-payload
    // content divergence, never as directory mismatch.
    const canon = compareChildrenParity(
      makeSuccess(req, [kid(KID_A, { directory: "/tmp/" }), kid(KID_B)]) as unknown as never,
      sdk as unknown as never,
      PARENT,
    )
    expect(canon.divergence).toBe("observation-divergence:content-mismatch")
    assertSafe(canon.divergence, canon.details)
    // Non-array SDK shape is observation divergence, not failure.
    const shape = compareChildrenParity(
      makeSuccess(req) as unknown as never,
      { data: { children: [] } } as unknown as never,
      PARENT,
    )
    expect(shape.divergence).toContain("observation-divergence")
  })

  test("compareChildrenParity failure classes 400/404/500 plus config-fence 409", () => {
    const req = makeReq()
    const sdk400 = { data: undefined, error: { status: 400 }, response: { status: 400 } }
    expect(
      compareChildrenParity(
        makeFailed(req, "validation.failed") as unknown as never,
        sdk400 as unknown as never,
        PARENT,
      ).divergence,
    ).toBeNull()
    expect(
      compareChildrenParity(makeFailed(req, "scope_mismatch") as unknown as never, sdk400 as unknown as never, PARENT)
        .divergence,
    ).toBeNull()
    expect(
      compareChildrenParity(makeFailed(req, "internal") as unknown as never, sdk400 as unknown as never, PARENT)
        .divergence,
    ).toContain("failure-class-mismatch")
    const sdk404 = { data: undefined, error: { status: 404 }, response: { status: 404 } }
    expect(
      compareChildrenParity(
        makeFailed(req, "session.not_found") as unknown as never,
        sdk404 as unknown as never,
        PARENT,
      ).divergence,
    ).toBeNull()
    expect(
      compareChildrenParity(
        makeFailed(req, "validation.failed") as unknown as never,
        sdk404 as unknown as never,
        PARENT,
      ).divergence,
    ).toContain("failure-class-mismatch")
    const sdk500 = { data: undefined, error: { status: 500 }, response: { status: 500 } }
    expect(
      compareChildrenParity(makeFailed(req, "internal") as unknown as never, sdk500 as unknown as never, PARENT)
        .divergence,
    ).toBeNull()
    const sdk409 = { data: undefined, error: { status: 409 }, response: { status: 409 } }
    expect(
      compareChildrenParity(
        makeFailed(req, "InstanceUnavailableDuringConfigRebuild") as unknown as never,
        sdk409 as unknown as never,
        PARENT,
      ).divergence,
    ).toBeNull()
    const mismatch = compareChildrenParity(
      makeFailed(req, "internal") as unknown as never,
      sdk404 as unknown as never,
      PARENT,
    )
    expect(mismatch.divergence).toContain("failure-class-mismatch")
    assertSafe(mismatch.divergence, mismatch.details)
    const ambiguous = {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "session/children",
      idempotencyKey: req.idempotencyKey,
      status: "ambiguous",
      outcome: { type: "ambiguous", time: 1 },
      accepted: false,
      transportUnknown: true,
    }
    expect(
      compareChildrenParity(ambiguous as unknown as never, { data: [] } as unknown as never, PARENT).divergence,
    ).toBe("transport-unknown")
  })

  test("sdkChildrenHasTerminal gates observer to terminal results only", () => {
    expect(sdkChildrenHasTerminal({ data: [] })).toBeTrue()
    expect(sdkChildrenHasTerminal({ data: [kid(KID_A)] })).toBeTrue()
    expect(sdkChildrenHasTerminal({ error: { status: 404 }, response: { status: 404 } })).toBeTrue()
    expect(sdkChildrenHasTerminal({ error: { status: 500 }, response: { status: 500 } })).toBeTrue()
    expect(sdkChildrenHasTerminal({ error: new Error("aborted"), response: undefined })).toBeFalse()
    expect(sdkChildrenHasTerminal(new Error("aborted"))).toBeFalse()
    expect(SESSION_CHILDREN_PARITY_TIMEOUT_MS).toBe(3000)
  })

  test("capability gating: session/children negotiates independently of B1-B7", async () => {
    const onlyChildren = createLinkedChannel(async (method) => {
      if (method === "initialize")
        return {
          protocol: { name: "kilo-private", major: 1, minor: 0 },
          serverInfo: { name: "kilo", version: "1" },
          capabilities: ["session/children"],
        }
      throw new Error("unexpected")
    })
    const peerChildren = new ServePrivatePeer({
      reader: onlyChildren.clientReader,
      writer: onlyChildren.clientWriter,
      pid: 701,
      epoch: 71,
      initializeTimeoutMs: 300,
    })
    expect(await peerChildren.initialize(300)).toBeTrue()
    expect(peerChildren.hasCapability("session/children")).toBeTrue()
    expect(peerChildren.hasCapability("session/messages")).toBeFalse()
    expect(peerChildren.getCapabilitiesListForFixture().includes("session/children")).toBeTrue()
    peerChildren.dispose()
    onlyChildren.backendPeer.dispose()

    const legacy = createLinkedChannel(async (method) => {
      if (method === "initialize")
        return {
          protocol: { name: "kilo-private", major: 1, minor: 0 },
          serverInfo: { name: "kilo", version: "1" },
          capabilities: ["session/messages"],
        }
      throw new Error("unexpected")
    })
    const peerLegacy = new ServePrivatePeer({
      reader: legacy.clientReader,
      writer: legacy.clientWriter,
      pid: 702,
      epoch: 72,
      initializeTimeoutMs: 300,
    })
    expect(await peerLegacy.initialize(300)).toBeTrue()
    expect(peerLegacy.hasCapability("session/children")).toBeFalse()
    expect(peerLegacy.hasCapability("session/messages")).toBeTrue()
    const req = makeReq()
    expect(() => peerLegacy.privateChildrenOutcomeWithHandle(req as unknown as never)).toThrow(
      "missing session/children capability",
    )
    peerLegacy.dispose()
    legacy.backendPeer.dispose()
  })

  test("privateChildren success round-trips and invalid wire rejects without comparator", async () => {
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel(async (method, params) => {
      if (method === "initialize")
        return {
          protocol: { name: "kilo-private", major: 1, minor: 0 },
          serverInfo: { name: "kilo", version: "1" },
          capabilities: ["session/children"],
        }
      if (method === "session/children") {
        const req = params as { requestId: string; opId: string; idempotencyKey: string }
        return {
          v: 1,
          requestId: req.requestId,
          opId: req.opId,
          op: "session/children",
          idempotencyKey: req.idempotencyKey,
          status: "succeeded",
          outcome: { type: "succeeded", time: Date.now() },
          accepted: true,
          data: { children: [kid(KID_A), kid(KID_B)] },
        }
      }
      throw new Error("unexpected")
    })
    const peer = new ServePrivatePeer({
      reader: clientReader,
      writer: clientWriter,
      pid: 703,
      epoch: 73,
      initializeTimeoutMs: 300,
    })
    expect(await peer.initialize(300)).toBeTrue()
    const req = makeReq()
    const out = await peer.privateChildrenOutcomeWithHandle(req as unknown as never).promise
    expect(out.kind).toBe("valid")
    if (out.kind !== "valid") throw new Error("expected valid")
    expect(out.result.status).toBe("succeeded")
    peer.dispose()
    backendPeer.dispose()
  })

  test("privateChildrenOutcomeWithHandle surfaces invalid wire without entering comparator", async () => {
    const { clientReader, clientWriter, backendPeer } = createLinkedChannel(async (method, params) => {
      if (method === "initialize")
        return {
          protocol: { name: "kilo-private", major: 1, minor: 0 },
          serverInfo: { name: "kilo", version: "1" },
          capabilities: ["session/children"],
        }
      if (method === "session/children") {
        const req = params as { requestId: string; opId: string; idempotencyKey: string }
        return {
          v: 1,
          requestId: req.requestId,
          opId: req.opId,
          op: "session/children",
          idempotencyKey: req.idempotencyKey,
          status: "succeeded",
          outcome: { type: "succeeded", time: Date.now() },
          accepted: true,
          data: { children: [{ id: 1 }] },
        }
      }
      throw new Error("unexpected")
    })
    const peer = new ServePrivatePeer({
      reader: clientReader,
      writer: clientWriter,
      pid: 704,
      epoch: 74,
      initializeTimeoutMs: 300,
    })
    expect(await peer.initialize(300)).toBeTrue()
    const req = makeReq()
    const outcome = await peer.privateChildrenOutcomeWithHandle(req as unknown as never).promise
    expect(outcome.kind).toBe("invalid")
    peer.dispose()
    backendPeer.dispose()
  })

  test("privateChildren exact cancel owns pending; second miss fail-closed invalidates", async () => {
    const toClient = new PassThrough()
    const toBackend = new PassThrough()
    const backendPeer = new JsonRpcPeer({
      reader: toBackend,
      writer: toClient,
      onRequest: async (method) => {
        if (method === "initialize")
          return {
            protocol: { name: "kilo-private", major: 1, minor: 0 },
            serverInfo: { name: "kilo", version: "1" },
            capabilities: ["session/children"],
          }
        return new Promise(() => {})
      },
    })
    const peer = new ServePrivatePeer({
      reader: toClient,
      writer: toBackend,
      pid: 705,
      epoch: 75,
      initializeTimeoutMs: 300,
    })
    expect(await peer.initialize(300)).toBeTrue()
    const req = makeReq()
    const handle = peer.privateChildrenOutcomeWithHandle(req as unknown as never)
    expect(peer.getPendingCount()).toBe(1)
    expect(handle.cancel("private parity timeout")).toBeTrue()
    expect(peer.getPendingCount()).toBe(0)
    const res = await handle.promise
    expect(res.kind).toBe("valid")
    if (res.kind !== "valid") throw new Error("expected valid")
    expect(res.result.status).toBe("ambiguous")
    expect((res.result as unknown as { transportUnknown?: boolean }).transportUnknown).toBeTrue()
    expect(handle.cancel("private parity timeout")).toBeFalse()
    expect(peer.isAvailable()).toBeFalse()
    peer.dispose()
    backendPeer.dispose()
  })

  test("observer is SDK-first, non-blocking, warn-only with no state mutation", async () => {
    const sdk = { data: [kid(KID_A), kid(KID_B)], error: undefined, response: { status: 200 } }
    const calls: string[] = []
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const conn: ChildrenParityConnection = {
        isPrivateAvailable: () => true,
        privateChildrenOutcomeWithHandle: (req) => {
          calls.push(`outcome:${req.opId}`)
          return {
            id: 7,
            promise: Promise.resolve({
              kind: "valid",
              result: {
                v: 1,
                requestId: req.requestId,
                opId: req.opId,
                op: "session/children",
                idempotencyKey: req.idempotencyKey,
                status: "succeeded",
                outcome: { type: "succeeded", time: 1 },
                accepted: true,
                data: { children: [kid(KID_A), kid(KID_B)] },
              },
            }),
          }
        },
      }
      const before = JSON.stringify(sdk.data)
      const ret = observeSessionChildrenParityDetached(conn, sdk as unknown as never, PARENT, "/tmp", 200)
      expect(ret).toBeUndefined()
      expect(JSON.stringify(sdk.data)).toBe(before)
      await new Promise((r) => setTimeout(r, 50))
      expect(calls.length).toBe(1)
      expect(calls[0]!.startsWith(`outcome:children:${PARENT}:`)).toBeTrue()
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
      const sdk = { data: [kid(KID_A), kid(KID_B)] }
      const divergent: ChildrenParityConnection = {
        isPrivateAvailable: () => true,
        privateChildrenOutcomeWithHandle: (req) => ({
          id: 1,
          promise: Promise.resolve({
            kind: "valid",
            result: {
              v: 1,
              requestId: req.requestId,
              opId: req.opId,
              op: "session/children",
              idempotencyKey: req.idempotencyKey,
              status: "succeeded",
              outcome: { type: "succeeded", time: 1 },
              accepted: true,
              data: { children: [kid(KID_A)] },
            },
          }),
        }),
      }
      observeSessionChildrenParityDetached(divergent, sdk as unknown as never, PARENT, "/tmp", 200)
      await new Promise((r) => setTimeout(r, 50))
      expect(
        warns.some(
          (w) => String(w[0]).includes("parity divergence") && String(w[1]).includes("observation-divergence"),
        ),
      ).toBeTrue()
      for (const w of warns) {
        const hit = leaked(JSON.stringify(w))
        expect(hit).toBeNull()
      }

      warns.length = 0
      const invalid: ChildrenParityConnection = {
        isPrivateAvailable: () => true,
        privateChildrenOutcomeWithHandle: () => ({
          id: 2,
          promise: Promise.resolve({ kind: "invalid", detail: "succeeded data.children entry must be object" }),
        }),
      }
      observeSessionChildrenParityDetached(invalid, sdk as unknown as never, PARENT, "/tmp", 200)
      await new Promise((r) => setTimeout(r, 50))
      expect(warns.some((w) => String(w[0]).includes("validation divergence"))).toBeTrue()
      for (const w of warns) {
        const hit = leaked(JSON.stringify(w))
        expect(hit).toBeNull()
      }
    } finally {
      console.warn = origWarn
    }
  })

  test("observer never observes non-terminal SDK outcomes and never replays", async () => {
    let calls = 0
    const conn: ChildrenParityConnection = {
      isPrivateAvailable: () => true,
      privateChildrenOutcomeWithHandle: () => {
        calls += 1
        throw new Error("unused")
      },
    }
    observeSessionChildrenParityDetached(conn, { error: new Error("aborted") } as unknown as never, PARENT, "/tmp", 50)
    observeSessionChildrenParityDetached(conn, new Error("boom") as unknown as never, PARENT, "/tmp", 50)
    observeSessionChildrenParityDetached(conn, {} as unknown as never, PARENT, "/tmp", 50)
    await new Promise((r) => setTimeout(r, 50))
    expect(calls).toBe(0)
  })

  test("observer timeout uses exact cancel; miss fail-closed invalidates without SDK impact", async () => {
    const cancelled: number[] = []
    const invalidated: string[] = []
    const sdk = { data: [kid(KID_A)] }
    const conn: ChildrenParityConnection = {
      isPrivateAvailable: () => true,
      privateChildrenOutcomeWithHandle: () => ({
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
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      observeSessionChildrenParityDetached(conn, sdk as unknown as never, PARENT, "/tmp", 20)
      await new Promise((r) => setTimeout(r, 80))
      expect(cancelled).toEqual([42])
      expect(invalidated).toEqual([])
      expect(JSON.stringify(sdk.data)).toBe(JSON.stringify([kid(KID_A)]))
      for (const w of warns) {
        const hit = leaked(JSON.stringify(w))
        expect(hit).toBeNull()
      }
    } finally {
      console.warn = origWarn
    }
  })

  test("observer defers while negotiating and skips stale epochs without leaking", async () => {
    const sdk = { data: [kid(KID_A)] }
    const before = JSON.stringify(sdk.data)
    let listener: (() => void) | null = null
    let unsubscribed = 0
    let requests = 0
    let cancels = 0
    let invalidates = 0
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const conn: ChildrenParityConnection = {
        isPrivateAvailable: () => false,
        getPrivateEpoch: () => 3,
        privateChildrenOutcomeWithHandle: () => {
          requests += 1
          return { id: 1, promise: Promise.resolve({ kind: "invalid", detail: "unused" }) }
        },
        tryCancelPrivatePending: () => {
          cancels += 1
          return true
        },
        invalidatePrivatePeerOnObserverTimeout: () => {
          invalidates += 1
        },
        onPrivateAvailable: (fn) => {
          listener = fn
          return () => {
            unsubscribed += 1
            listener = null
          }
        },
      }
      observeSessionChildrenParityDetached(conn, sdk as unknown as never, PARENT, "/tmp", 50)
      expect(listener).not.toBeNull()
      ;(conn as { getPrivateEpoch: () => number }).getPrivateEpoch = () => 4
      listener!()
      await new Promise((r) => setTimeout(r, 30))
      // Stale epoch does zero private work and cleans its listener.
      expect(requests).toBe(0)
      expect(cancels).toBe(0)
      expect(invalidates).toBe(0)
      expect(unsubscribed).toBe(1)
      expect(listener).toBeNull()
      expect(JSON.stringify(sdk.data)).toBe(before)
      expect(warns.some((w) => String(w[0]).includes("stale deferred parity skipped"))).toBeTrue()
      for (const w of warns) {
        const text = JSON.stringify(w)
        // Fixed stale message contains the word "changed" ("epoch changed");
        // that fixed token is not a title leak, so check remaining secrets only.
        expect(text).not.toContain(PARENT)
        expect(text).not.toContain(KID_A)
        expect(text).not.toContain("ses_kid000000000000000000c")
        expect(text).not.toContain("ses_other00000000000000001")
      }
    } finally {
      console.warn = origWarn
    }
  })

  test("owner-managed deferred children keys dedupe without suppressing current availability", async () => {
    const sdk = { data: [kid(KID_A)] }
    const listeners = new Map<string, () => void>()
    const conn: ChildrenParityConnection = {
      isPrivateAvailable: () => false,
      getPrivateEpoch: () => 11,
      addDeferredChildrenObserver: (dir: string, parent: string, fn: () => void) => {
        const key = `children:11:${dir}:${parent}`
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
    observeSessionChildrenParityDetached(conn, sdk as unknown as never, PARENT, "/tmp", 50)
    observeSessionChildrenParityDetached(conn, sdk as unknown as never, PARENT, "/tmp", 50)
    expect(listeners.size).toBe(1)
    observeSessionChildrenParityDetached(conn, sdk as unknown as never, "ses_other00000000000000001", "/tmp", 50)
    expect(listeners.size).toBe(2)
  })

  test("fixture backendSnapshot reads children private-first with zero SDK on success", async () => {
    const { AgentManagerProvider } = await import("../../agent-manager/AgentManagerProvider")
    const OTHER = "ses_other00000000000000001"
    const sdkKid = kid(KID_A)
    const observed: string[] = []
    let sdkChildrenCalls = 0
    const fakeClient = {
      session: {
        list: async () => ({
          data: [
            { id: PARENT, title: "p", agent: null, model: null, parentID: null, time: { created: 1, updated: 2 } },
            { id: OTHER, title: "o", agent: null, model: null, parentID: null, time: { created: 3, updated: 4 } },
          ],
        }),
        status: async () => ({ data: {} }),
        messages: async () => ({ data: [] }),
        children: async () => {
          sdkChildrenCalls += 1
          return { data: [] }
        },
      },
      app: { agents: async () => ({ data: [] }) },
      provider: { catalog: async () => ({ data: { connected: [] } }) },
      mcp: { status: async () => ({ data: {} }) },
      permission: { list: async () => ({ data: [] }) },
      question: { list: async () => ({ data: [] }) },
    }
    const conn = {
      getClientAsync: async () => fakeClient,
      isPrivateAvailable: () => true,
      getPrivateEpoch: () => 7,
      privateChildrenOutcomeWithHandle: (req: { opId: string; requestId: string; idempotencyKey: string }) => {
        observed.push(req.opId)
        const isParent = req.opId.startsWith(`children:${PARENT}:`)
        const result = isParent
          ? {
              v: 1,
              requestId: req.requestId,
              opId: req.opId,
              op: "session/children",
              idempotencyKey: req.idempotencyKey,
              status: "succeeded",
              outcome: { type: "succeeded", time: 1 },
              accepted: true,
              data: { children: [sdkKid] },
            }
          : {
              v: 1,
              requestId: req.requestId,
              opId: req.opId,
              op: "session/children",
              idempotencyKey: req.idempotencyKey,
              status: "failed",
              outcome: { type: "failed", time: 1, failure: { code: "session.not_found", message: "x", retryable: false } },
              accepted: false,
              failure: { code: "session.not_found", message: "x", retryable: false },
            }
        return { id: observed.length, promise: Promise.resolve({ kind: "valid", result }) }
      },
    }
    const provider = Object.create(AgentManagerProvider.prototype) as {
      backendSnapshotForFixture(): Promise<{ children?: Record<string, string[]> }>
    } & Record<string, unknown>
    provider.host = { workspacePath: () => "/tmp" }
    provider.connectionService = conn
    provider.outputChannel = { appendLine: () => {} }
    const snap = await provider.backendSnapshotForFixture()
    await new Promise((r) => setTimeout(r, 50))
    // Private-first: valid private success maps ids with zero SDK, validated
    // terminal fails closed to empty with zero SDK. No detached observer.
    expect(snap.children?.[PARENT]).toEqual([KID_A])
    expect(snap.children?.[OTHER]).toEqual([])
    // One private attempt per session, no SDK children fallback on either.
    expect(sdkChildrenCalls).toBe(0)
    expect(observed.length).toBe(2)
    expect(observed.filter((op) => op.startsWith(`children:${PARENT}:`)).length).toBe(1)
    expect(observed.filter((op) => op.startsWith(`children:${OTHER}:`)).length).toBe(1)
    expect(new Set(observed).size).toBe(2)
  })

  test("production children handle cancel path is observable with safe logging", async () => {
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
        hasCapability: (cap: string) => cap === "session/children",
        privateChildrenOutcomeWithHandle: () => ({ id: 7, promise: new Promise(() => {}) }),
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
      const handle = svc.privateChildrenOutcomeWithHandle(req as unknown as never)
      anySvc.privatePeer = null
      anySvc.privateEpoch = 32
      const ok = handle.cancel("private parity timeout")
      expect(ok).toBe("stale")
      expect(warns.some((w) => String(w[0]).includes("stale observer cleanup failed"))).toBeTrue()
      expect(
        warns.some(
          (w) =>
            String(w[0]).includes("stale observer cleanup failed") &&
            String(JSON.stringify(w[1] ?? {})).includes("session/children"),
        ),
      ).toBeTrue()
      for (const w of warns) {
        const hit = leaked(JSON.stringify(w))
        expect(hit).toBeNull()
      }
    } finally {
      console.warn = origWarn
      try {
        svc.dispose()
      } catch {}
    }
  })

  test("failed epoch rejects late children registrations without suppressing renewal", async () => {
    const { KiloConnectionService } = await import("./connection-service")
    const svc = new KiloConnectionService({} as never)
    try {
      const anySvc = svc as unknown as {
        privateEpoch: number | null
        privateFailedGetEpoch: number | null
        deferredChildren: { size: number }
        setPrivateEpoch: (server: unknown) => void
        failPrivateNegotiation: (epoch: number, pid: number | undefined) => void
      }
      anySvc.setPrivateEpoch({ epoch: 51, pid: 511 })
      let fired = 0
      svc.addDeferredChildrenObserver("/tmp", PARENT, () => {
        fired += 1
      })
      expect(anySvc.deferredChildren.size).toBe(1)
      anySvc.failPrivateNegotiation(51, 511)
      expect(anySvc.deferredChildren.size).toBe(0)
      expect(anySvc.privateFailedGetEpoch).toBe(51)
      svc.addDeferredChildrenObserver("/tmp", PARENT, () => {
        fired += 1
      })
      expect(anySvc.deferredChildren.size).toBe(0)
      expect(fired).toBe(0)
      anySvc.setPrivateEpoch({ epoch: 52, pid: 512 })
      svc.addDeferredChildrenObserver("/tmp", PARENT, () => {
        fired += 1
      })
      expect(anySvc.deferredChildren.size).toBe(1)
      expect(fired).toBe(0)
    } finally {
      try {
        svc.dispose()
      } catch {}
    }
  })

  test("deferred children keys never embed parent material", async () => {
    const { DeferredChildren } = await import("./serve-private-children")
    const store = new DeferredChildren(new Set())
    const key = store.key(7, "/tmp", PARENT)
    expect(key.startsWith("children:7:/tmp:h-")).toBeTrue()
    expect(key).not.toContain(PARENT)
    expect(key).not.toContain("ses_")
    store.add(7, null, false, "/tmp", PARENT, () => {})
    expect(store.size).toBe(1)
    store.add(7, null, false, "/tmp", PARENT, () => {})
    expect(store.size).toBe(1)
    store.add(7, null, false, "/tmp", "ses_other00000000000000001", () => {})
    expect(store.size).toBe(2)
    store.clearForEpoch(7)
    expect(store.size).toBe(0)
  })

  test("validateChildrenResult rejects malformed nested Session.Info fields", () => {
    const req = makeReq()
    // Nested key-set violations.
    expect(() =>
      validateChildrenResult(makeSuccess(req, [kid(KID_A, { time: { created: 1, updated: 2, bogus: 1 } })]), req),
    ).toThrow()
    expect(() =>
      validateChildrenResult(makeSuccess(req, [kid(KID_A, { summary: { additions: 1, deletions: 1 } })]), req),
    ).toThrow()
    expect(() =>
      validateChildrenResult(
        makeSuccess(req, [kid(KID_A, { summary: { additions: 1, deletions: 1, files: 1, bogus: 1 } })]),
        req,
      ),
    ).toThrow()
    expect(() =>
      validateChildrenResult(
        makeSuccess(req, [kid(KID_A, { summary: { additions: 1, deletions: 1, files: 1, diffs: [{ bogus: 1 }] } })]),
        req,
      ),
    ).toThrow()
    expect(() =>
      validateChildrenResult(
        makeSuccess(req, [
          kid(KID_A, {
            summary: { additions: 1, deletions: 1, files: 1, diffs: [{ additions: 1, deletions: 1, status: "weird" }] },
          }),
        ]),
        req,
      ),
    ).toThrow()
    // Tokens/cache shape.
    expect(() =>
      validateChildrenResult(makeSuccess(req, [kid(KID_A, { tokens: { input: 1, output: 1 } })]), req),
    ).toThrow()
    expect(() =>
      validateChildrenResult(
        makeSuccess(req, [kid(KID_A, { tokens: { input: 1, output: 1, reasoning: 1, cache: { read: 1 } } })]),
        req,
      ),
    ).toThrow()
    expect(() =>
      validateChildrenResult(
        makeSuccess(req, [kid(KID_A, { tokens: { input: 1, output: 1, reasoning: 1, cache: { read: 1, write: 1, x: 1 } } })]),
        req,
      ),
    ).toThrow()
    // Share/model/time numeric and enum constraints.
    expect(() => validateChildrenResult(makeSuccess(req, [kid(KID_A, { share: { url: "" } })]), req)).toThrow()
    expect(() =>
      validateChildrenResult(makeSuccess(req, [kid(KID_A, { share: { url: "u", extra: 1 } })]), req),
    ).toThrow()
    expect(() => validateChildrenResult(makeSuccess(req, [kid(KID_A, { model: { id: "m" } })]), req)).toThrow()
    expect(() =>
      validateChildrenResult(makeSuccess(req, [kid(KID_A, { model: { id: "m", providerID: "p", variant: 1 } })]), req),
    ).toThrow()
    expect(() =>
      validateChildrenResult(makeSuccess(req, [kid(KID_A, { time: { created: 1.5, updated: 2 } })]), req),
    ).toThrow()
    expect(() =>
      validateChildrenResult(makeSuccess(req, [kid(KID_A, { time: { created: -1, updated: 2 } })]), req),
    ).toThrow()
    expect(() =>
      validateChildrenResult(makeSuccess(req, [kid(KID_A, { time: { created: 1, updated: 2, compacting: "x" } })]), req),
    ).toThrow()
    // Permission ruleset and revert ID constraints.
    expect(() =>
      validateChildrenResult(makeSuccess(req, [kid(KID_A, { permission: [{ permission: "p", pattern: "x" }] })]), req),
    ).toThrow()
    expect(() =>
      validateChildrenResult(
        makeSuccess(req, [kid(KID_A, { permission: [{ permission: "p", pattern: "x", action: "weird" }] })]),
        req,
      ),
    ).toThrow()
    expect(() =>
      validateChildrenResult(makeSuccess(req, [kid(KID_A, { revert: { messageID: "bad" } })]), req),
    ).toThrow()
    expect(() =>
      validateChildrenResult(makeSuccess(req, [kid(KID_A, { revert: { messageID: "msg_1", partID: "bad" } })]), req),
    ).toThrow()
    // Strict pass-through: fully-shaped nested entries still validate.
    const full = kid(KID_A, {
      summary: { additions: 1, deletions: 2, files: 1, diffs: [{ file: "f", additions: 1, deletions: 1, status: "added" }] },
      tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 1, write: 0 } },
      share: { url: "https://example.invalid/s" },
      model: { id: "m", providerID: "p", variant: "v" },
      time: { created: 1, updated: 2, compacting: 3, archived: 4 },
      permission: [{ permission: "read", pattern: "**", action: "allow" }],
      revert: { messageID: "msg_1", partID: "prt_1", snapshot: "s", diff: "d" },
      workspaceID: "wrk_000000000000000000000001",
      path: "/tmp/abs",
    })
    expect(() => validateChildrenResult(makeSuccess(req, [full]), req)).not.toThrow()
    // Malformed workspaceID values reject strictly (WorkspaceV2.ID shape: startsWith wrk).
    for (const workspaceID of ["ws_1", "", "bad", 1, " wrk_1", "WRK_1", "rk_1"]) {
      expect(() => validateChildrenResult(makeSuccess(req, [kid(KID_A, { workspaceID })]), req)).toThrow()
    }
    // Backend-valid edge values accept, including schema-valid wrk-primary.
    for (const workspaceID of ["wrk", "wrk_", "wrk-primary", "wrk_000000000000000000000001"]) {
      expect(() => validateChildrenResult(makeSuccess(req, [kid(KID_A, { workspaceID })]), req)).not.toThrow()
    }
    // Malformed nested entries normalize invalid and bypass the comparator.
    for (const kids of [
      [kid(KID_A, { summary: { additions: 1 } })],
      [kid(KID_A, { tokens: { input: 1 } })],
      [kid(KID_A, { permission: "x" })],
      [kid(KID_A, { revert: { messageID: 1 } })],
      [kid(KID_A, { workspaceID: "ws_1" })],
      [kid(KID_A, { workspaceID: "" })],
    ]) {
      const wire = normalizePrivateChildrenWire(makeSuccess(req, kids), req)
      expect(wire.kind).toBe("invalid")
    }
  })

  test("compareChildrenParity rejects SDK duplicate IDs without collapsing", () => {
    const req = makeReq()
    const dupSdk = { data: [kid(KID_A), kid(KID_A)], error: undefined, response: { status: 200 } }
    const dup = compareChildrenParity(makeSuccess(req, [kid(KID_A)]) as unknown as never, dupSdk as unknown as never, PARENT)
    expect(dup.divergence).toContain("observation-divergence")
    expect(dup.divergence).toContain("sdk-duplicate-id")
    assertSafe(dup.divergence, dup.details)
    // Duplicates cannot parity-match even when membership overlaps.
    const dupMatch = compareChildrenParity(
      makeSuccess(req, [kid(KID_A), kid(KID_A)]) as unknown as never,
      dupSdk as unknown as never,
      PARENT,
    )
    // Private duplicates are invalid wire, so a duplicated private payload
    // never reaches a match; SDK duplicates diverge safely here.
    expect(dupMatch.divergence).toContain("observation-divergence")
    assertSafe(dupMatch.divergence, dupMatch.details)
    // Unique collections still match.
    const ok = compareChildrenParity(makeSuccess(req) as unknown as never, { data: [kid(KID_A), kid(KID_B)] } as unknown as never, PARENT)
    expect(ok.divergence).toBeNull()
  })

  test("fallback deferred registration re-registers after lifecycle reset", async () => {
    const sdk = { data: [kid(KID_A)] }
    let epoch = 21
    let available = false
    const listeners = new Set<() => void>()
    let observations = 0
    const conn: ChildrenParityConnection = {
      isPrivateAvailable: () => available,
      getPrivateEpoch: () => epoch,
      privateChildrenOutcomeWithHandle: () => {
        observations += 1
        return { id: observations, promise: Promise.resolve({ kind: "invalid", detail: "unused" }) }
      },
      onPrivateAvailable: (fn) => {
        listeners.add(fn)
        return () => {
          listeners.delete(fn)
        }
      },
    }
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      observeSessionChildrenParityDetached(conn, sdk as unknown as never, PARENT, "/tmp", 50)
      expect(listeners.size).toBe(1)
      // Simulate lifecycle reset/dispose clearing owner listeners without notifying fallback.
      listeners.clear()
      epoch = 22
      observeSessionChildrenParityDetached(conn, sdk as unknown as never, PARENT, "/tmp", 50)
      expect(listeners.size).toBe(1)
      // Same-epoch orphan also re-registers instead of suppressing.
      listeners.clear()
      observeSessionChildrenParityDetached(conn, sdk as unknown as never, PARENT, "/tmp", 50)
      expect(listeners.size).toBe(1)
      // Firing the renewed listener observes without leaking.
      available = true
      for (const fn of [...listeners]) fn()
      await new Promise((r) => setTimeout(r, 30))
      expect(observations).toBe(1)
      expect(listeners.size).toBe(0)
      for (const w of warns) {
        const hit = leaked(JSON.stringify(w))
        expect(hit).toBeNull()
      }
    } finally {
      console.warn = origWarn
    }
  })

  test("B8 diagnostics never emit variable timeoutMs or epoch values", async () => {
    const sdk = { data: [kid(KID_A)] }
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const conn: ChildrenParityConnection = {
        isPrivateAvailable: () => true,
        privateChildrenOutcomeWithHandle: () => ({
          id: 42,
          promise: new Promise(() => {}),
          cancel: () => true,
        }),
        getPrivateEpoch: () => 9,
      }
      observeSessionChildrenParityDetached(conn, sdk as unknown as never, PARENT, "/tmp", 20)
      await new Promise((r) => setTimeout(r, 80))
      expect(warns.length).toBeGreaterThan(0)
      for (const w of warns) {
        const text = JSON.stringify(w)
        expect(text).not.toContain('"timeoutMs"')
        expect(text).not.toContain('"epoch"')
        expect(text).not.toContain("after 20ms")
        const hit = leaked(text)
        expect(hit).toBeNull()
      }
      expect(warns.some((w) => String(JSON.stringify(w[1] ?? {})).includes('"timeout":true'))).toBeTrue()
    } finally {
      console.warn = origWarn
    }
  })

  test("fallback deferred unsubscribe failures stay visible via fixed safe diagnostics", async () => {
    const sdk = { data: [kid(KID_A)] }
    let epoch = 31
    const listeners = new Set<() => void>()
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const conn: ChildrenParityConnection = {
        isPrivateAvailable: () => false,
        getPrivateEpoch: () => epoch,
        privateChildrenOutcomeWithHandle: () => ({
          id: 1,
          promise: Promise.resolve({ kind: "invalid", detail: "unused" }),
        }),
        onPrivateAvailable: (fn) => {
          listeners.add(fn)
          return () => {
            throw new Error("unsub-boom")
          }
        },
      }
      observeSessionChildrenParityDetached(conn, sdk as unknown as never, PARENT, "/tmp", 50)
      expect(listeners.size).toBe(1)
      // Epoch move purges with visible fixed cleanup-failure diagnostics, fail-closed.
      epoch = 32
      observeSessionChildrenParityDetached(conn, sdk as unknown as never, PARENT, "/tmp", 50)
      expect(listeners.size).toBe(2)
      expect(
        warns.some(
          (w) =>
            String(w[0]).includes("deferred parity unsubscribe failed") &&
            String(JSON.stringify(w[1] ?? {})).includes('"unsubscribeFailed":true'),
        ),
      ).toBeTrue()
      for (const w of warns) {
        const text = JSON.stringify(w)
        expect(text).not.toContain('"timeoutMs"')
        expect(text).not.toContain('"epoch"')
        const hit = leaked(text)
        expect(hit).toBeNull()
      }
    } finally {
      console.warn = origWarn
    }
  })

  test("stale owner cancel cleanup failures stay visible without variable epoch", async () => {
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
        hasCapability: (cap: string) => cap === "session/children",
        privateChildrenOutcomeWithHandle: () => ({ id: 7, promise: new Promise(() => {}) }),
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
      const handle = svc.privateChildrenOutcomeWithHandle(req as unknown as never)
      anySvc.privatePeer = null
      anySvc.privateEpoch = 32
      const ok = handle.cancel("private parity timeout")
      expect(ok).toBe("stale")
      for (const w of warns) {
        const text = JSON.stringify(w)
        expect(text).not.toContain('"timeoutMs"')
        expect(text).not.toContain('"epoch"')
        const hit = leaked(text)
        expect(hit).toBeNull()
      }
      expect(
        warns.some(
          (w) =>
            String(w[0]).includes("stale observer cleanup failed") &&
            String(JSON.stringify(w[1] ?? {})).includes('"cleanupFailed":true'),
        ),
      ).toBeTrue()
    } finally {
      console.warn = origWarn
      try {
        svc.dispose()
      } catch {}
    }
  })
})

describe("session/children parity diagnostics (bounded)", () => {
  function matchResult(req: { requestId: string; opId: string; idempotencyKey: string }) {
    return {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "session/children",
      idempotencyKey: req.idempotencyKey,
      status: "succeeded",
      outcome: { type: "succeeded", time: 1 },
      accepted: true,
      data: { children: [kid(KID_A), kid(KID_B)] },
    }
  }

  function zeros() {
    return {
      comparedNoDivergence: 0,
      divergence: 0,
      transportUnknown: 0,
      validationDivergence: 0,
      timeout: 0,
      staleSkipped: 0,
      failClosed: 0,
    }
  }

  test("diagnostics count comparator no-divergence once; SDK-first and comparator unchanged", async () => {
    const sdk = { data: [kid(KID_A), kid(KID_B)] }
    const before = JSON.stringify(sdk)
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const conn: ChildrenParityConnection = {
        isPrivateAvailable: () => true,
        privateChildrenOutcomeWithHandle: (req) => ({
          id: 1,
          promise: Promise.resolve({ kind: "valid", result: matchResult(req) }),
        }),
        getPrivateEpoch: () => 1,
      }
      const ret = observeSessionChildrenParityDetached(conn, sdk as never, PARENT, "/tmp", 200)
      expect(ret).toBeUndefined()
      await new Promise((r) => setTimeout(r, 50))
      expect(JSON.stringify(sdk)).toBe(before)
      expect(warns.length).toBe(0)
      expect({ ...getSessionChildrenParityDiagnostics(conn) }).toEqual({ ...zeros(), comparedNoDivergence: 1 })
      const parity = compareChildrenParity(
        matchResult({ requestId: "r", opId: "o", idempotencyKey: "o" }) as unknown as never,
        sdk as unknown as never,
        PARENT,
      )
      expect(parity.divergence).toBeNull()
      // Children comparator carries no `*Unknown` detail fields: the
      // no-divergence counter is comparator-scoped (stable id/parentID/
      // canonical directory/title plus in-memory full-payload equality) and
      // never claims full parity/health. Concurrent membership shifts stay
      // warn-only observation divergence.
      const details = parity.details as Record<string, unknown>
      expect(Object.keys(details).some((k) => k.toLowerCase().includes("unknown"))).toBeFalse()
      const snap = getSessionChildrenParityDiagnostics(conn) as Record<string, unknown>
      expect(snap.comparedNoDivergence).toBe(1)
      expect(Object.keys(snap).some((k) => k.toLowerCase().includes("unknown") && k !== "transportUnknown")).toBeFalse()
      expect("match" in snap).toBeFalse()
      expect("fullParity" in snap).toBeFalse()
      expect("health" in snap).toBeFalse()
    } finally {
      console.warn = origWarn
    }
  })

  test("diagnostics count divergence; parity warn and comparator unchanged", async () => {
    const sdk = { data: [kid(KID_A), kid(KID_B)] }
    const before = JSON.stringify(sdk)
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const conn: ChildrenParityConnection = {
        isPrivateAvailable: () => true,
        privateChildrenOutcomeWithHandle: (req) => ({
          id: 1,
          promise: Promise.resolve({
            kind: "valid",
            result: { ...matchResult(req), data: { children: [kid(KID_A)] } },
          }),
        }),
        getPrivateEpoch: () => 1,
      }
      observeSessionChildrenParityDetached(conn, sdk as never, PARENT, "/tmp", 200)
      await new Promise((r) => setTimeout(r, 50))
      expect(JSON.stringify(sdk)).toBe(before)
      expect(
        warns.some(
          (w) => String(w[0]).includes("parity divergence") && String(w[1]).includes("observation-divergence"),
        ),
      ).toBeTrue()
      expect({ ...getSessionChildrenParityDiagnostics(conn) }).toEqual({ ...zeros(), divergence: 1 })
      const parity = compareChildrenParity(
        { ...matchResult({ requestId: "r", opId: "o", idempotencyKey: "o" }), data: { children: [kid(KID_A)] } } as unknown as never,
        sdk as unknown as never,
        PARENT,
      )
      expect(parity.divergence).toContain("observation-divergence")
    } finally {
      console.warn = origWarn
    }
  })

  test("diagnostics count transport-unknown separately from divergence", async () => {
    const sdk = { data: [kid(KID_A)] }
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const conn: ChildrenParityConnection = {
        isPrivateAvailable: () => true,
        privateChildrenOutcomeWithHandle: (req) => ({
          id: 1,
          promise: Promise.resolve({
            kind: "valid",
            result: {
              v: 1,
              requestId: req.requestId,
              opId: req.opId,
              op: "session/children",
              idempotencyKey: req.idempotencyKey,
              status: "ambiguous",
              outcome: { type: "ambiguous", time: 1 },
              accepted: false,
              transportUnknown: true,
            },
          }),
        }),
        getPrivateEpoch: () => 1,
      }
      observeSessionChildrenParityDetached(conn, sdk as never, PARENT, "/tmp", 200)
      await new Promise((r) => setTimeout(r, 50))
      expect(warns.some((w) => JSON.stringify(w).includes("transport-unknown"))).toBeTrue()
      expect({ ...getSessionChildrenParityDiagnostics(conn) }).toEqual({ ...zeros(), transportUnknown: 1 })
    } finally {
      console.warn = origWarn
    }
  })

  test("diagnostics count validation divergence without comparator codes", async () => {
    const sdk = { data: [kid(KID_A), kid(KID_B)] }
    const before = JSON.stringify(sdk)
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const conn: ChildrenParityConnection = {
        isPrivateAvailable: () => true,
        privateChildrenOutcomeWithHandle: () => ({
          id: 2,
          promise: Promise.resolve({ kind: "invalid", detail: "succeeded data.children entry must be object" }),
        }),
        getPrivateEpoch: () => 1,
      }
      observeSessionChildrenParityDetached(conn, sdk as never, PARENT, "/tmp", 200)
      await new Promise((r) => setTimeout(r, 50))
      expect(JSON.stringify(sdk)).toBe(before)
      expect(warns.some((w) => String(w[0]).includes("validation divergence"))).toBeTrue()
      expect(warns.some((w) => String(w[0]).includes("parity divergence"))).toBeFalse()
      expect({ ...getSessionChildrenParityDiagnostics(conn) }).toEqual({ ...zeros(), validationDivergence: 1 })
    } finally {
      console.warn = origWarn
    }
  })

  test("diagnostics count observer timeout; SDK snapshot untouched", async () => {
    const sdk = { data: [kid(KID_A)] }
    const before = JSON.stringify(sdk)
    const invalidated: string[] = []
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const conn: ChildrenParityConnection = {
        isPrivateAvailable: () => true,
        privateChildrenOutcomeWithHandle: () => ({
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
      observeSessionChildrenParityDetached(conn, sdk as never, PARENT, "/tmp", 20)
      await new Promise((r) => setTimeout(r, 100))
      expect(JSON.stringify(sdk)).toBe(before)
      expect(invalidated).toEqual([])
      expect(warns.some((w) => String(w[0]).includes("private parity timeout"))).toBeTrue()
      expect({ ...getSessionChildrenParityDiagnostics(conn) }).toEqual({ ...zeros(), timeout: 1, transportUnknown: 1 })
    } finally {
      console.warn = origWarn
    }
  })

  test("diagnostics count stale epoch invalidation without timeout", async () => {
    const sdk = { data: [kid(KID_A)] }
    const invalidated: string[] = []
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const conn: ChildrenParityConnection = {
        isPrivateAvailable: () => true,
        privateChildrenOutcomeWithHandle: () => ({
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
      observeSessionChildrenParityDetached(conn, sdk as never, PARENT, "/tmp", 20)
      await new Promise((r) => setTimeout(r, 100))
      expect(invalidated).toEqual([])
      expect(warns.some((w) => String(w[0]).includes("stale observer timeout skipped"))).toBeTrue()
      expect({ ...getSessionChildrenParityDiagnostics(conn) }).toEqual({ ...zeros(), staleSkipped: 1, transportUnknown: 1 })
    } finally {
      console.warn = origWarn
    }
  })

  test("diagnostics count failClosed on handle.cancel throw alongside timeout", async () => {
    const sdk = { data: [kid(KID_A)] }
    const before = JSON.stringify(sdk)
    const invalidated: string[] = []
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const conn: ChildrenParityConnection = {
        isPrivateAvailable: () => true,
        privateChildrenOutcomeWithHandle: () => ({
          id: 44,
          promise: new Promise(() => {}),
          cancel: () => {
            throw new Error("cancel-boom")
          },
        }),
        tryCancelPrivatePending: () => false,
        invalidatePrivatePeerOnObserverTimeout: (r) => {
          invalidated.push(r)
        },
        getPrivateEpoch: () => 9,
      }
      observeSessionChildrenParityDetached(conn, sdk as never, PARENT, "/tmp", 20)
      await new Promise((r) => setTimeout(r, 100))
      expect(JSON.stringify(sdk)).toBe(before)
      expect(invalidated).toEqual(["children observer timeout"])
      expect(
        warns.some(
          (w) =>
            String(w[0]).includes("handle.cancel failed") &&
            String(JSON.stringify(w[1] ?? {})).includes('"cancelFailed":true'),
        ),
      ).toBeTrue()
      expect(warns.some((w) => String(w[0]).includes("private parity timeout"))).toBeTrue()
      expect({ ...getSessionChildrenParityDiagnostics(conn) }).toEqual({
        ...zeros(),
        timeout: 1,
        transportUnknown: 1,
        failClosed: 1,
      })
    } finally {
      console.warn = origWarn
    }
  })

  test("diagnostics count failClosed on tryCancel throw alongside timeout", async () => {
    const sdk = { data: [kid(KID_A)] }
    const before = JSON.stringify(sdk)
    const invalidated: string[] = []
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const conn: ChildrenParityConnection = {
        isPrivateAvailable: () => true,
        privateChildrenOutcomeWithHandle: () => ({
          id: 45,
          promise: new Promise(() => {}),
        }),
        tryCancelPrivatePending: () => {
          throw new Error("try-cancel-boom")
        },
        invalidatePrivatePeerOnObserverTimeout: (r) => {
          invalidated.push(r)
        },
        getPrivateEpoch: () => 9,
      }
      observeSessionChildrenParityDetached(conn, sdk as never, PARENT, "/tmp", 20)
      await new Promise((r) => setTimeout(r, 100))
      expect(JSON.stringify(sdk)).toBe(before)
      expect(invalidated).toEqual(["children observer timeout"])
      expect(
        warns.some(
          (w) =>
            String(w[0]).includes("tryCancelPrivatePending failed") &&
            String(JSON.stringify(w[1] ?? {})).includes('"cancelFailed":true'),
        ),
      ).toBeTrue()
      expect({ ...getSessionChildrenParityDiagnostics(conn) }).toEqual({
        ...zeros(),
        timeout: 1,
        transportUnknown: 1,
        failClosed: 1,
      })
    } finally {
      console.warn = origWarn
    }
  })

  test("diagnostics count failClosed on invalidate throw alongside timeout", async () => {
    const sdk = { data: [kid(KID_A)] }
    const before = JSON.stringify(sdk)
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const conn: ChildrenParityConnection = {
        isPrivateAvailable: () => true,
        privateChildrenOutcomeWithHandle: () => ({
          id: 46,
          promise: new Promise(() => {}),
          cancel: () => false,
        }),
        tryCancelPrivatePending: () => false,
        invalidatePrivatePeerOnObserverTimeout: () => {
          throw new Error("invalidate-boom")
        },
        getPrivateEpoch: () => 9,
      }
      observeSessionChildrenParityDetached(conn, sdk as never, PARENT, "/tmp", 20)
      await new Promise((r) => setTimeout(r, 100))
      expect(JSON.stringify(sdk)).toBe(before)
      expect(
        warns.some(
          (w) =>
            String(w[0]).includes("invalidatePrivatePeerOnObserverTimeout failed") &&
            String(JSON.stringify(w[1] ?? {})).includes('"invalidateFailed":true'),
        ),
      ).toBeTrue()
      expect({ ...getSessionChildrenParityDiagnostics(conn) }).toEqual({
        ...zeros(),
        timeout: 1,
        transportUnknown: 1,
        failClosed: 1,
      })
    } finally {
      console.warn = origWarn
    }
  })

  test("diagnostics count fail-closed on private throw; SDK-first preserved", async () => {
    const sdk = { data: [kid(KID_A)] }
    const before = JSON.stringify(sdk)
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const conn: ChildrenParityConnection = {
        isPrivateAvailable: () => true,
        privateChildrenOutcomeWithHandle: () => {
          throw new Error("private boom")
        },
        getPrivateEpoch: () => 1,
      }
      const ret = observeSessionChildrenParityDetached(conn, sdk as never, PARENT, "/tmp", 50)
      expect(ret).toBeUndefined()
      await new Promise((r) => setTimeout(r, 50))
      expect(JSON.stringify(sdk)).toBe(before)
      expect(warns.some((w) => String(w[0]).includes("private parity observation failed (fail-closed)"))).toBeTrue()
      expect({ ...getSessionChildrenParityDiagnostics(conn) }).toEqual({ ...zeros(), failClosed: 1 })
    } finally {
      console.warn = origWarn
    }
  })

  test("diagnostics count deferred stale skip; snapshot frozen, resettable, per-connection", async () => {
    const sdk = { data: [kid(KID_A)] }
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      let listener: (() => void) | null = null
      const conn: ChildrenParityConnection = {
        isPrivateAvailable: () => false,
        privateChildrenOutcomeWithHandle: () => ({
          id: 1,
          promise: Promise.resolve({ kind: "valid", result: {} }),
        }),
        getPrivateEpoch: () => 3,
        onPrivateAvailable: (fn) => {
          listener = fn
          return () => {
            listener = null
          }
        },
      }
      const other: ChildrenParityConnection = {
        isPrivateAvailable: () => false,
        privateChildrenOutcomeWithHandle: () => ({
          id: 1,
          promise: Promise.resolve({ kind: "valid", result: {} }),
        }),
        getPrivateEpoch: () => 3,
        onPrivateAvailable: () => () => {},
      }
      observeSessionChildrenParityDetached(conn, sdk as never, PARENT, "/tmp", 50)
      expect(listener).not.toBeNull()
      ;(conn as { getPrivateEpoch: () => number }).getPrivateEpoch = () => 4
      listener!()
      await new Promise((r) => setTimeout(r, 30))
      expect(warns.some((w) => String(w[0]).includes("stale deferred parity skipped"))).toBeTrue()
      const snap = getSessionChildrenParityDiagnostics(conn)
      expect({ ...snap }).toEqual({ ...zeros(), staleSkipped: 1 })
      expect(Object.isFrozen(snap)).toBeTrue()
      const warnCount = warns.length
      expect({ ...getSessionChildrenParityDiagnostics(conn) }).toEqual({ ...zeros(), staleSkipped: 1 })
      expect(warns.length).toBe(warnCount)
      expect({ ...getSessionChildrenParityDiagnostics(other) }).toEqual(zeros())
      resetSessionChildrenParityDiagnostics(conn)
      expect({ ...getSessionChildrenParityDiagnostics(conn) }).toEqual(zeros())
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
      const conn: ChildrenParityConnection = {
        isPrivateAvailable: () => true,
        privateChildrenOutcomeWithHandle: () => {
          calls += 1
          throw new Error("must not observe")
        },
        getPrivateEpoch: () => 1,
      }
      const ret = observeSessionChildrenParityDetached(conn, sdk as unknown as never, PARENT, "/tmp", 50)
      expect(ret).toBeUndefined()
      await new Promise((r) => setTimeout(r, 30))
      expect(calls).toBe(0)
      expect(warns.length).toBe(0)
      expect({ ...getSessionChildrenParityDiagnostics(conn) }).toEqual(zeros())
    } finally {
      console.warn = origWarn
    }
  })
})
