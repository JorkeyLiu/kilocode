/**
 * Legacy default-agent derivation parity on the canonical serving path
 * (KiloProvider.sendCanonicalAgents → resolveServedDefaultAgent).
 *
 * Regression context: configs WITHOUT `default_agent` produced a canonical
 * agent index whose defaultId is null, so the served payload carried
 * defaultAgent "" — the webview ModeSwitcher then rendered permanently
 * disabled. The legacy path derived the default from the first visible agent;
 * these tests prove the canonical path now mirrors that ordering faithfully,
 * real temp dirs + real materialization — no mocks.
 */

import { afterEach, describe, expect, it } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { KiloConnectionService } from "../../src/services/cli-backend/connection-service"
import { CanonicalConfigService } from "../../src/config/service"
import { Roots } from "../../src/config/paths"
import { createMemorySecretAdapter } from "../../src/config/secret-adapter"
import { createMemoryStateAdapter, createMemoryEmitterFactory } from "../../src/config/state-adapter"
import { resetVersion } from "../../src/config/materialize"
import type { AgentIndex } from "../../src/config/selectors"
import { resolveServedDefaultAgent } from "../../src/kilo-provider-utils"

const { KiloProvider } = await import("../../src/KiloProvider")

// ── Pure helper: legacy ordering semantics ────────────────────────────

function index(agents: AgentIndex["agents"], defaultId: string | null): Pick<AgentIndex, "defaultId" | "agents"> {
  return { defaultId, agents }
}

describe("resolveServedDefaultAgent", () => {
  it("serves an explicit default_agent verbatim", () => {
    const idx = index(
      [
        { id: "code", displayName: "Code", hidden: false, source: "global" },
        { id: "ask", displayName: "Ask", hidden: false, source: "global" },
      ],
      "ask",
    )
    expect(resolveServedDefaultAgent(idx)).toBe("ask")
  })

  it("derives the first non-subagent served agent when config lacks default_agent", () => {
    const idx = index(
      [
        { id: "alpha", displayName: "Alpha", mode: "subagent", hidden: false, source: "global" },
        { id: "zeta", displayName: "Zeta", mode: "primary", hidden: false, source: "global" },
      ],
      null,
    )
    expect(resolveServedDefaultAgent(idx)).toBe("zeta")
  })

  it("skips hidden entries while deriving", () => {
    const idx = index(
      [
        { id: "ghost", displayName: "Ghost", mode: "primary", hidden: true, source: "global" },
        { id: "real", displayName: "Real", mode: "primary", hidden: false, source: "global" },
      ],
      null,
    )
    expect(resolveServedDefaultAgent(idx)).toBe("real")
  })

  it("falls back to the first served entry when every agent is a subagent", () => {
    const idx = index([{ id: "reviewer", displayName: "Reviewer", mode: "subagent", hidden: false, source: "project" }], null)
    expect(resolveServedDefaultAgent(idx)).toBe("reviewer")
  })

  it("keeps \"\" only when zero agents are served", () => {
    expect(resolveServedDefaultAgent(index([], null))).toBe("")
  })
})

// ── Serving-path payload parity ───────────────────────────────────────

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

type ProviderInternals = {
  canonicalReady: boolean
  postMessage: (message: unknown) => void
  sendCanonicalAgents: () => Promise<void>
  cleanupRetries: Map<string, unknown>
}

/** Service over real temp dirs + provider wired to capture postMessage traffic. */
async function seededSetup(seedAgents: boolean): Promise<{ provider: ProviderInternals; messages: unknown[] }> {
  resetVersion()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-default-agent-"))
  dirs.push(root)
  const global = path.join(root, "xdg-config", "kilo")
  const project = path.join(root, "workspace")
  fs.mkdirSync(global, { recursive: true })
  fs.mkdirSync(path.join(project, ".kilo"), { recursive: true })
  // Intentionally NO default_agent — the fixture parity contract under test.
  fs.writeFileSync(path.join(global, "kilo.jsonc"), JSON.stringify({}), "utf8")
  if (seedAgents) {
    // Alphabetical scan order puts the subagent asset FIRST, so a faithful
    // legacy derivation must skip it for the primary agent.
    const agentDir = path.join(global, "agent")
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, "alpha.md"), ["---", "displayName: Alpha", "description: Subagent asset", "mode: subagent", "---", "", "You are Alpha.", ""].join("\n"), "utf8")
    fs.writeFileSync(path.join(agentDir, "zeta.md"), ["---", "displayName: Zeta", "description: Primary asset", "mode: primary", "---", "", "You are Zeta.", ""].join("\n"), "utf8")
  }
  const secrets = createMemorySecretAdapter()
  const canonical = new CanonicalConfigService({ secrets } as never, {
    roots: new Roots(project, global),
    secretAdapter: secrets,
    globalState: createMemoryStateAdapter(),
    workspaceState: createMemoryStateAdapter(),
    emitterFactory: createMemoryEmitterFactory(),
  })
  await canonical.initialize()
  const connection = new KiloConnectionService({} as never)
  const providerRaw = new KiloProvider({} as never, connection, undefined, { canonicalConfig: canonical })
  const messages: unknown[] = []
  const provider = providerRaw as unknown as ProviderInternals
  provider.postMessage = (message) => messages.push(message)
  return { provider, messages }
}

function agentsMsg(messages: unknown[]): Record<string, unknown> {
  return messages.find((m) => (m as Record<string, unknown>).type === "agentsLoaded") as Record<string, unknown>
}

describe("sendCanonicalAgents payload defaultAgent parity", () => {
  it("carries a valid served agent id when the config lacks default_agent", async () => {
    const { provider, messages } = await seededSetup(true)
    expect(provider.canonicalReady).toBe(true)
    await provider.sendCanonicalAgents()

    const msg = agentsMsg(messages)
    expect(msg).toBeDefined()
    const names = (msg.agents as Array<{ name: string }>).map((item) => item.name)
    expect(names.length).toBeGreaterThan(0)

    const fallback = msg.defaultAgent as string
    // Non-empty AND actually present in the served list — the exact property
    // whose absence left the real ModeSwitcher permanently disabled.
    expect(fallback.length).toBeGreaterThan(0)
    expect(names).toContain(fallback)
    // Faithful legacy ordering: the subagent asset is skipped
    // for the first primary agent, despite scanning first.
    expect(fallback).toBe("zeta")
    provider.cleanupRetries.clear()
  })

  it("keeps \"\" only when zero agents are served", async () => {
    const { provider, messages } = await seededSetup(false)
    await provider.sendCanonicalAgents()

    const msg = agentsMsg(messages)
    expect(msg).toBeDefined()
    expect(msg.agents).toEqual([])
    expect(msg.defaultAgent).toBe("")
    provider.cleanupRetries.clear()
  })
})
