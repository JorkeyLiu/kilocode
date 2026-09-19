import * as crypto from "crypto"
import type { KiloClient } from "@kilocode/sdk/v2/client"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"
import { canonicalPromptOpId, validatePromptResult } from "../services/cli-backend/serve-private-prompt-contract"
import type { PromptContractRequest } from "../services/cli-backend/serve-private-prompt-contract"
import { submitPrivateFirst } from "./session-submit"

export function buildPromptIdentity(messageId: string): { opId: string; idempotencyKey: string; requestId: string } {
  const opId = canonicalPromptOpId(messageId)
  return { opId, idempotencyKey: opId, requestId: crypto.randomUUID() }
}

export function ensurePromptMessageId(provided?: string): string {
  if (typeof provided === "string" && provided.length > 0) return provided
  return `msg_${crypto.randomUUID().replace(/-/g, "")}`
}

export interface PromptPrivateFirstInput {
  client: KiloClient
  connection: KiloConnectionService
  sessionId: string
  directory: string
  messageID?: string
  parts: Array<Record<string, unknown>>
  model?: { providerID: string; modelID: string }
  agent?: string
  variant?: string
  editorContext?: Record<string, unknown>
  snapshotInitialization?: "wait"
  noReply?: boolean
  tools?: Record<string, boolean>
  format?: unknown
  system?: string
}

type SdkResult = { data?: unknown; error?: unknown; response?: Response }

function buildPromptReq(opts: PromptPrivateFirstInput, messageID: string): PromptContractRequest {
  const { opId, idempotencyKey, requestId } = buildPromptIdentity(messageID)
  return {
    v: 1 as const,
    requestId,
    opId,
    op: "session/prompt" as const,
    idempotencyKey,
    context: { directory: opts.directory, sessionId: opts.sessionId, parentSessionId: null as string | null },
    payload: {
      messageId: messageID,
      parts: opts.parts as unknown[],
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.agent ? { agent: opts.agent } : {}),
      ...(opts.variant ? { variant: opts.variant } : {}),
      ...(opts.noReply !== undefined ? { noReply: opts.noReply } : {}),
      ...(opts.tools ? { tools: opts.tools } : {}),
      ...(opts.format !== undefined ? { format: opts.format } : {}),
      ...(opts.system ? { system: opts.system } : {}),
      ...(opts.snapshotInitialization ? { snapshotInitialization: opts.snapshotInitialization } : {}),
      ...(opts.editorContext ? { editorContext: opts.editorContext } : {}),
    },
  }
}

// Single-attempt prompt boundary used by KiloProvider.handleSendMessage.
// Calls promptSessionPrivateFirst exactly once (at most one private attempt
// plus at most one same-identity SDK fallback) and never retries on
// retryable SDK status. SDK error is thrown as-is so the caller posts
// sendMessageFailed; generation status stays owned by CLI runtime
// `session.status`/`session.error` — this seam never posts local status.
export async function sendPromptOnce(opts: PromptPrivateFirstInput): Promise<void> {
  const res = (await promptSessionPrivateFirst(opts)) as SdkResult
  if (res?.error) throw res.error
}

export async function promptSessionPrivateFirst(opts: PromptPrivateFirstInput): Promise<SdkResult> {
  const messageID = ensurePromptMessageId(opts.messageID)
  const opId = buildPromptIdentity(messageID).opId
  const privateReq = buildPromptReq(opts, messageID)

  const sdkFallback = async (): Promise<SdkResult> => {
    const res = (await opts.client.session.promptAsync(
      {
        sessionID: opts.sessionId,
        directory: opts.directory,
        messageID,
        parts: opts.parts as never,
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.agent ? { agent: opts.agent } : {}),
        ...(opts.variant ? { variant: opts.variant } : {}),
        ...(opts.editorContext ? { editorContext: opts.editorContext as never } : {}),
        ...(opts.snapshotInitialization ? { snapshotInitialization: opts.snapshotInitialization } : {}),
        ...(opts.noReply !== undefined ? { noReply: opts.noReply } : {}),
        ...(opts.tools ? { tools: opts.tools } : {}),
        ...(opts.format !== undefined ? { format: opts.format as never } : {}),
        ...(opts.system ? { system: opts.system } : {}),
      } as never,
      { throwOnError: false } as never,
    )) as unknown as SdkResult
    return res
  }

  const conn = opts.connection as unknown as {
    privatePromptWithHandle?: (r: PromptContractRequest) => { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean }
    privatePrompt?: (r: PromptContractRequest) => Promise<unknown>
    tryCancelPrivatePending?: (id: number, msg?: string) => boolean
    invalidatePrivatePeerOnObserverTimeout?: (r: string) => void
    peekPrivatePeerNextId?: () => number | null
  }
  const factory = conn.privatePromptWithHandle?.bind(opts.connection) ?? null
  const direct = conn.privatePrompt?.bind(opts.connection) ?? null
  const cancel = conn.tryCancelPrivatePending?.bind(opts.connection) ?? null
  const invalidate = conn.invalidatePrivatePeerOnObserverTimeout?.bind(opts.connection) ?? null
  const peek = conn.peekPrivatePeerNextId?.bind(opts.connection) ?? null

  return submitPrivateFirst({
    available: () => opts.connection.isPrivateAvailable(),
    opId,
    scope: "Prompt",
    request: privateReq,
    dispatch: {
      factory: factory ? (req: unknown) => factory(req as PromptContractRequest) : null,
      direct: direct ? (req: unknown) => direct(req as PromptContractRequest) : null,
      cancel,
      invalidate,
      peek,
    },
    validate: (result: unknown) => validatePromptResult(result, privateReq),
    fallback: sdkFallback,
  })
}
