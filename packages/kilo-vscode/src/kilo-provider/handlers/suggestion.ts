/**
 * Suggestion handlers — extracted from KiloProvider.
 *
 * Manages suggestion accept and dismiss flows plus recovery after SSE reconnects.
 * No vscode dependency.
 */

import type { KiloClient, SuggestionRequest } from "@kilocode/sdk/v2/client"
import { recoveryDirs } from "./permission-handler"
import {
  acceptSuggestionPrivateFirst,
  dismissSuggestionPrivateFirst,
  readSuggestionsForDir,
} from "../suggestion-privatefirst"

type PrivateConn = Parameters<typeof acceptSuggestionPrivateFirst>[0]["connection"]

export type RecoverableSuggestion = SuggestionRequest

export interface SuggestionContext {
  readonly client: KiloClient | null
  readonly currentSessionId: string | undefined
  readonly trackedSessionIds: Set<string>
  readonly sessionDirectories: ReadonlyMap<string, string>
  readonly connection?: PrivateConn
  postMessage(msg: unknown): void
  getWorkspaceDirectory(sessionId?: string): string
}

export function recoverableSuggestions(items: RecoverableSuggestion[], tracked: Set<string>, seen: Set<string>) {
  return items.filter((item) => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return tracked.has(item.sessionID)
  })
}

/**
 * Route suggestion-related webview messages.
 * Extracted from the main message handler to stay within the complexity limit.
 */
export async function routeSuggestionWebviewMessage(
  ctx: SuggestionContext,
  message: { type: string; requestID?: string; sessionID?: string; index?: number },
): Promise<void> {
  switch (message.type) {
    case "suggestionAccept":
      await handleSuggestionAccept(ctx, message.requestID!, message.index!, message.sessionID)
      break
    case "suggestionDismiss":
      await handleSuggestionDismiss(ctx, message.requestID!, message.sessionID)
      break
  }
}

function isNotFoundError(error: unknown): boolean {
  const record = (value: unknown) =>
    value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
  const obj = record(error)
  if (!obj) return false

  const cause = record(obj.cause)
  const body = record(cause?.body)
  return [obj, record(obj.data), cause, body, record(body?.data)].some(
    (value) => value?.name === "NotFoundError" || value?._tag === "NotFound" || value?.status === 404,
  )
}

function stale(ctx: SuggestionContext, requestID: string): void {
  ctx.postMessage({ type: "suggestionResolved", requestID })
}

export async function handleSuggestionAccept(
  ctx: SuggestionContext,
  requestID: string,
  index: number,
  sessionID?: string,
): Promise<void> {
  if (!ctx.client) {
    ctx.postMessage({ type: "suggestionError", requestID })
    return
  }

  const dir = ctx.getWorkspaceDirectory(sessionID ?? ctx.currentSessionId)

  try {
    const priv = await acceptSuggestionPrivateFirst({
      connection: ctx.connection ?? null,
      directory: dir,
      requestID,
      index,
    })
    if (priv.outcome.kind === "terminal") return
    if (priv.outcome.kind === "terminal-failure") {
      if (priv.outcome.code === "suggestion.not_found") {
        stale(ctx, requestID)
        return
      }
      console.error("[Kilo New] KiloProvider: Failed to accept suggestion:", priv.outcome.code)
      ctx.postMessage({ type: "suggestionError", requestID })
      return
    }
  } catch (error) {
    console.error("[Kilo New] KiloProvider: Private accept attempt failed, falling back:", error)
  }

  try {
    await ctx.client.suggestion.accept({ requestID, index, directory: dir }, { throwOnError: true })
  } catch (error) {
    console.error("[Kilo New] KiloProvider: Failed to accept suggestion:", error)
    if (isNotFoundError(error)) {
      stale(ctx, requestID)
      return
    }
    ctx.postMessage({ type: "suggestionError", requestID })
  }
}

export async function handleSuggestionDismiss(
  ctx: SuggestionContext,
  requestID: string,
  sessionID?: string,
): Promise<void> {
  if (!ctx.client) {
    ctx.postMessage({ type: "suggestionError", requestID })
    return
  }

  const dir = ctx.getWorkspaceDirectory(sessionID ?? ctx.currentSessionId)

  try {
    const priv = await dismissSuggestionPrivateFirst({ connection: ctx.connection ?? null, directory: dir, requestID })
    if (priv.outcome.kind === "terminal") return
    if (priv.outcome.kind === "terminal-failure") {
      if (priv.outcome.code === "suggestion.not_found") {
        stale(ctx, requestID)
        return
      }
      console.error("[Kilo New] KiloProvider: Failed to dismiss suggestion:", priv.outcome.code)
      ctx.postMessage({ type: "suggestionError", requestID })
      return
    }
  } catch (error) {
    console.error("[Kilo New] KiloProvider: Private dismiss attempt failed, falling back:", error)
  }

  try {
    await ctx.client.suggestion.dismiss({ requestID, directory: dir }, { throwOnError: true })
  } catch (error) {
    console.error("[Kilo New] KiloProvider: Failed to dismiss suggestion:", error)
    if (isNotFoundError(error)) {
      stale(ctx, requestID)
      return
    }
    ctx.postMessage({ type: "suggestionError", requestID })
  }
}

export async function fetchAndSendPendingSuggestions(ctx: SuggestionContext): Promise<void> {
  if (!ctx.client) return
  try {
    const dirs = recoveryDirs(ctx.getWorkspaceDirectory(), ctx.sessionDirectories)

    const seen = new Set<string>()
    for (const dir of dirs) {
      let items: RecoverableSuggestion[]
      try {
        const read = await readSuggestionsForDir({
          connection: ctx.connection ?? null,
          client: ctx.client,
          directory: dir,
        })
        if (read.kind !== "ok") continue
        items = read.items as unknown as RecoverableSuggestion[]
      } catch (error) {
        console.error(`[Kilo New] KiloProvider: Failed to fetch pending suggestions for ${dir}:`, error)
        continue
      }
      if (!items) continue
      for (const suggestion of recoverableSuggestions(items, ctx.trackedSessionIds, seen)) {
        ctx.postMessage({
          type: "suggestionRequest",
          suggestion,
        })
      }
    }
  } catch (error) {
    console.error("[Kilo New] KiloProvider: Failed to fetch pending suggestions:", error)
  }
}
