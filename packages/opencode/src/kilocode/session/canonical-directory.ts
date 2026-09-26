import { isAbsolute, normalize as normalizePath, resolve } from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"

export function canonicalDirectory(dir: string): string {
  if (typeof dir !== "string" || !isAbsolute(dir)) throw new Error("context.directory must be absolute path")
  if (dir.includes("\0")) throw new Error("context.directory must not contain null bytes")
  const normalized = normalizePath(resolve(dir))
  if (!isAbsolute(normalized)) throw new Error("context.directory must be absolute path")
  return normalized
}

// Authoritative directory write boundary: lexical validation first via
// `canonicalDirectory` (rejects relative/null-byte), then `FSUtil.resolve`
// realpath with ENOENT fallback — identical constraints to `InstanceStore`
// cache keys. New `SessionTable`/`session_operation` rows must store this
// spelling so observation/SQLite reads (which resolve the same way) match.
export function authoritativeDirectory(dir: string): string {
  const canon = canonicalDirectory(dir)
  return FSUtil.resolve(canon)
}

// Same-physical comparison for scope checks and legacy-row convergence.
// Throws on invalid spelling so callers map stored-shape failures to
// `internal` and request-shape failures to validation, never to equality.
export function samePhysicalDirectory(a: string, b: string): boolean {
  return FSUtil.resolve(canonicalDirectory(a)) === FSUtil.resolve(canonicalDirectory(b))
}
