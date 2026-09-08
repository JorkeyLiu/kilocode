// Test-only serialization for the two B5 production integration tests
// (LOCK-B5-005). Both tests mutate process-global VS Code (`vscode.workspace`)
// and environment (`XDG_DATA_HOME`/`KILO_DB`) state, so their whole
// global-mutation lifecycle (setup, use, restoration) must not interleave
// across files, whether the runner shares one process (in-memory queue) or
// isolates files in workers (directory lock).
//
// Directory-lock protocol (LOCK-B5-006): the lock directory itself is the
// exclusivity primitive. Atomic `mkdir` acquires it; no cooperative contender
// can create a successor until the owner removes the directory with `rmdir`.
// Owner metadata lives inside the acquired directory (`owner.json`). Release
// verifies the metadata belongs to the current owner, unlinks only that owned
// metadata file, then removes the now-empty directory with non-recursive
// `rmdir`. A successor `mkdir` is therefore gated on directory removal, so a
// normal release cannot unlink a successor/foreign lock: no fixed-path
// read/compare/unlink of the outer lock pathname exists. A metadata
// mismatch, missing metadata, or failed `rmdir` throws and leaves existing
// state in place (fail closed); the lock directory is never removed
// recursively. No automatic stale recovery exists: a foreign, partial,
// unparseable, or orphaned (including empty) directory is never deleted by
// any path and blocks acquisition until timeout (LOCK-B5-007). A
// crashed/partially-created lock therefore fails closed with an actionable
// timeout; manual inspection/removal is the only recovery, never automatic
// reclaim.
import * as crypto from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

const dir = path.join(os.tmpdir(), "kilo-b5-global-serialization")
const owner = path.join(dir, "owner.json")

let tail: Promise<void> = Promise.resolve()

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForLock(start: number, timeoutMs: number, releaseMem: () => void): Promise<void> {
  if (Date.now() - start > timeoutMs) {
    releaseMem()
    throw new Error(
      `timed out acquiring B5 global lock: ${dir} is held by another owner; by design an abandoned lock blocks until timeout (fail closed) — inspect and manually remove the lock directory if its owner is provably gone`,
    )
  }
  await sleep(50)
}

export async function acquireB5GlobalLock(timeoutMs = 120_000): Promise<() => Promise<void>> {
  const prev = tail
  let releaseMem!: () => void
  const next = new Promise<void>((resolve) => {
    releaseMem = resolve
  })
  tail = next
  await prev
  const token = `${process.pid}:${crypto.randomUUID()}`
  const payload = JSON.stringify({ pid: process.pid, token, createdAt: Date.now() })
  const start = Date.now()
  while (true) {
    try {
      fs.mkdirSync(dir)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code !== "EEXIST") {
        // Fail closed: the directory could not be created for a reason other
        // than a live holder. Never delete; just release the memory slot.
        releaseMem()
        throw err
      }
      // Lock directory held by another owner (including partial/unparseable
      // metadata or an empty orphaned directory): never read/reclaim/delete;
      // wait bounded until timeout.
      await waitForLock(start, timeoutMs, releaseMem)
      continue
    }
    // Directory created by this holder: it is the exclusive owner of the
    // pathname. Record ownership inside it.
    try {
      fs.writeFileSync(owner, payload, { flag: "wx" })
      break
    } catch (err) {
      // Partial owner creation: this holder owns the newly-created directory
      // but failed to record metadata (EEXIST here means a non-cooperative
      // actor planted a file inside the fresh directory). Never unlink a
      // potential foreign file and never remove recursively. The only
      // defensible cleanup is a non-recursive rmdir, which succeeds solely
      // for an empty directory this holder created and fails closed
      // (ENOTEMPTY/ENOENT) when foreign content exists.
      try {
        fs.rmdirSync(dir)
      } catch (cleanup) {
        // Cleanup failed: leave state fail-closed and surface diagnostically;
        // the primary metadata error below remains the acquisition failure.
        console.warn(
          `B5 global lock cleanup failed to remove owned lock directory after owner metadata failure: ${(cleanup as Error)?.message ?? String(cleanup)}; primary: ${(err as Error)?.message ?? String(err)}`,
        )
      }
      releaseMem()
      throw err
    }
  }
  let released = false
  return async () => {
    if (released) return
    released = true
    let cur: string | null = null
    try {
      cur = fs.readFileSync(owner, "utf8")
    } catch (err) {
      releaseMem()
      throw new Error(`B5 global lock release found no owner metadata: ${(err as Error)?.message ?? String(err)}`)
    }
    if (cur !== payload) {
      // Foreign/mismatched metadata: leave the directory and its content
      // intact. No successor can exist yet because its mkdir is gated on
      // rmdir of this directory; refusing here cannot strand a successor.
      releaseMem()
      throw new Error("B5 global lock release refused: owner metadata records a different owner; left intact")
    }
    try {
      fs.unlinkSync(owner)
    } catch (err) {
      // Owned metadata could not be removed: the directory still gates
      // cross-worker entry, so releasing only the memory slot cannot admit
      // an unsafe successor. Surface the failure instead of swallowing it.
      releaseMem()
      throw new Error(
        `B5 global lock release failed to remove owned metadata: ${(err as Error)?.message ?? String(err)}`,
      )
    }
    try {
      fs.rmdirSync(dir)
    } catch (err) {
      // Directory removal failed after owned metadata was removed (for
      // example a foreign file was planted, or the directory was replaced).
      // Never retry with recursive removal; the remaining directory (even if
      // empty/orphaned) intentionally fails closed until manual inspection.
      releaseMem()
      throw new Error(
        `B5 global lock release failed to remove owned lock directory: ${(err as Error)?.message ?? String(err)}`,
      )
    }
    releaseMem()
  }
}

async function withB5GlobalLock<T>(fn: () => Promise<T>): Promise<T> {
  const release = await acquireB5GlobalLock()
  try {
    return await fn()
  } finally {
    await release()
  }
}
