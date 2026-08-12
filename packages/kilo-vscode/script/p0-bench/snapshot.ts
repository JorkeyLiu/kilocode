/**
 * Immutable per-campaign CLI snapshot for the P0 extension benchmark.
 *
 * A non-owned dev watcher (script/watch-cli.ts) rebuilds and overwrites
 * `packages/kilo-vscode/bin/kilo` on source changes, which changed the measured
 * binary's provenance mid-campaign. Before any sample runs, the harness copies
 * the current `bin/kilo` to a run-owned temporary campaign path, computes its
 * SHA, and pins that exact path through the benchmark-only `KILO_P0_BACKEND_CLI`
 * env override to ServerManager (which prefers the override only when
 * explicitly set and otherwise falls back to the bundled binary — production
 * behavior is unchanged). The watcher may keep running; it can no longer alter
 * the measured binary.
 *
 * Provenance race: the watcher can overwrite bin/kilo WHILE it is being
 * snapshotted. The source SHA/size are therefore re-read AFTER the copy and
 * compared against the freshly written snapshot; a mismatch means the snapshot
 * is not a faithful copy of the current source, so the campaign fails before
 * launch rather than measuring a binary it cannot pin.
 *
 * Ownership + bounds:
 *   - The snapshot lives under a run-owned `mkdtemp` directory (os.tmpdir, NOT
 *     the versioned evidence dir — the ~150 MB binary never enters versioned
 *     evidence).
 *   - Validation happens BEFORE the campaign starts: the source must exist, be
 *     executable, and pass the post-copy provenance check, otherwise the
 *     benchmark fails safely before launch.
 *   - The run-owned snapshot directory is deleted only after the campaign
 *     finishes or fails (caller invokes `cleanup()` in a finally).
 */

import { createHash } from "node:crypto"
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import type { CliSnapshotInfo } from "./types"

export interface CliSnapshot {
  info: CliSnapshotInfo
  /** Delete the run-owned snapshot directory (idempotent). */
  cleanup: () => void
}

/** sha256 of a file, or null when it cannot be read. */
function sha256File(file: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex")
  } catch {
    return null
  }
}

/**
 * Copy `sourcePath` to a fresh run-owned temp dir and record full provenance.
 * Throws when the source is missing, not executable, or changed while it was
 * being copied (post-copy source re-read) — the campaign fails before any
 * sample launches (never measure a binary we cannot pin).
 */
export function createCliSnapshot(sourcePath: string, tmpRoot: string): CliSnapshot {
  const sourceStat = statSync(sourcePath) // throws → fail before launch when missing
  const dir = mkdtempSync(join(tmpRoot, "kilo-p0-cli-"))
  const snapshotPath = join(dir, "kilo")
  try {
    copyFileSync(sourcePath, snapshotPath)
    chmodSync(snapshotPath, sourceStat.mode & 0o777)
    const executable = (statSync(snapshotPath).mode & 0o111) !== 0
    if (!executable) {
      throw new Error(`[p0-bench] CLI snapshot not executable after copy: ${snapshotPath}`)
    }
    // Provenance pin: hash the snapshot, then re-read the source AFTER the
    // copy and fail when its SHA/size no longer matches. The non-owned watcher
    // may have overwritten bin/kilo between the copy and this re-read; a
    // mismatch means the snapshot is not a faithful copy of the current
    // source, so refuse to launch rather than measure an unpinnable binary.
    const snapshotSha = sha256File(snapshotPath)
    const snapshotSize = statSync(snapshotPath).size
    const sourceAfter = sha256File(sourcePath)
    const sourceSizeAfter = statSync(sourcePath).size
    if (!snapshotSha || !sourceAfter || snapshotSha !== sourceAfter || snapshotSize !== sourceSizeAfter) {
      throw new Error(
        `[p0-bench] CLI snapshot provenance mismatch: source ${sourcePath} changed while it was being ` +
          `snapshotted (sourceSha256=${sourceAfter ? sourceAfter.slice(0, 12) : "unreadable"} ` +
          `snapshotSha256=${snapshotSha ? snapshotSha.slice(0, 12) : "unreadable"} ` +
          `sourceSize=${sourceSizeAfter} snapshotSize=${snapshotSize}) — refusing to launch on an unpinnable binary`,
      )
    }
    const info: CliSnapshotInfo = {
      sourcePath,
      snapshotPath,
      sourceSha256: sourceAfter,
      snapshotSha256: snapshotSha,
      sourceSize: sourceSizeAfter,
      snapshotSize,
      createdAt: Date.now(),
    }
    return {
      info,
      cleanup: () => {
        rmSync(dir, { recursive: true, force: true })
      },
    }
  } catch (err) {
    rmSync(dir, { recursive: true, force: true })
    throw err
  }
}

/** True when a candidate snapshot source is usable (exists + executable). */
export function cliSnapshotSourceUsable(sourcePath: string): boolean {
  if (!existsSync(sourcePath)) return false
  try {
    return (statSync(sourcePath).mode & 0o111) !== 0
  } catch {
    return false
  }
}
