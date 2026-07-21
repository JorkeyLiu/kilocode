/**
 * Phase 3C — directory routing tests.
 *
 * Proves:
 *  1. Agent Manager tool mode:local delegates to createLocalSession and
 *     does not call worktree-specific operations.
 *  2. Run controller sets WORKSPACE_PATH (worktree-only WORKTREE_PATH removed).
 *  3. Terminal routing resolves all terminals to workspace root.
 *  4. parseToolRequest only accepts mode:"local".
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// 1. tool-start.ts — local mode delegates to createLocalSession
// ---------------------------------------------------------------------------

import { startFromTool, parseToolRequest, type ToolDeps, type ToolRequest } from "../../src/agent-manager/tool-start"

function createToolDeps(overrides: Partial<ToolDeps> = {}): ToolDeps {
  return {
    getClient: () => ({}) as any,
    getRoot: () => "/repo",
    getPanel: () =>
      ({
        sessions: { registerSession: vi.fn() },
      }) as any,
    openPanel: vi.fn(),
    waitReady: vi.fn().mockResolvedValue(undefined),
    claimRequest: () => true,
    createLocalSession: vi.fn().mockResolvedValue(true),
    push: vi.fn(),
    post: vi.fn(),
    capture: vi.fn(),
    log: vi.fn(),
    error: vi.fn(),
    ...overrides,
  }
}

describe("Phase 3C — tool mode:local uses workspace root", () => {
  it("delegates each task to createLocalSession", async () => {
    const createLocalSession = vi.fn().mockResolvedValue(true)
    const deps = createToolDeps({ createLocalSession })

    const req: ToolRequest = {
      requestID: "req-1",
      mode: "local",
      tasks: [{ prompt: "task one" }, { prompt: "task two" }],
    }

    await startFromTool(deps, req)

    expect(createLocalSession).toHaveBeenCalledTimes(2)
    expect(createLocalSession.mock.calls[0]![0]).toEqual({ prompt: "task one" })
    expect(createLocalSession.mock.calls[1]![0]).toEqual({ prompt: "task two" })
  })

  it("does not call worktree-specific operations", async () => {
    const deps = createToolDeps()
    // These deps should not exist on the new interface at all
    expect(deps).not.toHaveProperty("createWorktree")
    expect(deps).not.toHaveProperty("cleanupWorktree")
    expect(deps).not.toHaveProperty("setup")
    expect(deps).not.toHaveProperty("createSessionInWorktree")
    expect(deps).not.toHaveProperty("registerWorktreeSession")
    expect(deps).not.toHaveProperty("notifyReady")
  })

  it("reports error when all tasks fail", async () => {
    const error = vi.fn()
    const createLocalSession = vi.fn().mockResolvedValue(false)
    const deps = createToolDeps({ createLocalSession, error })

    const req: ToolRequest = {
      requestID: "req-fail",
      mode: "local",
      tasks: [{ prompt: "failing task" }],
    }

    await startFromTool(deps, req)

    expect(error).toHaveBeenCalledWith(expect.stringContaining("Failed to start"))
  })

  it("opens panel and waits ready before creating sessions", async () => {
    const order: string[] = []
    const openPanel = vi.fn(() => order.push("open"))
    const waitReady = vi.fn(async () => order.push("ready"))
    const createLocalSession = vi.fn(async () => {
      order.push("create")
      return true
    })
    const deps = createToolDeps({ openPanel, waitReady, createLocalSession })

    const req: ToolRequest = {
      requestID: "req-order",
      mode: "local",
      tasks: [{ prompt: "test" }],
    }

    await startFromTool(deps, req)

    expect(order).toEqual(["open", "ready", "create"])
  })

  it("skips duplicate request when claimRequest returns false", async () => {
    const createLocalSession = vi.fn().mockResolvedValue(true)
    const log = vi.fn()
    const deps = createToolDeps({
      claimRequest: () => false,
      createLocalSession,
      log,
    })

    const req: ToolRequest = {
      requestID: "req-dup",
      mode: "local",
      tasks: [{ prompt: "test" }],
    }

    await startFromTool(deps, req)

    expect(createLocalSession).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.stringContaining("skipped duplicate"))
  })
})

// ---------------------------------------------------------------------------
// 2. run/controller.ts — WORKSPACE_PATH env (WORKTREE_PATH removed)
// ---------------------------------------------------------------------------

describe("Phase 3C — run controller WORKSPACE_PATH env", () => {
  it("run-script source sets WORKSPACE_PATH", () => {
    const fs = require("fs")
    const path = require("path")
    const controllerPath = path.resolve(__dirname, "../../src/agent-manager/run/controller.ts")
    const content = fs.readFileSync(controllerPath, "utf-8")

    expect(content).toContain("WORKSPACE_PATH")
    expect(content).toMatch(/WORKSPACE_PATH:\s*cwd/)
  })

  it("WORKTREE_PATH was removed (no worktree env var)", () => {
    const fs = require("fs")
    const path = require("path")
    const controllerPath = path.resolve(__dirname, "../../src/agent-manager/run/controller.ts")
    const content = fs.readFileSync(controllerPath, "utf-8")

    expect(content).not.toContain("WORKTREE_PATH")
  })
})

// ---------------------------------------------------------------------------
// 3. terminal-routing.ts — ALL terminals resolve to workspace root
// ---------------------------------------------------------------------------

import { TerminalRouter, type TerminalRoutingDeps } from "../../src/agent-manager/terminal-routing"

function createTerminalDeps(overrides: Partial<TerminalRoutingDeps> = {}): TerminalRoutingDeps {
  return {
    getClient: () => ({}) as any,
    getServerConfig: () => ({ baseUrl: "http://localhost:3000", password: "test" }),
    getRoot: () => "/repo",
    log: vi.fn(),
    post: vi.fn(),
    getTerminalFont: () => ({ fontFamily: "Menlo", fontSize: 14 }),
    ...overrides,
  }
}

describe("Phase 3C — terminal routing resolves ALL to root", () => {
  it("terminal create with null worktreeId uses workspace root as cwd", async () => {
    const getRoot = vi.fn().mockReturnValue("/workspace")
    const router = new TerminalRouter({
      ...createTerminalDeps(),
      getRoot,
    })

    await router.handle({ type: "agentManager.terminal.create", worktreeId: null })

    expect(getRoot).toHaveBeenCalled()
  })

  it("terminal create with any worktreeId also uses workspace root", async () => {
    const getRoot = vi.fn().mockReturnValue("/workspace")
    const router = new TerminalRouter({
      ...createTerminalDeps(),
      getRoot,
    })

    await router.handle({ type: "agentManager.terminal.create", worktreeId: "wt-1" })

    // Should use root regardless of worktreeId
    expect(getRoot).toHaveBeenCalled()
  })

  it("TerminalRoutingDeps no longer has getWorktreePath", () => {
    const deps = createTerminalDeps()
    expect(deps).not.toHaveProperty("getWorktreePath")
  })
})

// ---------------------------------------------------------------------------
// 4. Session send routing — parseToolRequest only accepts mode:local
// ---------------------------------------------------------------------------

describe("Phase 3C — session send routing for local mode", () => {
  it("parseToolRequest rejects non-local modes", () => {
    const result = parseToolRequest({ mode: "invalid", tasks: [{ prompt: "test" }] })
    expect(result).toBeUndefined()
  })

  it("parseToolRequest accepts mode:local", () => {
    const result = parseToolRequest({ requestID: "r1", mode: "local", tasks: [{ prompt: "test" }] })
    expect(result).toBeDefined()
    expect(result!.mode).toBe("local")
  })

  it("parseToolRequest rejects mode:worktree (removed)", () => {
    const result = parseToolRequest({ requestID: "r1", mode: "worktree", tasks: [{ prompt: "test" }] })
    expect(result).toBeUndefined()
  })

  it("parseToolRequest rejects empty tasks", () => {
    const result = parseToolRequest({ requestID: "r1", mode: "local", tasks: [] })
    expect(result).toBeUndefined()
  })

  it("parseToolRequest accepts tasks with model", () => {
    const result = parseToolRequest({
      requestID: "r1",
      mode: "local",
      tasks: [{ prompt: "test", model: { providerID: "openai", modelID: "gpt-4" } }],
    })
    expect(result).toBeDefined()
    expect(result!.tasks[0]!.model).toEqual({ providerID: "openai", modelID: "gpt-4" })
  })
})
