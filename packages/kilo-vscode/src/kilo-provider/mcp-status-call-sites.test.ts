import { describe, expect, test } from "bun:test"
import { readFile } from "fs/promises"
import { join } from "path"

// Structural proof that the three production MCP status readers go through
// the shared private-first helper. This asserts the specific call expression
// (not a whole-file snapshot): each file must reference the helper, and no
// production path may call `.mcp.status(` directly. The single allowlisted
// exception is the env-gated E2E fixture bridge
// (`mcpDisconnectForFixture`), which owns its exact MCP child lifecycle.
const ROOT = join(import.meta.dir, "..", "..")

async function src(rel: string): Promise<string> {
  return readFile(join(ROOT, rel), "utf8")
}

function directCalls(text: string): number {
  return text.match(/\.mcp\.status\s*\(/g)?.length ?? 0
}

function helperRefs(text: string): number {
  return text.match(/fetchMcpStatusPrivateFirst/g)?.length ?? 0
}

function withoutFixtureBridge(text: string): { inside: number; outside: number } {
  const start = text.indexOf("mcpDisconnectForFixture")
  if (start < 0) return { inside: 0, outside: directCalls(text) }
  const rest = text.slice(start)
  const endRel = rest.search(/\n  (public|private|protected) /)
  const body = endRel < 0 ? rest : rest.slice(0, endRel)
  const outside = text.slice(0, start) + (endRel < 0 ? "" : rest.slice(endRel))
  return { inside: directCalls(body), outside: directCalls(outside) }
}

describe("mcp-status production call sites", () => {
  test("KiloProvider status fetch goes through the shared helper with zero direct SDK calls", async () => {
    const text = await src("src/KiloProvider.ts")
    expect(helperRefs(text)).toBeGreaterThan(0)
    expect(directCalls(text)).toBe(0)
  })

  test("Agent Manager backend snapshot goes through the shared helper; only the fixture bridge keeps SDK calls", async () => {
    const text = await src("src/agent-manager/AgentManagerProvider.ts")
    expect(helperRefs(text)).toBeGreaterThan(0)
    const { inside, outside } = withoutFixtureBridge(text)
    expect(inside).toBeGreaterThan(0)
    expect(outside).toBe(0)
  })

  test("agent-manager warmup delegates to the shared helper with zero direct SDK calls", async () => {
    const text = await src("src/agent-manager/mcp-warmup.ts")
    expect(helperRefs(text)).toBeGreaterThan(0)
    expect(directCalls(text)).toBe(0)
  })
})
