import { describe, expect, test } from "bun:test"
import { fetchFixtureVariantRealPrivateFirst } from "./fixture-variant-real-privatefirst"
import { buildAgentListReq } from "./agent-list-privatefirst"
import { buildProviderCatalogReq } from "./provider-catalog-privatefirst"

const DIR = "/tmp/fixture-variant-real"

function caps() {
  return {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  }
}

function catalogEntry(pid = "real", mid = "real-model") {
  return {
    id: pid,
    name: pid,
    source: "api",
    env: [],
    hasCredential: true,
    models: {
      [mid]: {
        id: mid,
        providerID: pid,
        api: { id: mid, url: "https://x", npm: "n" },
        name: mid,
        capabilities: caps(),
        cost: { input: 1, output: 2, cache: { read: 0, write: 0 } },
        limit: { context: 8, output: 1 },
        status: "active",
        release_date: "2024-01-01",
      },
    },
  }
}

function catalogData() {
  return { all: [catalogEntry()], default: { real: "real-model" }, connected: ["real"], failed: [] }
}

function agentEntry(name = "real-agent") {
  return { name, mode: "primary", permission: [{ permission: "edit", pattern: "*", action: "allow" }], options: {} }
}

function catalogOk(q: ReturnType<typeof buildProviderCatalogReq>, d: unknown = catalogData()) {
  return {
    v: 1,
    requestId: q.requestId,
    op: "provider/catalog",
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: d,
  }
}

function catalogTerminal(q: ReturnType<typeof buildProviderCatalogReq>) {
  const failure = { code: "validation.failed", message: "invalid provider-catalog request", retryable: false }
  return {
    v: 1,
    requestId: q.requestId,
    op: "provider/catalog",
    status: "failed",
    outcome: { type: "failed", time: 1, failure },
    accepted: false,
    failure,
  }
}

function agentsOk(q: ReturnType<typeof buildAgentListReq>, agents: unknown[] = [agentEntry()]) {
  return {
    v: 1,
    requestId: q.requestId,
    op: "agent/list",
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { agents },
  }
}

function agentsTerminal(q: ReturnType<typeof buildAgentListReq>) {
  const failure = { code: "validation.failed", message: "invalid agent-list request", retryable: false }
  return {
    v: 1,
    requestId: q.requestId,
    op: "agent/list",
    status: "failed",
    outcome: { type: "failed", time: 1, failure },
    accepted: false,
    failure,
  }
}

function connBoth(catalog: (q: never) => unknown, agents: (q: never) => unknown) {
  return {
    isPrivateAvailable: () => true,
    privateProviderCatalogOutcomeWithHandle: (q: never) => ({
      id: 1,
      promise: Promise.resolve({ kind: "valid", result: catalog(q) }),
      cancel: () => true,
    }),
    privateAgentListOutcomeWithHandle: (q: never) => ({
      id: 2,
      promise: Promise.resolve({ kind: "valid", result: agents(q) }),
      cancel: () => true,
    }),
  }
}

const injected = { id: "e2e-probe", name: "e2e-probe", variants: { low: {}, high: {} } }

describe("fixture variant real private-first", () => {
  test("private authoritative with zero SDK reads", async () => {
    let sdkCatalog = 0
    let sdkAgents = 0
    const client = {
      provider: {
        catalog: async (_a: unknown, _o: unknown) => {
          sdkCatalog += 1
          return { data: catalogData() }
        },
      },
      app: {
        agents: async () => {
          sdkAgents += 1
          return { data: [agentEntry("sdk-agent")] }
        },
      },
    }
    const out = await fetchFixtureVariantRealPrivateFirst({
      connection: connBoth((q) => catalogOk(q as never), (q) => agentsOk(q as never)) as never,
      client: client as never,
      directory: DIR,
      providerID: "kilo",
      modelID: "e2e-probe",
      injected,
    })
    expect(sdkCatalog).toBe(0)
    expect(sdkAgents).toBe(0)
    expect(out.connected).toEqual(["real"])
    expect(out.defaults).toEqual({ real: "real-model" })
    expect(out.raw["real"]).toBeDefined()
    expect(out.realAgents.map((a) => (a as { name: string }).name)).toEqual(["real-agent"])
    expect(out.selections["real-agent"]).toEqual({ providerID: "kilo", modelID: "e2e-probe" })
  })

  test("terminal closes fail-soft with zero SDK reads", async () => {
    let sdkCatalog = 0
    let sdkAgents = 0
    const client = {
      provider: {
        catalog: async () => {
          sdkCatalog += 1
          return { data: catalogData() }
        },
      },
      app: {
        agents: async () => {
          sdkAgents += 1
          return { data: [agentEntry()] }
        },
      },
    }
    const out = await fetchFixtureVariantRealPrivateFirst({
      connection: connBoth((q) => catalogTerminal(q as never), (q) => agentsTerminal(q as never)) as never,
      client: client as never,
      directory: DIR,
      providerID: "kilo",
      modelID: "e2e-probe",
      injected,
    })
    expect(sdkCatalog).toBe(0)
    expect(sdkAgents).toBe(0)
    expect(out).toEqual({ raw: {}, connected: [], defaults: {}, selections: {}, realAgents: [] })
  })

  test("fallback-eligible takes exactly one same-directory SDK read per surface", async () => {
    const seen: string[] = []
    let sdkCatalog = 0
    let sdkAgents = 0
    const client = {
      provider: {
        catalog: async (a: { directory: string }) => {
          sdkCatalog += 1
          seen.push(`catalog:${a.directory}`)
          return { data: catalogData() }
        },
      },
      app: {
        agents: async (a: { directory: string }) => {
          sdkAgents += 1
          seen.push(`agents:${a.directory}`)
          return { data: [agentEntry("sdk-agent")] }
        },
      },
    }
    const out = await fetchFixtureVariantRealPrivateFirst({
      connection: { isPrivateAvailable: () => false } as never,
      client: client as never,
      directory: DIR,
      providerID: "kilo",
      modelID: "e2e-probe",
      injected,
    })
    expect(sdkCatalog).toBe(1)
    expect(sdkAgents).toBe(1)
    expect(seen).toEqual([`catalog:${DIR}`, `agents:${DIR}`])
    expect(out.connected).toEqual(["real"])
    expect(out.realAgents.map((a) => (a as { name: string }).name)).toEqual(["sdk-agent"])
    expect(out.selections["sdk-agent"]).toEqual({ providerID: "kilo", modelID: "e2e-probe" })
  })

  test("matching provider raw entry carries the synthetic injection", async () => {
    const data = { all: [catalogEntry("kilo", "other-model")], default: {}, connected: [], failed: [] }
    const client = {
      provider: { catalog: async () => ({ data }) },
      app: { agents: async () => ({ data: [] }) },
    }
    const out = await fetchFixtureVariantRealPrivateFirst({
      connection: { isPrivateAvailable: () => false } as never,
      client: client as never,
      directory: DIR,
      providerID: "kilo",
      modelID: "e2e-probe",
      injected,
    })
    const models = (out.raw["kilo"]?.models as Record<string, unknown>) ?? {}
    expect(models["e2e-probe"]).toEqual(injected)
    expect(models["other-model"]).toBeDefined()
  })
})
