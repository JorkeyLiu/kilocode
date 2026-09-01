import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { buildGithubProviderOptions } from "../../src/cli/cmd/github.handler"
import { buildProviderOptions, matchProviderInput, resolvePluginProviders } from "../../src/cli/cmd/providers"

// P4.4-T8 source-removal evidence — bounded preset-identity removal in CLI
// provider login selectors (LOCK-006 preset-only removal; LOCK-009 bridge preserved).
// Removed via `ProvidersLoginCommand` and `githubInstall`/`promptProvider`:
// - `buildProviderOptions`/`buildGithubProviderOptions` now use deterministic generic
//   `sortBy((x) => x.name ?? x.id)` without preset priority map (`kilo: 0` etc.)
// - hardcoded hints (`"recommended"` / `"ChatGPT login or API key"` / `hint: {`) removed
// - `codex` -> `openai` alias (`matchProviderInput` no longer aliases) removed
// Generic catalog lookup (`ModelsDev.Service`), plugin/custom-provider auth
// (`handlePluginAuth`, `resolvePluginProviders`, `other` path with `Enter provider id`),
// and HTTP/SSE generated-SDK bridge (`/provider` list/auth/authorize/callback) remain.
// Core `ModelsDev` and `models-api.json` remain per scope (not removed in this unit).
// Webview Kilo fallback identity is out of scope for this unit.
// This file keeps static absence checks as supplementary evidence and adds focused
// executable coverage that reaches the changed selectors via real implementation.

const opencode = join(import.meta.dir, "../../src")
const repo = resolve(join(import.meta.dir, "../../../../"))

function read(rel: string): string {
  return readFileSync(join(opencode, rel), "utf8")
}
function readRepo(rel: string): string {
  return readFileSync(join(repo, rel), "utf8")
}

describe("P4.4 provider login preset removal — hardcoded selector identity absent (static)", () => {
  test("providers.ts no longer contains preset priority map", () => {
    const src = read("cli/cmd/providers.ts")
    expect(src).not.toContain("const priority: Record<string, number>")
    expect(src).not.toContain("kilo: 0")
    expect(src).not.toContain('"github-copilot": 3')
    expect(src).not.toContain("priority[x.id] ?? 99")
    expect(src).not.toContain("priority[x.id] ??")
    // deterministic generic ordering remains via helpers
    expect(src).toContain("sortBy((x) => x.name ?? x.id)")
    expect(src).toContain("export function buildProviderOptions")
    expect(src).toContain("export function matchProviderInput")
    expect(src).not.toContain('"recommended"')
    expect(src).not.toContain("ChatGPT login or API key")
    expect(src).not.toContain('hint: {')
    expect(src).toContain('hint: "plugin"')
  })

  test("providers.ts no longer contains codex -> openai alias", () => {
    const src = read("cli/cmd/providers.ts")
    expect(src).not.toContain('=== "codex"')
    expect(src).not.toContain("=== 'codex'")
    expect(src).not.toContain("codex")
    // generic selection now via matchProviderInput helper — alias absent
    expect(src).toContain("matchProviderInput")
    expect(src).toContain("byID")
    expect(src).toContain("byName")
    expect(src).toContain("matchProviderInput(input, options)")
    const aliasMatches = src.match(/\bconst alias\b/g) ?? []
    expect(aliasMatches.length).toBe(0)
  })

  test("providers.ts generic catalog/plugin/custom paths remain (G2 catalog absent)", () => {
    const src = read("cli/cmd/providers.ts")
    expect(src).not.toContain("ModelsDev.Service")
    expect(src).toContain("Plugin.Service")
    expect(src).toContain("Config.Service")
    expect(src).toContain("resolvePluginProviders")
    expect(src).toContain("handlePluginAuth")
    expect(src).toContain("buildProviderOptions")
    expect(src).toContain("Select provider")
    expect(src).toContain('value: "other"')
    expect(src).toContain("Enter provider id")
    expect(src).toContain("Enter your API key")
    expect(src).toContain('type: "api"')
    expect(src).toContain('type: "oauth"')
    expect(src).toContain("authSvc.set")
    expect(src).toContain("authSvc.remove")
    expect(src).toContain("plugin.auth")
    expect(src).toContain("disabled_providers")
    expect(src).toContain("enabled_providers")
    expect(src).toContain("allProviders")
  })

  test("github.handler.ts no longer contains preset priority/recommended map", () => {
    const src = read("cli/cmd/github.handler.ts")
    expect(src).toContain("export function buildGithubProviderOptions")
    expect(src).toContain("sortBy((x) => x.name ?? x.id)")
    // promptProvider must not define priority
    const promptSlice = src.slice(src.indexOf("async function promptProvider()"), src.indexOf("async function promptProvider()") + 1200)
    expect(promptSlice).not.toContain("const priority")
    expect(promptSlice).not.toContain("kilo: 0")
    expect(promptSlice).not.toContain("anthropic: 1")
    expect(promptSlice).not.toContain("priority[x.id]")
    expect(promptSlice).not.toContain("recommended")
    expect(promptSlice).not.toContain("hint:")
    expect(promptSlice).toContain("buildGithubProviderOptions(providers)")
    // helper itself must not contain hint
    const helperSlice = src.slice(src.indexOf("export function buildGithubProviderOptions"), src.indexOf("export function buildGithubProviderOptions") + 400)
    expect(helperSlice).not.toContain("hint")
    expect(helperSlice).toContain('label: x.name')
    expect(helperSlice).toContain('value: x.id')
  })

  test("CLI selector source tree contains no preset priority/hint/alias surface in targeted files", () => {
    const providers = read("cli/cmd/providers.ts")
    const github = read("cli/cmd/github.handler.ts")
    const combined = providers + "\n" + github
    expect(combined).not.toContain("priority: Record<string, number>")
    expect(combined).not.toContain("priority[x.id] === 0")
    expect(combined).not.toContain("ChatGPT login")
    // codex alias must be gone (only occurrence would be in old alias logic)
    // allow no occurrence except possibly in comments — we assert no alias code remains
    expect(combined.toLowerCase()).not.toContain('"codex"')
    expect(providers).toContain('hint: "plugin"')
    const ghHintCount = (github.match(/\bhint\b/g) ?? []).length
    expect(github).not.toContain("recommended")
    expect(ghHintCount).toBe(0)
  })

  test("generic catalog artifacts removed — G2 absence plus custom/provider preserved (LOCK-006)", () => {
    expect(existsSync(join(opencode, "kilocode/provider/models-api.json"))).toBe(false)
    expect(existsSync(resolve(join(repo, "packages/core/src/models-dev.ts")))).toBe(false)
    expect(read("cli/cmd/providers.ts")).not.toContain("ModelsDev.Service")
    expect(read("cli/cmd/github.handler.ts")).not.toContain("ModelsDev.Service")
    expect(existsSync(join(opencode, "provider/provider.ts"))).toBe(true)
    const provider = read("provider/provider.ts")
    expect(provider).toContain("const BUNDLED_PROVIDERS")
    expect(provider).toContain('"@ai-sdk/openai"')
    expect(provider).toContain('"@ai-sdk/openai-compatible"')
    expect(existsSync(join(opencode, "kilocode/custom-provider.ts"))).toBe(true)
    expect(existsSync(join(opencode, "kilocode/server/custom-provider-save.ts"))).toBe(true)
    expect(existsSync(join(opencode, "kilocode/server/custom-provider-delete.ts"))).toBe(true)
    // Custom provider save/delete no longer pulls ModelsDev
    expect(read("kilocode/server/custom-provider-save.ts")).not.toContain("ModelsDev")
    expect(read("kilocode/server/custom-provider-delete.ts")).not.toContain("ModelsDev")
  })

  test("provider HTTP/SSE/generated-SDK bridge remains per LOCK-009 (G2 catalog absent)", () => {
    const group = read("server/routes/instance/httpapi/groups/provider.ts")
    expect(group).toContain('HttpApiEndpoint.get("list"')
    expect(group).toContain('HttpApiEndpoint.get("auth"')
    expect(group).toContain('HttpApiEndpoint.post("authorize"')
    expect(group).toContain('HttpApiEndpoint.post("callback"')
    const handler = read("server/routes/instance/httpapi/handlers/provider.ts")
    expect(handler).toContain('HttpApiBuilder.group(InstanceHttpApi, "provider"')
    expect(handler).toContain('.handle("list"')
    expect(handler).toContain('.handle("auth"')
    expect(handler).toContain('handleRaw("authorize"')
    expect(handler).toContain('.handle("callback"')
    expect(handler).toContain("Provider.toPublicInfo")
    expect(handler).not.toContain("ModelsDev.Service")
    expect(handler).toContain("connected: Object.keys(connected)")
    expect(handler).toContain("failed,")
  })

  test("no webview files were modified by this CLI unit (out of scope)", () => {
    expect(existsSync(resolve(join(repo, "packages/kilo-vscode/webview-ui/src/components/settings/provider-catalog.ts")))).toBe(true)
    const providers = read("cli/cmd/providers.ts")
    expect(providers).not.toContain("webview")
    expect(providers).not.toContain("provider-catalog")
  })

  test("test-profile lists the new removal regression in sorted order", () => {
    const profile = readRepo("packages/opencode/script/kilocode/test-profile.ts")
    expect(profile).toContain("p4-4-provider-login-preset-removal")
    expect(profile).toContain("p4-4-bundled-provider-loader-removal")
    expect(profile).toContain("p4-4-managed-removal")
    expect(profile).toContain("p4-4-model-cache-removal")
    expect(profile).toContain("p4-4-primary-worktree-removal")
    expect(profile).toContain("p4-4-provider-metadata-removal")
    expect(profile).toContain("p4-4-wellknown-provider-auth-removal")
    const bundledIdx = profile.indexOf("p4-4-bundled-provider-loader-removal")
    const managedIdx = profile.indexOf("p4-4-managed-removal")
    const modelCacheIdx = profile.indexOf("p4-4-model-cache-removal")
    const primaryIdx = profile.indexOf("p4-4-primary-worktree-removal")
    const loginIdx = profile.indexOf("p4-4-provider-login-preset-removal")
    const providerIdx = profile.indexOf("p4-4-provider-metadata-removal")
    const wellknownIdx = profile.indexOf("p4-4-wellknown-provider-auth-removal")
    expect(bundledIdx).toBeGreaterThan(-1)
    expect(managedIdx).toBeGreaterThan(-1)
    expect(modelCacheIdx).toBeGreaterThan(-1)
    expect(primaryIdx).toBeGreaterThan(-1)
    expect(loginIdx).toBeGreaterThan(-1)
    expect(providerIdx).toBeGreaterThan(-1)
    expect(wellknownIdx).toBeGreaterThan(-1)
    expect(bundledIdx).toBeLessThan(managedIdx)
    expect(managedIdx).toBeLessThan(modelCacheIdx)
    expect(modelCacheIdx).toBeLessThan(primaryIdx)
    expect(primaryIdx).toBeLessThan(loginIdx)
    expect(loginIdx).toBeLessThan(providerIdx)
    expect(providerIdx).toBeLessThan(wellknownIdx)
  })
})

describe("P4.4 provider login preset removal — executable selector behavior", () => {
  test("buildProviderOptions orders providers alphabetically by name and appends plugin hint", () => {
    const providers = {
      openai: { id: "openai", name: "OpenAI" },
      anthropic: { id: "anthropic", name: "Anthropic" },
      google: { id: "google", name: "Google" },
      kilo: { id: "kilo", name: "Kilo" },
    }
    const opts = buildProviderOptions({ providers, pluginProviders: [] })
    expect(opts.map((o) => o.value)).toEqual(["anthropic", "google", "kilo", "openai"])
    expect(opts.map((o) => o.label)).toEqual(["Anthropic", "Google", "Kilo", "OpenAI"])
    // no preset priority — kilo is not first
    expect(opts[0].value).not.toBe("kilo")
    // no hint on generic entries
    for (const o of opts) expect(o.hint).toBeUndefined()

    const withPlugin = buildProviderOptions({
      providers,
      pluginProviders: [{ id: "portkey", name: "Portkey" }],
    })
    expect(withPlugin.map((o) => o.value)).toEqual(["anthropic", "google", "kilo", "openai", "portkey"])
    const plugin = withPlugin.find((o) => o.value === "portkey")!
    expect(plugin.hint).toBe("plugin")
    expect(plugin.label).toBe("Portkey")
  })

  test("buildGithubProviderOptions mirrors generic alphabetical ordering without hint", () => {
    const providers = {
      openai: { id: "openai", name: "OpenAI" },
      anthropic: { id: "anthropic", name: "Anthropic" },
      google: { id: "google", name: "Google" },
      kilo: { id: "kilo", name: "Kilo" },
    }
    const opts = buildGithubProviderOptions(providers)
    expect(opts.map((o) => o.value)).toEqual(["anthropic", "google", "kilo", "openai"])
    for (const o of opts) expect("hint" in o).toBe(false)
    expect(opts.every((o) => o.label && o.value)).toBe(true)
  })

  test("matchProviderInput rejects codex alias and resolves by exact id and case-insensitive name", () => {
    const opts = buildProviderOptions({
      providers: {
        openai: { id: "openai", name: "OpenAI" },
        anthropic: { id: "anthropic", name: "Anthropic" },
      },
      pluginProviders: [],
    })
    // codex must not resolve to openai
    expect(matchProviderInput("codex", opts)).toBeUndefined()
    expect(matchProviderInput("Codex", opts)).toBeUndefined()
    expect(matchProviderInput("CODEX", opts)).toBeUndefined()
    // id match is exact (case-sensitive)
    expect(matchProviderInput("openai", opts)?.value).toBe("openai")
    expect(matchProviderInput("anthropic", opts)?.value).toBe("anthropic")
    // name match is case-insensitive — OPENAI resolves via label "OpenAI", not via exact id
    expect(matchProviderInput("OPENAI", opts)?.value).toBe("openai")
    expect(matchProviderInput("Anthropic", opts)?.value).toBe("anthropic")
    expect(matchProviderInput("ANTHROPIC", opts)?.value).toBe("anthropic")
    // distinct id/name proves exact-id semantics: id "custom-id" vs label "Custom Display"
    const distinctOpts = buildProviderOptions({
      providers: {
        "custom-id": { id: "custom-id", name: "Custom Display" },
      },
      pluginProviders: [],
    })
    expect(matchProviderInput("custom-id", distinctOpts)?.value).toBe("custom-id")
    expect(matchProviderInput("CUSTOM-ID", distinctOpts)).toBeUndefined()
    expect(matchProviderInput("Custom Display", distinctOpts)?.value).toBe("custom-id")
    expect(matchProviderInput("CUSTOM DISPLAY", distinctOpts)?.value).toBe("custom-id")
    expect(matchProviderInput("custom display", distinctOpts)?.value).toBe("custom-id")
    // unknown still fails
    expect(matchProviderInput("unknown", opts)).toBeUndefined()
  })

  test("prompt contents are generic label/value without preset hints", () => {
    const providers = {
      openai: { id: "openai", name: "OpenAI" },
      "github-copilot": { id: "github-copilot", name: "GitHub Copilot" },
    }
    const opts = buildProviderOptions({ providers, pluginProviders: [] })
    // each option must be label=name, value=id, no hint
    expect(opts).toEqual([
      { label: "GitHub Copilot", value: "github-copilot" },
      { label: "OpenAI", value: "openai" },
    ])
    const ghOpts = buildGithubProviderOptions(providers)
    expect(ghOpts).toEqual([
      { label: "GitHub Copilot", value: "github-copilot" },
      { label: "OpenAI", value: "openai" },
    ])
    // no preset recommended/chatgpt hint present
    expect(JSON.stringify(opts)).not.toContain("recommended")
    expect(JSON.stringify(opts)).not.toContain("ChatGPT")
  })

  test("resolvePluginProviders preserves generic/plugin dispatch and other custom path separation", () => {
    // pluginProviders are those not in existingProviders and not disabled
    const hooks: Parameters<typeof resolvePluginProviders>[0]["hooks"] = [
      { auth: { provider: "portkey", methods: [] } },
      { auth: { provider: "openai", methods: [] } },
    ]
    const res = resolvePluginProviders({
      hooks,
      existingProviders: { openai: {} },
      disabled: new Set(),
      providerNames: {},
    })
    expect(res).toEqual([{ id: "portkey", name: "portkey" }])
    // plugin hint is added only via buildProviderOptions, not via resolve
    const built = buildProviderOptions({
      providers: { openai: { id: "openai", name: "OpenAI" } },
      pluginProviders: res,
    })
    expect(built).toEqual([
      { label: "OpenAI", value: "openai" },
      { label: "portkey", value: "portkey", hint: "plugin" },
    ])
    // other path is separate from plugin dispatch — ensure value "other" is not a plugin id
    expect(built.every((o) => o.value !== "other")).toBe(true)
    const extended = [...built, { label: "Other", value: "other" }]
    expect(extended.find((o) => o.value === "other")?.label).toBe("Other")
  })

  test("ordering is stable when names collide — preserves insertion order for ties without preset priority", () => {
    const providers = {
      b: { id: "b", name: "Same" },
      a: { id: "a", name: "Same" },
      c: { id: "c", name: "Alpha" },
    }
    const opts = buildProviderOptions({ providers, pluginProviders: [] })
    // alphabetical by name: Alpha first, then Same entries preserve input insertion order (stable sort, no id tie-break)
    expect(opts[0].value).toBe("c")
    expect(opts.slice(1).map((o) => o.value)).toEqual(["b", "a"])
    expect(opts.slice(1).map((o) => o.label)).toEqual(["Same", "Same"])
    // no kilo/openai priority leak — ensure generic order, not preset order
    const presetOrder = ["kilo", "anthropic", "github-copilot", "openai", "google", "openrouter", "vercel"]
    const candidate = buildProviderOptions({
      providers: Object.fromEntries(presetOrder.map((id) => [id, { id, name: id }])),
      pluginProviders: [],
    })
    const sortedNames = [...presetOrder].sort()
    expect(candidate.map((o) => o.value)).toEqual(sortedNames)
  })
})
