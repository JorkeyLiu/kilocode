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
// explicit PASS/FAIL sentinel: a FAIL means the selectVariant memory logic
// regressed (fail immediately), while any other non-zero exit is a transient
// spawn failure under load and is retried so the suite stays deterministic.
const WEBVIEW = path.resolve(import.meta.dir, "../../webview-ui")

const PASS = "VARIANT_MEMORY_PASS"
const FAIL = "VARIANT_MEMORY_FAIL:"

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
  const [config, setConfig] = createSignal({})

  // Two models, each with the same variant names so a stale value is only
  // invalid when it is absent from the model's variant map (checked at read time).
  const models = {
    "gpt-4.1": { id: "gpt-4.1", name: "GPT-4.1", variants: { low: {}, medium: {}, high: {} } },
    "claude-sonnet-4": { id: "claude-sonnet-4", name: "Sonnet", variants: { low: {}, medium: {}, high: {} } },
  }
  const providerValue = {
    providers: () => ({ kilo: { id: "kilo", name: "Kilo", env: [], models } }),
    connected: () => ["kilo"],
    defaults: () => ({}),
    defaultSelection: () => ({ providerID: "kilo", modelID: "gpt-4.1" }),
    models: () => Object.values(models).map((m) => ({ ...m, providerID: "kilo", providerName: "Kilo" })),
    findModel: (sel) => {
      if (!sel) return undefined
      const m = models[sel.modelID]
      return m ? { ...m, providerID: sel.providerID, providerName: "Kilo" } : undefined
    },
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

  const posted = () => sent.filter((m) => m.type === "persistVariant")

  // LOCK-002: every session-scoped selectVariant persists the agent+model key
  // and the model-only key; the session-scoped key stays ephemeral.
  ctx.setSessionModel("s1", "kilo", "gpt-4.1")
  ctx.setSessionAgent("s1", "code")
  ctx.selectVariant("high", "s1")
  let mem = posted()
  if (mem.length !== 2) {
    fail("session selectVariant must persist agent+model and model-only keys: " + JSON.stringify(mem))
  }
  const agentPost = mem.find((m) => m.key === "agent/code/kilo/gpt-4.1")
  const legacyPost = mem.find((m) => m.key === "kilo/gpt-4.1")
  if (!agentPost || agentPost.value !== "high" || !legacyPost || legacyPost.value !== "high") {
    fail("session selectVariant must persist agent+model and model-only keys: " + JSON.stringify(mem))
  }
  if (mem.some((m) => m.key.startsWith("session/"))) {
    fail("session-scoped key must never be persisted: " + JSON.stringify(mem))
  }

  // The agent+model memory write restores the last-used variant for a fresh
  // session of the same model and agent, instead of resetting to variants[0].
  ctx.setSessionModel("s2", "kilo", "gpt-4.1")
  const restored = ctx.currentVariant("s2")
  if (restored !== "high") {
    fail("agent+model memory not restored on model switch: got " + JSON.stringify(restored))
  }

  // An explicit session selection still beats the memory value, and the
  // in-session pick still updates and persists the agent-scoped key.
  ctx.selectVariant("low", "s2")
  mem = posted().slice(-2)
  const agentPost2 = mem.find((m) => m.key === "agent/code/kilo/gpt-4.1")
  const legacyPost2 = mem.find((m) => m.key === "kilo/gpt-4.1")
  if (!agentPost2 || agentPost2.value !== "low" || !legacyPost2 || legacyPost2.value !== "low") {
    fail("in-session pick must persist the agent+model and model-only keys: " + JSON.stringify(mem))
  }
  if (ctx.currentVariant("s2") !== "low") {
    fail("explicit session selection not applied: " + JSON.stringify(ctx.currentVariant("s2")))
  }

  // No-session selectVariant persists the model-only memory key AND the
  // agent-scoped key. The model-only ("legacy") persistence is newly
  // introduced by this change — not existing behavior.
  ctx.selectModel("kilo", "gpt-4.1")
  ctx.selectVariant("high")
  const noSession = posted().slice(-2)
  const memoryPost = noSession.find((m) => m.key === "kilo/gpt-4.1")
  const agentDraftPost = noSession.find((m) => m.key === "agent/code/kilo/gpt-4.1")
  if (!memoryPost || memoryPost.value !== "high" || !agentDraftPost || agentDraftPost.value !== "high") {
    fail("no-session selectVariant must persist memory + agent key: " + JSON.stringify(noSession))
  }

  // The explicit session choice from s2 still wins over the newer memory value.
  if (ctx.currentVariant("s2") !== "low") {
    fail("explicit session choice lost to agent+model memory: " + JSON.stringify(ctx.currentVariant("s2")))
  }

  // Cross-agent memory (LOCK-002): the same model keeps an independent variant
  // per agent; switching agents restores each agent's remembered value.
  ctx.selectAgent("build")
  ctx.selectModel("kilo", "gpt-4.1")
  ctx.selectVariant("low")
  ctx.selectAgent("ask")
  ctx.selectModel("kilo", "gpt-4.1")
  ctx.selectVariant("high")
  if (ctx.currentVariant() !== "high") {
    fail("agent ask must remember high: " + JSON.stringify(ctx.currentVariant()))
  }
  ctx.selectAgent("build")
  if (ctx.currentVariant() !== "low") {
    fail("agent build must restore low: " + JSON.stringify(ctx.currentVariant()))
  }
  ctx.selectAgent("ask")
  if (ctx.currentVariant() !== "high") {
    fail("agent ask must restore high: " + JSON.stringify(ctx.currentVariant()))
  }

  // LOCK-001 regression: WITHIN one session, each agent keeps its own
  // session-scoped variant. The session key must carry the agent dimension —
  // with the old agent-less format, agent code's pick wrote a session key
  // that hit for agent ask too (and vice versa), making the agent tier
  // unreachable inside the session.
  ctx.setSessionModel("s3", "kilo", "gpt-4.1")
  ctx.setSessionAgent("s3", "code")
  ctx.selectVariant("low", "s3") // agent code picks low in session s3
  ctx.setSessionAgent("s3", "ask")
  ctx.selectVariant("high", "s3") // agent ask picks high in session s3
  if (ctx.currentVariant("s3") !== "high") {
    fail("agent ask must remember high in-session: " + JSON.stringify(ctx.currentVariant("s3")))
  }
  ctx.setSessionAgent("s3", "code")
  if (ctx.currentVariant("s3") !== "low") {
    fail("agent code must restore low in-session (agent-less session key shadowed the agent tier): " + JSON.stringify(ctx.currentVariant("s3")))
  }
  ctx.setSessionAgent("s3", "ask")
  if (ctx.currentVariant("s3") !== "high") {
    fail("agent ask must restore high in-session: " + JSON.stringify(ctx.currentVariant("s3")))
  }

  // LOCK-005: an explicit fresh-composer pick outranks the configured start.
  // Config now says model_variant "low" for gpt-4.1; the composer pick "high"
  // must win for the upcoming session while memory tiers stay below config.
  setConfig({ model_variant: "low", model_variant_overrides: {} })
  ctx.selectModel("kilo", "gpt-4.1")
  ctx.selectVariant("high")
  if (ctx.currentVariant() !== "high") {
    fail("LOCK-005: fresh-composer pick must outrank the configured variant: " + JSON.stringify(ctx.currentVariant()))
  }
  // Switching the composer agent drops the stale pending pick (it belonged to
  // the previous agent context); the target agent's chain — here the
  // configured "low" — resolves instead.
  ctx.selectAgent("build")
  if (ctx.currentVariant() !== "low") {
    fail("LOCK-005: agent switch must drop the pending pick and resolve config: got " + JSON.stringify(ctx.currentVariant()) + " config=" + JSON.stringify(config()))
  }

  dispose()
  console.log("${PASS}")
`

describe("per-agent variant memory (LOCK-002)", () => {
  it("selectVariant writes and persists the agent+model memory key; memory restores on model and agent switch", async () => {
    // Entry and output live at the webview-ui root so the child's relative
    // `./src/context/...` imports resolve, and so the bundled output can still
    // resolve the external `happy-dom` package from webview-ui's node_modules.
    const name = `.tmp-variant-memory-${randomUUID()}`
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
        // A FAIL sentinel is a real assertion failure in the variant memory logic — surface it now.
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

      expect.unreachable(`variant memory child never reported success:\n${failures.join("\n")}`)
    } finally {
      fs.rmSync(entry, { force: true })
      fs.rmSync(out, { force: true })
    }
  })
})
