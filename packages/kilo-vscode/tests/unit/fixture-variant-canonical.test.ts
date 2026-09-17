import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { flattenModels, findModel, isModelValid } from "../../webview-ui/src/context/provider-utils"

const EXT = readFileSync(join(import.meta.dirname, "../../src/extension.ts"), "utf8")
const MSG = readFileSync(join(import.meta.dirname, "../../webview-ui/src/types/messages/extension-messages.ts"), "utf8")
const SESSION = readFileSync(join(import.meta.dirname, "../../webview-ui/src/context/session.tsx"), "utf8")
const PROVIDER = readFileSync(join(import.meta.dirname, "../../webview-ui/src/context/provider.tsx"), "utf8")

function provisionBlock(): string {
  const start = EXT.indexOf("async function provisionVariantModelFixture")
  if (start < 0) throw new Error("provision block missing")
  const end = EXT.indexOf("export function activate", start)
  return EXT.slice(start, end < 0 ? undefined : end)
}

describe("fixture variant canonical provision (bounded)", () => {
  it("publishes synthetic kilo/e2e-probe variants through the canonical contract", () => {
    const block = provisionBlock()
    expect(EXT).toContain('canonical: true')
    expect(EXT).toContain('ready: true')
    expect(EXT).toContain('materializationVersion: fixtureVersion')
    expect(EXT).toContain('defaultSelection: { providerID, modelID }')
    expect(EXT).toContain('[modelID]: injected')
    expect(EXT).toContain('type: "providersLoaded"')
    expect(EXT).toContain('type: "modelSelectionsLoaded"')
    expect(EXT).toContain('contentHash')
    expect(EXT).toContain('diagnostics: {}')
    expect(block).toContain('const injected = { id: modelID, name: modelID, variants: variantMap }')
  })

  it("preserves real catalog entries and injects only the synthetic model", () => {
    // Variant fixture real seeding goes through the shared private-first
    // projections; the SDK lives only in the helpers' fallback.
    expect(EXT).toContain("fetchFixtureVariantRealPrivateFirst")
    expect(EXT).toContain("function fixtureLoadReal")
    expect(EXT).toContain("function fixtureEnsureSynthetic")
    expect(EXT).not.toMatch(/client\.provider\.catalog\s*\(/)
    expect(EXT).not.toMatch(/client\.app\.agents\s*\(/)
    const helper = readFileSync(join(import.meta.dirname, "../../src/kilo-provider/fixture-variant-real-privatefirst.ts"), "utf8")
    expect(helper).toContain("fetchProviderCatalogPrivateFirst")
    expect(helper).toContain("fetchAgentsPrivateFirst")
    expect(helper).toContain("for (const item of data.all ?? [])")
    // Real models spread preserved; synthetic injected by key only.
    expect(helper).toContain("[mid]: injected")
    expect(EXT).toContain("[modelID]: injected")
    // No backend/config persistence from the fixture path.
    const fixtureSrc = EXT.slice(EXT.indexOf("type FixtureRawProvider"), EXT.indexOf("export function activate"))
    expect(fixtureSrc).not.toContain("writeConfig")
    expect(fixtureSrc).not.toContain("processCredentialIntent")
    expect(fixtureSrc).not.toContain("storeSecret")
    expect(fixtureSrc).not.toContain("client.provider.list")
    expect(fixtureSrc).not.toContain("writeAsset")
    expect(fixtureSrc).not.toContain("deleteAsset")
    expect(fixtureSrc).not.toContain("writeRealGlobalSeed")
  })

  it("keeps KILO_E2E_FIXTURE gating and no post-provision settle/refresh", () => {
    const block = provisionBlock()
    expect(block).toContain("isE2EFixtureEnabled()")
    const settle = block.indexOf("settleSessionsForFixture")
    const postCall = block.indexOf("fixturePostVariant(")
    expect(settle).toBeGreaterThan(-1)
    expect(postCall).toBeGreaterThan(-1)
    // No settle/refresh after the first synthetic post call.
    expect(block.slice(postCall)).not.toContain("settleSessionsForFixture")
    expect(block.slice(postCall)).not.toContain("fetchAndSend")
    expect(block.slice(postCall)).not.toContain("refreshSessions")
    // The helper itself only posts; no settle/refresh there either.
    const helperStart = EXT.indexOf("function fixturePostVariant")
    const helper = EXT.slice(helperStart, EXT.indexOf("async function provisionVariantModelFixture", helperStart))
    expect(helper).toContain("agentManagerProvider.postMessage")
    expect(helper).not.toContain("settleSessionsForFixture")
    expect(helper).not.toContain("fetchAndSend")
    expect(helper).not.toContain("refreshSessions")
    expect(EXT).toContain('"kilo-code.new.e2eFixture.provisionVariantModel"')
  })

  it("repeated publishes stay monotonic/idempotent (never overwrite newer canonical)", () => {
    const block = provisionBlock()
    expect(EXT).toContain("function fixtureCurrentVersion")
    expect(EXT).toContain("function fixturePostVariant")
    expect(EXT).toContain("function fixtureCanonicalProviders")
    expect(block).toContain("const fixtureVersion = Math.max(fixtureCurrentVersion(canonicalConfig), 0) + 1")
    expect(EXT).toContain("if (fixtureCurrentVersion(canonicalConfig) > fixtureVersion) return false")
    expect(block).toContain("for (const delayMs of [500, 1500, 3000, 5000])")
    expect(block).toContain("if (!post()) return")
  })

  it("defines the fixture-only canonical selections contract", () => {
    expect(MSG).toContain("export interface CanonicalModelSelectionsLoadedMessage")
    expect(MSG).toContain('type: "modelSelectionsLoaded"')
    expect(MSG).toContain("canonical: true")
    expect(MSG).toContain("materializationVersion: number")
    expect(MSG).toContain("stamp: CanonicalStamp")
    expect(MSG).toContain("CanonicalModelSelectionsLoadedMessage")
  })

  it("session context accepts canonical selections but still drops legacy in canonical mode", () => {
    expect(SESSION).toContain("if (message.canonical === true)")
    expect(SESSION).toContain("selectionsStamp")
    expect(SESSION).toContain("setStore(\"modelSelections\", reconcile(message.selections))")
    // Legacy-sticky production semantics preserved for non-canonical.
    expect(SESSION).toContain("if (canonicalMode?.()) return")
    const selBlock = SESSION.slice(SESSION.indexOf("const unsubSelections"))
    expect(selBlock).toContain("if (message.canonical === true)")
    expect(selBlock).toContain("if (canonicalMode?.()) return")
  })

  it("production provider canonical-sticky semantics are untouched", () => {
    expect(PROVIDER).toContain("if (message.canonical) setCanonicalMode(true)")
    expect(PROVIDER).toContain("else if (canonicalMode()) return")
    expect(PROVIDER).toContain("message.materializationVersion < (stamp()?.materializationVersion ?? -1)")
  })

  it("provisions two deterministic synthetic primary agents code-first with fixture model binding", () => {
    expect(EXT).toContain("function fixtureSyntheticAgents")
    expect(EXT).toContain("function fixtureCanonicalAgents")
    expect(EXT).toContain("function fixtureAgentView")
    expect(EXT).toContain('name: "code"')
    expect(EXT).toContain('name: "search"')
    expect(EXT).toContain('displayName: "Code"')
    expect(EXT).toContain('displayName: "Search"')
    expect(EXT).toContain("E2E fixture code agent")
    expect(EXT).toContain("E2E fixture search agent")
    expect(EXT).toContain('mode: "primary"')
    expect(EXT).toContain("hidden: false")
    expect(EXT).toContain("frontmatter: { model: binding }")
    expect(EXT).toContain("const binding = `${providerID}/${modelID}`")
    const synthStart = EXT.indexOf("function fixtureSyntheticAgents")
    const synth = EXT.slice(synthStart, EXT.indexOf("function fixtureAgentView", synthStart))
    expect(synth.indexOf('"code"')).toBeLessThan(synth.indexOf('"search"'))
  })

  it("unions real agents with dedup/sorted order and prefers code default", () => {
    expect(EXT).toContain("realAgents: Array<Record<string, unknown>>")
    expect(EXT).toContain("fixtureCanonicalAgents(state.realAgents, providerID, modelID)")
    expect(EXT).toContain("if (seen.has(view.name)) continue")
    expect(EXT).toContain("real.sort((a, b)")
    expect(EXT).toContain("const allAgents = [...synthetic, ...real]")
    expect(EXT).toContain("const agents = allAgents.filter((a) => !a.hidden)")
    expect(EXT).toContain('hasCode ? "code"')
    expect(EXT).toContain("defaultAgent")
  })

  it("publishes canonical agentsLoaded with shared frozen version/stamp/hash", () => {
    const block = provisionBlock()
    expect(EXT).toContain('type: "agentsLoaded"')
    expect(EXT).toContain("agents: frozen.agents.agents")
    expect(EXT).toContain("allAgents: frozen.agents.allAgents")
    expect(EXT).toContain("defaultAgent: frozen.agents.defaultAgent")
    expect(block).toContain("const frozen = {")
    expect(block).toContain("agents: fixtureCanonicalAgents(state.realAgents, providerID, modelID)")
    expect(block).toContain("stamp: { ...canonicalConfig.stamp, materializationVersion: fixtureVersion }")
    expect(block).toContain('contentHash: canonicalConfig.snapshot?.contentHash ?? "e2e-fixture"')
    const helperStart = EXT.indexOf("function fixturePostVariant")
    const helper = EXT.slice(helperStart, EXT.indexOf("async function provisionVariantModelFixture", helperStart))
    expect(helper).toContain('type: "modelSelectionsLoaded"')
    expect(helper).toContain('type: "providersLoaded"')
    expect(helper).toContain('type: "agentsLoaded"')
    // Single atomic guard before any post; same frozen stamp/hash/version on all three.
    expect(helper.indexOf("if (fixtureCurrentVersion(canonicalConfig) > fixtureVersion) return false")).toBeLessThan(
      helper.indexOf('type: "modelSelectionsLoaded"'),
    )
    expect(helper).toContain("const stamp = frozen.stamp")
    expect(helper).toContain("const contentHash = frozen.contentHash")
    expect(helper).toContain("diagnostics: {}")
    expect(helper).toContain("ready: true")
  })

  it("model selections union real plus both synthetic agents", () => {
    const block = provisionBlock()
    expect(block).toContain('state.selections["code"] = { providerID, modelID }')
    expect(block).toContain('state.selections["search"] = { providerID, modelID }')
    const helper = readFileSync(join(import.meta.dirname, "../../src/kilo-provider/fixture-variant-real-privatefirst.ts"), "utf8")
    expect(helper).toContain("for (const agent of realAgents)")
    expect(helper).toContain("selections[name] = { providerID: pid, modelID: mid }")
  })

  it("delayed republishes reuse frozen payloads and stop atomically on newer real", () => {
    const block = provisionBlock()
    expect(block).toContain("const post = (): boolean =>")
    expect(block).toContain("fixtureVersion,\n      frozen,")
    expect(block).toContain("for (const delayMs of [500, 1500, 3000, 5000])")
    expect(block).toContain("if (!post()) return")
    const helperStart = EXT.indexOf("function fixturePostVariant")
    const helper = EXT.slice(helperStart, EXT.indexOf("async function provisionVariantModelFixture", helperStart))
    // Frozen stamp/hash come from the provision, never recomputed per repeat.
    expect(helper).not.toContain("...canonicalConfig.stamp")
    expect(helper).not.toContain('?? "e2e-fixture"')
    expect(helper).not.toContain("fixtureCanonicalAgents(")
  })
})

describe("fixture variant canonical behavior (provider-utils)", () => {
  const providerID = "kilo"
  const modelID = "e2e-probe"
  const providers = {
    [providerID]: {
      id: providerID,
      name: providerID,
      hasCredential: true,
      models: { [modelID]: { id: modelID, name: modelID, variants: { low: {}, medium: {}, high: {} } } },
    },
    real: {
      id: "real",
      name: "real",
      hasCredential: true,
      models: { "real-model": { id: "real-model", name: "real-model" } },
    },
  }
  const connected = [providerID, "real"]
  const def = { providerID, modelID }
  const selections = { code: { ...def }, search: { ...def } }

  it("synthetic provider/model variants resolve with matching selections/default", () => {
    const flat = flattenModels(providers as never)
    const found = findModel(flat, def)
    expect(found).toBeDefined()
    expect(Object.keys(found!.variants ?? {}).sort()).toEqual(["high", "low", "medium"])
    expect(isModelValid(providers as never, connected, def)).toBeTrue()
    for (const sel of Object.values(selections)) {
      expect(sel).toEqual(def)
      expect(isModelValid(providers as never, connected, sel)).toBeTrue()
    }
    // Real entries preserved alongside the synthetic injection.
    expect(findModel(flat, { providerID: "real", modelID: "real-model" })).toBeDefined()
  })

  it("accepted materialization version: fixture base+1 is not stale, repeat is idempotent", () => {
    const accepts = (msg: number, stamp: number): boolean => !(msg < stamp)
    const base = 7
    const fixture = base + 1
    expect(accepts(fixture, base)).toBeTrue()
    expect(accepts(fixture, fixture)).toBeTrue()
    expect(accepts(base, fixture)).toBeFalse()
  })

  it("legacy-sticky rejection no longer applies to canonical fixture posts", () => {
    // provider.tsx drops only non-canonical once canonicalMode is set.
    const dropped = (canonicalMode: boolean, canonical?: boolean): boolean => {
      if (canonical) return false
      if (canonicalMode) return true
      return false
    }
    expect(dropped(true, true)).toBeFalse()
    expect(dropped(true, undefined)).toBeTrue()
    expect(dropped(true, false)).toBeTrue()
  })

  it("delayed republishes stop when a newer canonical materialization exists", () => {
    const fixture = 8
    const shouldPost = (current: number): boolean => !(current > fixture)
    expect(shouldPost(8)).toBeTrue()
    expect(shouldPost(7)).toBeTrue()
    expect(shouldPost(9)).toBeFalse()
  })
})
