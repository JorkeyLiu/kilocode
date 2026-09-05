import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LLMRequestPrep } from "@/session/llm/request"
import { InstanceRef } from "@/effect/instance-ref"
import { HEADER_TASKID } from "@kilocode/kilo-gateway"

const sessionID = "ses_opencode_headers"
const user = {
  id: "msg_user-headers",
  sessionID,
  role: "user",
  time: { created: Date.now() },
  agent: "build",
  model: { providerID: "test", modelID: "test-model" },
} as any

const agent = {
  name: "build",
  mode: "primary",
  options: {},
  permission: [],
} as any

const plugin = {
  trigger: (_name: string, _input: unknown, output: unknown) => Effect.succeed(output),
  list: () => Effect.succeed([]),
  init: () => Effect.void,
} as any

const flags = { outputTokenMax: 32_000, client: "test-client" } as any

function model(providerID: string, npm = "@ai-sdk/openai") {
  return {
    id: `${providerID}/test-model`,
    providerID,
    api: { id: "test-model", url: "https://api.test.com", npm },
    name: "Test Model",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: false,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0.001, output: 0.002, cache: { read: 0.0001, write: 0.0002 } },
    limit: { context: 128_000, output: 8192 },
    status: "active",
    options: {},
    headers: {},
  } as any
}

function input(providerID: string, extra: Record<string, any> = {}) {
  return {
    user,
    sessionID,
    model: model(providerID, extra.npm),
    agent,
    system: [],
    messages: [{ role: "user", content: "Hello" }],
    tools: {},
    provider: { id: providerID, options: {} } as any,
    auth: undefined,
    plugin,
    flags,
    isWorkflow: false,
    ...extra.input,
  } as any
}

const ctx = {
  directory: "/tmp",
  worktree: "/tmp",
  project: { id: "proj_opencode_headers" },
} as any

describe("session-llm-request headers", () => {
  test("opencode provider receives x-opencode-* headers", async () => {
    const result = await Effect.runPromise(
      LLMRequestPrep.prepare(input("opencode")).pipe(Effect.provideService(InstanceRef, ctx)),
    )
    const headers = result.headers as Record<string, string | undefined>
    expect(headers["x-opencode-project"]).toBe("proj_opencode_headers")
    expect(headers["x-opencode-session"]).toBe(sessionID)
    expect(headers["x-opencode-request"]).toBe(user.id)
    expect(headers["x-opencode-client"]).toBe("test-client")
    expect(headers["User-Agent"]).toBeDefined()
    expect(headers["x-session-affinity"]).toBeUndefined()
    expect(headers["X-Session-Id"]).toBeUndefined()
    expect(headers["x-kilo-session"]).toBeUndefined()
  })

  test("opencode-go provider receives x-opencode-* headers", async () => {
    const result = await Effect.runPromise(
      LLMRequestPrep.prepare(input("opencode-go")).pipe(Effect.provideService(InstanceRef, ctx)),
    )
    const headers = result.headers as Record<string, string | undefined>
    expect(headers["x-opencode-session"]).toBe(sessionID)
    expect(headers["x-opencode-request"]).toBe(user.id)
    expect(headers["x-opencode-client"]).toBe("test-client")
    expect(headers["x-session-affinity"]).toBeUndefined()
    expect(headers["X-Session-Id"]).toBeUndefined()
  })

  test("kilo provider receives generic headers", async () => {
    const result = await Effect.runPromise(LLMRequestPrep.prepare(input("kilo")))
    const headers = result.headers as Record<string, string | undefined>
    expect(headers["x-session-affinity"]).toBe(sessionID)
    expect(headers["X-Session-Id"]).toBe(sessionID)
    expect(headers["x-opencode-session"]).toBeUndefined()
    expect(headers["x-kilo-session"]).toBeUndefined()
  })

  test("other providers receive generic headers with parent session", async () => {
    const result = await Effect.runPromise(
      LLMRequestPrep.prepare(input("test", { input: { parentSessionID: "ses_parent" } })),
    )
    const headers = result.headers as Record<string, string | undefined>
    expect(headers["x-session-affinity"]).toBe(sessionID)
    expect(headers["X-Session-Id"]).toBe(sessionID)
    expect(headers["x-parent-session-id"]).toBe("ses_parent")
    expect(headers["x-opencode-session"]).toBeUndefined()
  })

  test("kilo gateway attribution stays on its gateway branch", async () => {
    const result = await Effect.runPromise(
      LLMRequestPrep.prepare(input("kilocode", { npm: "@kilocode/kilo-gateway" })),
    )
    const headers = result.headers as Record<string, string | undefined>
    expect(headers["x-session-affinity"]).toBe(sessionID)
    expect(headers["X-Session-Id"]).toBe(sessionID)
    expect(headers["x-opencode-session"]).toBeUndefined()
    expect(headers[HEADER_TASKID]).toBe(sessionID)
  })
})
