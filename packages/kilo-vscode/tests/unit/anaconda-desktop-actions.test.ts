import { describe, expect, it } from "bun:test"
import { AnacondaDesktopBridge } from "../../src/anaconda-desktop/bridge"

const ready = {
  type: "ready" as const,
  serverID: "server",
  models: [{ id: "model", name: "Local Model" }],
  context: 32768,
  toolcall: "unknown" as const,
}

describe("AnacondaDesktopBridge", () => {
  it("forwards explicit tool acknowledgement", async () => {
    const calls: unknown[][] = []
    let refreshed = false
    const bridge = new AnacondaDesktopBridge()
    await bridge.handle(
      { type: "anacondaDesktopSync", requestId: "sync", acknowledgeToolLimitations: true },
      {
        client: {
          anacondaDesktop: {
            sync: async (...args: unknown[]) => {
              calls.push(args)
              return { data: ready }
            },
          },
        } as never,
        directory: "/workspace",
        post: () => {},
        refresh: async () => {
          refreshed = true
        },
        error: String,
      },
    )

    expect(calls[0]?.[0]).toEqual({ directory: "/workspace", acknowledgeToolLimitations: true })
    expect(refreshed).toBe(true)
  })

  it("aborts cancelled requests and suppresses their result", async () => {
    const posts: unknown[] = []
    const bridge = new AnacondaDesktopBridge()
    const client = {
      anacondaDesktop: {
        status: (_: unknown, opts: { signal: AbortSignal }) =>
          new Promise((_, reject) => opts.signal.addEventListener("abort", () => reject(new Error("aborted")))),
      },
    }
    const ctx = {
      client: client as never,
      directory: "/workspace",
      post: (message: unknown) => posts.push(message),
      refresh: async () => {},
      error: String,
    }
    const request = bridge.handle({ type: "anacondaDesktopStatus", requestId: "request" }, ctx)

    await bridge.handle({ type: "cancelAnacondaDesktopRequest", requestId: "request" }, ctx)
    await request
    expect(posts).toEqual([])
  })
})
