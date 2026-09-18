/**
 * P3.1 regression contract: the ordinary single-chat Activity Bar sidebar is
 * permanently removed.
 *
 * Static analysis — reads package.json, src/extension.ts, src/KiloProvider.ts,
 * and src/agent-manager/AgentManagerProvider.ts and verifies:
 *
 * - The manifest contributes no `kilo-code-ActivityBar` activity bar
 *   container, no `kilo-code.SidebarProvider` webview view, no
 *   `sidebarTitle.*` commands/menus, and no `kilo-code.new.sidebarVisible`
 *   keybinding context. Absence checks are identifier-based: forbidden sidebar
 *   ids/prefixes must not appear, but unrelated future views are not banned.
 * - No production source registers a webview view under the forbidden sidebar
 *   ids or resolves the sidebar, and no stale `kilo-code.SidebarProvider.focus`
 *   / `sidebarTitle.*` references remain.
 * - Preserved surfaces survive: the Agent Manager panel serializer is still
 *   registered and commands that used the sidebar fallback now route through
 *   `resolveChatTarget` (Agent Manager is the sole chat surface).
 * - The cycle-agent-mode keybindings exist and are scoped to the editor
 *   surfaces only (asserted non-vacuously: the bindings must be present).
 * - The demonstrably sidebar-exclusive i18n keys are absent from every app
 *   locale dictionary and from all production source, the shared sidebar keys
 *   survive in every locale, and the TITLE_BUTTON_CLICKED telemetry event name
 *   (emitted only by the removed sidebar title wrappers; no remaining emitter)
 *   is gone.
 *
 * Protects against accidental reintroduction during later removals (P3.2+).
 */

import { describe, it, expect } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "../..")
const PKG_JSON_FILE = path.join(ROOT, "package.json")
const EXTENSION_FILE = path.join(ROOT, "src/extension.ts")
const KILO_PROVIDER_FILE = path.join(ROOT, "src/KiloProvider.ts")
const AM_PROVIDER_FILE = path.join(ROOT, "src/agent-manager/AgentManagerProvider.ts")

const pkg = JSON.parse(fs.readFileSync(PKG_JSON_FILE, "utf-8"))
const ext = fs.readFileSync(EXTENSION_FILE, "utf-8")
const provider = fs.readFileSync(KILO_PROVIDER_FILE, "utf-8")
const am = fs.readFileSync(AM_PROVIDER_FILE, "utf-8")

const SIDEBAR_IDS = ["kilo-code-ActivityBar", "kilo-code.SidebarProvider"]
const SIDEBAR_TITLE_PREFIX = "kilo-code.new.sidebarTitle."
const SIDEBAR_CONTEXT_KEY = "kilo-code.new.sidebarVisible"

function readSrcFiles(dir: string): string {
  const parts: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      parts.push(readSrcFiles(full))
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".spec.ts")) {
      parts.push(fs.readFileSync(full, "utf-8"))
    }
  }
  return parts.join("\n")
}

const src = readSrcFiles(path.join(ROOT, "src"))

describe("P3.1 manifest — Activity Bar sidebar contributions removed", () => {
  const containers = (pkg.contributes?.viewsContainers?.activitybar ?? []) as Array<{ id?: string }>
  const views = (pkg.contributes?.views ?? {}) as Record<string, Array<{ id?: string }>>
  const menus = (pkg.contributes?.menus ?? {}) as Record<string, Array<{ command?: string }>>

  it("contributes no activitybar container for the removed sidebar", () => {
    // Identifier-based: the removed sidebar's container id must not appear.
    // Unrelated future activitybar containers are not banned.
    for (const container of containers) {
      const id = container.id ?? ""
      expect(SIDEBAR_IDS.includes(id)).toBe(false)
      expect(id.startsWith("kilo-code.new.sidebar")).toBe(false)
    }
  })

  it("contributes no views for the removed sidebar", () => {
    // Identifier-based: the removed sidebar's view ids must not appear in any
    // contributed view. Unrelated future views are not banned.
    for (const group of Object.values(views)) {
      for (const view of group) {
        const id = view.id ?? ""
        expect(SIDEBAR_IDS.includes(id)).toBe(false)
        expect(id.startsWith("kilo-code.Sidebar")).toBe(false)
      }
    }
  })

  it("declares no sidebar view/title menus", () => {
    // view/title:<viewId> groups would target a specific webview view; none
    // may target the removed sidebar. Menu commands never use sidebarTitle.*.
    for (const group of Object.keys(menus).filter((key) => key.startsWith("view/title"))) {
      const target = group.slice("view/title".length).replace(/^:/, "")
      for (const id of SIDEBAR_IDS) expect(target).not.toContain(id)
    }
    const menuCommands = Object.values(menus)
      .flat()
      .map((m) => m.command ?? "")
    expect(menuCommands.some((c: string) => c.startsWith(SIDEBAR_TITLE_PREFIX))).toBe(false)
  })

  it("declares no sidebarTitle.* commands", () => {
    const declared = pkg.contributes?.commands?.map((c: { command: string }) => c.command) ?? []
    expect(declared.some((c: string) => c.startsWith(SIDEBAR_TITLE_PREFIX))).toBe(false)
    expect(declared.some((c: string) => SIDEBAR_IDS.some((id) => c.includes(id)))).toBe(false)
  })

  it("declares no sidebar id or sidebarVisible context key anywhere in the manifest", () => {
    const raw = fs.readFileSync(PKG_JSON_FILE, "utf-8")
    for (const id of SIDEBAR_IDS) expect(raw).not.toContain(id)
    expect(raw).not.toContain(SIDEBAR_CONTEXT_KEY)
  })

  it("scopes cycle-agent-mode keybindings to the editor surfaces only", () => {
    const bindings = pkg.contributes?.keybindings ?? []
    for (const cmd of ["kilo-code.new.cycleAgentMode", "kilo-code.new.cyclePreviousAgentMode"]) {
      const found = bindings.filter((b: { command: string }) => b.command === cmd)
      expect(found.length, `expected a keybinding for ${cmd}`).toBeGreaterThan(0)
      for (const binding of found) {
        expect(binding.when).not.toContain(SIDEBAR_CONTEXT_KEY)
        expect(binding.when).not.toContain("sideBarFocus")
        expect(binding.when).toContain("activeWebviewPanelId == 'kilo-code.new.AgentManagerPanel'")
        expect(binding.when).not.toContain("kilo-code.new.TabPanel")
      }
    }
  })
})

describe("P3.1 source — no sidebar registration, focus path, or context", () => {
  it("registers no webview view under the removed sidebar ids", () => {
    // Identifier-based: a reintroduced sidebar would register its view under
    // the forbidden ids. A bare registerWebviewViewProvider ban would forbid
    // all future webview-view surfaces, not just the removed sidebar.
    for (const id of SIDEBAR_IDS) {
      expect(src).not.toContain(`registerWebviewViewProvider("${id}"`)
      expect(src).not.toContain(`registerWebviewViewProvider('${id}'`)
    }
    expect(src).not.toContain("kilo-code.SidebarProvider")
    expect(src).not.toContain("kilo-code-ActivityBar")
  })

  it("has no sidebar resolve path or visibility context in KiloProvider", () => {
    expect(provider).not.toContain("resolveWebviewView")
    expect(provider).not.toContain("setSidebarVisible")
    expect(provider).not.toContain("WebviewViewProvider")
    expect(provider).not.toContain("kilo-code.SidebarProvider")
    expect(provider).not.toContain(SIDEBAR_CONTEXT_KEY)
  })

  it("has no stale sidebar focus or sidebarTitle references in any production source", () => {
    expect(src).not.toContain("kilo-code.SidebarProvider.focus")
    expect(src).not.toContain(SIDEBAR_TITLE_PREFIX)
    expect(src).not.toContain(SIDEBAR_CONTEXT_KEY)
  })

  it("registers sidebarTitle.* nowhere in source", () => {
    expect(src).not.toContain("sidebarTitle.")
  })
})

describe("P3.1 residue — no sidebar-exclusive i18n keys or telemetry names", () => {
  const DEAD_KEYS = [
    "sidebar.menu.toggle",
    "sidebar.nav.projectsAndSessions",
    "sidebar.help",
    "sidebar.workspaces.enable",
    "sidebar.workspaces.disable",
    "sidebar.gettingStarted.title",
    "sidebar.gettingStarted.line1",
    "sidebar.gettingStarted.line2",
    "sidebar.project.recentSessions",
    "sidebar.project.viewAllSessions",
    "command.sidebar.toggle",
  ]
  const PRESERVED_KEYS = ["sidebar.settings", "sidebar.session.newSession", "sidebar.session.newSession.tooltip"]

  function readWebviewFiles(): string {
    const parts: string[] = []
    for (const dir of [path.join(ROOT, "webview-ui/src"), path.join(ROOT, "webview-ui/agent-manager")]) {
      const walk = (d: string) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, entry.name)
          if (entry.isDirectory()) {
            if (!full.endsWith("/i18n")) walk(full)
          } else if (
            (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
            !entry.name.endsWith(".test.ts") &&
            !entry.name.endsWith(".spec.ts")
          ) {
            parts.push(fs.readFileSync(full, "utf-8"))
          }
        }
      }
      walk(dir)
    }
    return parts.join("\n")
  }

  it("removed the dead sidebar keys from every app locale dictionary", () => {
    const dictDir = path.join(ROOT, "webview-ui/src/i18n")
    for (const file of fs.readdirSync(dictDir)) {
      if (!file.endsWith(".ts")) continue
      const content = fs.readFileSync(path.join(dictDir, file), "utf-8")
      for (const key of DEAD_KEYS) {
        expect(content, `${file} still contains dead key "${key}"`).not.toContain(`"${key}"`)
      }
    }
  })

  it("keeps the shared sidebar keys in every app locale dictionary", () => {
    const dictDir = path.join(ROOT, "webview-ui/src/i18n")
    const files = fs.readdirSync(dictDir).filter((f) => f.endsWith(".ts"))
    for (const file of files) {
      const content = fs.readFileSync(path.join(dictDir, file), "utf-8")
      for (const key of PRESERVED_KEYS) {
        expect(content, `${file} is missing shared key "${key}"`).toContain(`"${key}"`)
      }
    }
  })

  it("references none of the dead sidebar keys in any production source", () => {
    const webview = readWebviewFiles()
    for (const key of DEAD_KEYS) {
      expect(src, `extension source references "${key}"`).not.toContain(`"${key}"`)
      expect(webview, `webview source references "${key}"`).not.toContain(`"${key}"`)
    }
  })

  it("removed the TITLE_BUTTON_CLICKED telemetry event name (emitted only by the removed sidebar title wrappers)", () => {
    const telemetry = fs.readFileSync(path.join(ROOT, "src/services/telemetry/types.ts"), "utf-8")
    expect(telemetry).not.toContain("TITLE_BUTTON_CLICKED")
    expect(src).not.toContain("TITLE_BUTTON_CLICKED")
    expect(src).not.toContain("Title Button Clicked")
  })
})

describe("P3.1 routing — preserved surfaces and command re-routing", () => {
  it("still registers the Agent Manager serializer and removes the TabPanel serializer", () => {
    expect(ext).toContain("vscode.window.registerWebviewPanelSerializer(AgentManagerProvider.viewType")
    expect(ext).not.toContain('vscode.window.registerWebviewPanelSerializer("kilo-code.new.TabPanel"')
    expect(ext).not.toContain("kilo-code.new.TabPanel")
  })

  it("still registers the standalone settings panel serializer", () => {
    expect(ext).toContain("registerWebviewPanelSerializer(`kilo-code.new.${suffix}`")
  })

  it("no longer registers a Diff Viewer serializer (P3.2 custom surface removal)", () => {
    expect(ext).not.toContain("DiffViewerProvider")
    expect(ext).not.toContain("DiffVirtualProvider")
  })

  it("removes the TabPanel editor/title toolbar contributions", () => {
    const menus = pkg.contributes?.menus ?? {}
    const editorTitle = menus["editor/title"] ?? []
    expect(editorTitle.some((m: { command: string }) => m.command === "kilo-code.new.openInTab")).toBe(false)
    expect(editorTitle.length).toBe(0)
    expect(JSON.stringify(pkg)).not.toContain("kilo-code.new.TabPanel")
    expect(JSON.stringify(pkg)).not.toContain("openInTab")
  })

  it("keeps editor/terminal context submenus and the preserved commands without TabPanel", () => {
    const declared = pkg.contributes?.commands?.map((c: { command: string }) => c.command) ?? []
    for (const cmd of [
      "kilo-code.new.explainCode",
      "kilo-code.new.fixCode",
      "kilo-code.new.improveCode",
      "kilo-code.new.addToContext",
      "kilo-code.new.terminalAddToContext",
      "kilo-code.new.focusChatInput",
      "kilo-code.new.toggleChatSearch",
      "kilo-code.new.cycleAgentMode",
      "kilo-code.new.agentManagerOpen",
      "kilo-code.new.agentManager.newTab",
    ]) {
      expect(declared, `declared command ${cmd}`).toContain(cmd)
    }
    expect(declared).not.toContain("kilo-code.new.openInTab")
  })

  it("routes chat commands through Agent Manager-only resolveChatTarget", () => {
    expect(ext).toContain("registerCodeActions(context, resolveChatTarget)")
    expect(ext).toContain("registerTerminalActions(context, resolveChatTarget)")
    expect(ext).toContain("const resolveChatTarget = ")
    expect(ext).not.toContain("activeTabProvider")
    expect(ext).not.toContain("ensureChatTab")
    expect(ext).not.toContain("openKiloInNewTab")
    expect(ext).not.toContain("kilo-code.new.openInTab")
    expect(ext).not.toContain("registerWebviewViewProvider")
  })

  it("routes the cold-open toolbar fallbacks through readiness-gated posting", () => {
    // Finding 3 (P3.1 audit): plus/history/cycle commands open the Agent
    // Manager panel and deliver only after waitForReady, instead of posting
    // into a possibly absent panel.
    expect(ext).toContain("const postToAgentManager = async (msg: unknown)")
    expect(ext).toContain("const ok = await agentManagerProvider.waitForReady()")
  })

  it("drops the cloud-session deep link and its readiness delivery (LOCK-003)", () => {
    // P3.3: cloud session deep links are permanently removed. The linked-model
    // selection paths (selectKiloModel) remain.
    expect(ext).not.toContain("openCloudSession")
    expect(ext).not.toContain("waitForChatReady(tab.waitForReady(), 15_000)")
    expect(provider).not.toContain("openCloudSession")
  })

  it("keeps the readiness-aware chat target resolver and drops the dead review-comments push chain", () => {
    expect(ext).toContain("const resolveChatTarget = ")
    expect(ext).not.toContain("activeTabProvider")
    expect(provider).not.toContain("appendReviewComments")
    const promptInput = fs.readFileSync(path.join(ROOT, "webview-ui/src/components/chat/PromptInput.tsx"), "utf-8")
    expect(promptInput).not.toContain('message.type === "appendReviewComments"')
    const terminalTab = fs.readFileSync(path.join(ROOT, "webview-ui/agent-manager/terminal/TerminalTab.tsx"), "utf-8")
    expect(terminalTab).not.toContain("appendReviewCommentsToTerminal")
    expect(promptInput).toContain("if (message.review) replaceReviewComments(message.review)")
  })

  it("sources session directories from Agent Manager only (reload routing)", () => {
    expect(am).toContain("public getActiveSessionId(): string | undefined")
    expect(ext).not.toContain("tabPanels")
    expect(ext).toContain("agentManagerProvider.getSessionDirectories()")
  })

  it("removes the TabPanel E2E fixture bridge while keeping Agent Manager fixtures", () => {
    expect(ext).not.toContain('vscode.commands.registerCommand("kilo-code.new.e2eFixture.openInTabReady"')
    expect(ext).not.toContain("kilo-code.new.TabPanel")
    expect(ext).toContain('vscode.commands.registerCommand("kilo-code.new.e2eFixture.agentManagerReady"')
  })
})
