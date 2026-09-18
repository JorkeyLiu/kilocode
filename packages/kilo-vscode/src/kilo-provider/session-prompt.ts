import * as crypto from "crypto"
import type { KiloClient } from "@kilocode/sdk/v2/client"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"
import { canonicalPromptOpId, validatePromptResult } from "../services/cli-backend/serve-private-prompt-contract"
import type { PromptContractRequest } from "../services/cli-backend/serve-private-prompt-contract"

export function buildPromptIdentity(messageId: string): { opId: string; idempotencyKey: string; requestId: string } {
  const opId = canonicalPromptOpId(messageId)
  return { opId, idempotencyKey: opId, requestId: crypto.randomUUID() }
}

export function ensurePromptMessageId(provided?: string): string {
  if (typeof provided === "string" && provided.length > 0) return provided
  return `msg_${crypto.randomUUID().replace(/-/g, "")}`
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`private parity timeout after ${ms}ms`)), ms)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

function promptTerminal(code: string, message: string): Error {
  const err = new Error(message) as Error & { code: string; terminal: boolean }
  err.code = code
  err.terminal = true
  return err
}

function isTerminalErr(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { terminal?: unknown }).terminal === true
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

// eslint-disable-next-line complexity
export async function promptSessionPrivateFirst(opts: PromptPrivateFirstInput): Promise<SdkResult> {
  const messageID = ensurePromptMessageId(opts.messageID)
  const { opId, idempotencyKey, requestId } = buildPromptIdentity(messageID)
  const privateReq: PromptContractRequest = {
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

  if (!opts.connection.isPrivateAvailable()) {
    return sdkFallback()
  }

  try {
    const conn = opts.connection as unknown as {
      privatePromptWithHandle?: (r: PromptContractRequest) => { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean }
      privatePrompt?: (r: PromptContractRequest) => Promise<unknown>
      tryCancelPrivatePending?: (id: number, msg?: string) => boolean
      invalidatePrivatePeerOnObserverTimeout?: (r: string) => void
      peekPrivatePeerNextId?: () => number | null
    }
    const handleFactory = conn.privatePromptWithHandle?.bind(opts.connection) ?? null
    const tryCancel = conn.tryCancelPrivatePending?.bind(opts.connection) ?? null
    const invalidate = conn.invalidatePrivatePeerOnObserverTimeout?.bind(opts.connection) ?? null
    const peekNextId = conn.peekPrivatePeerNextId?.bind(opts.connection) ?? null

    let handle: { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean } | null = null
    let exactId: number | null = null
    let promise: Promise<unknown>
    if (handleFactory) {
      try {
        const h = handleFactory(privateReq)
        handle = h
        exactId = h.id
        promise = h.promise
      } catch (e) {
        promise = Promise.reject(e)
      }
    } else if (conn.privatePrompt) {
      exactId = peekNextId ? peekNextId() : null
      promise = conn.privatePrompt.bind(opts.connection)(privateReq)
    } else {
      return sdkFallback()
    }

    let result: unknown
    try {
      result = await withTimeout(promise, 3000)
    } catch (e) {
      const msg = String(e)
      if (msg.includes("private parity timeout")) {
        if (handle?.cancel) {
          try {
            handle.cancel(`private parity timeout opId=${opId}`)
          } catch {}
        } else if (exactId !== null && tryCancel) {
          let cleaned = false
          try {
            cleaned = tryCancel(exactId, `private parity timeout opId=${opId}`)
          } catch {}
          if (!cleaned && invalidate) {
            try {
              invalidate(`prompt observer timeout opId=${opId}`)
            } catch {}
          }
        } else if (invalidate) {
          try {
            invalidate(`prompt observer timeout opId=${opId}`)
          } catch {}
        }
      }
      throw e
    }

    const typed = result as { status?: string; accepted?: boolean; transportUnknown?: unknown }
    if (typed.transportUnknown === true) throw new Error("invalid private result")
    if (typed.status === "succeeded" && typed.accepted === true) {
      try {
        validatePromptResult(result, privateReq)
      } catch {
        throw new Error("invalid private result")
      }
      return {}
    }
    if (typed.status === "failed") {
      try {
        validatePromptResult(result, privateReq)
      } catch {
        throw new Error("invalid private result")
      }
      const failure = (result as { failure?: { code?: unknown; message?: unknown; retryable?: unknown } }).failure
      if (failure?.retryable === true) throw new Error(`private failed retryable: ${String(typeof failure?.code === "string" ? failure.code : "failed")}`)
      if (failure?.retryable === false) {
        const code = typeof failure?.code === "string" && failure.code ? failure.code : "failed"
        const message = typeof failure?.message === "string" && failure.message ? failure.message : code
        throw promptTerminal(code, message)
      }
      throw new Error("invalid private result")
    }
    throw new Error(`private not succeeded: ${String(typed.status)}`)
  } catch (e) {
    if (isTerminalErr(e)) throw e
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.startsWith("private failed retryable:") || msg === "invalid private result" || msg.startsWith("private not succeeded:") || msg.includes("private parity timeout") || msg.includes("Private peer") || msg.includes("Peer closed") || msg.includes("Peer disposed") || msg.includes("capability")) {
      console.warn("[Kilo Prompt] private fallback to SDK", { opId, reason: msg.slice(0, 120) })
      return sdkFallback()
    }
    console.warn("[Kilo Prompt] private fallback to SDK", { opId, reason: msg.slice(0, 120) })
    return sdkFallback()
  }
}
