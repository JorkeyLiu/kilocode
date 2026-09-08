import { describe, expect, it } from "bun:test"
import path from "node:path"
import * as fs from "node:fs"
import { randomUUID } from "node:crypto"
import esbuild from "esbuild"
import { solidPlugin } from "esbuild-plugin-solid"

// Focused SessionProvider regression for the pre-canonical configured
// fallback: before canonical materialization a valid concrete non-Kilo
// provider default is exposed so fresh no-draft sessions resolve it instead
// of inheriting recentModels/pending composer choices, while KILO_AUTO/kilo
// stays hidden. Canonical-ready fallback behavior is unchanged.
const WEBVIEW = path.resolve(import.meta.dir, "../../webview-ui")

const PASS = "CONFIGURED_FALLBACK_PASS"
const FAIL = "CONFIGURED_FALLBACK_FAIL:"

const CHILD = `
  import { Window } from "happy-dom"

  const window = new Window()
  globalThis.window = window
  globalThis.document = window.document
  globalThis.Node = window.Node
  globalThis.navigator = window.navigator

  const sent = []
  globalThis.acquireVsCodeApi = () => ({
    postMessage: (message) => sent.push(message),
    getState: () => undefined,
    setState: () => {},
  })

  const { createComponent, useContext, createSignal } = await import("solid-js")
  const { render } = await import("solid-js/web")
  const { VSCodeProvider } = await import("./src/context/vscode.tsx")
  const { ServerProvider } = await import("./src/context/server.tsx")
  const { ProviderContext } = await import("./src/context/provider.tsx")
  const { ConfigContext } = await import("./src/context/config.tsx")
  const { LanguageContext } = await import("./src/context/language.tsx")
  const { SessionProvider, SessionContext } = await import("./src/context/session.tsx")

  const fail = (reason) => {
    console.log("${FAIL}" + reason)
    process.exit(2)
  }
  const eq = (actual, expected, label) => {
    if (actual !== expected) fail(label + ": got " + JSON.stringify(actual) + " expected " + JSON.stringify(expected))
  }

  const noop = () => {}
  const [config] = createSignal({})

  const FLASH = "deepseek-v4-flash"
  const GPT = "gpt-4.1"
  const KILO_AUTO = "kilo-auto/free"
  const fullCatalog = {
    "opencode-go": {
      id: "opencode-go",
      name: "OpenCode Go",
      env: [],
      models: {
        [FLASH]: { id: FLASH, name: "Flash", variants: { low: {}, high: {} } },
        [GPT]: { id: GPT, name: "GPT", variants: { low: {}, high: {} } },
      },
    },
    kilo: { id: "kilo", name: "Kilo", env: [], models: { [KILO_AUTO]: { id: KILO_AUTO, name: "Auto" } } },
  }
  const [catalog, setCatalog] = createSignal(true)
  const [def, setDef] = createSignal({ providerID: "opencode-go", modelID: FLASH })
  const [isCanon, setCanon] = createSignal(false)
  const valid = (sel) => {
    if (!sel || !sel.providerID || !sel.modelID) return false
    const cat = catalog() ? fullCatalog : {}
    const p = cat[sel.providerID]
    if (!p) return false
    if (sel.providerID !== "kilo" && sel.providerID !== "opencode-go") return false
    return !!p.models[sel.modelID]
  }
  const providerValue = {
    providers: () => (catalog() ? fullCatalog : {}),
    connected: () => ["opencode-go"],
    defaults: () => ({}),
    defaultSelection: () => def(),
    models: () => [],
    findModel: (sel) => {
      if (!catalog() || !sel) return undefined
      const p = fullCatalog[sel.providerID]
      const m = p?.models[sel.modelID]
      return m ? { ...m, providerID: sel.providerID, providerName: p.name } : undefined
    },
    authMethods: () => ({}),
    authStates: () => ({}),
    isModelValid: (sel) => valid(sel),
  }
  const configValue = {
    config: () => config(),
    globalConfig: () => config(),
    projectConfig: () => config(),
    settings: () => ({}),
    features: () => ({ indexing: false, sandboxControls: false }),
    loading: () => false,
    isDirty: () => false,
    saving: () => false,
    saveError: () => null,
    canonical: () => isCanon(),
    canonicalMode: () => isCanon(),
    updateConfig: noop,
    updateGlobalConfig: noop,
    updateProjectConfig: noop,
    updateSetting: noop,
    saveConfig: noop,
    discardConfig: noop,
  }
  const languageValue = { locale: () => "en", setLocale: noop, userOverride: () => "", t: (key) => key }

  let ctx = null
  const Probe = () => {
    ctx = useContext(SessionContext)
    return null
  }
  const root = document.createElement("div")
  const dispose = render(
    () =>
      createComponent(VSCodeProvider, {
        get children() {
          return createComponent(ServerProvider, {
            get children() {
              return createComponent(ProviderContext.Provider, {
                value: providerValue,
                get children() {
                  return createComponent(ConfigContext.Provider, {
                    value: configValue,
                    get children() {
                      return createComponent(LanguageContext.Provider, {
                        value: languageValue,
                        get children() {
                          return createComponent(SessionProvider, {
                            get children() {
                              return createComponent(Probe, {})
                            },
                          })
                        },
                      })
                    },
                  })
                },
              })
            },
          })
        },
      }),
    root,
  )
  if (!ctx) fail("SessionContext never became available")

  const emit = (message) => window.dispatchEvent(new window.MessageEvent("message", { data: message }))
  const last = (type) => {
    const list = sent.filter((m) => m.type === type)
    return list[list.length - 1]
  }
  const now = Date.now()
  const iso = new Date(now).toISOString()
  const session = (id) => ({ id, createdAt: iso, updatedAt: iso })
  const userMsg = (id, sid, model) => ({ id, sessionID: sid, role: "user", createdAt: iso, time: { created: now }, ...(model ? { model } : {}) })

  emit({ type: "ready", serverInfo: { version: "test" }, workspaceDirectory: "/" })

  // Pre-canonical valid concrete default: pollute recent/pending with GPT/high,
  // then a no-draft echo must resolve the provider default FLASH/low.
  setCanon(false)
  setCatalog(true)
  setDef({ providerID: "opencode-go", modelID: FLASH })
  ctx.selectModel("opencode-go", GPT)
  ctx.selectVariant("high")
  emit({ type: "sessionCreated", session: session("nd-1") })
  eq(ctx.getSessionModel("nd-1")?.modelID, FLASH, "pre-canonical concrete default must win over recent/pending")
  eq(ctx.currentVariant("nd-1"), "low", "pre-canonical no-draft variant must be the model default, not pending high")
  eq(ctx.currentVariant(), "high", "no-draft echo must not consume pending composer picks")

  // No-draft lifecycle: recovered no-variant history stays undefined, then a
  // manual in-session pick flows into the next send.
  emit({ type: "messagesLoaded", sessionID: "nd-1", messages: [userMsg("m1", "nd-1", { providerID: "opencode-go", modelID: FLASH })] })
  if (ctx.currentVariant("nd-1") !== undefined) fail("recovered no-variant history must display undefined, got " + JSON.stringify(ctx.currentVariant("nd-1")))
  ctx.setCurrentSessionID("nd-1")
  ctx.selectVariant("high", "nd-1")
  eq(ctx.currentVariant("nd-1"), "high", "manual in-session pick must resolve high")
  ctx.sendMessage("hello")
  const send = last("sendMessage")
  if (!send || send.sessionID !== "nd-1") fail("sendMessage must target the current session")
  eq(send.variant, "high", "manual high must flow into sendMessage")

  // Pre-canonical KILO_AUTO stays hidden: fallback null, so an unrecovered
  // no-draft session resolves null (never kilo) even with polluted recent.
  ctx.setCurrentSessionID(undefined)
  setDef({ providerID: "kilo", modelID: KILO_AUTO })
  ctx.selectModel("opencode-go", GPT)
  ctx.selectVariant("high")
  emit({ type: "sessionCreated", session: session("nd-2") })
  const hidden = ctx.getSessionModel("nd-2")
  if (hidden !== null) fail("pre-canonical KILO_AUTO must stay hidden, got " + JSON.stringify(hidden))
  if (ctx.currentVariant("nd-2") !== undefined) fail("pre-canonical hidden fallback must not expose a variant, got " + JSON.stringify(ctx.currentVariant("nd-2")))

  // Canonical-ready behavior unchanged: kilo fallback allowed, recovered
  // history still wins over it.
  setCanon(true)
  setDef({ providerID: "kilo", modelID: KILO_AUTO })
  emit({ type: "sessionCreated", session: session("nd-3") })
  eq(ctx.getSessionModel("nd-3")?.modelID, KILO_AUTO, "canonical kilo fallback must resolve when valid")
  emit({ type: "messagesLoaded", sessionID: "nd-3", messages: [userMsg("m1", "nd-3", { providerID: "opencode-go", modelID: GPT })] })
  eq(ctx.getSessionModel("nd-3")?.modelID, GPT, "recovered history must still win over the canonical fallback")

  dispose()
  console.log("${PASS}")
`

describe("pre-canonical configured fallback", () => {
  it("exposes a valid concrete default, hides KILO_AUTO, keeps no-draft lifecycle, and leaves canonical behavior unchanged", async () => {
    const name = `.tmp-configured-fallback-${randomUUID()}`
    const entry = path.join(WEBVIEW, `${name}.ts`)
    const out = path.join(WEBVIEW, `${name}.js`)
    fs.writeFileSync(entry, CHILD)
    try {
      const attempts = 3
      const failures: string[] = []
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          const built = await esbuild.build({
            entryPoints: [entry],
            bundle: true,
            format: "esm",
            platform: "browser",
            outfile: out,
            plugins: [solidPlugin()],
            external: ["happy-dom"],
            logLevel: "silent",
          })
          if (built.errors.length > 0) {
            expect.unreachable(`child bundle failed:\n${built.errors.map((e) => e.text).join("\n")}`)
          }
        } catch (err) {
          failures.push(`attempt ${attempt} build: ${String(err)}`)
          continue
        }
        const result = Bun.spawnSync(["bun", out], {
          cwd: WEBVIEW,
          stdout: "pipe",
          stderr: "pipe",
        })
        const output = result.stdout.toString() + result.stderr.toString()
        if (output.includes(PASS)) return
        const logic = output.indexOf(FAIL)
        if (logic !== -1) {
          expect.unreachable(
            output
              .slice(logic + FAIL.length)
              .split("\n")[0]
              ?.trim(),
          )
        }
        failures.push(`attempt ${attempt} exit ${result.exitCode}: ${output.trim() || "<no output>"}`)
      }
      expect.unreachable(`configured fallback child never reported success:\n${failures.join("\n")}`)
    } finally {
      fs.rmSync(entry, { force: true })
      fs.rmSync(out, { force: true })
    }
  }, 30_000)
})
