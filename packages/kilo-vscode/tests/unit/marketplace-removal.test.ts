/**
 * Downloadable Marketplace product removal: structural absence + local retention.
 *
 * Static analysis — reads extension source and webview to verify:
 * - Marketplace host, catalog, installer, notifier, webview entry, components,
 *   context, types, stories, and marketplace-only tests are deleted.
 * - Extension activation, serializer, notifier, command wiring, esbuild
 *   marketplace bundle, knip/tsconfig entries, and telemetry members are gone.
 * - Webview message unions carry no marketplace members; navigate view has no
 *   marketplace literal.
 * - No downloadable catalog/repo markers (`api.kilo.ai/api/marketplace`,
 *   `Kilo-Org/kilo-marketplace`, `kilo-marketplace`) and no marketplace
 *   panel/command/install messages remain in production
 *   (packages/kilo-vscode/src, webview-ui/src, packages/opencode/src,
 *   packages/core/src). Only this guard source itself may name them, and only
 *   historical/docs redirect contexts outside production are allowed.
 * - MCP removal is canonical-only with no marketplace/local legacy bridge.
 * - Skills Refresh uses requestSkills; paths/URLs UI remains; remove
 *   confirmation is manifest-only.
 * - Retained surfaces survive: CLI skill discovery (skills.paths/urls),
 *   requestSkills/skillsLoaded, skill/remove private path, canonical agent
 *   mutations, MCP config CRUD, AgentRequirements read-only lists.
 * Behavioral coverage lives in marketplace-removal-behavior.test.ts and the
 * retained skill-remove backend suite (fd-carrier-skill-remove manifest-only
 * sibling preservation); this file stays structural.
 */

import { describe, it, expect } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "../..")
const REPO = path.resolve(ROOT, "../..")
const SRC = path.join(ROOT, "src")
const WEBVIEW = path.join(ROOT, "webview-ui")
const WEBVIEW_SRC = path.join(WEBVIEW, "src")
const OPENCODE_SRC = path.join(REPO, "packages/opencode/src")
const CORE_SRC = path.join(REPO, "packages/core/src")

const read = (file: string) => fs.readFileSync(file, "utf8")

describe("marketplace product removal — deleted surfaces are absent", () => {
  it("marketplace host, service, webview, and type sources are deleted", () => {
    for (const file of [
      path.join(SRC, "MarketplacePanelProvider.ts"),
      path.join(SRC, "services/marketplace/api.ts"),
      path.join(SRC, "services/marketplace/actions.ts"),
      path.join(SRC, "services/marketplace/detection.ts"),
      path.join(SRC, "services/marketplace/index.ts"),
      path.join(SRC, "services/marketplace/installer.ts"),
      path.join(SRC, "services/marketplace/notifier.ts"),
      path.join(SRC, "services/marketplace/notify.ts"),
      path.join(SRC, "services/marketplace/paths.ts"),
      path.join(SRC, "services/marketplace/relevance.ts"),
      path.join(SRC, "services/marketplace/types.ts"),
      path.join(SRC, "kilo-provider/remove-config-item.ts"),
      path.join(WEBVIEW, "marketplace/index.tsx"),
      path.join(WEBVIEW, "marketplace/MarketplaceApp.tsx"),
      path.join(WEBVIEW, "src/types/marketplace.ts"),
      path.join(WEBVIEW, "src/context/marketplace-session.tsx"),
      path.join(WEBVIEW, "src/stories/marketplace.stories.tsx"),
      path.join(WEBVIEW, "src/components/marketplace/MarketplaceView.tsx"),
      path.join(WEBVIEW, "src/components/marketplace/MarketplaceListView.tsx"),
    ]) {
      expect(fs.existsSync(file), `${file} should be removed`).toBe(false)
    }
    expect(fs.existsSync(path.join(SRC, "services/marketplace"))).toBe(false)
    expect(fs.existsSync(path.join(WEBVIEW, "marketplace"))).toBe(false)
    expect(fs.existsSync(path.join(WEBVIEW, "src/components/marketplace"))).toBe(false)
  })

  it("marketplace-only unit tests are deleted", () => {
    for (const file of [
      "marketplace-actions.test.ts",
      "marketplace-installer-convergence.test.ts",
      "marketplace-installer.test.ts",
      "marketplace-notify.test.ts",
      "marketplace-panel-arch.test.ts",
      "marketplace-relevance.test.ts",
      "marketplace-skill-remove.test.ts",
    ]) {
      expect(fs.existsSync(path.join(ROOT, "tests/unit", file)), `${file} should be removed`).toBe(false)
    }
  })

  it("extension.ts has no marketplace activation, serializer, notifier, or command", () => {
    const ext = read(path.join(SRC, "extension.ts"))
    expect(ext).not.toContain("MarketplacePanelProvider")
    expect(ext).not.toContain("MarketplaceNotifier")
    expect(ext).not.toContain("marketplacePanelProvider")
    expect(ext).not.toContain("marketplaceNotifier")
    expect(ext).not.toContain("marketplaceButtonClicked")
  })

  it("KiloProvider has no marketplace open, remove bridge, or dismissed state", () => {
    const provider = read(path.join(SRC, "KiloProvider.ts"))
    expect(provider).not.toContain("openMarketplacePanel")
    expect(provider).not.toContain("marketplaceRemove")
    expect(provider).not.toContain("MarketplaceRemoveContext")
    expect(provider).not.toContain("createMarketplaceRemover")
    expect(provider).not.toContain("remove-config-item")
    expect(provider).not.toContain("removeConfigItemCtx")
    expect(provider).not.toContain("kilo.marketplace.dismissedSuggestions")
  })

  it("webview message unions carry no marketplace members", () => {
    const extMessages = read(path.join(WEBVIEW, "src/types/messages/extension-messages.ts"))
    const webviewMessages = read(path.join(WEBVIEW, "src/types/messages/webview-messages.ts"))
    for (const msg of [
      "MarketplaceDataMessage",
      "MarketplaceInstallResultMessage",
      "MarketplaceRemoveResultMessage",
      "OpenInstallModalMessage",
      "FetchMarketplaceDataMessage",
      "FilterMarketplaceItemsMessage",
      "InstallMarketplaceItemMessage",
      "RemoveInstalledMarketplaceItemMessage",
      "OpenMarketplacePanelRequest",
      "marketplaceData",
      "marketplaceInstallResult",
      "marketplaceRemoveResult",
      "fetchMarketplaceData",
      "filterMarketplaceItems",
      "installMarketplaceItem",
      "removeInstalledMarketplaceItem",
      "openMarketplacePanel",
      "openInstallModal",
    ]) {
      expect(extMessages).not.toContain(msg)
      expect(webviewMessages).not.toContain(msg)
    }
    expect(extMessages).not.toContain('"marketplace"')
  })

  it("manifest, esbuild, knip, tsconfig, and telemetry drop marketplace", () => {
    const pkg = JSON.parse(read(path.join(ROOT, "package.json")))
    const commands = pkg.contributes?.commands?.map((c: { command: string }) => c.command) ?? []
    expect(commands).not.toContain("kilo-code.new.marketplaceButtonClicked")
    expect(read(path.join(ROOT, "esbuild.js"))).not.toContain("marketplace")
    expect(read(path.join(ROOT, "knip.json"))).not.toContain("marketplace")
    expect(read(path.join(WEBVIEW, "tsconfig.json"))).not.toContain("marketplace")
    const telemetry = read(path.join(SRC, "services/telemetry/types.ts"))
    expect(telemetry).not.toContain("MARKETPLACE")
    expect(telemetry).not.toContain("Marketplace")
  })

  it("no downloadable catalog/repo markers or panel/command/install messages remain in production", () => {
    const roots = [SRC, WEBVIEW_SRC, path.join(WEBVIEW, "agent-manager"), OPENCODE_SRC, CORE_SRC]
    const markers = [
      "api.kilo.ai/api/marketplace",
      "Kilo-Org/kilo-marketplace",
      "kilo-marketplace",
      "openMarketplacePanel",
      "marketplaceButtonClicked",
      "MarketplacePanelProvider",
      "MarketplaceInstaller",
      "MarketplaceNotifier",
      "fetchMarketplaceData",
      "installMarketplaceItem",
      "removeInstalledMarketplaceItem",
      "filterMarketplaceItems",
      "marketplaceData",
      "marketplaceInstallResult",
      "marketplaceRemoveResult",
      "openInstallModal",
    ]
    const hits: string[] = []
    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(file)
        else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
          const src = read(file)
          for (const marker of markers) {
            if (src.includes(marker)) hits.push(`${file}: ${marker}`)
          }
        }
      }
    }
    for (const dir of roots) walk(dir)
    expect(hits).toEqual([])
  })
})

describe("marketplace product removal — local workflows are retained and decoupled", () => {
  it("MCP removal is canonical-only with no legacy bridge", () => {
    const provider = read(path.join(SRC, "KiloProvider.ts"))
    expect(provider).toContain("handleRemoveMcp")
    expect(provider).toContain("writeConfigScopes")
    expect(provider).toContain("mcpCleanupError")
    expect(provider).not.toContain("MarketplaceInstaller")
    expect(provider).not.toContain("mcp.json")
  })

  it("Skills Refresh sends requestSkills and paths/URLs UI remains", () => {
    const tab = read(path.join(WEBVIEW, "src/components/settings/AgentBehaviourTab.tsx"))
    expect(tab).toContain("session.refreshSkills()")
    expect(tab).toContain("refreshSkills")
    expect(tab).not.toContain("openMarketplacePanel")
    expect(tab).not.toContain("mcpBrowseMarketplace")
    expect(tab).toContain("skillPaths")
    expect(tab).toContain("skillUrls")
    const session = read(path.join(WEBVIEW, "src/context/session.tsx"))
    expect(session).toContain("requestSkills")
    expect(session).toContain("refreshSkills")
    expect(session).toContain("removeSkill")
  })

  it("skill remove confirmation is manifest-only, not file deletion", () => {
    const en = read(path.join(WEBVIEW, "src/i18n/en.ts"))
    expect(en).toContain("Only the skill manifest is removed")
    expect(en).not.toContain("delete the skill files from disk")
  })

  it("AgentRequirements is read-only with local guidance and no marketplace action", () => {
    const req = read(path.join(WEBVIEW, "src/components/chat/AgentRequirements.tsx"))
    expect(req).not.toContain("openMarketplacePanel")
    expect(req).not.toContain("openMarketplace")
    expect(req).toContain("agentRequirements.localHint")
    const en = read(path.join(WEBVIEW, "src/i18n/en.ts"))
    expect(en).toContain("agentRequirements.localHint")
    expect(en).not.toContain("agentRequirements.action.openMarketplace")
  })

  it("Agents retain canonical create/edit/import/remove with no marketplace entry", () => {
    const tab = read(path.join(WEBVIEW, "src/components/settings/AgentBehaviourTab.tsx"))
    expect(tab).toContain("mutateAgent")
    expect(tab).toContain("removeAgent")
    expect(tab).not.toContain("Marketplace")
  })

  it("no marketplace i18n keys remain in any webview locale", () => {
    const locales = fs.readdirSync(path.join(WEBVIEW, "src/i18n")).filter((f) => f.endsWith(".ts"))
    for (const file of locales) {
      const src = read(path.join(WEBVIEW, "src/i18n", file))
      expect(src).not.toContain("mcpBrowseMarketplace")
      expect(src).not.toContain("openMarketplace")
      expect(src).toContain("refreshSkills")
      expect(src).toContain("localHint")
    }
  })
})
