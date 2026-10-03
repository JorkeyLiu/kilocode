/**
 * kilocode_change - owned termination (F-E same-bound force escalation).
 *
 * Same bound as the core cross-spawn spawner: normal wrapped release
 * signals the exact guardian PID only (never a negative-pid group kill,
 * never taskkill); only the final force may tear down the whole owned
 * tree, and only after independent verification (retained handle alive
 * + expected birth + pgid === pid). Without proof it fails closed with
 * an explicit error (PID best-effort, never a guessed shared/dead
 * group). Win32 stays PID-only: the native job owns the tree, no
 * on-platform group claim and no guessed taskkill here.
 *
 * Borrowed proof: birth/group primitives come from
 * `@opencode-ai/core/kilocode/process-birth` (no duplication). No new
 * coordination, journal, or resources: bounded polling only.
 */
import { birthOf, groupMembers, owned as verifyOwned } from "@opencode-ai/core/kilocode/process-birth"
import type { ChildProcess } from "node:child_process"

const births = new WeakMap<ChildProcess, { birth: string | undefined }>()

export function registerOwned(proc: ChildProcess): void {
  const pid = proc.pid
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    births.set(proc, { birth: undefined })
    return
  }
  births.set(proc, { birth: birthOf(pid) })
}

export function isOwned(proc: ChildProcess): boolean {
  return births.has(proc)
}

export function birthFor(proc: ChildProcess): string | undefined {
  return births.get(proc)?.birth
}

function gone(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null
}

function code(err: unknown): string | undefined {
  if (!err || typeof err !== "object" || !("code" in err)) return undefined
  const v = (err as { code?: unknown }).code
  return typeof v === "string" ? v : undefined
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitExit(proc: ChildProcess, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (gone(proc)) return true
    await sleep(50)
  }
  return gone(proc)
}

async function waitEmpty(pgid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const rest = groupMembers(pgid)
    if (rest.length === 0) return true
    await sleep(50)
  }
  return groupMembers(pgid).length === 0
}

/**
 * Normal wrapped release: exact guardian PID only, never a group.
 * ESRCH (already gone) counts as success; anything else throws explicit.
 */
export function termOwned(proc: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  const pid = proc.pid
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    throw new Error("Owned guardian has no pid; cannot signal owned tree")
  }
  try {
    process.kill(pid, signal)
  } catch (err) {
    if (code(err) === "ESRCH") return
    throw new Error(`Owned guardian TERM failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Final force: verified owned-group SIGKILL then drain. Awaits group
 * empty and child exit before resolving. Unverified/stale fails closed
 * with an explicit error after PID best-effort (never a group guess).
 * Win32 is PID SIGKILL only (job owns the tree, no taskkill here).
 */
export async function forceOwned(proc: ChildProcess, opts?: { groupMs?: number; exitMs?: number }): Promise<void> {
  const groupMs = opts?.groupMs ?? 3000
  const exitMs = opts?.exitMs ?? 5000
  if (gone(proc)) return
  const pid = proc.pid
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    throw new Error("Owned guardian has no pid; cannot verify owned group, tree may survive")
  }
  if (process.platform === "win32") {
    try {
      process.kill(pid, "SIGKILL")
    } catch (err) {
      if (code(err) === "ESRCH") return
      throw new Error(`Owned guardian SIGKILL failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    const out = await waitExit(proc, exitMs)
    if (!out) throw new Error(`Owned guardian ${pid} survived SIGKILL; retaining authority, tree may survive`)
    return
  }
  const check = verifyOwned(pid, birthFor(proc))
  if (!check.ok) {
    try {
      process.kill(pid, "SIGKILL")
    } catch (err) {
      if (code(err) !== "ESRCH") {
        throw new Error(`Owned guardian group unverified (${check.reason}); PID SIGKILL failed, tree may survive`)
      }
    }
    await waitExit(proc, exitMs)
    throw new Error(`Owned guardian group unverified (${check.reason}); PID SIGKILL best-effort only, tree may survive`)
  }
  const pgid = check.pgid
  try {
    process.kill(-pgid, "SIGKILL")
  } catch (err) {
    if (code(err) !== "ESRCH") {
      throw new Error(`Owned group ${pgid} SIGKILL failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const empty = await waitEmpty(pgid, groupMs)
  if (!empty) throw new Error(`Owned group ${pgid} survived SIGKILL; retaining authority, tree may survive`)
  const out = await waitExit(proc, exitMs)
  if (!out) throw new Error(`Owned guardian ${pid} survived group SIGKILL; retaining authority, tree may survive`)
}

/**
 * Post-exit drain check for the owned leader: never guesses a group
 * from a dead leader beyond membership observation. Resolves when the
 * owned group is empty, rejects explicit when members linger.
 */
export async function drainOwnedAfterExit(proc: ChildProcess, ms = 3000): Promise<void> {
  if (!isOwned(proc)) return
  if (process.platform === "win32") return
  const pid = proc.pid
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return
  const rest = groupMembers(pid)
  if (rest.length === 0) return
  const empty = await waitEmpty(pid, ms)
  if (!empty) {
    const count = groupMembers(pid).length
    throw new Error(`Owned guardian exited with ${count} group member(s) still alive; retaining authority, no group guess`)
  }
}
