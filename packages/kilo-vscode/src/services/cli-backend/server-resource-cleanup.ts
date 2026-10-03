/**
 * Token-verified crash cleanup for one private runtime instance.
 *
 * vscode-free (Node builtins only) so `bun test tests/unit/` can exercise it
 * without the Extension Host. The owner is `ServerManager`: it mints one
 * cryptographically unique token per serve child, retains the exact
 * epoch/token through exit/startup failure/dispose, and runs this cleanup to
 * completion BEFORE a replacement backend accepts work.
 *
 * Safety contract:
 * - Only exact-PID signals (`process.kill(pid, SIGTERM/SIGKILL)`). Never a
 *   negative-PID group kill, never `pkill`/`taskkill`/`killall`/name matching.
 * - A PID is signalled only while its live identity carries exactly
 *   `KILO_RUNTIME_TOKEN=<token>` (exact entry, not substring), or while it
 *   is an attested `__process-guardian` wrapper for that token (argv marker
 *   + exact token boundaries + same-start identity). PID reuse or foreign
 *   ownership is never signalled.
 * - `persistent` BackgroundProcess runners strip this token (backend
 *   `stripRuntimeToken`) and are never wrapped, so they are invisible to
 *   this sweep by construction and keep their own persist lease +
 *   per-process oracle.
 * - Unknown ownership fails closed with a visible reason; the caller must
 *   refuse the replacement backend, never claim freed.
 *
 * Achieved boundary: every nonpersistent child IS a `__process-guardian`
 * wrapper holding real group/job ownership across serve death,
 * independent of the target's env (prelaunch ownership: the target never
 * runs before the guardian owns it, so there is no SIGKILL/install gap
 * and no `env -i` escape). Guardians reap their trees via pgid
 * membership (POSIX) or KILL_ON_CLOSE jobs (Windows, structural code
 * claim — Windows execution evidence is unavailable on POSIX hosts and
 * clean is never attested there by marker presence alone); the sweep
 * reaps guardians by exact-PID signals and guardians reap their trees.
 * A guardian is never SIGKILLed before its owned cleanup completes:
 * SIGTERM first, then a bounded wait for the guardian to finish
 * reaping, then verified SIGKILL only for still-live still-owned
 * stragglers, then a fresh empty census before clean. A process that
 * calls `setsid` to escape its group leaves guardian group coverage and
 * is reported as a known gap (lineage primitive required), never
 * silently claimed. Env-token census remains as defense-in-depth, not
 * authority.
 */
import * as crypto from "crypto"
import { execFile } from "child_process"
import * as fs from "fs"
import * as path from "path"

export const RUNTIME_TOKEN_ENV = "KILO_RUNTIME_TOKEN" as const

const TOKEN_RE = /^[0-9a-f]{64}$/
// TERM window covers guardian-owned cleanup (guardian group TERM ~2s +
// verified KILL): never SIGKILL a guardian before it can finish reaping.
const TERM_MS = 5000
const KILL_MS = 2000
const POLL_MS = 100

export function createRuntimeToken(): string {
  return crypto.randomBytes(32).toString("hex")
}

export function isValidRuntimeToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_RE.test(value)
}

/** Exact `/proc/<pid>/environ` (NUL-separated) entry match. Never substring. */
export function hasTokenInEnviron(data: Buffer | string, token: string): boolean {
  if (!isValidRuntimeToken(token)) return false
  const text = typeof data === "string" ? data : data.toString("utf8")
  return text.split("\0").includes(`${RUNTIME_TOKEN_ENV}=${token}`)
}

/**
 * Exact `ps eww` command/env match with token boundaries. The char after the
 * 64-hex token must not be hex (prefix-collision guard) and the key must not
 * be a suffix of a longer key (`KILO_BACKGROUND_PROCESS_TOKEN=` never
 * matches: it lacks the `KILO_RUNTIME_TOKEN=` substring, and the preceding
 * boundary check rejects any `*_KILO_RUNTIME_TOKEN=` smuggling).
 */
export function hasTokenInPsCommand(command: string, token: string): boolean {
  if (!isValidRuntimeToken(token)) return false
  const needle = `${RUNTIME_TOKEN_ENV}=${token}`
  let from = 0
  while (true) {
    const at = command.indexOf(needle, from)
    if (at < 0) return false
    const before = at === 0 ? "" : command[at - 1]!
    const after = command[at + needle.length] ?? ""
    const beforeOk = before === "" || before === " " || before === "\t"
    const afterOk = after === "" || after === " " || after === "\t" || after === "\0"
    if (beforeOk && afterOk) return true
    // A trailing hex char means this occurrence is a longer value's prefix.
    from = at + needle.length
  }
}

export type EnumerateOk = { status: "ok"; pids: number[] }
export type EnumerateUnknown = { status: "unknown"; reason: string }
export type EnumerateUnsupported = { status: "unsupported"; reason: string }
export type EnumerateResult = EnumerateOk | EnumerateUnknown | EnumerateUnsupported

function selfPid(): number | undefined {
  return typeof process.pid === "number" ? process.pid : undefined
}

async function enumerateLinux(token: string): Promise<EnumerateResult> {
  let names: string[]
  try {
    names = await fs.promises.readdir("/proc")
  } catch (err) {
    return { status: "unknown", reason: `cannot list /proc: ${String(err)}` }
  }
  const owned: number[] = []
  let readAny = false
  let readOk = false
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    const pid = Number(name)
    if (pid <= 0 || pid === selfPid()) continue
    let data: Buffer
    try {
      data = await fs.promises.readFile(path.join("/proc", name, "environ"))
    } catch {
      continue
    }
    readAny = true
    readOk = true
    if (hasTokenInEnviron(data, token)) owned.push(pid)
  }
  if (!readAny) return { status: "unknown", reason: "no /proc environ entries readable" }
  void readOk
  return { status: "ok", pids: owned.sort((a, b) => a - b) }
}

function runPs(args: string[]): Promise<{ code: number; text: string }> {
  return new Promise((resolve) => {
    execFile("ps", args, { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) resolve({ code: 1, text: String(stdout ?? "") })
      else resolve({ code: 0, text: String(stdout ?? "") })
    })
  })
}

/**
 * True env-only Darwin/FreeBSD oracle.
 *
 * BSD `ps -e` means "all processes" (NOT environment); only capital `-E`
 * appends the `KEY=VALUE` environment block after argv. The old
 * `ps eww -axo` therefore matched argv, never env — an argv spoof
 * (`node -e 'KILO_RUNTIME_TOKEN=<token>'`) was indistinguishable from genuine
 * env inheritance.
 *
 * Separated probe: argv-only (`ps -axo`) vs argv+env (`ps -Eww -axo`).
 * Owned ⟺ exact token in the env view AND absent from the argv view for the
 * same PID in the same sweep pair. Present-in-both is argv spoof/ambiguity and
 * fails closed (never signalled). Missing from the argv snapshot is also
 * fail-closed (cannot disambiguate, never signalled).
 */
function parsePsTable(text: string): Map<number, string> {
  const out = new Map<number, string>()
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
    if (!match) continue
    const pid = Number(match[1])
    if (!Number.isInteger(pid) || pid <= 0 || pid === selfPid()) continue
    if (!out.has(pid)) out.set(pid, match[3]!)
  }
  return out
}

async function enumerateDarwin(token: string): Promise<EnumerateResult> {
  const [argv, env] = await Promise.all([
    runPs(["-axo", "pid=,pgid=,command="]),
    runPs(["-Eww", "-axo", "pid=,pgid=,command="]),
  ])
  if (argv.code !== 0 || env.code !== 0) return { status: "unknown", reason: "ps enumeration failed" }
  const argvTable = parsePsTable(argv.text)
  const envTable = parsePsTable(env.text)
  const owned: number[] = []
  for (const [pid, envCmd] of envTable) {
    if (!hasTokenInPsCommand(envCmd, token)) continue
    const argvCmd = argvTable.get(pid)
    if (argvCmd === undefined) continue // cannot disambiguate — fail closed
    if (hasTokenInPsCommand(argvCmd, token)) continue // argv spoof/ambiguity — fail closed
    owned.push(pid)
  }
  return { status: "ok", pids: owned.sort((a, b) => a - b) }
}

export async function enumerateOwnedPids(
  token: string,
  platform: string = process.platform,
): Promise<EnumerateResult> {
  if (!isValidRuntimeToken(token)) return { status: "unknown", reason: "invalid runtime token shape" }
  if (platform === "linux") {
    const [envOwned, guardians] = await Promise.all([enumerateLinux(token), enumerateGuardians(token, platform)])
    if (envOwned.status !== "ok") return envOwned
    if (guardians.status !== "ok") return envOwned
    const merged = Array.from(new Set([...envOwned.pids, ...guardians.pids])).sort((a, b) => a - b)
    return { status: "ok", pids: merged }
  }
  if (platform === "darwin" || platform === "freebsd") {
    const [envOwned, guardians] = await Promise.all([enumerateDarwin(token), enumerateGuardians(token, platform)])
    if (envOwned.status !== "ok") return envOwned
    if (guardians.status !== "ok") return envOwned
    const merged = Array.from(new Set([...envOwned.pids, ...guardians.pids])).sort((a, b) => a - b)
    return { status: "ok", pids: merged }
  }
  // Windows: no exact env oracle (CIM CommandLine is argv-only), so the
  // env-token census cannot prove ownership. Guardian sidecars ARE provable:
  // their argv carries `__process-guardian` + exact token boundaries, and
  // each holds a KILL_ON_CLOSE job over its tree. Enumerate guardians only;
  // an empty guardian census with a working CIM oracle attests clean for
  // guardian-covered epochs (all nonpersistent spawns supervise; persistent
  // runners strip the token and are never supervised by construction).
  // A failed CIM oracle stays unsupported (never clean by assertion).
  if (platform === "win32") return enumerateGuardians(token, platform)
  return {
    status: "unsupported",
    reason: `resource cleanup unsupported on ${platform} (stable platform limit, retry cannot recover): no exact env-token oracle — manual cleanup required before replacement`,
  }
}

/**
 * Attested guardian census: processes whose live argv carries the
 * `__process-guardian` wrapper marker plus the exact token.
 * Disambiguated like the Darwin env oracle (argv-spoof fails closed via
 * birth re-verification at signal time). Never matches
 * `KILO_BACKGROUND_PROCESS_TOKEN`. The wrapper holds the Windows job
 * structurally (code claim, not execution evidence); on win32 an empty
 * guardian census with a working CIM oracle drains owned wrappers, and
 * a failed oracle stays unsupported (never clean by marker presence).
 */
export function hasGuardianToken(command: string, token: string): boolean {
  if (!isValidRuntimeToken(token)) return false
  if (!command.includes("__process-guardian")) return false
  return hasTokenInPsCommand(command, token)
}

function parseGuardianTable(text: string, token: string): number[] {
  const out: number[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
    if (!match) continue
    const pid = Number(match[1])
    if (!Number.isInteger(pid) || pid <= 0 || pid === selfPid()) continue
    if (hasGuardianToken(match[3]!, token)) out.push(pid)
  }
  return out.sort((a, b) => a - b)
}

async function enumerateGuardiansLinux(token: string): Promise<EnumerateResult> {
  let names: string[]
  try {
    names = await fs.promises.readdir("/proc")
  } catch (err) {
    return { status: "unknown", reason: `cannot list /proc: ${String(err)}` }
  }
  const owned: number[] = []
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    const pid = Number(name)
    if (pid <= 0 || pid === selfPid()) continue
    let data: string
    try {
      data = await fs.promises.readFile(path.join("/proc", name, "cmdline"), "utf8")
    } catch {
      continue
    }
    if (hasGuardianToken(data.split("\0").join(" "), token)) owned.push(pid)
  }
  return { status: "ok", pids: owned.sort((a, b) => a - b) }
}

async function enumerateGuardiansDarwin(token: string): Promise<EnumerateResult> {
  const [argv, env] = await Promise.all([
    runPs(["-axo", "pid=,pgid=,command="]),
    runPs(["-Eww", "-axo", "pid=,pgid=,command="]),
  ])
  if (argv.code !== 0 || env.code !== 0) return { status: "unknown", reason: "ps enumeration failed" }
  return { status: "ok", pids: parseGuardianTable(`${argv.text}\n${env.text}`, token) }
}

async function enumerateGuardiansWindows(token: string): Promise<EnumerateResult> {
  const out = await new Promise<{ code: number; text: string }>((resolve) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
      ],
      { windowsHide: true, timeout: 8000 },
      (err, stdout) => {
        if (err) resolve({ code: 1, text: "" })
        else resolve({ code: 0, text: String(stdout ?? "") })
      },
    )
  })
  if (out.code !== 0 || !out.text.trim()) {
    return { status: "unsupported", reason: "resource cleanup unsupported on win32: CIM guardian oracle unavailable — manual cleanup required before replacement" }
  }
  let items: unknown
  try {
    items = JSON.parse(out.text)
  } catch {
    return { status: "unsupported", reason: "resource cleanup unsupported on win32: CIM guardian oracle unparseable — manual cleanup required before replacement" }
  }
  const rows = Array.isArray(items) ? items : [items]
  const owned: number[] = []
  for (const row of rows) {
    if (!row || typeof row !== "object") continue
    const rec = row as { ProcessId?: unknown; CommandLine?: unknown }
    if (typeof rec.ProcessId !== "number" || typeof rec.CommandLine !== "string") continue
    if (rec.ProcessId <= 0 || rec.ProcessId === selfPid()) continue
    if (hasGuardianToken(rec.CommandLine, token)) owned.push(rec.ProcessId)
  }
  return { status: "ok", pids: owned.sort((a, b) => a - b) }
}

async function enumerateGuardians(token: string, platform: string): Promise<EnumerateResult> {
  if (!isValidRuntimeToken(token)) return { status: "unknown", reason: "invalid runtime token shape" }
  if (platform === "linux") return enumerateGuardiansLinux(token)
  if (platform === "darwin" || platform === "freebsd") return enumerateGuardiansDarwin(token)
  if (platform === "win32") return enumerateGuardiansWindows(token)
  return {
    status: "unsupported",
    reason: `resource cleanup unsupported on ${platform} (stable platform limit, retry cannot recover): no guardian oracle — manual cleanup required before replacement`,
  }
}

/** Re-verify one live PID still carries the exact token. False on foreign/reused/gone. */
async function stillOwned(pid: number, token: string, platform: string): Promise<boolean> {
  if (platform === "linux") {
    // Guardians carry the token in env AND argv marker; either proves
    // attested ownership (argv marker checked with exact boundaries).
    let env: Buffer | undefined
    try {
      env = await fs.promises.readFile(path.join("/proc", String(pid), "environ"))
    } catch {
      env = undefined
    }
    if (env && hasTokenInEnviron(env, token)) return true
    try {
      const cmd = await fs.promises.readFile(path.join("/proc", String(pid), "cmdline"), "utf8")
      if (hasGuardianToken(cmd.split("\0").join(" "), token)) return true
    } catch {}
    return false
  }
  if (platform === "darwin" || platform === "freebsd") {
    const [argv, env] = await Promise.all([
      runPs(["-axo", "pid=,pgid=,command="]),
      runPs(["-Eww", "-axo", "pid=,pgid=,command="]),
    ])
    if (argv.code !== 0 || env.code !== 0) return false
    const argvTable = parsePsTable(argv.text)
    const envTable = parsePsTable(env.text)
    const argvCmd = argvTable.get(pid)
    // Attested guardian argv (marker + exact token) proves ownership even
    // though the token appears in argv: the marker distinguishes controlled
    // guardian argv from user argv spoof.
    if (argvCmd !== undefined && hasGuardianToken(argvCmd, token)) return true
    const envCmd = envTable.get(pid)
    if (envCmd === undefined || !hasTokenInPsCommand(envCmd, token)) return false
    if (argvCmd === undefined) return false // cannot disambiguate — fail closed
    if (hasTokenInPsCommand(argvCmd, token)) return false // argv spoof — fail closed
    return true
  }
  if (platform === "win32") {
    // No env oracle on Windows; only attested guardian argv is provable.
    const found = await enumerateGuardians(token, platform)
    if (found.status !== "ok") return false
    return found.pids.includes(pid)
  }
  return false
}

/** Start-identity (PID-reuse guard) as obtainable per platform. */
async function linuxBirth(pid: number): Promise<string | undefined> {
  let text: string
  try {
    text = await fs.promises.readFile(path.join("/proc", String(pid), "stat"), "utf8")
  } catch {
    return undefined
  }
  const end = text.lastIndexOf(")")
  if (end < 0) return undefined
  const fields = text
    .slice(end + 2)
    .trim()
    .split(/\s+/)
  // Field 22 (starttime); fields after ")" start at field 3 → index 19.
  const starttime = fields[19]
  return starttime !== undefined && starttime !== "" ? starttime : undefined
}

async function darwinBirthTable(): Promise<Map<number, string> | undefined> {
  const out = await runPs(["-axo", "pid=,lstart="])
  if (out.code !== 0) return undefined
  const table = new Map<number, string>()
  for (const line of out.text.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(.*\S)\s*$/)
    if (!match) continue
    const pid = Number(match[1])
    if (!Number.isInteger(pid) || pid <= 0) continue
    table.set(pid, match[2]!.trim())
  }
  return table
}

export type OwnedEntry = { pid: number; birth: string | undefined }

async function snapshotOwned(token: string, platform: string): Promise<EnumerateResult & { entries?: OwnedEntry[] }> {
  const found = await enumerateOwnedPids(token, platform)
  if (found.status !== "ok") return found
  if (platform === "linux") {
    const entries: OwnedEntry[] = []
    for (const pid of found.pids) entries.push({ pid, birth: await linuxBirth(pid) })
    return { status: "ok", pids: found.pids, entries }
  }
  if (platform === "darwin" || platform === "freebsd") {
    const births = await darwinBirthTable()
    return { status: "ok", pids: found.pids, entries: found.pids.map((pid) => ({ pid, birth: births?.get(pid) })) }
  }
  return { status: "ok", pids: found.pids, entries: found.pids.map((pid) => ({ pid, birth: undefined })) }
}

/** Immediate pre-signal re-verification: live token + same start identity (when obtainable). */
async function verifyOne(entry: OwnedEntry, token: string, platform: string): Promise<boolean> {
  if (!alive(entry.pid)) return false
  if (!(await stillOwned(entry.pid, token, platform))) return false
  if (entry.birth !== undefined) {
    if (platform === "linux") {
      const now = await linuxBirth(entry.pid)
      if (now === undefined || now !== entry.birth) return false
    } else if (platform === "darwin" || platform === "freebsd") {
      const table = await darwinBirthTable()
      const now = table?.get(entry.pid)
      if (now === undefined || now !== entry.birth) return false
    }
  }
  return true
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export type CleanupResult =
  | { status: "clean"; killed: number[]; elapsedMs: number }
  | { status: "failed"; reason: string; remaining: number[]; killed: number[] }
  | { status: "unsupported"; reason: string }

type SignalOutcome = { refused?: { pid: number; signal: string; cause: string } }

/** Exact-PID signal only. ESRCH (already gone) is not a refusal. Never group/pattern. */
function signalExact(pids: number[], signal: NodeJS.Signals): SignalOutcome {
  for (const pid of pids) {
    try {
      process.kill(pid, signal)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ESRCH") continue
      return { refused: { pid, signal, cause: (err as Error)?.message ?? String(err) } }
    }
  }
  return {}
}

async function waitGone(pids: number[], ms: number): Promise<number[]> {
  const end = Date.now() + ms
  let remaining = pids.filter(alive)
  while (remaining.length > 0 && Date.now() < end) {
    await sleep(POLL_MS)
    remaining = remaining.filter(alive)
  }
  return remaining
}



/**
 * Bounded enumerate → verify → TERM → verify → KILL → fresh-census drain to
 * quiescence. Every signal is preceded by an immediate per-PID re-verification
 * (live token + same start identity when obtainable); a dead-then-reused PID
 * is foreign and never signalled. Clean requires a fresh empty census after
 * the last kill — growth/forks during the sweep start another bounded pass,
 * and a growing/cycling set fails closed with the remaining gate held.
 * Never uses group/pattern kills.
 */
const MAX_SWEEPS = 5

type SweepOutcome =
  | { kind: "empty" }
  | { kind: "stale" }
  | { kind: "drained" }
  | { kind: "refused"; reason: string; remaining: number[] }

/** One verified TERM (+ verified KILL for stragglers) pass over a census. */
async function drainSweep(
  entries: OwnedEntry[],
  token: string,
  platform: string,
  opts: { termMs?: number; killMs?: number } | undefined,
  killed: number[],
): Promise<SweepOutcome> {
  // Immediate pre-TERM verification per PID: stale/reused identities are skipped, never signalled.
  const termTargets: OwnedEntry[] = []
  for (const e of entries) {
    if (await verifyOne(e, token, platform)) termTargets.push(e)
  }
  if (termTargets.length === 0) return { kind: "stale" }
  const refusedTerm = signalExact(termTargets.map((e) => e.pid), "SIGTERM")
  if (refusedTerm.refused)
    return {
      kind: "refused",
      reason: `SIGTERM refused for owned pid ${refusedTerm.refused.pid}: ${refusedTerm.refused.cause}`,
      remaining: entries.map((e) => e.pid),
    }
  for (const e of termTargets) {
    if (!killed.includes(e.pid)) killed.push(e.pid)
  }
  const remaining = await waitGone(
    termTargets.map((e) => e.pid),
    opts?.termMs ?? TERM_MS,
  )
  // Re-verify before SIGKILL with fresh birth check per PID.
  const byPid = new Map(termTargets.map((e) => [e.pid, e]))
  const killTargets: OwnedEntry[] = []
  for (const pid of remaining) {
    const e = byPid.get(pid)
    if (e && (await verifyOne(e, token, platform))) killTargets.push(e)
  }
  if (killTargets.length === 0) return { kind: "drained" }
  const refusedKill = signalExact(killTargets.map((e) => e.pid), "SIGKILL")
  if (refusedKill.refused)
    return {
      kind: "refused",
      reason: `SIGKILL refused for owned pid ${refusedKill.refused.pid}: ${refusedKill.refused.cause}`,
      remaining: killTargets.map((e) => e.pid),
    }
  await waitGone(
    killTargets.map((e) => e.pid),
    opts?.killMs ?? KILL_MS,
  )
  return { kind: "drained" }
}

export async function cleanupOwnedProcesses(
  token: string,
  opts?: { termMs?: number; killMs?: number; platform?: string },
): Promise<CleanupResult> {
  const platform = opts?.platform ?? process.platform
  const started = Date.now()
  const done = (killed: number[]): CleanupResult => ({ status: "clean", killed, elapsedMs: Date.now() - started })
  if (!isValidRuntimeToken(token)) return { status: "failed", reason: "invalid runtime token shape", remaining: [], killed: [] }
  const killed: number[] = []
  for (let sweep = 0; sweep < MAX_SWEEPS; sweep++) {
    const census = await snapshotOwned(token, platform)
    if (census.status === "unsupported") return { status: "unsupported", reason: census.reason }
    if (census.status === "unknown") return { status: "failed", reason: census.reason, remaining: [], killed: [...killed] }
    const entries = (census.entries ?? []).filter((e) => e.pid !== selfPid())
    if (entries.length === 0) return done([...killed])
    const out = await drainSweep(entries, token, platform, opts, killed)
    if (out.kind === "refused") return { status: "failed", reason: out.reason, remaining: out.remaining, killed: [...killed] }
    // "stale" and "drained" both loop for a fresh census: late forks appear there.
  }
  const tail = await snapshotOwned(token, platform)
  if (tail.status === "unsupported") return { status: "unsupported", reason: tail.reason }
  if (tail.status === "unknown") return { status: "failed", reason: tail.reason, remaining: [], killed: [...killed] }
  const rest = (tail.status === "ok" ? (tail.entries ?? []) : []).filter((e) => e.pid !== selfPid())
  if (rest.length === 0) return done([...killed])
  return {
    status: "failed",
    reason: `owned pids survived bounded drain (${MAX_SWEEPS} sweeps): ${rest.map((e) => e.pid).join(",")}`,
    remaining: rest.map((e) => e.pid),
    killed: [...killed],
  }
}
