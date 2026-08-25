/**
 * P3.2 regression contract: managed git-worktree infrastructure is permanently
 * removed while the root-local Agent Manager orchestration layer survives.
 *
 * Static analysis — reads the extension source tree, webview source tree,
 * manifest, build configs, i18n dictionaries, the CLI source tree, the SDK
 * generated sources, and the OpenAPI spec and verifies:
 *
 * - Managed worktree lifecycle/state/protocol/run/transfer/import infrastructure
 *   is structurally absent: no WorktreeManager/WorktreeStateManager/
 *   PRStatusPoller/SetupScriptService, no run/ controller subsystem, no
 *   git-transfer, no worktree-mode context, no BranchSelect, no worktree
 *   message types, no agentManager.worktree.* / agentManager.run.* i18n keys,
 *   no worktree commands/keybindings/settings in the manifest, no worktree
 *   build entries, and no `Worktree.appLayer` / worktree routes / branch-name
 *   route / SDK worktree groups on the CLI side.
 * - Retained root-local orchestration survives: Agent Manager panel
 *   registration, session tabs, openSession transaction, local-only
 *   remoteSessions, generic terminals (slotId), permissions/questions,
 *   reload-directory, H-12 SessionRevert/Snapshot revert/unrevert, the
 *   session.diff backend route, local diff helpers, and agentManager.localStats.
 * - The P4.4 primary-worktree mirror-read helper (`primary-worktree.ts`,
 *   `primaryPaths`/`primaryWorktree`) is physically removed (P4.4-T2): no
 *   mirror-read consumers remain after the canonical `canonicalRoot` cutover.
 * - Core schema `worktree` fields (Session.Instance / Project schema, SDK
 *   Project/workspace `worktree` and `git_worktree` strategy) are retained and
 *   not flagged by the absence checks.
 *
 * Protects against accidental reintroduction during later phases (P3.3+).
 */

import { describe, it, expect } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "../..")
const OPENCODE_ROOT = path.resolve(ROOT, "../opencode")
const SDK_ROOT = path.resolve(ROOT, "../sdk/js")

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
const amWebview = readTree(path.join(ROOT, "webview-ui/agent-manager"))
const cli = readTree(path.join(OPENCODE_ROOT, "src"))

// Forbidden managed-worktree identifiers. Core-schema names are NOT here:
// `ctx.worktree` / `worktree: Schema.String` (core session/project schema),
// `git_worktree` strategy and `worktree?: string` SDK fields (core workspace
// schema). `primaryPaths`/`primaryWorktree` (P4.4 mirror reads) are now
// forbidden and asserted absent via the P4.4-T2 physical-removal contract
// below, not via this allowlist.
const FORBIDDEN_EXT = [
  "WorktreeManager",
  "WorktreeStateManager",
  "WorktreeDiffController",
  "PRStatusPoller",
  "SetupScriptService",
  "SetupScriptRunner",
  "WorktreeDiffEntry",
  "WorktreeDiffReverter",
  "git-transfer",
  "worktree-mode",
  "WorktreeModeProvider",
  "useWorktreeMode",
  "BranchSelect",
  "VscodeSessionTurn",
  "multi-model-utils",
  "MAX_MULTI_VERSIONS",
  "ModelAllocation",
  "ExternalWorktreeInfo",
  "WorktreeErrorCode",
  "AgentManagerPRStatusMessage",
  "agentManager.runScript",
  "agentManager.apply",
  "agentManager.import",
  "agentManager.branches",
  "worktreeId",
]

const FORBIDDEN_EXT_FILES = [
  path.join(ROOT, "src/agent-manager/run"),
  path.join(ROOT, "src/agent-manager/git-transfer.ts"),
  path.join(ROOT, "src/diff"),
  path.join(ROOT, "src/DiffVirtualProvider.ts"),
  path.join(ROOT, "src/review-settings.ts"),
  path.join(ROOT, "webview-ui/diff-viewer"),
  path.join(ROOT, "webview-ui/diff-virtual"),
  path.join(ROOT, "webview-ui/src/context/worktree-mode.tsx"),
  path.join(ROOT, "webview-ui/src/components/shared/BranchSelect.tsx"),
  path.join(ROOT, "webview-ui/src/components/chat/VscodeSessionTurn.tsx"),
  path.join(ROOT, "webview-ui/agent-manager/multi-model-utils.ts"),
  path.join(ROOT, "webview-ui/agent-manager/new-task-drafts.ts"),
  path.join(ROOT, "webview-ui/agent-manager/section-colors.ts"),
  path.join(ROOT, "webview-ui/agent-manager/agent-manager-review.css"),
]

const FORBIDDEN_CLI = [
  "Worktree.appLayer",
  "worktree.appLayer",
  "WorktreeFamily",
  "WorktreeCleanup",
  "BranchNameApi",
  "branchName.generate",
  "experimental.worktree",
  "worktree.list",
  "worktree.create",
  "worktree.remove",
  "worktree.reset",
  "worktree.diff",
]

const FORBIDDEN_CLI_FILES = [
  path.join(OPENCODE_ROOT, "src/worktree"),
  path.join(OPENCODE_ROOT, "src/kilocode/worktree-family.ts"),
  path.join(OPENCODE_ROOT, "src/kilocode/worktree-cleanup.ts"),
  path.join(OPENCODE_ROOT, "src/kilocode/branch-name.ts"),
  path.join(OPENCODE_ROOT, "src/kilocode/review/worktree-diff.ts"),
  path.join(OPENCODE_ROOT, "src/control-plane/adapters/worktree.ts"),
  path.join(OPENCODE_ROOT, "src/kilocode/server/httpapi/groups/branch-name.ts"),
  path.join(OPENCODE_ROOT, "src/kilocode/server/httpapi/handlers/branch-name.ts"),
]

describe("P3.2 removal — managed worktree modules and surfaces are absent", () => {
  it("deletes the extension worktree/run/transfer modules and surface-owned webviews", () => {
    for (const file of FORBIDDEN_EXT_FILES) {
      expect(fs.existsSync(file), `${file} must not exist`).toBe(false)
    }
  })

  it("references no forbidden managed-worktree identifier in extension or webview production source", () => {
    for (const id of FORBIDDEN_EXT) {
      expect(ext, `extension source must not reference "${id}"`).not.toContain(id)
      expect(webview, `webview source must not reference "${id}"`).not.toContain(id)
      expect(amWebview, `agent-manager webview must not reference "${id}"`).not.toContain(id)
    }
  })

  it("keeps the i18n dictionaries free of agentManager.worktree.* and agentManager.run.* keys", () => {
    for (const dir of [path.join(ROOT, "webview-ui/agent-manager/i18n"), path.join(ROOT, "webview-ui/src/i18n")]) {
      if (!fs.existsSync(dir)) continue
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith(".ts")) continue
        const content = fs.readFileSync(path.join(dir, file), "utf-8")
        expect(content, `${file} must not contain agentManager.worktree keys`).not.toMatch(/"agentManager\.worktree\./)
        expect(content, `${file} must not contain agentManager.run keys`).not.toMatch(/"agentManager\.run\./)
      }
    }
  })

  it("declares no managed-worktree settings in the manifest", () => {
    const raw = fs.readFileSync(PKG_JSON_FILE, "utf-8")
    expect(raw).not.toContain("autoBranchNaming")
    expect(raw).not.toContain("branchPrefix")
  })

  it("declares no worktree/run/transfer commands or keybindings in the manifest", () => {
    const raw = fs.readFileSync(PKG_JSON_FILE, "utf-8")
    const commands = (pkg.contributes?.commands ?? []).map((c: { command: string }) => c.command)
    const bindings = pkg.contributes?.keybindings ?? []
    for (const cmd of commands) {
      expect(cmd).not.toMatch(/worktree|runScript|setupScript|gitTransfer|apply|import/i)
    }
    for (const binding of bindings) {
      expect(binding.command).not.toMatch(/worktree|runScript|setupScript|gitTransfer|apply|import/i)
    }
    expect(raw).not.toContain("showChanges")
  })

  it("removes worktree/diff-viewer entries from esbuild, knip, and webview tsconfig", () => {
    const esbuild = fs.readFileSync(ESBUILD_FILE, "utf-8")
    const knip = fs.readFileSync(KNIP_FILE, "utf-8")
    const tsconfig = fs.readFileSync(WEBVIEW_TSCONFIG, "utf-8")
    for (const needle of ["diff-viewer", "diff-virtual", "worktree"]) {
      expect(esbuild, `esbuild.js must not reference ${needle}`).not.toContain(needle)
      expect(knip, `knip.json must not reference ${needle}`).not.toContain(needle)
      expect(tsconfig, `webview tsconfig must not reference ${needle}`).not.toContain(needle)
    }
  })

  it("removes the managed-worktree message protocol from the webview contracts", () => {
    const amTypes = fs.readFileSync(path.join(ROOT, "webview-ui/src/types/messages/agent-manager.ts"), "utf-8")
    const webviewMsg = fs.readFileSync(path.join(ROOT, "webview-ui/src/types/messages/webview-messages.ts"), "utf-8")
    const extMsg = fs.readFileSync(path.join(ROOT, "webview-ui/src/types/messages/extension-messages.ts"), "utf-8")
    for (const needle of ["WorktreeState", "SectionState", "RunStatus", "BranchInfo", "ExternalWorktreeInfo", "ModelAllocation", "MAX_MULTI_VERSIONS", "WorktreeErrorCode"]) {
      expect(amTypes, `agent-manager types must not reference ${needle}`).not.toContain(needle)
    }
    expect(webviewMsg).not.toMatch(/worktree/i)
    expect(extMsg).not.toMatch(/worktree/i)
  })

  it("removes the knip-flagged orphans (KILO_DIR, PRStatus) introduced by the removal", () => {
    const constants = fs.readFileSync(path.join(ROOT, "src/agent-manager/constants.ts"), "utf-8")
    const amTypes = fs.readFileSync(path.join(ROOT, "webview-ui/src/types/messages/agent-manager.ts"), "utf-8")
    expect(constants).not.toContain("KILO_DIR")
    expect(amTypes).not.toContain("PRStatus")
    expect(amTypes).not.toContain("PRCheck")
    expect(amTypes).not.toContain("PRComment")
  })
})

describe("P3.2 removal — CLI app layer, routes, and SDK groups are absent", () => {
  it("deletes the CLI worktree/branch-name modules", () => {
    for (const file of FORBIDDEN_CLI_FILES) {
      expect(fs.existsSync(file), `${file} must not exist`).toBe(false)
    }
  })

  it("references no forbidden managed-worktree identifier in CLI source", () => {
    for (const id of FORBIDDEN_CLI) {
      expect(cli, `CLI source must not reference "${id}"`).not.toContain(id)
    }
  })

  it("keeps the experimental route group free of worktree endpoints", () => {
    const group = fs.readFileSync(
      path.join(OPENCODE_ROOT, "src/server/routes/instance/httpapi/groups/experimental.ts"),
      "utf-8",
    )
    expect(group).not.toMatch(/worktree/i)
  })

  it("keeps the SDK generated sources free of worktree route groups", () => {
    const sdk = readTree(path.join(SDK_ROOT, "src/v2/gen"))
    for (const id of ["worktree.list", "worktree.create", "worktree.remove", "worktree.reset", "worktree.diff", "branchName.generate"]) {
      expect(sdk, `SDK must not reference "${id}"`).not.toContain(id)
    }
  })

  it("allows the retained core-schema worktree identifiers in the SDK", () => {
    // The SDK still carries the generic project/workspace schema `worktree`
    // fields and the `git_worktree` copy strategy. These are core schema, not
    // managed worktree infrastructure, and must not be flagged by the removal.
    const types = fs.readFileSync(path.join(SDK_ROOT, "src/v2/gen/types.gen.ts"), "utf-8")
    expect(types).toContain("worktree")
    expect(types).toContain("git_worktree")
  })
})

describe("P3.2 preservation — retained root-local orchestration and P4.4 boundaries", () => {
  it("keeps the Agent Manager panel registration and session-tab orchestration", () => {
    expect(ext).toContain("registerWebviewPanelSerializer(AgentManagerProvider.viewType")
    expect(ext).toContain("kilo-code.new.AgentManagerPanel")
    expect(fs.existsSync(path.join(ROOT, "webview-ui/agent-manager/session-tabs.ts"))).toBe(true)
    expect(fs.existsSync(path.join(ROOT, "webview-ui/agent-manager/session-tab-manager.ts"))).toBe(true)
    expect(amWebview).toContain("createTabOrderSync")
    expect(amWebview).toContain("reportRemoteSessions")
  })

  it("keeps the local-only session transaction and ManagedSessionState", () => {
    expect(fs.existsSync(path.join(ROOT, "webview-ui/agent-manager/open-session.ts"))).toBe(true)
    const amTypes = fs.readFileSync(path.join(ROOT, "webview-ui/src/types/messages/agent-manager.ts"), "utf-8")
    expect(amTypes).toContain("ManagedSessionState")
    const srcTypes = fs.readFileSync(path.join(ROOT, "src/agent-manager/types.ts"), "utf-8")
    expect(srcTypes).toContain("ManagedSession")
  })

  it("keeps generic terminals with slotId routing and local git stats", () => {
    expect(fs.existsSync(path.join(ROOT, "src/agent-manager/terminal-routing.ts"))).toBe(true)
    expect(fs.existsSync(path.join(ROOT, "src/agent-manager/terminal-manager.ts"))).toBe(true)
    expect(fs.existsSync(path.join(ROOT, "src/agent-manager/SessionTerminalManager.ts"))).toBe(true)
    const amTypes = fs.readFileSync(path.join(ROOT, "webview-ui/src/types/messages/agent-manager.ts"), "utf-8")
    expect(amTypes).toContain("LocalGitStats")
    const srcTypes = fs.readFileSync(path.join(ROOT, "src/agent-manager/types.ts"), "utf-8")
    expect(srcTypes).toContain('type: "agentManager.localStats"')
  })

  it("keeps permission/question routing and reload-directory", () => {
    expect(fs.existsSync(path.join(ROOT, "src/kilo-provider/handlers/permission-handler.ts"))).toBe(true)
    expect(fs.existsSync(path.join(ROOT, "src/kilo-provider/handlers/question.ts"))).toBe(true)
    expect(fs.existsSync(path.join(ROOT, "src/reload-directory.ts"))).toBe(true)
  })

  it("keeps H-12 SessionRevert/Snapshot revert/unrevert through the SDK", () => {
    expect(ext).toContain("this.client.session.revert")
    expect(ext).toContain("this.client.session.unrevert")
    expect(ext).toContain('type: "sessionUpdated"')
    expect(webview).toContain('type: "revertSession"')
    expect(webview).toContain('type: "unrevertSession"')
  })

  it("keeps the backend session.diff route and TUI diff consumer", () => {
    const groups = readTree(path.join(OPENCODE_ROOT, "src/server/routes/instance/httpapi/groups"))
    expect(groups).toContain('identifier: "session.diff"')
    expect(groups).toContain('identifier: "session.revert"')
    expect(groups).toContain('identifier: "session.unrevert"')
    const tui = fs.readFileSync(path.join(OPENCODE_ROOT, "src/cli/cmd/tui/feature-plugins/system/diff-viewer.tsx"), "utf-8")
    expect(tui).toContain("session.diff")
  })

  it("keeps the neutral local diff helpers under agent-manager modules", () => {
    expect(fs.existsSync(path.join(ROOT, "src/agent-manager/local-diff.ts"))).toBe(true)
    expect(fs.existsSync(path.join(ROOT, "src/agent-manager/diff-media.ts"))).toBe(true)
    expect(fs.existsSync(path.join(ROOT, "src/agent-manager/git-diff-target.ts"))).toBe(true)
    const types = fs.readFileSync(path.join(ROOT, "src/agent-manager/types.ts"), "utf-8")
    expect(types).toContain("LocalDiffEntry")
  })

  it("keeps the CLI agent-manager start-only tool and drops the orphaned request/reply/list protocol", () => {
    expect(fs.existsSync(path.join(OPENCODE_ROOT, "src/kilocode/tool/agent-manager.ts"))).toBe(true)
    expect(fs.existsSync(path.join(OPENCODE_ROOT, "src/kilocode/agent-manager/event.ts"))).toBe(true)
    // The start-only tool publishes the start event; the orphaned list/prompt
    // request-reply contract and its protocol schemas are gone.
    expect(cli).toContain("kilocode.agent_manager.start")
    expect(cli).not.toContain("AgentManagerOverview")
    expect(cli).not.toContain("AgentManagerOverviewRequest")
    expect(cli).not.toContain("AgentManagerPromptRequest")
    expect(cli).not.toContain("agent-manager/service")
    expect(fs.existsSync(path.join(OPENCODE_ROOT, "src/kilocode/agent-manager/protocol.ts"))).toBe(false)
    expect(fs.existsSync(path.join(OPENCODE_ROOT, "src/kilocode/agent-manager/service.ts"))).toBe(false)
  })

  it("proves the P4.4 primary-worktree mirror-read helper is physically removed", () => {
    expect(fs.existsSync(path.join(OPENCODE_ROOT, "src/kilocode/primary-worktree.ts"))).toBe(false)
    expect(fs.existsSync(path.join(OPENCODE_ROOT, "test/kilocode/primary-worktree.test.ts"))).toBe(false)
    expect(cli).not.toContain("primaryWorktree")
    expect(cli).not.toContain("primaryPaths")
    // Historical retired-source documentation may still mention the helper name
    // in markdown (e.g., kilo-config.md retired list); the import surface
    // itself must be absent from code. The hyphenated filename check is scoped
    // to TypeScript sources via the dedicated opencode regression test.
    const cfg = fs.readFileSync(path.join(OPENCODE_ROOT, "src/config/config.ts"), "utf-8")
    expect(cfg).not.toContain("primary-worktree")
    expect(cfg).not.toContain("primaryPaths")
    const skill = fs.readFileSync(path.join(OPENCODE_ROOT, "src/skill/index.ts"), "utf-8")
    expect(skill).not.toContain("primary-worktree")
    expect(skill).not.toContain("primaryPaths")
  })

  it("allows the retained core-schema worktree references in CLI source", () => {
    // Core session/project schema: Instance.worktree, ctx.worktree,
    // ProjectTable.worktree. These are the generic project-root semantics, not
    // managed worktree infrastructure, and must survive the removal.
    expect(cli).toContain("worktree: Schema.String")
    expect(cli).toContain("ctx.worktree")
    expect(cli).toContain("ProjectTable.worktree")
  })
})
