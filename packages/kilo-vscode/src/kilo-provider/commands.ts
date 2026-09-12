import type { KiloClient } from "@kilocode/sdk/v2/client"
import { retry } from "../services/cli-backend/retry"
import type { CommandListContractRequest } from "../services/cli-backend/serve-private-command-list-contract"
import { attemptCommandListPrivate, buildCommandListPrivateReq } from "./command-list-privatefirst"

const promises = new Map<string, Promise<unknown>>()

export function clearCommandsCache(): void {
  promises.clear()
}

type CommandListConnection = {
  isPrivateAvailable(): boolean
  privateCommandListOutcomeWithHandle(req: CommandListContractRequest): {
    id: number
    promise: Promise<unknown>
    cancel?: (msg?: string) => boolean | "stale"
  }
}

function mapEntries(items: Array<{ name: string; description?: string; source?: string; hints?: string[] }>): {
  type: string
  commands: Array<{ name: string; description?: string; source?: string; hints?: string[] }>
} {
  return {
    type: "commandsLoaded",
    commands: items.map((cmd) => ({
      name: cmd.name,
      description: cmd.description,
      source: cmd.source,
      hints: cmd.hints,
    })),
  }
}

function terminalError(code: string, message: string): Error {
  const err = new Error(`private command/list failed: ${code}: ${message}`.slice(0, 300))
  ;(err as unknown as Record<string, unknown>).code = code
  return err
}

/**
 * Private-first `command/list` read. A validated private
 * `succeeded`+`accepted` returns the safe carrier projection with zero SDK;
 * a validated `failed` with `retryable === false` rejects terminally with
 * zero SDK. Retryable fence, unavailable, invalid, ambiguous, transport,
 * closed, and timeout take exactly one SDK `client.command.list` fallback
 * through the existing retry wrapper; no second private attempt runs.
 */
export async function loadCommands(client: KiloClient, dir: string, connection?: unknown): Promise<unknown> {
  const pending = promises.get(dir)
  if (pending) return pending

  const promise = (async () => {
    const conn = connection as CommandListConnection | null | undefined
    if (typeof dir === "string" && dir.length > 0 && conn) {
      let req: CommandListContractRequest
      try {
        req = buildCommandListPrivateReq(dir)
      } catch {
        req = null as unknown as CommandListContractRequest
      }
      if (req) {
        const attempt = await attemptCommandListPrivate(conn, req)
        if (attempt.kind === "ok") return mapEntries(attempt.commands)
        if (attempt.kind === "terminal") throw terminalError(attempt.code, attempt.message)
      }
    }
    const result = await retry(() => client.command.list({ directory: dir }, { throwOnError: true }))
    const data = (result as { data?: unknown }).data
    return mapEntries(data as Array<{ name: string; description?: string; source?: string; hints?: string[] }>)
  })()

  promises.set(dir, promise)
  try {
    return await promise
  } finally {
    // Clear the cache entry once the request settles so subsequent calls
    // fetch fresh data. Identity check guards against clear-then-restart
    // races: if clearCommandsCache() wiped the map and a new loadCommands()
    // already stored a fresh promise, don't delete its entry.
    if (promises.get(dir) === promise) promises.delete(dir)
  }
}
