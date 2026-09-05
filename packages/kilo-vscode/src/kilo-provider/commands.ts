import type { KiloClient } from "@kilocode/sdk/v2/client"
import { retry } from "../services/cli-backend/retry"
import { observeCommandListParityDetached, type CommandListParityConnection } from "./command-list-parity"

const promises = new Map<string, Promise<unknown>>()

export function clearCommandsCache(): void {
  promises.clear()
}

/**
 * Detached SDK-first `command/list` parity boundary. SDK stays the sole
 * authority; the observer is non-blocking, warn-only, and never mutates the
 * SDK return or the per-directory dedupe cache. Null detaches. Set by the
 * owner that holds the current `KiloConnectionService`.
 */
let parityConn: CommandListParityConnection | null = null

export function setCommandListParityConnection(c: CommandListParityConnection | null): void {
  parityConn = c
}

function observeParity(sdk: { data?: unknown; error?: unknown; response?: unknown }, dir: string): void {
  const conn = parityConn
  if (!conn) return
  if (typeof dir !== "string" || dir.length === 0) return
  try {
    observeCommandListParityDetached(conn, sdk, dir)
  } catch {
    console.warn("[Kilo CommandList] private parity observation failed (fail-closed):", {
      op: "command/list",
      observationFailed: true,
    })
  }
}

export async function loadCommands(client: KiloClient, dir: string): Promise<unknown> {
  const pending = promises.get(dir)
  if (pending) return pending

  const promise = retry(() => client.command.list({ directory: dir }, { throwOnError: true })).then(
    (result) => {
      const sdk = {
        data: (result as { data?: unknown }).data,
        response: (result as { response?: unknown }).response,
      }
      observeParity(sdk, dir)
      return {
        type: "commandsLoaded",
        commands: (sdk.data as Array<{ name: string; description?: string; source?: string; hints?: string[] }>).map(
          (cmd) => ({
            name: cmd.name,
            description: cmd.description,
            source: cmd.source,
            hints: cmd.hints,
          }),
        ),
      }
    },
    (error: unknown) => {
      observeParity(
        { error, response: (error as { response?: unknown })?.response },
        dir,
      )
      throw error
    },
  )

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
