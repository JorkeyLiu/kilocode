import * as vscode from "vscode"
import type { KiloConnectionService } from "../cli-backend"
import { attemptMcpAddPrivate, buildMcpAddReq, mcpAddFailureMessage } from "../../kilo-provider/mcp-add-privatefirst"
import { attemptMcpDisconnectPrivate, buildMcpDisconnectReq } from "../../kilo-provider/mcp-connection-privatefirst"

type BrowserAutomationState = "disabled" | "registering" | "connected" | "failed" | "disconnected"

export class BrowserAutomationService implements vscode.Disposable {
  private state: BrowserAutomationState = "disabled"
  private disposables: vscode.Disposable[] = []

  // MCP server name used when registering with the CLI backend
  private static readonly MCP_SERVER_NAME = "kilo-playwright"

  constructor(private readonly connectionService: KiloConnectionService) {
    // Listen for settings changes
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("kilo-code.new.browserAutomation")) {
          this.syncWithSettings()
        }
      }),
    )
  }

  /**
   * Read settings and enable/disable accordingly.
   * Called on construction and when settings change.
   */
  async syncWithSettings(): Promise<void> {
    const config = vscode.workspace.getConfiguration("kilo-code.new.browserAutomation")
    const enabled = config.get<boolean>("enabled", false)

    if (enabled) {
      await this.register()
    } else {
      await this.unregister()
    }
  }

  /**
   * Re-register the MCP server after CLI backend reconnects.
   * Should be called from the connection state change handler.
   */
  async reregisterIfEnabled(): Promise<void> {
    const config = vscode.workspace.getConfiguration("kilo-code.new.browserAutomation")
    const enabled = config.get<boolean>("enabled", false)
    if (enabled) {
      await this.register()
    }
  }

  /**
   * Register the Playwright MCP server with the CLI backend.
   * Private-only: at most one private `mcp/add` call per registration with
   * zero SDK fallback and zero retry. The returned status map is the sole
   * convergence source for the automation state.
   */
  private async register(): Promise<void> {
    this.setState("registering")

    const config = vscode.workspace.getConfiguration("kilo-code.new.browserAutomation")
    const useSystemChrome = config.get<boolean>("useSystemChrome", true)
    const headless = config.get<boolean>("headless", false)

    // Build the command for the Playwright MCP server
    const command = ["npx", "@playwright/mcp@latest"]
    if (headless) {
      command.push("--headless")
    }
    if (useSystemChrome) {
      command.push("--browser", "chrome")
    }

    try {
      const directory = this.getWorkspaceDirectory()
      const req = buildMcpAddReq(directory, BrowserAutomationService.MCP_SERVER_NAME, {
        type: "local",
        command,
        enabled: true,
        timeout: 60000,
      })
      const attempt = await attemptMcpAddPrivate(this.connectionService, req)
      if (attempt.kind !== "ok") {
        const detail = attempt.kind === "failed" ? attempt.code : attempt.reason
        console.error(
          `[Kilo New] BrowserAutomationService: Failed to register MCP server "${BrowserAutomationService.MCP_SERVER_NAME}": ${mcpAddFailureMessage(detail)} (${detail})`,
        )
        this.setState("failed")
        return
      }

      const serverStatus = attempt.status[BrowserAutomationService.MCP_SERVER_NAME]
      if (serverStatus?.status === "connected") {
        this.setState("connected")
      } else if (serverStatus?.status === "failed") {
        console.error(
          "[Kilo New] BrowserAutomationService: MCP server failed:",
          (serverStatus as { error?: string }).error,
        )
        this.setState("failed")
      } else {
        this.setState("disconnected")
      }
    } catch (error) {
      console.error("[Kilo New] BrowserAutomationService: Failed to register MCP server:", error)
      this.setState("failed")
    }
  }

  /**
   * Unregister/disconnect the Playwright MCP server.
   */
  private async unregister(): Promise<void> {
    if (this.state === "disabled") {
      return
    }

    try {
      const directory = this.getWorkspaceDirectory()
      const req = buildMcpDisconnectReq(directory, BrowserAutomationService.MCP_SERVER_NAME)
      const outcome = await attemptMcpDisconnectPrivate(this.connectionService, req)
      if (outcome.kind !== "ok") {
        const detail = outcome.kind === "failed" ? outcome.code : outcome.reason
        console.error(
          `[Kilo New] BrowserAutomationService: Failed to disconnect MCP server "${BrowserAutomationService.MCP_SERVER_NAME}": ${detail}`,
        )
      }
    } catch (error) {
      console.error("[Kilo New] BrowserAutomationService: Failed to disconnect MCP server:", error)
    }

    this.setState("disabled")
  }

  private getWorkspaceDirectory(): string {
    const folders = vscode.workspace.workspaceFolders
    if (folders && folders.length > 0) {
      return folders[0].uri.fsPath
    }
    return process.cwd()
  }

  private setState(state: BrowserAutomationState): void {
    if (this.state === state) {
      return
    }
    console.log(`[Kilo New] BrowserAutomationService: State ${this.state} → ${state}`)
    this.state = state
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose()
    }
    this.disposables = []
  }
}
