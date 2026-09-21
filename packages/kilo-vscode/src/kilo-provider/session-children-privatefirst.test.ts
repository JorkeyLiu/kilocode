import { describe, expect, it, mock } from "bun:test"
import {
  attemptSessionChildrenPrivate,
  buildSessionChildrenReq,
  coerceSdkChildren,
  fetchSessionChildrenPrivate,
  fetchSessionChildrenPrivateFirst,
  parseSessionChildrenResult,
} from "./session-children-privatefirst"
import type { ServePrivateChildrenRequest } from "../services/cli-backend/serve-private-children"

const PARENT = "ses_parent0001"
const DIR = "/repo"

function req(): ServePrivateChildrenRequest {
  return buildSessionChildrenReq(PARENT, DIR)
}

function kid(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    slug: "s",
    projectID: "p",
    directory: DIR,
    parentID: PARENT,
    title: "t",
    version: "v1",
    time: { created: 1, updated: 2 },
    ...overrides,
  }
}

function okKids(r: ServePrivateChildrenRequest, children: unknown[]) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "session/children",
    idempotencyKey: r.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: Date.now() },
    accepted: true,
    data: { children },
  }
}

function failedRes(r: ServePrivateChildrenRequest, code = "internal", message = "x", retryable = false) {
  const failure = { code, message, retryable }
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "session/children",
    idempotencyKey: r.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: Date.now(), failure },
    accepted: false,
    failure,
  }
}

function ambiguousRes(r: ServePrivateChildrenRequest) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "session/children",
    idempotencyKey: r.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: Date.now() },
    accepted: false,
    transportUnknown: true,
  }
}

function outcomeConn(result: unknown) {
  return {
    isPrivateAvailable: () => true,
    privateChildrenOutcomeWithHandle: (r: ServePrivateChildrenRequest) => ({
      id: 1,
      promise: Promise.resolve(
        typeof result === "function"
          ? { kind: "valid", result: (result as (q: ServePrivateChildrenRequest) => unknown)(r) }
          : { kind: "valid", result },
      ),
      cancel: () => true,
    }),
  }
}

describe("session-children private-authority helper", () => {
  it("builds strict parent-bound opId identity", () => {
    const r = req()
    expect(r.op).toBe("session/children")
    expect(r.opId.startsWith(`children:${PARENT}:`)).toBeTrue()
    expect(r.idempotencyKey).toBe(r.opId)
    expect(r.context.parentSessionId).toBe(PARENT)
    expect(r.context.directory).toBe(DIR)
  })

  it("valid success returns private authoritative including empty and unordered", async () => {
    const r = req()
    const out = parseSessionChildrenResult(okKids(r, [kid("ses_b"), kid("ses_a")]), r)
    expect(out.kind).toBe("ok")
    const empty = parseSessionChildrenResult(okKids(r, []), r)
    expect(empty.kind).toBe("ok")

    const conn = outcomeConn((q: ServePrivateChildrenRequest) => okKids(q, [kid("ses_a"), kid("ses_b")])) as never
    const res = await fetchSessionChildrenPrivate({ connection: conn, parentSessionId: PARENT, directory: DIR })
    expect(res.kind).toBe("ok")
    if (res.kind === "ok") {
      expect(res.via).toBe("private")
      expect(res.children.length).toBe(2)
    }
    const emptyRes = await fetchSessionChildrenPrivate({ connection: outcomeConn((q: ServePrivateChildrenRequest) => okKids(q, [])) as never, parentSessionId: PARENT, directory: DIR })
    expect(emptyRes.kind).toBe("ok")
    if (emptyRes.kind === "ok") expect(emptyRes.children.length).toBe(0)
  })

  it("strict validation rejects parent mismatch, bad directory, duplicates -> fail-closed unavailable with zero SDK", async () => {
    const r = req()
    expect(parseSessionChildrenResult(okKids(r, [kid("ses_a", { parentID: "ses_other" })]), r).kind).toBe("fallback")
    expect(parseSessionChildrenResult(okKids(r, [kid("ses_a", { directory: "relative" })]), r).kind).toBe(
      "fallback",
    )
    expect(parseSessionChildrenResult(okKids(r, [kid("ses_a"), kid("ses_a")]), r).kind).toBe("fallback")
    expect(parseSessionChildrenResult(okKids(r, [{ ...kid("ses_a"), id: "bad" }]), r).kind).toBe("fallback")
    expect(parseSessionChildrenResult(null, r).kind).toBe("fallback")
    expect(parseSessionChildrenResult({ ...okKids(r, []), transportUnknown: true }, r).kind).toBe("fallback")

    const sdk = mock(async () => ({ data: [] }))
    for (const bad of [
      [kid("ses_a", { parentID: "ses_other" })],
      [kid("ses_a", { directory: "relative" })],
      [kid("ses_a"), kid("ses_a")],
    ]) {
      sdk.mockClear()
      const c = outcomeConn((q: ServePrivateChildrenRequest) => okKids(q, bad)) as never
      const out = await fetchSessionChildrenPrivate({ connection: c, parentSessionId: PARENT, directory: DIR })
      expect(out.kind).toBe("unavailable")
      expect(sdk).toHaveBeenCalledTimes(0)
    }
    // also via PrivateFirst alias with client passed but ignored
    const client = { session: { children: sdk } } as never
    const out = await fetchSessionChildrenPrivateFirst({ connection: outcomeConn((q: ServePrivateChildrenRequest) => okKids(q, [kid("ses_a", { parentID: "ses_other" })])) as never, client, parentSessionId: PARENT, directory: DIR })
    expect(out.kind).toBe("unavailable")
    expect(sdk).toHaveBeenCalledTimes(0)
  })

  it("child directories may differ from the parent directory", () => {
    const r = req()
    const out = parseSessionChildrenResult(okKids(r, [kid("ses_a", { directory: "/other/root" })]), r)
    expect(out.kind).toBe("ok")
  })

  it("terminal closes with zero SDK for non-retryable codes (private-authority)", async () => {
    const sdk = mock(async () => ({ data: [] }))
    const client = { session: { children: sdk } } as never
    for (const code of ["session.not_found", "scope_mismatch", "validation.failed", "internal"]) {
      sdk.mockClear()
      const snapshot = code
      const out = await fetchSessionChildrenPrivateFirst({
        connection: outcomeConn((q: ServePrivateChildrenRequest) => failedRes(q, snapshot, "m", false)) as never,
        client,
        parentSessionId: PARENT,
        directory: DIR,
      })
      expect(out.kind).toBe("terminal")
      expect(sdk).toHaveBeenCalledTimes(0)
      const out2 = await fetchSessionChildrenPrivate({
        connection: outcomeConn((q: ServePrivateChildrenRequest) => failedRes(q, snapshot, "m", false)) as never,
        parentSessionId: PARENT,
        directory: DIR,
      })
      expect(out2.kind).toBe("terminal")
    }
  })

  it.each([["retryable"], ["ambiguous"], ["invalid"], ["transportUnknown"]])(
    "fallback class %s fails closed to unavailable with zero SDK (private-authority)",
    async (name) => {
      const sdk = mock(async () => ({ data: [kid("ses_a")] }))
      const client = { session: { children: sdk } } as never
      const maker = (r: ServePrivateChildrenRequest) => {
        if (name === "retryable") return failedRes(r, "InstanceUnavailableDuringConfigRebuild", "fence", true)
        if (name === "ambiguous") return ambiguousRes(r)
        if (name === "transportUnknown") return { ...okKids(r, []), transportUnknown: true }
        return { ...okKids(r, []), extra: 1 }
      }
      const out = await fetchSessionChildrenPrivate({
        connection: outcomeConn(maker as (r: ServePrivateChildrenRequest) => unknown) as never,
        parentSessionId: PARENT,
        directory: DIR,
      })
      expect(out.kind).toBe("unavailable")
      expect(sdk).toHaveBeenCalledTimes(0)
      const out2 = await fetchSessionChildrenPrivateFirst({
        connection: outcomeConn(maker as (r: ServePrivateChildrenRequest) => unknown) as never,
        client,
        parentSessionId: PARENT,
        directory: DIR,
      })
      expect(out2.kind).toBe("unavailable")
      expect(sdk).toHaveBeenCalledTimes(0)
    },
  )

  it("gate/off/not-started/worker unavailable -> unavailable with zero SDK and no second private request", async () => {
    const sdk = mock(async () => ({ data: [kid("ses_a")] }))
    const client = { session: { children: sdk } } as never
    const unavailable = await fetchSessionChildrenPrivate({
      connection: { isPrivateAvailable: () => false } as never,
      parentSessionId: PARENT,
      directory: DIR,
    })
    expect(unavailable.kind).toBe("unavailable")
    expect(sdk).toHaveBeenCalledTimes(0)
    const unavailable2 = await fetchSessionChildrenPrivateFirst({
      connection: { isPrivateAvailable: () => false } as never,
      client,
      parentSessionId: PARENT,
      directory: DIR,
    })
    expect(unavailable2.kind).toBe("unavailable")
    expect(sdk).toHaveBeenCalledTimes(0)

    sdk.mockClear()
    let privates = 0
    const closed = {
      isPrivateAvailable: () => true,
      privateChildrenOutcomeWithHandle: () => {
        privates += 1
        throw new Error("Peer closed")
      },
    } as never
    const out = await fetchSessionChildrenPrivate({ connection: closed, parentSessionId: PARENT, directory: DIR })
    expect(out.kind).toBe("unavailable")
    expect(sdk).toHaveBeenCalledTimes(0)
    expect(privates).toBe(1)
    const out2 = await fetchSessionChildrenPrivateFirst({ connection: closed, client, parentSessionId: PARENT, directory: DIR })
    expect(out2.kind).toBe("unavailable")
    expect(sdk).toHaveBeenCalledTimes(0)
    expect(privates).toBe(2)

    // null/undefined connection
    const nullOut = await fetchSessionChildrenPrivate({ connection: null as never, parentSessionId: PARENT, directory: DIR })
    expect(nullOut.kind).toBe("unavailable")
    expect(sdk).toHaveBeenCalledTimes(0)
    const notStarted = await fetchSessionChildrenPrivate({ connection: { isPrivateAvailable: () => { throw new Error("not started") } } as never, parentSessionId: PARENT, directory: DIR })
    expect(notStarted.kind).toBe("unavailable")
    expect(sdk).toHaveBeenCalledTimes(0)
  })

  it("timeout exact-cancels and fails closed to unavailable with zero SDK", async () => {
    let cancelled = false
    const conn = {
      isPrivateAvailable: () => true,
      privateChildrenOutcomeWithHandle: () => ({
        id: 9,
        promise: new Promise(() => {}),
        cancel: () => {
          cancelled = true
          return true
        },
      }),
    } as never
    const sdk = mock(async () => ({ data: [kid("ses_a")] }))
    const client = { session: { children: sdk } } as never
    const out = await fetchSessionChildrenPrivate({ connection: conn, parentSessionId: PARENT, directory: DIR, timeoutMs: 30 })
    expect(out.kind).toBe("unavailable")
    expect(cancelled).toBeTrue()
    expect(sdk).toHaveBeenCalledTimes(0)
    cancelled = false
    const out2 = await fetchSessionChildrenPrivateFirst({ connection: conn, client, parentSessionId: PARENT, directory: DIR, timeoutMs: 30 })
    expect(out2.kind).toBe("unavailable")
    expect(cancelled).toBeTrue()
    expect(sdk).toHaveBeenCalledTimes(0)
  })

  it("signal abort before private request throws and with zero SDK and cancel", async () => {
    const sdk = mock(async () => ({ data: [kid("ses_a")] }))
    const client = { session: { children: sdk } } as never
    let cancelCalled = false
    const conn = {
      isPrivateAvailable: () => true,
      privateChildrenOutcomeWithHandle: () => ({
        id: 11,
        promise: new Promise(() => {}),
        cancel: () => {
          cancelCalled = true
          return true
        },
      }),
    } as never
    const ac = new AbortController()
    ac.abort(new DOMException("aborted", "AbortError"))
    await expect(fetchSessionChildrenPrivate({ connection: conn, parentSessionId: PARENT, directory: DIR, signal: ac.signal })).rejects.toThrow()
    expect(cancelCalled).toBeFalse()
    expect(sdk).toHaveBeenCalledTimes(0)
    await expect(fetchSessionChildrenPrivateFirst({ connection: conn, client, parentSessionId: PARENT, directory: DIR, signal: ac.signal })).rejects.toThrow()
    expect(sdk).toHaveBeenCalledTimes(0)
  })

  it("signal abort during private request cancels transport and throws with zero SDK", async () => {
    const sdk = mock(async () => ({ data: [kid("ses_a")] }))
    const client = { session: { children: sdk } } as never
    let cancelCalled = false
    const ac = new AbortController()
    const conn = {
      isPrivateAvailable: () => true,
      privateChildrenOutcomeWithHandle: () => ({
        id: 12,
        promise: new Promise(() => {}),
        cancel: () => {
          cancelCalled = true
          return true
        },
      }),
    } as never
    const pending = fetchSessionChildrenPrivate({ connection: conn, parentSessionId: PARENT, directory: DIR, signal: ac.signal })
    ac.abort(new DOMException("aborted mid-flight", "AbortError"))
    await expect(pending).rejects.toThrow()
    expect(cancelCalled).toBeTrue()
    expect(sdk).toHaveBeenCalledTimes(0)
    cancelCalled = false
    const ac2 = new AbortController()
    const pending2 = fetchSessionChildrenPrivateFirst({ connection: conn, client, parentSessionId: PARENT, directory: DIR, signal: ac2.signal })
    ac2.abort()
    await expect(pending2).rejects.toThrow()
    expect(cancelCalled).toBeTrue()
    expect(sdk).toHaveBeenCalledTimes(0)
  })

  it("attempt helper maps invalid outcome kind to fallback", async () => {
    const r = req()
    const conn = {
      isPrivateAvailable: () => true,
      privateChildrenOutcomeWithHandle: () => ({
        id: 3,
        promise: Promise.resolve({ kind: "invalid", detail: "bad" }),
        cancel: () => true,
      }),
    } as never
    expect((await attemptSessionChildrenPrivate(conn, r)).kind).toBe("fallback")
    const out = await fetchSessionChildrenPrivate({ connection: conn as never, parentSessionId: PARENT, directory: DIR })
    expect(out.kind).toBe("unavailable")
  })

  it("coerceSdkChildren accepts strict list and rejects malformed", () => {
    expect(coerceSdkChildren([kid("ses_a")], PARENT)).not.toBeNull()
    expect(coerceSdkChildren([], PARENT)).not.toBeNull()
    expect(coerceSdkChildren(null, PARENT)).toBeNull()
    expect(coerceSdkChildren([kid("ses_a", { parentID: "ses_other" })], PARENT)).toBeNull()
    expect(coerceSdkChildren([kid("ses_a"), kid("ses_a")], PARENT)).toBeNull()
  })
})
