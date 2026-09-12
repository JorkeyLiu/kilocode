import { describe, expect, it } from "bun:test"
import type { KiloClient } from "@kilocode/sdk/v2/client"
import type { BackendAgentRequirementResult } from "../../src/kilo-provider/agent-requirements"
import { AgentRequirementsController } from "../../src/kilo-provider/agent-requirements-controller"

const root = "/repo"

function result(input: Partial<BackendAgentRequirementResult> = {}): BackendAgentRequirementResult {
  return {
    agent: "demo",
    directory: root,
    enabled: true,
    state: "ready",
    skills: [],
    mcps: [],
    vscode_extensions: [],
    ...input,
  }
}

function sdkClient(value: BackendAgentRequirementResult, calls: Array<{ agent: string; directory: string }>) {
  const api = {
    kilocode: {
      agentRequirements: async (parameters: { agent: string; directory: string }) => {
        calls.push(parameters)
        return { data: value }
      },
    },
  } as unknown as KiloClient
  return api
}

function controller(input: {
  api?: KiloClient | null
  posts?: unknown[]
  sdkValue?: BackendAgentRequirementResult
  sdkCalls?: Array<{ agent: string; directory: string }>
  priv?: (agent: string, directory: string) => Promise<never | { kind: string }>
  generation?: () => number
}) {
  const posts = input.posts ?? []
  const sdkCalls = input.sdkCalls ?? []
  const sdkValue = input.sdkValue ?? result()
  const api = input.api ?? sdkClient(sdkValue, sdkCalls)
  return {
    posts,
    sdkCalls,
    requirements: new AgentRequirementsController({
      post: (message) => posts.push(message),
      client: () => api,
      connected: () => true,
      generation: input.generation ?? (() => 1),
      root: () => root,
      folders: () => [root],
      project: () => root,
      sessions: () => new Map(),
      extension: () => undefined,
      error: (error) => (error instanceof Error ? error.message : String(error)),
      private: input.priv as never,
    }),
  }
}

describe("AgentRequirementsController private-first", () => {
  it("private success posts augmented result with zero SDK and caches", async () => {
    const posts: unknown[] = []
    const sdkCalls: Array<{ agent: string; directory: string }> = []
    const privPayload = result({ vscode_extensions: [{ name: "Missing Extension", id: "publisher.missing" }] })
    const { requirements } = controller({
      posts,
      sdkCalls,
      priv: async () => ({ kind: "ok", requirements: privPayload }),
    })

    await requirements.fetch({ agent: "demo", directory: root })
    await requirements.fetch({ agent: "demo", directory: root })

    expect(sdkCalls).toEqual([])
    expect(posts.at(-1)).toMatchObject({
      type: "agentRequirementsLoaded",
      result: { state: "blocked", vscode_extensions: [{ status: "missing" }] },
    })
  })

  it("retryable private failure takes exactly one SDK fallback", async () => {
    const posts: unknown[] = []
    const sdkCalls: Array<{ agent: string; directory: string }> = []
    let privCalls = 0
    const { requirements } = controller({
      posts,
      sdkCalls,
      sdkValue: result({ state: "ready" }),
      priv: async () => {
        privCalls += 1
        return { kind: "fallback", reason: "InstanceUnavailableDuringConfigRebuild" }
      },
    })

    await requirements.fetch({ agent: "demo", directory: root })

    expect(privCalls).toBe(1)
    expect(sdkCalls).toEqual([{ agent: "demo", directory: root }])
    expect(posts.at(-1)).toMatchObject({ type: "agentRequirementsLoaded", result: { state: "ready" } })
  })

  it("unavailable private takes exactly one SDK fallback", async () => {
    const posts: unknown[] = []
    const sdkCalls: Array<{ agent: string; directory: string }> = []
    const { requirements } = controller({
      posts,
      sdkCalls,
      sdkValue: result({ state: "ready" }),
      priv: async () => ({ kind: "fallback", reason: "unavailable" }),
    })

    await requirements.fetch({ agent: "demo", directory: root })

    expect(sdkCalls).toEqual([{ agent: "demo", directory: root }])
  })

  it("terminal private failure posts request_failed with zero SDK and no cache", async () => {
    const posts: unknown[] = []
    const sdkCalls: Array<{ agent: string; directory: string }> = []
    const { requirements } = controller({
      posts,
      sdkCalls,
      priv: async () => ({ kind: "terminal" }),
    })

    await requirements.fetch({ agent: "demo", directory: root })

    expect(sdkCalls).toEqual([])
    expect(posts.at(-1)).toMatchObject({
      type: "agentRequirementsLoaded",
      result: { state: "error", error: { code: "request_failed" } },
    })
  })

  it("timeout fallback exact-cancels and takes one SDK", async () => {
    const posts: unknown[] = []
    const sdkCalls: Array<{ agent: string; directory: string }> = []
    let cancelled: string | undefined
    const priv = () =>
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("private parity timeout after 5ms")), 5)
        ;(timer as unknown as { unref?: () => void })?.unref?.()
      })
        .catch(() => ({ kind: "fallback", reason: "timeout" }))
        .then((v) => {
          cancelled = "private parity timeout"
          return v
        })
    const { requirements } = controller({
      posts,
      sdkCalls,
      sdkValue: result({ state: "ready" }),
      priv: priv as never,
    })

    await requirements.fetch({ agent: "demo", directory: root })

    expect(cancelled).toBe("private parity timeout")
    expect(sdkCalls).toEqual([{ agent: "demo", directory: root }])
  })

  it("clear supersession still swallows the send-path assert", async () => {
    const posts: unknown[] = []
    let resolvePriv!: (value: { kind: string }) => void
    const privGate = new Promise<{ kind: string }>((resolve) => {
      resolvePriv = resolve as never
    })
    const { requirements } = controller({
      posts,
      priv: (() => privGate) as never,
    })

    const asserted = requirements.assertAgentRequirements("demo", root)
    requirements.clear()
    resolvePriv({ kind: "ok", requirements: result({ state: "ready" }) })
    await expect(asserted).resolves.toBeUndefined()
  })
})
