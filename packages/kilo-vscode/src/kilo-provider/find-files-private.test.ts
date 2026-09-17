import { describe, expect, test } from "bun:test"
import {
  attemptFindFilesPrivate,
  buildFindFilesIdentity,
  buildFindFilesReq,
  compareFindFilesTypeParity,
  digestFindFilesSet,
  fetchFindFilesTypePrivate,
  FIND_FILES_PRIVATE_LIMIT,
  FIND_FILES_PRIVATE_TIMEOUT_MS,
  isFindFilesPrivateRequestValid,
  parseFindFilesResult,
} from "./find-files-private"
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

describe("find-files private authority", () => {
  test("production timeout budget stays exact 3s", () => {
    expect(FIND_FILES_PRIVATE_TIMEOUT_MS).toBe(3000)
    expect(FIND_FILES_PRIVATE_LIMIT).toBe(50)
  })

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

  test("file and directory success return projected entries", () => {
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

  test("fetch returns private file result with zero SDK surface", async () => {
    const out = await fetchFindFilesTypePrivate({
      connection: connWith((q) => okFor(q, [entry("src/a.ts", "file")])) as never,
      directory: DIR,
      query: QUERY,
      type: "file",
      limit: 50,
    })
    expect(out).toEqual({ kind: "ok", files: ["src/a.ts"] })
  })

  test("fetch returns private directory result", async () => {
    const out = await fetchFindFilesTypePrivate({
      connection: connWith((q) => okFor(q, [entry("docs", "directory")])) as never,
      directory: DIR,
      query: QUERY,
      type: "directory",
      limit: 50,
    })
    expect(out).toEqual({ kind: "ok", files: ["docs"] })
  })

  test("fetch returns private empty as ok", async () => {
    const out = await fetchFindFilesTypePrivate({
      connection: connWith((q) => okFor(q, [])) as never,
      directory: DIR,
      query: QUERY,
      type: "file",
      limit: 50,
    })
    expect(out).toEqual({ kind: "ok", files: [] })
  })

  test("validated terminal stays terminal with zero SDK", async () => {
    for (const code of ["validation.failed", "internal", "scope_mismatch"]) {
      const r = buildFindFilesReq(DIR, QUERY, "file", 50)
      const out = await attemptFindFilesPrivate(connWith((q) => terminalFor(q, code)) as never, r)
      expect(out).toEqual({ kind: "terminal", code })
      const fetched = await fetchFindFilesTypePrivate({
        connection: connWith((q) => terminalFor(q, code)) as never,
        directory: DIR,
        query: QUERY,
        type: "file",
        limit: 50,
      })
      expect(fetched).toEqual({ kind: "terminal", code })
    }
  })

  test("retryable config fence maps to unavailable", async () => {
    const r = buildFindFilesReq(DIR, QUERY, "file", 50)
    const out = await attemptFindFilesPrivate(connWith((q) => retryableFor(q)) as never, r)
    expect(out).toEqual({ kind: "unavailable", reason: "InstanceUnavailableDuringConfigRebuild" })
    const fetched = await fetchFindFilesTypePrivate({
      connection: connWith((q) => retryableFor(q)) as never,
      directory: DIR,
      query: QUERY,
      type: "file",
      limit: 50,
    })
    expect(fetched).toEqual({ kind: "unavailable" })
  })

  test("transport failure code maps to unavailable", async () => {
    const r = buildFindFilesReq(DIR, QUERY, "file", 50)
    const out = await attemptFindFilesPrivate(connWith((q) => terminalFor(q, "transport") as never) as never, r)
    expect(out).toEqual({ kind: "unavailable", reason: "transport" })
  })

  test("unavailable with null connection and disabled peer", async () => {
    const bad = buildFindFilesReq(DIR, QUERY, "file", 50)
    expect(await attemptFindFilesPrivate(null, bad)).toEqual({ kind: "unavailable", reason: "unavailable" })
    expect(await attemptFindFilesPrivate(undefined, bad)).toEqual({ kind: "unavailable", reason: "unavailable" })
    const off = await attemptFindFilesPrivate({ isPrivateAvailable: () => false } as never, bad)
    expect(off).toEqual({ kind: "unavailable", reason: "unavailable" })
    const fetched = await fetchFindFilesTypePrivate({ connection: null, directory: DIR, query: QUERY, type: "file" })
    expect(fetched).toEqual({ kind: "unavailable" })
  })

  test("missing capability maps to unavailable", async () => {
    const r = buildFindFilesReq(DIR, QUERY, "file", 50)
    const missing = await attemptFindFilesPrivate({ isPrivateAvailable: () => true } as never, r)
    expect(missing).toEqual({ kind: "unavailable", reason: "missing-capability" })
    const capThrow = await attemptFindFilesPrivate(
      {
        isPrivateAvailable: () => true,
        privateFindFilesOutcomeWithHandle: () => {
          throw new Error("Private peer missing find/files capability")
        },
      } as never,
      r,
    )
    expect(capThrow).toEqual({ kind: "unavailable", reason: "transport" })
  })

  test("invalid wire never silently succeeds", async () => {
    const r = buildFindFilesReq(DIR, QUERY, "file", 50)
    expect(parseFindFilesResult(null, r)).toEqual({ kind: "unavailable", reason: "invalid" })
    expect(parseFindFilesResult({ status: "succeeded", accepted: true }, r)).toEqual({
      kind: "unavailable",
      reason: "invalid",
    })
    const invalid = await attemptFindFilesPrivate(
      {
        isPrivateAvailable: () => true,
        privateFindFilesOutcomeWithHandle: () => ({
          id: 3,
          promise: Promise.resolve({ kind: "invalid", detail: "bad" }),
          cancel: () => true,
        }),
      } as never,
      r,
    )
    expect(invalid).toEqual({ kind: "unavailable", reason: "invalid" })
    // Sensitive-name entry fails closed to invalid/unavailable, never returned.
    const sensitive = await attemptFindFilesPrivate(
      connWith((q) => okFor(q, [entry(".env", "file")])) as never,
      r,
    )
    expect(sensitive).toEqual({ kind: "unavailable", reason: "invalid" })
    // Over-cap private array fails closed as well.
    const many = Array.from({ length: 51 }, (_, i) => entry(`src/${i}.ts`, "file"))
    const over = await attemptFindFilesPrivate(connWith((q) => okFor(q, many)) as never, r)
    expect(over).toEqual({ kind: "unavailable", reason: "invalid" })
  })

  test("ambiguous and epoch-drift ambiguous map to unavailable", async () => {
    const r = buildFindFilesReq(DIR, QUERY, "directory", 50)
    const out = await attemptFindFilesPrivate(connWith((q) => ambiguousFor(q)) as never, r)
    expect(out).toEqual({ kind: "unavailable", reason: "transportUnknown" })
    const fetched = await fetchFindFilesTypePrivate({
      connection: connWith((q) => ambiguousFor(q)) as never,
      directory: DIR,
      query: QUERY,
      type: "directory",
      limit: 50,
    })
    expect(fetched).toEqual({ kind: "unavailable" })
  })

  test("transport and closed throw map to unavailable", async () => {
    const r = buildFindFilesReq(DIR, QUERY, "file", 50)
    const broken = await attemptFindFilesPrivate(
      {
        isPrivateAvailable: () => true,
        privateFindFilesOutcomeWithHandle: () => ({
          id: 4,
          promise: Promise.reject(new Error("Private peer unavailable")),
          cancel: () => true,
        }),
      } as never,
      r,
    )
    expect(broken).toEqual({ kind: "unavailable", reason: "transport" })
    const closed = await attemptFindFilesPrivate(
      {
        isPrivateAvailable: () => true,
        privateFindFilesOutcomeWithHandle: () => ({
          id: 5,
          promise: Promise.reject(new Error("Peer closed")),
          cancel: () => true,
        }),
      } as never,
      r,
    )
    expect(closed).toEqual({ kind: "unavailable", reason: "transport" })
  })

  test("non-closed inner rawPromise rejection maps to unavailable via exactly one private request", async () => {
    const privSeen: Array<{ directory: string; query: string; type: string; limit: number }> = []
    let calls = 0
    const connection = {
      isPrivateAvailable: () => true,
      privateFindFilesOutcomeWithHandle: (req: ReturnType<typeof buildFindFilesReq>) => {
        calls += 1
        const inner = req as unknown as {
          context: { directory: string }
          payload: { query: string; type: string; limit: number }
        }
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
    const out = await fetchFindFilesTypePrivate({
      connection: connection as never,
      directory: DIR,
      query: QUERY,
      type: "file",
      limit: 50,
    })
    expect(calls).toBe(1)
    expect(privSeen).toEqual([{ directory: DIR, query: QUERY, type: "file", limit: 50 }])
    expect(out).toEqual({ kind: "unavailable" })
  })

  test("read never retries: at most one private request", async () => {
    let priv = 0
    const out = await fetchFindFilesTypePrivate({
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
      directory: DIR,
      query: QUERY,
      type: "file",
      limit: 50,
    })
    expect(priv).toBe(1)
    expect(out).toEqual({ kind: "unavailable" })
  })

  test("request validity gates query/dir/limit only", () => {
    expect(isFindFilesPrivateRequestValid(QUERY, DIR, 50)).toBeTrue()
    expect(isFindFilesPrivateRequestValid("", DIR, 50)).toBeFalse()
    expect(isFindFilesPrivateRequestValid(QUERY, "relative", 50)).toBeFalse()
    expect(isFindFilesPrivateRequestValid(QUERY, DIR, 51)).toBeFalse()
    expect(isFindFilesPrivateRequestValid(QUERY, DIR, 0)).toBeFalse()
  })

  test("invalid input shape fails closed to unavailable with zero private request and zero SDK", async () => {
    let priv = 0
    for (const bad of [
      { query: "", directory: DIR, type: "file" as const, limit: 50 },
      { query: QUERY, directory: "relative", type: "file" as const, limit: 50 },
      { query: QUERY, directory: DIR, type: "file" as const, limit: 51 },
      { query: QUERY, directory: "", type: "directory" as const, limit: 50 },
    ]) {
      const out = await fetchFindFilesTypePrivate({
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
        directory: bad.directory,
        query: bad.query,
        type: bad.type,
        limit: bad.limit,
      })
      expect(out).toEqual({ kind: "unavailable" })
    }
    expect(priv).toBe(0)
  })

  test("shared helper exposes zero SDK surface", async () => {
    const mod = (await import("./find-files-private")) as Record<string, unknown>
    expect("fetchFindFilesTypePrivateFirst" in mod).toBeFalse()
    expect("fetchFindFilesTypePrivate" in mod).toBeTrue()
    expect(typeof mod.fetchFindFilesTypePrivate).toBe("function")
    // No client/SDK shape remains on the shared read.
    const text = await Bun.file(new URL("./find-files-private.ts", import.meta.url)).text()
    expect(text).not.toContain("fetchFindFilesTypePrivateFirst")
    expect(text.match(/client\.find\.files\(/g) ?? []).toEqual([])
    expect(text.match(/\.find\.files\(/g) ?? []).toEqual([])
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
