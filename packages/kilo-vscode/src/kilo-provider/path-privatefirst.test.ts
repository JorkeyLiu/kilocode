import { describe, expect, test } from "bun:test"
import {
  attemptPathPrivate,
  buildPathReq,
  fetchPathPrivateFirst,
  parsePathResult,
} from "./path-privatefirst"

function req(dir = "/tmp") {
  return buildPathReq(dir)
}

function okResult(r: ReturnType<typeof req>, state = "/s") {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "path/get",
    idempotencyKey: r.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { path: { home: "/h", state, config: "/c", worktree: "/tmp", directory: "/tmp" } },
  }
}

function failedResult(r: ReturnType<typeof req>, retryable: boolean) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "path/get",
    idempotencyKey: r.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure: { code: "validation.failed", message: "bad", retryable } },
    accepted: false,
    failure: { code: "validation.failed", message: "bad", retryable },
  }
}

describe("path private-first helper", () => {
  test("succeeded+accepted is ok with zero SDK", async () => {
    let sdk = 0
    const c = {
      isPrivateAvailable: () => true,
      privatePathOutcomeWithHandle: (q: unknown) => {
        const typed = q as ReturnType<typeof req>
        return { id: 1, promise: Promise.resolve({ kind: "valid", result: okResult(typed) }), cancel: () => true }
      },
    }
    const out = await fetchPathPrivateFirst({
      connection: c as never,
      client: { path: { get: async () => (sdk += 1, { data: {} }) } } as never,
      directory: "/repo",
    })
    expect(out.kind).toBe("ok")
    if (out.kind === "ok") expect(out.via).toBe("private")
    expect(sdk).toBe(0)
  })

  test("terminal failed closes with zero SDK", async () => {
    let sdk = 0
    const c = {
      isPrivateAvailable: () => true,
      privatePathOutcomeWithHandle: (q: unknown) => ({
        id: 1,
        promise: Promise.resolve({ kind: "valid", result: failedResult(q as ReturnType<typeof req>, false) }),
        cancel: () => true,
      }),
    }
    const out = await fetchPathPrivateFirst({
      connection: c as never,
      client: { path: { get: async () => (sdk += 1, { data: {} }) } } as never,
      directory: "/repo",
    })
    expect(out.kind).toBe("terminal")
    expect(sdk).toBe(0)
  })

  test("retryable/invalid/ambiguous fall back exactly once with same directory", async () => {
    const builders: Array<(r: ReturnType<typeof req>) => unknown> = [
      (r) => ({ kind: "valid", result: failedResult(r, true) }),
      () => ({ kind: "invalid", detail: "bad" }),
      (r) => ({
        kind: "valid",
        result: {
          v: 1,
          requestId: r.requestId,
          opId: r.opId,
          op: "path/get",
          idempotencyKey: r.idempotencyKey,
          status: "ambiguous",
          outcome: { type: "ambiguous", time: 1 },
          accepted: false,
          transportUnknown: true,
        },
      }),
    ]
    for (const build of builders) {
      let sdk = 0
      let arg: unknown = null
      const c = {
        isPrivateAvailable: () => true,
        privatePathOutcomeWithHandle: (q: unknown) => ({
          id: 1,
          promise: Promise.resolve(build(q as ReturnType<typeof req>)),
          cancel: () => true,
        }),
      }
      const out = await fetchPathPrivateFirst({
        connection: c as never,
        client: {
          path: {
            get: async (p?: unknown) => {
              sdk += 1
              arg = p
              return { data: { home: "/h", state: "/s", config: "/c", worktree: "/repo", directory: "/repo" } }
            },
          },
        } as never,
        directory: "/repo",
      })
      expect(out.kind).toBe("ok")
      if (out.kind === "ok") expect(out.via).toBe("sdk")
      expect(sdk).toBe(1)
      expect(arg).toEqual({ directory: "/repo" })
    }
  })

  test("no directory sends no private request and SDK with no args", async () => {
    let priv = 0
    let arg: unknown = "unset"
    const c = {
      isPrivateAvailable: () => {
        priv += 1
        return true
      },
      privatePathOutcomeWithHandle: () => {
        priv += 1
        throw new Error("must not call private without directory")
      },
    }
    const out = await fetchPathPrivateFirst({
      connection: c as never,
      client: {
        path: {
          get: async (...a: unknown[]) => {
            arg = a
            return { data: { home: "/h", state: "/s", config: "/c", worktree: "/w", directory: "/d" } }
          },
        },
      } as never,
      directory: undefined,
    })
    expect(out.kind).toBe("ok")
    expect(priv).toBe(0)
    expect(arg).toEqual([])
  })

  test("timeout exact-cancels the pending by id and falls back", async () => {
    const r = req("/repo")
    let cancelled: unknown = null
    const c = {
      isPrivateAvailable: () => true,
      privatePathOutcomeWithHandle: () => ({
        id: 41,
        promise: new Promise(() => {}),
        cancel: (msg?: string) => {
          cancelled = msg
          return true
        },
      }),
    }
    const attempt = await attemptPathPrivate(c as never, r, 20)
    expect(attempt.kind).toBe("fallback")
    if (attempt.kind === "fallback") expect(attempt.reason).toBe("timeout")
    expect(typeof cancelled).toBe("string")
    expect(String(cancelled)).toContain(r.opId)
  })

  test("parse never compares globals: only status/accepted/retryable decide", () => {
    const r = req("/repo")
    expect(parsePathResult(okResult(r, "/a"), r).kind).toBe("ok")
    expect(parsePathResult(failedResult(r, false), r).kind).toBe("terminal")
    expect(parsePathResult(failedResult(r, true), r).kind).toBe("fallback")
  })
})
