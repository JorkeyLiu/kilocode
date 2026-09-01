/**
 * Pure direct-execution gate.
 *
 * Single implementation of `isDirectExecution`. Source/import is always
 * false; a launcher-built CJS bundle with `define: { __KILO_E2E_BUNDLE__:
 * "true" }` evaluates true only when executed directly via `node out.cjs`.
 */

declare const __KILO_E2E_BUNDLE__: boolean | undefined

export function isDirectExecution(): boolean {
  const b = (import.meta as unknown as { main?: boolean }).main
  if (typeof b === "boolean") return b
  try {
    if (typeof __KILO_E2E_BUNDLE__ !== "undefined" && __KILO_E2E_BUNDLE__) {
      const r = typeof require !== "undefined" ? (require as unknown as { main?: unknown }) : undefined
      const m = typeof module !== "undefined" ? (module as unknown as { filename?: string }) : undefined
      if (r && m && (r as { main: unknown }).main === m) return true
      const a = (r as { main?: { filename?: string } } | undefined)?.main?.filename
      const c = (m as { filename?: string } | undefined)?.filename
      if (a && c && a === c) return true
    }
  } catch (err) {
    void err
    return false
  }
  return false
}
