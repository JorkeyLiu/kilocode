import { describe, expect, it } from "bun:test"
import path from "node:path"
import * as fs from "node:fs"
import { randomUUID } from "node:crypto"
import esbuild from "esbuild"
import { solidPlugin } from "esbuild-plugin-solid"

// Real SessionProvider lifecycle regression for the no-draft sessionCreated
// corruption: existing sessions such as nexus/inspector and nexus/manifestor
// that actually ran with the provider default variant must never resolve
// unrelated pending composer picks, and late memory/config/catalog/replay
// events must never flip them to legacy model-only "high".
//
// The real SessionProvider runs in a child process under happy-dom, exactly
// like session-variant-memory.test.ts: solid-js effects only run under the
// browser export condition and the JSX must be transpiled with esbuild-plugin-
// solid, so the child is bundled with the production webview toolchain. All
// extension events are delivered through the real window message channel that
// VSCodeProvider listens on in production (window.dispatchEvent with a
// MessageEvent carrying the extension payload). The child prints an explicit
// PASS/FAIL sentinel; a FAIL is a real regression and surfaces immediately,
// while any other non-zero exit is a transient spawn failure under load and is
// retried so the suite stays deterministic.
const WEBVIEW = path.resolve(import.meta.dir, "../../webview-ui")

const PASS = "NO_DRAFT_CORRELATION_PASS"
const FAIL = "NO_DRAFT_CORRELATION_FAIL:"

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
  const assert = (cond, label, actual) => {
    if (!cond) fail(label + (actual === undefined ? "" : ": got " + JSON.stringify(actual)))
  }
  const eq = (actual, expected, label) => {
    if (actual !== expected) fail(label + ": got " + JSON.stringify(actual) + " expected " + JSON.stringify(expected))
  }

  const noop = () => {}
  const [config, setConfig] = createSignal({})

  const FLASH = "deepseek-v4-flash"
  const GPT = "gpt-4.1"
  const models = {
    [FLASH]: { id: FLASH, name: "DeepSeek V4 Flash", variants: { low: {}, high: {} } },
    [GPT]: { id: GPT, name: "GPT-4.1", variants: { low: {}, high: {} } },
  }
  // Late catalog: the provider catalog is empty until the extension's
  // providersLoaded push lands, so variantList is empty and the UI shows the
  // pre-recovery "Not set" state.
  const [catalog, setCatalog] = createSignal(false)
  const providerValue = {
    providers: () => (catalog() ? { "opencode-go": { id: "opencode-go", name: "OpenCode Go", env: [], models } } : {}),
    connected: () => ["opencode-go"],
    defaults: () => ({}),
    defaultSelection: () => ({ providerID: "opencode-go", modelID: FLASH }),
    models: () =>
      catalog()
        ? Object.values(models).map((m) => ({ ...m, providerID: "opencode-go", providerName: "OpenCode Go" }))
        : [],
    findModel: (sel) => {
      if (!catalog() || !sel) return undefined
      const m = models[sel.modelID]
      return m ? { ...m, providerID: sel.providerID, providerName: "OpenCode Go" } : undefined
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

  // Real window message channel — the same channel VSCodeProvider registers on
  // in production webviews; the SessionProvider consumes the exact extension
  // message shapes through it.
  const emit = (message) => window.dispatchEvent(new window.MessageEvent("message", { data: message }))
  const last = (type) => {
    const list = sent.filter((m) => m.type === type)
    return list[list.length - 1]
  }

  const now = Date.now()
  const iso = new Date(now).toISOString()
  const session = (id) => ({ id, createdAt: iso, updatedAt: iso })
  const userMsg = (id, sid, model) => ({
    id,
    sessionID: sid,
    role: "user",
    createdAt: iso,
    time: { created: now },
    ...(model ? { model } : {}),
  })

  const INSPECTOR = "nexus/inspector"
  const MANIFESTOR = "nexus/manifestor"
  const FLASH_SEL = { providerID: "opencode-go", modelID: FLASH }

  // Bring the backend up so sendMessage/sendCommand/createSession run.
  emit({ type: "ready", serverInfo: { version: "test" }, workspaceDirectory: "/" })

  // ---- Phase A: pending picks exist; no-draft sessionCreated; late catalog ----
  // The user is composing fresh: agent plan + model opencode-go/deepseek-v4-flash
  // + variant high. A no-draft sessionCreated (SSE/legacy replay) arrives for
  // the restored nexus/inspector session while those picks are pending.
  ctx.selectAgent("plan")
  ctx.selectModel("opencode-go", FLASH)
  ctx.selectVariant("high")
  emit({ type: "sessionCreated", session: session(INSPECTOR) })
  assert(
    ctx.currentVariant(INSPECTOR) === undefined,
    "no-draft sessionCreated before recovery/catalog must not expose a variant",
    ctx.currentVariant(INSPECTOR),
  )
  eq(ctx.getSessionAgent(INSPECTOR), "code", "no-draft sessionCreated must not promote the pending agent")
  // Actual history: model opencode-go/deepseek-v4-flash with NO variant
  // (provider default) — authoritative for this session.
  emit({ type: "messagesLoaded", sessionID: INSPECTOR, messages: [userMsg("m1", INSPECTOR, FLASH_SEL)] })
  assert(ctx.currentVariant(INSPECTOR) === undefined, "recovered no-variant history must display undefined", ctx.currentVariant(INSPECTOR))
  // Late memory: only the model-only key holds high (no agent-specific memory).
  emit({ type: "variantsLoaded", variants: { "opencode-go/deepseek-v4-flash": "high" } })
  assert(
    ctx.currentVariant(INSPECTOR) === undefined,
    "model-only memory high must not leak into recovered no-variant history",
    ctx.currentVariant(INSPECTOR),
  )
  // Late catalog arrives — recovered no-variant history still wins.
  setCatalog(true)
  assert(ctx.currentVariant(INSPECTOR) === undefined, "late catalog must not flip recovered default to high", ctx.currentVariant(INSPECTOR))
  // The pending composer picks were NOT consumed by the no-draft session.
  eq(ctx.currentVariant(), "high", "no-draft sessionCreated must not consume pending fresh-composer picks")
  // Repeated replay/recovery of the same no-draft session stays settled.
  emit({ type: "sessionCreated", session: session(INSPECTOR) })
  emit({ type: "messagesLoaded", sessionID: INSPECTOR, messages: [userMsg("m2", INSPECTOR, FLASH_SEL)] })
  assert(ctx.currentVariant(INSPECTOR) === undefined, "replayed no-draft sessionCreated after recovery must stay undefined", ctx.currentVariant(INSPECTOR))
  emit({ type: "variantsLoaded", variants: { "opencode-go/deepseek-v4-flash": "high" } })
  assert(ctx.currentVariant(INSPECTOR) === undefined, "replayed variantsLoaded after recovery must stay undefined", ctx.currentVariant(INSPECTOR))
  eq(ctx.currentVariant(), "high", "pending picks survive repeated no-draft replays")

  // ---- Phase B: variantsLoaded BEFORE messagesLoaded + cross-model detector ----
  // The user switches the pending model to a DIFFERENT model: any seeding of
  // the pending model/variant into nexus/manifestor would be visible as a
  // session override or a session-scoped variant key.
  ctx.selectModel("opencode-go", GPT)
  ctx.selectVariant("high")
  emit({ type: "sessionCreated", session: session(MANIFESTOR) })
  if (ctx.currentVariant(MANIFESTOR) === "high") {
    fail("no-draft sessionCreated must not expose pending high before recovery")
  }
  emit({ type: "variantsLoaded", variants: { "opencode-go/deepseek-v4-flash": "high" } })
  if (ctx.currentVariant(MANIFESTOR) === "high") {
    fail("memory alone must not flip a pre-recovery session to high")
  }
  emit({ type: "messagesLoaded", sessionID: MANIFESTOR, messages: [userMsg("m1", MANIFESTOR, FLASH_SEL)] })
  assert(
    ctx.currentVariant(MANIFESTOR) === undefined,
    "recovered no-variant history must display undefined (variantsLoaded before messagesLoaded)",
    ctx.currentVariant(MANIFESTOR),
  )
  const model = ctx.getSessionModel(MANIFESTOR)
  if (!model || model.modelID !== FLASH) {
    fail("no-draft sessionCreated must not seed a pending model override: got " + JSON.stringify(model))
  }
  // Replay the no-draft sessionCreated + full reload — still settled undefined.
  emit({ type: "sessionCreated", session: session(MANIFESTOR) })
  emit({ type: "messagesLoaded", sessionID: MANIFESTOR, messages: [userMsg("m2", MANIFESTOR, FLASH_SEL)] })
  assert(
    ctx.currentVariant(MANIFESTOR) === undefined,
    "replayed no-draft sessionCreated must stay undefined (variantsLoaded first)",
    ctx.currentVariant(MANIFESTOR),
  )
  eq(ctx.currentVariant(), "high", "cross-model pending picks survive no-draft replays")

  // ---- Phase C: manual in-session high then send/command use the same result ----
  ctx.setCurrentSessionID(INSPECTOR)
  ctx.selectVariant("high", INSPECTOR)
  eq(ctx.currentVariant(INSPECTOR), "high", "manual in-session pick must resolve high")
  ctx.sendMessage("hello inspector")
  const send = last("sendMessage")
  if (!send || send.sessionID !== INSPECTOR) fail("sendMessage must target the current session")
  eq(send.variant, ctx.currentVariant(INSPECTOR), "outbound send must use the exact current variant")
  eq(send.variant, "high", "manual high must flow into sendMessage")
  ctx.sendCommand("compact", "")
  const cmd = last("sendCommand")
  if (!cmd || cmd.sessionID !== INSPECTOR) fail("sendCommand must target the current session")
  eq(cmd.variant, "high", "manual high must flow into sendCommand")

  // ---- Phase D: reload/history high recovery ----
  // The session's actual history says high — recovery must display high and
  // later async events must not clobber it.
  emit({
    type: "messagesLoaded",
    sessionID: MANIFESTOR,
    messages: [userMsg("m3", MANIFESTOR, { ...FLASH_SEL, variant: "high" })],
  })
  eq(ctx.currentVariant(MANIFESTOR), "high", "recovered history high must display high")
  emit({ type: "variantsLoaded", variants: { "opencode-go/deepseek-v4-flash": "high" } })
  eq(ctx.currentVariant(MANIFESTOR), "high", "reloaded history high survives variantsLoaded")
  emit({ type: "sessionCreated", session: session(MANIFESTOR) })
  eq(ctx.currentVariant(MANIFESTOR), "high", "replayed no-draft sessionCreated must not clobber recovered history high")

  // ---- Phase E: fresh composer picks still attach via the exact draftID ----
  ctx.setCurrentSessionID(undefined)
  ctx.selectModel("opencode-go", FLASH)
  ctx.selectVariant("high")
  eq(ctx.currentVariant(), "high", "fresh composer pending pick must resolve high")
  ctx.sendMessage("fresh task", "opencode-go", FLASH)
  const freshSend = last("sendMessage")
  if (!freshSend || typeof freshSend.draftID !== "string") fail("fresh send must mint a correlated draftID")
  eq(freshSend.variant, ctx.currentVariant(), "fresh send must carry the exact current variant")
  // The extension echoes sessionCreated with the same draftID → picks attach.
  emit({ type: "sessionCreated", session: session("fresh-1"), draftID: freshSend.draftID })
  eq(ctx.currentVariant("fresh-1"), "high", "draft-correlated fresh session must attach pending picks")

  // ---- Phase F: truly fresh composer resolves generic model-only memory high ----
  ctx.setCurrentSessionID(undefined)
  eq(ctx.currentVariant(), "high", "fresh composer resolves generic model-only memory high")
  ctx.sendMessage("memory send")
  const memSend = last("sendMessage")
  eq(memSend.variant, ctx.currentVariant(), "outbound send must match the fresh composer result")
  eq(memSend.variant, "high", "generic memory high must flow into a fresh send")

  // ---- Phase G: duplicate draft echo is idempotent; no-draft echo is inert ----
  // A webview-initiated session can be echoed twice (the extension's
  // draft-correlated echo plus the forwarded no-draft SSE session.created),
  // and the no-draft echo must never consume composer picks or disturb the
  // session the draft already attached to.
  ctx.setCurrentSessionID(undefined)
  ctx.selectModel("opencode-go", FLASH)
  ctx.selectVariant("high")
  ctx.sendMessage("duplicate echo probe")
  const dupSend = last("sendMessage")
  if (!dupSend || typeof dupSend.draftID !== "string") fail("sendMessage must mint a correlated draftID")
  emit({ type: "sessionCreated", session: session("dup-a"), draftID: dupSend.draftID })
  eq(ctx.currentVariant("dup-a"), "high", "the draft echo attaches pending picks")
  eq(ctx.currentSessionID(), "dup-a", "the draft echo selects the created session")
  // Duplicate echo of the same draftID must be idempotent.
  emit({ type: "sessionCreated", session: session("dup-a"), draftID: dupSend.draftID })
  eq(ctx.currentVariant("dup-a"), "high", "a duplicate draft echo must not corrupt attached picks")
  eq(ctx.currentSessionID(), "dup-a", "a duplicate draft echo must not reselect or deselect")
  // Fresh composer picks, then a no-draft SSE echo for another session.
  ctx.selectModel("opencode-go", GPT)
  ctx.selectVariant("high")
  eq(ctx.currentVariant(), "high", "pending picks resolve in the composer before the no-draft echo")
  emit({ type: "sessionCreated", session: session("dup-b") })
  eq(ctx.currentVariant(), "high", "a no-draft echo must not consume pending composer picks")
  eq(ctx.getSessionModel("dup-b")?.modelID, FLASH, "a no-draft echo must not seed a pending model override")
  // dup-b is not recovery-ready and never got a session-scoped key, so it can
  // only resolve the fallback "low" — never the pending "high".
  eq(ctx.currentVariant("dup-b"), "low", "a no-draft echo must not attach the pending session variant")
  eq(ctx.currentVariant("dup-a"), "high", "a no-draft echo must not disturb the earlier draft-correlated session")

  // ---- Phase H: failed-send prune guard with two in-flight submissions ----
  // Two submissions on one draft, then the user navigates away. A failure of
  // the first submission must NOT prune the draft while the second submission
  // is still in flight; the final failure on the abandoned, unowned draft
  // must prune its full owned state.
  ctx.setCurrentSessionID(undefined)
  ctx.selectAgent("plan")
  ctx.selectModel("opencode-go", FLASH)
  ctx.selectVariant("high")
  ctx.sendMessage("concurrent send one")
  const one = last("sendMessage")
  if (!one || typeof one.draftID !== "string") fail("concurrent send must mint a correlated draftID")
  const D = one.draftID
  // Second submission reusing the same draft while the first is still in flight.
  ctx.sendMessage("concurrent send two", "opencode-go", FLASH, undefined, D)
  const two = last("sendMessage")
  if (!two || two.draftID !== D) fail("second concurrent send must reuse the same draftID")
  eq(ctx.getSessionAgent(D), "plan", "seeded draft agent must be present before failures")
  // Navigation moves the active draft away while both submissions are in flight.
  ctx.setDraftSessionID(undefined)
  emit({
    type: "sendMessageFailed",
    error: "boom one",
    text: "concurrent send one",
    draftID: D,
    messageID: one.messageID,
  })
  eq(ctx.getSessionAgent(D), "plan", "failure of one of two submissions must not prune the draft")
  emit({
    type: "sendMessageFailed",
    error: "boom two",
    text: "concurrent send two",
    draftID: D,
    messageID: two.messageID,
  })
  eq(ctx.getSessionAgent(D), "code", "final failure on an abandoned unowned draft must prune its full state")

  dispose()
  console.log("${PASS}")
`

describe("no-draft sessionCreated pending-choice correlation", () => {
  // The child harness bundles the real webview (esbuild + esbuild-plugin-solid)
  // and spawns a happy-dom child process, so it needs more than Bun's default
  // 5s per-test timeout, especially when other files run concurrently.
  it("existing recovered-default sessions stay undefined across async arrivals, draft-correlated send sessions attach picks, and duplicate/no-draft echoes stay inert", async () => {
    // Entry and output live at the webview-ui root so the child's relative
    // `./src/context/...` imports resolve, and so the bundled output can still
    // resolve the external `happy-dom` package from webview-ui's node_modules.
    const name = `.tmp-no-draft-correlation-${randomUUID()}`
    const entry = path.join(WEBVIEW, `${name}.ts`)
    const out = path.join(WEBVIEW, `${name}.js`)
    fs.writeFileSync(entry, CHILD)
    try {
      const attempts = 3
      const failures: string[] = []

      for (let attempt = 1; attempt <= attempts; attempt++) {
        // Bundle inside the retry loop: when several child-harness tests run
        // concurrently, esbuild's in-process service can be torn down between
        // builds ("The service is no longer running") — treat that as a
        // transient failure and retry rather than failing the suite.
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
        // A FAIL sentinel is a real assertion failure in the lifecycle logic — surface it now.
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

      expect.unreachable(`no-draft correlation child never reported success:\n${failures.join("\n")}`)
    } finally {
      // Exact owned paths only — never glob temp artifacts owned by other runs.
      fs.rmSync(entry, { force: true })
      fs.rmSync(out, { force: true })
    }
  }, 30_000)
})
