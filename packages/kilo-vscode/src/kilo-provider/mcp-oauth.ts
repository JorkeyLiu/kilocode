import * as vscode from "vscode"

let lastMcpBrowserOpen: { url: string; at: number } | null = null

/** Dedupe when several webviews receive the same `mcp.browser.open.failed` SSE. */
export function openMcpOAuthUrlOnce(url: string): void {
  const now = Date.now()
  if (lastMcpBrowserOpen && lastMcpBrowserOpen.url === url && now - lastMcpBrowserOpen.at < 4000) return
  lastMcpBrowserOpen = { url, at: now }
  void vscode.env.openExternal(vscode.Uri.parse(url)).then(
    (opened) => {
      if (opened) return
      void vscode.window.showErrorMessage(
        "MCP sign-in failed to open the browser. Check the Kilo logs for the authentication URL.",
      )
    },
    (error) => {
      console.error("[Kilo New] Failed to open MCP OAuth URL:", error)
      void vscode.window.showErrorMessage(
        "MCP sign-in failed to open the browser. Check the Kilo logs for the authentication URL.",
      )
    },
  )
}
