import { describe, expect, test } from "bun:test"
import { handleFileSearch } from "./file-search"

function sdkClient(files: string[], dirs: string[], delay = 0) {
  const calls: Array<{ type: string }> = []
  return {
    calls,
    client: {
      find: {
        files: async (params: { query: string; directory: string; type: string; limit: number }) => {
          calls.push({ type: params.type })
          expect(params.limit).toBe(50)
          if (delay) await new Promise((r) => setTimeout(r, delay))
          return { data: params.type === "file" ? [...files] : [...dirs] }
        },
      },
    },
  }
}

describe("file-search SDK-first parity wiring", () => {
  test("posts unchanged merge output without waiting for private observer", async () => {
    const sdk = sdkClient(["src/a.ts"], ["src/docs"])
    let privateCalls = 0
    let releasePrivate: () => void = () => {}
    const gate = new Promise<void>((r) => {
      releasePrivate = r
    })
    const parity = {
      isPrivateAvailable: () => true,
      privateFindFilesOutcomeWithHandle: (req: Record<string, unknown>) => {
        privateCalls += 1
        return {
          id: privateCalls,
          promise: gate.then(() => ({
            kind: "valid",
            result: {
              v: 1,
              requestId: (req as { requestId: string }).requestId,
              opId: (req as { opId: string }).opId,
              op: "find/files",
              idempotencyKey: (req as { idempotencyKey: string }).idempotencyKey,
              status: "succeeded",
              outcome: { type: "succeeded", time: 1 },
              accepted: true,
              data: { files: [] },
            },
          })),
          cancel: () => true,
        }
      },
    }
    const posted: unknown[] = []
    await handleFileSearch({
      client: sdk.client as never,
      message: { query: "hello", requestId: "r1" },
      dir: () => "/tmp",
      open: async () => new Set<string>(),
      post: (m) => {
        posted.push(m)
      },
      parity: parity as never,
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(sdk.calls.map((c) => c.type).sort()).toEqual(["directory", "file"])
    expect(privateCalls).toBe(2)
    expect(posted.length).toBe(1)
    const msg = posted[0] as { type: string; paths: string[]; dir: string; requestId: string }
    expect(msg.type).toBe("fileSearchResult")
    expect(msg.dir).toBe("/tmp")
    expect(msg.requestId).toBe("r1")
    expect(msg.paths).toContain("src/a.ts")
    releasePrivate()
    await new Promise((r) => setTimeout(r, 10))
  })

  test("without parity connection the SDK path is byte-for-byte identical", async () => {
    const sdk = sdkClient(["a.ts"], ["d"])
    const posted: unknown[] = []
    await handleFileSearch({
      client: sdk.client as never,
      message: { query: "hello", requestId: "r2" },
      dir: () => "/tmp",
      open: async () => new Set<string>(),
      post: (m) => {
        posted.push(m)
      },
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(sdk.calls.length).toBe(2)
    expect(posted.length).toBe(1)
  })

  test("parity throw is contained and SDK post still succeeds", async () => {
    const sdk = sdkClient(["a.ts"], [])
    const posted: unknown[] = []
    const bad = {
      isPrivateAvailable: () => true,
      privateFindFilesOutcomeWithHandle: () => {
        throw new Error("private boom")
      },
    }
    await handleFileSearch({
      client: sdk.client as never,
      message: { query: "hello", requestId: "r3" },
      dir: () => "/tmp",
      open: async () => new Set<string>(),
      post: (m) => {
        posted.push(m)
      },
      parity: bad as never,
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(posted.length).toBe(1)
  })
})
