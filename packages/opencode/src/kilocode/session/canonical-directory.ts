import { isAbsolute, normalize as normalizePath, resolve } from "path"

export function canonicalDirectory(dir: string): string {
  if (typeof dir !== "string" || !isAbsolute(dir)) throw new Error("context.directory must be absolute path")
  if (dir.includes("\0")) throw new Error("context.directory must not contain null bytes")
  const normalized = normalizePath(resolve(dir))
  if (!isAbsolute(normalized)) throw new Error("context.directory must be absolute path")
  return normalized
}
