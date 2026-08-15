import { afterEach, describe, expect, it } from "bun:test"
import * as vscode from "vscode"
import { registerTerminalActions } from "../../src/services/code-actions/register-terminal-actions"
import type { ChatTarget } from "../../src/services/code-actions/register-code-actions"

type Command = (...args: unknown[]) => unknown

type Api = typeof vscode & {
  commands: {
    registerCommand: (command: string, callback: Command) => { dispose(): void }
  }
}

const api = vscode as Api
const original = {
  register: api.commands.registerCommand,
}

function setup(ready = true) {
  const commands = new Map<string, Command>()
  const posts: unknown[] = []
  const context = { subscriptions: [] as Array<{ dispose(): void }> } as vscode.ExtensionContext
  const target: ChatTarget = {
    postMessage: (msg: unknown) => {
      posts.push(msg)
    },
  }
  const resolveTarget = async (): Promise<ChatTarget | undefined> => (ready ? target : undefined)

  api.commands.registerCommand = (command, callback) => {
    commands.set(command, callback)
    return { dispose: () => undefined }
  }

  registerTerminalActions(context, resolveTarget)

  return { commands, posts }
}

afterEach(() => {
  api.commands.registerCommand = original.register
})

describe("registerTerminalActions", () => {
  it("adds terminal output to the resolved chat target", async () => {
    const state = setup()

    await state.commands.get("kilo-code.new.terminalAddToContext")?.({ selection: "bun test" })

    expect(state.posts).toEqual([
      {
        type: "appendChatBoxMessage",
        text: "\nTerminal output:\n```\nbun test\n```",
      },
      { type: "action", action: "focusInput" },
    ])
  })

  it("routes fix/explain prompts to the resolved target", async () => {
    const state = setup()

    await state.commands.get("kilo-code.new.terminalFixCommand")?.({ selection: "bun test" })
    await state.commands.get("kilo-code.new.terminalExplainCommand")?.({ selection: "bun test" })

    expect(state.posts.map((p) => (p as { type: string }).type)).toEqual(["triggerTask", "triggerTask"])
  })

  it("does not post when no chat target could be resolved", async () => {
    const state = setup(false)

    await state.commands.get("kilo-code.new.terminalAddToContext")?.({ selection: "bun test" })

    expect(state.posts).toEqual([])
  })
})
