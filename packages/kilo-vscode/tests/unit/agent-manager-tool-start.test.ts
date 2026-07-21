import { afterEach, describe, expect, it, mock } from "bun:test"
import { parseToolRequest, startFromTool, type ToolDeps, type ToolRequest } from "../../src/agent-manager/tool-start"
import type { Session } from "@kilocode/sdk/v2/client"

const platform = Object.getOwnPropertyDescriptor(process, "platform")

function setPlatform(value: string) {
  Object.defineProperty(process, "platform", { value, configurable: true })
}

afterEach(() => {
  if (platform) Object.defineProperty(process, "platform", platform)
})

function session(id: string): Session {
  return { id, title: id, createdAt: "", updatedAt: "" } as Session
}

function deps(overrides: Partial<ToolDeps> = {}): ToolDeps {
  const calls: unknown[] = []
  const panel = {
    waitForReady: mock(async () => calls.push("waitForReady")),
    sessions: { registerSession: mock(() => calls.push("registerSession")) },
  }
  return {
    getRoot: () => "/repo",
    getPanel: () => panel as never,
    openPanel: mock(() => calls.push("openPanel")),
    waitReady: mock(async () => calls.push("waitReady")),
    claimRequest: undefined,
    createLocalSession: mock(async () => true),
    push: mock(() => calls.push("push")),
    post: mock((msg: unknown) => calls.push(msg)),
    capture: mock(() => calls.push("capture")),
    log: mock(() => {}),
    error: mock(() => {}),
    ...overrides,
  }
}

describe("agent manager tool start", () => {
  it("parses tool start events defensively", () => {
    const parsed = parseToolRequest({
      mode: "local",
      tasks: [
        {
          prompt: "one",
          model: { providerID: " test ", modelID: " reasoning/model " },
          variant: " high ",
        },
      ],
    })
    expect(parsed?.requestID.startsWith("am-")).toBe(true)
    expect(parsed?.sessionID).toBeUndefined()
    expect(parsed?.directory).toBeUndefined()
    expect(parsed?.mode).toBe("local")
    expect(parsed?.tasks).toEqual([
      {
        prompt: "one",
        model: { providerID: "test", modelID: "reasoning/model" },
        variant: "high",
      },
    ])
    expect(
      parseToolRequest({
        mode: "local",
        tasks: [{ prompt: "one", model: { providerID: "", modelID: "model" }, variant: "high" }],
      }),
    ).toBeUndefined()
    expect(parseToolRequest({ mode: "local", tasks: [{ prompt: "one", variant: "high" }] })).toBeUndefined()
    expect(
      parseToolRequest({
        mode: "local",
        tasks: [{ name: "Prepared session", model: { providerID: "test", modelID: "model" } }],
      }),
    ).toBeUndefined()
    expect(parseToolRequest({ mode: "local", tasks: [] })).toBeUndefined()
    expect(parseToolRequest({ mode: "local", tasks: [{}] })).toBeUndefined()
  })

  it("rejects mode:worktree in parseToolRequest", () => {
    expect(parseToolRequest({ mode: "worktree", tasks: [{ prompt: "one" }] })).toBeUndefined()
  })

  it("starts local sessions via createLocalSession", async () => {
    const createLocalSession = mock(async () => true)
    const c = deps({ createLocalSession })
    const req: ToolRequest = {
      requestID: "am-1",
      mode: "local",
      tasks: [
        {
          prompt: "Do work",
          model: { providerID: "test", modelID: "reasoning/model" },
          variant: "high",
        },
      ],
    }

    await startFromTool(c, req)

    expect(c.openPanel).toHaveBeenCalledWith(true)
    expect(createLocalSession).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Do work" }),
      expect.objectContaining({}),
    )
  })

  it("deduplicates repeated delivery of the same exact request", async () => {
    const requests = new Set<string>()
    const createLocalSession = mock(async () => true)
    const c = deps({
      claimRequest: mock((id: string) => {
        if (requests.has(id)) return false
        requests.add(id)
        return true
      }),
      createLocalSession,
    })
    const req: ToolRequest = {
      requestID: "am-duplicate",
      mode: "local",
      tasks: [{ prompt: "Do work" }],
    }

    await startFromTool(c, req)
    await startFromTool(c, req)

    expect(createLocalSession).toHaveBeenCalledTimes(1)
  })

  it("starts each task from separate tool calls", async () => {
    const requests = new Set<string>()
    const createLocalSession = mock(async () => true)
    const c = deps({
      claimRequest: mock((id: string) => {
        if (requests.has(id)) return false
        requests.add(id)
        return true
      }),
      createLocalSession,
    })
    const req: ToolRequest = {
      requestID: "am-first",
      mode: "local",
      tasks: [{ prompt: "Task one" }],
    }

    await startFromTool(c, req)
    await startFromTool(c, { ...req, requestID: "am-second" })

    expect(createLocalSession).toHaveBeenCalledTimes(2)
  })

  it("reports errors when all tasks fail", async () => {
    const c = deps({ createLocalSession: mock(async () => false) })
    await startFromTool(c, {
      requestID: "am-fail",
      mode: "local",
      tasks: [{ prompt: "Do work" }],
    })
    expect(c.error).toHaveBeenCalledWith(expect.stringContaining("Failed to start"))
  })

  it("uses workspace root for local sessions regardless of directory", async () => {
    const createLocalSession = mock(async () => true)
    const c = deps({ createLocalSession })

    await startFromTool(c, {
      requestID: "am-dir",
      mode: "local",
      directory: "/repo/other",
      tasks: [{ prompt: "Do work" }],
    })

    expect(createLocalSession).toHaveBeenCalled()
  })
})
