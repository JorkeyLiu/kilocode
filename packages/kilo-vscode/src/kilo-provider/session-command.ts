import * as crypto from "crypto"
import type { KiloClient } from "@kilocode/sdk/v2/client"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"
import { canonicalCommandOpId, validateCommandResult } from "../services/cli-backend/serve-private-command-contract"
import type { CommandContractRequest } from "../services/cli-backend/serve-private-command-contract"

export function buildCommandIdentity(messageId: string): { opId: string; idempotencyKey: string; requestId: string } {
  const opId = canonicalCommandOpId(messageId)
  return { opId, idempotencyKey: opId, requestId: crypto.randomUUID() }
}

export function ensureCommandMessageId(provided?: string): string {
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

function commandTerminal(code: string, message: string): Error {
  const err = new Error(message) as Error & { code: string; terminal: boolean }
  err.code = code
  err.terminal = true
  return err
}

function isTerminalErr(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { terminal?: unknown }).terminal === true
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
// retryable SDK status. SDK error maps to one idle post then throw so the
// caller posts sendMessageFailed; private success returns void.
export async function sendCommandOnce(opts: CommandPrivateFirstInput, onIdle?: () => void): Promise<void> {
  const res = (await commandSessionPrivateFirst(opts)) as SdkResult
  if (res?.error) {
    try {
      onIdle?.()
    } catch {}
    throw res.error
  }
}

// eslint-disable-next-line complexity
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
    const res = (await opts.client.session.command(
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

  if (!opts.connection.isPrivateAvailable()) {
    return sdkFallback()
  }

  try {
    const conn = opts.connection as unknown as {
      privateCommandWithHandle?: (r: CommandContractRequest) => { id: number; promise: Promise<unknown>; cancel?: (msg?: string) => boolean }
      privateCommand?: (r: CommandContractRequest) => Promise<unknown>
      tryCancelPrivatePending?: (id: number, msg?: string) => boolean
      invalidatePrivatePeerOnObserverTimeout?: (r: string) => void
      peekPrivatePeerNextId?: () => number | null
    }
    const handleFactory = conn.privateCommandWithHandle?.bind(opts.connection) ?? null
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
    } else if (conn.privateCommand) {
      exactId = peekNextId ? peekNextId() : null
      promise = conn.privateCommand.bind(opts.connection)(privateReq)
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
              invalidate(`command observer timeout opId=${opId}`)
            } catch {}
          }
        } else if (invalidate) {
          try {
            invalidate(`command observer timeout opId=${opId}`)
          } catch {}
        }
      }
      throw e
    }

    const typed = result as { status?: string; accepted?: boolean; transportUnknown?: unknown }
    if (typed.transportUnknown === true) throw new Error("invalid private result")
    if (typed.status === "succeeded" && typed.accepted === true) {
      try {
        validateCommandResult(result, privateReq)
      } catch {
        throw new Error("invalid private result")
      }
      return {}
    }
    if (typed.status === "failed") {
      try {
        validateCommandResult(result, privateReq)
      } catch {
        throw new Error("invalid private result")
      }
      const failure = (result as { failure?: { code?: unknown; message?: unknown; retryable?: unknown } }).failure
      if (failure?.retryable === true) throw new Error(`private failed retryable: ${String(typeof failure?.code === "string" ? failure.code : "failed")}`)
      if (failure?.retryable === false) {
        const code = typeof failure?.code === "string" && failure.code ? failure.code : "failed"
        const message = typeof failure?.message === "string" && failure.message ? failure.message : code
        throw commandTerminal(code, message)
      }
      throw new Error("invalid private result")
    }
    throw new Error(`private not succeeded: ${String(typed.status)}`)
  } catch (e) {
    if (isTerminalErr(e)) throw e
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.startsWith("private failed retryable:") || msg === "invalid private result" || msg.startsWith("private not succeeded:") || msg.includes("private parity timeout") || msg.includes("Private peer") || msg.includes("Peer closed") || msg.includes("Peer disposed") || msg.includes("capability")) {
      console.warn("[Kilo Command] private fallback to SDK", { opId, reason: msg.slice(0, 120) })
      return sdkFallback()
    }
    console.warn("[Kilo Command] private fallback to SDK", { opId, reason: msg.slice(0, 120) })
    return sdkFallback()
  }
}
