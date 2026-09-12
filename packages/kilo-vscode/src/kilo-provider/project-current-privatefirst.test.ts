import { describe, expect, test } from "bun:test"
import {
  attemptProjectCurrentPrivate,
  buildProjectCurrentIdentity,
  buildProjectCurrentReq,
  fetchHasGitPrivateFirst,
  parseProjectCurrentResult,
} from "./project-current-privatefirst"
import { canonicalProjectCurrentOpId } from "../services/cli-backend/serve-private-project-current-contract"
import { hasGit, setProjectCurrentPrivateConnection } from "./git-status"

const DIR = "/tmp"

function okFor(r: ReturnType<typeof buildProjectCurrentReq>, data: unknown = {}) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "project/current",
    idempotencyKey: r.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data,
  }
}

function failedFor(r: ReturnType<typeof buildProjectCurrentReq>, code: string) {
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
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "project/current",
    idempotencyKey: r.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure: { code, message: entry.message, retryable: entry.retryable } },
    accepted: false,
    failure: { code, message: entry.message, retryable: entry.retryable },
  }
}

function ambiguousFor(r: ReturnType<typeof buildProjectCurrentReq>) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "project/current",
    idempotencyKey: r.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: 1 },
    accepted: false,
    transportUnknown: true,
  }
}

function connWith(build: (r: ReturnType<typeof buildProjectCurrentReq>) => unknown, seen?: unknown[]) {
  return {
    isPrivateAvailable: () => true,
    privateProjectCurrentOutcomeWithHandle: (q: ReturnType<typeof buildProjectCurrentReq>) => {
      seen?.push(q)
      return {
        id: 1,
        promise: Promise.resolve({ kind: "valid", result: build(q) }),
        cancel: () => true,
      }
    },
  }
}

describe("project-current private-first (hasGit narrow projection)", () => {
  test("identity binds canonical project-current tuple", () => {
    const { opId, idempotencyKey, requestId } = buildProjectCurrentIdentity()
    expect(opId).toBe(idempotencyKey)
    expect(opId.startsWith("project-current:")).toBeTrue()
    const token = opId.split(":")[1]!
    expect(canonicalProjectCurrentOpId(token)).toBe(opId)
    expect(typeof requestId).toBe("string")
  })

  test("succeeded accepted maps to the derived hasGit boolean", () => {
    const git = buildProjectCurrentReq(DIR)
    expect(parseProjectCurrentResult(okFor(git, { vcs: "git" }), git)).toEqual({ kind: "ok", hasGit: true })
    const nogit = buildProjectCurrentReq(DIR)
    expect(parseProjectCurrentResult(okFor(nogit, {}), nogit)).toEqual({ kind: "ok", hasGit: false })
  })

  test("routing identity is directory-only; payload never binds directory", () => {
    const r = buildProjectCurrentReq(DIR)
    expect(r.context.directory).toBe(DIR)
    expect(r.payload).toEqual({})
  })

  test("terminal failed closes with zero SDK", async () => {
    for (const code of ["validation.failed", "internal"]) {
      let sdk = 0
      const client = {
        project: {
          current: () => {
            sdk += 1
            return Promise.resolve({ data: { vcs: "git" } })
          },
        },
      }
      const out = await fetchHasGitPrivateFirst({
        connection: connWith((q) => failedFor(q, code)) as never,
        client: client as never,
        directory: DIR,
      })
      expect(out).toBeFalse()
      expect(sdk).toBe(0)
    }
  })

  test("private git success returns true with zero SDK", async () => {
    let sdk = 0
    const client = {
      project: {
        current: () => {
          sdk += 1
          return Promise.resolve({ data: {} })
        },
      },
    }
    const out = await fetchHasGitPrivateFirst({
      connection: connWith((q) => okFor(q, { vcs: "git" })) as never,
      client: client as never,
      directory: DIR,
    })
    expect(out).toBeTrue()
    expect(sdk).toBe(0)
  })

  test("private non-git success returns false with zero SDK", async () => {
    let sdk = 0
    const client = {
      project: {
        current: () => {
          sdk += 1
          return Promise.resolve({ data: { vcs: "git" } })
        },
      },
    }
    const out = await fetchHasGitPrivateFirst({
      connection: connWith((q) => okFor(q, {})) as never,
      client: client as never,
      directory: DIR,
    })
    expect(out).toBeFalse()
    expect(sdk).toBe(0)
  })

  test("retryable fence falls back exactly once with the same directory", async () => {
    const sdkSeen: unknown[] = []
    const privSeen: unknown[] = []
    const client = {
      project: {
        current: (args: unknown) => {
          sdkSeen.push(args)
          return Promise.resolve({ data: { vcs: "git" } })
        },
      },
    }
    const out = await fetchHasGitPrivateFirst({
      connection: connWith((q) => failedFor(q, "InstanceUnavailableDuringConfigRebuild"), privSeen) as never,
      client: client as never,
      directory: DIR,
    })
    expect(out).toBeTrue()
    expect(sdkSeen).toEqual([{ directory: DIR }])
    expect((privSeen[0] as { context: { directory: string } }).context.directory).toBe(DIR)
  })

  test("transport failure falls back exactly once with the same directory", async () => {
    const sdkSeen: unknown[] = []
    const client = {
      project: {
        current: (args: unknown) => {
          sdkSeen.push(args)
          return Promise.resolve({ data: {} })
        },
      },
    }
    const out = await fetchHasGitPrivateFirst({
      connection: connWith((q) => failedFor(q, "transport")) as never,
      client: client as never,
      directory: DIR,
    })
    expect(out).toBeFalse()
    expect(sdkSeen).toEqual([{ directory: DIR }])
  })

  test("unavailable/invalid/ambiguous/closed/timeout each fall back exactly once", async () => {
    const cases: Array<{ name: string; conn: unknown }> = [
      { name: "unavailable", conn: { isPrivateAvailable: () => false } },
      {
        name: "invalid",
        conn: {
          isPrivateAvailable: () => true,
          privateProjectCurrentOutcomeWithHandle: () => ({
            id: 3,
            promise: Promise.resolve({ kind: "invalid", detail: "bad" }),
            cancel: () => true,
          }),
        },
      },
      {
        name: "ambiguous",
        conn: connWith((q) => ambiguousFor(q)),
      },
      {
        name: "closed",
        conn: {
          isPrivateAvailable: () => true,
          privateProjectCurrentOutcomeWithHandle: () => ({
            id: 4,
            promise: Promise.reject(new Error("Private peer unavailable")),
            cancel: () => true,
          }),
        },
      },
      {
        name: "timeout",
        conn: {
          isPrivateAvailable: () => true,
          privateProjectCurrentOutcomeWithHandle: () => ({
            id: 5,
            promise: new Promise(() => {}),
            cancel: () => true,
          }),
        },
      },
    ]
    for (const c of cases) {
      let sdk = 0
      const client = {
        project: {
          current: () => {
            sdk += 1
            return Promise.resolve({ data: { vcs: "git" } })
          },
        },
      }
      const out = await fetchHasGitPrivateFirst({
        connection: c.conn as never,
        client: client as never,
        directory: DIR,
      })
      expect(out).toBeTrue()
      expect(sdk).toBe(1)
    }
  })

  test("fallback uses the same directory for private and SDK", async () => {
    const sdkSeen: unknown[] = []
    const privSeen: unknown[] = []
    const client = {
      project: {
        current: (args: unknown) => {
          sdkSeen.push(args)
          return Promise.resolve({ data: {} })
        },
      },
    }
    const out = await fetchHasGitPrivateFirst({
      connection: connWith((q) => ambiguousFor(q), privSeen) as never,
      client: client as never,
      directory: DIR,
    })
    expect(out).toBeFalse()
    expect(sdkSeen).toEqual([{ directory: DIR }])
    expect((privSeen[0] as { context: { directory: string } }).context.directory).toBe(DIR)
  })

  test("timeout exact-cancels the pending", async () => {
    const r = buildProjectCurrentReq(DIR)
    let cancelled: string | undefined
    let cancelledId = 0
    const out = await attemptProjectCurrentPrivate(
      {
        isPrivateAvailable: () => true,
        privateProjectCurrentOutcomeWithHandle: () => ({
          id: 7,
          promise: new Promise(() => {}),
          cancel: (msg?: string) => {
            cancelled = msg
            cancelledId = 7
            return true
          },
        }),
      } as never,
      r,
      10,
    )
    expect(out).toEqual({ kind: "fallback", reason: "timeout" })
    expect(cancelled).toContain(r.opId)
    expect(cancelledId).toBe(7)
  })

  test("SDK error and malformed SDK data return false", async () => {
    const failing = { project: { current: () => Promise.reject(new Error("down")) } }
    expect(
      await fetchHasGitPrivateFirst({
        connection: { isPrivateAvailable: () => false } as never,
        client: failing as never,
        directory: DIR,
      }),
    ).toBeFalse()
    for (const data of [{ vcs: "hg" }, [], undefined, { vcs: 42 }]) {
      const malformed = { project: { current: () => Promise.resolve({ data }) } }
      expect(
        await fetchHasGitPrivateFirst({
          connection: { isPrivateAvailable: () => false } as never,
          client: malformed as never,
          directory: DIR,
        }),
      ).toBeFalse()
    }
  })

  test("hasGit without SDK read on private success and exactly one SDK read on fallback (no double read)", async () => {
    let priv = 0
    let sdk = 0
    const out = await fetchHasGitPrivateFirst({
      connection: {
        isPrivateAvailable: () => true,
        privateProjectCurrentOutcomeWithHandle: () => {
          priv += 1
          return {
            id: 1,
            promise: Promise.resolve({ kind: "invalid", detail: "bad" }),
            cancel: () => true,
          }
        },
      } as never,
      client: {
        project: {
          current: () => {
            sdk += 1
            return Promise.resolve({ data: { vcs: "git" } })
          },
        },
      } as never,
      directory: DIR,
    })
    expect(priv).toBe(1)
    expect(sdk).toBe(1)
    expect(out).toBeTrue()
  })

  test("hasGit observes through the private-first boundary and detaches on null", async () => {
    let priv = 0
    let sdk = 0
    const conn = {
      isPrivateAvailable: () => true,
      privateProjectCurrentOutcomeWithHandle: (q: ReturnType<typeof buildProjectCurrentReq>) => {
        priv += 1
        return {
          id: 1,
          promise: Promise.resolve({ kind: "valid", result: okFor(q, { vcs: "git" }) }),
          cancel: () => true,
        }
      },
    }
    setProjectCurrentPrivateConnection(conn as never)
    try {
      const client = {
        project: {
          current: () => {
            sdk += 1
            return Promise.resolve({ data: {} })
          },
        },
      }
      expect(await hasGit(client as never, DIR)).toBeTrue()
      expect(priv).toBe(1)
      expect(sdk).toBe(0)
    } finally {
      setProjectCurrentPrivateConnection(null)
    }
    const bare = { project: { current: async () => ({ data: { vcs: "git" } }) } }
    expect(await hasGit(bare as never, DIR)).toBeTrue()
    const failing = {
      project: {
        current: async () => {
          throw new Error("boom")
        },
      },
    }
    expect(await hasGit(failing as never, DIR)).toBeFalse()
  })
})
