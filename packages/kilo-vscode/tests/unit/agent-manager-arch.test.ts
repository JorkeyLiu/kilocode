/**
 * Architecture tests: Agent Manager
 *
 * The agent manager runs in the same webview context as other UI.
 * All its CSS classes must be prefixed with "am-" to avoid conflicts.
 * These tests also verify consistency between CSS definitions and TSX usage,
 * and that the provider sends correct message types for each action.
 */

import { describe, it, expect } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Project, SyntaxKind } from "ts-morph"

const ROOT = path.resolve(import.meta.dir, "../..")
const KILO_PROVIDER_FILE = path.join(ROOT, "src/KiloProvider.ts")
const CSS_FILES = [path.join(ROOT, "webview-ui/agent-manager/agent-manager.css")]
const TSX_FILES = [
  path.join(ROOT, "webview-ui/agent-manager/AgentManagerApp.tsx"),
  path.join(ROOT, "webview-ui/agent-manager/SidebarSessionList.tsx"),
  path.join(ROOT, "webview-ui/agent-manager/sortable-tab.tsx"),
  path.join(ROOT, "webview-ui/agent-manager/SidebarSearchMenu.tsx"),
  path.join(ROOT, "webview-ui/agent-manager/SidebarToggleButton.tsx"),
  path.join(ROOT, "webview-ui/agent-manager/tab-rendering.tsx"),
  path.join(ROOT, "webview-ui/agent-manager/WorkStyleEmptyPicker.tsx"),
  path.join(ROOT, "webview-ui/agent-manager/terminal/TerminalTab.tsx"),
  path.join(ROOT, "webview-ui/agent-manager/terminal/SortableTerminalTab.tsx"),
  path.join(ROOT, "webview-ui/agent-manager/terminal/render.tsx"),
  // Shared components that consume agent-manager CSS classes (e.g. am-dropdown,
  // am-branch-item) used by the agent manager.
  path.join(ROOT, "webview-ui/src/components/chat/TabDnd.tsx"),
]
const TSX_FILE = TSX_FILES[0]!
const PROVIDER_FILE = path.join(ROOT, "src/agent-manager/AgentManagerProvider.ts")
const TERMINAL_ROUTING_FILE = path.join(ROOT, "src/agent-manager/terminal-routing.ts")

function readAllCss(): string {
  return CSS_FILES.map((f) => fs.readFileSync(f, "utf-8")).join("\n")
}

function readAllTsx(): string {
  return TSX_FILES.map((f) => fs.readFileSync(f, "utf-8")).join("\n")
}

describe("Agent Manager CSS Prefix", () => {
  it("all class selectors should use am- prefix", () => {
    const css = readAllCss()
    const matches = [...css.matchAll(/\.([a-z][a-z0-9-]*)/gi)]
    const names = [...new Set(matches.map((m) => m[1]))]

    // Exceptions:
    // - VS Code sets these body classes on webview elements (scoping
    //   selectors for high contrast theme support).
    // - `kilo-diff-theme` is the shared Pierre diff theme utility defined
    //   in webview-ui/src/styles/diff.css and reused across webviews.
    // - `css` is matched from `@import "./diff.css"` file extension, not a
    //   class selector.
    const host = new Set(["vscode-high-contrast", "vscode-high-contrast-light", "kilo-diff-theme", "css"])
    const invalid = names.filter((n) => !n!.startsWith("am-") && !host.has(n!))

    expect(invalid, `Classes missing "am-" prefix: ${invalid.join(", ")}`).toEqual([])
  })

  it("all CSS custom properties should use am- prefix", () => {
    const css = readAllCss()
    const matches = [...css.matchAll(/--([a-z][a-z0-9-]*)\s*:/gi)]
    const names = [...new Set(matches.map((m) => m[1]))]

    // Allow kilo-ui design tokens, vscode theme variables, and third-party
    // library tokens (@pierre/diffs, kilo-ui sticky-accordion) used as fallbacks
    const allowed = ["am-", "vscode-", "surface-", "text-", "border-", "diffs-", "sticky-", "syntax-"]
    const invalid = names.filter((n) => !allowed.some((p) => n!.startsWith(p)))

    expect(invalid, `CSS properties missing allowed prefix: ${invalid.join(", ")}`).toEqual([])
  })

  it("all @keyframes should use am- prefix", () => {
    const css = readAllCss()
    const matches = [...css.matchAll(/@keyframes\s+([a-z][a-z0-9-]*)/gi)]
    const names = matches.map((m) => m[1])

    const invalid = names.filter((n) => !n!.startsWith("am-"))

    expect(invalid, `Keyframes missing "am-" prefix: ${invalid.join(", ")}`).toEqual([])
  })
})

describe("Agent Manager CSS/TSX Consistency", () => {
  it("all classes used in TSX should be defined in CSS", () => {
    const css = readAllCss()
    const tsx = readAllTsx()

    // Extract am- classes defined in CSS
    const cssMatches = [...css.matchAll(/\.([a-z][a-z0-9-]*)/gi)]
    const defined = new Set(cssMatches.map((m) => m[1]))

    // Extract am- classes referenced in TSX (class="am-..." or `am-...`)
    // Use negative lookbehind to exclude CSS custom properties (--am-...)
    const tsxMatches = [...tsx.matchAll(/(?<!--)\bam-[a-z0-9-]+/g)]
    const used = [...new Set(tsxMatches.map((m) => m[0]))]

    const missing = used.filter((c) => !defined.has(c))

    expect(missing, `Classes used in TSX but not defined in CSS: ${missing.join(", ")}`).toEqual([])
  })

  it("all am- classes defined in CSS should be used in TSX", () => {
    const css = readAllCss()
    const tsx = readAllTsx()

    // Extract am- classes defined in CSS
    const cssMatches = [...css.matchAll(/\.([a-z][a-z0-9-]*)/gi)]
    const defined = [...new Set(cssMatches.map((m) => m[1]!).filter((n) => n.startsWith("am-")))]

    const unused = defined.filter((c) => !tsx.includes(c!))

    // Phase 4A: worktree product surfaces removed from webview UI.
    // Many worktree-specific CSS classes are now unused in TSX but will be
    // cleaned up in Phase 4C alongside i18n keys and message contracts.
    // Filter out known worktree-related CSS class prefixes for Phase 4A.
    const worktreePrefixes = [
      "am-worktree-",
      "am-wt-",
      "am-apply-",
      "am-nv-",
      "am-import-",
      "am-advanced-",
      "am-confirm",
      "am-setup-",
      "am-hover-card",
      "am-pr-",
      "am-local-",
      "am-section-",
      "am-default-base-branch",
      "am-tab-switcher",
      "am-compare-",
      "am-shortcut-badge",
      "am-tooltip-wrap",
      "am-color-",
      "am-icon-flip",
      "am-ctx-menu-",
      "am-prompt-input",
      "am-mm-",
      "am-skeleton-wt",
      "am-selector-",
    ]
    const phase4aDeferred = unused.filter((c) => worktreePrefixes.some((p) => c!.startsWith(p)))
    const unexpected = unused.filter((c) => !worktreePrefixes.some((p) => c!.startsWith(p)))

    expect(unexpected, `Unexpected unused CSS classes (not worktree-related): ${unexpected.join(", ")}`).toEqual([])
    // Log deferred cleanups for visibility
    if (phase4aDeferred.length > 0) {
      console.log(`[Phase 4A] ${phase4aDeferred.length} worktree CSS classes deferred to Phase 4C cleanup`)
    }
  })
})

describe("Agent Manager Provider Messages", () => {
  function getMethodBody(name: string): string {
    const project = new Project({ compilerOptions: { allowJs: true } })
    const source = project.addSourceFileAtPath(PROVIDER_FILE)
    const cls = source.getFirstDescendantByKind(SyntaxKind.ClassDeclaration)
    const method = cls?.getMethod(name)
    expect(method, `method ${name} not found in AgentManagerProvider`).toBeTruthy()
    return method!.getText()
  }

  it("warms MCP before creating every new session via startSession", () => {
    // createSessionInWorktree was removed; session creation now happens in
    // startToolRequest via startSession() which does the MCP warmup.
    const text = fs.readFileSync(PROVIDER_FILE, "utf-8")
    expect(text).toContain("startSession(")
  })

  it("state-mutating messages wait for state initialization", () => {
    const body = getMethodBody("shouldWaitForState")
    // Phase 4B: trimmed to only message types that still have handlers
    const messages = ["agentManager.setTabOrder", "agentManager.persistSession", "agentManager.forgetSession"]

    for (const message of messages) {
      expect(body, `${message} should wait for loaded state`).toContain(message)
    }

    expect(getMethodBody("onMessage")).toContain("if (this.shouldWaitForState(m)) await this.waitForStateReady(m.type)")
  })

  it("initializeState delegates to runInitialization which pushes panel state on every path", () => {
    // UI-only lifecycle: workspace persistence owner + runInitialization serialization unchanged.
    // initializeState must only serialize via initializationOp and delegate to runInitialization;
    // runInitialization flushes/loads authoritative/pending fallback then pushes current panel state.
    const init = getMethodBody("initializeState")
    expect(init, "initializeState must delegate to runInitialization").toContain("runInitialization")
    expect(init, "initializeState must serialize via initializationOp").toContain("initializationOp")
    expect(init, "initializeState must not directly pushState — owner is runInitialization").not.toContain("pushState")
    expect(init, "initializeState must not directly load persisted state").not.toContain("loadPersisted")
    expect(init, "initializeState must not directly flush dirty persistence").not.toContain("flush()")

    const run = getMethodBody("runInitialization")
    // runInitialization owns the pushState contract on all success/dirty-fallback paths
    expect(run, "runInitialization must flush dirty persistence when hasDirty").toContain("this.flush()")
    expect(run, "runInitialization must load authoritative persisted state").toContain("this.loadPersisted()")
    expect(run, "runInitialization dirty-fallback path must restore pending snapshot").toContain("pendingSnapshot")
    expect(run, "runInitialization must push current panel state via pushState").toContain("this.pushState()")
    // Both the dirty-fallback early-return and the authoritative-load fallthrough must push guarded by panel
    const guarded = [...run.matchAll(/if\s*\(\s*this\.panel\s*\)\s*this\.pushState\(\)/g)]
    expect(
      guarded.length,
      "runInitialization must have guarded pushState on dirty fallback + authoritative path",
    ).toBeGreaterThanOrEqual(2)
    // Ensure pushes are not arbitrary file-wide but owned by runInitialization
    const pushes = [...run.matchAll(/this\.pushState\(\)/g)]
    expect(pushes.length, "runInitialization must own at least two pushState calls").toBeGreaterThanOrEqual(2)
  })

  it("async shutdown waits for terminal router cleanup", () => {
    const body = getMethodBody("disposeAsync")
    expect(body).toContain("await this.terminalRouter.dispose()")
    expect(body).not.toContain("void this.terminalRouter.dispose()")
  })

  // Phase 4B: onCloseSession was removed (unreachable from local-only webview).
  // Session close is now handled by the webview sending abort directly.
  // The TSX close-tab handler and panelSessions tracking remain intact.

  it("stops open sessions and clears remote registrations when the panel closes", () => {
    const body = getMethodBody("attachPanel")
    const abort = body.indexOf("ctx.sessions.abortSessions(ids)")
    const dispose = body.indexOf("ctx.sessions.dispose()")
    expect(abort).toBeGreaterThanOrEqual(0)
    expect(dispose).toBeGreaterThan(abort)
    expect(body).toContain("const ids = [...this.panelSessions]")
    expect(body).toContain("if (this.activeSessionId) ids.push(this.activeSessionId)")
    // Presence must be cleared via visiblePresence.clear() — a direct
    // registerVisible("agent-manager", []) would leave a stale displayed id
    // that re-registers on the next flush after the panel reopens.
    expect(body).toContain("this.visiblePresence.clear()")
    expect(body).not.toContain('this.connectionService.registerVisible("agent-manager"')
    expect(body).not.toContain('this.connectionService.registerAttached("agent-manager"')
    expect(body).toContain("this.activeSessionId = undefined")
    const messages = getMethodBody("onSessionMessage")
    expect(messages).toContain("if (m.draftID) this.panelSessions.add(m.draftID)")
    expect(messages).toContain("this.panel?.sessions.acknowledgeDraft(m.draftID, m.sessionId)")
    expect(messages).toContain("for (const id of m.sessionIDs) this.panelSessions.add(id)")
  })

  it("does not treat extension shutdown as a user panel close", () => {
    const body = getMethodBody("disposeAsync")
    expect(body.indexOf("this.panel = undefined")).toBeLessThan(body.indexOf("panel?.dispose()"))
  })

  it("reports all open Agent Manager sessions for remote control", () => {
    const body = fs.readFileSync(TSX_FILE, "utf-8")
    expect(body).toContain("reportRemoteSessions(vscode, localSessionIDs, managedSessions, isPending)")
  })
})

describe("Agent Manager Model Picker", () => {
  it("MultiModelSelector was removed in Phase 4A (worktree product surfaces)", () => {
    const filePath = path.join(ROOT, "webview-ui/agent-manager/MultiModelSelector.tsx")
    expect(fs.existsSync(filePath)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Provider message routing — static-analysis regression tests
//
// These tests use ts-morph to inspect the source code of AgentManagerProvider
// and verify structural invariants that prevent regressions without needing
// a VS Code test host.
// ---------------------------------------------------------------------------

describe("Agent Manager Provider — onMessage routing", () => {
  let source: import("ts-morph").SourceFile
  let cls: import("ts-morph").ClassDeclaration

  function setup() {
    if (source) return
    const project = new Project({ compilerOptions: { allowJs: true } })
    source = project.addSourceFileAtPath(PROVIDER_FILE)
    cls = source.getFirstDescendantByKind(SyntaxKind.ClassDeclaration)!
  }

  function body(name: string): string {
    setup()
    const method = cls.getMethod(name)
    expect(method, `method ${name} not found`).toBeTruthy()
    return method!.getText()
  }

  function provider(): string {
    return fs.readFileSync(PROVIDER_FILE, "utf-8")
  }

  // -- onMessage dispatches all expected message types -----------------------

  it("provider routing handles all documented agentManager.* message types", () => {
    const text = provider() + fs.readFileSync(TERMINAL_ROUTING_FILE, "utf-8")
    // Phase 4C: removed createWorktree, deleteWorktree, and other worktree-only messages;
    // P3.2 removed the run-script subsystem.
    const expected = [
      "agentManager.persistSession",
      "agentManager.forgetSession",
      "agentManager.showTerminal",
      "agentManager.showLocalTerminal",
      "agentManager.showExistingLocalTerminal",
      "agentManager.requestRepoInfo",
      "agentManager.requestState",
      "agentManager.setTabOrder",
      "agentManager.terminal.create",
      "agentManager.terminal.close",
      "agentManager.terminal.resize",
    ]
    for (const msg of expected) {
      expect(text, `provider routing should handle "${msg}"`).toContain(msg)
    }
  })

  it("session routing handles loadMessages for terminal switching", () => {
    const text = body("onSessionMessage")
    expect(text).toContain("loadMessages")
    expect(text).toContain("syncOnSessionSwitch")
  })

  it("terminal context reveals the terminal associated with the originating session", () => {
    const text = body("onSessionMessage")
    const show = text.indexOf("this.terminalManager.prepareContext(m.sessionID)")
    expect(show).toBeGreaterThan(-1)
    expect(text).not.toContain("!this.terminalManager.hasActiveTerminal()")
    expect(text).toContain('type: "terminalContextError"')
  })

  it("session routing handles clearSession for SSE re-registration", () => {
    const text = body("onSessionMessage")
    expect(text).toContain("clearSession")
    expect(text).toContain("trackSession")
  })

  // Phase 4C: onWorktreeMessage, onDeleteWorktree, onCreateWorktree, notifyWorktreeReady removed.
  it("onMessage delegates to cohesive routing groups", () => {
    const text = body("onMessage")
    expect(text).toContain("onSessionMessage")
    expect(text).toContain("onUiMessage")
    expect(text).toContain("onStateMessage")
    expect(text).not.toContain("onDiffMessage")
    expect(text).not.toContain("agentManager.requestState")
  })

  // LOCK-002: the shared sidebar Diff Viewer stays intact, and its
  // agentManager.openFile route (session file → VS Code editor) is preserved
  // even though the feature-exclusive Agent Manager diff/review surface was
  // removed. Guard the routing so a future cleanup cannot drop it silently.
  it("routes agentManager.openFile through onUiMessage to the file opener", () => {
    const text = body("onUiMessage")
    expect(text, "onUiMessage must route agentManager.openFile").toContain('m.type === "agentManager.openFile"')
    expect(text, "openFile handler must call the shared file opener").toContain(
      "this.openFile(m.sessionId, m.filePath, m.line, m.column)",
    )
    expect(text, "openFile must be consumed (return null), not forwarded to the backend").toContain(
      "this.openFile(m.sessionId, m.filePath, m.line, m.column)\n      return null",
    )
  })

  // Phase 4C: onDeleteWorktree, onCreateWorktree, notifyWorktreeReady removed.

  // -- agentManager.requestState in non-git workspace -------------------------

  /**
   * Phase 4C: pushEmptyState removed — local-only mode always pushes via pushState().
   */
  it("requestState handler calls pushState", () => {
    const text = body("onRequestState")
    expect(text, "must call pushState for the normal path").toContain("this.pushState()")
  })

  // Phase 4C: onDiffMessage and onImportMessage were removed from AgentManagerProvider.
  // The Agent Manager worktree diff controller and the custom Diff Viewer
  // (P3.2) are both gone; local git diff data now flows through Agent Manager
  // local stats and git-changes prompt context only.
})

// ---------------------------------------------------------------------------
// Webview — catalog readiness contract
// ---------------------------------------------------------------------------

describe("Agent Manager Webview — catalog readiness contract", () => {
  const tsx = readAllTsx()

  /**
   * Contract: catalog readiness (sessionsLoaded) comes ONLY from the real
   * "sessionsLoaded" backend message. Durable `agentManager.state` restores
   * IDs/order/active for hydration but must never mark the catalog as ready —
   * conflating persisted UI state with authoritative backend catalog would
   * mask missing/deleted sessions. Non-git intent is preserved via the
   * `isGitRepo` signal stored from state and rendered inside the
   * sessionsLoaded-gated UI, not via state-driven readiness.
   */
  it("agentManager.state does NOT set catalog readiness — only sessionsLoaded does", () => {
    const start = tsx.indexOf('"agentManager.state"')
    expect(start, "agentManager.state handler must exist").toBeGreaterThan(-1)
    const snippet = tsx.slice(start, start + 2500)
    expect(
      snippet,
      "agentManager.state must NOT call setSessionsLoaded — catalog readiness comes only from real sessionsLoaded message",
    ).not.toContain("setSessionsLoaded")
    expect(snippet, "state handler must still capture isGitRepo for non-git UI").toContain("setIsGitRepo")
  })

  it("sessionsLoaded handler is the sole setter of catalog readiness", () => {
    const start = tsx.indexOf('"sessionsLoaded"')
    expect(start, "sessionsLoaded handler must exist").toBeGreaterThan(-1)
    const snippet = tsx.slice(start, start + 1400)
    expect(snippet, "sessionsLoaded handler must set catalog readiness").toContain("setSessionsLoaded(true)")
    expect(snippet, "sessionsLoaded handler must accumulate catalog").toContain("accumulateCatalog")
    expect(snippet, "sessionsLoaded handler must trigger reconciliation").toContain("applyReconciliation")
  })

  it("sessionsProgress preview never drives authoritative readiness or reconciliation", () => {
    const start = tsx.indexOf('"sessionsProgress"')
    expect(start, "sessionsProgress preview handler must exist").toBeGreaterThan(-1)
    const snippet = tsx.slice(start, start + 1400)
    expect(snippet, "preview must not set catalog readiness").not.toContain("setSessionsLoaded")
    expect(snippet, "preview must not accumulate the authoritative catalog").not.toContain("accumulateCatalog")
    expect(snippet, "preview must not trigger reconciliation").not.toContain("applyReconciliation")
    expect(snippet, "preview must clear scoped failure on newer refresh").toContain("setCatalogFailed(false)")
  })

  it("preserves non-git behavior via isGitRepo signal without conflating with catalog readiness", () => {
    expect(tsx, "non-git notice must still exist").toContain("am-not-git-notice")
    expect(tsx, "non-git notice must be gated by isGitRepo signal").toContain("!isGitRepo()")
    // SidebarSessionList owns skeleton/preview/complete rendering; the
    // skeleton gates on the sessionsLoaded prop. The non-git notice lives in
    // AgentManagerApp after the catalog is ready and never sets readiness.
    expect(tsx, "skeleton must gate on sessionsLoaded").toContain("props.sessionsLoaded")
    const app = fs.readFileSync(path.join(ROOT, "webview-ui/agent-manager/AgentManagerApp.tsx"), "utf-8")
    expect(app, "non-git notice must render only after the catalog is ready").toContain(
      "sessionsLoaded() && !isGitRepo()",
    )
  })

  it("preview rows are read-only with retry owned by scoped catalog failure", () => {
    const sidebar = fs.readFileSync(path.join(ROOT, "webview-ui/agent-manager/SidebarSessionList.tsx"), "utf-8")
    const app = fs.readFileSync(path.join(ROOT, "webview-ui/agent-manager/AgentManagerApp.tsx"), "utf-8")

    // 1. SidebarSessionList failed-preview Button calls props.onRetryPreview?.()
    const failed = sidebar.indexOf("props.previewFailed")
    expect(failed, "previewFailed branch must exist in SidebarSessionList").toBeGreaterThan(-1)
    const btn = sidebar.indexOf("<Button", failed)
    expect(btn, "failed-preview retry button must exist").toBeGreaterThan(-1)
    const btnEnd = sidebar.indexOf("</Button>", btn)
    expect(btnEnd, "retry button must close").toBeGreaterThan(btn)
    const btnSlice = sidebar.slice(btn, btnEnd + "</Button>".length)
    expect(btnSlice, "retry button must call props.onRetryPreview?.()").toContain("props.onRetryPreview?.()")

    // 2. Preview row block has data-preview-id + aria-disabled and no onClick, onKeyDown, onSelectSession, rename/delete/expand actions
    const loop = sidebar.indexOf("<For each={previewRows()}>")
    expect(loop, "preview rows loop must exist in SidebarSessionList").toBeGreaterThan(-1)
    const loopEnd = sidebar.indexOf("</For>", loop)
    expect(loopEnd, "preview rows loop must close").toBeGreaterThan(loop)
    const rowSlice = sidebar.slice(loop, loopEnd + "</For>".length)
    expect(rowSlice, "preview row block must have data-preview-id").toContain("data-preview-id")
    expect(rowSlice, "preview row block must have aria-disabled").toContain('aria-disabled="true"')
    expect(rowSlice, "preview row block must not bind onClick").not.toContain("onClick")
    expect(rowSlice, "preview row block must not bind onKeyDown").not.toContain("onKeyDown")
    expect(rowSlice, "preview row block must not trigger onSelectSession").not.toContain("onSelectSession")
    expect(rowSlice, "preview row block must not include rename actions").not.toContain("rename")
    expect(rowSlice, "preview row block must not include delete actions").not.toContain("delete")
    expect(rowSlice, "preview row block must not include expand actions").not.toMatch(
      /toggle\(|aria-expanded|isExpanded/,
    )
    expect(sidebar, "preview must not derive Topics").not.toMatch(/preview[\s\S]{0,2000}deriveTopics\(/)

    // 3. AgentManagerApp.retryCatalog clears scoped failure and posts {type:"loadSessions"}
    const retry = app.indexOf("const retryCatalog =")
    expect(retry, "retryCatalog function must exist in AgentManagerApp").toBeGreaterThan(-1)
    const retrySlice = app.slice(retry, retry + 200)
    expect(retrySlice, "retryCatalog must clear scoped failure").toContain("setCatalogFailed(false)")
    expect(retrySlice, "retryCatalog must post loadSessions message").toMatch(
      /postMessage\(\s*\{\s*type:\s*["']loadSessions["']\s*\}\s*\)/,
    )

    // 4. AgentManagerApp passes onRetryPreview={retryCatalog}
    const usage = app.indexOf("<SidebarSessionList")
    expect(usage, "<SidebarSessionList usage must exist in AgentManagerApp").toBeGreaterThan(-1)
    const usageEnd = app.indexOf("/>", usage)
    expect(usageEnd, "<SidebarSessionList usage must close").toBeGreaterThan(usage)
    const usageSlice = app.slice(usage, usageEnd + 2)
    expect(usageSlice, "AgentManagerApp must pass onRetryPreview={retryCatalog}").toContain(
      "onRetryPreview={retryCatalog}",
    )
  })

  it("ordinary session store ignores sessionsProgress; sessionsLoaded stays authoritative", () => {
    const ctx = fs.readFileSync(path.join(ROOT, "webview-ui/src/context/session.tsx"), "utf-8")
    const start = ctx.indexOf('"sessionsProgress"')
    expect(start, "session store must explicitly ignore preview").toBeGreaterThan(-1)
    const snippet = ctx.slice(start, start + 400)
    expect(snippet, "preview must never enter the ordinary session store").not.toContain("setStore")
    expect(snippet, "preview must never call authoritative reconciliation").not.toContain("handleSessionsLoaded")
  })
})

// ---------------------------------------------------------------------------
// KiloProvider — pendingSessionRefresh race condition fix
// ---------------------------------------------------------------------------

describe("KiloProvider — pending session refresh on reconnect", () => {
  const provider = fs.readFileSync(KILO_PROVIDER_FILE, "utf-8")
  const utils = fs.readFileSync(path.join(ROOT, "src/kilo-provider-utils.ts"), "utf-8")

  /**
   * Regression: when the Agent Manager opens its panel, initializeState()
   * calls refreshSessions() before the CLI server has started. Because
   * httpClient is null at that point, handleLoadSessions() used to bail
   * with an error message and never send "sessionsLoaded" to the webview.
   * The worktree would show up in the sidebar but display "No sessions open".
   *
   * The fix uses a pendingSessionRefresh flag: loadSessions() (in
   * kilo-provider-utils) sets it when httpClient is unavailable, and
   * both initializeConnection() and the "connected" state handler flush
   * the pending refresh.
   */
  it("loadSessions sets pendingSessionRefresh when client is null", () => {
    const start = utils.indexOf("export async function loadSessions")
    expect(start, "loadSessions must exist in kilo-provider-utils").toBeGreaterThan(-1)
    const snippet = utils.slice(start, start + 700)
    expect(snippet, "must set pendingSessionRefresh when client missing").toContain("ctx.pendingSessionRefresh = true")
    expect(snippet, "must avoid noisy errors while still connecting").toContain('ctx.connectionState !== "connecting"')
    expect(snippet, "must clear pendingSessionRefresh on successful entry").toContain(
      "ctx.pendingSessionRefresh = false",
    )
  })

  it("handleLoadSessions delegates to loadSessionsUtil through the serialized load chain", () => {
    // Session-list loads are serialized (enqueueSessionLoad) so concurrent
    // refreshes never interleave; the actual fetch lives in runLoadSessions.
    const start = provider.indexOf("private handleLoadSessions(")
    expect(start, "handleLoadSessions must exist").toBeGreaterThan(-1)
    const snippet = provider.slice(start, start + 400)
    expect(snippet, "must enqueue through the serialized load chain").toContain("enqueueSessionLoad")
    expect(snippet, "must delegate the fetch to runLoadSessions").toContain("runLoadSessions")
    const runStart = provider.indexOf("private async runLoadSessions(")
    expect(runStart, "runLoadSessions must exist").toBeGreaterThan(-1)
    expect(provider.slice(runStart, runStart + 500), "runLoadSessions must call loadSessionsUtil").toContain(
      "loadSessionsUtil",
    )
  })

  it("connected state handler flushes deferred session refresh", () => {
    // Bound the assertion to the onStateChange subscription block: from the
    // "connected" branch to the next subscription setup
    // (unsubscribeLanguageChange), which structurally closes the connected
    // handler regardless of how many best-effort steps the block grows.
    const connectedIdx = provider.indexOf('state === "connected"')
    expect(connectedIdx, '"connected" state handler must exist').toBeGreaterThan(-1)
    const endIdx = provider.indexOf("this.unsubscribeLanguageChange", connectedIdx)
    expect(endIdx, "connected handler block must end before the next subscription").toBeGreaterThan(connectedIdx)
    const snippet = provider.slice(connectedIdx, endIdx)
    expect(snippet, "must call flushPendingSessionRefresh from connected handler").toContain(
      'this.flushPendingSessionRefresh("sse-connected")',
    )
  })

  it("initializeConnection flushes deferred refresh for missed connected events", () => {
    const initIdx = provider.indexOf('this.syncWebviewState("initializeConnection")')
    expect(initIdx, "initializeConnection sync call must exist").toBeGreaterThan(-1)
    const snippet = provider.slice(initIdx, initIdx + 220)
    expect(snippet, "must flush deferred session refresh in initializeConnection").toContain(
      'this.flushPendingSessionRefresh("initializeConnection")',
    )
  })

  it("pendingSessionRefresh is declared as a class field", () => {
    expect(provider, "pendingSessionRefresh field must be declared").toMatch(
      /private\s+pendingSessionRefresh\s*=\s*false/,
    )
  })
})

// ---------------------------------------------------------------------------
// handleChangeDefaultBaseBranch — listener leak fix
// ---------------------------------------------------------------------------

describe("Agent Manager — dialog listener cleanup", () => {
  /**
   * Phase 4A: handleChangeDefaultBaseBranch was removed along with all
   * worktree product surfaces. The dialog listener leak fix no longer applies.
   */
  it("handleChangeDefaultBaseBranch was removed in Phase 4A", () => {
    const tsx = fs.readFileSync(TSX_FILE, "utf-8")
    expect(tsx).not.toContain("handleChangeDefaultBaseBranch")
  })
})

// ---------------------------------------------------------------------------
// VS Code import boundary — layering enforcement
//
// The agent-manager is being decoupled from VS Code so it can eventually run
// outside the extension host. These tests enforce the layering:
//
//   1. Only files on the VSCODE_ALLOWED list may import "vscode".
//   2. Each allowed file has a maxLines cap — shrink it as logic is extracted.
//
// To improve the architecture:
//   - Extract business logic from allowed files into vscode-free modules.
//   - Lower maxLines once the extraction lands.
//   - Remove entries from VSCODE_ALLOWED once they no longer need vscode.
// ---------------------------------------------------------------------------

const AGENT_MANAGER_DIR = path.join(ROOT, "src/agent-manager")

/**
 * Exception list: files currently allowed to import `vscode`.
 *
 * Each entry has a maxLines cap. The goal is to shrink these over time and
 * eventually remove entries as logic moves into vscode-free modules.
 *
 * When you extract code out of one of these files, lower its maxLines to
 * the new line count rounded up to the nearest 50.
 *
 * DO NOT raise maxLines to accommodate new code. If adding a feature would
 * exceed the cap, extract logic into a vscode-free helper module and have
 * the provider call it. Only raise the cap as a last resort when the code
 * is structurally impossible to extract (e.g. deep vscode API interleaving)
 * — and document the reason in the entry's `note` field.
 */
const VSCODE_ALLOWED: Record<string, { note: string }> = {
  // VS Code adapter implementing the Host interface for the Agent Manager
  "vscode-host.ts": {
    note: "vscode adapter implementing Host interface",
  },
  // Thin adapter: wraps vscode.window terminal APIs behind TerminalHost interface
  "terminal-host.ts": {
    note: "vscode adapter for SessionTerminalManager",
  },
  // Reads terminal.integrated.* and editor.font* config for xterm font settings
  "terminal-font.ts": {
    note: "vscode config reader for integrated terminal font settings",
  },
}

/**
 * File size caps — prevent large files from growing unchecked.
 *
 * When you extract code out of one of these files, lower its maxLines to
 * the new line count rounded up to the nearest 50.
 *
 * DO NOT raise maxLines to accommodate new code. If adding a feature would
 * exceed the cap, extract logic into a vscode-free helper module and have
 * the provider call it. Only raise the cap as a last resort when the code
 * is structurally impossible to extract (e.g. deep vscode API interleaving)
 * — and document the reason in the entry's `note` field.
 */
const MAX_LINES: Record<string, { maxLines: number; note: string }> = {
  "AgentManagerProvider.ts": {
    maxLines: 2000,
    note: "diff and import workflows are extracted into cohesive domain services; extract more orchestration next",
  },
}

function importsVscode(content: string): boolean {
  return /(?:from|require\()\s*["']vscode["']/.test(content)
}

function agentManagerSourceFiles(): string[] {
  return fs
    .readdirSync(AGENT_MANAGER_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".spec.ts"))
}

describe("Agent Manager — VS Code import boundary", () => {
  it("only allowlisted files may import vscode", () => {
    const violations: string[] = []
    for (const file of agentManagerSourceFiles()) {
      if (file in VSCODE_ALLOWED) continue
      const content = fs.readFileSync(path.join(AGENT_MANAGER_DIR, file), "utf-8")
      if (importsVscode(content)) violations.push(file)
    }
    expect(
      violations,
      `These files import "vscode" but are not on the exception list.\n` +
        `Either extract the vscode dependency or add them to VSCODE_ALLOWED:\n` +
        violations.map((v) => `  - ${v}`).join("\n"),
    ).toEqual([])
  })

  it("capped files stay within their maxLines limit", () => {
    const overweight: string[] = []
    for (const [file, { maxLines }] of Object.entries(MAX_LINES)) {
      const filepath = path.join(AGENT_MANAGER_DIR, file)
      if (!fs.existsSync(filepath)) continue
      const lines = fs.readFileSync(filepath, "utf-8").split("\n").length
      if (lines > maxLines) overweight.push(`${file}: ${lines} lines (cap: ${maxLines})`)
    }
    expect(
      overweight,
      `File too large — needs better modularization.\n\n` +
        overweight.map((o) => `  ${o}`).join("\n") +
        `\n\n` +
        `Do NOT raise maxLines. Instead, extract logic into a vscode-free\n` +
        `helper module and call it from the provider. See fork-session.ts\n` +
        `for an example of this pattern.`,
    ).toEqual([])
  })

  it("every allowlisted file actually exists", () => {
    const stale = Object.keys(VSCODE_ALLOWED).filter((f) => !fs.existsSync(path.join(AGENT_MANAGER_DIR, f)))
    expect(
      stale,
      `These files are in VSCODE_ALLOWED but no longer exist — remove them:\n` +
        stale.map((s) => `  - ${s}`).join("\n"),
    ).toEqual([])
  })

  it("every allowlisted file actually imports vscode", () => {
    const unnecessary: string[] = []
    for (const file of Object.keys(VSCODE_ALLOWED)) {
      const filepath = path.join(AGENT_MANAGER_DIR, file)
      if (!fs.existsSync(filepath)) continue
      if (!importsVscode(fs.readFileSync(filepath, "utf-8"))) unnecessary.push(file)
    }
    expect(
      unnecessary,
      `These files no longer import "vscode" — remove them from VSCODE_ALLOWED:\n` +
        unnecessary.map((u) => `  - ${u}`).join("\n"),
    ).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Provider chain parity — sidebar App.tsx vs AgentManagerApp.tsx
//
// The agent manager reuses ChatView (and therefore MessageList, etc.) from the
// sidebar. Any context provider that ChatView's tree may call useXxx() on must
// also be present in the agent manager's provider chain. A missing provider
// crashes the entire SolidJS component tree silently.
// ---------------------------------------------------------------------------

const APP_FILE = path.join(ROOT, "webview-ui/src/App.tsx")
const AGENT_MANAGER_APP_FILE = path.join(ROOT, "webview-ui/agent-manager/AgentManagerApp.tsx")

describe("Agent Manager — provider chain parity with sidebar", () => {
  /**
   * Extract provider component names used as JSX elements in a file.
   * Matches `<FooProvider` and `<FooProvider>` patterns, returning the names.
   */
  function extractProviders(content: string): string[] {
    const matches = [...content.matchAll(/<(\w+Provider)\b/g)]
    return [...new Set(matches.map((m) => m[1]!))]
  }

  /**
   * Providers that the agent manager intentionally omits because it does not
   * use the components that depend on them. If a shared component (ChatView,
   * MessageList, etc.) starts using one of these, the test will fail and
   * force the developer to add the provider to AgentManagerApp.tsx.
   */
  const KNOWN_EXCLUSIONS: string[] = [
    // These are wrapped by LanguageBridge and DataBridge respectively,
    // which the agent manager already includes in its provider chain.
    "LanguageProvider",
    "DataProvider",
    // Agent Manager owns its local session tabs and ChatView only reads this
    // optional context in the standard sidebar/editor webview.
    "LocalTabsProvider",
  ]

  it("agent manager includes all context providers from sidebar App.tsx", () => {
    const sidebar = fs.readFileSync(APP_FILE, "utf-8")
    const agent = fs.readFileSync(AGENT_MANAGER_APP_FILE, "utf-8")

    const sidebarProviders = extractProviders(sidebar)
    const agentProviders = extractProviders(agent)
    const agentSet = new Set(agentProviders)
    const excluded = new Set(KNOWN_EXCLUSIONS)

    const missing = sidebarProviders.filter((p) => !agentSet.has(p) && !excluded.has(p))

    expect(
      missing,
      `These providers are in App.tsx but missing from AgentManagerApp.tsx.\n` +
        `The agent manager reuses ChatView — any provider that ChatView's component\n` +
        `tree depends on must be present in both provider chains.\n\n` +
        `Missing providers:\n` +
        missing.map((p) => `  - ${p}`).join("\n") +
        `\n\nFix: add the missing <${missing[0]}> to AgentManagerApp.tsx's provider chain,\n` +
        `or add it to KNOWN_EXCLUSIONS with a justification if it's truly unused.`,
    ).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Agent Manager — viewChildSession event handling contract
//
// TaskToolExpanded (shared between sidebar and Agent Manager) posts a
// "viewChildSession" window message when the user clicks a child session
// navigation link. The sidebar App.tsx handles this event. AgentManagerApp.tsx
// must also handle it — otherwise clicking child session links inside the
// Agent Manager silently does nothing.
// ---------------------------------------------------------------------------

describe("Agent Manager — viewChildSession event contract", () => {
  it("sidebar App.tsx no longer handles viewChildSession (LOCK-001: ordinary bundle has no chat)", () => {
    const source = fs.readFileSync(APP_FILE, "utf-8")
    expect(source).not.toContain("viewChildSession")
  })

  it("AgentManagerApp.tsx handles viewChildSession messages", () => {
    const source = fs.readFileSync(AGENT_MANAGER_APP_FILE, "utf-8")
    expect(
      source,
      "AgentManagerApp.tsx does not handle 'viewChildSession' window messages.\n" +
        "TaskToolExpanded posts this event when clicking child session links.\n" +
        "Without a handler, child navigation silently does nothing inside the Agent Manager.\n\n" +
        'Fix: add a `msg?.type === "viewChildSession"` check in the onMount message handler\n' +
        "that calls session.selectSession(msg.sessionID).",
    ).toContain('"viewChildSession"')
    // Verify it actually calls session.selectSession with the child ID
    // (handler may be extracted to a named function)
    expect(
      source,
      "AgentManagerApp handles viewChildSession but does not call session.selectSession.\n" +
        "The handler must select the child session to navigate to it.",
    ).toContain("session.selectSession")
  })

  it("viewChildSession defaults to LOCAL when session ID is absent from both lists", () => {
    const source = fs.readFileSync(AGENT_MANAGER_APP_FILE, "utf-8")
    // Phase 4A: selection is always LOCAL (a function returning the constant),
    // so no explicit setSelection(LOCAL) call is needed. The handler navigates
    // via the child-open transaction which sets selection internally.
    expect(source).toContain("handleViewChildSession")
    expect(source).toContain("openChildSession")
  })

  it("viewChildSession carries the source session ID into the child-open transaction", () => {
    const source = fs.readFileSync(AGENT_MANAGER_APP_FILE, "utf-8")
    // The production task renderer (TaskToolExpanded, shared with the sidebar)
    // posts sourceSessionID alongside sessionID. AgentManagerApp must forward
    // both so the child opens immediately right of its source tab.
    expect(source).toContain(
      "handleViewChildSession(msg.sessionID as string, msg.sourceSessionID as string | undefined)",
    )
    expect(source).toContain("const handleViewChildSession = (id: string, source: string | undefined) =>")
  })

  it("generic openSession stays append — only the child-open path is source-relative", () => {
    const openSessionSrc = fs.readFileSync(path.join(ROOT, "webview-ui/agent-manager/open-session.ts"), "utf-8")
    // The canonical openSession transaction (used by +/Cmd+T/navigation/sessionAdded)
    // must remain append-or-focus via tabMgr.open. The source-relative behavior is
    // isolated in the dedicated openChildSession transaction.
    expect(openSessionSrc).toContain("deps.tabMgr.open(LOCAL, id)")
    expect(openSessionSrc).toContain("export function openChildSession")
    expect(openSessionSrc).toContain("deps.tabMgr.openAfter(LOCAL, source, id)")
  })

  it("TaskToolExpanded emits sourceSessionID alongside sessionID", () => {
    const file = path.join(ROOT, "webview-ui/src/components/chat/TaskToolExpanded.tsx")
    const source = fs.readFileSync(file, "utf-8")
    expect(source).toContain('type: "viewChildSession", sessionID: id, sourceSessionID: session.currentSessionID()')
  })
})

// ---------------------------------------------------------------------------
// Agent Manager — explicit task renderer registration (LOCK-001)
//
// TaskToolExpanded was previously active in the Agent Manager webview only as
// an accidental module-scope side effect of importing DataBridge from App.tsx
// (which calls registerExpandedTaskTool/registerVscodeToolOverrides). The
// bridges moved to side-effect-free AppBridge.tsx; the Agent Manager must
// register the renderers it owns explicitly at its own boundary, and the
// sidebar must keep its own single registration.
// ---------------------------------------------------------------------------

describe("Agent Manager — explicit tool renderer registration (LOCK-001)", () => {
  const APP_BRIDGE_FILE = path.join(ROOT, "webview-ui/src/AppBridge.tsx")

  it("AgentManagerApp imports DataBridge from AppBridge, not from App.tsx", () => {
    const source = fs.readFileSync(AGENT_MANAGER_APP_FILE, "utf-8")
    expect(source).toContain('import { DataBridge, MermaidDownloadBridge } from "../src/AppBridge"')
    expect(source).not.toContain('from "../src/App"')
  })

  it("AgentManagerApp registers TaskToolExpanded and sidebar tool overrides explicitly", () => {
    const source = fs.readFileSync(AGENT_MANAGER_APP_FILE, "utf-8")
    expect(source).toContain("registerExpandedTaskTool()")
    expect(source).toContain("registerVscodeToolOverrides()")
  })

  it("AppBridge is side-effect-free (no module-scope tool registration)", () => {
    const bridge = fs.readFileSync(APP_BRIDGE_FILE, "utf-8")
    expect(bridge).not.toContain("registerExpandedTaskTool()")
    expect(bridge).not.toContain("registerVscodeToolOverrides()")
  })

  it("sidebar App.tsx no longer registers the task renderer (LOCK-001: ordinary bundle has no ChatView)", () => {
    const sidebar = fs.readFileSync(APP_FILE, "utf-8")
    expect(sidebar).not.toContain("registerExpandedTaskTool()")
    expect(sidebar).not.toContain("registerVscodeToolOverrides()")
  })

  it("App.tsx re-exports the bridges so the sidebar public API is unchanged", () => {
    const sidebar = fs.readFileSync(APP_FILE, "utf-8")
    expect(sidebar).toContain("export { DataBridge, MermaidDownloadBridge }")
  })
})

// ---------------------------------------------------------------------------
// Agent Manager — sessionDeleted tab registry contract
//
// When the backend sends a sessionDeleted message, the Agent Manager must
// remove the session from every tab registry context (LOCAL + all worktrees)
// to prevent stale IDs from lingering in the tab strip.
// ---------------------------------------------------------------------------

describe("Agent Manager — sessionDeleted tab registry contract", () => {
  it("AgentManagerApp.tsx handles sessionDeleted messages", () => {
    const source = fs.readFileSync(AGENT_MANAGER_APP_FILE, "utf-8")
    expect(
      source,
      "AgentManagerApp.tsx does not handle 'sessionDeleted' messages.\n" +
        "Backend session deletion must clean up the tab registry.\n\n" +
        'Fix: add a `msg.type === "sessionDeleted"` check in the onMount message handler.',
    ).toContain('"sessionDeleted"')
  })

  it("sessionDeleted removes from LOCAL tabMgr context (Phase 3A single context)", () => {
    const source = fs.readFileSync(AGENT_MANAGER_APP_FILE, "utf-8")
    // Phase 3A: single LOCAL context — handler removes directly from LOCAL.
    expect(
      source,
      "sessionDeleted handler must remove from LOCAL tabMgr context.\n\n" +
        "Fix: call tabMgr.remove(LOCAL, sid) in the handler.",
    ).toContain("tabMgr.remove(LOCAL, sid)")
  })

  it("sessionDeleted uses tabMgr.remove (not tabMgr.close)", () => {
    const source = fs.readFileSync(AGENT_MANAGER_APP_FILE, "utf-8")
    // Must use remove() for explicit deletion semantics (deterministic adjacent fallback)
    expect(
      source,
      "sessionDeleted handler must use tabMgr.remove() for explicit deletion semantics.\n\n" +
        "Fix: use tabMgr.remove(ctx, sid) instead of tabMgr.close(ctx, sid) in the handler.",
    ).toContain("tabMgr.remove(")
  })
})

// ---------------------------------------------------------------------------
// Agent Manager — atomic close-others contract
//
// The "Close Others" tab context menu must route through the registry's
// atomic closeOthers operation rather than closing tabs one-by-one.
// ---------------------------------------------------------------------------

describe("Agent Manager — atomic close-others contract", () => {
  const TAB_RENDER_FILE = path.join(ROOT, "webview-ui/agent-manager/tab-rendering.tsx")

  it("closeOthers in tab-rendering.tsx uses tabMgrCloseOthers", () => {
    const source = fs.readFileSync(TAB_RENDER_FILE, "utf-8")
    const fnBlock = source.slice(source.indexOf("function closeOthers("))
    expect(
      fnBlock.slice(0, 1500),
      "closeOthers in tab-rendering.tsx must call deps.tabMgrCloseOthers for atomic registry update.\n\n" +
        "Fix: call deps.tabMgrCloseOthers(deps.ctx(), target) before sending individual close messages.",
    ).toContain("deps.tabMgrCloseOthers(")
  })

  it("TabRenderDeps includes ctx and tabMgrCloseOthers", () => {
    const source = fs.readFileSync(TAB_RENDER_FILE, "utf-8")
    expect(
      source,
      "TabRenderDeps must include ctx and tabMgrCloseOthers fields for atomic close-others.\n\n" +
        "Fix: add ctx: () => string and tabMgrCloseOthers to the interface.",
    ).toContain("tabMgrCloseOthers:")
    expect(source).toContain("ctx:")
  })

  it("TabRenderDeps includes sessionCloseMessage for lightweight close", () => {
    const source = fs.readFileSync(TAB_RENDER_FILE, "utf-8")
    expect(
      source,
      "TabRenderDeps must include sessionCloseMessage for lightweight backend close messages.\n\n" +
        "Fix: add sessionCloseMessage: (id: string) => void to the interface.",
    ).toContain("sessionCloseMessage:")
  })
})

describe("Agent Manager — continueInWorktree prop contract", () => {
  it("AgentManagerApp does not pass continueInWorktree to ChatView", () => {
    const source = fs.readFileSync(AGENT_MANAGER_APP_FILE, "utf-8")
    expect(source).not.toContain("continueInWorktree")
  })
})

// ---------------------------------------------------------------------------
// Agent Manager — P1 derived Topic navigation invariants (Q1-LOCK)
//
// Topic/session navigation is derived at render time from runtime session
// facts only: no Topic persistence, no new extension message types, no
// session mutation. The sidebar derives Topics via the pure module and
// routes selection through the existing onSelectSession → openSession
// transaction.
// ---------------------------------------------------------------------------

describe("Agent Manager — P1 derived Topic navigation", () => {
  const SIDEBAR_FILE = path.join(ROOT, "webview-ui/agent-manager/SidebarSessionList.tsx")
  const TOPICS_FILE = path.join(ROOT, "webview-ui/agent-manager/topics.ts")

  it("SidebarSessionList derives Topics from the pure topic module", () => {
    const source = fs.readFileSync(SIDEBAR_FILE, "utf-8")
    expect(source).toContain('from "./topics"')
    expect(source).toContain("deriveTopics(")
    expect(source).toContain("activeTopicID(")
  })

  it("SidebarSessionList auto-expands only when the active session or Topic changes", () => {
    // The auto-expand effect tracks only the active session ID and the derived
    // active Topic ID. An unrelated inventory update (same active session and
    // Topic, e.g. an updatedAt bump) recomputes to identical values, so `on`
    // does not re-fire and a manual collapse survives the update (P1 finding 1).
    const source = fs.readFileSync(SIDEBAR_FILE, "utf-8")
    expect(source).toContain("[() => session.currentSessionID(), activeTopic]")
  })

  it("removed the dead presentation-only Topic filter", () => {
    const source = fs.readFileSync(SIDEBAR_FILE, "utf-8")
    expect(source).not.toContain("filterQuery")
    expect(source).not.toContain("filterTopics")
    const topics = fs.readFileSync(TOPICS_FILE, "utf-8")
    expect(topics).not.toContain("filterTopics")
  })

  it("Topic disclosure aria labels are localized", () => {
    const source = fs.readFileSync(SIDEBAR_FILE, "utf-8")
    expect(source).toContain('lang.t("agentManager.topic.collapse")')
    expect(source).toContain('lang.t("agentManager.topic.expand")')
  })

  it("Topic selection routes through the existing openSession transaction", () => {
    // The sidebar only calls props.onSelectSession; the app wires that to the
    // canonical openSession transaction — no bypass, no new message type.
    const source = fs.readFileSync(SIDEBAR_FILE, "utf-8")
    expect(source).toContain("props.onSelectSession(")
    expect(source).not.toContain("postMessage")
    const app = fs.readFileSync(AGENT_MANAGER_APP_FILE, "utf-8")
    // Whitespace-insensitive: collapse whitespace runs so formatter-driven
    // indentation changes cannot break the wiring assertion.
    const compact = app.replace(/\s+/g, " ")
    expect(compact).toContain("onSelectSession={(id) => { handleOpenSession(id)")
  })

  it("topic derivation is pure — no mutation, no persistence, no message sends", () => {
    const source = fs.readFileSync(TOPICS_FILE, "utf-8")
    expect(source).not.toContain("postMessage")
    expect(source).not.toContain("localStorage")
    expect(source).not.toContain("vscode")
    expect(source).toContain("export function deriveTopics")
  })

  it("AgentManagerApp still uses SidebarSessionList unchanged as the sidebar", () => {
    const app = fs.readFileSync(AGENT_MANAGER_APP_FILE, "utf-8")
    expect(app).toContain("<SidebarSessionList")
  })
})

describe("Agent Manager — Gate C in-flight preservation and bottom-page derivation", () => {
  const app = fs.readFileSync(AGENT_MANAGER_APP_FILE, "utf-8")
  it("tracks recentRealIds from sessionCreated and consumes on catalog inclusion", () => {
    expect(app).toContain("recentRealIds")
    expect(app).toContain("recentRealIds.add(created.session.id)")
    expect(app).toContain("for (const id of [...recentRealIds]) if (latestCatalog.has(id)) recentRealIds.delete(id)")
    expect(app).toContain("recentRealIds.delete(sid)")
  })
  it("passes combined preserve (catalogPreserve + recentRealIds) to reconcile", () => {
    expect(app).toContain("combinedPreserve")
    expect(app).toContain("preserveSessionIds: combinedPreserve")
  })
  it("reconciliation needsPending does not gate bottom page (visible pending)", () => {
    // pending created by reconciliation must be visible, not gated hidden
    const block = app.slice(app.indexOf("if (out.needsPending)"), app.indexOf("if (out.needsPending)") + 600)
    expect(block).toContain("setIsBottomPage(false)")
    expect(block).not.toContain("setIsBottomPage(true)")
  })
  it("reconciliation final invariant derives bottom-page from real content only", () => {
    expect(app).toContain("if (isBottomPage())")
    expect(app).toContain("shouldClearBottomPage(")
    expect(app).toContain("terms.current().length")
    expect(app).not.toContain("if (finalIds.length > 0) setIsBottomPage(false)")
  })
  it("does not synthesize sessionsLoaded/sessionCreated/sessionAdded/title", () => {
    // Only real events may change state — no synthetic injections
    expect(app).not.toContain('postMessage({ type: "sessionsLoaded"')
    expect(app).not.toContain('postMessage({ type: "sessionCreated"')
    expect(app).not.toContain('postMessage({ type: "agentManager.sessionAdded"')
    expect(app).not.toContain("synthetic")
  })
  it("provider reconcile preserves recentSessions until catalog includes", () => {
    const provider = fs.readFileSync(PROVIDER_FILE, "utf-8")
    expect(provider).toContain("recentSessions")
    expect(provider).toContain("recentSessions.add(m.sessionId)")
    expect(provider).toContain("recentSessions.delete")
    expect(provider).toContain("effective")
    expect(provider).toContain("new Set([...catalog, ...this.recentSessions])")
  })
})
