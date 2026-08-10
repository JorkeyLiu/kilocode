import { getVSCodeAPI } from "../context/vscode"

/**
 * Opt-in P0 perf instrumentation (webview side).
 *
 * Enabled only when the extension injected `window.__KILO_P0_PERF__ = true`
 * into the webview HTML (KILO_P0_PERF env flag on the extension host). When
 * off, `p0WebviewStage` is a no-op and nothing is posted.
 *
 * Records are posted to the extension as `{ type: "p0Perf", stage, t, wd }`
 * and emitted by the extension into the shared [Kilo New][P0-Perf] JSON stream
 * with the activation correlation id attached.
 */

declare global {
  interface Window {
    __KILO_P0_PERF__?: boolean
  }
}

const ENABLED = typeof window !== "undefined" && window.__KILO_P0_PERF__ === true
const T0 = typeof window !== "undefined" ? Date.now() : 0

/** Record a webview stage: `t` = wall-clock epoch ms, `wd` = ms since webview module load. */
export function p0WebviewStage(stage: string, extra?: Record<string, unknown>): void {
  if (!ENABLED) return
  const t = Date.now()
  const wd = Math.round((t - T0) * 100) / 100
  getVSCodeAPI().postMessage({ type: "p0Perf", stage, t, wd, ...(extra ?? {}) })
}
