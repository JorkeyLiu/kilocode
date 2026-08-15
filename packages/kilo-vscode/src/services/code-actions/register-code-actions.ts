import * as vscode from "vscode"
import { getEditorContext } from "./editor-utils"
import { createPrompt } from "./support-prompt"
import type { ChatTarget, ChatTargetResolver } from "./chat-target"
export type { ChatTarget, ChatTargetResolver } from "./chat-target"

export function registerCodeActions(context: vscode.ExtensionContext, resolveTarget: ChatTargetResolver): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("kilo-code.new.explainCode", async () => {
      const ctx = getEditorContext()
      if (!ctx) return
      const prompt = createPrompt("EXPLAIN", {
        filePath: ctx.filePath,
        startLine: String(ctx.startLine),
        endLine: String(ctx.endLine),
        selectedText: ctx.selectedText,
        userInput: "",
      })
      const view = await resolveTarget()
      if (!view) return
      view.postMessage({ type: "triggerTask", text: prompt })
    }),

    vscode.commands.registerCommand("kilo-code.new.fixCode", async () => {
      const ctx = getEditorContext()
      if (!ctx) return
      const prompt = createPrompt("FIX", {
        filePath: ctx.filePath,
        startLine: String(ctx.startLine),
        endLine: String(ctx.endLine),
        selectedText: ctx.selectedText,
        diagnostics: ctx.diagnostics,
        userInput: "",
      })
      const view = await resolveTarget()
      if (!view) return
      view.postMessage({ type: "triggerTask", text: prompt })
    }),

    vscode.commands.registerCommand("kilo-code.new.improveCode", async () => {
      const ctx = getEditorContext()
      if (!ctx) return
      const prompt = createPrompt("IMPROVE", {
        filePath: ctx.filePath,
        startLine: String(ctx.startLine),
        endLine: String(ctx.endLine),
        selectedText: ctx.selectedText,
        userInput: "",
      })
      const view = await resolveTarget()
      if (!view) return
      view.postMessage({ type: "triggerTask", text: prompt })
    }),

    vscode.commands.registerCommand("kilo-code.new.addToContext", async () => {
      const ctx = getEditorContext()
      if (!ctx) return
      const prompt = createPrompt("ADD_TO_CONTEXT", {
        filePath: ctx.filePath,
        startLine: String(ctx.startLine),
        endLine: String(ctx.endLine),
        selectedText: ctx.selectedText,
      })
      const view = await resolveTarget()
      if (!view) return
      view.postMessage({ type: "appendChatBoxMessage", text: prompt })
    }),

    vscode.commands.registerCommand("kilo-code.new.focusChatInput", async () => {
      const view = await resolveTarget()
      if (!view) return
      view.postMessage({ type: "action", action: "focusInput" })
    }),

    // Command Palette only — no keybinding. A keybinding would need to
    // route through VS Code's keybinding-to-focused-webview forwarding,
    // which doesn't reliably reach a webview whose own input already has
    // focus; invoking straight from the palette sidesteps that path
    // entirely, the same way terminalAddToContext etc. do. Toggles: the
    // webview closes the search bar itself if it's already open.
    vscode.commands.registerCommand("kilo-code.new.toggleChatSearch", async () => {
      const view = await resolveTarget()
      if (!view) return
      view.postMessage({ type: "action", action: "focusSearch" })
    }),
  )
}
