import { p0Stage } from "./perf-instrument"

/**
 * Minimal, default-off, diagnostic-only P0 startup observation stages.
 *
 * All emission is gated by the existing narrow `KILO_P0_PERF` flag inside
 * `p0Stage` (default off, no user-visible setting). When off, every observer
 * method below is a cheap in-memory flag check with no record, no extra HTTP,
 * and no behavior impact. No persistent state is added: flags live only in
 * the returned observer instance (one per KiloProvider).
 *
 * Precise per-stage definitions:
 * - `http.ready`: the first successful SDK REST response observed by the
 *   parallel diagnostic probe (`client.experimental.session.list`,
 *   `limit: 1`, bypassing the private channel) fired inside the shared
 *   connection service after the dynamic port/client exists but BEFORE the
 *   SSE connect/wait below, so it can be ordered against first SSE.
 *   Fire-and-forget: never awaited, never gates `connect()`, adds no serial
 *   delay, never retries, and failures stay silent. Owned once per
 *   connection-service instance (not per provider) so multi-provider
 *   startups record a single point. It is NOT the first SSE event renamed.
 * - `catalog.progress.first`: the first non-authoritative `sessionsProgress`
 *   page delta posted by the catalog drain. Preview-only: it never enters the
 *   session store, Topics, pruning, tombstones, readiness, persistence, or
 *   hydration. Exactly one record per startup; later refreshes stay silent.
 * - `catalog.loaded.first`: the first authoritative `sessionsLoaded` complete
 *   snapshot posted by the catalog drain (the sole authoritative event that
 *   replaces the catalog and drives reconciliation). Exactly one record per
 *   startup; later refreshes stay silent but keep carrying their own
 *   `refreshId` on the wire so analysis can still order them.
 * - `agentManager.operable.first` (webview surface, documented here so the
 *   four startup points share one naming source): the first Agent Manager
 *   render where the global inoperable condition is lifted
 *   (`server.isConnected() === true`, i.e. the prompt-disabled gate) AND the
 *   enabled state has painted (double `requestAnimationFrame` after the
 *   reactive effect), never on message receipt alone.
 */

export const P0_HTTP_READY = "http.ready"
export const P0_CATALOG_PROGRESS_FIRST = "catalog.progress.first"
export const P0_CATALOG_LOADED_FIRST = "catalog.loaded.first"
/** Webview surface stage emitted via the existing `p0Perf` channel. */
export const P0_AM_OPERABLE_FIRST = "agentManager.operable.first"

export type P0StartupEmit = (stage: string, extra?: Record<string, unknown>) => void

export interface P0StartupObserver {
  /** Record HTTP readiness once. Returns true when this call emitted. */
  markHttpReady: (extra?: Record<string, unknown>) => boolean
  /** Record the first catalog page delta once. Returns true when emitted. */
  onCatalogProgress: (refreshId: number, count: number) => boolean
  /** Record the first authoritative catalog snapshot once. Returns true when emitted. */
  onCatalogLoaded: (refreshId: number | undefined, count: number) => boolean
}

/**
 * Create a per-startup observer. Each method emits at most once per instance;
 * later calls return false and emit nothing, so repeated refreshes and
 * reconnects stay silent without extra bookkeeping at call sites.
 * `emit` defaults to `p0Stage` (flag-gated); tests inject a fake.
 */
export function createP0StartupObserver(emit: P0StartupEmit = p0Stage): P0StartupObserver {
  let http = false
  let progress = false
  let loaded = false
  return {
    markHttpReady(extra?: Record<string, unknown>): boolean {
      if (http) return false
      http = true
      emit(P0_HTTP_READY, { via: "session.list", ...(extra ?? {}) })
      return true
    },
    onCatalogProgress(refreshId: number, count: number): boolean {
      if (progress) return false
      progress = true
      emit(P0_CATALOG_PROGRESS_FIRST, { refreshId, count })
      return true
    },
    onCatalogLoaded(refreshId: number | undefined, count: number): boolean {
      if (loaded) return false
      loaded = true
      emit(P0_CATALOG_LOADED_FIRST, { ...(refreshId === undefined ? {} : { refreshId }), count })
      return true
    },
  }
}

/** Minimal structural type for the probe: only the endpoint it uses. */
export interface HttpProbeClient {
  experimental: {
    session: {
      list: (args: { directory: string; limit: number }, opts: { throwOnError: boolean }) => Promise<unknown>
    }
  }
}

/**
 * Fire the diagnostic HTTP-readiness probe. Initiates exactly one lightweight
 * SDK `session.list(limit: 1)` synchronously and returns immediately without
 * awaiting it, so callers stay non-blocking. REST success calls `mark` once;
 * any failure (rejection) stays silent and never propagates, so the
 * connection result is unchanged. `mark` itself is first-only per observer.
 * The SDK client carries the connection auth header; `dir` is the workspace
 * routing identity, matching the catalog drain semantics.
 */
export function fireHttpReadinessProbe(client: HttpProbeClient, dir: string, mark: () => void): void {
  void client.experimental.session.list({ directory: dir, limit: 1 }, { throwOnError: true }).then(
    () => {
      mark()
    },
    () => {},
  )
}
