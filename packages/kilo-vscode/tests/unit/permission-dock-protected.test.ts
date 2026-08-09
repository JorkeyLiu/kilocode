import { describe, expect, it } from "bun:test"
import path from "node:path"
import * as fs from "node:fs"
import { randomUUID } from "node:crypto"
import esbuild from "esbuild"
import { solidPlugin } from "esbuild-plugin-solid"

// Renders the real PermissionDock (kilo-ui + solid-js JSX) in a happy-dom child
// process, bundled with the same esbuild + esbuild-plugin-solid toolchain the
// production webview uses. Verifies the protected config-file approval UX:
// the protected heading/scope note (agent-aware), the exact-path rule row,
// and that the checked-rule payload submitted on "Allow once" is unchanged
// (LOCK-002/003). The child prints an explicit PASS/FAIL sentinel; other
// non-zero exits are transient spawn failures and are retried.
const WEBVIEW = path.resolve(import.meta.dir, "../../webview-ui")

const PASS = "PERMISSION_DOCK_PROTECTED_PASS"
const FAIL = "PERMISSION_DOCK_PROTECTED_FAIL:"

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
    "ui.permission.configProtected.edit": "Config file edits always require approval",
    "ui.permission.configProtected.access": "Kilo configuration access always requires approval",
    "ui.permission.configProtected.scope": "Saved approvals apply only to {{agent}} and these exact paths.",
    "ui.permission.configProtected.thisAgent": "this agent",
    "ui.permission.configProtected.addToAllowed": "Save approval for this agent and these exact paths",
    "ui.permission.configProtected.removeFromAllowed": "Remove saved approval for this agent and these exact paths",
    "ui.permission.configProtected.addToDenied": "Save denial for this agent and these exact paths",
    "ui.permission.configProtected.removeFromDenied": "Remove saved denial for this agent and these exact paths",
    "ui.permission.rule.addToAllowed": "Add to allowed list",
    "ui.permission.rule.removeFromAllowed": "Remove from allowed list",
    "ui.permission.rule.addToDenied": "Add to denied list",
    "ui.permission.rule.removeFromDenied": "Remove from denied list",
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

  function expandRules(root) {
    const header = root.querySelector('[data-slot="permission-rules-header"]')
    if (!header) fail("no permission rules header")
    header.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
  }

  const base = {
    id: "perm-1",
    sessionID: "ses-1",
    patterns: [],
    always: [],
    args: {},
  }

  // Case A: protected config-file edit with agent metadata. The backend fills
  // args.protectedPaths with the canonical identities it will persist, and the
  // dock must display that exact set (LOCK-003).
  {
    const decisions = []
    const request = {
      ...base,
      toolName: "edit",
      patterns: [".kilo/kilo.json"],
      always: ["*"],
      args: {
        configProtected: true,
        protectedAgent: "coder",
        filepath: "/Users/developer/projects/demo/.kilo/kilo.json",
        protectedPaths: ["/Users/developer/projects/demo/.kilo/kilo.json"],
      },
    }
    const { root, dispose } = mount(request, (response, approved, denied) => decisions.push({ response, approved, denied }))

    const note = root.querySelector('[data-slot="permission-protected"]')
    if (!note) fail("protected request has no protected note")
    const title = note.querySelector('[data-slot="permission-protected-title"]')
    if (!title || title.textContent !== "Config file edits always require approval") {
      fail("protected heading wrong: " + JSON.stringify(title && title.textContent))
    }
    const scope = note.querySelector('[data-slot="permission-protected-scope"]')
    if (!scope || !scope.textContent.includes("coder")) {
      fail("protected scope does not include agent: " + JSON.stringify(scope && scope.textContent))
    }

    expandRules(root)
    const rule = root.querySelector('[data-slot="permission-rule"]')
    if (!rule || rule.textContent.trim() !== "/Users/developer/projects/demo/.kilo/kilo.json") {
      fail("protected rule row does not show the persisted canonical path: " + JSON.stringify(rule && rule.textContent))
    }

    // Checked-rule payload must be preserved: approving the "*" rule submits "*".
    const approve = root.querySelector('[data-slot="permission-rule-toggle"][data-variant="approve"]')
    approve.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
    const row = root.querySelector('[data-slot="permission-rule-row"]')
    if (!row || row.getAttribute("data-decision") !== "approved") fail("protected approve toggle did not stick")

    const allowOnce = [...root.querySelectorAll('[data-component="button"]')].find((b) => b.textContent === "Allow once")
    if (!allowOnce) fail("no Allow once button")
    allowOnce.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
    if (decisions.length !== 1) fail("onDecide not called once")
    const d = decisions[0]
    if (d.response !== "once" || JSON.stringify(d.approved) !== JSON.stringify(["*"]) || d.denied.length !== 0) {
      fail("checked-rule payload changed: " + JSON.stringify(d))
    }
    dispose()
  }

  // Case B: protected request without agent metadata falls back to "this agent".
  {
    const request = {
      ...base,
      toolName: "edit",
      patterns: [".kilo/kilo.json"],
      always: ["*"],
      args: { configProtected: true, filepath: "/Users/developer/projects/demo/.kilo/kilo.json" },
    }
    const { root, dispose } = mount(request, noop)
    const note = root.querySelector('[data-slot="permission-protected"]')
    if (!note) fail("protected request (no agent) has no protected note")
    const scope = note.querySelector('[data-slot="permission-protected-scope"]')
    if (!scope || !scope.textContent.includes("this agent")) {
      fail("protected scope does not fall back to this agent: " + JSON.stringify(scope && scope.textContent))
    }
    dispose()
  }

  // Case C: non-protected edit keeps the old generic rule label and no note.
  {
    const decisions = []
    const request = {
      ...base,
      toolName: "edit",
      patterns: ["src/app.ts"],
      always: ["*"],
      args: {},
    }
    const { root, dispose } = mount(request, (response, approved, denied) => decisions.push({ response, approved, denied }))
    if (root.querySelector('[data-slot="permission-protected"]')) {
      fail("non-protected request rendered the protected note")
    }
    expandRules(root)
    const rule = root.querySelector('[data-slot="permission-rule"]')
    if (!rule || rule.textContent.trim() !== "Edit") {
      fail("non-protected rule row changed: " + JSON.stringify(rule && rule.textContent))
    }
    const approve = root.querySelector('[data-slot="permission-rule-toggle"][data-variant="approve"]')
    approve.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
    const allowOnce = [...root.querySelectorAll('[data-component="button"]')].find((b) => b.textContent === "Allow once")
    allowOnce.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
    const d = decisions[0]
    if (!d || d.response !== "once" || JSON.stringify(d.approved) !== JSON.stringify(["*"])) {
      fail("non-protected payload changed: " + JSON.stringify(d))
    }
    dispose()
  }

  // Case D: mixed protected/unprotected request — the rule row shows exactly the
  // backend-persisted canonical set, never unprotected or glob patterns (LOCK-003).
  {
    const request = {
      ...base,
      toolName: "edit",
      patterns: ["src/app.ts", "~/.config/kilo/*"],
      always: ["*"],
      args: {
        configProtected: true,
        protectedAgent: "coder",
        filepath: "src/app.ts, /Users/developer/projects/demo/.kilo/agents/a.md",
        protectedPaths: [
          "/Users/developer/projects/demo/.kilo/kilo.json",
          "/Users/developer/projects/demo/.kilo/agents/a.md",
        ],
      },
    }
    const { root, dispose } = mount(request, noop)
    if (!root.querySelector('[data-slot="permission-protected"]')) {
      fail("mixed protected request has no protected note")
    }
    expandRules(root)
    const rule = root.querySelector('[data-slot="permission-rule"]')
    const shown = rule && rule.textContent.trim()
    const expected = "/Users/developer/projects/demo/.kilo/kilo.json, /Users/developer/projects/demo/.kilo/agents/a.md"
    if (shown !== expected) {
      fail("mixed request overstates saved scope: " + JSON.stringify(shown))
    }
    dispose()
  }

  // Case E: glob-only protected request — no exact path is persisted, so the row
  // falls back to the tool label and never invents a path.
  {
    const request = {
      ...base,
      toolName: "edit",
      patterns: ["~/.config/kilo/*"],
      always: ["*"],
      args: { configProtected: true, protectedAgent: "coder", protectedPaths: [] },
    }
    const { root, dispose } = mount(request, noop)
    expandRules(root)
    const rule = root.querySelector('[data-slot="permission-rule"]')
    if (!rule || rule.textContent.trim() !== "Edit") {
      fail("glob-only request shows invented paths: " + JSON.stringify(rule && rule.textContent))
    }
    dispose()
  }

  console.log("${PASS}")
`

describe("PermissionDock protected config-file approval (LOCK-002/003)", () => {
  it("shows agent-scoped protected heading + exact path rule, keeps the checked-rule payload", // This test bundles the real webview (esbuild + esbuild-plugin-solid) and
  // spawns a happy-dom child process, so it needs more than Bun's default 5s
  // per-test timeout on cold caches.
  async () => {
    const name = `.tmp-permission-dock-${randomUUID()}`
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
          // Same alias the production webview esbuild.js uses: route the shared
          // pierre/worker module (Vite-only ?worker&url import) to the Kilo
          // replacement, which is lazy and never touches Worker without a URI.
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

      expect.unreachable(`PermissionDock child never reported success:\n${failures.join("\n")}`)
    } finally {
      fs.rmSync(entry, { force: true })
      fs.rmSync(out, { force: true })
    }
  }, 60_000)
})
