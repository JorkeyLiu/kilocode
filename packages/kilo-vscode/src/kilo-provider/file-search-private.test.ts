import { describe, expect, test } from "bun:test"
import { handleFileSearch } from "./file-search"
import { buildFindFilesReq } from "./find-files-private"

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
  const failure = { code: "validation.failed", message: "invalid find-files request", retryable: false }
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

function fenceWire(req: Record<string, unknown>) {
  const failure = {
    code: "InstanceUnavailableDuringConfigRebuild",
    message: "Instance is unavailable during config rebuild; no active runtime for this request",
    retryable: true,
  }
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

describe("file-search private authority wiring", () => {
  test("all-ok private success for both types posts merged output with zero SDK", async () => {
    const seen: Array<{ type: string; query: string; limit: number; directory: string }> = []
    const conn = privateConn((req) => {
      const type = (req as { payload: { type: string } }).payload.type
      return type === "file"
        ? okWire(req, [{ path: "src/a.ts", type: "file" }])
        : okWire(req, [{ path: "src/docs", type: "directory" }])
    }, seen)
    const posted: unknown[] = []
    await handleFileSearch({
      message: { query: "hello", requestId: "r1" },
      dir: () => "/tmp",
      open: async () => new Set<string>(),
      post: (m) => {
        posted.push(m)
      },
      connection: conn as never,
    })
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

  test("mixed success and terminal: one type may succeed while the other fails", async () => {
    let calls = 0
    const conn = {
      isPrivateAvailable: () => true,
      privateFindFilesOutcomeWithHandle: (req: Record<string, unknown>) => {
        calls += 1
        const type = (req as { payload: { type: string } }).payload.type
        if (type === "file")
          return {
            id: calls,
            promise: Promise.resolve({ kind: "valid", result: okWire(req, [{ path: "priv.ts", type: "file" }]) }),
            cancel: () => true,
          }
        return {
          id: calls,
          promise: Promise.resolve({ kind: "valid", result: terminalWire(req) }),
          cancel: () => true,
        }
      },
    }
    const posted: unknown[] = []
    await handleFileSearch({
      message: { query: "hello", requestId: "r-mix" },
      dir: () => "/tmp",
      open: async () => new Set<string>(),
      post: (m) => {
        posted.push(m)
      },
      connection: conn as never,
    })
    expect(calls).toBe(2)
    expect(posted.length).toBe(1)
    const msg = posted[0] as { paths: string[]; items: Array<{ path: string; type: string }> }
    expect(msg.paths).toContain("priv.ts")
    // Directory terminal maps to [] so no folder items from backend.
    expect(msg.items.every((i) => i.type !== "folder" || i.path !== "sdk-dir")).toBeTrue()
  })

  test("mixed success and fence-unavailable maps fence type to empty", async () => {
    const conn = privateConn((req) => {
      const type = (req as { payload: { type: string } }).payload.type
      return type === "file" ? okWire(req, [{ path: "keep.ts", type: "file" }]) : fenceWire(req)
    })
    const posted: unknown[] = []
    await handleFileSearch({
      message: { query: "hello", requestId: "r-fence" },
      dir: () => "/tmp",
      open: async () => new Set<string>(),
      post: (m) => {
        posted.push(m)
      },
      connection: conn as never,
    })
    expect(posted.length).toBe(1)
    const msg = posted[0] as { paths: string[] }
    expect(msg.paths).toContain("keep.ts")
  })

  test("no connection fails closed to empty backend but keeps local open merge and always posts", async () => {
    const posted: unknown[] = []
    await handleFileSearch({
      message: { query: "kept", requestId: "r-noconn" },
      dir: () => "/tmp",
      open: async () => new Set<string>(["open/kept.ts"]),
      post: (m) => {
        posted.push(m)
      },
      connection: null,
    })
    expect(posted.length).toBe(1)
    const msg = posted[0] as { type: string; paths: string[]; dir: string; requestId: string }
    expect(msg.type).toBe("fileSearchResult")
    expect(msg.paths).toContain("open/kept.ts")
    expect(msg.dir).toBe("/tmp")
    expect(msg.requestId).toBe("r-noconn")
  })

  test("private empty for both types posts open-only merge", async () => {
    const conn = privateConn((req) => okWire(req, []))
    const posted: unknown[] = []
    await handleFileSearch({
      message: { query: "kept", requestId: "r2" },
      dir: () => "/tmp",
      open: async () => new Set<string>(["open/kept.ts"]),
      post: (m) => {
        posted.push(m)
      },
      connection: conn as never,
    })
    expect(posted.length).toBe(1)
    const msg = posted[0] as { paths: string[] }
    expect(msg.paths).toContain("open/kept.ts")
  })

  test("filtered private results fail closed: sensitive/invalid entries map to empty backend", async () => {
    // Backend never returns sensitive names; if the wire carries one the
    // strict validation fails closed to unavailable -> [] for that type.
    const conn = privateConn((req) => {
      const type = (req as { payload: { type: string } }).payload.type
      return type === "file" ? okWire(req, [{ path: ".env", type: "file" }]) : okWire(req, [])
    })
    const posted: unknown[] = []
    await handleFileSearch({
      message: { query: "kept", requestId: "r-filter" },
      dir: () => "/tmp",
      open: async () => new Set<string>(["open/kept.ts"]),
      post: (m) => {
        posted.push(m)
      },
      connection: conn as never,
    })
    expect(posted.length).toBe(1)
    const msg = posted[0] as { paths: string[] }
    expect(msg.paths).not.toContain(".env")
    expect(msg.paths).toContain("open/kept.ts")
  })

  test("terminal for both types fails soft and always posts empty", async () => {
    const conn = privateConn((req) => terminalWire(req))
    const posted: unknown[] = []
    await handleFileSearch({
      message: { query: "hello", requestId: "r3" },
      dir: () => "/tmp",
      open: async () => new Set<string>(),
      post: (m) => {
        posted.push(m)
      },
      connection: conn as never,
    })
    expect(posted.length).toBe(1)
    const msg = posted[0] as { paths: string[]; items: unknown[] }
    expect(msg.paths).toEqual([])
    expect(msg.items).toEqual([])
  })

  test("local and open-file merging keeps dedup and order", async () => {
    const conn = privateConn((req) => {
      const type = (req as { payload: { type: string } }).payload.type
      return type === "file"
        ? okWire(req, [
            { path: "src/kept-a.ts", type: "file" },
            { path: "open/kept.ts", type: "file" },
          ])
        : okWire(req, [{ path: "src/kept-docs", type: "directory" }])
    })
    const posted: unknown[] = []
    await handleFileSearch({
      message: { query: "kept", requestId: "r-merge" },
      dir: () => "/tmp",
      open: async () => new Set<string>(["open/kept.ts"]),
      post: (m) => {
        posted.push(m)
      },
      connection: conn as never,
    })
    expect(posted.length).toBe(1)
    const msg = posted[0] as { paths: string[]; items: Array<{ path: string; type: string }> }
    // Open tab appears once and leads the merged paths.
    expect(msg.paths.filter((p) => p === "open/kept.ts").length).toBe(1)
    expect(msg.paths[0]).toBe("open/kept.ts")
    expect(msg.paths).toContain("src/kept-a.ts")
    // Open file is marked as opened-file in items.
    const opened = msg.items.find((i) => i.path === "open/kept.ts")
    expect(opened?.type).toBe("opened-file")
  })

  test("invalid query fails closed to unavailable but still always posts", async () => {
    let priv = 0
    const conn = {
      isPrivateAvailable: () => {
        priv += 1
        return true
      },
      privateFindFilesOutcomeWithHandle: () => {
        priv += 10
        return { id: 1, promise: Promise.resolve({ kind: "valid", result: {} }), cancel: () => true }
      },
    }
    const posted: unknown[] = []
    await handleFileSearch({
      message: { query: "", requestId: "r-invalid" },
      dir: () => "/tmp",
      open: async () => new Set<string>(["open/kept.ts"]),
      post: (m) => {
        posted.push(m)
      },
      connection: conn as never,
    })
    expect(priv).toBe(0)
    expect(posted.length).toBe(1)
    const msg = posted[0] as { paths: string[] }
    expect(msg.paths).toContain("open/kept.ts")
  })

  test("private request identity matches exact query tuple per type", () => {
    const rf = buildFindFilesReq("/tmp", "hello", "file", 50)
    const rd = buildFindFilesReq("/tmp", "hello", "directory", 50)
    expect(rf.context.directory).toBe("/tmp")
    expect(rf.payload).toEqual({ query: "hello", type: "file", limit: 50 })
    expect(rd.payload).toEqual({ query: "hello", type: "directory", limit: 50 })
    expect(rf.opId).not.toBe(rd.opId)
  })

  test("file-search has zero SDK surface", async () => {
    const text = await Bun.file(new URL("./file-search.ts", import.meta.url)).text()
    expect(text).not.toContain("fetchFindFilesTypePrivateFirst")
    expect(text).toContain("fetchFindFilesTypePrivate")
    expect(text.match(/\.find\.files\(/g) ?? []).toEqual([])
    expect(text).not.toContain("KiloClient")
  })
})
