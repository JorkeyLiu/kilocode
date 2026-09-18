import { describe, expect, test } from "bun:test"
import { readFile } from "fs/promises"
import { join } from "path"

// Structural proof that the three production MCP status readers plus the
// env-gated E2E fixture disconnect bridge go through the shared
// private-authority helper. No path — production or fixture — may call
// `.mcp.status(` directly. The fixture bridge (`mcpDisconnectForFixture`)
// owns its exact MCP child lifecycle as a test control action through the
// same shared status authority. The shared helper itself must also contain
// zero direct SDK status calls.
const ROOT = join(import.meta.dir, "..", "..")

async function src(rel: string): Promise<string> {
  return readFile(join(ROOT, rel), "utf8")
}

function directCalls(text: string): number {
  return text.match(/\.mcp\.status\s*\(/g)?.length ?? 0
}

function helperRefs(text: string): number {
  return text.match(/fetchMcpStatusPrivate\b/g)?.length ?? 0
}

function legacyRefs(text: string): number {
  return text.match(/fetchMcpStatusPrivateFirst/g)?.length ?? 0
}

function fixtureBody(text: string): string {
  const start = text.indexOf("mcpDisconnectForFixture")
  if (start < 0) return ""
  const rest = text.slice(start)
  const endRel = rest.search(/\n  (public|private|protected) /)
  return endRel < 0 ? rest : rest.slice(0, endRel)
}

describe("mcp-status production call sites", () => {
  test("shared helper is private-authority with zero direct SDK calls", async () => {
    const text = await src("src/kilo-provider/mcp-status-private.ts")
    expect(text).toContain("fetchMcpStatusPrivate")
    expect(legacyRefs(text)).toBe(0)
    expect(directCalls(text)).toBe(0)
    expect(text).not.toContain("coerceSdkStatus")
  })

  test("KiloProvider status fetch goes through the shared helper with zero direct SDK calls", async () => {
    const text = await src("src/KiloProvider.ts")
    expect(helperRefs(text)).toBeGreaterThan(0)
    expect(legacyRefs(text)).toBe(0)
    expect(directCalls(text)).toBe(0)
  })

  test("Agent Manager snapshot and fixture bridge go through the shared helper with zero SDK calls", async () => {
    const text = await src("src/agent-manager/AgentManagerProvider.ts")
    expect(helperRefs(text)).toBeGreaterThan(0)
    expect(legacyRefs(text)).toBe(0)
    expect(directCalls(text)).toBe(0)
    expect(fixtureBody(text)).toContain("fetchMcpStatusPrivate")
  })

  test("agent-manager warmup delegates to the shared helper with zero direct SDK calls", async () => {
    const text = await src("src/agent-manager/mcp-warmup.ts")
    expect(helperRefs(text)).toBeGreaterThan(0)
    expect(legacyRefs(text)).toBe(0)
    expect(directCalls(text)).toBe(0)
  })
})
