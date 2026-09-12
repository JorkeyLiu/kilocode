import type { KiloClient } from "@kilocode/sdk/v2/client"
import { fetchMcpStatusPrivateFirst } from "../kilo-provider/mcp-status-privatefirst"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"

type Client = Pick<KiloClient, "mcp">
type Log = (...args: unknown[]) => void

async function warm(client: Client, dir: string, log: Log, connection?: KiloConnectionService | null): Promise<void> {
  log(`[MCPWarmup] Starting for ${dir}`)
  const outcome = await fetchMcpStatusPrivateFirst({ connection: connection ?? null, client, directory: dir })
  if (outcome.kind !== "ok") throw new Error(`[MCPWarmup] status unavailable for ${dir}`)
  log(`[MCPWarmup] Completed for ${dir}`)
}

export function startSession<T>(
  client: Client,
  dir: string,
  create: () => Promise<T>,
  log: Log,
  connection?: KiloConnectionService | null,
): Promise<T> {
  void warm(client, dir, log, connection).catch((err) => log(`[MCPWarmup] Failed for ${dir}:`, err))
  return create()
}
