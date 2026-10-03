/**
 * Ephemeral per-child process-resource guardian (NON-SERVING).
 *
 * Prelaunch command wrapper: the private runtime launches the guardian
 * command INSTEAD of the actual child. The guardian establishes parent
 * liveness + its own cleanup ownership FIRST, then starts the target
 * itself and retains the native handle/group/job until every member is
 * reaped. Real child code can never run before the guardian owns it —
 * refusal/failure aborts without launching the target (fail closed).
 *
 * POSIX: the owner spawns the guardian detached (new group, guardian is
 * the leader). The guardian spawns the target non-detached so it stays
 * in that exact group (pgid === guardian pid, a real pgid, never
 * invented). Stdio/env/cwd are proxied via inherit: the guardian is
 * spawned with the target's desired stdio modes + env + cwd, and the
 * target inherits them, so bytes flow owner<->target directly with no
 * shuttle. On target normal exit the guardian reaps late grandchildren
 * (group TERM then verified KILL) before exiting with the target's
 * code/signal. Signal handlers (SIGTERM/SIGINT = owner release) own the
 * same cleanup; the wrapper holds the native ChildProcess handle so no
 * birth-PID guessing is needed.
 *
 * Win32: the guardian creates the native KILL_ON_CLOSE job BEFORE
 * dispatch and assigns the actual child handle immediately after spawn
 * with an identity check (no suspended-spawn primitive in Node; the
 * assignment races a fork-escape window structurally, never silently).
 * Failure before/at dispatch aborts the target (exact-pid kill of our
 * own child only, never a foreign PID, never a reassignment) and exits
 * non-zero with no fake coverage. Holding the job is a structural code
 * claim (Windows execution evidence is unavailable on POSIX hosts).
 *
 * Same shipped kilo-serve __process-guardian prebootstrap mode: no
 * DB/AppLayer/config, no sessions, no persistent state. Argv carries
 * only the target spec + parent identity + token oracle for the
 * extension census (exact boundaries, env -i safe, Windows CIM safe).
 *
 * Explicit `persistent` BackgroundProcess work and source-only CLI
 * without the private marker never wrap (unchanged bypass).
 */
import { spawnSync, type ChildProcess, type SpawnOptions, type StdioOptions } from "child_process"
import launch from "cross-spawn"
import * as fs from "fs"
import * as path from "path"

export const GUARDIAN_MARKER = "__process-guardian"
export const GUARDIAN_ENV = "KILO_GUARDIAN"
export const GUARDIAN_CMD_ENV = "KILO_GUARDIAN_CMD"
export const GUARDIAN_OPT_OUT = "KILO_PROCESS_GUARDIAN"

export type GuardianWrapTarget = {
  cmd: string
  args: string[]
  shell?: boolean | string
  extraFds?: number[]
}

export type GuardianArgs = {
  mode: "wrap"
  target: GuardianWrapTarget
  parentPid: number
  parentBirth?: string
  token?: string
}

function num(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

function b64urlDecode(value: string): string {
  const pad = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4))
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64").toString("utf8")
}

export function b64urlEncode(text: string): string {
  return Buffer.from(text, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function encodeWrapTarget(target: GuardianWrapTarget): string {
  return b64urlEncode(JSON.stringify({ cmd: target.cmd, args: target.args, shell: target.shell ?? false, extraFds: target.extraFds ?? [] }))
}

export function decodeWrapTarget(raw: string): GuardianWrapTarget | undefined {
  try {
    const value: unknown = JSON.parse(b64urlDecode(raw))
    if (!value || typeof value !== "object") return undefined
    const rec = value as { cmd?: unknown; args?: unknown; shell?: unknown; extraFds?: unknown }
    if (typeof rec.cmd !== "string" || rec.cmd.length === 0) return undefined
    if (!Array.isArray(rec.args) || !rec.args.every((x) => typeof x === "string")) return undefined
    const shell = typeof rec.shell === "string" || typeof rec.shell === "boolean" ? rec.shell : false
    const extraFds = Array.isArray(rec.extraFds)
      ? rec.extraFds.filter((x): x is number => Number.isInteger(x) && (x as number) >= 3 && (x as number) <= 64)
      : []
    return { cmd: rec.cmd, args: rec.args as string[], shell, extraFds: [...new Set(extraFds)].toSorted((a, b) => a - b) }
  } catch {
    return undefined
  }
}

export function parseGuardianArgv(argv: string[]): (GuardianArgs & { isGuardian: boolean }) | undefined {
  const at = argv.indexOf(GUARDIAN_MARKER)
  if (at < 0) return undefined
  const rest = argv.slice(at + 1)
  const get = (name: string) => {
    const i = rest.indexOf(name)
    return i >= 0 ? rest[i + 1] : undefined
  }
  const parentPid = num(get("--parent-pid"))
  const spec = get("--cmd-b64")
  if (!parentPid || !spec) return undefined
  const target = decodeWrapTarget(spec)
  if (!target) return undefined
  const rawToken = get("--token")
  const token = rawToken?.startsWith("KILO_RUNTIME_TOKEN=") ? rawToken.slice("KILO_RUNTIME_TOKEN=".length) : rawToken
  return {
    isGuardian: true,
    mode: "wrap",
    target,
    parentPid,
    parentBirth: get("--parent-birth"),
    token,
  }
}

function errCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object" || !("code" in err)) return undefined
  const v = (err as { code?: unknown }).code
  return typeof v === "string" ? v : undefined
}

export function alive(pid: number): boolean {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Start-identity for PID-reuse guard. Undefined when unobtainable. */
export function birthOf(pid: number): string | undefined {
  if (process.platform === "linux") {
    try {
      const text = fs.readFileSync(path.join("/proc", String(pid), "stat"), "utf8")
      const end = text.lastIndexOf(")")
      if (end < 0) return undefined
      const fields = text
        .slice(end + 2)
        .trim()
        .split(/\s+/)
      const starttime = fields[19]
      return starttime !== undefined && starttime !== "" ? `${starttime}` : undefined
    } catch {
      return undefined
    }
  }
  if (process.platform === "darwin" || process.platform === "freebsd") {
    try {
      const out = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { windowsHide: true, encoding: "utf8" })
      const text = typeof out.stdout === "string" ? out.stdout.trim() : ""
      return text ? text : undefined
    } catch {
      return undefined
    }
  }
  if (process.platform === "win32") return windowsBirth(pid)
  return undefined
}

function windowsBirth(pid: number): string | undefined {
  try {
    const out = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($p) { [Console]::Out.Write($p.CreationDate) }`,
      ],
      { windowsHide: true, encoding: "utf8" },
    )
    const text = typeof out.stdout === "string" ? out.stdout.trim() : ""
    return text ? text : undefined
  } catch {
    return undefined
  }
}

// kilocode_change (F-F) - exported pure identity comparison for tests:
// unknown current identity never counts as same (fail closed, no
// ambiguous kill). Handle-based kills use the live ChildProcess object;
// PID-number signals always gate on this.
export function sameBirth(pid: number, birth: string | undefined): boolean {
  if (birth === undefined) return alive(pid)
  const now = birthOf(pid)
  if (now === undefined) return false
  return now === birth
}

/**
 * kilocode_change (F-F) - pure Windows assignment decision (no native
 * proof, injectable in tests): unknown or changed identity must abort
 * before job assignment; only a verified same-birth pid may assign.
 * The abort path kills via the native handle only, never a PID number.
 */
export function windowsAssignDecision(
  targetBirth: string | undefined,
  currentBirth: string | undefined,
): "assign" | "abort-unknown" | "abort-changed" {
  if (targetBirth === undefined) return "abort-unknown"
  if (currentBirth === undefined) return "abort-unknown"
  return currentBirth === targetBirth ? "assign" : "abort-changed"
}

// kilocode_change (F-A) - our own process-group id (never invented): the
// guardian must be the group leader (pgid === pid) before it may execute
// a target, so group cleanup provably covers exactly the owned tree.
function ownPgid(): number | undefined {
  if (process.platform === "win32") return undefined
  if (process.platform === "linux") {
    try {
      const text = fs.readFileSync(path.join("/proc", "self", "stat"), "utf8")
      const end = text.lastIndexOf(")")
      if (end < 0) return undefined
      const fields = text
        .slice(end + 2)
        .trim()
        .split(/\s+/)
      const pg = Number(fields[2])
      return Number.isInteger(pg) && pg > 0 ? pg : undefined
    } catch {
      return undefined
    }
  }
  try {
    const out = spawnSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { windowsHide: true, encoding: "utf8" })
    const text = typeof out.stdout === "string" ? out.stdout.trim() : ""
    const n = Number(text)
    return Number.isInteger(n) && n > 0 ? n : undefined
  } catch {
    return undefined
  }
}

/** PIDs whose pgid equals `pgid`, excluding self. */
export function groupMembers(pgid: number): number[] {
  if (process.platform === "win32" || pgid <= 0) return []
  const self = process.pid
  if (process.platform === "linux") {
    let names: string[]
    try {
      names = fs.readdirSync("/proc")
    } catch {
      return []
    }
    const out: number[] = []
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue
      const pid = Number(name)
      if (pid <= 0 || pid === self) continue
      let text: string
      try {
        text = fs.readFileSync(path.join("/proc", name, "stat"), "utf8")
      } catch {
        continue
      }
      const end = text.lastIndexOf(")")
      if (end < 0) continue
      const fields = text
        .slice(end + 2)
        .trim()
        .split(/\s+/)
      const pg = Number(fields[2])
      if (pg === pgid) out.push(pid)
    }
    return out.sort((a, b) => a - b)
  }
  try {
    const out = spawnSync("ps", ["-axo", "pid=,pgid="], { windowsHide: true, encoding: "utf8", timeout: 5000 })
    const text = typeof out.stdout === "string" ? out.stdout : ""
    const members: number[] = []
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s*$/)
      if (!m) continue
      const pid = Number(m[1])
      if (!Number.isInteger(pid) || pid <= 0 || pid === self) continue
      if (Number(m[2]) === pgid) members.push(pid)
    }
    return members.sort((a, b) => a - b)
  } catch {
    return []
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function killExact(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal)
    return true
  } catch (err) {
    return errCode(err) !== "ESRCH"
  }
}

/**
 * Kill an owned group without signalling ourselves: enumerate members via
 * owned pgid membership (never a negative-pid group kill, never pkill), skip
 * our own pid, TERM then verified KILL.
 */
export async function killGroupOwned(pgid: number, opts?: { termMs?: number }): Promise<void> {
  if (process.platform === "win32" || pgid <= 0) return
  const termMs = opts?.termMs ?? 2000
  const targets = groupMembers(pgid)
  if (targets.length === 0) return
  for (const pid of targets) killExact(pid, "SIGTERM")
  const end = Date.now() + termMs
  let rest = targets.filter(alive)
  while (rest.length > 0 && Date.now() < end) {
    await sleep(100)
    rest = rest.filter(alive)
  }
  const still = groupMembers(pgid).filter((pid) => pid !== process.pid)
  for (const pid of still.filter(alive)) killExact(pid, "SIGKILL")
}

// kilocode_change (F-C) - birth is mandatory: an unknown parent identity
// is treated as gone/dead (fail closed), never as alive.
function parentGone(parentPid: number, parentBirth: string | undefined, admitPpid?: number): boolean {
  try {
    process.kill(parentPid, 0)
  } catch {
    return true
  }
  if (parentBirth === undefined) return true
  if (!sameBirth(parentPid, parentBirth)) return true
  try {
    const ppid = process.ppid
    // Orphaned guardians move to pid 1 (or 0). Under pty libs an
    // intermediate spawn-helper is the initial ppid (never the owner), so
    // only reparenting AWAY from the admission ppid counts.
    if (ppid === 1 || ppid === 0) return true
    if (admitPpid !== undefined && ppid !== admitPpid && ppid !== parentPid) return true
  } catch {
    // birth/kill checks above already gate reuse
  }
  return false
}

function parentLive(parentPid: number, parentBirth: string | undefined): boolean {
  try {
    process.kill(parentPid, 0)
  } catch {
    return false
  }
  if (parentBirth === undefined) return false
  if (!sameBirth(parentPid, parentBirth)) return false
  return true
}

type WindowsJobHandle = {
  assign: (pid: number) => void
  terminate: () => void
  close: () => void
}

function loadWindowsJob(): WindowsJobHandle | undefined {
  try {
    // Compiled serve binary ships next to source; resolve without late
    // dynamic-import games: plain require of the sibling module.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../background-process/windows-job") as {
      WindowsJob?: { create: () => WindowsJobHandle | undefined }
    }
    return mod.WindowsJob?.create() ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Guardian wrap main. Establishes parent liveness + cleanup ownership
 * BEFORE spawning the target; any refusal aborts without launching the
 * target (fail closed). Runs pre-bootstrap (no DB/AppLayer/config) and
 * never returns on success paths except via process exit.
 */
export async function runGuardian(args: GuardianArgs): Promise<never> {
  process.env[GUARDIAN_ENV] = "1"
  process.env[GUARDIAN_OPT_OUT] = "1"
  const tag = `guardian wrap parent=${args.parentPid} target=${args.target.cmd}`

  const failClosed = (message: string): never => {
    try {
      process.stderr.write(`[guardian] ${tag} ${message}; target not launched\n`)
    } catch {}
    process.exit(2)
    throw new Error("unreachable")
  }

  // 1. Parent lease/liveness BEFORE exec: a dead/reused parent must never
  // admit target code. Birth is mandatory (no foreign reused parent
  // deemed alive).
  if (!args.parentBirth) failClosed("parent birth unavailable at admission")
  if (!parentLive(args.parentPid, args.parentBirth)) failClosed("parent not live at admission")

  // 1b. Group leadership BEFORE dispatch (POSIX): we must be the real
  // group leader (pgid === our pid, read live, never invented) so an
  // accidental non-detached launch (e.g. an external cross-spawn without
  // detached) cannot execute the target with a shared serve/decoy group.
  if (process.platform !== "win32") {
    const mine = ownPgid()
    if (mine === undefined) failClosed("own pgid unavailable")
    if (mine !== process.pid) failClosed(`not group leader (pgid ${mine} != pid ${process.pid})`)
  }

  // 2. Cleanup ownership BEFORE dispatch.
  // POSIX: we are the detached group leader; the target stays in our exact
  // group (pgid === our pid, read from our own pid — never guessed).
  const pgid = process.platform === "win32" ? -1 : process.pid
  let job: WindowsJobHandle | undefined
  if (process.platform === "win32") {
    job = loadWindowsJob()
    if (!job) failClosed("windows job unavailable")
  }

  // 3. Dispatch the target with proxied stdio/env/cwd: our stdio already
  // mirrors the target's desired modes (owner set them), our env/cwd ARE
  // the target's (owner set them), so inherit preserves everything
  // through direct fd duplication with no shuttle.
  const extra = args.target.extraFds ?? []
  const maxExtra = extra.length > 0 ? Math.max(...extra) : 2
  const stdio: StdioOptions = ["inherit", "inherit", "inherit"]
  for (let fd = 3; fd <= Math.min(Math.max(maxExtra, 2), 64); fd++) {
    ;(stdio as Array<string | undefined>)[fd] = extra.includes(fd) ? "inherit" : "ignore"
  }
  const opts: SpawnOptions = {
    cwd: process.cwd(),
    env: process.env,
    stdio,
    detached: false,
    windowsHide: true,
    shell: args.target.shell === false ? undefined : (args.target.shell as boolean | string),
  }
  let child: ChildProcess
  try {
    // Re-verify parent immediately before exec (admission-to-dispatch gap).
    if (!parentLive(args.parentPid, args.parentBirth)) failClosed("parent died before dispatch")
    // cross-spawn preserves the owner's spawn semantics (Windows
    // PATHEXT/shebang/shell quoting) through the wrapper.
    child = launch(args.target.cmd, args.target.args, opts) as ChildProcess
  } catch (err) {
    try {
      job?.close()
    } catch {}
    failClosed(`dispatch failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  const rawPid = child!.pid
  if (rawPid === undefined || rawPid <= 0) {
    try {
      job?.close()
    } catch {}
    failClosed("dispatch produced no pid")
  }
  const targetPid: number = rawPid as number
  const targetBirth = birthOf(targetPid)

  // 4. Windows job assignment immediately after dispatch with handle
  // identity: only our own freshly spawned pid with verified same-birth.
  // Unknown identity aborts BEFORE assignment (fail closed, native-handle
  // kill only, never a PID-number signal, never a reassignment) with no
  // coverage. NOTE: Windows is structurally unexecuted on this Darwin
  // host; the shape (not the kill) is what POSIX tests assert via the
  // pure windowsAssignDecision helper.
  if (process.platform === "win32" && job) {
    const decision = windowsAssignDecision(targetBirth, targetBirth === undefined ? undefined : birthOf(targetPid))
    if (decision !== "assign") {
      try {
        child!.kill("SIGKILL" as NodeJS.Signals)
      } catch {}
      try {
        job.close()
      } catch {}
      failClosed(decision === "abort-unknown" ? "target identity unavailable before job assignment" : "target identity changed before job assignment")
    }
    try {
      job.assign(targetPid)
    } catch (err) {
      try {
        child!.kill("SIGKILL" as NodeJS.Signals)
      } catch {}
      try {
        job.close()
      } catch {}
      failClosed(`job assignment failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  let cleaned = false
  const cleanupOwned = async (): Promise<void> => {
    if (cleaned) return
    cleaned = true
    try {
      if (process.platform === "win32") {
        try {
          if (targetBirth === undefined || sameBirth(targetPid, targetBirth)) job?.terminate()
        } catch {}
      } else {
        // The native handle is intact (child object alive until reaped);
        // group cleanup covers env -i grandchildren via real membership.
        await killGroupOwned(pgid)
        // Exact target fallback when group enumeration is blind.
        try {
          if (child!.exitCode === null && (child! as { signalCode?: unknown }).signalCode == null) {
            if (targetBirth === undefined || sameBirth(targetPid, targetBirth)) child!.kill("SIGKILL")
          }
        } catch {}
      }
    } finally {
      try {
        job?.close()
      } catch {}
    }
  }

  const exitWithTarget = async (): Promise<never> => {
    const code = child!.exitCode
    const signal = (child! as { signalCode?: NodeJS.Signals | null }).signalCode ?? null
    // Normal exit: clean late grandchildren BEFORE guardian exit.
    await cleanupOwned()
    // Drain the group so a lingering grandchild never outlives us.
    if (process.platform !== "win32") {
      const end = Date.now() + 3000
      while (Date.now() < end && groupMembers(pgid).length > 0) await sleep(100)
    }
    if (signal) {
      // Propagate the signal so owners observe signal termination, not a
      // fake zero/synthetic code. The release handlers below would
      // intercept a self-signal and exit 0, so remove them BEFORE reemit;
      // then park for delivery (no synchronous exit that would mask the
      // signal). Fallback exit only if the signal was ignored.
      try {
        process.removeAllListeners("SIGTERM")
      } catch {}
      try {
        process.removeAllListeners("SIGINT")
      } catch {}
      try {
        process.kill(process.pid, signal)
      } catch {}
      await sleep(2000)
      process.exit(1)
    }
    process.exit(code ?? 1)
    throw new Error("unreachable")
  }

  const onReleaseSignal = () => {
    void cleanupOwned().then(() => process.exit(0))
  }
  process.once("SIGTERM", onReleaseSignal)
  process.once("SIGINT", onReleaseSignal)

  child!.once("exit", () => {
    void exitWithTarget()
  })
  child!.once("error", () => {
    void (async () => {
      await cleanupOwned()
      process.exit(1)
    })()
  })

  // Parent-death watch: ppid/birth polling owns it (no pipe lease; stdio
  // belongs to the target). Crash (SIGKILL, no signal) arrives as
  // reparenting; we reap the owned tree then exit. The admission ppid is
  // the baseline (pty spawn-helpers interpose, never the owner).
  const admitPpid = (() => {
    try {
      return process.ppid
    } catch {
      return undefined
    }
  })()
  const watcher = (async () => {
    for (;;) {
      await sleep(300)
      if (parentGone(args.parentPid, args.parentBirth, admitPpid)) {
        await cleanupOwned()
        process.exit(0)
      }
    }
  })()
  void watcher
  // Park: target exit or parent death or release signal exits us. Target
  // exit alone never exits without grandchild cleanup (exitWithTarget).
  await new Promise(() => undefined)
  process.exit(0)
}
