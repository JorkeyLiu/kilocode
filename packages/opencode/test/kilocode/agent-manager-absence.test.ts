import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

// P3.2: the orphaned `agent_manager` list/prompt request-reply contract is
// removed. Only the root-local `kilocode.agent_manager.start` event survives.
// These static guards assert the removal holds across source, HTTP group, and
// the regenerated SDK, so no dead request/reply/list surface can sneak back.
const opencode = join(import.meta.dir, "../../src")

function read(path: string): string {
  return readFileSync(path, "utf8")
}

describe("agent_manager orphaned contract absence", () => {
  test("agent-manager module holds only the start event", () => {
    const dir = join(opencode, "kilocode/agent-manager")
    const entries = readdirSync(dir)
    expect(entries).toContain("event.ts")
    expect(entries).not.toContain("protocol.ts")
    expect(entries).not.toContain("service.ts")
  })

  test("no agent-manager request service layer remains wired", () => {
    const app = read(join(opencode, "effect/app-runtime.ts"))
    const toolRegistry = read(join(opencode, "tool/registry.ts"))
    const kiloToolRegistry = read(join(opencode, "kilocode/tool/registry.ts"))
    expect(app).not.toContain("agent-manager/service")
    expect(app).not.toContain("AgentManager.defaultLayer")
    expect(toolRegistry).not.toContain("agent-manager/service")
    expect(toolRegistry).not.toContain("AgentManager.defaultLayer")
    expect(kiloToolRegistry).not.toContain("agent-manager/service")
    expect(kiloToolRegistry).not.toContain("AgentManager.Service")
  })

  test("no agent-manager request/reply/reject HTTP endpoints remain", () => {
    const group = read(join(opencode, "kilocode/server/httpapi/groups/kilocode.ts"))
    const handlers = read(join(opencode, "kilocode/server/httpapi/handlers/kilocode.ts"))
    for (const surface of ["agentManagerList", "agentManagerReply", "agentManagerReject"]) {
      expect(group).not.toContain(surface)
      expect(handlers).not.toContain(surface)
    }
    expect(group).not.toContain("agent-manager/protocol")
    expect(handlers).not.toContain("agent-manager/protocol")
  })

  test("regenerated SDK keeps only the start event and drops request/reply surfaces", () => {
    const types = read(join(import.meta.dir, "../../../sdk/js/src/v2/gen/types.gen.ts"))
    const sdk = read(join(import.meta.dir, "../../../sdk/js/src/v2/gen/sdk.gen.ts"))
    expect(types).toContain("kilocode.agent_manager.start")
    for (const stale of [
      "kilocode.agent_manager.requested",
      "kilocode.agent_manager.cancelled",
      "AgentManagerOverviewRequest",
      "AgentManagerPromptRequest",
      "AgentManagerRequest",
      "AgentManagerOverviewResult",
      "AgentManagerPromptResult",
      "AgentManagerResult",
    ]) {
      expect(types).not.toContain(stale)
    }
    for (const stale of ["AgentManagerList", "AgentManagerReply", "AgentManagerReject"]) {
      expect(sdk).not.toContain(stale)
      expect(types).not.toContain(`Kilocode${stale}Data`)
    }
  })

  test("start-only tool schema exposes only the tasks array", () => {
    const tool = read(join(opencode, "kilocode/tool/agent-manager.ts"))
    const events = read(join(opencode, "kilocode/agent-manager/event.ts"))
    expect(events).toContain("kilocode.agent_manager.start")
    expect(tool).toContain("AgentManagerEvent.Start")
    for (const stale of ["ListParams", "PromptParams", "operation: \"overview\"", "operation: \"prompt\""]) {
      expect(tool).not.toContain(stale)
    }
  })
})
