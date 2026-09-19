import * as crypto from "crypto"
import type { KiloClient } from "@kilocode/sdk/v2/client"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"
import { canonicalCommandOpId, validateCommandResult } from "../services/cli-backend/serve-private-command-contract"
import type { CommandContractRequest } from "../services/cli-backend/serve-private-command-contract"
import { submitPrivateFirst } from "./session-submit"

export function buildCommandIdentity(messageId: string): { opId: string; idempotencyKey: string; requestId: string } {
  const opId = canonicalCommandOpId(messageId)
  return { opId, idempotencyKey: opId, requestId: crypto.randomUUID() }
}

export function ensureCommandMessageId(provided?: string): string {
  if (typeof provided === "string" && provided.length > 0) return provided
  return `msg_${crypto.randomUUID().replace(/-/g, "")}`
}

export interface CommandPrivateFirstInput {
  client: KiloClient
  connection: KiloConnectionService
  sessionId: string
  directory: string
  messageID?: string
  command: string
  args: string
  model?: string
  agent?: string
  variant?: string
  parts?: Array<Record<string, unknown>>
  snapshotInitialization?: "wait"
}

type SdkResult = { data?: unknown; error?: unknown; response?: Response }

// Single-attempt command boundary used by KiloProvider.handleSendCommand.
// Calls commandSessionPrivateFirst exactly once (at most one private attempt
// plus at most one same-identity SDK fallback) and never retries on
// retryable SDK status. SDK error is thrown as-is so the caller posts
// sendMessageFailed; generation status stays owned by CLI runtime
// `session.status`/`session.error` — this seam never posts local status.
export async function sendCommandOnce(opts: CommandPrivateFirstInput): Promise<void> {
  const res = (await commandSessionPrivateFirst(opts)) as SdkResult
  if (res?.error) throw res.error
}

export async function commandSessionPrivateFirst(opts: CommandPrivateFirstInput): Promise<SdkResult> {
  const messageID = ensureCommandMessageId(opts.messageID)
  const { opId, idempotencyKey, requestId } = buildCommandIdentity(messageID)
  const privateReq: CommandContractRequest = {
    v: 1 as const,
    requestId,
    opId,
    op: "session/command" as const,
    idempotencyKey,
    context: { directory: opts.directory, sessionId: opts.sessionId, parentSessionId: null as string | null },
    payload: {
      messageId: messageID,
      command: opts.command,
      arguments: opts.args,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.agent ? { agent: opts.agent } : {}),
      ...(opts.variant ? { variant: opts.variant } : {}),
      ...(opts.parts ? { parts: opts.parts as unknown[] } : {}),
      ...(opts.snapshotInitialization ? { snapshotInitialization: opts.snapshotInitialization } : {}),
    },
  }

  const sdkFallback = async (): Promise<SdkResult> => {
    const res = (await opts.client.session.commandAsync(
      {
        sessionID: opts.sessionId,
        directory: opts.directory,
        command: opts.command,
        arguments: opts.args,
        messageID,
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.agent ? { agent: opts.agent } : {}),
        ...(opts.variant ? { variant: opts.variant } : {}),
        ...(opts.parts ? { parts: opts.parts as never } : {}),
        ...(opts.snapshotInitialization ? { snapshotInitialization: opts.snapshotInitialization } : {}),
      } as never,
      { throwOnError: false } as never,
    )) as unknown as SdkResult
    return res
  }

  const conn = opts.connection as unknown as {
    privateCommandWithHandle?: (r: CommandContractRequest) => { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean }
    privateCommand?: (r: CommandContractRequest) => Promise<unknown>
    tryCancelPrivatePending?: (id: number, msg?: string) => boolean
    invalidatePrivatePeerOnObserverTimeout?: (r: string) => void
    peekPrivatePeerNextId?: () => number | null
  }
  const factory = conn.privateCommandWithHandle?.bind(opts.connection) ?? null
  const direct = conn.privateCommand?.bind(opts.connection) ?? null
  const cancel = conn.tryCancelPrivatePending?.bind(opts.connection) ?? null
  const invalidate = conn.invalidatePrivatePeerOnObserverTimeout?.bind(opts.connection) ?? null
  const peek = conn.peekPrivatePeerNextId?.bind(opts.connection) ?? null

  return submitPrivateFirst({
    available: () => opts.connection.isPrivateAvailable(),
    opId,
    scope: "Command",
    request: privateReq,
    dispatch: {
      factory: factory ? (req: unknown) => factory(req as CommandContractRequest) : null,
      direct: direct ? (req: unknown) => direct(req as CommandContractRequest) : null,
      cancel,
      invalidate,
      peek,
    },
    validate: (result: unknown) => validateCommandResult(result, privateReq),
    fallback: sdkFallback,
  })
}
