/**
 * VS Code adapter implementing the Host interface.
 *
 * This file is on the architecture test allowlist — it is one of the few
 * agent-manager files permitted to import "vscode".
 */

import * as vscode from "vscode"
import type { Host, PanelContext, OutputHandle, SessionProvider, Disposable, Store } from "./host"
import type { KiloConnectionService } from "../services/cli-backend"
import { KiloProvider } from "../KiloProvider"
import { agentOptions } from "./agent-options"
import type { KiloProviderOptions } from "../kilo-provider/options"
import { buildWebviewHtml } from "../utils"
import { isP0PerfEnabled } from "../perf/perf-instrument"
import { openFileInEditor, getWorkspaceRoot } from "../review-utils"
import { TelemetryProxy, type TelemetryEventName } from "../services/telemetry"
import type { AutoApproveController } from "../commands/toggle-auto-approve"
import type { RemoteStatusService } from "../services/RemoteStatusService"
import type { CanonicalConfigService } from "../config/service"
import type { PrivateSessionReader, PrivateSessionList } from "../kilo-provider/options"

export class VscodeHost implements Host {
  private autoApprove: AutoApproveController | undefined
  private amPanel: vscode.WebviewPanel | undefined
  private amProvider: KiloProvider | undefined
  private amStreams: vscode.Disposable | undefined
  private amContext: PanelContext | undefined
  private amCloseSub: vscode.Disposable | undefined
  private amOnBeforeMessage:
    | ((msg: Record<string, unknown>) => Promise<Record<string, unknown> | null>)
    | undefined

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly connectionService: KiloConnectionService,
    private readonly context: vscode.ExtensionContext,
    private readonly remoteService: RemoteStatusService,
    private readonly canonicalConfig: CanonicalConfigService,
    private readonly privateSessionReader?: PrivateSessionReader | null,
  ) {}

  setAutoApproveController(ctrl: AutoApproveController): void {
    this.autoApprove = ctrl
  }

  /** Test-observable handoff: exact options wirePanel passes to KiloProvider. */
  providerOpts(): KiloProviderOptions {
    return agentOptions(this.canonicalConfig, this.privateSessionReader ?? null)
  }

  openPanel(opts: {
    onBeforeMessage: (msg: Record<string, unknown>) => Promise<Record<string, unknown> | null>
  }): PanelContext {
    const panel = vscode.window.createWebviewPanel(
      "kilo-code.new.AgentManagerPanel",
      "Agent Manager",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri],
      },
    )
    return this.wirePanel(panel, opts)
  }

  /** Wrap an existing vscode.WebviewPanel (e.g. deserialized on restart). */
  wrapExistingPanel(
    panel: vscode.WebviewPanel,
    opts: {
      onBeforeMessage: (msg: Record<string, unknown>) => Promise<Record<string, unknown> | null>
    },
  ): PanelContext {
    return this.wirePanel(panel, opts)
  }

  /**
   * Host-owned cleanup for the current Agent Manager panel. Disposes the host's
   * view-state stream exactly once and clears host refs. Does not dispose the
   * provider — sessions disposal is owned by AgentManagerProvider's
   * panel.onDidDispose callback via ctx.sessions.dispose(). Idempotent and
   * scoped to the exact closing panel.
   */
  private clearAgentManagerPanel(closing: vscode.WebviewPanel): void {
    if (this.amPanel !== closing) return
    if (this.amStreams) {
      try {
        this.amStreams.dispose()
      } catch (err) {
        console.warn("[Kilo New] VscodeHost: dispose stream failed")
        void err
      }
      this.amStreams = undefined
    }
    if (this.amCloseSub) {
      const sub = this.amCloseSub
      this.amCloseSub = undefined
      try {
        sub.dispose()
      } catch (err) {
        console.warn("[Kilo New] VscodeHost: dispose close subscription failed")
        void err
      }
    }
    this.amPanel = undefined
    this.amProvider = undefined
    this.amContext = undefined
    this.amOnBeforeMessage = undefined
  }

  /**
   * Fixture-only: targeted reload preserving same outer PanelContext, inner KiloProvider,
   * streams and listeners. Only production HTML is reassigned and the next real
   * webviewReady drives normal sync/hydration. No dispose/recreate/rebind.
   * Rejects if no current live panel/context/provider or the panel is considered disposed.
   */
  async reloadAgentManagerPanelForFixture(): Promise<PanelContext> {
    const panel = this.amPanel
    const provider = this.amProvider
    const ctx = this.amContext
    if (!panel || !provider || !ctx) throw new Error("VscodeHost: no Agent Manager panel to reload")
    // Panel considered disposed when host has already cleared it or the
    // provider is disposed. Stale refs must not be targeted.
    const anyPanel = panel as unknown as { _disposed?: boolean; disposed?: boolean }
    const anyProv = provider as unknown as { disposed?: boolean }
    if (anyPanel._disposed || anyPanel.disposed || anyProv.disposed) {
      throw new Error("VscodeHost: Agent Manager panel is disposed")
    }
    const anyProvider = provider as unknown as {
      reloadWebviewForFixture?: (assign: () => void) => Promise<void>
    }
    if (!anyProvider.reloadWebviewForFixture) throw new Error("VscodeHost: Host does not support AM reload")
    await anyProvider.reloadWebviewForFixture(() => this.assignAgentManagerHtml(panel))
    // Verify still alive after await (panel/provider could have been disposed while waiting)
    if (this.amPanel !== panel || this.amProvider !== provider || this.amContext !== ctx) {
      throw new Error("webview reload aborted")
    }
    if (anyProv.disposed || anyPanel._disposed || anyPanel.disposed) throw new Error("webview reload aborted")
    return ctx
  }

  private assignAgentManagerHtml(panel: vscode.WebviewPanel): void {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    }
    panel.iconPath = {
      light: vscode.Uri.joinPath(this.extensionUri, "assets", "icons", "kilo-light.svg"),
      dark: vscode.Uri.joinPath(this.extensionUri, "assets", "icons", "kilo-dark.svg"),
    }
    const port = this.connectionService.getServerInfo()?.port
    panel.webview.html = buildWebviewHtml(panel.webview, {
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "agent-manager.js")),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "agent-manager.css")),
      iconsBaseUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "assets", "icons")),
      workerUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "shiki-worker.js")),
      title: "Agent Manager",
      port,
      perfEnabled: isP0PerfEnabled(),
    })
  }

  private buildPanelContext(
    panel: vscode.WebviewPanel,
    provider: KiloProvider,
    streams: vscode.Disposable,
  ): PanelContext {
    const sessions: SessionProvider = {
      getSessionDirectories: () => provider.getSessionDirectories(),
      trackSession: (id) => provider.trackSession(id),
      refreshSessions: () => provider.refreshSessions(),
      waitForCatalogSettled: (opts) => provider.waitForCatalogSettled(opts),
      registerSession: (s) => provider.registerSession(s),
      recoverPendingPrompts: () => provider.recoverPendingPrompts(),
      onFollowupAdopted: (cb) => provider.onFollowupAdopted(cb),
      acknowledgeDraft: (draftID, sessionID) => provider.acknowledgeDraft(draftID, sessionID),
      abortSessions: (ids) => provider.abortSessions(ids),
      dispose: () => provider.dispose(),
      onCatalog: (cb) => provider.onCatalog(cb),
    }
    // Capture host for reuse in dispose path
    const host = this
    let disposed = false
    return {
      get active() {
        return panel.active
      },
      get visible() {
        return panel.visible
      },
      postMessage(msg) {
        void panel.webview.postMessage(msg)
      },
      waitForReady() {
        return provider.waitForReady()
      },
      waitForActive() {
        if (panel.active) return Promise.resolve()
        return new Promise((resolve) => {
          const sub = panel.onDidChangeViewState((e) => {
            if (!e.webviewPanel.active) return
            sub.dispose()
            resolve()
          })
        })
      },
      reveal(preserveFocus) {
        panel.reveal(vscode.ViewColumn.One, preserveFocus ?? false)
      },
      sessions,
      onDidChangeVisibility(cb) {
        return panel.onDidChangeViewState((e) => cb(e.webviewPanel.visible))
      },
      onDidDispose(cb) {
        return panel.onDidDispose(cb)
      },
      dispose() {
        if (disposed) return
        disposed = true
        // Reuse host-owned clear for streams/refs exactly once; provider disposal
        // is owned by AgentManagerProvider's panel.onDidDispose -> ctx.sessions.dispose().
        // This path may be called for explicit context.dispose() or replacement;
        // clearing here ensures streams not double-disposed when the panel's
        // onDidDispose fires after panel.dispose().
        if (host.amPanel === panel) host.clearAgentManagerPanel(panel)
        else {
          // Fallback if host already cleared (idempotent)
          try {
            streams.dispose()
          } catch (err) {
            console.warn("[Kilo New] VscodeHost: dispose stream fallback failed")
            void err
          }
        }
        try {
          panel.dispose()
        } catch (err) {
          console.warn("[Kilo New] VscodeHost: dispose panel failed")
          void err
        }
      },
    }
  }

  private wirePanel(
    panel: vscode.WebviewPanel,
    opts: {
      onBeforeMessage: (msg: Record<string, unknown>) => Promise<Record<string, unknown> | null>
    },
  ): PanelContext {
    this.assignAgentManagerHtml(panel)
    const provider = new KiloProvider(this.extensionUri, this.connectionService, this.context, this.providerOpts())
    provider.setRemoteService(this.remoteService)
    provider.attachToWebview(panel.webview, {
      onBeforeMessage: opts.onBeforeMessage,
    })
    provider.setStreamVisibility(panel.active && panel.visible)
    const streams = panel.onDidChangeViewState((event) =>
      provider.setStreamVisibility(event.webviewPanel.active && event.webviewPanel.visible),
    )
    if (this.autoApprove) provider.setAutoApproveController(this.autoApprove)
    // Clear any previous host subscription before overwriting (defensive)
    if (this.amCloseSub) {
      try {
        this.amCloseSub.dispose()
      } catch (err) {
        console.warn("[Kilo New] VscodeHost: dispose previous close sub failed")
        void err
      }
      this.amCloseSub = undefined
    }
    this.amPanel = panel
    this.amProvider = provider
    this.amStreams = streams
    this.amOnBeforeMessage = opts.onBeforeMessage
    const ctx = this.buildPanelContext(panel, provider, streams)
    this.amContext = ctx
    this.amCloseSub = panel.onDidDispose(() => this.clearAgentManagerPanel(panel))
    return ctx
  }

  workspacePath(): string | undefined {
    return getWorkspaceRoot()
  }

  /** Per-workspace durable store backed by VS Code workspaceState. */
  get workspaceStore(): Store {
    return this.context.workspaceState
  }

  showError(msg: string): void {
    void vscode.window.showErrorMessage(msg)
  }

  openFile(path: string, line?: number, column?: number): void {
    openFileInEditor(path, line, column, vscode.ViewColumn.Active, "AgentManagerProvider")
  }

  createOutput(name: string): OutputHandle {
    const channel = vscode.window.createOutputChannel(name)
    return {
      appendLine: (msg) => channel.appendLine(msg),
      dispose: () => channel.dispose(),
    }
  }

  extensionKeybindings(): Array<{ command: string; key?: string; mac?: string }> {
    const ext = vscode.extensions.getExtension("kilocode.kilo-code")
    return ext?.packageJSON?.contributes?.keybindings ?? []
  }

  serverPort(): number | undefined {
    return this.connectionService.getServerInfo()?.port
  }

  copyToClipboard(text: string): void {
    void vscode.env.clipboard.writeText(text)
  }

  capture(event: string, properties?: Record<string, unknown>): void {
    TelemetryProxy.capture(event as TelemetryEventName, properties)
  }

  openExternal(url: string): void {
    void vscode.env.openExternal(vscode.Uri.parse(url))
  }

  dispose(): void {}
}
