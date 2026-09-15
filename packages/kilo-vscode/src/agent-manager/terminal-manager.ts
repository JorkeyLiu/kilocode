/**
 * Agent Manager terminal manager.
 *
 * Maps Agent Manager terminal IDs to backend PTY IDs (from `kilo serve`).
 * Creation, resize, close, and bulk dispose are private-first
 * (`pty/create` + `pty/update` + `pty/remove` fd carrier via
 * `pty-privatefirst.ts`, same per-directory `Pty.Service` owner as HTTP,
 * with exactly-one same-tuple SDK fallback). The backend runs a real shell
 * via `@lydell/node-pty` and streams the output over the `/pty/:id/connect`
 * WebSocket — the webview connects directly to that URL so raw bytes do
 * not travel through postMessage. Only `buildWsUrl` (connect URL/auth/bytes)
 * remains SDK/WS unchanged.
 *
 * This module is vscode-free on purpose: it only talks to the SDK and
 * whatever log / post / WS-URL helpers its caller provides. That keeps the
 * architecture test happy and makes the manager easy to unit test.
 */

import type { KiloClient } from "@kilocode/sdk/v2/client"
import {
  createPtyPrivateFirst,
  removePtyPrivateFirst,
  updatePtyPrivateFirst,
  type PtyPrivateConnection,
  type PtySdkClient,
} from "../kilo-provider/pty-privatefirst"

/**
 * Everything the manager needs from the surrounding AgentManagerProvider.
 *
 * Keeping these as function dependencies rather than direct references
 * to the connection service keeps the manager trivially unit-testable
 * and lets the provider control initialization order.
 */
export interface TerminalManagerDeps {
  /** Obtain the shared SDK client. Throws when the CLI is not connected. */
  getClient(): KiloClient
  /** Build the WebSocket URL (including auth + directory query params). */
  buildWsUrl(ptyID: string, cwd: string): string
  /** Short logger, routed to the Agent Manager output channel. */
  log(...args: unknown[]): void
  /** Private fd-carrier connection for `pty/create` + `pty/update` + `pty/remove`. Absent means SDK-only fallback. */
  getPrivateConnection?(): PtyPrivateConnection | null | undefined
}

/**
 * Bookkeeping entry kept in memory for each live terminal.
 *
 * `cwd` is stored because it is required on every SDK call (the server
 * uses the `directory` query param to route requests to the right
 * per-instance PTY map — see `packages/opencode/src/server/instance/middleware.ts`).
 */
interface Entry {
  terminalId: string
  ptyID: string
  slotId: string | null // round-tripped to webview
  cwd: string
  title: string
}

/** Stable prefix used for terminal tab IDs in the webview (e.g. `terminal:abc123`). */
export const TERMINAL_PREFIX = "terminal:"

/** Generate a reasonably unique terminal ID without bringing in a uuid dep. */
function makeTerminalId(): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${TERMINAL_PREFIX}${Date.now().toString(36)}-${rand}`
}

export class TerminalManager {
  private readonly entries = new Map<string, Entry>()

  constructor(private readonly deps: TerminalManagerDeps) {}

  /**
   * Spawn a new backend PTY and record it locally.
   *
   * Returns the attach info the webview needs: our synthetic terminal ID,
   * the title, and the signed WebSocket URL pointing at the PTY's connect
   * endpoint. The slotId is round-tripped so the webview can route the tab
   * back into the correct Agent Manager context. Private-first: one private
   * `pty/create` attempt plus at most one same-tuple SDK `pty.create`
   * fallback, never retried.
   */
  async create(params: {
    slotId: string | null
    cwd: string
    title: string
  }): Promise<{ terminalId: string; slotId: string | null; title: string; wsUrl: string }> {
    const out = await createPtyPrivateFirst({
      connection: this.conn(),
      getClient: () => this.deps.getClient() as unknown as PtySdkClient,
      directory: params.cwd,
      cwd: params.cwd,
      title: params.title,
    })
    if (out.kind === "terminal") throw new Error(`Failed to create PTY: code=${out.code}`)
    if (out.kind === "sdkError") {
      const err = out.error instanceof Error ? out.error.message : String(out.error ?? "unknown error")
      throw new Error(`Failed to create PTY: ${err}`)
    }
    const terminalId = makeTerminalId()
    const entry: Entry = {
      terminalId,
      ptyID: out.id,
      slotId: params.slotId,
      cwd: params.cwd,
      title: out.title || params.title,
    }
    this.entries.set(terminalId, entry)
    const wsUrl = this.deps.buildWsUrl(entry.ptyID, entry.cwd)
    this.deps.log(`Terminal created: ${terminalId} -> pty ${entry.ptyID} cwd=${entry.cwd}`)
    return { terminalId, slotId: entry.slotId, title: entry.title, wsUrl }
  }

  private conn(): PtyPrivateConnection | null | undefined {
    try {
      return this.deps.getPrivateConnection?.() ?? null
    } catch {
      return null
    }
  }

  /** Forward a resize event to the backend PTY. Missing terminals are a no-op. Private-first. */
  async resize(terminalId: string, cols: number, rows: number): Promise<void> {
    const entry = this.entries.get(terminalId)
    if (!entry) return
    const out = await updatePtyPrivateFirst({
      connection: this.conn(),
      getClient: () => this.deps.getClient() as unknown as PtySdkClient,
      directory: entry.cwd,
      ptyID: entry.ptyID,
      rows,
      cols,
    })
    if (out.kind === "ok") return
    if (out.kind === "terminal") {
      this.deps.log(`Terminal resize failed (${terminalId}): code=${out.code}`)
      return
    }
    const err = out.error instanceof Error ? out.error.message : String(out.error)
    this.deps.log(`Terminal resize failed (${terminalId}): ${err}`)
  }

  /** Kill a single terminal. Best-effort — we always drop our bookkeeping. Private-first. */
  async close(terminalId: string): Promise<void> {
    const entry = this.entries.get(terminalId)
    if (!entry) return
    this.entries.delete(terminalId)
    try {
      const out = await removePtyPrivateFirst({
        connection: this.conn(),
        getClient: () => this.deps.getClient() as unknown as PtySdkClient,
        directory: entry.cwd,
        ptyID: entry.ptyID,
      })
      if (out.kind === "ok") {
        this.deps.log(`Terminal closed: ${terminalId} (pty ${entry.ptyID})`)
        return
      }
      if (out.kind === "terminal") {
        this.deps.log(`Terminal close failed (${terminalId}): code=${out.code} — PTY may linger until kilo serve exits`)
        return
      }
      const msg = out.error instanceof Error ? out.error.message : String(out.error)
      this.deps.log(`Terminal close failed (${terminalId}): ${msg} — PTY may linger until kilo serve exits`)
    } catch (err) {
      // Thrown errors are reserved for transport-level failures (no
      // response from the server at all, or SDK client unavailable).
      const msg = err instanceof Error ? err.message : String(err)
      this.deps.log(`Terminal close transport error (${terminalId}): ${msg}`)
    }
  }

  /**
   * Kill every managed terminal. Invoked from AgentManagerProvider.dispose()
   * so PTYs do not outlive a webview drop that bypasses the explicit close
   * messages.
   *
   * Failure modes we surface in the log:
   *   - The SDK client is unavailable (connection service already torn
   *     down). We can't reach the server to call `pty.remove`; the
   *     server-side PTYs are then only reaped when `kilo serve` itself
   *     dies, which ServerManager does on extension deactivate via
   *     SIGTERM → SIGKILL on the process group. OS kills every child.
   *   - Individual `pty.remove` requests error (404 because the server
   *     already cleaned up, or network blip). Logged per-entry and then
   *     summarized with a "may leak" notice so it's obvious something
   *     slipped through.
   *
   * In-memory `entries` is cleared only at the end — we want to hold
   * onto the records while the async removal is in flight so we don't
   * lose track if dispose() is called twice concurrently or the process
   * is sampled mid-shutdown.
   */
  async dispose(): Promise<void> {
    const snapshot = [...this.entries.values()]
    if (snapshot.length === 0) {
      this.entries.clear()
      return
    }
    this.deps.log(`Disposing ${snapshot.length} terminal(s)`)
    const connection = this.conn()
    // No control path at all (private absent-or-unavailable plus SDK client
    // torn down): fall back to the `kilo serve` process-group kill, same as
    // the null-connection branch. A live private peer still attempts per-entry
    // private cleanup first, so it skips this branch.
    const usable = ((): boolean => {
      try {
        return !!connection?.isPrivateAvailable()
      } catch {
        return false
      }
    })()
    if (!usable) {
      try {
        this.deps.getClient()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.deps.log(
          `Terminal dispose: SDK client unavailable (${msg}); relying on kilo serve process-group kill to reap PTYs`,
        )
        this.entries.clear()
        return
      }
    }
    const results = await Promise.all(
      snapshot.map(async (entry) => {
        try {
          const out = await removePtyPrivateFirst({
            connection,
            getClient: () => this.deps.getClient() as unknown as PtySdkClient,
            directory: entry.cwd,
            ptyID: entry.ptyID,
          })
          if (out.kind === "ok") return { ok: true as const, entry }
          if (out.kind === "terminal") return { ok: false as const, entry, err: `code=${out.code}` }
          return { ok: false as const, entry, err: out.error }
        } catch (err) {
          return { ok: false as const, entry, err }
        }
      }),
    )
    let failed = 0
    for (const r of results) {
      if (r.ok) continue
      failed++
      const msg = r.err instanceof Error ? r.err.message : String(r.err)
      this.deps.log(`Terminal dispose cleanup failed (${r.entry.terminalId}): ${msg}`)
    }
    if (failed > 0) {
      this.deps.log(`Terminal dispose: ${failed}/${snapshot.length} PTYs may linger until kilo serve exits`)
    }
    this.entries.clear()
  }
}
