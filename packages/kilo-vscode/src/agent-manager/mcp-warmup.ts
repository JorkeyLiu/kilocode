import { fetchMcpStatusPrivate } from "../kilo-provider/mcp-status-private"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"

type Log = (...args: unknown[]) => void

async function warm(dir: string, log: Log, connection?: KiloConnectionService | null): Promise<void> {
  log(`[MCPWarmup] Starting for ${dir}`)
  const outcome = await fetchMcpStatusPrivate({ connection: connection ?? null, directory: dir })
  if (outcome.kind !== "ok") throw new Error(`[MCPWarmup] status unavailable for ${dir}`)
  log(`[MCPWarmup] Completed for ${dir}`)
}

export function startSession<T>(
  dir: string,
  create: () => Promise<T>,
  log: Log,
  connection?: KiloConnectionService | null,
): Promise<T> {
  void warm(dir, log, connection).catch((err) => log(`[MCPWarmup] Failed for ${dir}:`, err))
  return create()
}
