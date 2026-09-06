import { observeConfigWarningsParityDetached, type ConfigWarningsParityConnection } from "./config-warnings-parity"

/**
 * Detached SDK-first `config/warnings` parity boundary. SDK stays the sole
 * authority; the observer is non-blocking, warn-only, and never mutates the
 * SDK return, the warning UI, the once-per-lifecycle flag, or error
 * handling. Null detaches. Set by extension activation to the current
 * `KiloConnectionService` and cleared on deactivation.
 */
let parityConn: ConfigWarningsParityConnection | null = null

export function setConfigWarningsParityConnection(c: ConfigWarningsParityConnection | null): void {
  parityConn = c
}

export function observeConfigWarningsParity(
  sdk: { data?: unknown; error?: unknown; response?: unknown },
  dir: string,
  workspace?: string,
): void {
  const conn = parityConn
  if (!conn) return
  if (typeof dir !== "string" || dir.length === 0) return
  try {
    observeConfigWarningsParityDetached(conn, sdk, dir, workspace)
  } catch {
    console.warn("[Kilo ConfigWarnings] private parity observation failed (fail-closed):", {
      op: "config/warnings",
      observationFailed: true,
    })
  }
}
