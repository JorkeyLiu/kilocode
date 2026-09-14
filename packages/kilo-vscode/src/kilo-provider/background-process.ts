import type { KiloClient } from "@kilocode/sdk/v2/client"
import type { BackgroundStopSessionPrivateConnection } from "./background-process-stop-session-privatefirst"

/**
 * Best-effort warn-only session background cleanup. Private-first with
 * exactly-one SDK fallback: a valid private `succeeded` is authoritative with
 * zero SDK call; unavailable/unsupported/transport/closed/timeout/ambiguous
 * or retryable takes exactly one SDK `backgroundProcess.stopSession`
 * fallback; a validated terminal non-retryable private failure closes without
 * SDK replay. No UI change; failures only warn.
 */
export async function stopSessionProcesses(
  client: KiloClient | null,
  sessionID: string,
  directory: string,
  connection?: BackgroundStopSessionPrivateConnection | null,
): Promise<void> {
  if (!client) return
  try {
    const { stopSessionProcessesPrivateFirst } = await import("./background-process-stop-session-privatefirst")
    await stopSessionProcessesPrivateFirst({
      connection: connection ?? null,
      client: client as never,
      sessionId: sessionID,
      directory,
    })
  } catch (err: unknown) {
    console.warn("[Kilo New] KiloProvider: Failed to stop background processes:", err)
  }
}
