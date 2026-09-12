import { describe, expect, test } from "bun:test"
import {
  attemptFindFilesPrivate,
  buildFindFilesIdentity,
  buildFindFilesReq,
  compareFindFilesTypeParity,
  digestFindFilesSet,
  fetchFindFilesTypePrivateFirst,
  isFindFilesPrivateRequestValid,
  parseFindFilesResult,
} from "./find-files-privatefirst"
import { canonicalFindFilesOpId } from "../services/cli-backend/serve-private-find-files-contract"
import { requestFindFilesOutcome } from "../services/cli-backend/serve-private-find-files"

const DIR = "/tmp"
const QUERY = "hello"

function okFor(r: ReturnType<typeof buildFindFilesReq>, files: unknown[] = []) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "find/files",
    idempotencyKey: r.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { files },
  }
}

function entry(path = "src/a.ts", type: "file" | "directory" = "file") {
  return { path, type }
}

function terminalFor(r: ReturnType<typeof buildFindFilesReq>, code = "validation.failed") {
  const fixed: Record<string, { message: string; retryable: boolean }> = {
    "validation.failed": { message: "invalid find-files request", retryable: false },
    internal: { message: "internal error", retryable: false },
    scope_mismatch: { message: "scope mismatch", retryable: false },
    transport: { message: "private find failed", retryable: false },
  }
  const item = fixed[code] ?? fixed["validation.failed"]!
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "find/files",
    idempotencyKey: r.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure: { code, message: item.message, retryable: item.retryable } },
    accepted: false,
    failure: { code, message: item.message, retryable: item.retryable },
  }
}

function retryableFor(r: ReturnType<typeof buildFindFilesReq>) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "find/files",
    idempotencyKey: r.idempotencyKey,
    status: "failed",
    outcome: {
      type: "failed",
      time: 1,
      failure: {
        code: "InstanceUnavailableDuringConfigRebuild",
        message: "Instance is unavailable during config rebuild; no active runtime for this request",
        retryable: true,
      },
    },
    accepted: false,
    failure: {
      code: "InstanceUnavailableDuringConfigRebuild",
      message: "Instance is unavailable during config rebuild; no active runtime for this request",
      retryable: true,
    },
  }
}

function ambiguousFor(r: ReturnType<typeof buildFindFilesReq>) {
  return {
    v: 1,
    requestId: r.requestId,
    opId: r.opId,
    op: "find/files",
    idempotencyKey: r.idempotencyKey,
    status: "ambiguous",
    outcome: { type: "ambiguous", time: 1 },
    accepted: false,
    transportUnknown: true,
  }
}

function connWith(build: (r: ReturnType<typeof buildFindFilesReq>) => unknown, seen?: unknown[]) {
  return {
    isPrivateAvailable: () => true,
    privateFindFilesOutcomeWithHandle: (q: ReturnType<typeof buildFindFilesReq>) => {
      seen?.push(q)
      return {
        id: 1,
        promise: Promise.resolve({ kind: "valid", result: build(q) }),
        cancel: () => true,
      }
    },
  }
}

describe("find-files private-first", () => {
  test("identity binds canonical find-files tuple", () => {
    const { opId, idempotencyKey, requestId } = buildFindFilesIdentity()
    expect(opId).toBe(idempotencyKey)
    expect(opId.startsWith("find-files:")).toBeTrue()
    const token = opId.split(":")[1]!
    expect(canonicalFindFilesOpId(token)).toBe(opId)
    expect(typeof requestId).toBe("string")
  })

  test("request binds directory/query/type/limit", () => {
    const r = buildFindFilesReq(DIR, QUERY, "file", 50)
    expect(r.context.directory).toBe(DIR)
    expect(r.payload).toEqual({ query: QUERY, type: "file", limit: 50 })
    const d = buildFindFilesReq(DIR, QUERY, "directory", 50)
    expect(d.payload.type).toBe("directory")
    expect(d.opId).not.toBe(r.opId)
  })

  test("file and directory success return projected paths", () => {
    const rf = buildFindFilesReq(DIR, QUERY, "file", 50)
    const parsedF = parseFindFilesResult(okFor(rf, [entry("src/a.ts", "file")]), rf)
    expect(parsedF).toEqual({ kind: "ok", files: [entry("src/a.ts", "file")] })
    const rd = buildFindFilesReq(DIR, QUERY, "directory", 50)
    const parsedD = parseFindFilesResult(okFor(rd, [entry("docs", "directory")]), rd)
    expect(parsedD).toEqual({ kind: "ok", files: [entry("docs", "directory")] })
  })

  test("empty success is authoritative", () => {
    const r = buildFindFilesReq(DIR, QUERY, "file", 50)
    expect(parseFindFilesResult(okFor(r, []), r)).toEqual({ kind: "ok", files: [] })
  })

  test("terminal failed closes without SDK", async () => {
    for (const code of ["validation.failed", "internal", "scope_mismatch"]) {
      const r = buildFindFilesReq(DIR, QUERY, "file", 50)
      const out = await attemptFindFilesPrivate(connWith((q) => terminalFor(q, code)) as never, r)
      expect(out.kind).toBe("terminal")
      if (out.kind === "terminal") expect(out.code).toBe(code)
    }
  })

  test("transport failure code falls back", async () => {
    const r = buildFindFilesReq(DIR, QUERY, "file", 50)
    const out = await attemptFindFilesPrivate(connWith((q) => terminalFor(q, "transport") as never) as never, r)
    expect(out.kind).toBe("fallback")
  })

  test("retryable fence falls back", async () => {
    const r = buildFindFilesReq(DIR, QUERY, "file", 50)
    const out = await attemptFindFilesPrivate(connWith((q) => retryableFor(q)) as never, r)
    expect(out.kind).toBe("fallback")
  })

  test("unavailable/ambiguous/invalid/transport/closed/timeout are fallback-eligible", async () => {
    const bad = buildFindFilesReq(DIR, QUERY, "file", 50)
    const off = await attemptFindFilesPrivate({ isPrivateAvailable: () => false } as never, bad)
    expect(off.kind).toBe("fallback")

    const r2 = buildFindFilesReq(DIR, QUERY, "file", 50)
    const vague = await attemptFindFilesPrivate(connWith((q) => ambiguousFor(q)) as never, r2)
    expect(vague.kind).toBe("fallback")

    const r3 = buildFindFilesReq(DIR, QUERY, "file", 50)
    const invalid = await attemptFindFilesPrivate(
      {
        isPrivateAvailable: () => true,
        privateFindFilesOutcomeWithHandle: () => ({
          id: 3,
          promise: Promise.resolve({ kind: "invalid", detail: "bad" }),
          cancel: () => true,
        }),
      } as never,
      r3,
    )
    expect(invalid.kind).toBe("fallback")

    const r4 = buildFindFilesReq(DIR, QUERY, "file", 50)
    const broken = await attemptFindFilesPrivate(
      {
        isPrivateAvailable: () => true,
        privateFindFilesOutcomeWithHandle: () => ({
          id: 4,
          promise: Promise.reject(new Error("Private peer unavailable")),
          cancel: () => true,
        }),
      } as never,
      r4,
    )
    expect(broken.kind).toBe("fallback")

    const r5 = buildFindFilesReq(DIR, QUERY, "file", 50)
    const closed = await attemptFindFilesPrivate(
      {
        isPrivateAvailable: () => true,
        privateFindFilesOutcomeWithHandle: () => ({
          id: 5,
          promise: Promise.reject(new Error("Peer closed")),
          cancel: () => true,
        }),
      } as never,
      r5,
    )
    expect(closed.kind).toBe("fallback")

    const r6 = buildFindFilesReq(DIR, QUERY, "file", 50)
    const slow = await attemptFindFilesPrivate(
      {
        isPrivateAvailable: () => true,
        privateFindFilesOutcomeWithHandle: () => ({
          id: 6,
          promise: new Promise(() => {}),
          cancel: () => true,
        }),
      } as never,
      r6,
      10,
    )
    expect(slow).toEqual({ kind: "fallback", reason: "timeout" })
  })

  test("epoch-drift ambiguous falls back", async () => {
    const r = buildFindFilesReq(DIR, QUERY, "directory", 50)
    const out = await attemptFindFilesPrivate(connWith((q) => ambiguousFor(q)) as never, r)
    expect(out.kind).toBe("fallback")
  })

  test("timeout exact-cancels the pending with the op identity", async () => {
    const r = buildFindFilesReq(DIR, QUERY, "file", 50)
    let cancelled: string | undefined
    let cancelledId = 0
    const out = await attemptFindFilesPrivate(
      {
        isPrivateAvailable: () => true,
        privateFindFilesOutcomeWithHandle: () => ({
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

  test("stale cancel is contained as timeout fallback", async () => {
    const r = buildFindFilesReq(DIR, QUERY, "file", 50)
    const out = await attemptFindFilesPrivate(
      {
        isPrivateAvailable: () => true,
        privateFindFilesOutcomeWithHandle: () => ({
          id: 9,
          promise: new Promise(() => {}),
          cancel: () => "stale" as const,
        }),
      } as never,
      r,
      10,
    )
    expect(out).toEqual({ kind: "fallback", reason: "timeout" })
  })

  test("fetch returns private file result with zero SDK calls", async () => {
    let sdk = 0
    const client = {
      find: {
        files: () => {
          sdk += 1
          return Promise.resolve({ data: [] })
        },
      },
    }
    const out = await fetchFindFilesTypePrivateFirst({
      connection: connWith((q) => okFor(q, [entry("src/a.ts", "file")])) as never,
      client: client as never,
      directory: DIR,
      query: QUERY,
      type: "file",
      limit: 50,
    })
    expect(sdk).toBe(0)
    expect(out).toEqual({ kind: "ok", via: "private", files: ["src/a.ts"] })
  })

  test("fetch returns private directory result with zero SDK calls", async () => {
    let sdk = 0
    const client = {
      find: {
        files: () => {
          sdk += 1
          return Promise.resolve({ data: [] })
        },
      },
    }
    const out = await fetchFindFilesTypePrivateFirst({
      connection: connWith((q) => okFor(q, [entry("docs", "directory")])) as never,
      client: client as never,
      directory: DIR,
      query: QUERY,
      type: "directory",
      limit: 50,
    })
    expect(sdk).toBe(0)
    expect(out).toEqual({ kind: "ok", via: "private", files: ["docs"] })
  })

  test("fetch returns private empty with zero SDK calls", async () => {
    let sdk = 0
    const client = {
      find: {
        files: () => {
          sdk += 1
          return Promise.resolve({ data: ["other.ts"] })
        },
      },
    }
    const out = await fetchFindFilesTypePrivateFirst({
      connection: connWith((q) => okFor(q, [])) as never,
      client: client as never,
      directory: DIR,
      query: QUERY,
      type: "file",
      limit: 50,
    })
    expect(sdk).toBe(0)
    expect(out).toEqual({ kind: "ok", via: "private", files: [] })
  })

  test("fetch exposes terminal with zero SDK calls", async () => {
    let sdk = 0
    const client = {
      find: {
        files: () => {
          sdk += 1
          return Promise.resolve({ data: [] })
        },
      },
    }
    const out = await fetchFindFilesTypePrivateFirst({
      connection: connWith((q) => terminalFor(q)) as never,
      client: client as never,
      directory: DIR,
      query: QUERY,
      type: "file",
      limit: 50,
    })
    expect(sdk).toBe(0)
    expect(out.kind).toBe("terminal")
  })

  test("fetch falls back exactly once with the same tuple", async () => {
    const seen: Array<{ query: string; directory: string; type: string; limit: number }> = []
    const privSeen: unknown[] = []
    const client = {
      find: {
        files: (args: { query: string; directory: string; type: string; limit: number }) => {
          seen.push(args)
          return Promise.resolve({ data: args.type === "file" ? ["src/a.ts"] : ["docs"] })
        },
      },
    }
    const out = await fetchFindFilesTypePrivateFirst({
      connection: connWith((q) => ambiguousFor(q), privSeen) as never,
      client: client as never,
      directory: DIR,
      query: QUERY,
      type: "file",
      limit: 50,
    })
    expect(seen).toEqual([{ query: QUERY, directory: DIR, type: "file", limit: 50 }])
    const priv = privSeen[0] as { context: { directory: string }; payload: { query: string; type: string; limit: number } }
    expect(priv.context.directory).toBe(DIR)
    expect(priv.payload).toEqual({ query: QUERY, type: "file", limit: 50 })
    expect(out).toEqual({ kind: "ok", via: "sdk", files: ["src/a.ts"] })
  })

  test("fetch treats SDK failure and malformed SDK data as unavailable", async () => {
    const failing = { find: { files: () => Promise.reject(new Error("down")) } }
    const lost = await fetchFindFilesTypePrivateFirst({
      connection: { isPrivateAvailable: () => false } as never,
      client: failing as never,
      directory: DIR,
      query: QUERY,
      type: "file",
      limit: 50,
    })
    expect(lost.kind).toBe("unavailable")

    const malformed = { find: { files: () => Promise.resolve({ data: { path: "x" } }) } }
    const bad = await fetchFindFilesTypePrivateFirst({
      connection: { isPrivateAvailable: () => false } as never,
      client: malformed as never,
      directory: DIR,
      query: QUERY,
      type: "directory",
      limit: 50,
    })
    expect(bad.kind).toBe("unavailable")
  })

  test("read never retries: one private attempt plus at most one SDK", async () => {
    let priv = 0
    let sdk = 0
    const out = await fetchFindFilesTypePrivateFirst({
      connection: {
        isPrivateAvailable: () => true,
        privateFindFilesOutcomeWithHandle: () => {
          priv += 1
          return {
            id: 1,
            promise: Promise.resolve({ kind: "invalid", detail: "bad" }),
            cancel: () => true,
          }
        },
      } as never,
      client: {
        find: {
          files: () => {
            sdk += 1
            return Promise.resolve({ data: [] })
          },
        },
      } as never,
      directory: DIR,
      query: QUERY,
      type: "file",
      limit: 50,
    })
    expect(priv).toBe(1)
    expect(sdk).toBe(1)
    expect(out).toEqual({ kind: "ok", via: "sdk", files: [] })
  })

  test("request validity gates query/dir/limit only", () => {
    expect(isFindFilesPrivateRequestValid(QUERY, DIR, 50)).toBeTrue()
    expect(isFindFilesPrivateRequestValid("", DIR, 50)).toBeFalse()
    expect(isFindFilesPrivateRequestValid(QUERY, "relative", 50)).toBeFalse()
    expect(isFindFilesPrivateRequestValid(QUERY, DIR, 51)).toBeFalse()
    expect(isFindFilesPrivateRequestValid(QUERY, DIR, 0)).toBeFalse()
  })

  test("invalid request shape skips private and uses one SDK call", async () => {
    let priv = 0
    let sdk = 0
    const out = await fetchFindFilesTypePrivateFirst({
      connection: {
        isPrivateAvailable: () => {
          priv += 1
          return true
        },
        privateFindFilesOutcomeWithHandle: () => {
          priv += 10
          return { id: 1, promise: Promise.resolve({ kind: "invalid", detail: "x" }), cancel: () => true }
        },
      } as never,
      client: {
        find: {
          files: () => {
            sdk += 1
            return Promise.resolve({ data: [] })
          },
        },
      } as never,
      directory: DIR,
      query: "",
      type: "file",
      limit: 50,
    })
    expect(priv).toBe(0)
    expect(sdk).toBe(1)
    expect(out).toEqual({ kind: "ok", via: "sdk", files: [] })
  })

  test("non-closed inner rawPromise rejection falls back via exactly one same-tuple SDK", async () => {
    const privSeen: Array<{ directory: string; query: string; type: string; limit: number }> = []
    const connection = {
      isPrivateAvailable: () => true,
      privateFindFilesOutcomeWithHandle: (req: ReturnType<typeof buildFindFilesReq>) => {
        const inner = (req as { context: { directory: string }; payload: { query: string; type: string; limit: number } })
        privSeen.push({
          directory: inner.context.directory,
          query: inner.payload.query,
          type: inner.payload.type,
          limit: inner.payload.limit,
        })
        const raw = {
          requestWithId: () => ({ id: 41, promise: Promise.reject(new Error("inner transport boom")) }),
        }
        const host = {
          isStale: () => false,
          isClosed: () => false,
          failInfo: () => ({ code: "-32603", msg: "inner transport boom" }),
        }
        const handle = requestFindFilesOutcome(raw as never, host, () => () => true, req as never)
        return { id: handle.id, promise: handle.promise, cancel: () => true as const }
      },
    }
    const sdkSeen: Array<{ query: string; directory: string; type: string; limit: number }> = []
    const client = {
      find: {
        files: (args: { query: string; directory: string; type: string; limit: number }) => {
          sdkSeen.push(args)
          return Promise.resolve({ data: ["src/a.ts"] })
        },
      },
    }
    const out = await fetchFindFilesTypePrivateFirst({
      connection: connection as never,
      client: client as never,
      directory: DIR,
      query: QUERY,
      type: "file",
      limit: 50,
    })
    expect(privSeen).toEqual([{ directory: DIR, query: QUERY, type: "file", limit: 50 }])
    expect(sdkSeen).toEqual([{ query: QUERY, directory: DIR, type: "file", limit: 50 }])
    expect(out).toEqual({ kind: "ok", via: "sdk", files: ["src/a.ts"] })
  })

  test("comparator stays pure diagnostic: membership ignores order per type", () => {
    const sdk = ["b.ts", "a.ts", "a.ts"]
    const priv = [
      { path: "a.ts", type: "file" as const },
      { path: "b.ts", type: "file" as const },
      { path: "c", type: "directory" as const },
    ]
    const file = compareFindFilesTypeParity(sdk, priv, "file")
    expect(file.match).toBeTrue()
    expect(file.sdkCount).toBe(2)
    expect(file.privateCount).toBe(2)
    const dir = compareFindFilesTypeParity([], priv, "directory")
    expect(dir.match).toBeFalse()
    expect(dir.extraCount).toBe(1)
    const a = digestFindFilesSet(["b.ts", "a.ts"], "file")
    const b = digestFindFilesSet(["a.ts", "b.ts"], "file")
    expect(a).toBe(b)
    expect(a).not.toContain("a.ts")
  })
})
