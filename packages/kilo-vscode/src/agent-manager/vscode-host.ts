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
import { PLATFORM, SNAPSHOT_INITIALIZATION } from "./constants"
import { buildWebviewHtml } from "../utils"
import { isP0PerfEnabled } from "../perf/perf-instrument"
import { openFileInEditor, getWorkspaceRoot } from "../review-utils"
import { TelemetryProxy, type TelemetryEventName } from "../services/telemetry"
import type { AutoApproveController } from "../commands/toggle-auto-approve"
import type { RemoteStatusService } from "../services/RemoteStatusService"

export class VscodeHost implements Host {
  private autoApprove: AutoApproveController | undefined

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly connectionService: KiloConnectionService,
    private readonly context: vscode.ExtensionContext,
    private readonly remoteService: RemoteStatusService,
  ) {}

  setAutoApproveController(ctrl: AutoApproveController): void {
    this.autoApprove = ctrl
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

  private wirePanel(
    panel: vscode.WebviewPanel,
    opts: {
      onBeforeMessage: (msg: Record<string, unknown>) => Promise<Record<string, unknown> | null>
    },
  ): PanelContext {
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
      // P0 benchmark webview timing (opt-in KILO_P0_PERF only, same as the
      // editor-tab webview's HTML — the Agent Manager panel must also set
      // window.__KILO_P0_PERF__ so its load/render/paint/mount stages stream).
      perfEnabled: isP0PerfEnabled(),
    })

    const provider = new KiloProvider(this.extensionUri, this.connectionService, this.context, {
      platform: PLATFORM,
      snapshotInitialization: SNAPSHOT_INITIALIZATION,
      slimEditMetadata: true,
      disableViewedRegistration: true,
    })
    provider.setRemoteService(this.remoteService)
    provider.attachToWebview(panel.webview, {
      onBeforeMessage: opts.onBeforeMessage,
    })
    provider.setStreamVisibility(panel.active && panel.visible)
    const streams = panel.onDidChangeViewState((event) =>
      provider.setStreamVisibility(event.webviewPanel.active && event.webviewPanel.visible),
    )
    if (this.autoApprove) provider.setAutoApproveController(this.autoApprove)

    const sessions: SessionProvider = {
      getSessionDirectories: () => provider.getSessionDirectories(),
      getSessionInfo: (id) => provider.getSessionInfo(id),
      trackSession: (id) => provider.trackSession(id),
      refreshSessions: () => provider.refreshSessions(),
      registerSession: (s) => provider.registerSession(s),
      recoverPendingPrompts: () => provider.recoverPendingPrompts(),
      onFollowupAdopted: (cb) => provider.onFollowupAdopted(cb),
      acknowledgeDraft: (draftID, sessionID) => provider.acknowledgeDraft(draftID, sessionID),
      abortSessions: (ids) => provider.abortSessions(ids),
      showMemory: (id) => provider.showMemory(id),
      toggleMemory: (id) => provider.toggleMemory(id),
      dispose: () => provider.dispose(),
    }

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
        streams.dispose()
        provider.dispose()
        panel.dispose()
      },
    }
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
