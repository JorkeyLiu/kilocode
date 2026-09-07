import { isAbsolute, normalize, resolve } from "path"

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
