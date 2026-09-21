import type { KiloClient } from "@kilocode/sdk/v2/client"
import type { MessagesParityConnection } from "./session-messages-parity"
import { tryPrivateMessagesPage } from "./session-messages-private"
import type { PrivateSessionReader } from "./options"

export const MESSAGE_PAGE_LIMIT = 80

// Bound assistant-boundary backfill so corrupt histories cannot load an entire session.
const FILL_LIMIT = 2

// Full-history private iteration stays inside the worker 1..100 wire contract.
const FULL_PRIVATE_LIMIT = 100
// Bounds private page iteration for limit:0 full reads (100 pages x 100 = 10k messages).
const FULL_PRIVATE_PAGES = 100



export async function fetchMessagePage(
  _client: KiloClient,
  input: {
    sessionID: string
    workspaceDir: string
    limit: number
    before?: string
    signal?: AbortSignal
  },
  // Retained for call-site compatibility only. The SDK fallback path issues
  // no second private request; this connection is never used for parity
  // observation. `compareMessagesParity` stays as pure diagnostic/test
  // evidence only.
  _parityConnection?: MessagesParityConnection | null,
  privateReader?: PrivateSessionReader | null,
) {
  // limit: 0 is the server contract for "return every message".
  const full = input.limit === 0
  if (full) return collect()
  const read = async (before?: string) => {
    // Paged private-authority, per bounded page read: at most one private attempt
    // with zero SDK on any unavailable/malformed branch (no getClientAsync,
    // no client.session.messages fallback). Valid found and valid empty stay
    // authoritative; not_found/scope_mismatch stay authoritative terminals.
    // Malformed fails closed without SDK. AbortSignal is transport-only
    // cancellation: before-read guard prevents the RPC and an in-flight
    // private RPC is cancelled via existing peer $/cancelRequest with abort
    // listener cleanup; no DB-query cancellation, no protocol change, signal
    // never becomes an observation wire payload.
    if (input.signal?.aborted) {
      if (typeof input.signal.throwIfAborted === "function") input.signal.throwIfAborted()
      throw input.signal.reason ?? new DOMException("This operation was aborted", "AbortError")
    }
    const attempt = await tryPrivateMessagesPage(privateReader ?? null, {
      directory: input.workspaceDir,
      sessionId: input.sessionID,
      limit: input.limit,
      ...(before !== undefined ? { cursor: before } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    })
    if (attempt.kind === "found") return { items: attempt.items, cursor: attempt.cursor }
    if (attempt.kind === "terminal") throw attempt.error
    console.warn("[Kilo Messages] private messages unavailable, failing closed without SDK", {
      unavailable: true,
    })
    throw new Error("private observation unavailable: messages gate off or not started or worker error or protocol invalid")
  }

  const fill = async (page: Awaited<ReturnType<typeof read>>, depth = 0): Promise<Awaited<ReturnType<typeof read>>> => {
    if ((page.items[0] as { info?: { role?: string } } | undefined)?.info?.role !== "assistant") return page
    if (depth >= FILL_LIMIT) return page
    if (!page.cursor || input.signal?.aborted) return page
    const next = await read(page.cursor)
    const items = [...next.items, ...page.items]
    return fill({ items, cursor: next.cursor }, depth + 1)
  }

  return fill(await read(input.before))

  // Full-history private-authority: iterate private pages (wire limit 1..100)
  // oldest-first concatenation preserves chronological ASC and the projected
  // message shape. Terminal outcomes surface without SDK. Any unavailable
  // (gate off/not-started/worker error/protocol invalid/malformed), cycle, or
  // bound overflow fails closed with zero SDK and no fallback. AbortSignal is
  // transport-only (peer $/cancelRequest with abort listener cleanup): throwIfAborted
  // runs before and after each awaited private page and before the unavailable
  // throw, and each private page carries input.signal so an in-flight RPC is
  // cancelled and no further private pages run after abort. Single
  // private-authority read with zero SDK for the whole limit:0 operation; no
  // DB-query cancellation.
  async function collect() {
    const throwIfAborted = () => {
      const s = input.signal
      if (!s || !s.aborted) return
      if (typeof s.throwIfAborted === "function") s.throwIfAborted()
      throw s.reason ?? new DOMException("This operation was aborted", "AbortError")
    }
    const unavailable = (): never => {
      throwIfAborted()
      console.warn("[Kilo Messages] private messages unavailable (full), failing closed without SDK", {
        unavailable: true,
      })
      throw new Error("private observation unavailable: messages gate off or not started or worker error or protocol invalid")
    }
    const pages: import("@opencode-ai/core/v1/session").SessionV1.WithParts[][] = []
    let cursor = input.before
    const seen = new Set<string>()
    for (let n = 0; n < FULL_PRIVATE_PAGES; n++) {
      throwIfAborted()
      if (cursor !== undefined) {
        if (seen.has(cursor)) return unavailable()
        seen.add(cursor)
      }
      const attempt = await tryPrivateMessagesPage(privateReader ?? null, {
        directory: input.workspaceDir,
        sessionId: input.sessionID,
        limit: FULL_PRIVATE_LIMIT,
        ...(cursor !== undefined ? { cursor } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      })
      throwIfAborted()
      if (attempt.kind === "terminal") throw attempt.error
      if (attempt.kind !== "found") return unavailable()
      if (attempt.items.length === 0) {
        if (attempt.cursor) return unavailable()
        return { items: pages.reverse().flat(), cursor: undefined as string | undefined }
      }
      pages.push(attempt.items)
      if (!attempt.cursor) return { items: pages.reverse().flat(), cursor: undefined as string | undefined }
      cursor = attempt.cursor
    }
    return unavailable()
  }
}
