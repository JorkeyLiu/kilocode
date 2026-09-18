import * as vscode from "vscode"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"
import {
  getInitialWorkStyle,
  resolveMainState,
  type PermissionMainLevel,
  type PermissionMainState,
  type WorkStyleState,
} from "../shared/work-style-presets"
import { handleWorkStyleApplyMessage, type WorkStyleCanonicalWriter } from "./work-style-apply-handler"
import { hasAnySession } from "./session-existence-privatefirst"
import {
  fetchConfigUiDefaultsPrivateFirst,
  requireUiDefaults,
} from "../shared/config-ui-defaults-privatefirst"

export const WORK_STYLE_SETTING_KEYS = ["showTaskTimeline"] as const

function getConfig() {
  return vscode.workspace.getConfiguration("kilo-code.new")
}

function isWorkStyleConfigured(): boolean {
  return getConfig().inspect<WorkStyleState>("agentWorkStyle")?.globalValue !== undefined
}

export function getWorkStylePayload() {
  return {
    type: "workStyleLoaded" as const,
    style: getConfig().get<WorkStyleState>("agentWorkStyle", "unset"),
  }
}

export type WorkStyleLoadedPayload = ReturnType<typeof getWorkStylePayload> & {
  level: PermissionMainLevel | "custom" | "unset" | "skipped"
  mainState: PermissionMainState | "unset" | "skipped"
}

async function getCanonicalLevel(
  connection: KiloConnectionService,
  directory: string,
): Promise<{ permissionPreset?: unknown; hasPermission: boolean } | null> {
  try {
    const client = await connection.getClientAsync(directory)
    const out = await fetchConfigUiDefaultsPrivateFirst({ connection, client: client as never, directory })
    const data = requireUiDefaults(out, "work-style level")
    return { permissionPreset: data.workStyle.permissionPreset, hasPermission: data.workStyle.hasPermission }
  } catch {
    return null
  }
}

export function isWorkStyleSetting(key: string): boolean {
  return WORK_STYLE_SETTING_KEYS.includes(key as (typeof WORK_STYLE_SETTING_KEYS)[number]) || key === "agentWorkStyle"
}

export function watchWorkStyleConfig(post: (message: unknown) => void, next?: vscode.Disposable) {
  const keys = ["agentWorkStyle", ...WORK_STYLE_SETTING_KEYS]
  const watcher = vscode.workspace.onDidChangeConfiguration((event) => {
    if (keys.some((key) => event.affectsConfiguration(`kilo-code.new.${key}`))) post(getWorkStylePayload())
  })
  return next ? vscode.Disposable.from(watcher, next) : watcher
}

export async function setWorkStyle(style: WorkStyleState) {
  await getConfig().update("agentWorkStyle", style, vscode.ConfigurationTarget.Global)
}

async function initializeWorkStyle(connection: KiloConnectionService, directory: string): Promise<void> {
  if (isWorkStyleConfigured()) return

  const hasSessions = await hasAnySession(connection, directory)

  if (isWorkStyleConfigured()) return
  await setWorkStyle(getInitialWorkStyle(hasSessions))
}

export async function handleWorkStyleMessage(input: {
  message: { type?: string; style?: WorkStyleState }
  connection: KiloConnectionService
  directory: string
  canonical?: WorkStyleCanonicalWriter | null
  post: (message: unknown) => void
}): Promise<boolean> {
  if (input.message.type === "requestWorkStyle") {
    const initialized = await initializeWorkStyle(input.connection, input.directory)
      .then(() => true)
      .catch((err: unknown) => {
        console.error("[Kilo New] Failed to initialize work style:", err)
        return false
      })
    const base = getWorkStylePayload()
    const style = initialized ? base.style : "skipped"
    const canonical = await getCanonicalLevel(input.connection, input.directory)
    const main = resolveMainState({
      preset: canonical?.permissionPreset,
      legacyStyle: style,
    })
    const payload: WorkStyleLoadedPayload = {
      ...base,
      style,
      level: main === "custom" || main === "unset" || main === "skipped" ? main : main,
      mainState: main,
    }
    input.post(payload)
    return true
  }
  if (await handleWorkStyleApplyMessage({ ...input, canonical: input.canonical })) return true
  if (input.message.type !== "setWorkStyle") return false
  if (!input.message.style) {
    console.error("[Kilo New] Missing style in setWorkStyle message")
    return true
  }
  await setWorkStyle(input.message.style)
  input.post(getWorkStylePayload())
  return true
}
