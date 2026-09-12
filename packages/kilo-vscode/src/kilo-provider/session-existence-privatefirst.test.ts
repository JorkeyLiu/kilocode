import { describe, expect, test } from "bun:test"
import {
  attemptSessionExistencePrivate,
  buildSessionExistencePrivateIdentity,
  buildSessionExistencePrivateReq,
  hasAnySession,
  parseSessionExistencePrivateResult,
} from "./session-existence-privatefirst"
import { canonicalSessionListOpId } from "../services/cli-backend/serve-private-session-list-contract"
import { SESSION_LIST_TRANSPORT_FAILURE_MESSAGE } from "../services/cli-backend/serve-private-session-list"

function sum(id: string) {
  return { id, directory: "/tmp/exist", title: "t", updated: 1 }
}

function req() {
  return buildSessionExistencePrivateReq("/tmp/exist")
}

function okFor(r: ReturnType<typeof req>, sessions: unknown[] = [sum("ses1")]) {
  return {
    v: 2,
    requestId: r.requestId,
    opId: r.opId,
    op: "experimental/session/list",
    idempotencyKey: r.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { sessions },
  }
}

function failedFor(r: ReturnType<typeof req>, code = "validation.failed", retryable = false) {
  return {
    v: 2,
    requestId: r.requestId,
    opId: r.opId,
    op: "experimental/session/list",
    idempotencyKey: r.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure: { code, message: "bad", retryable } },
    accepted: false,
    failure: { code, message: "bad", retryable },
  }
}

function retryableFor(r: ReturnType<typeof req>) {
  return failedFor(r, "InstanceUnavailableDuringConfigRebuild", true)
}

function ambiguousFor(r: ReturnType<typeof req>) {
  return {
    v: 2,
    requestId: r.requestId,
    opId: r.opId,
    op: "experimental/session/list",
    idempotencyKey: r.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: 1 },
    accepted: false,
    transportUnknown: true,
  }
}

function connFor(result: (q: ReturnType<typeof req>) => unknown, id = 1) {
  return {
    isPrivateAvailable: () => true,
    privateSessionListOutcomeWithHandle: (q: ReturnType<typeof req>) => ({
      id,
      promise: Promise.resolve({ kind: "valid", result: result(q) }),
      cancel: () => true,
    }),
  }
}

function fullFor(
  result: (q: ReturnType<typeof req>) => unknown,
  sdk: { data: unknown[] } | { throws: unknown },
  got: { client: number; sdk: number; args: unknown[] },
  dir = "/tmp/exist",
) {
  return {
    isPrivateAvailable: () => true,
    privateSessionListOutcomeWithHandle: (q: ReturnType<typeof req>) => ({
      id: 1,
      promise: Promise.resolve({ kind: "valid", result: result(q) }),
      cancel: () => true,
    }),
    getClientAsync: async (d: string) => {
      got.client += 1
      expect(d).toBe(dir)
      return {
        experimental: {
          session: {
            list: async (a: unknown, o: unknown) => {
              got.sdk += 1
              got.args.push([a, o])
              if ("throws" in (sdk as object)) throw (sdk as { throws: unknown }).throws
              return { data: (sdk as { data: unknown[] }).data }
            },
          },
        },
      }
    },
  }
}

describe("session-existence private-first", () => {
  test("identity binds canonical session-list tuple", () => {
    const ids = buildSessionExistencePrivateIdentity()
    expect(ids.opId).toBe(ids.idempotencyKey)
    expect(ids.opId.startsWith("experimental-session-list:")).toBeTrue()
    const token = ids.opId.split(":")[1]!
    expect(canonicalSessionListOpId(token)).toBe(ids.opId)
    expect(typeof ids.requestId).toBe("string")
  })

  test("request binds strict same-directory filter tuple", () => {
    const r = buildSessionExistencePrivateReq("/tmp/exist")
    expect(r.v).toBe(2)
    expect(r.op).toBe("experimental/session/list")
    expect(r.opId).toBe(r.idempotencyKey)
    expect(r.context).toEqual({ directory: "/tmp/exist" })
    expect(r.payload).toEqual({ filter: { limit: 1, archived: true } })
  })

  test("succeeded accepted maps sessions.length>0 true/false", () => {
    const r = req()
    const one = parseSessionExistencePrivateResult(okFor(r, [sum("ses1")]), r)
    expect(one).toEqual({ kind: "ok", has: true })
    const two = parseSessionExistencePrivateResult(okFor(r, [sum("ses1"), sum("ses2")]), r)
    expect(two).toEqual({ kind: "ok", has: true })
    const none = parseSessionExistencePrivateResult(okFor(r, []), r)
    expect(none).toEqual({ kind: "ok", has: false })
  })

  test("failed retryable and nonretryable both fallback with no terminal", async () => {
    for (const [code, retryable] of [
      ["validation.failed", false],
      ["scope_mismatch", false],
      ["internal", false],
      ["InstanceUnavailableDuringConfigRebuild", true],
    ] as Array<[string, boolean]>) {
      const r = req()
      const out = await attemptSessionExistencePrivate(connFor((q) => failedFor(q, code, retryable)) as never, r)
      expect(out.kind).toBe("fallback")
    }
  })

  test("unavailable/invalid/ambiguous/transport/closed/timeout are fallback", async () => {
    const r1 = req()
    const unavailable = {
      isPrivateAvailable: () => false,
      privateSessionListOutcomeWithHandle: () => {
        throw new Error("must not be called")
      },
    }
    expect((await attemptSessionExistencePrivate(unavailable as never, r1)).kind).toBe("fallback")

    const r2 = req()
    expect((await attemptSessionExistencePrivate(connFor((q) => ambiguousFor(q)) as never, r2)).kind).toBe("fallback")

    const r3 = req()
    const invalid = {
      isPrivateAvailable: () => true,
      privateSessionListOutcomeWithHandle: () => ({
        id: 3,
        promise: Promise.resolve({ kind: "invalid", detail: "bad" }),
        cancel: () => true,
      }),
    }
    expect((await attemptSessionExistencePrivate(invalid as never, r3)).kind).toBe("fallback")

    const r4 = req()
    const transport = {
      isPrivateAvailable: () => true,
      privateSessionListOutcomeWithHandle: () => ({
        id: 4,
        promise: Promise.reject(new Error("Private peer unavailable")),
        cancel: () => true,
      }),
    }
    expect((await attemptSessionExistencePrivate(transport as never, r4)).kind).toBe("fallback")

    const r5 = req()
    const closed = {
      isPrivateAvailable: () => true,
      privateSessionListOutcomeWithHandle: () => ({
        id: 5,
        promise: Promise.reject(new Error("peer closed")),
        cancel: () => true,
      }),
    }
    expect((await attemptSessionExistencePrivate(closed as never, r5)).kind).toBe("fallback")

    const r6 = req()
    const hanging = {
      isPrivateAvailable: () => true,
      privateSessionListOutcomeWithHandle: () => ({
        id: 6,
        promise: new Promise(() => {}),
        cancel: () => true,
      }),
    }
    expect((await attemptSessionExistencePrivate(hanging as never, r6, 10)).kind).toBe("fallback")

    const r7 = req()
    const synth = connFor((q) => ({
      v: 2,
      requestId: q.requestId,
      opId: q.opId,
      op: "experimental/session/list",
      idempotencyKey: q.idempotencyKey,
      status: "failed",
      outcome: {
        type: "failed",
        time: 1,
        failure: { code: "-32603", message: SESSION_LIST_TRANSPORT_FAILURE_MESSAGE, retryable: false },
      },
      accepted: false,
      failure: { code: "-32603", message: SESSION_LIST_TRANSPORT_FAILURE_MESSAGE, retryable: false },
    }))
    expect((await attemptSessionExistencePrivate(synth as never, r7)).kind).toBe("fallback")
  })

  test("timeout exact-cancels the pending by id with opId", async () => {
    const r = req()
    const seen: unknown[] = []
    const hanging = {
      isPrivateAvailable: () => true,
      privateSessionListOutcomeWithHandle: () => ({
        id: 42,
        promise: new Promise(() => {}),
        cancel: (msg?: string) => {
          seen.push(msg)
          return true
        },
      }),
    }
    const out = await attemptSessionExistencePrivate(hanging as never, r, 10)
    expect(out).toEqual({ kind: "fallback", reason: "timeout" })
    expect(seen.length).toBe(1)
    expect(String(seen[0]).includes(r.opId)).toBeTrue()
  })

  test("private success returns zero SDK and zero client acquisition", async () => {
    for (const [sessions, has] of [
      [[sum("ses1")], true],
      [[], false],
    ] as Array<[unknown[], boolean]>) {
      const got = { client: 0, sdk: 0, args: [] as unknown[] }
      const conn = fullFor((q) => okFor(q, sessions), { data: [{ id: "ses9" }] }, got)
      const out = await hasAnySession(conn as never, "/tmp/exist")
      expect(out).toBe(has)
      expect(got.client).toBe(0)
      expect(got.sdk).toBe(0)
    }
  })

  test("each fallback class takes exactly one same-directory SDK fallback", async () => {
    const cases: Array<{ label: string; make: (got: { client: number; sdk: number; args: unknown[] }) => unknown }> = [
      { label: "failed", make: (got) => fullFor((q) => failedFor(q), { data: [] }, got) },
      { label: "retryable", make: (got) => fullFor((q) => retryableFor(q), { data: [sum("ses1")] }, got) },
      {
        label: "ambiguous",
        make: (got) => fullFor((q) => ambiguousFor(q), { data: [] }, got),
      },
      {
        label: "unavailable",
        make: (got) => ({
          isPrivateAvailable: () => false,
          privateSessionListOutcomeWithHandle: () => {
            throw new Error("must not be called")
          },
          getClientAsync: async (d: string) => {
            got.client += 1
            expect(d).toBe("/tmp/exist")
            return {
              experimental: {
                session: {
                  list: async (a: unknown, o: unknown) => {
                    got.sdk += 1
                    got.args.push([a, o])
                    return { data: [] }
                  },
                },
              },
            }
          },
        }),
      },
      {
        label: "invalid",
        make: (got) => ({
          isPrivateAvailable: () => true,
          privateSessionListOutcomeWithHandle: () => ({
            id: 1,
            promise: Promise.resolve({ kind: "invalid", detail: "bad" }),
            cancel: () => true,
          }),
          getClientAsync: async (d: string) => {
            got.client += 1
            expect(d).toBe("/tmp/exist")
            return {
              experimental: {
                session: {
                  list: async (a: unknown, o: unknown) => {
                    got.sdk += 1
                    got.args.push([a, o])
                    return { data: [sum("ses1")] }
                  },
                },
              },
            }
          },
        }),
      },
      {
        label: "transport",
        make: (got) => ({
          isPrivateAvailable: () => true,
          privateSessionListOutcomeWithHandle: () => ({
            id: 1,
            promise: Promise.reject(new Error("Private peer unavailable")),
            cancel: () => true,
          }),
          getClientAsync: async (d: string) => {
            got.client += 1
            expect(d).toBe("/tmp/exist")
            return {
              experimental: {
                session: {
                  list: async (a: unknown, o: unknown) => {
                    got.sdk += 1
                    got.args.push([a, o])
                    return { data: [] }
                  },
                },
              },
            }
          },
        }),
      },
      {
        label: "closed",
        make: (got) => ({
          isPrivateAvailable: () => true,
          privateSessionListOutcomeWithHandle: () => ({
            id: 1,
            promise: Promise.reject(new Error("peer closed")),
            cancel: () => true,
          }),
          getClientAsync: async (d: string) => {
            got.client += 1
            expect(d).toBe("/tmp/exist")
            return {
              experimental: {
                session: {
                  list: async (a: unknown, o: unknown) => {
                    got.sdk += 1
                    got.args.push([a, o])
                    return { data: [] }
                  },
                },
              },
            }
          },
        }),
      },
      {
        label: "timeout",
        make: (got) => ({
          isPrivateAvailable: () => true,
          privateSessionListOutcomeWithHandle: () => ({
            id: 1,
            promise: new Promise(() => {}),
            cancel: () => true,
          }),
          getClientAsync: async (d: string) => {
            got.client += 1
            expect(d).toBe("/tmp/exist")
            return {
              experimental: {
                session: {
                  list: async (a: unknown, o: unknown) => {
                    got.sdk += 1
                    got.args.push([a, o])
                    return { data: [] }
                  },
                },
              },
            }
          },
        }),
      },
    ]
    for (const c of cases) {
      const got = { client: 0, sdk: 0, args: [] as unknown[] }
      const conn = c.make(got)
      await hasAnySession(conn as never, "/tmp/exist")
      expect(got.client).toBe(1)
      expect(got.sdk).toBe(1)
      expect(got.args.length).toBe(1)
      expect(got.args[0]).toEqual([{ directory: "/tmp/exist", limit: 1, archived: true }, { throwOnError: true }])
    }
  })

  test("directory-scoped existence: empty current-directory page is false", async () => {
    // Server filters by the `directory` query arg, so an empty page means
    // zero sessions in the current directory even if other directories hold
    // sessions. The helper trusts that server scoping via the exact
    // `{directory, limit:1, archived:true}` tuple and never re-filters
    // client-side (no backend logic duplication); cardinality is `data.length > 0`.
    const got = { client: 0, sdk: 0, args: [] as unknown[] }
    const conn = {
      isPrivateAvailable: () => false,
      privateSessionListOutcomeWithHandle: () => {
        throw new Error("must not be called")
      },
      getClientAsync: async (d: string) => {
        got.client += 1
        expect(d).toBe("/tmp/exist")
        return {
          experimental: {
            session: {
              list: async (a: unknown, o: unknown) => {
                got.sdk += 1
                got.args.push([a, o])
                return { data: [] }
              },
            },
          },
        }
      },
    }
    const out = await hasAnySession(conn as never, "/tmp/exist")
    expect(out).toBeFalse()
    expect(got.client).toBe(1)
    expect(got.sdk).toBe(1)
    expect(got.args[0]).toEqual([{ directory: "/tmp/exist", limit: 1, archived: true }, { throwOnError: true }])
  })

  test("SDK failure propagates so caller posts skipped without persistence", async () => {
    const got = { client: 0, sdk: 0, args: [] as unknown[] }
    const boom = new Error("transient boom")
    const conn = fullFor((q) => failedFor(q), { throws: boom }, got)
    let err: unknown = null
    try {
      await hasAnySession(conn as never, "/tmp/exist")
    } catch (e) {
      err = e
    }
    expect(err).toBe(boom)
    expect(got.client).toBe(1)
    expect(got.sdk).toBe(1)
  })
})
