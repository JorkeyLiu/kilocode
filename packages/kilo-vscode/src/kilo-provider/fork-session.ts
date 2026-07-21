import type { Session, SessionStatus } from "@kilocode/sdk/v2/client"
import type { KiloConnectionService } from "../services/cli-backend"
import { getErrorMessage } from "../kilo-provider-utils"
import { TelemetryProxy, TelemetryEventName } from "../services/telemetry"

export interface ForkContext {
  connection: KiloConnectionService
  post: (message: { type: "error"; message: string }) => void
  register: (session: Session) => void
  forked: (session: Session, sourceID: string) => void
  status: (sessionID: string) => SessionStatus["type"] | undefined
  directory: (sessionID: string) => string
}

export async function handleForkSession(ctx: ForkContext, sessionId: string, messageId?: string): Promise<void> {
  const status =
    ctx.status(sessionId) ??
    (await Promise.resolve()
      .then(() =>
        ctx.connection.getClient().session.status({ directory: ctx.directory(sessionId) }, { throwOnError: true }),
      )
      .then((result) => result.data?.[sessionId]?.type ?? "idle")
      .catch((e) => {
        console.error("[Kilo New] refreshForkStatus failed:", e)
        return "busy" as SessionStatus["type"]
      }))
  if (status !== "idle") {
    ctx.post({ type: "error", message: "Wait for the session to finish before forking it." })
    return
  }

  const client = ctx.connection.getClient()
  const directory = ctx.directory(sessionId)
  let forked: Session
  try {
    const input = { sessionID: sessionId, directory, ...(messageId ? { messageID: messageId } : {}) }
    const { data } = await client.session.fork(input, { throwOnError: true })
    forked = data
  } catch (error) {
    const err = getErrorMessage(error)
    ctx.post({ type: "error", message: `Failed to fork session: ${err}` })
    TelemetryProxy.capture(TelemetryEventName.AGENT_MANAGER_SESSION_ERROR, {
      source: "kilo-provider",
      error: err,
      context: "forkSession",
      sessionId,
    })
    return
  }

  ctx.register(forked)
  ctx.forked(forked, sessionId)
}
