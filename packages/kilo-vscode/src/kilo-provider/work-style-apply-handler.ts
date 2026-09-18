import * as vscode from "vscode"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"
import type { CanonicalConfigService } from "../config/service"
import type { WorkStyle, WorkStyleState } from "../shared/work-style-presets"
import { levelForStyle } from "../shared/work-style-presets"
import {
  fetchConfigUiDefaultsPrivateFirst,
  requireUiDefaults,
  toWorkStyleConfig,
} from "../shared/config-ui-defaults-privatefirst"
import { applyWorkStyle, type WorkStyleSettingSnapshot } from "./work-style-apply"

/**
 * Minimal canonical writer for the Work Style preset path.
 * Production passes the activation-owned `CanonicalConfigService`; tests may
 * pass the real service over temp files. Only `stamp` + `writeConfigScopes`
 * are used — no second config owner, no new fd operation.
 */
export type WorkStyleCanonicalWriter = Pick<CanonicalConfigService, "stamp" | "writeConfigScopes">

function inspect(config: vscode.WorkspaceConfiguration, key: string): WorkStyleSettingSnapshot {
  const info = config.inspect(key)
  return {
    global: info?.globalValue,
    customized:
      info?.globalValue !== undefined || info?.workspaceValue !== undefined || info?.workspaceFolderValue !== undefined,
  }
}

async function apply(
  connection: KiloConnectionService,
  directory: string,
  style: WorkStyle,
  canonical: WorkStyleCanonicalWriter | null | undefined,
) {
  const settings = vscode.workspace.getConfiguration("kilo-code.new")
  return applyWorkStyle(style, {
    read: async () => {
      const client = await connection.getClientAsync(directory)
      const out = await fetchConfigUiDefaultsPrivateFirst({ connection, client: client as never, directory })
      return toWorkStyleConfig(requireUiDefaults(out, "work-style config"))
    },
    inspect: (key) => inspect(settings, key),
    write: async (key, value) => {
      await settings.update(key, value, vscode.ConfigurationTarget.Global)
    },
    patch: async (config) => {
      if (!canonical) throw new Error("Canonical config authority is not ready")
      const stamp = canonical.stamp
      const result = await canonical.writeConfigScopes(
        { global: { patch: config as Record<string, unknown>, expectedHash: stamp.globalHash ?? "absent" } },
        stamp,
      )
      if (!result.ok) throw new Error(result.message)
    },
  })
}

export async function handleWorkStyleApplyMessage(input: {
  message: { type?: string; style?: WorkStyleState }
  connection: KiloConnectionService
  directory: string
  canonical?: WorkStyleCanonicalWriter | null
  post: (message: unknown) => void
}): Promise<boolean> {
  if (input.message.type !== "applyWorkStyle") return false
  if (input.message.style !== "human-in-the-loop" && input.message.style !== "autonomous") {
    console.error("[Kilo New] Invalid style in applyWorkStyle message")
    input.post({ type: "workStyleApplyFailed", message: "Invalid work style", rollbackFailed: false })
    return true
  }

  const result = await apply(input.connection, input.directory, input.message.style, input.canonical)
  input.post(
    result.ok
      ? { type: "workStyleApplied", style: input.message.style, level: levelForStyle(input.message.style) }
      : {
          type: "workStyleApplyFailed",
          message: result.error,
          rollbackFailed: result.rollback.length > 0,
        },
  )
  return true
}
