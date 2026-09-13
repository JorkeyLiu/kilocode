import type { KiloClient } from "@kilocode/sdk/v2/client"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"
import type { SandboxPreference } from "../services/sandbox-preference"
import { fetchConfigUiDefaultsPrivateFirst, requireUiDefaults } from "./config-ui-defaults-privatefirst"

export const SANDBOX_METADATA_KEY = "kilocode.sandbox"

export function sandboxMetadata(enabled: boolean, metadata?: Record<string, unknown>) {
  return {
    ...metadata,
    [SANDBOX_METADATA_KEY]: {
      enabled,
      version: 0,
    },
  }
}

export async function sandboxDefault(
  preference: SandboxPreference | undefined,
  client: KiloClient,
  directory: string,
  connection: KiloConnectionService,
) {
  await preference?.wait()
  const explicit = preference?.explicit()
  if (explicit !== undefined) return explicit
  const out = await fetchConfigUiDefaultsPrivateFirst({ connection, client: client as never, directory })
  return requireUiDefaults(out, "sandbox default").sandbox.enabled
}

export async function sandboxSessionMetadata(
  preference: SandboxPreference | undefined,
  client: KiloClient,
  directory: string,
  connection: KiloConnectionService,
  metadata?: Record<string, unknown>,
) {
  return sandboxMetadata(await sandboxDefault(preference, client, directory, connection), metadata)
}
