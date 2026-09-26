import { isAbsolute, normalize, resolve } from "path"
import { realpathSync } from "node:fs"

/**
 * Mirrors `packages/opencode/src/kilocode/session/canonical-directory.ts`.
 * Lexical canonicalization: `normalize(resolve(dir))`, no `realpath`.
 * Keeps stored `SessionTable.directory` rows addressable by their exact
 * lexical spelling, including symlink-spelled persisted rows.
 */
export function canonicalDirectory(dir: string): string {
  if (typeof dir !== "string" || !isAbsolute(dir)) throw new Error("context.directory must be absolute path")
  if (dir.includes("\0")) throw new Error("context.directory must not contain null bytes")
  const normalized = normalize(resolve(dir))
  if (!isAbsolute(normalized)) throw new Error("context.directory must be absolute path")
  return normalized
}

function resolvePhysical(p: string): string {
  try {
    return realpathSync(p)
  } catch (e: unknown) {
    if ((e as { code?: string })?.code === "ENOENT") return p
    throw e
  }
}

// Authoritative write/read boundary for the standalone worker: lexical
// validation first, then realpath with ENOENT fallback — same constraints as
// backend `FSUtil.resolve` / `InstanceStore` keys.
export function authoritativeDirectory(dir: string): string {
  return resolvePhysical(canonicalDirectory(dir))
}

export function samePhysicalDirectory(a: string, b: string): boolean {
  return resolvePhysical(canonicalDirectory(a)) === resolvePhysical(canonicalDirectory(b))
}
