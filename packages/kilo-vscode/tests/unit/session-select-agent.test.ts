import { describe, expect, it } from "bun:test"
import path from "node:path"
import * as fs from "node:fs"
import { randomUUID } from "node:crypto"
import esbuild from "esbuild"
import { solidPlugin } from "esbuild-plugin-solid"

// The real SessionProvider is exercised in a child process: solid-js effects only
// run under the browser export condition, and its JSX must be transpiled with
// solid-js (the webview-ui tsconfig's jsxImportSource is not honored by bun's
// runtime transpiler), so the child is bundled with the same esbuild +
// esbuild-plugin-solid toolchain the production webview uses. The child prints an
// explicit PASS/FAIL sentinel: a FAIL means the selectAgent logic regressed (fail
// immediately), while any other non-zero exit is a transient spawn failure under
// load and is retried so the suite stays deterministic.
const WEBVIEW = path.resolve(import.meta.dir, "../../webview-ui")

const PASS = "SELECT_AGENT_PASS"
const FAIL = "SELECT_AGENT_FAIL:"

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

  const noop = () => {}

  // Config with a model configured for the "ask" agent so the old
  // shouldClearModeModelSelection path would have had something to clear.
  const [config] = createSignal({
    agent: { ask: { model: "kilo/anthropic/claude-sonnet-4-6" } },
  })

  const models = {
    "anthropic/claude-sonnet-4-6": { id: "anthropic/claude-sonnet-4-6", name: "Sonnet" },
    "gpt-4o": { id: "gpt-4o", name: "GPT-4o" },
    "custom-model": { id: "custom-model", name: "Custom" },
  }
  const providerValue = {
    providers: () => ({ kilo: { id: "kilo", name: "Kilo", env: [], models } }),
    connected: () => ["kilo"],
    defaults: () => ({}),
    defaultSelection: () => ({ providerID: "kilo", modelID: "anthropic/claude-sonnet-4-6" }),
    models: () => Object.values(models).map((m) => ({ ...m, providerID: "kilo", providerName: "Kilo" })),
    findModel: () => undefined,
    authMethods: () => ({}),
    authStates: () => ({}),
    isModelValid: () => true,
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
    updateConfig: noop,
    updateGlobalConfig: noop,
    updateProjectConfig: noop,
    updateSetting: noop,
    saveConfig: noop,
    discardConfig: noop,
  }
  const languageValue = {
    locale: () => "en",
    setLocale: noop,
    userOverride: () => "",
    t: (key) => key,
  }

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

  // LOCK-001 (session-scoped): switching the agent must not delete the
  // per-session model override.
  ctx.setSessionModel("s1", "kilo", "custom-model")
  ctx.selectAgent("ask", "s1")
  const overrideModel = ctx.getSessionModel("s1")
  if (!overrideModel || overrideModel.modelID !== "custom-model") {
    fail("agent switch cleared sessionOverrides: got " + JSON.stringify(overrideModel))
  }

  // LOCK-001 (agent-scoped): switching the agent must not clear the explicit
  // per-agent model choice (modelSelections + userSetAgents).
  ctx.selectAgent("ask")
  ctx.selectModel("kilo", "gpt-4o")
  ctx.selectAgent("code")
  ctx.selectAgent("ask")
  const chosen = ctx.selected()
  if (!chosen || chosen.modelID !== "gpt-4o") {
    fail("agent switch cleared per-agent model choice: got " + JSON.stringify(chosen))
  }

  dispose()
  console.log("${PASS}")
`

describe("selectAgent model-state preservation (LOCK-001)", () => {
  it("keeps sessionOverrides and per-agent model choices across agent switches", async () => {
    // Entry and output live at the webview-ui root so the child's relative
    // `./src/context/...` imports resolve, and so the bundled output can still
    // resolve the external `happy-dom` package from webview-ui's node_modules.
    const name = `.tmp-select-agent-${randomUUID()}`
    const entry = path.join(WEBVIEW, `${name}.ts`)
    const out = path.join(WEBVIEW, `${name}.js`)
    fs.writeFileSync(entry, CHILD)
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

      const attempts = 3
      const failures: string[] = []

      for (let attempt = 1; attempt <= attempts; attempt++) {
        const result = Bun.spawnSync(["bun", out], {
          cwd: WEBVIEW,
          stdout: "pipe",
          stderr: "pipe",
        })
        const output = result.stdout.toString() + result.stderr.toString()

        if (output.includes(PASS)) return

        const logic = output.indexOf(FAIL)
        // A FAIL sentinel is a real assertion failure in the selectAgent logic — surface it now.
        if (logic !== -1) {
          expect.unreachable(
            output
              .slice(logic + FAIL.length)
              .split("\n")[0]
              ?.trim(),
          )
        }

        // Otherwise the child died before it could run (starved/transient spawn) — retry.
        failures.push(`attempt ${attempt} exit ${result.exitCode}: ${output.trim() || "<no output>"}`)
      }

      expect.unreachable(`selectAgent child never reported success:\n${failures.join("\n")}`)
    } finally {
      fs.rmSync(entry, { force: true })
      fs.rmSync(out, { force: true })
    }
  })
})
