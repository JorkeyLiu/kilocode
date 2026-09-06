import type { KiloClient } from "@kilocode/sdk/v2/client"
import { observeProjectCurrentParityDetached, type ProjectCurrentParityConnection } from "./project-current-parity"

/**
 * Detached SDK-first `project/current` vcs-only parity boundary. SDK stays
 * the sole authority; the observer is non-blocking, warn-only, and never
 * mutates the SDK return, the git cache/UI, or error handling. Null
 * detaches. Set by extension activation to the current
 * `KiloConnectionService` and cleared on deactivation.
 */
let parityConn: ProjectCurrentParityConnection | null = null

export function setProjectCurrentParityConnection(c: ProjectCurrentParityConnection | null): void {
  parityConn = c
}

function observeParity(sdk: { data?: unknown; error?: unknown; response?: unknown }, dir: string): void {
  const conn = parityConn
  if (!conn) return
  if (typeof dir !== "string" || dir.length === 0) return
  try {
    observeProjectCurrentParityDetached(conn, sdk, dir)
  } catch {
    console.warn("[Kilo ProjectCurrent] private parity observation failed (fail-closed):", {
      op: "project/current",
      observationFailed: true,
    })
  }
}

export async function hasGit(client: KiloClient, directory: string): Promise<boolean> {
  try {
    const result = (await client.project.current({ directory })) as unknown as {
      data?: unknown
      error?: unknown
      response?: unknown
    }
    observeParity(result, directory)
    return (result.data as { vcs?: unknown } | undefined)?.vcs === "git"
  } catch (err) {
    observeParity({ error: err }, directory)
    return false
  }
}
