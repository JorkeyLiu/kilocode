import { describe, expect, test } from "bun:test"
import {
  compareFindFilesTypeParity,
  deferredFindFilesKey,
  digestFindFilesSet,
  isFindFilesParityRequestValid,
  observeFindFilesParityDetached,
  observeFindFilesParityFromSdkPromises,
  FIND_FILES_PARITY_TIMEOUT_MS,
  type FindFilesParityConnection,
} from "./find-files-parity"

function validResult(req: Record<string, unknown>, files: unknown) {
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

function connWith(
  impl: Partial<FindFilesParityConnection> & {
    seen?: Array<{ type: string; opId: string; requestId: string }>
  },
): FindFilesParityConnection {
  const seen = impl.seen ?? []
  return {
    isPrivateAvailable: () => true,
    privateFindFilesOutcomeWithHandle: (req: Record<string, unknown>) => {
      seen.push({
        type: (req as { payload: { type: string } }).payload.type,
        opId: (req as { opId: string }).opId,
        requestId: (req as { requestId: string }).requestId,
      })
      return {
        id: seen.length,
        promise: Promise.resolve({ kind: "valid", result: validResult(req, []) }),
        cancel: () => true,
      }
    },
    ...impl,
  } as unknown as FindFilesParityConnection
}

describe("find-files parity comparator/diagnostics", () => {
  test("membership ignores order and is bounded per type", () => {
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
    expect(dir.sdkCount).toBe(0)
  })

  test("digests are stable, domain-separated, and opaque", () => {
    const a = digestFindFilesSet(["b.ts", "a.ts"], "file")
    const b = digestFindFilesSet(["a.ts", "b.ts"], "file")
    expect(a).toBe(b)
    expect(digestFindFilesSet(["a.ts"], "file")).not.toBe(digestFindFilesSet(["a.ts"], "directory"))
    expect(a).not.toContain("a.ts")
  })

  test("request validity gates query/dir/limit only", () => {
    expect(isFindFilesParityRequestValid("hello", "/tmp", 50)).toBeTrue()
    expect(isFindFilesParityRequestValid("", "/tmp", 50)).toBeFalse()
    expect(isFindFilesParityRequestValid("hello", "relative", 50)).toBeFalse()
    expect(isFindFilesParityRequestValid("hello", "/tmp", 51)).toBeFalse()
    expect(FIND_FILES_PARITY_TIMEOUT_MS).toBe(3000)
  })
})

describe("find-files detached observer", () => {
  test("SDK-first non-blocking: launches two independent type requests with isolated keys", async () => {
    const seen: Array<{ type: string; opId: string; requestId: string }> = []
    const conn = connWith({ seen })
    let ret: unknown
    expect(() => {
      ret = observeFindFilesParityDetached(conn, { files: ["a.ts"], directories: ["docs"] }, "/tmp", "hello")
    }).not.toThrow()
    expect(ret).toBeUndefined()
    expect(seen.length).toBe(2)
    expect(new Set(seen.map((s) => s.type))).toEqual(new Set(["file", "directory"]))
    expect(new Set(seen.map((s) => s.opId)).size).toBe(2)
    expect(new Set(seen.map((s) => s.requestId)).size).toBe(2)
    await new Promise((r) => setTimeout(r, 25))
  })

  test("non-terminal/invalid input never touches private transport", () => {
    const conn = {
      isPrivateAvailable: () => {
        throw new Error("must not check")
      },
      privateFindFilesOutcomeWithHandle: () => {
        throw new Error("must not call")
      },
    } as unknown as FindFilesParityConnection
    expect(() => observeFindFilesParityDetached(conn, { files: [], directories: [] }, "/tmp", "")).not.toThrow()
    expect(() =>
      observeFindFilesParityDetached(conn, { files: [], directories: [] }, "relative", "hello"),
    ).not.toThrow()
    expect(() =>
      observeFindFilesParityDetached(conn, { files: "bad", directories: [] } as never, "/tmp", "hello"),
    ).not.toThrow()
  })

  test("timeout branch cancels exact id and warns redacted fixed fields", async () => {
    const warns: unknown[][] = []
    const orig = console.warn
    console.warn = (...a: unknown[]) => {
      warns.push(a)
    }
    try {
      let cancelled: number[] = []
      const conn = {
        isPrivateAvailable: () => true,
        privateFindFilesOutcomeWithHandle: () => ({
          id: 41,
          promise: new Promise(() => {}),
          cancel: (msg?: string) => {
            void msg
            cancelled.push(41)
            return true
          },
        }),
        getPrivateEpoch: () => 7,
      } as unknown as FindFilesParityConnection
      observeFindFilesParityDetached(conn, { files: [], directories: [] }, "/tmp", "hello", undefined, 20)
      await new Promise((r) => setTimeout(r, 60))
      expect(cancelled.length).toBe(2)
      const timeout = warns.filter((w) => String(w[0]).includes("private parity timeout"))
      expect(timeout.length).toBe(2)
      for (const w of warns) {
        const text = JSON.stringify(w)
        expect(text).not.toContain("hello")
        expect(text).not.toContain("/tmp")
      }
    } finally {
      console.warn = orig
    }
  })

  test("stale replacement isolation: stale cancel returns stale and skips invalidation", async () => {
    const warns: unknown[][] = []
    const orig = console.warn
    console.warn = (...a: unknown[]) => {
      warns.push(a)
    }
    try {
      let invalidated = 0
      const conn = {
        isPrivateAvailable: () => true,
        privateFindFilesOutcomeWithHandle: () => ({
          id: 5,
          promise: new Promise(() => {}),
          cancel: () => "stale" as const,
        }),
        invalidatePrivatePeerOnObserverTimeout: () => {
          invalidated += 1
        },
        getPrivateEpoch: () => 8,
      } as unknown as FindFilesParityConnection
      observeFindFilesParityDetached(conn, { files: [], directories: [] }, "/tmp", "hello", undefined, 20)
      await new Promise((r) => setTimeout(r, 60))
      expect(invalidated).toBe(0)
      expect(warns.some((w) => JSON.stringify(w).includes('"stale":true'))).toBeTrue()
    } finally {
      console.warn = orig
    }
  })

  test("deferred negotiation registers per-type keys through connection service", async () => {
    const regs: Array<{ query: string; type: string; limit: number | undefined }> = []
    let available = false
    let listener: (() => void) | null = null
    const conn = {
      isPrivateAvailable: () => available,
      privateFindFilesOutcomeWithHandle: (req: Record<string, unknown>) => ({
        id: 1,
        promise: Promise.resolve({ kind: "valid", result: validResult(req, []) }),
        cancel: () => true,
      }),
      addDeferredFindFilesObserver: (
        _dir: string,
        _ws: string | undefined,
        query: string,
        type: string,
        limit: number | undefined,
        fn: () => void,
      ) => {
        regs.push({ query, type, limit })
        listener = fn
        return () => {}
      },
    } as unknown as FindFilesParityConnection
    observeFindFilesParityDetached(conn, { files: [], directories: [] }, "/tmp", "hello")
    expect(regs.length).toBe(2)
    expect(new Set(regs.map((r) => r.type))).toEqual(new Set(["file", "directory"]))
    expect(regs.every((r) => r.query === "hello" && r.limit === 50)).toBeTrue()
    available = true
    listener?.()
    await new Promise((r) => setTimeout(r, 25))
  })

  test("malformed private result is warn-only contained without raw material", async () => {
    const warns: unknown[][] = []
    const orig = console.warn
    console.warn = (...a: unknown[]) => {
      warns.push(a)
    }
    try {
      const conn = {
        isPrivateAvailable: () => true,
        privateFindFilesOutcomeWithHandle: () => ({
          id: 1,
          promise: Promise.resolve({ kind: "invalid", detail: "bad wire" }),
          cancel: () => true,
        }),
      } as unknown as FindFilesParityConnection
      expect(() =>
        observeFindFilesParityDetached(conn, { files: ["secret/a.ts"], directories: [] }, "/tmp", "hello"),
      ).not.toThrow()
      await new Promise((r) => setTimeout(r, 25))
      expect(warns.length).toBeGreaterThan(0)
      for (const w of warns) {
        const text = JSON.stringify(w)
        expect(text).not.toContain("secret/a.ts")
        expect(text).not.toContain("hello")
        expect(text).not.toContain("/tmp")
      }
      expect(warns.some((w) => JSON.stringify(w).includes('"invalid":true'))).toBeTrue()
    } finally {
      console.warn = orig
    }
  })

  test("divergence diagnostics carry counts/digests only, never raw paths", async () => {
    const warns: unknown[][] = []
    const orig = console.warn
    console.warn = (...a: unknown[]) => {
      warns.push(a)
    }
    try {
      const conn = {
        isPrivateAvailable: () => true,
        privateFindFilesOutcomeWithHandle: (req: Record<string, unknown>) => {
          const type = (req as { payload: { type: string } }).payload.type
          const files = type === "file" ? [{ path: "other.ts", type: "file" }] : []
          return {
            id: 1,
            promise: Promise.resolve({ kind: "valid", result: validResult(req, files) }),
            cancel: () => true,
          }
        },
      } as unknown as FindFilesParityConnection
      observeFindFilesParityDetached(conn, { files: ["mine.ts"], directories: [] }, "/tmp", "hello")
      await new Promise((r) => setTimeout(r, 25))
      const div = warns.filter((w) => String(w[0]).includes("parity divergence"))
      expect(div.length).toBe(1)
      const text = JSON.stringify(div[0])
      expect(text).not.toContain("mine.ts")
      expect(text).not.toContain("other.ts")
      expect(text).toContain("sdkCount")
      expect(text).toContain("sdkDigest")
    } finally {
      console.warn = orig
    }
  })

  test("deferred fallback key is opaque and per-type isolated", () => {
    const a = deferredFindFilesKey(7, "/tmp/alpha", undefined, "hello", "file", 50)
    const b = deferredFindFilesKey(7, "/tmp/alpha", undefined, "hello", "directory", 50)
    expect(a).not.toBe(b)
    for (const k of [a, b]) {
      expect(k.startsWith("find-files:")).toBeTrue()
      expect(k).not.toContain("hello")
      expect(k).not.toContain("/tmp/alpha")
    }
  })

  test("deferred fallback null epoch fires on first availability epoch", async () => {
    const warns: unknown[][] = []
    const orig = console.warn
    console.warn = (...a: unknown[]) => {
      warns.push(a)
    }
    try {
      const listeners: Array<() => void> = []
      let available = false
      let epoch: number | null = null
      const seen: Array<{ type: string }> = []
      const conn = {
        isPrivateAvailable: () => available,
        getPrivateEpoch: () => epoch,
        onPrivateAvailable: (fn: () => void) => {
          listeners.push(fn)
          return () => {}
        },
        privateFindFilesOutcomeWithHandle: (req: Record<string, unknown>) => {
          seen.push({ type: (req as { payload: { type: string } }).payload.type })
          return {
            id: seen.length,
            promise: Promise.resolve({ kind: "valid", result: validResult(req, []) }),
            cancel: () => true,
          }
        },
      } as unknown as FindFilesParityConnection
      observeFindFilesParityDetached(conn, { files: [], directories: [] }, "/tmp", "hello")
      expect(listeners.length).toBe(2)
      expect(seen.length).toBe(0)
      available = true
      epoch = 9
      for (const fn of [...listeners]) fn()
      await new Promise((r) => setTimeout(r, 25))
      expect(seen.length).toBe(2)
      expect(new Set(seen.map((s) => s.type))).toEqual(new Set(["file", "directory"]))
      expect(warns.filter((w) => String(w[0]).includes("stale deferred parity skipped")).length).toBe(0)
    } finally {
      console.warn = orig
    }
  })

  test("deferred fallback captured epoch still skips on stale epoch", async () => {
    const warns: unknown[][] = []
    const orig = console.warn
    console.warn = (...a: unknown[]) => {
      warns.push(a)
    }
    try {
      const listeners: Array<() => void> = []
      let available = false
      let epoch: number | null = 7
      const seen: Array<{ type: string }> = []
      const conn = {
        isPrivateAvailable: () => available,
        getPrivateEpoch: () => epoch,
        onPrivateAvailable: (fn: () => void) => {
          listeners.push(fn)
          return () => {}
        },
        privateFindFilesOutcomeWithHandle: (req: Record<string, unknown>) => {
          seen.push({ type: (req as { payload: { type: string } }).payload.type })
          return {
            id: seen.length,
            promise: Promise.resolve({ kind: "valid", result: validResult(req, []) }),
            cancel: () => true,
          }
        },
      } as unknown as FindFilesParityConnection
      observeFindFilesParityDetached(conn, { files: [], directories: [] }, "/tmp", "hello")
      expect(listeners.length).toBe(2)
      expect(seen.length).toBe(0)
      available = true
      epoch = 8
      for (const fn of [...listeners]) fn()
      await new Promise((r) => setTimeout(r, 25))
      expect(seen.length).toBe(0)
      expect(warns.filter((w) => String(w[0]).includes("stale deferred parity skipped")).length).toBe(2)
    } finally {
      console.warn = orig
    }
  })

  test("promise launcher forwards settled SDK arrays without blocking", async () => {
    const seen: Array<{ type: string }> = []
    const conn = connWith({ seen: seen as never }) as FindFilesParityConnection
    const fileP = Promise.resolve({ data: ["a.ts"] })
    const dirP = Promise.resolve({ data: ["docs"] })
    const t0 = Date.now()
    let ret: unknown
    expect(() => {
      ret = observeFindFilesParityFromSdkPromises(conn, fileP, dirP, "/tmp", "hello")
    }).not.toThrow()
    expect(ret).toBeUndefined()
    expect(Date.now() - t0).toBeLessThan(50)
    await new Promise((r) => setTimeout(r, 25))
    expect(seen.length).toBe(2)
  })

  test("rejected SDK type skips comparison without false divergence", async () => {
    const warns: unknown[][] = []
    const orig = console.warn
    console.warn = (...a: unknown[]) => {
      warns.push(a)
    }
    try {
      const seen: Array<{ type: string }> = []
      const conn = {
        isPrivateAvailable: () => true,
        privateFindFilesOutcomeWithHandle: (req: Record<string, unknown>) => {
          const type = (req as { payload: { type: string } }).payload.type
          seen.push({ type })
          const files = type === "file" ? [{ path: "other.ts", type: "file" }] : [{ path: "other", type: "directory" }]
          return {
            id: seen.length,
            promise: Promise.resolve({ kind: "valid", result: validResult(req, files) }),
            cancel: () => true,
          }
        },
      } as unknown as FindFilesParityConnection
      const fileP: Promise<{ data: string[] }> = Promise.reject(new Error("sdk file boom"))
      void fileP.catch(() => undefined)
      const dirP: Promise<{ data: string[] }> = Promise.reject(new Error("sdk dir boom"))
      void dirP.catch(() => undefined)
      expect(() => {
        observeFindFilesParityFromSdkPromises(conn, fileP, dirP, "/tmp", "hello")
      }).not.toThrow()
      await new Promise((r) => setTimeout(r, 25))
      expect(seen.length).toBe(0)
      expect(warns.filter((w) => String(w[0]).includes("parity divergence")).length).toBe(0)
    } finally {
      console.warn = orig
    }
  })

  test("rejected file skips file only while fulfilled directory still compares", async () => {
    const warns: unknown[][] = []
    const orig = console.warn
    console.warn = (...a: unknown[]) => {
      warns.push(a)
    }
    try {
      const seen: Array<{ type: string }> = []
      const conn = {
        isPrivateAvailable: () => true,
        privateFindFilesOutcomeWithHandle: (req: Record<string, unknown>) => {
          const type = (req as { payload: { type: string } }).payload.type
          seen.push({ type })
          const files = type === "directory" ? [{ path: "other", type: "directory" }] : []
          return {
            id: seen.length,
            promise: Promise.resolve({ kind: "valid", result: validResult(req, files) }),
            cancel: () => true,
          }
        },
      } as unknown as FindFilesParityConnection
      const fileP: Promise<{ data: string[] }> = Promise.reject(new Error("sdk file boom"))
      void fileP.catch(() => undefined)
      const dirP = Promise.resolve({ data: [] })
      observeFindFilesParityFromSdkPromises(conn, fileP, dirP, "/tmp", "hello")
      await new Promise((r) => setTimeout(r, 25))
      expect(seen).toEqual([{ type: "directory" }])
      const div = warns.filter((w) => String(w[0]).includes("parity divergence"))
      expect(div.length).toBe(1)
      expect(JSON.stringify(div[0])).toContain('"type":"directory"')
    } finally {
      console.warn = orig
    }
  })

  test("fulfilled empty remains comparable and diverges against private extra", async () => {
    const warns: unknown[][] = []
    const orig = console.warn
    console.warn = (...a: unknown[]) => {
      warns.push(a)
    }
    try {
      const conn = {
        isPrivateAvailable: () => true,
        privateFindFilesOutcomeWithHandle: (req: Record<string, unknown>) => {
          const type = (req as { payload: { type: string } }).payload.type
          const files = type === "file" ? [{ path: "other.ts", type: "file" }] : []
          return {
            id: 1,
            promise: Promise.resolve({ kind: "valid", result: validResult(req, files) }),
            cancel: () => true,
          }
        },
      } as unknown as FindFilesParityConnection
      observeFindFilesParityDetached(conn, { files: [], directories: [] }, "/tmp", "hello")
      await new Promise((r) => setTimeout(r, 25))
      const div = warns.filter((w) => String(w[0]).includes("parity divergence"))
      expect(div.length).toBe(1)
      const text = JSON.stringify(div[0])
      expect(text).toContain('"sdkCount":0')
      expect(text).toContain('"privateCount":1')
    } finally {
      console.warn = orig
    }
  })

  test("detached null SDK entry skips that type without divergence", async () => {
    const warns: unknown[][] = []
    const orig = console.warn
    console.warn = (...a: unknown[]) => {
      warns.push(a)
    }
    try {
      const seen: Array<{ type: string }> = []
      const conn = {
        isPrivateAvailable: () => true,
        privateFindFilesOutcomeWithHandle: (req: Record<string, unknown>) => {
          seen.push({ type: (req as { payload: { type: string } }).payload.type })
          return {
            id: seen.length,
            promise: Promise.resolve({ kind: "valid", result: validResult(req, []) }),
            cancel: () => true,
          }
        },
      } as unknown as FindFilesParityConnection
      observeFindFilesParityDetached(conn, { files: null, directories: null }, "/tmp", "hello")
      await new Promise((r) => setTimeout(r, 25))
      expect(seen.length).toBe(0)
      expect(warns.filter((w) => String(w[0]).includes("parity divergence")).length).toBe(0)
    } finally {
      console.warn = orig
    }
  })

  test("real elapsed-time timeout probe for both independent type observers", async () => {
    const conn = {
      isPrivateAvailable: () => true,
      privateFindFilesOutcomeWithHandle: () => ({
        id: 9,
        promise: new Promise(() => {}),
        cancel: () => true,
      }),
      getPrivateEpoch: () => 1,
    } as unknown as FindFilesParityConnection
    const start = Date.now()
    observeFindFilesParityDetached(conn, { files: [], directories: [] }, "/tmp", "hello", undefined, 30)
    await new Promise((r) => setTimeout(r, 80))
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(25)
    expect(elapsed).toBeLessThan(2000)
  }, 5000)
})
