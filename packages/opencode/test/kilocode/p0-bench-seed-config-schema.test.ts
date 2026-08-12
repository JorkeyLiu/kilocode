/**
 * Production-schema conformance for the P0 benchmark seeded config fixtures
 * (scenarios 3/4/5).
 *
 * The harness seeds scratch XDG kilo configs through the shared pure builder
 * script/p0-bench/seed-config.ts (packages/kilo-vscode). This test validates
 * the EXACT seeded fixtures against the production config schema
 * (ConfigV1.Info) so a schema drift — like the scenario-4 defect where the
 * custom-provider model seed omitted the required `limit.output` — fails here
 * with a clear decode error instead of crashing a full VS Code campaign. No
 * production logic is duplicated: the fixture and the schema are both the real
 * artifacts.
 *
 * Run: `bun test test/kilocode/p0-bench-seed-config-schema.test.ts` from
 * packages/opencode/.
 */
import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { seedConfigFor } from "../../../kilo-vscode/script/p0-bench/seed-config"

const decode = Schema.decodeUnknownSync(ConfigV1.Info)

const SCRATCH = "/tmp/p0-bench-schema-test"
const MCP = "/ws/packages/kilo-vscode/script/p0-bench/mcp-fixture.mjs"

function withoutOutputLimit(fixture: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(fixture) as {
    provider: Record<string, { models: Record<string, { limit: Record<string, number> }> }>
  }
  delete copy.provider["p0-custom"].models["p0-custom-model"].limit["output"]
  return copy
}

describe("P0 seeded config fixtures conform to the production config schema", () => {
  it("custom-provider (scenario 4) decodes with a finite output limit", () => {
    const fixture = seedConfigFor("custom-provider", SCRATCH, MCP, 0)
    expect(fixture).not.toBeNull()
    const decoded = decode(fixture)
    const model = decoded.provider?.["p0-custom"]?.models?.["p0-custom-model"]
    expect(model?.name).toBe("P0 Custom Model")
    expect(model?.limit?.context).toBe(128000)
    expect(model?.limit?.output).toBe(32768)
  })

  it("custom-provider without limit.output is rejected (the scenario-4 defect)", () => {
    const fixture = seedConfigFor("custom-provider", SCRATCH, MCP, 0)
    expect(fixture).not.toBeNull()
    expect(() => decode(withoutOutputLimit(fixture!))).toThrow()
  })

  it("no-provider (scenario 3) decodes", () => {
    expect(() => decode(seedConfigFor("no-provider", SCRATCH, MCP, 0))).not.toThrow()
  })

  it("many-agent-mcp (scenario 5) decodes", () => {
    expect(() => decode(seedConfigFor("many-agent-mcp", SCRATCH, MCP, 8))).not.toThrow()
  })
})
