import * as vscode from "vscode"
import type { KiloClient } from "@kilocode/sdk/v2/client"
import { t } from "./cli-backend/i18n"
import { fetchRemoteStatusPrivateFirst } from "../kilo-provider/remote-status-privatefirst"
import type { RemoteStatusPrivateConnection } from "../kilo-provider/remote-status-privatefirst"
import { fetchRemoteTogglePrivateFirst } from "../kilo-provider/remote-toggle-privatefirst"
import type { RemoteTogglePrivateConnection } from "../kilo-provider/remote-toggle-privatefirst"

export type RemoteState = { enabled: boolean; connected: boolean }

type Listener = (state: RemoteState) => void

type RemotePrivateConnection = RemoteStatusPrivateConnection & RemoteTogglePrivateConnection

/**
 * Singleton service that owns all remote-control state and the VS Code status bar item.
 * Replaces the per-webview polling in RemoteIndicator.tsx and ExperimentalTab.tsx
 * with a push-based model: one status bar item, zero recurring cost for non-remote users.
 *
 * `remote/status` reads and `remote/enable|disable` writes are private-first
 * (same process-global `KiloSessions` authority as the HTTP routes;
 * directory/workspace are routing-only, payload booleans stay
 * process-global): one private attempt plus at most one same-identity SDK
 * fallback per action, never retried. SSE `remote-status-changed` remains the
 * subsequent transition authority.
 */
export class RemoteStatusService implements vscode.Disposable {
  private state: RemoteState = { enabled: false, connected: false }
  private bar: vscode.StatusBarItem
  private listeners = new Set<Listener>()
  private client: KiloClient | null = null
  private privConn: RemotePrivateConnection | null = null

  constructor() {
    this.bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99)
    this.bar.command = "kilo-code.new.toggleRemote"
    this.sync()
  }

  setClient(c: KiloClient | null): void {
    this.client = c
  }

  /**
   * Attach the private `remote/status` + `remote/enable|disable` boundary. Null detaches (SDK-only).
   */
  setPrivateConnection(c: RemotePrivateConnection | null): void {
    this.privConn = c
  }

  /** Get current state synchronously. */
  getState(): RemoteState {
    return this.state
  }

  updateFromEvent(state: RemoteState): void {
    this.update(state)
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  onChange(cb: Listener): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  clearState(): void {
    this.update({ enabled: false, connected: false })
  }

  /** One-shot status fetch — broadcasts via onChange if state changed. */
  async refresh(): Promise<void> {
    if (!this.client) return
    const dir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    const out = await fetchRemoteStatusPrivateFirst({
      connection: this.privConn,
      client: this.client as never,
      directory: dir,
    })
    if (out.kind === "ok") {
      this.update(out.state)
      return
    }
    if (out.kind === "terminal") {
      console.warn("[Kilo] remote status refresh failed:", { op: "remote/status", terminal: true, code: out.code })
      return
    }
    console.warn("[Kilo] remote status refresh failed:", out.cause ?? { op: "remote/status" })
  }

  /** Toggle remote on/off based on current state. */
  async toggle(): Promise<void> {
    if (!this.client) return
    const dir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    const out = await fetchRemoteStatusPrivateFirst({
      connection: this.privConn,
      client: this.client as never,
      directory: dir,
    })
    if (out.kind === "ok") {
      await this.setEnabled(!out.state.enabled)
      return
    }
    if (out.kind === "terminal") throw new Error(`remote status unavailable: ${out.code ?? "terminal"}`)
    throw out.cause instanceof Error ? out.cause : new Error("remote status unavailable")
  }

  /** Enable or disable remote. State updates are pushed via events. */
  async setEnabled(enabled: boolean): Promise<void> {
    if (!this.client) return
    const dir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    const out = await fetchRemoteTogglePrivateFirst({
      connection: this.privConn,
      client: this.client as never,
      directory: dir,
      action: enabled ? "enable" : "disable",
    })
    if (out.kind === "ok") {
      this.update(out.state)
      return
    }
    if (out.kind === "terminal") throw new Error(`remote ${enabled ? "enable" : "disable"} failed: ${out.code ?? "terminal"}`)
    throw out.cause instanceof Error ? out.cause : new Error(`remote ${enabled ? "enable" : "disable"} unavailable`)
  }

  /**
   * Handle a remote-related webview message.
   * Returns a response message to post back to the webview, or null.
   */
  async handleMessage(type: string, enabled?: boolean): Promise<RemoteState | null> {
    switch (type) {
      case "toggleRemote":
        await this.toggle()
        return null
      case "setRemoteEnabled":
        if (enabled === undefined) return null
        await this.setEnabled(enabled)
        return null
      case "requestRemoteStatus":
        void this.refresh()
        return this.state
    }
    return null
  }

  dispose(): void {
    this.listeners.clear()
    this.privConn = null
    this.bar.dispose()
  }

  // -- internal ---------------------------------------------------------------

  private update(next: RemoteState): void {
    if (this.state.enabled === next.enabled && this.state.connected === next.connected) return
    this.state = next
    this.sync()
    for (const cb of this.listeners) cb(next)
  }

  /** Sync status bar appearance to current state. */
  private sync(): void {
    if (!this.state.enabled) {
      this.bar.hide()
      return
    }
    if (this.state.connected) {
      this.bar.text = "$(radio-tower) Kilo Remote"
      this.bar.tooltip = t("remote.connected")
      this.bar.color = new vscode.ThemeColor("testing.iconPassed")
    } else {
      this.bar.text = "$(radio-tower) Kilo Remote …"
      this.bar.tooltip = t("remote.connecting")
      this.bar.color = new vscode.ThemeColor("editorWarning.foreground")
    }
    this.bar.show()
  }
}
