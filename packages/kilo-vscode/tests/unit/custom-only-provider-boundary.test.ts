import { afterEach, describe, expect, it } from "bun:test"
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync as readBin, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  buildCustomAddList,
  buildCustomConfiguredList,
  CUSTOM_ONLY_UNSUPPORTED,
  isCustomOnlyConfigured,
} from "../../webview-ui/src/components/settings/provider-tab-helpers"
import type { Provider } from "../../webview-ui/src/types/messages"
import { KiloConnectionService } from "../../src/services/cli-backend/connection-service"
import { CanonicalConfigService } from "../../src/config/service"
import { Roots } from "../../src/config/paths"
import { createMemorySecretAdapter } from "../../src/config/secret-adapter"
import { createMemoryStateAdapter } from "../../src/config/state-adapter"

const { KiloProvider } = await import("../../src/KiloProvider")

const ROOT = resolve(import.meta.dir, "../..")
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8")
}

function makeProviderItem(id: string, name: string, source?: string): Provider {
  const p: Provider = { id, name, models: {} }
  if (source) (p as Record<string, unknown>).source = source
  return p
}

describe("custom-only helpers", () => {
  it("keeps only custom configured providers", () => {
    const all = {
      anthropic: makeProviderItem("anthropic", "Anthropic", "api"),
      mycustom: makeProviderItem("mycustom", "My Custom", "custom"),
    }
    const list = buildCustomConfiguredList(all, ["anthropic"], new Set(), { mycustom: { npm: "@ai-sdk/openai-compatible" } }, { anthropic: "api" })
    expect(list.map((p) => p.id)).toEqual(["mycustom"])
  })

  it("lists canonical shape custom entries (endpoint+protocol, source custom)", () => {
    const all = {
      anthropic: makeProviderItem("anthropic", "Anthropic", "api"),
      mycustom: makeProviderItem("mycustom", "My Custom", "custom"),
    }
    const cfg = {
      mycustom: { name: "My Custom", endpoint: "https://example.com/v1", protocol: "openai/completions" },
    }
    const list = buildCustomConfiguredList(all, [], new Set(), cfg, {})
    expect(list.map((p) => p.id)).toEqual(["mycustom"])
  })

  it("lists canonical source-custom providers even without a config entry", () => {
    const all = {
      mycustom: makeProviderItem("mycustom", "My Custom", "custom"),
    }
    const list = buildCustomConfiguredList(all, ["mycustom"], new Set(), undefined, {})
    expect(list.map((p) => p.id)).toEqual(["mycustom"])
  })

  it("hides built-in rows in canonical custom-only mode", () => {
    const all = {
      anthropic: makeProviderItem("anthropic", "Anthropic", "api"),
      openai: makeProviderItem("openai", "OpenAI", "api"),
    }
    const list = buildCustomConfiguredList(all, ["anthropic", "openai"], new Set(), undefined, { anthropic: "api" })
    expect(list).toEqual([])
  })

  it("keeps legacy npm custom shape compatible", () => {
    const all = {
      legacycustom: makeProviderItem("legacycustom", "Legacy Custom", "config"),
    }
    const cfg = { legacycustom: { name: "Legacy Custom", npm: "@ai-sdk/anthropic" } }
    const list = buildCustomConfiguredList(all, [], new Set(), cfg, {})
    expect(list.map((p) => p.id)).toEqual(["legacycustom"])
  })

  it("never treats reserved internal IDs as custom", () => {
    const all = {
      kilo: makeProviderItem("kilo", "Kilo", "custom"),
      _custom: makeProviderItem("_custom", "Synthetic", "custom"),
      "anaconda-desktop": makeProviderItem("anaconda-desktop", "Local", "custom"),
    }
    const cfg = {
      kilo: { name: "Kilo", endpoint: "https://example.com/v1", protocol: "openai/completions" },
      _custom: { name: "Synthetic", endpoint: "https://example.com/v1", protocol: "openai/completions" },
      "anaconda-desktop": { name: "Local", endpoint: "https://example.com/v1", protocol: "openai/completions" },
    }
    const list = buildCustomConfiguredList(all, ["kilo", "_custom", "anaconda-desktop"], new Set(), cfg, {})
    expect(list).toEqual([])
  })

  it("returns an empty add list for built-in providers", () => {
    expect(buildCustomAddList()).toEqual([])
  })

  it("exposes a custom-only unsupported message", () => {
    expect(CUSTOM_ONLY_UNSUPPORTED).toContain("custom")
  })

  it("matches isCustomConfigured semantics", () => {
    const cfg = { mycustom: { npm: "@ai-sdk/openai-compatible" } }
    expect(isCustomOnlyConfigured(makeProviderItem("mycustom", "My Custom", "custom"), cfg)).toBe(true)
    expect(isCustomOnlyConfigured(makeProviderItem("anthropic", "Anthropic", "api"), cfg)).toBe(false)
  })
})

describe("custom-only webview surface", () => {
  it("ProvidersTab renders only custom configured providers with a notice", () => {
    const src = read("webview-ui/src/components/settings/ProvidersTab.tsx")
    expect(src).toContain("buildCustomConfiguredList")
    expect(src).toContain("buildCustomAddList")
    expect(src).toContain("CUSTOM_ONLY_UNSUPPORTED")
    expect(src).not.toContain("ProviderConnectDialog")
  })

  it("ProvidersTab viewAll stays as the custom-only entry point", () => {
    const src = read("webview-ui/src/components/settings/ProvidersTab.tsx")
    expect(src).toContain("viewAll")
    expect(src).toContain("ProviderSelectDialog")
  })

  it("ProviderSelectDialog offers only the custom entry", () => {
    const src = read("webview-ui/src/components/settings/ProviderSelectDialog.tsx")
    expect(src).toContain("CUSTOM_PROVIDER_ID")
    expect(src).toContain("CUSTOM_ONLY_UNSUPPORTED")
    expect(src).not.toContain("ProviderConnectDialog")
    expect(src).not.toContain("available.map")
  })

  it("ProviderConnectDialog keeps custom form with provider OAuth removed", () => {
    const src = read("webview-ui/src/components/settings/ProviderConnectDialog.tsx")
    expect(src).toContain("CUSTOM_ONLY_UNSUPPORTED")
    expect(src).toContain("<Match when={true}>")
    expect(src).toContain("credentialRequested: true")
    expect(src).toContain("provider-connect-byok")
    expect(src).not.toContain("authorizeProviderOAuth")
    expect(src).not.toContain("completeProviderOAuth")
    expect(src).not.toContain("providerOAuthReady")
    expect(src).not.toContain("onOAuthReady")
    expect(src).not.toContain("oauthOnly")
  })

  it("ProviderConnectDialog webview Anaconda dead leaf stays deleted", () => {
    const src = read("webview-ui/src/components/settings/ProviderConnectDialog.tsx")
    expect(src).not.toContain("AnacondaDesktopDialog")
    expect(src).not.toContain("!CUSTOM_ONLY")
    expect(src).not.toContain('props.providerID === "anaconda-desktop"')
    expect(src).not.toContain("anacondaDesktop")
    expect(existsSync(resolve(ROOT, "webview-ui/src/components/settings/AnacondaDesktopDialog.tsx"))).toBe(false)
    expect(existsSync(resolve(ROOT, "webview-ui/src/utils/anaconda-desktop-action.ts"))).toBe(false)
    expect(existsSync(resolve(ROOT, "webview-ui/src/stories/anaconda-desktop.stories.tsx"))).toBe(false)
  })

  it("ProfileView hides sign-in actions and keeps only the unavailable notice", () => {
    const src = read("webview-ui/src/components/profile/ProfileView.tsx")
    expect(src).toContain("CUSTOM_ONLY")
    expect(src).toContain("temporarily unavailable")
    expect(src).toContain("if (CUSTOM_ONLY) return")
    expect(src).toContain("CUSTOM_ONLY_PROFILE_MESSAGE")
    expect(src).not.toContain("disabled title={CUSTOM_ONLY_PROFILE_MESSAGE}")
    expect(src).not.toMatch(/variant="primary" disabled/)
  })

  it("speech-to-text shows no sign-in action in custom-only mode", () => {
    const src = read("webview-ui/src/components/speech-to-text/useSpeechToText.ts")
    expect(src).toContain("CUSTOM_ONLY")
    expect(src).toContain("common.dismiss")
    const guard = src.indexOf("if (CUSTOM_ONLY)")
    expect(guard).toBeGreaterThan(-1)
    const customBlock = src.slice(guard, guard + 300)
    expect(customBlock).not.toContain("common.signIn")
    expect(customBlock).toContain("common.dismiss")
    expect(src).toContain("common.signIn")
  })

  it("server context no longer posts login from the webview", () => {
    const src = read("webview-ui/src/context/server.tsx")
    expect(src).not.toMatch(/vscode\.postMessage\(\{ type: "login"/)
  })

  it("error surfaces hide built-in connect/login entries", () => {
    const src = read("webview-ui/src/components/chat/ErrorDisplay.tsx")
    expect(src).toContain("CUSTOM_ONLY")
    expect(src).toContain("if (CUSTOM_ONLY) return")
  })
})

describe("custom-only canonical UI behavior (B1/B2)", () => {
  it("custom edit opens without a canonical blockade", () => {
    const src = read("webview-ui/src/components/settings/ProvidersTab.tsx")
    expect(src).toContain("onClick={() => editProvider(item)}")
    expect(src).not.toContain("if (!canonicalMode()) editProvider(item)")
  })

  it("custom delete confirm opens in any mode and sends canonical-only with stamp guards", () => {
    const src = read("webview-ui/src/components/settings/ProvidersTab.tsx")
    const head = src.slice(src.indexOf("function deleteCustom"), src.indexOf("function deleteCustom") + 400)
    expect(head).not.toContain("if (canonicalMode()) return")
    expect(head).toContain("dialog.show(")
    expect(src).toContain('{ type: "deleteCustomProvider", providerID, canonical: true, stamp }')
    expect(src).toContain("Provider mutations are canonical-only")
  })

  it("custom trash button is not disabled by canonical mode", () => {
    const src = read("webview-ui/src/components/settings/ProvidersTab.tsx")
    const at = src.indexOf('icon="close"')
    expect(at).toBeGreaterThan(-1)
    const block = src.slice(at, at + 400)
    expect(block).toContain("onClick={() => deleteCustom(item.id, item.name)}")
    expect(block).not.toContain("disabled")
  })

  it("Add Custom opens CustomProviderDialog without a canonical blockade", () => {
    const src = read("webview-ui/src/components/settings/ProvidersTab.tsx")
    expect(src).toContain("onClick={() => dialog.show(() => <CustomProviderDialog />)}")
    expect(src).not.toContain("if (!canonicalMode()) dialog.show(() => <CustomProviderDialog />)")
  })

  it("viewAll opens ProviderSelectDialog without a canonical blockade and the dialog stays custom-only", () => {
    const src = read("webview-ui/src/components/settings/ProvidersTab.tsx")
    expect(src).toContain("onClick={() => dialog.show(() => <ProviderSelectDialog />)}")
    expect(src).not.toContain("if (!canonicalMode()) dialog.show(() => <ProviderSelectDialog />)")
    const dialog = read("webview-ui/src/components/settings/ProviderSelectDialog.tsx")
    expect(dialog).not.toContain("canonicalMode")
    expect(dialog).toContain("CUSTOM_PROVIDER_ID")
    expect(dialog).toContain("<CustomProviderDialog onBack=")
  })

  it("built-in connect/manage entries stay unavailable", () => {
    const src = read("webview-ui/src/components/settings/ProvidersTab.tsx")
    expect(src).toContain("CUSTOM_ONLY_UNSUPPORTED")
    // Built-in primary slots and the enable switch keep their canonical gates.
    expect(src).toContain("if (!canonicalMode()) connectChatGPT(item)")
    expect(src).toContain("if (!canonicalMode()) connectProvider(item)")
    expect(src).toContain("if (!canonicalMode()) toggleProvider(item.id)")
  })

  it("CustomProviderDialog submit stays canonical-only with stamp and canonical payload", () => {
    const src = read("webview-ui/src/components/settings/CustomProviderDialog.tsx")
    expect(src).toContain("Provider mutations are canonical-only")
    expect(src).toContain("serializeCanonicalProvider(form)")
    expect(src).toContain("canonical: true as const")
    expect(src).toContain("stamp: currentStamp")
  })
})

describe("custom-only canonical configured round-trip (helper + host)", () => {
  it("a canonical configured custom is listed by helpers and deletable via the host", async () => {
    const all = {
      anthropic: makeProviderItem("anthropic", "Anthropic", "api"),
      mycustom: makeProviderItem("mycustom", "My Custom", "custom"),
    }
    const cfg = {
      anthropic: { name: "Anthropic" },
      mycustom: { name: "My Custom", endpoint: "https://example.com/v1", protocol: "openai/completions" },
    }
    const list = buildCustomConfiguredList(all, ["anthropic"], new Set(), cfg, { anthropic: "api" })
    expect(list.map((p) => p.id)).toEqual(["mycustom"])
    expect(isCustomOnlyConfigured(makeProviderItem("mycustom", "My Custom", "custom"), cfg)).toBe(true)

    const { canonical } = await setupCanonical({ provider: cfg })
    const { host, messages } = makeCanonicalHost(canonical)
    await host.handleCanonicalProviderAction({
      type: "deleteCustomProvider",
      providerID: "mycustom",
      requestId: "r-canonical-listed-delete",
      canonical: true,
      stamp: canonical.stamp,
    })
    const deleted = messages.find((m) => (m as Record<string, unknown>).type === "providerDeleted")
    expect(deleted).toBeDefined()
    host.dispose()
    canonical.dispose()
  })

  it("canonical custom add then edit round-trips name/endpoint/protocol through helpers and host", async () => {
    const { canonical, globalFile } = await setupCanonical({ provider: {} })
    const { host, messages } = makeCanonicalHost(canonical)
    await host.handleCanonicalProviderAction({
      type: "saveCustomProvider",
      providerID: "editflow",
      requestId: "r-add-editflow",
      canonical: true,
      stamp: canonical.stamp,
      config: { name: "Flow", endpoint: "https://example.com/v1", protocol: "openai/completions", models: { m1: { name: "M1" } } },
    })
    expect(messages.find((m) => (m as Record<string, unknown>).type === "providerConnected")).toBeDefined()
    expect(readBin(globalFile, "utf8")).toContain("editflow")
    messages.length = 0
    // Edit keeps the same providerID with renamed name/endpoint/protocol.
    await host.handleCanonicalProviderAction({
      type: "saveCustomProvider",
      providerID: "editflow",
      requestId: "r-edit-editflow",
      canonical: true,
      stamp: canonical.stamp,
      config: { name: "Flow Renamed", endpoint: "https://edited.example.com/v1", protocol: "anthropic/messages", models: { m1: { name: "M1" } } },
    })
    const edited = messages.find((m) => (m as Record<string, unknown>).type === "providerConnected")
    expect(edited).toBeDefined()
    const persisted = readBin(globalFile, "utf8")
    expect(persisted).toContain("Flow Renamed")
    expect(persisted).toContain("https://edited.example.com/v1")
    expect(persisted).toContain("anthropic/messages")
    // The edited entry is still listed as a custom configured provider.
    const all = { editflow: makeProviderItem("editflow", "Flow Renamed", "custom") }
    const cfg = JSON.parse(persisted).provider
    expect(buildCustomConfiguredList(all, [], new Set(), cfg, {}).map((p) => p.id)).toEqual(["editflow"])
    expect(isCustomOnlyConfigured(makeProviderItem("editflow", "Flow Renamed", "custom"), cfg)).toBe(true)
    host.dispose()
    canonical.dispose()
  })
})

type Host = {
  postMessage: (message: unknown) => void
  handleProviderAction: (msg: Record<string, unknown>) => Promise<void>
  handleFetchCustomProviderModels: (msg: Record<string, unknown>) => Promise<void>
  handleCanonicalProviderAction: (msg: Record<string, unknown>) => Promise<void>
  dispose: () => void
}

function makeHost(client: unknown) {
  const connection = new KiloConnectionService({} as never)
  ;(connection as unknown as { getClient: () => unknown }).getClient = () => client as never
  const host = new KiloProvider({} as never, connection, undefined, {}) as unknown as Host
  const messages: unknown[] = []
  host.postMessage = (message) => messages.push(message)
  return { host, messages, connection }
}

type CanonicalHarness = {
  canonical: CanonicalConfigService
  secrets: ReturnType<typeof createMemorySecretAdapter>
  globalDir: string
  globalFile: string
}

async function setupCanonical(globalConfig: Record<string, unknown>): Promise<CanonicalHarness> {
  const root = mkdtempSync(join(tmpdir(), "kilo-custom-only-"))
  dirs.push(root)
  const globalDir = join(root, "global")
  const project = join(root, "project")
  mkdirSync(globalDir, { recursive: true })
  mkdirSync(join(project, ".kilo"), { recursive: true })
  const globalFile = join(globalDir, "kilo.jsonc")
  writeFileSync(globalFile, JSON.stringify(globalConfig))
  const secrets = createMemorySecretAdapter()
  const canonical = new CanonicalConfigService({ secrets } as never, {
    roots: new Roots(project, globalDir),
    secretAdapter: secrets,
    globalState: createMemoryStateAdapter(),
    workspaceState: createMemoryStateAdapter(),
  })
  await canonical.initialize()
  return { canonical, secrets, globalDir, globalFile }
}

function makeCanonicalHost(canonical: CanonicalConfigService, client: unknown = null) {
  const connection = new KiloConnectionService({} as never)
  ;(connection as unknown as { getClient: () => unknown }).getClient = () => client as never
  const host = new KiloProvider({} as never, connection, undefined, { canonicalConfig: canonical }) as unknown as Host & {
    canonicalReady: boolean
  }
  const messages: unknown[] = []
  host.postMessage = (message) => messages.push(message)
  return { host, messages }
}

function validCustomPayload() {
  return {
    name: "My Custom",
    endpoint: "https://example.com/v1",
    protocol: "openai/completions",
    models: { m1: { name: "M1" } },
  }
}

function builtinGlobalConfig() {
  return {
    provider: {
      anthropic: { name: "Anthropic" },
      mycustom: { name: "My Custom", endpoint: "https://example.com/v1", protocol: "openai/completions", models: { m1: { name: "M1" } } },
    },
  }
}

describe("custom-only host routing", () => {
  it("ignores removed provider OAuth message types without touching the SDK", async () => {
    let calls = 0
    const client = {
      provider: {
        oauth: {
          authorize: async () => {
            calls += 1
            return { data: { url: "https://example.com", method: "code", instructions: "x" } }
          },
          callback: async () => {
            calls += 1
            return { data: true }
          },
        },
      },
    }
    const { host, messages } = makeHost(client)
    const src = read("src/KiloProvider.ts")
    expect(src).not.toContain("authorizeProviderOAuth")
    expect(src).not.toContain("completeProviderOAuth")
    await host.handleProviderAction({ type: "authorizeProviderOAuth", requestId: "r1", providerID: "openai", method: 0 })
    await host.handleProviderAction({ type: "completeProviderOAuth", requestId: "r2", providerID: "openai", method: 0 })
    expect(calls).toBe(0)
    const errors = messages.filter((m) => (m as Record<string, unknown>).type === "providerActionError")
    expect(errors).toHaveLength(0)
    host.dispose()
  })

  it("rejects non-custom canonical connect/disconnect as unsupported", async () => {
    const src = read("src/KiloProvider.ts")
    expect(src).toContain("isCanonicalCustomEntry(providers[id])")
    expect(src).toContain("CUSTOM_ONLY_PROVIDER_MESSAGE")
    expect(src).toContain('msg.type === "connectProvider" || msg.type === "disconnectProvider"')
  })

  it("does not blanket-reject custom save/delete/fetch message types", async () => {
    const src = read("src/KiloProvider.ts")
    expect(src).toContain('msg.type === "saveCustomProvider"')
    expect(src).toContain('msg.type === "deleteCustomProvider"')
    expect(src).toContain("handleFetchCustomProviderModels")
    const { host, messages } = makeHost(null)
    await host.handleProviderAction({ type: "saveCustomProvider", requestId: "r5", providerID: "mycustom" })
    const err = messages.find((m) => (m as Record<string, unknown>).type === "providerActionError") as Record<string, unknown> | undefined
    expect(err).toBeDefined()
    expect(String(err?.message)).not.toContain("temporarily unavailable")
    host.dispose()
  })

  it("blocks login/logout/org/profile routing in source with no dormant host handlers", () => {
    const src = read("src/KiloProvider.ts")
    expect(src).toContain("Temporary custom-only boundary")
    expect(src).toContain('type: "deviceAuthFailed"')
    expect(src).toContain("CUSTOM_ONLY_AUTH_MESSAGE")
    expect(src).not.toContain("_dormantAuthFlows")
    expect(src).not.toContain("dormantHandleLogin")
    expect(src).not.toContain("dormantHandleLogout")
    expect(src).not.toContain("dormantHandleSetOrganization")
    expect(src).not.toContain("dormantHandleRefreshProfile")
    expect(src).not.toContain("handlers/auth")
    expect(src).not.toContain("authCtx")
  })

  it("keeps no VS Code-side OAuth helper export", () => {
    const actions = read("src/provider-actions.ts")
    expect(actions).not.toContain("authorizeProviderOAuth")
    expect(actions).not.toContain("completeProviderOAuth")
    expect(actions).toContain("fetchProviderData")
    expect(actions).toContain("isProviderModelsAuthError")
    const webview = read("webview-ui/src/types/messages/webview-messages.ts")
    expect(webview).not.toContain("authorizeProviderOAuth")
    expect(webview).not.toContain("completeProviderOAuth")
    const extension = read("webview-ui/src/types/messages/extension-messages.ts")
    expect(extension).not.toContain("providerOAuthReady")
    const util = read("webview-ui/src/utils/provider-action.ts")
    expect(util).not.toContain("authorizeProviderOAuth")
    expect(util).not.toContain("completeProviderOAuth")
    expect(util).not.toContain("providerOAuthReady")
    expect(util).not.toContain("onOAuthReady")
  })
})

describe("custom-only save/delete boundary", () => {
  it("rejects save over a built-in ID without writing config or secrets", async () => {
    const { canonical, secrets, globalFile } = await setupCanonical(builtinGlobalConfig())
    const before = readBin(globalFile, "utf8")
    const { host, messages } = makeCanonicalHost(canonical)
    await host.handleCanonicalProviderAction({
      type: "saveCustomProvider",
      providerID: "anthropic",
      requestId: "r-builtin-save",
      canonical: true,
      stamp: canonical.stamp,
      config: validCustomPayload(),
    })
    const err = messages.find((m) => (m as Record<string, unknown>).type === "providerActionError") as Record<string, unknown> | undefined
    expect(err).toBeDefined()
    expect(err!.kind).toBe("unsupported")
    expect(String(err!.message)).toContain("temporarily unavailable")
    expect(err!.providerID).toBe("anthropic")
    expect(readBin(globalFile, "utf8")).toBe(before)
    expect(secrets.store_.size).toBe(0)
    host.dispose()
    canonical.dispose()
  })

  it("rejects delete of a built-in ID without writing config or secrets", async () => {
    const { canonical, secrets, globalFile } = await setupCanonical(builtinGlobalConfig())
    const before = readBin(globalFile, "utf8")
    const { host, messages } = makeCanonicalHost(canonical)
    await host.handleCanonicalProviderAction({
      type: "deleteCustomProvider",
      providerID: "anthropic",
      requestId: "r-builtin-delete",
      canonical: true,
      stamp: canonical.stamp,
    })
    const err = messages.find((m) => (m as Record<string, unknown>).type === "providerActionError") as Record<string, unknown> | undefined
    expect(err).toBeDefined()
    expect(err!.kind).toBe("unsupported")
    expect(String(err!.message)).toContain("temporarily unavailable")
    expect(readBin(globalFile, "utf8")).toBe(before)
    expect(secrets.store_.size).toBe(0)
    host.dispose()
    canonical.dispose()
  })

  it("rejects reserved IDs for save/delete", async () => {
    const { canonical } = await setupCanonical({ provider: {} })
    for (const reserved of ["kilo", "anaconda-desktop", "_custom"]) {
      const { host, messages } = makeCanonicalHost(canonical)
      await host.handleCanonicalProviderAction({
        type: "saveCustomProvider",
        providerID: reserved,
        requestId: `r-save-${reserved}`,
        canonical: true,
        stamp: canonical.stamp,
        config: validCustomPayload(),
      })
      const saveErr = messages.find((m) => (m as Record<string, unknown>).type === "providerActionError") as Record<string, unknown> | undefined
      expect(saveErr?.kind).toBe("unsupported")
      messages.length = 0
      await host.handleCanonicalProviderAction({
        type: "deleteCustomProvider",
        providerID: reserved,
        requestId: `r-del-${reserved}`,
        canonical: true,
        stamp: canonical.stamp,
      })
      const delErr = messages.find((m) => (m as Record<string, unknown>).type === "providerActionError") as Record<string, unknown> | undefined
      expect(delErr?.kind).toBe("unsupported")
      host.dispose()
    }
    canonical.dispose()
  })

  it("allows a new legal custom ID to save and an existing custom to delete", async () => {
    const { canonical, globalFile } = await setupCanonical({ provider: {} })
    const { host, messages } = makeCanonicalHost(canonical)
    await host.handleCanonicalProviderAction({
      type: "saveCustomProvider",
      providerID: "brandnewcustom",
      requestId: "r-new-save",
      canonical: true,
      stamp: canonical.stamp,
      config: validCustomPayload(),
    })
    const connected = messages.find((m) => (m as Record<string, unknown>).type === "providerConnected")
    expect(connected).toBeDefined()
    expect(readBin(globalFile, "utf8")).toContain("brandnewcustom")
    messages.length = 0
    await host.handleCanonicalProviderAction({
      type: "deleteCustomProvider",
      providerID: "brandnewcustom",
      requestId: "r-new-delete",
      canonical: true,
      stamp: canonical.stamp,
    })
    const deleted = messages.find((m) => (m as Record<string, unknown>).type === "providerDeleted")
    expect(deleted).toBeDefined()
    expect(readBin(globalFile, "utf8")).not.toContain("brandnewcustom")
    host.dispose()
    canonical.dispose()
  })

  it("allows an unconfigured future-like ordinary ID to save as custom (accepted collision policy)", async () => {
    const { canonical, globalFile } = await setupCanonical({ provider: {} })
    const { host, messages } = makeCanonicalHost(canonical)
    await host.handleCanonicalProviderAction({
      type: "saveCustomProvider",
      providerID: "openrouter",
      requestId: "r-future-save",
      canonical: true,
      stamp: canonical.stamp,
      config: validCustomPayload(),
    })
    const connected = messages.find((m) => (m as Record<string, unknown>).type === "providerConnected")
    expect(connected).toBeDefined()
    expect(readBin(globalFile, "utf8")).toContain("openrouter")
    host.dispose()
    canonical.dispose()
  })

  it("rejects connect/disconnect of a configured non-custom entry without touching secrets", async () => {
    const { canonical, secrets, globalFile } = await setupCanonical(builtinGlobalConfig())
    const before = readBin(globalFile, "utf8")
    const { host, messages } = makeCanonicalHost(canonical)
    await host.handleCanonicalProviderAction({
      type: "connectProvider",
      providerID: "anthropic",
      requestId: "r-builtin-connect",
      canonical: true,
      stamp: canonical.stamp,
    })
    await host.handleCanonicalProviderAction({
      type: "disconnectProvider",
      providerID: "anthropic",
      requestId: "r-builtin-disconnect",
      canonical: true,
      stamp: canonical.stamp,
    })
    const errors = messages.filter((m) => (m as Record<string, unknown>).type === "providerActionError")
    expect(errors).toHaveLength(2)
    for (const err of errors) {
      expect((err as Record<string, unknown>).kind).toBe("unsupported")
      expect(String((err as Record<string, unknown>).message)).toContain("temporarily unavailable")
      expect((err as Record<string, unknown>).providerID).toBe("anthropic")
    }
    expect(readBin(globalFile, "utf8")).toBe(before)
    expect(secrets.store_.size).toBe(0)
    host.dispose()
    canonical.dispose()
  })

  it("rejects non-custom save payloads without touching secrets", async () => {
    const { canonical, secrets } = await setupCanonical({ provider: {} })
    const { host, messages } = makeCanonicalHost(canonical)
    await host.handleCanonicalProviderAction({
      type: "saveCustomProvider",
      providerID: "plaincustom",
      requestId: "r-plain",
      canonical: true,
      stamp: canonical.stamp,
      config: { name: "Plain" },
    })
    const err = messages.find((m) => (m as Record<string, unknown>).type === "providerActionError") as Record<string, unknown> | undefined
    expect(err?.kind).toBe("unsupported")
    expect(secrets.store_.size).toBe(0)
    host.dispose()
    canonical.dispose()
  })
})

describe("custom-only fetch boundary", () => {
  function mockModelsFetch(calls: { count: number }): () => void {
    const prev = globalThis.fetch
    globalThis.fetch = (async () => {
      calls.count += 1
      return new Response(JSON.stringify({ data: [{ id: "m1", name: "M1" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as typeof fetch
    return () => {
      globalThis.fetch = prev
    }
  }

  function fetchMsg(providerID: string, stamp: unknown): Record<string, unknown> {
    return {
      type: "fetchCustomProviderModels",
      requestId: `r-fetch-${providerID}`,
      baseURL: "https://example.com/v1",
      providerID,
      canonical: true,
      stamp,
    }
  }

  it("fails closed for a configured non-custom entry without fetching or touching secrets", async () => {
    const { canonical, secrets } = await setupCanonical(builtinGlobalConfig())
    const calls = { count: 0 }
    const restore = mockModelsFetch(calls)
    try {
      const { host, messages } = makeCanonicalHost(canonical)
      await host.handleFetchCustomProviderModels(fetchMsg("anthropic", canonical.stamp))
      const done = messages.find(
        (m) => (m as Record<string, unknown>).type === "customProviderModelsFetched",
      ) as Record<string, unknown> | undefined
      expect(done).toBeDefined()
      expect(String(done?.error)).toContain("temporarily unavailable")
      expect(done?.models).toBeUndefined()
      expect(calls.count).toBe(0)
      expect(secrets.store_.size).toBe(0)
      host.dispose()
    } finally {
      restore()
    }
    canonical.dispose()
  })

  it("rejects reserved IDs without fetching", async () => {
    const { canonical } = await setupCanonical({ provider: {} })
    const calls = { count: 0 }
    const restore = mockModelsFetch(calls)
    try {
      const { host, messages } = makeCanonicalHost(canonical)
      await host.handleFetchCustomProviderModels(fetchMsg("kilo", canonical.stamp))
      const done = messages.find(
        (m) => (m as Record<string, unknown>).type === "customProviderModelsFetched",
      ) as Record<string, unknown> | undefined
      expect(done).toBeDefined()
      expect(String(done?.error)).toContain("temporarily unavailable")
      expect(calls.count).toBe(0)
      host.dispose()
    } finally {
      restore()
    }
    canonical.dispose()
  })

  it("allows discovery for a configured custom entry", async () => {
    const { canonical } = await setupCanonical(builtinGlobalConfig())
    const calls = { count: 0 }
    const restore = mockModelsFetch(calls)
    try {
      const { host, messages } = makeCanonicalHost(canonical)
      await host.handleFetchCustomProviderModels(fetchMsg("mycustom", canonical.stamp))
      const done = messages.find(
        (m) => (m as Record<string, unknown>).type === "customProviderModelsFetched",
      ) as Record<string, unknown> | undefined
      expect(done?.error).toBeUndefined()
      expect(done?.models).toEqual([{ id: "m1", name: "M1" }])
      expect(calls.count).toBe(1)
      host.dispose()
    } finally {
      restore()
    }
    canonical.dispose()
  })

  it("allows discovery for an unconfigured ordinary ID (future IDs not reserved)", async () => {
    const { canonical } = await setupCanonical({ provider: {} })
    const calls = { count: 0 }
    const restore = mockModelsFetch(calls)
    try {
      const { host, messages } = makeCanonicalHost(canonical)
      await host.handleFetchCustomProviderModels(fetchMsg("openrouter", canonical.stamp))
      const done = messages.find(
        (m) => (m as Record<string, unknown>).type === "customProviderModelsFetched",
      ) as Record<string, unknown> | undefined
      expect(done?.error).toBeUndefined()
      expect(done?.models).toEqual([{ id: "m1", name: "M1" }])
      expect(calls.count).toBe(1)
      host.dispose()
    } finally {
      restore()
    }
    canonical.dispose()
  })
})

describe("custom-only auth routing", () => {
  function makeWebviewHost(client: unknown, canonical?: CanonicalConfigService) {
    const connection = new KiloConnectionService({} as never)
    ;(connection as unknown as { getClient: () => unknown }).getClient = () => client as never
    const host = new KiloProvider({} as never, connection, undefined, canonical ? { canonicalConfig: canonical } : {}) as unknown as {
      postMessage: (m: unknown) => void
      dispose: () => void
    }
    const messages: unknown[] = []
    host.postMessage = (m) => messages.push(m)
    let handler: ((msg: Record<string, unknown>) => Promise<unknown>) | undefined
    const webview = {
      onDidReceiveMessage: (cb: (msg: Record<string, unknown>) => Promise<unknown>) => {
        handler = cb
        return { dispose: () => {} }
      },
      postMessage: async () => true,
      options: {},
      html: "",
    }
    ;(host as unknown as { setupWebviewMessageHandler: (w: unknown) => void }).setupWebviewMessageHandler(webview)
    return { host, messages, send: async (msg: Record<string, unknown>) => { await handler?.(msg) } }
  }

  it("login fails closed with the existing failed shape and no Started/Complete path", async () => {
    const { host, messages, send } = makeWebviewHost(null)
    await send({ type: "login" })
    const failed = messages.find((m) => (m as Record<string, unknown>).type === "deviceAuthFailed") as Record<string, unknown> | undefined
    expect(failed).toBeDefined()
    expect(String(failed!.error)).toContain("temporarily unavailable")
    expect(messages.some((m) => (m as Record<string, unknown>).type === "deviceAuthStarted")).toBe(false)
    expect(messages.some((m) => (m as Record<string, unknown>).type === "deviceAuthComplete")).toBe(false)
    host.dispose()
  })

  it("cancelLogin posts cancelled with the existing shape and no Started/Complete path", async () => {
    const { host, messages, send } = makeWebviewHost(null)
    await send({ type: "login" })
    await send({ type: "cancelLogin" })
    const cancelled = messages.filter((m) => (m as Record<string, unknown>).type === "deviceAuthCancelled")
    expect(cancelled).toHaveLength(1)
    expect(messages.some((m) => (m as Record<string, unknown>).type === "deviceAuthStarted")).toBe(false)
    expect(messages.some((m) => (m as Record<string, unknown>).type === "deviceAuthComplete")).toBe(false)
    host.dispose()
  })

  it("logout/setOrganization/refreshProfile stay unsupported with stable shapes", async () => {
    const { host, messages, send } = makeWebviewHost(null)
    await send({ type: "logout" })
    await send({ type: "setOrganization", organizationId: "org-1" })
    await send({ type: "refreshProfile" })
    const errors = messages.filter((m) => (m as Record<string, unknown>).type === "error")
    expect(errors).toHaveLength(2)
    for (const e of errors) expect(String((e as Record<string, unknown>).message)).toContain("temporarily unavailable")
    const profile = messages.find((m) => (m as Record<string, unknown>).type === "profileData") as Record<string, unknown> | undefined
    expect(profile).toBeDefined()
    expect(profile!.data).toBeNull()
    host.dispose()
  })

  it("removed provider OAuth sends are ignored without SDK calls", async () => {
    let calls = 0
    const client = {
      provider: { oauth: { authorize: async () => { calls += 1 }, callback: async () => { calls += 1 } } },
    }
    const { host, messages } = makeCanonicalHost((await setupCanonical({ provider: {} })).canonical, client)
    await host.handleProviderAction({ type: "authorizeProviderOAuth", requestId: "r-a", providerID: "openai", method: 0 })
    await host.handleProviderAction({ type: "completeProviderOAuth", requestId: "r-c", providerID: "openai", method: 0 })
    expect(calls).toBe(0)
    expect(messages.filter((m) => (m as Record<string, unknown>).type === "providerActionError")).toHaveLength(0)
    host.dispose()
  })
})

describe("custom-only anaconda boundary", () => {
  function makeWebviewHost() {
    const calls = { status: 0, open: 0, sync: 0 }
    const client = {
      anacondaDesktop: {
        status: async () => { calls.status += 1; return { data: { type: "ready" } } },
        open: async () => { calls.open += 1; return { data: true } },
        sync: async () => { calls.sync += 1; return { data: { type: "ready" } } },
      },
    }
    const connection = new KiloConnectionService({} as never)
    ;(connection as unknown as { getClient: () => unknown }).getClient = () => client as never
    const host = new KiloProvider({} as never, connection, undefined, {}) as unknown as {
      postMessage: (m: unknown) => void
      dispose: () => void
    }
    const messages: unknown[] = []
    host.postMessage = (m) => messages.push(m)
    let handler: ((msg: Record<string, unknown>) => Promise<unknown>) | undefined
    const webview = {
      onDidReceiveMessage: (cb: (msg: Record<string, unknown>) => Promise<unknown>) => {
        handler = cb
        return { dispose: () => {} }
      },
      postMessage: async () => true,
      options: {},
      html: "",
    }
    ;(host as unknown as { setupWebviewMessageHandler: (w: unknown) => void }).setupWebviewMessageHandler(webview)
    return { host, messages, calls, send: async (msg: Record<string, unknown>) => { await handler?.(msg) } }
  }

  it("fails closed without touching the Anaconda backend", async () => {
    const { host, messages, calls, send } = makeWebviewHost()
    await send({ type: "anacondaDesktopStatus", requestId: "r-status" })
    await send({ type: "anacondaDesktopOpen", requestId: "r-open" })
    await send({ type: "anacondaDesktopSync", requestId: "r-sync", acknowledgeToolLimitations: true })
    await send({ type: "cancelAnacondaDesktopRequest", requestId: "r-sync" })
    expect(calls).toEqual({ status: 0, open: 0, sync: 0 })
    const errors = messages.filter((m) => (m as Record<string, unknown>).type === "anacondaDesktopActionError") as Record<string, unknown>[]
    expect(errors).toHaveLength(3)
    // Fail-closed: the three fallible messages error, cancel stays silent, no success leaks.
    expect(messages).toHaveLength(3)
    expect(errors.map((e) => e.action).sort()).toEqual(["open", "status", "sync"])
    for (const e of errors) expect(String(e.message)).toContain("temporarily unavailable")
    const src = read("src/KiloProvider.ts")
    expect(src).toContain("anacondaDesktopActionError")
    expect(src).not.toMatch(/await this\.anacondaDesktop\.handle/)
    host.dispose()
  })
})

describe("custom-only preserves custom guards", () => {
  it("custom disconnect keeps stamp guards and succeeds for custom entries", async () => {
    const { canonical } = await setupCanonical(builtinGlobalConfig())
    const { host, messages } = makeCanonicalHost(canonical)
    await host.handleCanonicalProviderAction({
      type: "disconnectProvider",
      providerID: "mycustom",
      requestId: "r-disconnect-ok",
      canonical: true,
      stamp: canonical.stamp,
    })
    const done = messages.find((m) => (m as Record<string, unknown>).type === "providerDisconnected")
    expect(done).toBeDefined()
    messages.length = 0
    await host.handleCanonicalProviderAction({
      type: "disconnectProvider",
      providerID: "mycustom",
      requestId: "r-disconnect-stale",
      canonical: true,
      stamp: { ...canonical.stamp, materializationVersion: -1 },
    })
    const stale = messages.find((m) => (m as Record<string, unknown>).type === "providerActionError") as Record<string, unknown> | undefined
    expect(stale?.kind).toBe("stale")
    host.dispose()
    canonical.dispose()
  })

  it("custom model discovery keeps credential and stamp guards", async () => {
    const { canonical } = await setupCanonical(builtinGlobalConfig())
    const { host, messages } = makeCanonicalHost(canonical)
    await host.handleFetchCustomProviderModels({
      type: "fetchCustomProviderModels",
      requestId: "r-fetch-stale",
      baseURL: "https://example.com/v1",
      providerID: "mycustom",
      canonical: true,
      stamp: { ...canonical.stamp, materializationVersion: -1 },
    })
    const stale = messages.find((m) => (m as Record<string, unknown>).type === "customProviderModelsFetched") as Record<string, unknown> | undefined
    expect(String(stale?.error)).toContain("stale")
    host.dispose()
    canonical.dispose()
  })
})
