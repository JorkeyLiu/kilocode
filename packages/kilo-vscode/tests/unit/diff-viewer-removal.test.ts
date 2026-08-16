/**
 * P3.2 regression contract: the custom Diff Viewer and Diff Virtual surfaces
 * are permanently removed while the H-12 SessionRevert/Snapshot rollback,
 * RevertBanner, Agent Manager local git stats, and git-changes prompt context
 * are preserved.
 *
 * Static analysis — reads the extension source tree, webview source tree,
 * manifest, build config, and i18n dictionaries and verifies:
 *
 * - Forbidden identifiers/entrypoints are structurally absent: no custom
 *   DiffViewerProvider / DiffVirtualProvider / SourceController, no
 *   DiffViewerPanel / DiffVirtualPanel view types, no showChanges command,
 *   no diff.renderMarkdown config, no diff-viewer / diff-virtual webview
 *   bundles or build entries, no openChanges / openDiffVirtual / diffViewer.*
 *   / diffVirtual.* message protocol, and no diffViewer.* i18n keys.
 * - Retained surfaces survive: KiloProvider still drives session revert /
 *   unrevert through the SDK, the RevertBanner webview exists, the Agent
 *   Manager local git stats message type exists, git-changes prompt context
 *   still resolves a local diff target, and the relocated diff-media /
 *   git-diff-target helpers are present in their neutral modules.
 *
 * Protects against accidental reintroduction during later phases (P3.3+).
 */

import { describe, it, expect } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "../..")
const PKG_JSON_FILE = path.join(ROOT, "package.json")
const ESBUILD_FILE = path.join(ROOT, "esbuild.js")
const KNIP_FILE = path.join(ROOT, "knip.json")
const WEBVIEW_TSCONFIG = path.join(ROOT, "webview-ui/tsconfig.json")

const pkg = JSON.parse(fs.readFileSync(PKG_JSON_FILE, "utf-8"))

function readTree(dir: string): string {
  if (!fs.existsSync(dir)) return ""
  const parts: string[] = []
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else parts.push(fs.readFileSync(full, "utf-8"))
    }
  }
  walk(dir)
  return parts.join("\n")
}

// Production extension source (excludes tests) and webview source (excludes
// the i18n dictionaries, which are asserted separately).
const ext = readTree(path.join(ROOT, "src"))
const webview = readTree(path.join(ROOT, "webview-ui/src"))
const agentManager = readTree(path.join(ROOT, "webview-ui/agent-manager"))

const FORBIDDEN = [
  "DiffViewerProvider",
  "DiffVirtualProvider",
  "SourceController",
  "DiffSourceCatalog",
  "kilo-code.new.DiffViewerPanel",
  "kilo-code.new.DiffVirtualPanel",
  "diffViewer.sendComments",
  "diffViewer.setMarkdownRender",
  "diffVirtual.setMarkdownRender",
  "openDiffVirtual",
  "kilo-code.new.showChanges",
]

const FORBIDDEN_FILES = [
  path.join(ROOT, "src/diff"),
  path.join(ROOT, "src/DiffVirtualProvider.ts"),
  path.join(ROOT, "src/review-settings.ts"),
  path.join(ROOT, "webview-ui/diff-viewer"),
  path.join(ROOT, "webview-ui/diff-virtual"),
]

describe("P3.2 removal — custom Diff Viewer / Diff Virtual surfaces are absent", () => {
  it("deletes the custom diff modules and surface-owned webviews", () => {
    for (const file of FORBIDDEN_FILES) {
      expect(fs.existsSync(file), `${file} must not exist`).toBe(false)
    }
  })

  it("references no forbidden identifier in extension or webview production source", () => {
    for (const id of FORBIDDEN) {
      expect(ext, `extension source must not reference "${id}"`).not.toContain(id)
      expect(webview, `webview source must not reference "${id}"`).not.toContain(id)
      expect(agentManager, `agent-manager webview must not reference "${id}"`).not.toContain(id)
    }
  })

  it("declares no showChanges command in the manifest", () => {
    const declared = pkg.contributes?.commands?.map((c: { command: string }) => c.command) ?? []
    expect(declared).not.toContain("kilo-code.new.showChanges")
    expect(fs.readFileSync(PKG_JSON_FILE, "utf-8")).not.toContain("showChanges")
  })

  it("removes diff-viewer/diff-virtual from esbuild, knip, and webview tsconfig", () => {
    const esbuild = fs.readFileSync(ESBUILD_FILE, "utf-8")
    const knip = fs.readFileSync(KNIP_FILE, "utf-8")
    const tsconfig = fs.readFileSync(WEBVIEW_TSCONFIG, "utf-8")
    for (const needle of ["diff-viewer", "diff-virtual"]) {
      expect(esbuild, `esbuild.js must not reference ${needle}`).not.toContain(needle)
      expect(knip, `knip.json must not reference ${needle}`).not.toContain(needle)
      expect(tsconfig, `webview tsconfig must not reference ${needle}`).not.toContain(needle)
    }
  })

  it("removes the openChanges message sender and type from the webview", () => {
    expect(webview).not.toContain('type: "openChanges"')
    expect(webview).not.toContain('type: "openDiffVirtual"')
  })

  it("removes the diff.renderMarkdown config and its serializers", () => {
    expect(fs.readFileSync(PKG_JSON_FILE, "utf-8")).not.toContain("renderMarkdown")
    expect(ext).not.toContain("diff.renderMarkdown")
  })

  it("removes every diffViewer/diffVirtual i18n key from every app locale", () => {
    const dictDir = path.join(ROOT, "webview-ui/src/i18n")
    for (const file of fs.readdirSync(dictDir)) {
      if (!file.endsWith(".ts")) continue
      const content = fs.readFileSync(path.join(dictDir, file), "utf-8")
      expect(content, `${file} must not contain diffViewer/diffVirtual keys`).not.toMatch(
        /"(?:diffViewer|diffVirtual)\./,
      )
    }
  })
})

describe("P3.2 preservation — retained H-12 and Agent Manager surfaces", () => {
  it("keeps KiloProvider session revert / unrevert through the SDK", () => {
    expect(ext).toContain("this.client.session.revert")
    expect(ext).toContain("this.client.session.unrevert")
    expect(ext).toContain('type: "sessionUpdated"')
  })

  it("keeps the webview revertSession / unrevertSession message protocol", () => {
    expect(webview).toContain('type: "revertSession"')
    expect(webview).toContain('type: "unrevertSession"')
  })

  it("keeps the RevertBanner component", () => {
    expect(fs.existsSync(path.join(ROOT, "webview-ui/src/components/chat/RevertBanner.tsx"))).toBe(true)
    expect(webview).toContain("session.unrevertSession()")
  })

  it("keeps the Agent Manager local stats message", () => {
    const amTypes = fs.readFileSync(path.join(ROOT, "webview-ui/src/types/messages/extension-messages.ts"), "utf-8")
    expect(amTypes).toContain("AgentManagerLocalStatsMessage")
    const srcTypes = fs.readFileSync(path.join(ROOT, "src/agent-manager/types.ts"), "utf-8")
    expect(srcTypes).toContain('type: "agentManager.localStats"')
  })

  it("keeps git-changes prompt context and its local diff target resolution", () => {
    expect(fs.existsSync(path.join(ROOT, "src/kilo-provider/git-changes-request.ts"))).toBe(true)
    expect(fs.existsSync(path.join(ROOT, "src/kilo-provider/git-changes-target.ts"))).toBe(true)
    expect(fs.readFileSync(path.join(ROOT, "src/kilo-provider/git-changes-target.ts"), "utf-8")).toContain(
      "resolveLocalDiffTarget",
    )
  })

  it("relocates the retained media/target helpers to neutral agent-manager modules", () => {
    expect(fs.existsSync(path.join(ROOT, "src/agent-manager/diff-media.ts"))).toBe(true)
    expect(fs.existsSync(path.join(ROOT, "src/agent-manager/git-diff-target.ts"))).toBe(true)
    const types = fs.readFileSync(path.join(ROOT, "src/agent-manager/types.ts"), "utf-8")
    expect(types).toContain("DiffImage")
    expect(types).not.toContain("src/diff")
  })

  it("keeps the backend session.diff route and TUI consumer untouched", () => {
    // P3.2 removes the custom viewer but must not touch the backend
    // session.diff endpoint or the TUI's diff-viewer plugin.
    const backend = path.resolve(ROOT, "../opencode/src")
    const route = fs.readFileSync(path.join(backend, "server/routes/instance/httpapi/groups/session.ts"), "utf-8")
    expect(route).toContain('identifier: "session.diff"')
    const tui = fs.readFileSync(path.join(backend, "cli/cmd/tui/feature-plugins/system/diff-viewer.tsx"), "utf-8")
    expect(tui).toContain("session.diff")
  })
})
