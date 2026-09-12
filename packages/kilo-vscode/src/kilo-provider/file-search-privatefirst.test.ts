import { describe, expect, test } from "bun:test"
import { handleFileSearch } from "./file-search"
import { buildFindFilesReq } from "./find-files-privatefirst"

function okWire(req: Record<string, unknown>, files: unknown[]) {
  return {
    v: 1,
    requestId: (req as { requestId: string }).requestId,
    opId: (req as { opId: string }).opId,
    op: "find/files",
    idempotencyKey: (req as { idempotencyKey: string }).idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { files },
  }
}

function terminalWire(req: Record<string, unknown>) {
  const failure = { code: "find.failed", message: "private find failed", retryable: false }
  return {
    v: 1,
    requestId: (req as { requestId: string }).requestId,
    opId: (req as { opId: string }).opId,
    op: "find/files",
    idempotencyKey: (req as { idempotencyKey: string }).idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure },
    accepted: false,
    failure,
  }
}

function privateConn(
  impl: (req: Record<string, unknown>) => unknown,
  seen?: Array<{ type: string; query: string; limit: number; directory: string }>,
) {
  return {
    isPrivateAvailable: () => true,
    privateFindFilesOutcomeWithHandle: (req: Record<string, unknown>) => {
      const r = req as { payload: { type: string; query: string; limit: number }; context: { directory: string } }
      seen?.push({ type: r.payload.type, query: r.payload.query, limit: r.payload.limit, directory: r.context.directory })
      return { id: seen?.length ?? 1, promise: Promise.resolve({ kind: "valid", result: impl(req) }), cancel: () => true }
    },
  }
}

describe("file-search private-first wiring", () => {
  test("private success for both types posts merged output with zero SDK", async () => {
    let sdk = 0
    const client = {
      find: {
        files: () => {
          sdk += 1
          return Promise.resolve({ data: [] })
        },
      },
    }
    const seen: Array<{ type: string; query: string; limit: number; directory: string }> = []
    const conn = privateConn((req) => {
      const type = (req as { payload: { type: string } }).payload.type
      return type === "file"
        ? okWire(req, [{ path: "src/a.ts", type: "file" }])
        : okWire(req, [{ path: "src/docs", type: "directory" }])
    }, seen)
    const posted: unknown[] = []
    await handleFileSearch({
      client: client as never,
      message: { query: "hello", requestId: "r1" },
      dir: () => "/tmp",
      open: async () => new Set<string>(),
      post: (m) => {
        posted.push(m)
      },
      connection: conn as never,
    })
    expect(sdk).toBe(0)
    expect(seen.length).toBe(2)
    expect(new Set(seen.map((s) => s.type))).toEqual(new Set(["file", "directory"]))
    expect(seen.every((s) => s.query === "hello" && s.limit === 50 && s.directory === "/tmp")).toBeTrue()
    expect(posted.length).toBe(1)
    const msg = posted[0] as { type: string; paths: string[]; items: unknown[]; dir: string; requestId: string }
    expect(msg.type).toBe("fileSearchResult")
    expect(msg.dir).toBe("/tmp")
    expect(msg.requestId).toBe("r1")
    expect(msg.paths).toContain("src/a.ts")
    expect(msg.items.length).toBeGreaterThan(1)
  })

  test("private empty for both types posts open-only merge with zero SDK", async () => {
    let sdk = 0
    const client = {
      find: {
        files: () => {
          sdk += 1
          return Promise.resolve({ data: ["should-not-appear.ts"] })
        },
      },
    }
    const conn = privateConn((req) => okWire(req, []))
    const posted: unknown[] = []
    await handleFileSearch({
      client: client as never,
      message: { query: "kept", requestId: "r2" },
      dir: () => "/tmp",
      open: async () => new Set<string>(["open/kept.ts"]),
      post: (m) => {
        posted.push(m)
      },
      connection: conn as never,
    })
    expect(sdk).toBe(0)
    expect(posted.length).toBe(1)
    const msg = posted[0] as { paths: string[] }
    expect(msg.paths).toContain("open/kept.ts")
    expect(msg.paths).not.toContain("should-not-appear.ts")
  })

  test("private terminal for both types fails soft with zero SDK", async () => {
    let sdk = 0
    const client = {
      find: {
        files: () => {
          sdk += 1
          return Promise.resolve({ data: ["sdk.ts"] })
        },
      },
    }
    const conn = privateConn((req) => terminalWire(req))
    const posted: unknown[] = []
    await handleFileSearch({
      client: client as never,
      message: { query: "hello", requestId: "r3" },
      dir: () => "/tmp",
      open: async () => new Set<string>(),
      post: (m) => {
        posted.push(m)
      },
      connection: conn as never,
    })
    expect(sdk).toBe(0)
    expect(posted.length).toBe(1)
    const msg = posted[0] as { paths: string[]; items: unknown[] }
    expect(msg.paths).toEqual([])
    expect(msg.items).toEqual([])
  })

  test("private fallback uses exactly one same-tuple SDK per type", async () => {
    const sdkSeen: Array<{ query: string; directory: string; type: string; limit: number }> = []
    const client = {
      find: {
        files: (args: { query: string; directory: string; type: string; limit: number }) => {
          sdkSeen.push(args)
          return Promise.resolve({ data: args.type === "file" ? ["sdk-file.ts"] : ["sdk-dir"] })
        },
      },
    }
    const privSeen: Array<{ type: string; query: string; limit: number; directory: string }> = []
    const conn = {
      isPrivateAvailable: () => false,
      privateFindFilesOutcomeWithHandle: () => {
        throw new Error("must not call when unavailable")
      },
    }
    void privSeen
    const posted: unknown[] = []
    await handleFileSearch({
      client: client as never,
      message: { query: "hello", requestId: "r4" },
      dir: () => "/tmp",
      open: async () => new Set<string>(),
      post: (m) => {
        posted.push(m)
      },
      connection: conn as never,
    })
    expect(sdkSeen.length).toBe(2)
    expect(sdkSeen).toEqual([
      { query: "hello", directory: "/tmp", type: "file", limit: 50 },
      { query: "hello", directory: "/tmp", type: "directory", limit: 50 },
    ])
    expect(posted.length).toBe(1)
    const msg = posted[0] as { paths: string[] }
    expect(msg.paths).toContain("sdk-file.ts")
  })

  test("mixed private file plus SDK directory fallback preserves cardinality", async () => {
    const sdkSeen: string[] = []
    const client = {
      find: {
        files: (args: { type: string }) => {
          sdkSeen.push(args.type)
          return Promise.resolve({ data: args.type === "directory" ? ["sdk-dir"] : [] })
        },
      },
    }
    let calls = 0
    const conn = {
      isPrivateAvailable: () => true,
      privateFindFilesOutcomeWithHandle: (req: Record<string, unknown>) => {
        calls += 1
        const type = (req as { payload: { type: string } }).payload.type
        if (type === "file") return { id: calls, promise: Promise.resolve({ kind: "valid", result: okWire(req, [{ path: "priv.ts", type: "file" }]) }), cancel: () => true }
        return { id: calls, promise: Promise.resolve({ kind: "invalid", detail: "bad" }), cancel: () => true }
      },
    }
    const posted: unknown[] = []
    await handleFileSearch({
      client: client as never,
      message: { query: "hello", requestId: "r5" },
      dir: () => "/tmp",
      open: async () => new Set<string>(),
      post: (m) => {
        posted.push(m)
      },
      connection: conn as never,
    })
    expect(calls).toBe(2)
    expect(sdkSeen).toEqual(["directory"])
    expect(posted.length).toBe(1)
    const msg = posted[0] as { paths: string[] }
    expect(msg.paths).toContain("priv.ts")
  })

  test("without connection the SDK path issues two same-tuple reads", async () => {
    const sdkSeen: string[] = []
    const client = {
      find: {
        files: (args: { type: string; limit: number }) => {
          sdkSeen.push(args.type)
          expect(args.limit).toBe(50)
          return Promise.resolve({ data: [] })
        },
      },
    }
    const posted: unknown[] = []
    await handleFileSearch({
      client: client as never,
      message: { query: "hello", requestId: "r6" },
      dir: () => "/tmp",
      open: async () => new Set<string>(),
      post: (m) => {
        posted.push(m)
      },
    })
    expect(sdkSeen.sort()).toEqual(["directory", "file"])
    expect(posted.length).toBe(1)
  })

  test("private request identity matches SDK tuple per type", () => {
    const rf = buildFindFilesReq("/tmp", "hello", "file", 50)
    const rd = buildFindFilesReq("/tmp", "hello", "directory", 50)
    expect(rf.context.directory).toBe("/tmp")
    expect(rf.payload).toEqual({ query: "hello", type: "file", limit: 50 })
    expect(rd.payload).toEqual({ query: "hello", type: "directory", limit: 50 })
    expect(rf.opId).not.toBe(rd.opId)
  })
})
