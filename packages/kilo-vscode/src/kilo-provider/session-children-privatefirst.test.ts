import { describe, expect, it, mock } from "bun:test"
import {
  attemptSessionChildrenPrivate,
  buildSessionChildrenReq,
  coerceSdkChildren,
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

describe("session-children private-first helper", () => {
  it("builds strict parent-bound opId identity", () => {
    const r = req()
    expect(r.op).toBe("session/children")
    expect(r.opId.startsWith(`children:${PARENT}:`)).toBeTrue()
    expect(r.idempotencyKey).toBe(r.opId)
    expect(r.context.parentSessionId).toBe(PARENT)
    expect(r.context.directory).toBe(DIR)
  })

  it("valid success returns privately including empty and unordered", () => {
    const r = req()
    const out = parseSessionChildrenResult(okKids(r, [kid("ses_b"), kid("ses_a")]), r)
    expect(out.kind).toBe("ok")
    const empty = parseSessionChildrenResult(okKids(r, []), r)
    expect(empty.kind).toBe("ok")
  })

  it("strict validation rejects parent mismatch, bad directory, duplicates", () => {
    const r = req()
    expect(parseSessionChildrenResult(okKids(r, [kid("ses_a", { parentID: "ses_other" })]), r).kind).toBe("fallback")
    expect(parseSessionChildrenResult(okKids(r, [kid("ses_a", { directory: "relative" })]), r).kind).toBe(
      "fallback",
    )
    expect(parseSessionChildrenResult(okKids(r, [kid("ses_a"), kid("ses_a")]), r).kind).toBe("fallback")
    expect(parseSessionChildrenResult(okKids(r, [{ ...kid("ses_a"), id: "bad" }]), r).kind).toBe("fallback")
    expect(parseSessionChildrenResult(null, r).kind).toBe("fallback")
    expect(parseSessionChildrenResult({ ...okKids(r, []), transportUnknown: true }, r).kind).toBe("fallback")
  })

  it("child directories may differ from the parent directory", () => {
    const r = req()
    const out = parseSessionChildrenResult(okKids(r, [kid("ses_a", { directory: "/other/root" })]), r)
    expect(out.kind).toBe("ok")
  })

  it("terminal closes with zero SDK for non-retryable codes", async () => {
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
    }
  })

  it.each([["retryable"], ["ambiguous"], ["invalid"], ["transportUnknown"]])(
    "fallback class %s issues exactly one same-parent SDK read",
    async (name) => {
      const sdk = mock(async (params: { sessionID: string; directory: string }) => {
        expect(params.sessionID).toBe(PARENT)
        expect(params.directory).toBe(DIR)
        return { data: [kid("ses_a")] }
      })
      const client = { session: { children: sdk } } as never
      const maker = (r: ServePrivateChildrenRequest) => {
        if (name === "retryable") return failedRes(r, "InstanceUnavailableDuringConfigRebuild", "fence", true)
        if (name === "ambiguous") return ambiguousRes(r)
        if (name === "transportUnknown") return { ...okKids(r, []), transportUnknown: true }
        return { ...okKids(r, []), extra: 1 }
      }
      const out = await fetchSessionChildrenPrivateFirst({
        connection: outcomeConn(maker as (r: ServePrivateChildrenRequest) => unknown) as never,
        client,
        parentSessionId: PARENT,
        directory: DIR,
      })
      expect(out.kind).toBe("ok")
      if (out.kind === "ok") expect(out.via).toBe("sdk")
      expect(sdk).toHaveBeenCalledTimes(1)
    },
  )

  it("unavailable and closed fall back once with no second private request", async () => {
    let calls = 0
    const sdk = mock(async () => {
      calls += 1
      return { data: [kid("ses_a")] }
    })
    const client = { session: { children: sdk } } as never
    const unavailable = await fetchSessionChildrenPrivateFirst({
      connection: { isPrivateAvailable: () => false } as never,
      client,
      parentSessionId: PARENT,
      directory: DIR,
    })
    expect(unavailable.kind).toBe("ok")
    expect(calls).toBe(1)
    sdk.mockClear()
    calls = 0
    let privates = 0
    const closed = {
      isPrivateAvailable: () => true,
      privateChildrenOutcomeWithHandle: () => {
        privates += 1
        throw new Error("Peer closed")
      },
    } as never
    const out = await fetchSessionChildrenPrivateFirst({
      connection: closed,
      client,
      parentSessionId: PARENT,
      directory: DIR,
    })
    expect(out.kind).toBe("ok")
    expect(sdk).toHaveBeenCalledTimes(1)
    expect(privates).toBe(1)
  })

  it("timeout exact-cancels and falls back once", async () => {
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
    const out = await fetchSessionChildrenPrivateFirst({
      connection: conn,
      client: { session: { children: sdk } } as never,
      parentSessionId: PARENT,
      directory: DIR,
      timeoutMs: 30,
    })
    expect(out.kind).toBe("ok")
    if (out.kind === "ok") expect(out.via).toBe("sdk")
    expect(cancelled).toBeTrue()
    expect(sdk).toHaveBeenCalledTimes(1)
  })

  it("SDK error and malformed return unavailable", async () => {
    const conn = { isPrivateAvailable: () => false } as never
    const errClient = { session: { children: mock(async () => { throw new Error("boom") }) } } as never
    expect(
      (await fetchSessionChildrenPrivateFirst({ connection: conn, client: errClient, parentSessionId: PARENT, directory: DIR })).kind,
    ).toBe("unavailable")
    const nullClient = { session: { children: mock(async () => ({ data: null })) } } as never
    expect(
      (await fetchSessionChildrenPrivateFirst({ connection: conn, client: nullClient, parentSessionId: PARENT, directory: DIR })).kind,
    ).toBe("unavailable")
    const badClient = {
      session: { children: mock(async () => ({ data: [kid("ses_a", { parentID: "ses_other" })] })) },
    } as never
    expect(
      (await fetchSessionChildrenPrivateFirst({ connection: conn, client: badClient, parentSessionId: PARENT, directory: DIR })).kind,
    ).toBe("unavailable")
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
  })

  it("coerceSdkChildren accepts strict list and rejects malformed", () => {
    expect(coerceSdkChildren([kid("ses_a")], PARENT)).not.toBeNull()
    expect(coerceSdkChildren([], PARENT)).not.toBeNull()
    expect(coerceSdkChildren(null, PARENT)).toBeNull()
    expect(coerceSdkChildren([kid("ses_a", { parentID: "ses_other" })], PARENT)).toBeNull()
    expect(coerceSdkChildren([kid("ses_a"), kid("ses_a")], PARENT)).toBeNull()
  })
})
