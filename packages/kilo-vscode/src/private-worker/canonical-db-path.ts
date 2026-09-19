import * as path from "path"
import * as os from "os"

/**
 * R9 production-enablement helper — canonical DB path resolver.
 *
 * Mirrors the migration runtime's canonical single-database identity:
 * `Global.Path.data/kilo.db` with `KILO_DISABLE_CHANNEL_DB=1` semantics
 * (i.e., the bridge's channel-disabled identity), not a config root or
 * extension globalStorage DB.
 *
 * Pure, testable, injectable for unit tests:
 * - Resolves XDG_DATA_HOME/kilo/kilo.db when XDG_DATA_HOME is set
 *   (mirrors `xdg-basedir` via `process.env.XDG_DATA_HOME || homedir/.local/share`)
 * - Falls back to `<homedir>/.local/share/kilo/kilo.db`
 * - Strips CR/LF defensively (mirrors `Global.Path` clean)
 * - Returns an absolute path when inputs are absolute (required by gate)
 * - No side effects, no singleton, no polling, no storage mutation
 */

function clean(p: string | undefined): string | undefined {
  return p?.replace(/[\r\n]+/g, "")
}

export function resolveCanonicalDataDir(opts?: { env?: NodeJS.ProcessEnv; homedir?: string }): string {
  const env = opts?.env ?? process.env
  const home = opts?.homedir ?? os.homedir()
  const raw = env.XDG_DATA_HOME
  const cleaned = clean(raw)
  // Strictly canonical absolute: only absolute XDG is accepted, mirrors xdg-basedir with absolute guard
  const xdgAbsolute = cleaned && cleaned.length > 0 && path.isAbsolute(cleaned) ? cleaned : undefined
  const base = xdgAbsolute ?? (home ? path.join(clean(home)!, ".local", "share") : undefined)
  if (!base) throw new Error("Unable to resolve canonical data dir: no XDG_DATA_HOME and no homedir")
  if (!path.isAbsolute(base)) throw new Error("Unable to resolve canonical data dir: base is not absolute")
  return path.join(base, "kilo")
}

export function resolveCanonicalDbPath(opts?: { env?: NodeJS.ProcessEnv; homedir?: string }): string {
  return path.join(resolveCanonicalDataDir(opts), "kilo.db")
}
