import { afterEach, describe, expect, it } from "bun:test"
import * as vscode from "vscode"
import { registerCodeActions } from "../../src/services/code-actions/register-code-actions"
import type { ChatTarget } from "../../src/services/code-actions/register-code-actions"

type Command = (...args: unknown[]) => unknown

type Api = typeof vscode & {
  commands: {
    registerCommand: (command: string, callback: Command) => { dispose(): void }
  }
  languages: {
    getDiagnostics: () => Array<{ range: { intersection: () => unknown } }>
  }
  window: typeof vscode.window & { activeTextEditor?: unknown }
}

const api = vscode as Api
const original = {
  register: api.commands.registerCommand,
  editor: api.window.activeTextEditor,
  diagnostics: api.languages.getDiagnostics,
}

type Resolution = "agent" | "none"

function setup(target: Resolution, agentReady = true) {
  const commands = new Map<string, Command>()
  const posts: unknown[] = []
  const context = { subscriptions: [] as Array<{ dispose(): void }> } as vscode.ExtensionContext
  const agent: ChatTarget = {
    postMessage: (msg: unknown) => {
      posts.push(msg)
    },
  }
  const resolveTarget = async (): Promise<ChatTarget | undefined> => {
    if (target === "agent" && agentReady) return agent
    return undefined
  }

  api.commands.registerCommand = (command, callback) => {
    commands.set(command, callback)
    return { dispose: () => undefined }
  }
  api.languages.getDiagnostics = () => []
  api.window.activeTextEditor = {
    selection: {
      isEmpty: false,
      start: { line: 2 },
      end: { line: 4 },
    },
    document: {
      uri: vscode.Uri.file("/repo/src/file.ts"),
      getText: () => "const value = 1",
    },
  }

  registerCodeActions(context, resolveTarget)

  return { commands, posts }
}

afterEach(() => {
  api.commands.registerCommand = original.register
  api.window.activeTextEditor = original.editor
  api.languages.getDiagnostics = original.diagnostics
})

describe("registerCodeActions", () => {
  it("adds selected code to the resolved chat target", async () => {
    const state = setup("agent")

    await state.commands.get("kilo-code.new.addToContext")?.()

    expect(state.posts).toEqual([
      {
        type: "appendChatBoxMessage",
        text: "src/file.ts:3-5\n```\nconst value = 1\n```",
      },
    ])
  })

  it("routes explain/fix/improve prompts to the resolved target", async () => {
    const state = setup("agent")

    await state.commands.get("kilo-code.new.explainCode")?.()
    await state.commands.get("kilo-code.new.fixCode")?.()
    await state.commands.get("kilo-code.new.improveCode")?.()

    expect(state.posts.map((p) => (p as { type: string }).type)).toEqual(["triggerTask", "triggerTask", "triggerTask"])
  })

  it("does not post when no chat target could be resolved", async () => {
    const state = setup("none")

    await state.commands.get("kilo-code.new.addToContext")?.()

    expect(state.posts).toEqual([])
  })

  it("does not post to an agent manager whose readiness wait is cancelled", async () => {
    const state = setup("agent", false)

    await state.commands.get("kilo-code.new.addToContext")?.()

    expect(state.posts).toEqual([])
  })

  it("toggles chat search on the resolved target", async () => {
    const state = setup("agent")

    await state.commands.get("kilo-code.new.toggleChatSearch")?.()

    expect(state.posts).toEqual([{ type: "action", action: "focusSearch" }])
  })

  it("focuses chat input on the resolved target", async () => {
    const state = setup("agent")

    await state.commands.get("kilo-code.new.focusChatInput")?.()

    expect(state.posts).toEqual([{ type: "action", action: "focusInput" }])
  })
})
