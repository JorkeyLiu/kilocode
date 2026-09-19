import type { KiloClient, Session } from "@kilocode/sdk/v2/client"
import { parseSessionTitle } from "../shared/session-title"

export type RenameSessionDurableContext = {
  directory: string
  sessionId: string
  parentSessionId: null
  configVersion?: number
  sessionRevision?: number
}

export function buildSessionUpdateIdentity(sessionID: string): { opId: string; idempotencyKey: string; requestId: string } {
  const token = crypto.randomUUID()
  const opId = `sessionUpdate:${sessionID}:${token}`
  const idempotencyKey = `sessionUpdate:${sessionID}:${token}`
  const requestId = crypto.randomUUID()
  return { opId, idempotencyKey, requestId }
}

// renameSessionWithResult is the only durable rename entrypoint.
export async function renameSessionWithResult(input: {
  client: KiloClient | null
  sessionID: string
  title: unknown
  directory: string
  idempotencyKey: string
  opId: string
  requestId: string
  context: RenameSessionDurableContext
}): Promise<{ data?: Session; error?: unknown; response?: unknown }> {
  if (!input.client) throw new Error("Not connected to CLI backend")
  const result = parseSessionTitle(input.title)
  if ("error" in result) throw new Error("Invalid session title")
  if (!input.opId || !input.idempotencyKey || !input.requestId) {
    throw new Error("Invalid durable identity: opId, idempotencyKey, and requestId must be provided together")
  }
  if (
    !input.context ||
    typeof input.context.directory !== "string" ||
    !input.context.directory ||
    typeof input.context.sessionId !== "string" ||
    !input.context.sessionId ||
    input.context.parentSessionId !== null
  ) {
    throw new Error("Invalid durable context: directory, sessionId, and parentSessionId must be provided together")
  }
  const res = await input.client.session.update({
    sessionID: input.sessionID,
    directory: input.directory,
    title: result.value,
    opId: input.opId,
    idempotencyKey: input.idempotencyKey,
    requestId: input.requestId,
    context: input.context,
  })
  return res as unknown as { data?: Session; error?: unknown; response?: unknown }
}
