import type { KiloClient, SessionStatus } from "@kilocode/sdk/v2/client"
import {
  fetchSessionStatusesPrivateFirst,
  type SessionStatusPrivateConnection,
} from "./kilo-provider/session-status-privatefirst"

/**
 * Minimal structural surface needed for the private-first status read.
 * The connection service itself satisfies this interface; tests supply
 * fakes. Only the read handle is required — no deferred/dedupe hooks.
 */
export type StatusParityConnection = SessionStatusPrivateConnection

export interface StatusParityObserver {
  connection: StatusParityConnection
  timeoutMs?: number
}

/**
 * Fetch all current session statuses and seed the provided map + webview.
 * Called on connect so the Settings panel knows about already-running sessions
 * without waiting for the next session.status SSE event.
 *
 * Private-first: the private `session/status` read runs first via the
 * shared helper (same `SessionStatus.Service.list()` source, same
 * directory). A valid private `succeeded`+`accepted` result seeds with zero
 * SDK; a validated terminal closes with zero SDK and no map/post side
 * effects; otherwise exactly one same-directory SDK fallback runs with no
 * retry. Only a successful map (private or SDK) executes the existing
 * set+post; `reconcile=true` (default: first seed) still only resets
 * locally non-idle sessions absent from the successful response to idle.
 * Failure/terminal/empty-invalid never writes the map, never posts, and
 * never reconciles. SSE `session.status` remains the transition authority;
 * this seed never changes its order/filter.
 *
 * When `reconcile` is true (default: first seed), locally-busy sessions absent
 * from the server response are reset to idle — covering server crash/restart.
 * On SSE reconnects set `reconcile: false` to avoid a race where the HTTP
 * fetch briefly returns stale data and the spinner disappears mid-stream.
 */
export async function seedSessionStatuses(
  client: KiloClient,
  dir: string,
  map: Map<string, SessionStatus["type"]>,
  post: (msg: unknown) => void,
  reconcile = true,
  observer?: StatusParityObserver,
): Promise<void> {
  try {
    const result = await fetchSessionStatusesPrivateFirst({
      connection: observer?.connection ?? null,
      client: client as unknown as Parameters<typeof fetchSessionStatusesPrivateFirst>[0]["client"],
      directory: dir,
      timeoutMs: observer?.timeoutMs,
    })
    if (result.kind !== "ok") {
      console.error("[Kilo New] KiloProvider: Failed to seed session statuses:", result.kind)
      return
    }
    const active = result.statuses as unknown as Record<string, SessionStatus>
    if (!active || typeof active !== "object" || Array.isArray(active)) {
      console.error("[Kilo New] KiloProvider: Failed to seed session statuses:", "invalid")
      return
    }

    // Seed/update entries the server knows about
    for (const [sid, info] of Object.entries(active) as [string, SessionStatus][]) {
      map.set(sid, info.type)
      post({
        type: "sessionStatus",
        sessionID: sid,
        status: info.type,
        ...(info.type === "retry" ? { attempt: info.attempt, message: info.message, next: info.next } : {}),
      })
    }

    // Reconcile: any locally non-idle session absent from the server response
    // means the server lost its in-memory state (crash/restart). Reset to idle.
    // Skipped on SSE reconnects — the real-time SSE events are authoritative
    // for status transitions and the brief fetch can race with them.
    if (reconcile) {
      for (const [sid, status] of map) {
        if (status !== "idle" && !active[sid]) {
          map.set(sid, "idle")
          post({ type: "sessionStatus", sessionID: sid, status: "idle" })
        }
      }
    }
  } catch (error) {
    console.error("[Kilo New] KiloProvider: Failed to seed session statuses:", error)
  }
}
