/**
 * Serve-side guardian launcher (owner side).
 *
 * Prelaunch ownership: every nonpersistent spawn launches the guardian
 * command INSTEAD of the actual child; the guardian admits parent
 * liveness + owns cleanup BEFORE starting the target. There is no
 * after-spawn attach and no async poll that can miss SIGKILL/install
 * races — the target cannot run before the guardian owns it.
 *
 * Fail-closed admission: when wrapping is required (private runtime with
 * a valid token) but the guardian command is absent/invalid or the
 * guardian spawn itself fails, the launch throws and the target is
 * NEVER started (no side effect). Inactive wrapping (no token,
 * inside a guardian, explicit opt-out, persistent bypass, source-only
 * CLI without the private marker) spawns directly, unchanged.
 *
 * Static resolution only: the guardian command comes from the
 * KILO_GUARDIAN_CMD published entry (source+compiled self resolution
 * via KiloPtySelfCommand, published by the serve entry). No late
 * dynamic imports, no catch-ignored fallbacks on the wrap path.
 */
import { spawn as spawnChild, type ChildProcess, type SpawnOptions, type StdioOptions } from "child_process"
import { KiloPtySelfCommand } from "@/kilocode/pty/self-command"
import { birthOf, encodeWrapTarget, GUARDIAN_CMD_ENV, GUARDIAN_ENV, GUARDIAN_MARKER, GUARDIAN_OPT_OUT, type GuardianWrapTarget } from "./guardian"
import { isValidRuntimeToken, readRuntimeToken } from "@/kilocode/runtime-token"

export type WrappedSpawn = {
  cmd: string
  args: string[]
}

function guardianBase(): { cmd: string; base: string[] } | undefined {
  const fromEnv = process.env[GUARDIAN_CMD_ENV]
  if (fromEnv) {
    try {
      const parsed: unknown = JSON.parse(fromEnv)
      if (Array.isArray(parsed) && typeof parsed[0] === "string" && parsed.every((x) => typeof x === "string")) {
        return { cmd: parsed[0] as string, base: (parsed as string[]).slice(1) }
      }
    } catch {
      return undefined
    }
    return undefined
  }
  try {
    const self = KiloPtySelfCommand.command()
    return { cmd: self.command, base: self.args }
  } catch {
    return undefined
  }
}

/** Publish the resolved self command so core (no opencode import) can wrap. */
export function publishGuardianCmd(): void {
  if (process.env[GUARDIAN_CMD_ENV]) return
  const base = guardianBase()
  if (!base) return
  try {
    process.env[GUARDIAN_CMD_ENV] = JSON.stringify([base.cmd, ...base.base])
  } catch {}
}

export function supervisionActive(): boolean {
  if (process.env[GUARDIAN_ENV] === "1") return false
  if (process.argv.includes(GUARDIAN_MARKER)) return false
  if (process.env[GUARDIAN_OPT_OUT] === "0") return false
  return isValidRuntimeToken(readRuntimeToken())
}

/**
 * Whether this spawn must wrap (private runtime, nonpersistent). The
 * persistent bypass and source-only CLI (no token) return false and
 * spawn directly.
 */
export function shouldWrap(opts?: { supervise?: boolean; persistent?: boolean }): boolean {
  if (opts?.supervise === false) return false
  if (opts?.persistent === true) return false
  return supervisionActive()
}

function tokenOracle(): string[] {
  const t = readRuntimeToken()
  return t && isValidRuntimeToken(t) ? ["--token", `${"KILO_RUNTIME_TOKEN"}=${t}`] : []
}

/**
 * Build the guardian command for a target. Throws (fail closed, no
 * target side effect) when wrapping is required but the guardian
 * command is absent/invalid.
 */
export function guardianCommandFor(target: GuardianWrapTarget): WrappedSpawn {
  const base = guardianBase()
  if (!base) throw new Error("Process guardian unavailable: KILO_GUARDIAN_CMD is absent or invalid; refusing to launch target without ownership")
  // Fail closed when the owner birth is unobtainable: a foreign reused
  // parent must never be deemed alive (no optional omission on supported
  // platforms, no target side effect).
  const parentBirth = birthOf(process.pid)
  if (!parentBirth) throw new Error("Process guardian unavailable: owner start identity unobtainable; refusing to launch target without ownership")
  return {
    cmd: base.cmd,
    args: [
      ...base.base,
      GUARDIAN_MARKER,
      "--cmd-b64",
      encodeWrapTarget(target),
      "--parent-pid",
      String(process.pid),
      "--parent-birth",
      parentBirth,
      ...tokenOracle(),
    ],
  }
}

/**
 * Spawn the guardian INSTEAD of the target (prelaunch ownership).
 * Throws without launching the target when the install is
 * absent/invalid or the guardian spawn fails. The caller keeps the
 * guardian handle: pid is the owned group leader (POSIX pgid), stdio
 * pipes connect directly to the target via inherit proxy, and SIGTERM
 * to the guardian reaps the owned tree.
 */
export function spawnWrapped(
  target: GuardianWrapTarget,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; stdio: StdioOptions; detached?: boolean; windowsHide?: boolean },
): ChildProcess {
  const wrapped = guardianCommandFor(target)
  let guardian: ChildProcess
  try {
    const spawnOpts: SpawnOptions = {
      cwd: opts.cwd,
      env: opts.env,
      stdio: opts.stdio,
      detached: opts.detached ?? process.platform !== "win32",
      windowsHide: opts.windowsHide ?? process.platform === "win32",
    }
    guardian = spawnChild(wrapped.cmd, wrapped.args, spawnOpts)
  } catch (err) {
    throw new Error(`Process guardian spawn failed, target not launched: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!guardian.pid) {
    // The failed spawn emits 'error' asynchronously; swallow it so the
    // fail-closed throw below is the only signal (no unhandled event).
    try {
      guardian.on("error", () => {})
    } catch {}
    try {
      guardian.kill("SIGKILL")
    } catch {}
    throw new Error("Process guardian spawn produced no pid, target not launched")
  }
  return guardian
}
