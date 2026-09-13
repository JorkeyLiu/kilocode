import { describe, expect, test } from "bun:test"
import { readFile } from "fs/promises"
import { join } from "path"

// Structural lock for the Settings MCP switch: the Settings host
// (`KiloProvider`) and BrowserAutomation perform connect/disconnect/add only
// through the private-only helper with zero direct SDK mutation calls. The
// single remaining direct `.mcp.disconnect(` site stays untouched: the
// env-gated E2E fixture bridge (`mcpDisconnectForFixture`).
// Behavioral proof lives in `src/kilo-provider-mcp-connection.test.ts`; this
// file only locks the call sites against future SDK fallback/retry.
const ROOT = join(import.meta.dir, "..", "..")

async function src(rel: string): Promise<string> {
  return readFile(join(ROOT, rel), "utf8")
}

function calls(text: string, method: string): number {
  return text.match(new RegExp(`\\.mcp\\.${method}\\s*\\(`, "g"))?.length ?? 0
}

describe("mcp-connection Settings call sites", () => {
  test("KiloProvider has zero direct MCP SDK mutation calls", async () => {
    const text = await src("src/KiloProvider.ts")
    expect(calls(text, "connect")).toBe(0)
    expect(calls(text, "disconnect")).toBe(0)
    expect(calls(text, "authenticate")).toBe(0)
    expect(calls(text, "add")).toBe(0)
    expect(text.match(/attemptMcpConnectPrivate/g)?.length ?? 0).toBeGreaterThan(0)
    expect(text.match(/attemptMcpDisconnectPrivate/g)?.length ?? 0).toBeGreaterThan(0)
  })

  test("only the fixture bridge keeps direct disconnect calls", async () => {
    const agent = await src("src/agent-manager/AgentManagerProvider.ts")
    const start = agent.indexOf("mcpDisconnectForFixture")
    expect(start).toBeGreaterThan(0)
    const outside = agent.slice(0, start)
    expect(calls(outside, "disconnect")).toBe(0)
    expect(calls(outside, "connect")).toBe(0)
    const auto = await src("src/services/browser-automation/browser-automation-service.ts")
    expect(calls(auto, "disconnect")).toBe(0)
    expect(calls(auto, "connect")).toBe(0)
    expect(calls(auto, "authenticate")).toBe(0)
    expect(calls(auto, "add")).toBe(0)
    expect(auto.match(/attemptMcpDisconnectPrivate/g)?.length ?? 0).toBeGreaterThan(0)
    expect(auto.match(/buildMcpDisconnectReq/g)?.length ?? 0).toBeGreaterThan(0)
    expect(auto.match(/attemptMcpAddPrivate/g)?.length ?? 0).toBeGreaterThan(0)
    expect(auto.match(/buildMcpAddReq/g)?.length ?? 0).toBeGreaterThan(0)
  })
})
