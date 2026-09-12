import * as vscode from "vscode"
import type { Event, KiloClient } from "@kilocode/sdk/v2/client"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"
import { readPermissionsForDir, replyPermissionPrivateFirst } from "../kilo-provider/permission-privatefirst"

/**
 * Callback that resolves the correct working directory for a session.
 * For tracked sessions this returns the session's directory; otherwise the workspace root.
 */
export type DirectoryResolver = (sessionId?: string) => string

/**
 * Returns every unique directory the extension tracks
 * (workspace root + all registered session directories).
 */
export type AllDirectories = () => string[]
type Asked = Extract<Event, { type: "permission.asked" }>

export interface AutoApproveController {
  active(): boolean
  approve(event: Asked, directory?: string): Promise<boolean>
  toggle(): Promise<boolean>
  onChange(listener: (active: boolean) => void): { dispose(): void }
}

const CONFIG = "kilo-code.new.autoApprove"
const KEY = "enabled"

type OnceResult = { ok: true } | { ok: false; terminal: boolean; detail: unknown }

async function replyOncePrivateFirst(
  connection: KiloConnectionService,
  client: KiloClient,
  dir: string,
  requestID: string,
): Promise<OnceResult> {
  let priv: Awaited<ReturnType<typeof replyPermissionPrivateFirst>> | null = null
  try {
    priv = await replyPermissionPrivateFirst({ connection, directory: dir, requestID, reply: "once" })
  } catch (error) {
    console.error("[Kilo New] toggleAutoApprove: private reply attempt failed, falling back:", error)
  }
  if (priv && priv.outcome.kind === "terminal") return { ok: true }
  if (priv && priv.outcome.kind === "terminal-failure") return { ok: false, terminal: true, detail: priv.outcome.code }
  const sdk = await client.permission
    .reply({ requestID, directory: dir, reply: "once" }, { throwOnError: true })
    .then(
      () => ({ ok: true as const }),
      (err) => ({ ok: false as const, terminal: false as const, detail: err }),
    )
  return sdk
}

/**
 * Runtime auto-accept toggle for permissions.
 *
 * Instead of writing to the CLI config, the attention coordinator delegates
 * `permission.asked` events here and auto-replies "once". This avoids config-layer
 * issues (merged vs global, sparse defaults) and works even when no chat surface is open.
 */
export function registerToggleAutoApprove(
  context: vscode.ExtensionContext,
  connectionService: KiloConnectionService,
  resolve: DirectoryResolver,
  directories: AllDirectories,
): AutoApproveController {
  let active = readActive()
  // Bumped on disable to invalidate in-flight enable drains
  let generation = 0
  const listeners = new Set<(active: boolean) => void>()

  const notify = () => {
    for (const listener of listeners) listener(active)
  }

  const setActive = async (next: boolean) => {
    active = next
    generation++
    notify()
    await vscode.workspace.getConfiguration(CONFIG).update(KEY, active, target())
  }

  const toggle = async () => {
    await setActive(!active)
    const snapshot = generation

    if (!active) {
      vscode.window.showInformationMessage("Auto-approve disabled")
      return active
    }

    vscode.window.showInformationMessage("Auto-approve enabled")
    // Drain any already-pending permission requests across all tracked directories
    const client = tryGetClient(connectionService)
    if (!client) return active
    for (const dir of directories()) {
      if (generation !== snapshot) break
      try {
        const read = await readPermissionsForDir({ connection: connectionService, client, directory: dir })
        if (read.kind !== "ok") continue
        for (const req of read.perms) {
          if (generation !== snapshot) break
          const out = await replyOncePrivateFirst(connectionService, client, dir, req.id)
          if (!out.ok) console.error("[Kilo New] toggleAutoApprove: failed to drain pending:", out.detail)
        }
      } catch (err) {
        console.error("[Kilo New] toggleAutoApprove: failed to list pending permissions:", err)
      }
    }

    return active
  }

  const approve = async (event: Asked, directory?: string) => {
    if (!active) return false
    const client = tryGetClient(connectionService)
    if (!client) return false
    const dir =
      directory ?? connectionService.getPermissionDirectory(event.properties.id) ?? resolve(event.properties.sessionID)
    const out = await replyOncePrivateFirst(connectionService, client, dir, event.properties.id)
    if (!out.ok) console.error("[Kilo New] toggleAutoApprove: failed to auto-reply:", out.detail)
    return out.ok
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(`${CONFIG}.${KEY}`)) return
      const next = readActive()
      if (next === active) return
      active = next
      generation++
      notify()
    }),
  )

  context.subscriptions.push(vscode.commands.registerCommand("kilo-code.new.toggleAutoApprove", toggle))

  return {
    active: () => active,
    approve,
    toggle,
    onChange(listener) {
      listeners.add(listener)
      let disposed = false
      return {
        dispose() {
          if (disposed) return
          disposed = true
          listeners.delete(listener)
        },
      }
    },
  }
}

function readActive(): boolean {
  return vscode.workspace.getConfiguration(CONFIG).get(KEY, false)
}

function target(): vscode.ConfigurationTarget {
  const info = vscode.workspace.getConfiguration(CONFIG).inspect<boolean>(KEY)
  if (info?.workspaceFolderValue !== undefined) return vscode.ConfigurationTarget.WorkspaceFolder
  if (info?.workspaceValue !== undefined) return vscode.ConfigurationTarget.Workspace
  return vscode.ConfigurationTarget.Global
}

function tryGetClient(connectionService: KiloConnectionService): KiloClient | undefined {
  try {
    return connectionService.getClient()
  } catch {
    return undefined
  }
}
