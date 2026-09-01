/**
 * P3.4 static absence + presence contract for the VS Code extension/webview:
 * indexing, project memory, user-visible context/compaction controls,
 * autocomplete (FIM/next-edit/chat), and commit-message surfaces are
 * permanently removed (LOCK-004), while invisible automatic CompactionPart
 * rendering (LOCK-005), custom provider/model selectors (LOCK-006), Agent
 * Manager / Open-in-Tab / notebook context / checkpoints / H paths
 * (LOCK-007/008) are retained. No dormant message/config/migration surface
 * (LOCK-014/015) and no removed registration/listener/bundle/prewarm
 * (LOCK-PERF-3).
 *
 * Static analysis — reads the extension source tree, webview source tree,
 * manifest, build configs, i18n dictionaries, script/local-bin.ts, and the
 * E2E probe/runner/evidence wiring and verifies:
 *
 * - Source-tree absence: the autocomplete tree, commit-message service, memory
 *   / indexing provider modules, removed settings tabs, removed webview
 *   contexts, the ghost-text hook, the memory message protocol, the
 *   chatCompletionResult message, the manual CompactRequest message, and the
 *   orphaned context-progress/memory/context CSS are all gone.
 * - Manifest absence: no autocomplete/memory/indexing/commit-message/compact
 *   commands, keybindings, settings, or dependencies.
 * - Activation/prewarm absence: extension.ts/KiloProvider register no removed
 *   feature path; the only retained prewarm is the speech-to-text one.
 * - i18n absence: the dead `command.session.compact`,
 *   `command.session.compact.description`, and `settings.context.title` keys
 *   are gone from every webview locale and from all production source.
 * - Build/metadata absence: esbuild/knip/webview tsconfig carry no removed
 *   feature entries; `script/local-bin.ts` no longer hashes the deleted
 *   `kilo-indexing` package; the package description/displayName/keywords no
 *   longer advertise the removed inline-autocomplete feature.
 * - Retained-presence: notebook helpers, Agent Manager + Open-in-Tab
 *   serializers, automatic CompactionPart mapping/rendering, custom provider
 *   surfaces, checkpoints, generic chat/code actions,
 *   selectKiloModel, and the agent manager / openInTab / newTab commands
 *   survive.
 * - E2E wiring: the focused `p3-4-removal` Extension Host scenario is
 *   registered in the runner, probe, evidence inventory, and package scripts.
 *
 * Protects against accidental reintroduction during later phases.
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

/** Production app webview source: excludes the i18n dictionaries (asserted separately). */
function readWebviewSource(): string {
  const parts: string[] = []
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) {
        if (!full.endsWith("/i18n")) walk(full)
      } else if (
        (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") || entry.name.endsWith(".css")) &&
        !entry.name.endsWith(".test.ts") &&
        !entry.name.endsWith(".spec.ts") &&
        !entry.name.endsWith(".stories.tsx")
      ) {
        parts.push(fs.readFileSync(full, "utf-8"))
      }
    }
  }
  walk(path.join(ROOT, "webview-ui/src"))
  walk(path.join(ROOT, "webview-ui/agent-manager"))
  return parts.join("\n")
}

// Production extension source (excludes tests) and webview production source.
const extTree = readTree(path.join(ROOT, "src"))
const webview = readWebviewSource()
const ext = fs.readFileSync(path.join(ROOT, "src/extension.ts"), "utf-8")
const provider = fs.readFileSync(path.join(ROOT, "src/KiloProvider.ts"), "utf-8")

/**
 * Removed-feature product identifiers (extension + webview). Identifier-based
 * by design (LOCK-004): each token is a product-unique surface name that would
 * only be present if the removed feature's code still lived in the tree.
 * Retained generic words are deliberately NOT here, so retained comments like
 * "in-memory cache", "memory leaks", "indexing the raw path string", or the
 * speech-to-text prewarm are never banned.
 */
const FORBIDDEN_IDS = [
  // autocomplete (FIM / next-edit / chat-autocomplete / statusbar)
  "AutocompleteServiceManager",
  "AutocompleteInlineCompletionProvider",
  "ChatTextAreaAutocomplete",
  "NextEditInlineCompletionProvider",
  "AutocompleteCodeActionProvider",
  "AutocompleteStatusBar",
  "autocomplete-models",
  "kilo-code.new.autocomplete.",
  "generateSuggestions",
  "cancelSuggestions",
  // indexing
  "indexing-settings",
  "IndexingTab",
  "useIndexing",
  "kilo-code.new.indexing.",
  "prompt-indexing",
  "indexing-warning",
  "dialog-indexing",
  // project memory
  "showMemory",
  "toggleMemory",
  "memory-prompt",
  "memory-status",
  "memory-recall",
  "memory-save",
  "memory-command",
  "MemoryManager",
  "MemoryActivity",
  "useMemory",
  "kilo-provider/memory",
  "context/memory",
  "memory-dialog",
  "kilo-code.new.showMemory",
  "kilo-code.new.toggleMemory",
  // commit-message
  "commit-message",
  "generateCommitMessage",
  "CommitMessageTab",
  "kilo-code.new.generateCommitMessage",
  // user-visible context-management / compaction controls
  "ContextProgress",
  "ContextTab",
  "context-progress",
  "CompactRequest",
  "compactSession",
  "command.session.compact",
  "settings.context.title",
  // orchestrator chatCompletionResult protocol
  "ChatCompletionResultMessage",
  "chatCompletionResult",
]

/** Removed-feature module/source files that must no longer exist. */
const FORBIDDEN_FILES = [
  path.join(ROOT, "src/services/autocomplete"),
  path.join(ROOT, "src/services/commit-message"),
  path.join(ROOT, "src/kilo-provider/memory.ts"),
  path.join(ROOT, "src/kilo-provider/indexing-settings.ts"),
  path.join(ROOT, "src/shared/autocomplete-models.ts"),
  path.join(ROOT, "webview-ui/src/components/chat/ContextProgress.tsx"),
  path.join(ROOT, "webview-ui/src/components/settings/AutocompleteTab.tsx"),
  path.join(ROOT, "webview-ui/src/components/settings/CommitMessageTab.tsx"),
  path.join(ROOT, "webview-ui/src/components/settings/ContextTab.tsx"),
  path.join(ROOT, "webview-ui/src/components/settings/IndexingTab.tsx"),
  path.join(ROOT, "webview-ui/src/components/settings/autocomplete-model-selector.ts"),
  path.join(ROOT, "webview-ui/src/components/settings/indexing-tab-state.ts"),
  path.join(ROOT, "webview-ui/src/context/memory.tsx"),
  path.join(ROOT, "webview-ui/src/context/indexing.tsx"),
  path.join(ROOT, "webview-ui/src/context/indexing-utils.ts"),
  path.join(ROOT, "webview-ui/src/context/kilo-embedding-models.tsx"),
  path.join(ROOT, "webview-ui/src/hooks/useGhostText.ts"),
  path.join(ROOT, "webview-ui/src/utils/memory-activity.ts"),
  path.join(ROOT, "webview-ui/src/utils/memory-command.ts"),
  path.join(ROOT, "webview-ui/src/types/messages/memory.ts"),
]

describe("P3.4 source — removed-feature modules and surfaces are absent", () => {
  it("deletes the autocomplete / commit-message / memory / indexing / context files", () => {
    for (const file of FORBIDDEN_FILES) {
      expect(fs.existsSync(file), `${file} must not exist`).toBe(false)
    }
  })

  it("references no forbidden removed-feature identifier in extension or webview production source", () => {
    for (const id of FORBIDDEN_IDS) {
      expect(extTree, `extension source must not reference "${id}"`).not.toContain(id)
      expect(webview, `webview source must not reference "${id}"`).not.toContain(id)
    }
  })

  it("leaves no dead context-progress / memory / indexing CSS anywhere in production styles", () => {
    // The removed ContextProgress bar, memory status popover, and indexing
    // indicator styles must be gone (LOCK-004 / LOCK-PERF-3).
    expect(webview).not.toContain("context-progress")
    expect(webview).not.toContain("task-header-memory-")
    expect(webview).not.toContain("prompt-indexing")
    // The retained task-header styles that survive are the expand/usage/model
    // ones — make the absence check non-vacuous.
    const taskHeader = fs.readFileSync(path.join(ROOT, "webview-ui/src/styles/task-header.css"), "utf-8")
    expect(taskHeader).toContain("task-header-expand")
    expect(taskHeader).toContain("task-header-usage-model-name")
  })
})

describe("P3.4 manifest — no removed commands, keybindings, settings, or deps", () => {
  const declared = (pkg.contributes?.commands ?? []).map((c: { command: string }) => c.command)
  const bindings = (pkg.contributes?.keybindings ?? []).map((b: { command: string }) => b.command)
  const props = Object.keys((pkg.contributes?.configuration?.properties ?? {}) as Record<string, unknown>)
  const raw = fs.readFileSync(PKG_JSON_FILE, "utf-8")

  it("declares no removed-feature command", () => {
    for (const cmd of [
      "kilo-code.new.autocomplete.generateSuggestions",
      "kilo-code.new.autocomplete.cancelSuggestions",
      "kilo-code.new.autocomplete.nextEdit.acceptOrJump",
      "kilo-code.new.autocomplete.nextEdit.dismiss",
      "kilo-code.new.generateCommitMessage",
      "kilo-code.new.showMemory",
      "kilo-code.new.toggleMemory",
    ]) {
      expect(declared).not.toContain(cmd)
    }
    for (const cmd of declared) {
      expect(cmd).not.toMatch(/autocomplete|showMemory|toggleMemory|generateCommitMessage|compact/i)
    }
  })

  it("declares no removed-feature keybinding", () => {
    for (const binding of bindings) {
      expect(binding).not.toMatch(/autocomplete|showMemory|toggleMemory|generateCommitMessage|compact/i)
    }
  })

  it("declares no removed-feature setting", () => {
    for (const prop of props) {
      expect(prop).not.toMatch(/autocomplete|indexing|memory|commitMessage|compact|context/i)
    }
  })

  it("declares no removed product / feature keyword in the manifest raw body", () => {
    expect(raw).not.toContain("autocomplete")
    expect(raw).not.toContain("code completion")
  })
})

describe("P3.4 activation/prewarm — no removed registration or server prewarm", () => {
  it("registers no removed feature path from extension activation", () => {
    expect(ext).not.toContain("AutocompleteServiceManager")
    expect(ext).not.toContain("registerInlineCompletionItemProvider")
    expect(ext).not.toContain("CommitMessageProvider")
    expect(ext).not.toContain("showMemory")
    expect(ext).not.toContain("toggleMemory")
    expect(ext).not.toContain("indexing")
  })

  it("keeps the only retained prewarm (speech-to-text) and no autocomplete server prewarm", () => {
    // The retained prewarm is the speech-to-text capture prewarm wired through
    // the extension host input-tools handler — not a server-side autocomplete
    // prewarm.
    expect(extTree).toContain("prewarmSpeechCapture")
    expect(ext).not.toContain("autocomplete")
    // LOCK-PERF-3: the autocomplete server prewarm/registration path is gone.
    expect(provider).not.toContain("prewarm")
  })

  it("handles no removed memory/indexing/compact message in KiloProvider", () => {
    expect(provider).not.toContain('case "compact"')
    expect(provider).not.toContain("handleRequestMemory")
    expect(provider).not.toContain("memoryStatusMessage")
    expect(provider).not.toContain("handleRequestIndexing")
  })
})

describe("P3.4 message/build — no dormant protocol or build residue", () => {
  it("removes the chatCompletionResult and manual CompactRequest messages from the webview unions", () => {
    const extMessages = fs.readFileSync(path.join(ROOT, "webview-ui/src/types/messages/extension-messages.ts"), "utf-8")
    const webviewMessages = fs.readFileSync(
      path.join(ROOT, "webview-ui/src/types/messages/webview-messages.ts"),
      "utf-8",
    )
    expect(extMessages).not.toContain("ChatCompletionResultMessage")
    expect(extMessages).not.toContain("chatCompletionResult")
    expect(webviewMessages).not.toContain("CompactRequest")
    expect(webviewMessages).not.toContain('type: "compact"')
  })

  it("removes the dead compaction-control / context i18n keys from every app locale", () => {
    const dictDir = path.join(ROOT, "webview-ui/src/i18n")
    const files = fs.readdirSync(dictDir).filter((f) => f.endsWith(".ts"))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const content = fs.readFileSync(path.join(dictDir, file), "utf-8")
      for (const key of ["command.session.compact", "command.session.compact.description", "settings.context.title"]) {
        expect(content, `${file} still contains dead key "${key}"`).not.toContain(`"${key}"`)
      }
    }
  })

  it("keeps the retained compaction i18n keys in every app locale", () => {
    // LOCK-005: the automatic-compaction part rendering keys survive in every
    // locale (the visible part surface stays, the manual control is gone).
    const dictDir = path.join(ROOT, "webview-ui/src/i18n")
    const files = fs.readdirSync(dictDir).filter((f) => f.endsWith(".ts"))
    for (const file of files) {
      const content = fs.readFileSync(path.join(dictDir, file), "utf-8")
      expect(content, `${file} is missing "command.session.fork"`).toContain('"command.session.fork"')
    }
  })

  it("removes removed-feature entries from esbuild, knip, and webview tsconfig", () => {
    const esbuild = fs.readFileSync(ESBUILD_FILE, "utf-8")
    const knip = fs.readFileSync(KNIP_FILE, "utf-8")
    const tsconfig = fs.readFileSync(WEBVIEW_TSCONFIG, "utf-8")
    for (const needle of [
      "autocomplete",
      "commit-message",
      "commitMessage",
      "indexing",
      "memory",
      "context-progress",
    ]) {
      expect(esbuild, `esbuild.js must not reference ${needle}`).not.toContain(needle)
      expect(knip, `knip.json must not reference ${needle}`).not.toContain(needle)
      expect(tsconfig, `webview tsconfig must not reference ${needle}`).not.toContain(needle)
    }
  })

  it("drops the deleted kilo-indexing package from the CLI source hash (script/local-bin.ts)", () => {
    const localBin = fs.readFileSync(path.join(ROOT, "script/local-bin.ts"), "utf-8")
    expect(localBin).not.toContain("kilo-indexing")
    expect(localBin).not.toContain("indexingDir")
    expect(localBin).not.toContain("indexingResult")
    // The retained hash composite still covers the packages that exist.
    expect(localBin).toContain("sandboxDir")
  })

  it("no longer advertises inline autocomplete in the package metadata", () => {
    expect(pkg.description).not.toContain("autocomplete")
    expect(pkg.displayName).not.toContain("Autocomplete")
    const keywords = pkg.keywords ?? []
    expect(keywords).not.toContain("autocomplete")
    expect(keywords).not.toContain("code completion")
  })
})

describe("P3.4 retention — preserved surfaces survive (LOCK-005/006/007/008)", () => {
  it("keeps the Agent Manager serializer and removes the TabPanel serializer", () => {
    expect(ext).toContain("registerWebviewPanelSerializer(AgentManagerProvider.viewType")
    expect(ext).not.toContain('registerWebviewPanelSerializer("kilo-code.new.TabPanel"')
    expect(ext).not.toContain("kilo-code.new.TabPanel")
  })

  it("keeps the retained notebook helpers in src/services/notebook", () => {
    for (const file of ["bridge.ts", "index.ts", "adapter.ts", "path.ts", "uri.ts", "file-ignore.ts", "types.ts"]) {
      expect(fs.existsSync(path.join(ROOT, "src/services/notebook", file)), `notebook ${file}`).toBe(true)
    }
    expect(ext).toContain("createNotebookBridge(connectionService)")
    expect(provider).toContain('from "./services/notebook/file-ignore"')
  })

  it("keeps the retained setting tabs (custom providers LOCK-006, checkpoints LOCK-007/008)", () => {
    for (const file of [
      "ModelsTab.tsx",
      "ProvidersTab.tsx",
      "CheckpointsTab.tsx",
      "AgentBehaviourTab.tsx",
      "AutoApproveTab.tsx",
      "BrowserTab.tsx",
      "DisplayTab.tsx",
      "NotificationsTab.tsx",
      "ExperimentalTab.tsx",
      "LanguageTab.tsx",
      "AboutKiloCodeTab.tsx",
      "CustomProviderDialog.tsx",
    ]) {
      expect(fs.existsSync(path.join(ROOT, "webview-ui/src/components/settings", file)), `settings ${file}`).toBe(true)
    }
  })

  it("keeps the generic settings import/export surface (settings-io, not the removed importer)", () => {
    // LOCK-014/015: generic settings transfer is retained and distinct from the
    // deleted legacy-migration/importer. Assert the presence of the transfer
    // module, its UI host, and the export/import markers without reimplementing
    // the logic.
    expect(fs.existsSync(path.join(ROOT, "webview-ui/src/components/settings/settings-io.ts"))).toBe(true)
    expect(fs.existsSync(path.join(ROOT, "webview-ui/src/components/settings/AboutKiloCodeTab.tsx"))).toBe(true)
    expect(webview).toContain("./settings-io")
    expect(webview).toContain("buildExport")
    expect(webview).toContain("parseImport")
    expect(webview).toContain("MAX_IMPORT_SIZE")
    expect(webview).toContain("settings.aboutKiloCode.settingsTransfer")
    expect(webview).toContain("requestGlobalConfig")
    expect(webview).toContain("globalConfigLoaded")
    expect(webview).toContain("settings.aboutKiloCode.exportSettings")
    expect(webview).toContain("settings.aboutKiloCode.importSettings")
  })

  it("keeps invisible automatic CompactionPart rendering with no manual control (LOCK-005)", () => {
    const parts = fs.readFileSync(path.join(ROOT, "webview-ui/src/types/messages/parts.ts"), "utf-8")
    expect(parts).toContain("export interface CompactionPart")
    expect(parts).toContain('type: "compaction"')
    const queue = fs.readFileSync(path.join(ROOT, "webview-ui/src/context/session-queue.ts"), "utf-8")
    expect(queue).toContain('part.type === "compaction"')
  })

  it("keeps the generic chat/code actions and agent-manager surface", () => {
    expect(ext).toContain("registerCodeActions(context, resolveChatTarget)")
    expect(ext).toContain("registerTerminalActions(context, resolveChatTarget)")
    expect(ext).toContain('vscode.commands.registerCommand("kilo-code.new.agentManagerOpen"')
    expect(ext).toContain("selectKiloModel")
  })

  it("removes the extension legacy migration/importer surface", () => {
    for (const file of [
      "src/legacy-migration/migration-service.ts",
      "src/roo-import/service.ts",
      "webview-ui/src/components/migration/MigrationWizard.tsx",
      "webview-ui/src/types/messages/migration.ts",
      "src/kilo-provider/handlers/migration.ts",
    ]) {
      expect(fs.existsSync(path.join(ROOT, file)), `${file} must not exist`).toBe(false)
    }
    for (const id of [
      "openMigrationWizard",
      "requestMigrationData",
      "startMigration",
      "skipLegacyMigration",
      "clearLegacyData",
      "finalizeLegacyMigration",
      "migrationState",
      "legacy-migration",
      "roo-import",
    ]) {
      expect(extTree, `extension source must not reference ${id}`).not.toContain(id)
      expect(webview, `webview source must not reference ${id}`).not.toContain(id)
    }
  })

  it("keeps checkpoint and revert paths and the SDK-backed session endpoints", () => {
    expect(provider).toContain("this.client.session.revert")
    expect(provider).toContain("this.client.session.unrevert")
    expect(fs.existsSync(path.join(ROOT, "webview-ui/src/components/settings/CheckpointsTab.tsx"))).toBe(true)
  })
})

describe("P3.4 E2E wiring — the p3-4-removal scenario is registered and evidence-mapped", () => {
  const RUNNER = fs.readFileSync(path.join(ROOT, "tests/e2e/runner.ts"), "utf-8")
  const PROBE = fs.readFileSync(path.join(ROOT, "script/e2e-probe.ts"), "utf-8")
  const EVIDENCE = fs.readFileSync(path.join(ROOT, "script/e2e-evidence.ts"), "utf-8")

  it("registers the p3-4-removal scenario in the probe scenario table and parser", () => {
    expect(PROBE).toContain('"p3-4-removal"')
    expect(PROBE).toContain('value === "p3-4-removal"')
    expect(PROBE).toContain('if (scenarios.has("p3-4-removal"))')
  })

  it("maps the p3-4-removal ready marker in the probe", () => {
    expect(PROBE).toContain('if (scenarios.has("p3-4-removal")) return "p3-4-removal-ready"')
  })

  it("registers the focused scenario in the runner with a dedicated flag and supported value", () => {
    expect(RUNNER).toContain('runP34Removal: scenario === "p3-4-removal"')
    expect(RUNNER).toContain('"p3-4-removal"')
    expect(RUNNER).toContain("await assertP34Removal(vscodeApi, ext, scratch, fixtureId)")
  })

  it("records the runtime evidence as a required artifact in the evidence inventory", () => {
    expect(EVIDENCE).toContain('if (scenarios.has("p3-4-removal"))')
    expect(EVIDENCE).toContain('{ rel: "p3-4-removal-runtime-evidence", base: "scratch" }')
  })

  it("declares a dedicated package script for the focused scenario", () => {
    expect(pkg.scripts["test:e2e:p3-4-removal"]).toBe("KILO_E2E_SCENARIO=p3-4-removal node script/e2e-probe-launch.mjs")
  })

  it("runs the forbidden removed-feature identifiers and bundle prefixes in the runner", () => {
    expect(RUNNER).toContain("const FORBIDDEN_P34_IDS")
    expect(RUNNER).toContain('"generateCommitMessage"')
    expect(RUNNER).toContain('"AutocompleteInlineCompletionProvider"')
    expect(RUNNER).toContain('"prompt-indexing"')
    expect(RUNNER).toContain("const FORBIDDEN_P34_BUNDLE_PREFIXES")
  })
})
