import type { KiloClient } from "@kilocode/sdk/v2/client"
import { retry } from "../services/cli-backend/retry"
import { observeSessionMessagesParityDetached, type MessagesParityConnection } from "./session-messages-parity"
import { tryPrivateMessagesPage } from "./session-messages-private"
import type { PrivateSessionReader } from "./options"

export const MESSAGE_PAGE_LIMIT = 80

// Bound assistant-boundary backfill so corrupt histories cannot load an entire session.
const FILL_LIMIT = 2

// Full-history private iteration stays inside the worker 1..100 wire contract.
const FULL_PRIVATE_LIMIT = 100
// Bounds private page iteration for limit:0 full reads (100 pages x 100 = 10k messages).
const FULL_PRIVATE_PAGES = 100

/**
 * Build the same base64url-encoded cursor format the server emits so a
 * synthesized cursor round-trips through `session.messages({ before })`.
 * Server contract: `{ id, time }` JSON → base64url. See MessageV2.cursor.
 */
function synthesizeCursor(oldest: { info: { id: string; time: { created: number } } }): string {
  const payload = JSON.stringify({ id: oldest.info.id, time: oldest.info.time.created })
  return Buffer.from(payload, "utf8").toString("base64url")
}

export async function fetchMessagePage(
  client: KiloClient,
  input: {
    sessionID: string
    workspaceDir: string
    limit: number
    before?: string
    signal?: AbortSignal
  },
  parityConnection?: MessagesParityConnection | null,
  privateReader?: PrivateSessionReader | null,
) {
  // limit: 0 is the server contract for "return every message".
  const full = input.limit === 0
  let observed = false
  const observeOnce = (
    result: { data?: unknown; error?: unknown; response?: unknown },
    query: { limit?: number; before?: string },
  ): void => {
    if (observed) return
    observed = true
    if (!parityConnection) return
    if (input.signal?.aborted) return
    try {
      observeSessionMessagesParityDetached(parityConnection, result, input.sessionID, input.workspaceDir, query)
    } catch {
      console.warn("[Kilo Messages] private parity observation failed (fail-closed):", {
        op: "session/messages",
        observationFailed: true,
      })
    }
  }
  if (full) return collect()
  const read = async (before?: string) => {
    const query: { limit?: number; before?: string } =
      before === undefined ? { limit: input.limit } : { limit: input.limit, before }
    // Paged private-first, per bounded page read: at most one private attempt
    // and on failure/unavailability one logical SDK fallback for that page
    // (existing transient retry preserved for bounded UI pages).
    // The outer assistant-boundary fill may legitimately read multiple pages;
    // parity observation stays intentionally bounded to once per outer
    // fetchMessagePage operation. Non-owning.
    const attempt = await tryPrivateMessagesPage(privateReader ?? null, {
      directory: input.workspaceDir,
      sessionId: input.sessionID,
      limit: input.limit,
      ...(before !== undefined ? { cursor: before } : {}),
    })
    if (attempt.kind === "found") return { items: attempt.items, cursor: attempt.cursor }
    if (attempt.kind === "terminal") throw attempt.error
    const result = await retry(() =>
      client.session.messages(
        { sessionID: input.sessionID, directory: input.workspaceDir, limit: input.limit, before },
        { throwOnError: true, signal: input.signal },
      ),
    ).catch((e: unknown) => {
      // SDK-first detached parity for terminal failures only; the observer
      // itself gates on terminal class and returns synchronously. Rethrow so
      // paging, fill, cancellation, and error behavior stay unchanged.
      observeOnce(e as { data?: unknown; error?: unknown; response?: unknown }, query)
      throw e
    })
    // Attach only after the SDK result is available and never await the observer.
    observeOnce(result as unknown as { data?: unknown; error?: unknown; response?: unknown }, query)
    // When a proxy/auth gateway strips X-Next-Cursor but the response fills
    // the requested limit, synthesize a cursor from the oldest item so the
    // "load earlier" path keeps working. Risk of one extra empty request is
    // preferable to silently hiding older history.
    const items = result.data
    const header = result.response.headers.get("X-Next-Cursor")
    const cursor = header ?? (items.length >= input.limit && items[0] ? synthesizeCursor(items[0]) : undefined)
    return { items, cursor }
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

  // Full-history private-first: iterate private pages (wire limit 1..100)
  // oldest-first concatenation preserves chronological ASC and the projected
  // message shape. Terminal outcomes surface without SDK. Any skip/fallback,
  // cycle, or bound overflow falls back to exactly one SDK limit:0 read with
  // no transient retry, with parity bounded once per outer operation, never
  // once per private page. Private iteration stops promptly on input.signal:
  // throwIfAborted runs before and after each awaited private page and before
  // the SDK fallback, so no further private pages or SDK read run after abort.
  async function collect() {
    const throwIfAborted = () => {
      const s = input.signal
      if (!s || !s.aborted) return
      if (typeof s.throwIfAborted === "function") s.throwIfAborted()
      throw s.reason ?? new DOMException("This operation was aborted", "AbortError")
    }
    const query: { limit?: number; before?: string } =
      input.before === undefined ? { limit: 0 } : { limit: 0, before: input.before }
    const fallback = async () => {
      // Full-read fallback is exactly one SDK limit:0 invocation per outer
      // operation: no retry helper, so a transient rejection surfaces after
      // a single read while signal propagation, response shape, and
      // exactly-once parity observation stay unchanged. Never runs after abort.
      throwIfAborted()
      const result = await client.session
        .messages(
          { sessionID: input.sessionID, directory: input.workspaceDir, limit: 0, before: input.before },
          { throwOnError: true, signal: input.signal },
        )
        .catch((e: unknown) => {
          observeOnce(e as { data?: unknown; error?: unknown; response?: unknown }, query)
          throw e
        })
      observeOnce(result as unknown as { data?: unknown; error?: unknown; response?: unknown }, query)
      return { items: result.data, cursor: undefined as string | undefined }
    }
    const pages: import("@opencode-ai/core/v1/session").SessionV1.WithParts[][] = []
    let cursor = input.before
    const seen = new Set<string>()
    for (let n = 0; n < FULL_PRIVATE_PAGES; n++) {
      throwIfAborted()
      if (cursor !== undefined) {
        if (seen.has(cursor)) return fallback()
        seen.add(cursor)
      }
      const attempt = await tryPrivateMessagesPage(privateReader ?? null, {
        directory: input.workspaceDir,
        sessionId: input.sessionID,
        limit: FULL_PRIVATE_LIMIT,
        ...(cursor !== undefined ? { cursor } : {}),
      })
      throwIfAborted()
      if (attempt.kind === "terminal") throw attempt.error
      if (attempt.kind !== "found") return fallback()
      if (attempt.items.length === 0) {
        if (attempt.cursor) return fallback()
        return { items: pages.reverse().flat(), cursor: undefined as string | undefined }
      }
      pages.push(attempt.items)
      if (!attempt.cursor) return { items: pages.reverse().flat(), cursor: undefined as string | undefined }
      cursor = attempt.cursor
    }
    return fallback()
  }
}
