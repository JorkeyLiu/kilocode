import { describe, expect, it } from "bun:test"
import path from "node:path"
import * as fs from "node:fs"
import { randomUUID } from "node:crypto"
import esbuild from "esbuild"
import { solidPlugin } from "esbuild-plugin-solid"

// Renders the real PermissionDock in a happy-dom child process and verifies
// the redacted provenance explanation: valid provenance is hidden while
// collapsed, shows only safe reason/layer/ceiling labels when expanded,
// malformed/future provenance renders nothing, raw sensitive material never
// reaches the DOM, absent provenance leaves the dock unchanged, the decide
// payload is byte-for-byte unchanged, and the expander is keyboard
// accessible with correct aria state.
const WEBVIEW = path.resolve(import.meta.dir, "../../webview-ui")

const PASS = "PERMISSION_DOCK_PROVENANCE_PASS"
const FAIL = "PERMISSION_DOCK_PROVENANCE_FAIL:"

const CHILD = `
  import { Window } from "happy-dom"

  const window = new Window()
  globalThis.window = window
  globalThis.document = window.document
  globalThis.Node = window.Node
  globalThis.navigator = window.navigator
  globalThis.MutationObserver = window.MutationObserver
  globalThis.ResizeObserver = window.ResizeObserver
  globalThis.getComputedStyle = window.getComputedStyle.bind(window)
  if (typeof globalThis.requestAnimationFrame !== "function") {
    globalThis.requestAnimationFrame = (cb) => {
      cb(0)
      return 0
    }
  }

  const { createComponent } = await import("solid-js")
  const { render } = await import("solid-js/web")
  const { LanguageContext } = await import("./src/context/language.tsx")
  const { SessionContext } = await import("./src/context/session.tsx")
  const { ConfigContext } = await import("./src/context/config.tsx")
  const { PermissionDock } = await import("./src/components/chat/PermissionDock.tsx")

  const fail = (reason) => {
    console.log("${FAIL}" + reason)
    process.exit(2)
  }

  const noop = () => {}
  const dict = {
    "notification.permission.title": "Permission required",
    "notification.permission.titleSubagent": "Permission required (subagent)",
    "ui.permission.manageAutoApprove": "Manage Auto-Approve Rules",
    "ui.permission.provenance.why": "Why this is required",
    "ui.permission.provenance.reason.ask": "Approval is required because no saved rule allows this yet.",
    "ui.permission.provenance.reason.askCeiling": "Approval is required by a safety rule. Only an exact approval for this request can satisfy it.",
    "ui.permission.provenance.reason.deny": "This action is blocked by a rule.",
    "ui.permission.provenance.reason.allow": "All applicable rules allow this action.",
    "ui.permission.provenance.layers": "Contributing scopes",
    "ui.permission.provenance.source.runtime": "Runtime safety",
    "ui.permission.provenance.source.global": "Global",
    "ui.permission.provenance.source.project": "Project",
    "ui.permission.provenance.source.agent": "Agent",
    "ui.permission.provenance.source.session": "Session",
    "ui.permission.provenance.source.approval": "Approval",
    "ui.permission.provenance.source.protectedFile": "Protected files",
    "ui.permission.provenance.decision.deny": "Blocked",
    "ui.permission.provenance.decision.ask": "Needs approval",
    "ui.permission.provenance.decision.askCeiling": "Needs approval (safety rule)",
    "ui.permission.provenance.decision.allow": "Allowed",
    "ui.permission.provenance.decision.noCeiling": "No restriction",
    "ui.permission.provenance.ceiling.a": "Hard safety block",
    "ui.permission.provenance.ceiling.b": "Configuration protection",
    "ui.permission.provenance.ceiling.c": "Sensitive file protection",
    "ui.permission.toolLabel.edit": "Edit",
    "ui.permission.allowOnce": "Allow once",
    "ui.permission.deny": "Deny",
  }
  const t = (key, params) => {
    let text = dict[key] ?? key
    if (params) {
      for (const [k, v] of Object.entries(params)) text = text.split("{{" + k + "}}").join(String(v))
    }
    return text
  }

  function mount(request, onDecide) {
    const root = document.createElement("div")
    document.body.appendChild(root)
    const dispose = render(
      () =>
        createComponent(LanguageContext.Provider, {
          value: { locale: () => "en", setLocale: noop, userOverride: () => "", t },
          get children() {
            return createComponent(SessionContext.Provider, {
              value: { currentSessionID: () => request.sessionID, respondingPermissions: () => new Set() },
              get children() {
                return createComponent(ConfigContext.Provider, {
                  value: {
                    config: () => ({ permission: undefined }),
                    globalConfig: () => ({}),
                    projectConfig: () => ({}),
                    settings: () => ({}),
                    features: () => ({}),
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
                  },
                  get children() {
                    return createComponent(PermissionDock, { request, responding: false, onDecide })
                  },
                })
              },
            })
          },
        }),
      root,
    )
    return {
      root,
      dispose: () => {
        dispose()
        root.remove()
      },
    }
  }

  const SECRET_PATH = "/secret/home/user/.config/kilo/kilo.json"
  const SECRET_PATTERN = "super-secret-pattern-xyz"
  const SECRET_OP = "permission:per_secret_001"
  const SECRET_SESSION = "ses_secret_999"

  function validProvenance() {
    return {
      schemaVersion: "1",
      request: {
        permissionRequestId: "per_secret_001",
        operationId: SECRET_OP,
        permission: "edit",
        patterns: [SECRET_PATH],
      },
      contributingLayers: [
        { sourceKind: "runtime-safety", canonicalPath: SECRET_PATH, decision: "ask-ceiling", rules: [{ pattern: SECRET_PATTERN, action: "ask", order: 0 }] },
        { sourceKind: "project-file", canonicalPath: SECRET_PATH, decision: "ask", rules: [] },
        { sourceKind: "agent-manifest", canonicalPath: "agent:secret-agent", decision: "allow", rules: [{ pattern: SECRET_PATTERN, action: "allow", order: 0 }] },
        { sourceKind: "protected-file", canonicalPath: SECRET_PATH, decision: "ask", rules: [] },
      ],
      decisive: { result: "ask-ceiling", reason: "ceiling-b", ceilingId: "(b)" },
      approval: { kind: "session", patterns: [SECRET_PATTERN], scope: SECRET_SESSION + ":secret-agent", expiry: "session-end" },
    }
  }

  const base = { id: "perm-1", sessionID: "ses-1", patterns: [], always: [], args: {} }

  // Case A: valid provenance hidden while collapsed, then safe labels on expand.
  {
    const decisions = []
    const request = { ...base, toolName: "edit", patterns: ["src/app.ts"], always: ["*"], args: { provenance: validProvenance() } }
    const { root, dispose } = mount(request, (response, approved, denied) => decisions.push({ response, approved, denied }))
    const section = root.querySelector('[data-slot="permission-provenance-section"]')
    if (!section) fail("valid provenance has no explanation section")
    const header = section.querySelector('[data-slot="permission-provenance-header"]')
    if (!header) fail("no provenance header")
    if (header.getAttribute("aria-expanded") !== "false") fail("provenance must start collapsed")
    if (header.textContent !== "Why this is required") fail("header copy wrong: " + JSON.stringify(header.textContent))
    if (root.innerHTML.includes(SECRET_PATH)) fail("sensitive path leaked while collapsed")
    if (root.innerHTML.includes(SECRET_PATTERN)) fail("sensitive pattern leaked while collapsed")
    const reasonBefore = section.querySelector('[data-slot="permission-provenance-reason"]')
    // Reason text lives inside the collapsed container; it must not be visible
    // before expand (no data-open on the collapse wrapper).
    const collapse = section.querySelector('[data-slot="permission-provenance-collapse"]')
    if (!collapse) fail("no provenance collapse")
    if (collapse && collapse.hasAttribute("data-open")) fail("provenance collapse must start closed")
    if (collapse.getAttribute("aria-hidden") !== "true") fail("provenance collapse must start aria-hidden true")
    void reasonBefore
    header.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
    if (header.getAttribute("aria-expanded") !== "true") fail("aria-expanded did not open")
    if (collapse.getAttribute("aria-hidden") !== "false") fail("provenance collapse must expose aria-hidden false after expand")
    const html = root.innerHTML
    if (!html.includes("Only an exact approval for this request can satisfy it")) fail("corrected ceiling reason missing")
    if (!html.includes("Runtime safety")) fail("runtime safety label missing")
    if (!html.includes("Project")) fail("project label missing")
    if (!html.includes("Agent")) fail("agent label missing")
    if (!html.includes("Protected files")) fail("protected-file label missing")
    if (html.includes(">Approval<")) fail("protected-file mislabeled as Approval")
    if (!html.includes("Configuration protection")) fail("ceiling label missing")
    if (html.includes(SECRET_PATH)) fail("sensitive canonicalPath leaked after expand")
    if (html.includes(SECRET_PATTERN)) fail("sensitive pattern leaked after expand")
    if (html.includes(SECRET_OP)) fail("operation id leaked after expand")
    if (html.includes(SECRET_SESSION)) fail("session id leaked after expand")
    if (html.includes("secret-agent")) fail("agent id leaked after expand")
    if (html.includes("/secret/")) fail("absolute path leaked after expand")
    // Payload unchanged: Allow once submits empty always arrays.
    const allowOnce = [...root.querySelectorAll('[data-component="button"]')].find((b) => b.textContent === "Allow once")
    if (!allowOnce) fail("no Allow once button")
    allowOnce.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
    if (decisions.length !== 1) fail("onDecide not called once")
    const d = decisions[0]
    if (d.response !== "once" || d.approved.length !== 0 || d.denied.length !== 0) fail("payload changed: " + JSON.stringify(d))
    dispose()
  }

  // Case B: malformed and future provenance render no explanation.
  {
    const bad = [
      { schemaVersion: "2", decisive: { result: "ask", ceilingId: null }, contributingLayers: [{ sourceKind: "project-file", decision: "ask" }] },
      { schemaVersion: "1", decisive: { result: "ask", ceilingId: null }, contributingLayers: [{ sourceKind: "nope", decision: "ask" }] },
      { schemaVersion: "1", decisive: { result: "maybe", ceilingId: null }, contributingLayers: [{ sourceKind: "project-file", decision: "ask" }] },
      { schemaVersion: "1", decisive: { result: "ask", ceilingId: "(z)" }, contributingLayers: [{ sourceKind: "project-file", decision: "ask" }] },
      { schemaVersion: "1", decisive: { result: "ask", ceilingId: null }, contributingLayers: [] },
      "not-an-object",
    ]
    for (let i = 0; i < bad.length; i++) {
      const request = { ...base, toolName: "edit", patterns: ["src/app.ts"], always: ["*"], args: { provenance: bad[i] } }
      const { root, dispose } = mount(request, noop)
      if (root.querySelector('[data-slot="permission-provenance-section"]')) fail("malformed provenance rendered section at index " + i)
      // Permission handling still works: dock renders the allow button.
      const allowOnce = [...root.querySelectorAll('[data-component="button"]')].find((b) => b.textContent === "Allow once")
      if (!allowOnce) fail("malformed provenance broke dock at index " + i)
      dispose()
    }
  }

  // Case C: absent provenance leaves the dock unchanged.
  {
    const request = { ...base, toolName: "edit", patterns: ["src/app.ts"], always: ["*"], args: {} }
    const { root, dispose } = mount(request, noop)
    if (root.querySelector('[data-slot="permission-provenance-section"]')) fail("absent provenance rendered section")
    dispose()
  }

  // Case D: keyboard toggling flips aria state open/closed.
  {
    const request = { ...base, toolName: "edit", patterns: ["src/app.ts"], always: ["*"], args: { provenance: validProvenance() } }
    const { root, dispose } = mount(request, noop)
    const header = root.querySelector('[data-slot="permission-provenance-header"]')
    if (!header) fail("no header for keyboard case")
    if (header.tagName !== "BUTTON") fail("provenance header is not a button")
    header.focus()
    if (document.activeElement !== header) fail("header not focusable")
    header.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    header.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
    await new Promise((r) => setTimeout(r, 0))
    if (header.getAttribute("aria-expanded") !== "true") fail("keyboard/click did not open")
    header.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
    await new Promise((r) => setTimeout(r, 0))
    if (header.getAttribute("aria-expanded") !== "false") fail("second toggle did not close")
    dispose()
  }

  console.log("${PASS}")
`

describe("PermissionDock provenance explanation (redacted)", () => {
  it("hides while collapsed, shows safe labels on expand, fails closed, keeps payload", async () => {
    const name = `.tmp-permission-dock-provenance-${randomUUID()}`
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
        plugins: [
          solidPlugin(),
          {
            name: "pierre-worker-alias",
            setup(build) {
              build.onResolve({ filter: /pierre\/worker$/ }, (args) => {
                if (args.path.includes("@pierre")) return
                return { path: path.join(WEBVIEW, "pierre-worker.ts") }
              })
            },
          },
        ],
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

      expect.unreachable(`PermissionDock provenance child never reported success:\n${failures.join("\n")}`)
    } finally {
      fs.rmSync(entry, { force: true })
      fs.rmSync(out, { force: true })
    }
  }, 60_000)
})
