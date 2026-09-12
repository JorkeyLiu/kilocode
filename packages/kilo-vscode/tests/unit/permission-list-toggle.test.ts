import { describe, expect, it } from "bun:test"
import * as vscode from "vscode"
import { registerToggleAutoApprove } from "../../src/commands/toggle-auto-approve"
import type { KiloClient } from "@kilocode/sdk/v2/client"
import type { KiloConnectionService } from "../../src/services/cli-backend/connection-service"

function context() {
  return { subscriptions: [] as Array<{ dispose(): void }> } as vscode.ExtensionContext
}

function succeeded(req: Record<string, unknown>, perms: unknown[]) {
  return {
    kind: "valid",
    result: {
      v: 1,
      requestId: req.requestId,
      opId: req.opId,
      op: "permission/list",
      idempotencyKey: req.idempotencyKey,
      status: "succeeded",
      outcome: { type: "succeeded", time: 1 },
      accepted: true,
      data: { permissions: perms },
    },
  }
}

function terminalReply(req: Record<string, unknown>) {
  return {
    kind: "terminal",
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    idempotencyKey: req.idempotencyKey,
    accepted: true,
    terminal: true,
    sessionID: "ses_1",
    requestID: (req.context as Record<string, unknown>).requestID,
    reply: "once",
  }
}

describe("permission-list toggle drain", () => {
  it("drains private list with once replies and preserves generation guards", async () => {
    const cfg = vscode as unknown as {
      workspace: {
        getConfiguration: () => {
          get: <T>(k: string, f?: T) => T | boolean
          inspect: () => Record<string, unknown> | undefined
          update: () => Promise<void>
        }
        onDidChangeConfiguration: () => { dispose(): void }
      }
      window: { showInformationMessage: () => Promise<undefined> }
      commands: { registerCommand: () => { dispose(): void } }
    }
    cfg.workspace.getConfiguration = () => ({
      get: (_k, f) => false ?? f,
      inspect: () => undefined,
      update: async () => {},
    })
    cfg.workspace.onDidChangeConfiguration = () => ({ dispose: () => undefined })
    cfg.window.showInformationMessage = async () => undefined
    const registered = new Map<string, (...a: unknown[]) => unknown>()
    cfg.commands.registerCommand = (name, cb) => {
      registered.set(name, cb)
      return { dispose: () => undefined }
    }

    const lists: string[] = []
    const replies: unknown[] = []
    const privReplies: Array<{ dir: string; id: string }> = []
    const permsByDir: Record<string, Array<Record<string, unknown>>> = {
      "/one": [
        {
          id: "per_one00000000000000001",
          sessionID: "ses_1",
          permission: "bash",
          patterns: ["*"],
          metadata: {},
          always: [],
        },
      ],
      "/two": [
        {
          id: "per_two00000000000000001",
          sessionID: "ses_1",
          permission: "bash",
          patterns: ["*"],
          metadata: {},
          always: [],
        },
      ],
    }
    const svc = {
      isPrivateAvailable: () => true,
      getPrivatePeer: () => null,
      getPrivateEpoch: () => 1,
      privatePermissionListOutcomeWithHandle: (req: Record<string, unknown>) => {
        const dir = (req.context as Record<string, unknown>).directory as string
        lists.push(dir)
        return { id: 1, promise: Promise.resolve(succeeded(req, permsByDir[dir] ?? [])), cancel: () => true }
      },
      privatePermissionReplyWithHandle: (req: Record<string, unknown>) => {
        const ctx = req.context as Record<string, unknown>
        privReplies.push({ dir: ctx.directory as string, id: ctx.requestID as string })
        return { id: 2, promise: Promise.resolve(terminalReply(req)), cancel: () => true }
      },
      getClient: () =>
        ({
          permission: {
            list: async () => {
              throw new Error("SDK list must not execute when private succeeds")
            },
            reply: async (args: unknown) => replies.push(args),
          },
        }) as unknown as KiloClient,
      getPermissionDirectory: () => undefined,
    } as unknown as KiloConnectionService

    const ctrl = registerToggleAutoApprove(context(), svc, () => "/repo", () => ["/one", "/two"])
    await ctrl.toggle()

    expect(lists).toEqual(["/one", "/two"])
    expect(privReplies).toEqual([
      { dir: "/one", id: "per_one00000000000000001" },
      { dir: "/two", id: "per_two00000000000000001" },
    ])
    expect(replies).toEqual([])
  })
})
