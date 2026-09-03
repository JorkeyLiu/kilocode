import fs from "node:fs/promises"
import path from "node:path"
import { xdgData } from "xdg-basedir"
import { ForkSeam } from "@/kilocode/session/fork-seam"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "claimed-file" })

export interface ClaimedHandle {
  readonly target: string
  cleanup(): Promise<boolean>
}

export class ClaimedWriteError extends Error {
  readonly target: string
  override readonly cause: unknown
  readonly handle: ClaimedHandle
  constructor(target: string, cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause)
    super(msg, cause instanceof Error ? { cause } : undefined)
    this.name = "ClaimedWriteError"
    this.target = target
    this.cause = cause
    this.handle = {
      target,
      cleanup: async () => {
        try {
          await fs.rm(target, { force: true })
          return true
        } catch (rmErr) {
          log.warn("claimed-file cleanup failed", { target, cause: String(rmErr) })
          return false
        }
      },
    }
    if (cause instanceof Error && cause.stack) this.stack = cause.stack
  }
}

export function isClaimedWriteError(err: unknown): err is ClaimedWriteError {
  return err instanceof ClaimedWriteError
}

/**
 * Smallest claimed-file primitive for fork ownership.
 * Establishes ownership immediately when an exclusive file handle is acquired
 * (O_CREAT | O_EXCL | O_WRONLY via "wx"), writes/closes through that handle.
 * Preserves atomic no-overwrite semantics (EEXIST on existing target).
 * Any claim/write uncertainty fails closed.
 * On post-open write/close failure, transfers a claim/cleanup handle to the
 * caller via ClaimedWriteError so the caller retains owner state and can
 * log/retry cleanup without swallowing the original error. Internal rm is
 * not attempted here; the caller owns cleanup via handle.cleanup() and
 * retains ownership until success.
 */
export async function writeExclusiveJson(target: string, content: unknown): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true })
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(target, "wx", 0o600)
  } catch (e) {
    throw e
  }
  // ownership claimed at handle acquisition
  try {
    if ((ForkSeam as unknown as { failClaimedWriteAfterOpen?: boolean }).failClaimedWriteAfterOpen) {
      throw new Error("injected claimed write failure")
    }
    const data = JSON.stringify(content, null, 2)
    await handle.writeFile(data, "utf8")
    await handle.close()
    handle = undefined
  } catch (e) {
    if (handle) {
      try {
        await handle.close()
      } catch (closeErr) {
        log.warn("claimed-file close failed", { target, cause: String(closeErr) })
      }
      handle = undefined
    }
    throw new ClaimedWriteError(target, e)
  }
}

function defaultDataDir(): string {
  const clean = (p: string | undefined) => p?.replace(/[\r\n]+/g, "")
  const base = clean(xdgData)
  if (!base) throw new Error("xdgData not available for storage path")
  return path.join(base, "kilo")
}

export function storageFileForKey(key: string[], baseDir?: string): string {
  // Bundler-safe storage layout: Global.Path.data/storage/<key...>.json
  // Uses xdg-basedir directly to avoid top-level-await Global dependency in compile.
  // Callers may inject baseDir (e.g., Global.Path.data) to preserve test isolation.
  const base = baseDir ?? defaultDataDir()
  return path.join(base, "storage", ...key) + ".json"
}
