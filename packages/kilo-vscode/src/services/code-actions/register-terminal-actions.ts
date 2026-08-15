import * as vscode from "vscode"
import { createPrompt } from "./support-prompt"
import { getTerminalContents } from "../terminal/context"
import type { ChatTargetResolver } from "./register-code-actions"

export function registerTerminalActions(context: vscode.ExtensionContext, resolveTarget: ChatTargetResolver): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("kilo-code.new.terminalAddToContext", async (args: any) => {
      let content = args?.selection as string | undefined
      if (!content) {
        content = (await getTerminalContents(-1)).content
      }
      if (!content) {
        vscode.window.showInformationMessage("No terminal content available. Select text in the terminal first.")
        return
      }
      const prompt = createPrompt("TERMINAL_ADD_TO_CONTEXT", {
        terminalContent: content,
        userInput: "",
      })
      const view = await resolveTarget()
      if (!view) return
      view.postMessage({ type: "appendChatBoxMessage", text: prompt })
      view.postMessage({ type: "action", action: "focusInput" })
    }),

    vscode.commands.registerCommand("kilo-code.new.terminalFixCommand", async (args: any) => {
      let content = args?.selection as string | undefined
      if (!content) {
        content = (await getTerminalContents(1)).content
      }
      if (!content) {
        vscode.window.showInformationMessage("No terminal content available. Select text in the terminal first.")
        return
      }
      const prompt = createPrompt("TERMINAL_FIX", {
        terminalContent: content,
        userInput: "",
      })
      const view = await resolveTarget()
      if (!view) return
      view.postMessage({ type: "triggerTask", text: prompt })
    }),

    vscode.commands.registerCommand("kilo-code.new.terminalExplainCommand", async (args: any) => {
      let content = args?.selection as string | undefined
      if (!content) {
        content = (await getTerminalContents(1)).content
      }
      if (!content) {
        vscode.window.showInformationMessage("No terminal content available. Select text in the terminal first.")
        return
      }
      const prompt = createPrompt("TERMINAL_EXPLAIN", {
        terminalContent: content,
        userInput: "",
      })
      const view = await resolveTarget()
      if (!view) return
      view.postMessage({ type: "triggerTask", text: prompt })
    }),
  )
}
