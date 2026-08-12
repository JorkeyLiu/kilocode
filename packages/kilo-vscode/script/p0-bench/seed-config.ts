/**
 * P0 benchmark seeded config fixtures (truthful scratch XDG kilo configs).
 *
 * Pure builders — no I/O, no VS Code imports — shared by the campaign script
 * (script/e2e-p0-bench.ts) and the production-schema conformance test
 * (packages/opencode/test/kilocode/p0-bench-seed-config-schema.test.ts) so
 * the exact seeded fixture is validated against the production config schema,
 * never a copy. The custom-provider seed is scenario 4's fixture: one
 * user-defined OpenAI-compatible provider with one model and a loopback URL.
 */
import { join } from "node:path"
import type { ScenarioID } from "./types"

/**
 * Build the seeded scratch XDG kilo config object for a scenario, or null when
 * the scenario seeds nothing (cold-start / warm-view / session-switch).
 */
export function seedConfigFor(
  id: ScenarioID,
  scratch: string,
  mcpFixturePath: string,
  mcpAgents: number,
): Record<string, unknown> | null {
  if (id === "no-provider") {
    return { provider: {}, agent: {} }
  }
  if (id === "custom-provider") {
    return {
      provider: {
        "p0-custom": {
          npm: "@ai-sdk/openai-compatible",
          name: "P0 Custom Provider",
          options: { baseURL: "http://127.0.0.1:9", apiKey: "p0-bench-key" },
          models: {
            // Production model schema requires BOTH limit.context and
            // limit.output (see packages/core/src/v1/config/provider.ts).
            "p0-custom-model": { name: "P0 Custom Model", limit: { context: 128000, output: 32768 } },
          },
        },
      },
    }
  }
  if (id === "many-agent-mcp") {
    const agents: Record<string, unknown> = {}
    for (let i = 1; i <= mcpAgents; i++) {
      const key = `p0-agent-${String(i).padStart(2, "0")}`
      agents[key] = {
        description: `P0 benchmark agent ${i}`,
        prompt: `You are P0 benchmark agent ${i}.`,
        mode: "primary",
      }
    }
    return {
      agent: agents,
      mcp: {
        "p0-bench-mcp": {
          type: "local",
          command: ["node", mcpFixturePath],
          environment: { P0_MCP_MARKER: join(scratch, "mcp-connected") },
          enabled: true,
        },
      },
    }
  }
  return null
}
