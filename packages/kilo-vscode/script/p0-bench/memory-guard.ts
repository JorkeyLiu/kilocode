/**
 * Run-owned process-tree memory guard for the P0 extension benchmark.
 *
 * P0 benchmark safety infrastructure (not a product SLA, not P1 work): a VS
 * Code/Code process memory runaway on a 16 GB machine froze the host before the
 * previous interrupted campaign could complete. The guard polls
 * `ps -axo lstart=,pid=,ppid=,rss=,vsz=,args=` on a cadence, seeds ownership
 * from processes whose args contain the exact unique lifecycle userData path,
 * and additionally seeds the exact run-owned BACKEND identity
 * (PID + immutable CLI snapshot path + raw process-start `lstart` string)
 * once it is observable via `spawn.done`/CLI path. The owned tree recursively
 * includes descendants by PPID — never ancestors and never name-matched
 * unrelated processes (e.g. the user's production VS Code, which uses a
 * different userData dir). Because the backend identity is seeded by exact
 * identity on EVERY poll — regardless of PPID — the run-owned `kilo serve`
 * backend stays monitored after the Extension Host exits and it is reparented
 * to PID 1, and it can never be signaled on PID/start/path mismatch (a reused
 * PID is treated as exited, never signaled). On breach it records bounded
 * diagnostic evidence; the caller (script/p0-bench/sample.ts) writes the done
 * marker, terminates only exact owned PIDs via the existing cleanup helpers
 * (plus the identity-checked backend termination), and forces the
 * lifecycle/sample to `ok:false`, `blocked.reason="memory-guard-abort"`.
 *
 * Thresholds are ENGINEERING SAFETY RAILS, not performance thresholds and not
 * an SLA (LOCK-PERF-7 stays Open):
 *   - any owned process RSS  >= 4 GiB  (KILO_P0_MEMORY_GUARD_MAX_PROCESS_RSS_MB)
 *   - aggregate owned RSS    >= 6 GiB  (KILO_P0_MEMORY_GUARD_AGGREGATE_RSS_MB)
 *   - any owned process VSZ  >= 64 GiB (KILO_P0_MEMORY_GUARD_MAX_PROCESS_VSZ_MB)
 *
 * VSZ rail platform note: macOS `ps` reports a fixed ~400 GB address-space
 * baseline for EVERY process (dyld shared cache reservation), so the 64 GiB VSZ
 * rail would trip on the first poll of any owned process and cannot distinguish
 * a runaway. On `darwin` the VSZ rail is therefore inert-by-construction (VSZ
 * is still recorded in the time series and maxes for RSS-vs-VSZ distinction),
 * while the two RSS rails remain the effective abort gates. On `linux` all
 * three rails are active. This is documented in the record (`configured.label`
 * / `configured.vszRailNote`) so the evidence stays truthful.
 *
 * If the platform cannot support the guard at all (e.g. Windows), starting the
 * guard throws and the benchmark fails safely BEFORE launch rather than running
 * unguarded.
 *
 * Bounds: the retained time series is capped by object count (MAX_SERIES) and
 * every command string is capped by byte length (MAX_COMMAND_BYTES). Poll
 * overhead is recorded (totalPollMs/maxPollMs). The interval is cleared on
 * stop()/breach, so no timer or subprocess outlives the lifecycle.
 *
 * Testability: `ps` output, clock, and the interval timer are injected via
 * MemoryGuardDeps; tests drive polls deterministically via `pollOnce()` with
 * synthetic ps data and never spawn large processes.
 */

import { spawnSync } from "node:child_process"
import type { GuardBreach, MemoryGuardResult, MemoryGuardSeriesEntry } from "./types"

const KB = 1024
const MB = KB * KB

/**
 * ps column set the guard polls (headers suppressed by trailing `=`). `lstart`
 * is the raw process-start identity (e.g. `Tue Aug 11 13:15:12 2026`) — the
 * stable, machine-available start marker on macOS/linux used to prove a PID is
 * still the same process (PID-reuse-safe) and to keep the backend an owned
 * root after reparenting. `args` stays the greedy tail so commands containing
 * spaces parse safely.
 */
const PS_ARGS = ["-axo", "lstart=,pid=,ppid=,rss=,vsz=,args="]

/**
 * Raw `lstart` identity: exactly 5 whitespace-separated tokens, e.g.
 * `Tue Aug 11 13:15:12 2026`. Token-count matching (not English month/day
 * names) keeps the parse locale-independent on macOS/linux `ps`.
 */
const LSTART = String.raw`\S+(?: \S+){4}`

/** Full polled-row: lstart + pid + ppid + rss + vsz + args (spaces allowed). */
const PS_ROW_RE = new RegExp(`^(${LSTART})\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(.*)$`)

/** Single-process ps query (`lstart=,args=`): lstart + args tail. */
const LSTART_LINE_RE = new RegExp(`^(${LSTART})\\s+(\\S.*)$`)

/** Hard cap on retained time-series observations (object-count bound). */
const MAX_SERIES = 360

/** Hard cap on retained command bytes (string bound). */
const MAX_COMMAND_BYTES = 200

/** Truthful label carried into every guard record. */
export const MEMORY_GUARD_LABEL = "engineering safety rails (not performance thresholds/R7; not SLA)"

/** Env vars honored by the guard (clearly named KILO_P0_MEMORY_GUARD_*). */
export const MEMORY_GUARD_ENV = {
  enabled: "KILO_P0_MEMORY_GUARD",
  pollMs: "KILO_P0_MEMORY_GUARD_POLL_MS",
  maxProcessRssMb: "KILO_P0_MEMORY_GUARD_MAX_PROCESS_RSS_MB",
  maxAggregateRssMb: "KILO_P0_MEMORY_GUARD_AGGREGATE_RSS_MB",
  maxProcessVszMb: "KILO_P0_MEMORY_GUARD_MAX_PROCESS_VSZ_MB",
} as const

export interface ProcessRow {
  pid: number
  ppid: number
  /** RSS in KB as reported by ps. */
  rssKb: number
  /** VSZ in KB as reported by ps. */
  vszKb: number
  /** Raw process-start identity (ps `lstart` string, e.g. `Tue Aug 11 13:15:12 2026`). */
  start: string
  args: string
}

/**
 * The exact run-owned backend identity: PID + immutable CLI path (the pinned
 * campaign snapshot path) + the raw `lstart` start string captured at
 * verification. Registered with the guard as soon as `spawn.done`/CLI path are
 * observable; matched on every poll regardless of PPID.
 */
export interface BackendRoot {
  pid: number
  /** Exact immutable CLI snapshot path (or bundled bin/kilo fallback) the backend must run from. */
  cliPath: string
  /** Raw process-start identity (ps `lstart`). */
  start: string
  /** Epoch ms when the identity was verified and registered. */
  registeredAt: number
}

/**
 * Generic exact process identity: PID + the exact immutable path the process
 * must run from + the raw `lstart` start string. The common shape behind the
 * backend identity (BackendRoot, CLI path) and the run-owned MCP fixture
 * identity (fixture script path); verification is shared via verifyProcessRow
 * so PID-reuse-safe cleanup is one mechanism, not two.
 */
export interface ProcessRoot {
  pid: number
  /** Exact immutable path the process must run from (CLI snapshot or fixture script). */
  path: string
  /** Raw process-start identity (ps `lstart`). */
  start: string
}

/** Per-poll verification of a backend identity against a ps row. */
export interface BackendVerification {
  status: "matched" | "missing" | "mismatch"
  /** Bounded reason when not matched; null while matched. */
  detail: string | null
}

/** Outcome of an exact identity-checked backend termination attempt. */
export interface BackendCleanupOutcome {
  /** True only when the identity was verified as gone (never signaled a mismatch). */
  terminated: boolean
  /** Last verification outcome. */
  status: BackendVerification["status"]
  /** Bounded reason when not cleanly terminated. */
  detail: string | null
}

/** Validated guard configuration (positive-integer env values). */
export interface MemoryGuardConfig {
  enabled: boolean
  pollMs: number
  maxProcessRssBytes: number
  maxAggregateRssBytes: number
  maxProcessVszBytes: number
}

/** Injectable dependencies so tests never spawn real processes or timers. */
export interface MemoryGuardDeps {
  /** Run `ps` with the given args and return stdout. */
  ps: (args: string[]) => string
  /** Wall-clock source. */
  now: () => number
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (handle: unknown) => void
  platform: NodeJS.Platform
  /** Invoked (fire-and-forget) once on breach, after polling stops. */
  onBreach?: (breach: GuardBreach) => void | Promise<void>
}

export interface MemoryGuard {
  /** Bounded result so far (safe to read after stop()). */
  result(): MemoryGuardResult
  /**
   * Resolves with the breach, or null when stopped without a breach. Rejects
   * with MemoryGuardUnavailableError when a poll (ps) fails after start —
   * the guard cannot monitor, so the caller must fail the lifecycle closed
   * instead of continuing unguarded.
   */
  breached: Promise<GuardBreach | null>
  /** Run one poll immediately (also used by the interval). Exposed for tests. */
  pollOnce(): void
  /**
   * Register the exact run-owned backend identity (PID + immutable CLI path +
   * raw start) as an owned root on every poll regardless of PPID. Idempotent
   * for the same PID; a later different-PID registration replaces the
   * identity (backend respawn). Takes effect on the next poll.
   */
  registerBackend(identity: BackendRoot): void
  /** The currently registered backend identity, or null. */
  backendIdentity(): BackendRoot | null
  /** Stop polling; never leaves a timer behind. Idempotent. */
  stop(): void
}

/**
 * Thrown when the guard cannot run safely (unsupported platform or invalid env
 * values). The benchmark must fail BEFORE launching VS Code rather than run
 * unguarded; the lifecycle catch classifies this as "memory-guard-unavailable".
 */
export class MemoryGuardUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MemoryGuardUnavailableError"
  }
}

/** Default production deps (real ps, Date.now, real timers, current platform). */
export function realGuardDeps(): Omit<MemoryGuardDeps, "onBreach"> {
  return {
    ps: (args) => {
      const proc = spawnSync("ps", args, { encoding: "utf8" })
      // A failed ps invocation must surface as a poll failure (the guard then
      // fails closed and stops polling) — never a silent empty poll that leaves
      // the lifecycle unguarded while reporting a healthy result.
      if (proc.error !== undefined) throw proc.error
      if (proc.status !== 0) {
        throw new Error(
          `ps exited with status ${String(proc.status)}: ${(proc.stderr ?? "").trim() || "no stderr"}`,
        )
      }
      return proc.stdout ?? ""
    },
    now: Date.now,
    setInterval: (fn, ms) => setInterval(fn, ms) as unknown,
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    platform: process.platform,
  }
}

/**
 * Platform support + VSZ-rail semantics. `supported:false` platforms (e.g.
 * Windows — no `ps -axo ...` columns) must fail the benchmark before launch.
 * On darwin the VSZ rail is inert-by-construction (fixed baseline, see header).
 */
export function memoryGuardPlatformNote(platform: NodeJS.Platform): {
  supported: boolean
  vszRailNote: string | null
} {
  if (platform === "darwin") {
    return {
      supported: true,
      vszRailNote:
        "darwin: macOS ps reports a fixed ~400 GB address-space baseline for every process, so the 64 GiB VSZ rail cannot distinguish a runaway; the RSS rails are the effective abort gates and VSZ is recorded for RSS-vs-VSZ distinction",
    }
  }
  if (platform === "linux") {
    return { supported: true, vszRailNote: null }
  }
  return { supported: false, vszRailNote: null }
}

/**
 * Parse `ps -axo lstart=,pid=,ppid=,rss=,vsz=,args=` stdout into rows. Lines
 * that do not start with a raw `lstart` identity + four integers are skipped
 * (no header, empty lines, truncated lines) so a partial/odd ps run can never
 * crash the poll.
 */
export function parsePsRows(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of stdout.split("\n")) {
    const m = line.trim().match(PS_ROW_RE)
    if (!m) continue
    const pid = Number(m[2])
    const ppid = Number(m[3])
    const rssKb = Number(m[4])
    const vszKb = Number(m[5])
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(rssKb) || !Number.isFinite(vszKb)) {
      continue
    }
    rows.push({ pid, ppid, rssKb, vszKb, start: m[1]!, args: m[6] ?? "" })
  }
  return rows
}

/**
 * Parse a single-process `ps -p <pid> -o lstart=,args=` line into the raw
 * start identity + args tail. Used to verify a backend identity against the
 * live process before registration and immediately before each signal.
 */
export function parseLstartLine(line: string): { start: string; rest: string } | null {
  const m = line.trim().match(LSTART_LINE_RE)
  if (!m) return null
  return { start: m[1]!, rest: m[2]! }
}

/**
 * Verify a ps row against an exact process identity (PID + raw start + exact
 * path). A row is matched only when the PID is present with the SAME raw start
 * string AND args that still contain the exact path. Any mismatch means the
 * identity must be treated as exited/reused — it must never be signaled.
 * `pathLabel` names the path in the mismatch detail (e.g. "CLI path" for the
 * backend, "fixture script path" for the MCP fixture).
 */
export function verifyProcessRow(
  root: ProcessRoot,
  row: ProcessRow | undefined,
  pathLabel = "pinned path",
): BackendVerification {
  if (!row) {
    return { status: "missing", detail: "process not in the ps table (exited or never started)" }
  }
  if (row.start !== root.start) {
    return { status: "mismatch", detail: "process start identity mismatch (PID likely reused)" }
  }
  if (!row.args.includes(root.path)) {
    return { status: "mismatch", detail: `process args no longer contain the ${pathLabel}` }
  }
  return { status: "matched", detail: null }
}

/**
 * Verify a ps row against the exact backend identity (delegates to the generic
 * verifyProcessRow; kept as the backend-specific surface used by the guard and
 * the probe's backend cleanup).
 */
export function verifyBackendRow(identity: BackendRoot, row: ProcessRow | undefined): BackendVerification {
  return verifyProcessRow({ pid: identity.pid, path: identity.cliPath, start: identity.start }, row, "CLI path")
}

/** The run-owned process tree: seeds + all descendants by PPID. */
export interface OwnedTree {
  /** PIDs that seed the tree: exact userData arg matches + the verified backend root. */
  rootPids: number[]
  /** Every owned PID (roots + descendants). */
  pids: Set<number>
  aggregateRssKb: number
  /** Owned row with the highest RSS (ties: first). */
  maxRss: ProcessRow | null
  /** Owned row with the highest VSZ (ties: first). */
  maxVsz: ProcessRow | null
  /** Per-poll verification of the registered backend identity (null when none registered). */
  backendStatus: { status: BackendVerification["status"]; detail: string | null; registeredAt: number } | null
}

/**
 * Build the owned tree from one ps snapshot. Ownership is seeded from
 * processes whose args contain the exact unique lifecycle userData path (never
 * a name match, never a parent walk) plus — when a backend identity is
 * registered and verifies (PID + start + pinned CLI path) — the backend itself
 * as an owned root regardless of PPID. The tree is then expanded recursively
 * to descendants by PPID. Ancestors and unrelated same-named processes (a
 * different userData dir, or a reused PID) are never included.
 */
export function buildOwnedTree(rows: ProcessRow[], userData: string, backend?: BackendRoot): OwnedTree {
  const byPid = new Map<number, ProcessRow>()
  const children = new Map<number, number[]>()
  const roots: number[] = []
  for (const row of rows) {
    byPid.set(row.pid, row)
    const list = children.get(row.ppid) ?? []
    list.push(row.pid)
    children.set(row.ppid, list)
    if (row.args.includes(userData)) roots.push(row.pid)
  }
  let backendStatus: { status: BackendVerification["status"]; detail: string | null; registeredAt: number } | null = null
  if (backend) {
    const v = verifyBackendRow(backend, byPid.get(backend.pid))
    backendStatus = { status: v.status, detail: v.detail, registeredAt: backend.registeredAt }
    if (v.status === "matched") roots.push(backend.pid)
  }
  const pids = new Set<number>()
  const queue = [...roots]
  while (queue.length > 0) {
    const pid = queue.pop()!
    if (pids.has(pid)) continue
    pids.add(pid)
    for (const child of children.get(pid) ?? []) queue.push(child)
  }
  let aggregateRssKb = 0
  let maxRss: ProcessRow | null = null
  let maxVsz: ProcessRow | null = null
  for (const pid of pids) {
    const row = byPid.get(pid)
    if (!row) continue
    aggregateRssKb += row.rssKb
    if (maxRss === null || row.rssKb > maxRss.rssKb) maxRss = row
    if (maxVsz === null || row.vszKb > maxVsz.vszKb) maxVsz = row
  }
  return { rootPids: roots, pids, aggregateRssKb, maxRss, maxVsz, backendStatus }
}

/**
 * Exact identity-checked termination sequence for the run-owned backend.
 * Re-verifies PID + start + pinned CLI path immediately before EACH signal and
 * never signals on missing/mismatch (a PID may have been reused by an
 * unrelated process — that process must never be killed). SIGTERM → grace →
 * re-verify → SIGKILL → grace → final verify. Clean only when the identity is
 * finally missing; a mismatch (identity invalid) is reported as cleanup
 * evidence, never silently treated as clean.
 */
export async function exactTerminateBackend(
  verify: () => BackendVerification,
  signal: (sig: NodeJS.Signals) => void,
  graceMs: number,
  sleepFn: (ms: number) => Promise<void>,
): Promise<BackendCleanupOutcome> {
  const first = verify()
  if (first.status !== "matched") {
    // Already gone: clean. Identity invalid (mismatch): never signal, report.
    return { terminated: first.status === "missing", status: first.status, detail: first.detail }
  }
  signal("SIGTERM")
  await sleepFn(graceMs)
  let v = verify()
  if (v.status === "matched") {
    signal("SIGKILL")
    await sleepFn(graceMs)
    v = verify()
  }
  if (v.status === "matched") {
    return { terminated: false, status: "matched", detail: "backend survived SIGKILL" }
  }
  if (v.status === "missing") {
    return { terminated: true, status: "missing", detail: null }
  }
  return { terminated: false, status: v.status, detail: v.detail }
}

/**
 * Byte-cap an evidence string to `maxBytes` bytes without splitting a UTF-8
 * sequence (the tail is replaced by the U+2026 ellipsis). Every bounded guard
 * evidence string — commands and poll-failure details — routes through this
 * helper so no path can grow a bounded field without bound.
 */
function boundEvidence(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s
  let cut = 0
  let bytes = 0
  while (cut < s.length) {
    const c = s.charCodeAt(cut)
    const low = s.charCodeAt(cut + 1)
    const pair = c >= 0xd800 && c <= 0xdbff && low >= 0xdc00 && low <= 0xdfff
    const n = pair ? 4 : c < 0x80 ? 1 : c < 0x800 ? 2 : 3
    if (bytes + n > maxBytes) break
    bytes += n
    cut += pair ? 2 : 1
  }
  return s.slice(0, cut) + "…"
}

/**
 * Bound a command string to MAX_COMMAND_BYTES bytes without splitting a UTF-8
 * sequence (the tail is replaced by the U+2026 ellipsis). The early return
 * compares the UTF-8 byte length (not the JS char length), so a multibyte
 * command can never pass through uncapped.
 */
export function boundCommand(args: string): string {
  return boundEvidence(args, MAX_COMMAND_BYTES)
}

/**
 * Evaluate the engineering safety rails for one poll. Returns the breach or
 * null. `vszRail` is false on darwin (fixed VSZ baseline — see header), so the
 * VSZ rail is only evaluated where it is a meaningful signal (linux).
 */
export function checkBreach(
  tree: OwnedTree,
  cfg: MemoryGuardConfig,
  vszRail: boolean,
  t: number,
  elapsedMs: number,
): GuardBreach | null {
  const top = tree.maxRss
  const topVsz = tree.maxVsz
  if (top && top.rssKb * KB >= cfg.maxProcessRssBytes) {
    return {
      reason: "max-process-rss",
      t,
      elapsedMs,
      aggregateRss: tree.aggregateRssKb * KB,
      maxProcessRss: top.rssKb * KB,
      maxProcessVsz: (topVsz?.vszKb ?? 0) * KB,
      pid: top.pid,
      ppid: top.ppid,
      command: boundCommand(top.args),
      ownedCount: tree.pids.size,
    }
  }
  if (tree.aggregateRssKb * KB >= cfg.maxAggregateRssBytes) {
    return {
      reason: "aggregate-rss",
      t,
      elapsedMs,
      aggregateRss: tree.aggregateRssKb * KB,
      maxProcessRss: (top?.rssKb ?? 0) * KB,
      maxProcessVsz: (topVsz?.vszKb ?? 0) * KB,
      pid: top?.pid ?? 0,
      ppid: top?.ppid ?? 0,
      command: top ? boundCommand(top.args) : "",
      ownedCount: tree.pids.size,
    }
  }
  if (vszRail && topVsz && topVsz.vszKb * KB >= cfg.maxProcessVszBytes) {
    return {
      reason: "max-process-vsz",
      t,
      elapsedMs,
      aggregateRss: tree.aggregateRssKb * KB,
      maxProcessRss: (top?.rssKb ?? 0) * KB,
      maxProcessVsz: topVsz.vszKb * KB,
      pid: topVsz.pid,
      ppid: topVsz.ppid,
      command: boundCommand(topVsz.args),
      ownedCount: tree.pids.size,
    }
  }
  return null
}

/**
 * Read + validate the guard configuration from the environment. Every
 * threshold/cadence value must be a positive integer; an invalid value throws
 * so the benchmark fails safely before launch. `KILO_P0_MEMORY_GUARD=0|false`
 * disables the guard explicitly (no polling, no abort).
 */export function memoryGuardConfig(env: NodeJS.ProcessEnv = process.env): MemoryGuardConfig {
  const mb = (name: string, fallback: number): number => {
    const raw = env[name]
    if (raw === undefined || raw.trim() === "") return fallback
    const value = Number(raw.trim())
    if (!Number.isInteger(value) || value <= 0) {
      throw new MemoryGuardUnavailableError(
        `[p0-probe] memory guard: ${name} must be a positive integer (got "${raw}") — safety rail values are MB/cadence-ms`,
      )
    }
    return value
  }
  const enabledRaw = env[MEMORY_GUARD_ENV.enabled]
  const enabled = !(enabledRaw === "0" || enabledRaw === "false")
  return {
    enabled,
    pollMs: mb(MEMORY_GUARD_ENV.pollMs, 1000),
    maxProcessRssBytes: mb(MEMORY_GUARD_ENV.maxProcessRssMb, 4 * 1024) * MB,
    maxAggregateRssBytes: mb(MEMORY_GUARD_ENV.maxAggregateRssMb, 6 * 1024) * MB,
    maxProcessVszBytes: mb(MEMORY_GUARD_ENV.maxProcessVszMb, 64 * 1024) * MB,
  }
}

/** Mutable per-poll backend monitoring state held by the guard closure. */
interface BackendTrack {
  lastSeen: number | null
  matchedPolls: number
  latest: MemoryGuardResult["backend"]
}

/**
 * Fold one poll's backend verification into the bounded monitoring state.
 * A matched poll records the seen time and increments the matched counter
 * (monitoring proof); the latest per-poll status/detail is always refreshed.
 * A null status (no verification yet) reads as `missing` pending first poll.
 */
function observeBackend(
  backend: BackendRoot,
  status: OwnedTree["backendStatus"],
  now: number,
  state: BackendTrack | null,
): BackendTrack {
  const next = state ?? { lastSeen: null, matchedPolls: 0, latest: undefined }
  if (status !== null && status.status === "matched") {
    next.lastSeen = now
    next.matchedPolls++
  }
  const s = status?.status ?? "missing"
  const detail = status?.detail ?? "registration pending first poll"
  next.latest = {
    identity: { pid: backend.pid, cliPath: backend.cliPath, start: backend.start },
    registeredAt: backend.registeredAt,
    status: s,
    detail,
    lastSeenAt: next.lastSeen,
    matchedPolls: next.matchedPolls,
  }
  return next
}

/**
 * Start the run-owned memory guard. Throws when the platform is unsupported
 * (refusing to run the benchmark unguarded) or the env config is invalid.
 * Polling begins immediately (one poll now, then every `pollMs`). On breach
 * polling stops, `breached` resolves with the breach, and `onBreach` is
 * invoked once. `stop()` clears the interval and resolves `breached` with null
 * when no breach occurred — no timer survives.
 */
export function startMemoryGuard(userData: string, cfg: MemoryGuardConfig, deps: MemoryGuardDeps): MemoryGuard {
  const platformNote = memoryGuardPlatformNote(deps.platform)
  if (cfg.enabled && !platformNote.supported) {
    throw new MemoryGuardUnavailableError(
      `[p0-probe] memory guard: platform ${deps.platform} unsupported; refusing to run the P0 benchmark unguarded. ` +
        `Supported: darwin, linux. Override only explicitly with ${MEMORY_GUARD_ENV.enabled}=0.`,
    )
  }
  const vszRailActive = platformNote.supported && platformNote.vszRailNote === null
  const started = deps.now()
  const configured: MemoryGuardResult["configured"] = {
    enabled: cfg.enabled,
    pollMs: cfg.pollMs,
    maxProcessRssBytes: cfg.maxProcessRssBytes,
    maxAggregateRssBytes: cfg.maxAggregateRssBytes,
    maxProcessVszBytes: cfg.maxProcessVszBytes,
    label: MEMORY_GUARD_LABEL,
    env: [...Object.values(MEMORY_GUARD_ENV)],
    platform: deps.platform,
    vszRailNote: cfg.enabled ? platformNote.vszRailNote : null,
  }

  let stopped = false
  let interval: unknown = null
  let pollCount = 0
  let totalPollMs = 0
  let maxPollMs = 0
  let maxAggregateRss = 0
  let maxOwnedCount = 0
  let maxProcessRss = 0
  let maxProcessVsz = 0
  let maxProcess: MemoryGuardResult["maxProcess"] = null
  let breach: GuardBreach | null = null
  let failure: MemoryGuardResult["failure"] = null
  const series: MemoryGuardSeriesEntry[] = []
  let resolveBreached: (b: GuardBreach | null) => void = () => {}
  let rejectBreached: (err: unknown) => void = () => {}
  const breached = new Promise<GuardBreach | null>((resolve, reject) => {
    resolveBreached = resolve
    rejectBreached = reject
  })

  // Exact backend identity (PID + immutable CLI path + raw start) registered
  // as soon as spawn.done/CLI path are observable. Seeded as an owned root on
  // every poll regardless of PPID so the backend+descendants remain monitored
  // after Extension Host exit/reparenting; per-poll verification means a
  // reused PID is never counted owned and never signaled.
  let registeredBackend: BackendRoot | null = null
  let backendState: BackendTrack | null = null

  /**
   * A poll (ps invocation or computation) failed: the guard cannot monitor.
   * Record the bounded failure, stop polling, and reject `breached` so the
   * lifecycle fails closed instead of continuing unguarded. Never throws — a
   * failing poll must surface through the promise, not crash the interval.
   */
  const failPoll = (err: unknown): void => {
    if (stopped) return // a prior breach/stop already settled the guard
    const detail = boundEvidence(err instanceof Error ? err.message : String(err), MAX_COMMAND_BYTES)
    failure = { reason: "ps-failed", detail, t: deps.now() }
    stopped = true
    if (interval !== null) {
      deps.clearInterval(interval)
      interval = null
    }
    rejectBreached(
      new MemoryGuardUnavailableError(
        `[p0-probe] memory guard: ps poll failed; polling stopped: ${detail}`,
      ),
    )
  }

  const pollOnce = (): void => {
    if (stopped || !cfg.enabled) return
    try {
      runPoll()
    } catch (err) {
      failPoll(err)
    }
  }

  const runPoll = (): void => {
    const t0 = deps.now()
    const stdout = deps.ps(PS_ARGS)
    const ms = deps.now() - t0
    pollCount++
    totalPollMs += ms
    if (ms > maxPollMs) maxPollMs = ms
    const backend = registeredBackend
    const tree = buildOwnedTree(parsePsRows(stdout), userData, backend ?? undefined)
    const aggregate = tree.aggregateRssKb * KB
    if (aggregate > maxAggregateRss) maxAggregateRss = aggregate
    if (tree.pids.size > maxOwnedCount) maxOwnedCount = tree.pids.size
    const top = tree.maxRss
    if (top) {
      const rss = top.rssKb * KB
      const vsz = top.vszKb * KB
      if (rss > maxProcessRss) {
        maxProcessRss = rss
        maxProcessVsz = vsz
        maxProcess = { pid: top.pid, ppid: top.ppid, rss, vsz, command: boundCommand(top.args) }
      }
      series.push({ t: deps.now(), aggregateRss: aggregate, topRss: rss, topVsz: vsz, topPid: top.pid, count: tree.pids.size })
    } else {
      series.push({ t: deps.now(), aggregateRss: aggregate, topRss: 0, topVsz: 0, topPid: 0, count: 0 })
    }
    if (series.length > MAX_SERIES) series.shift()
    if (backend) backendState = observeBackend(backend, tree.backendStatus, deps.now(), backendState)
    const b = checkBreach(tree, cfg, vszRailActive, deps.now(), deps.now() - started)
    if (b !== null && breach === null) {
      breach = b
      stopped = true
      if (interval !== null) {
        deps.clearInterval(interval)
        interval = null
      }
      resolveBreached(b)
      // A failing mitigation callback must never crash the poll loop.
      try {
        const result = deps.onBreach?.(b)
        if (result && typeof (result as Promise<void>).then === "function") {
          void Promise.resolve(result).catch((err) => {
            console.error(`[p0-probe] memory guard onBreach failed: ${err instanceof Error ? err.message : String(err)}`)
          })
        }
      } catch (err) {
        console.error(`[p0-probe] memory guard onBreach failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  if (cfg.enabled) {
    interval = deps.setInterval(pollOnce, cfg.pollMs)
    let initDetail: string | null = null
    try {
      runPoll()
    } catch (err) {
      initDetail = boundEvidence(err instanceof Error ? err.message : String(err), MAX_COMMAND_BYTES)
      failPoll(err)
    }
    if (initDetail !== null) {
      // The very first poll could not run (ps unavailable): the guard cannot
      // monitor at all. Fail closed BEFORE launch rather than run unguarded.
      breached.catch(() => undefined) // the throw below is the surfaced cause
      throw new MemoryGuardUnavailableError(
        `[p0-probe] memory guard: initial ps poll failed; refusing to run the P0 benchmark unguarded: ${initDetail}`,
      )
    }
  } else {
    resolveBreached(null)
  }

  return {
    result: () => {
      const result: MemoryGuardResult = {
        configured,
        failure,
        pollCount,
        totalPollMs,
        maxPollMs,
        maxAggregateRss,
        maxOwnedCount,
        maxProcessRss,
        maxProcessVsz,
        maxProcess,
        breach,
        series: series.slice(),
      }
      if (backendState?.latest !== undefined) result.backend = backendState.latest
      return result
    },
    breached,
    pollOnce,
    registerBackend: (identity: BackendRoot) => {
      if (registeredBackend && registeredBackend.pid === identity.pid) return
      registeredBackend = identity
      backendState = observeBackend(identity, null, 0, null)
      if (!stopped && cfg.enabled) pollOnce()
    },
    backendIdentity: () =>
      registeredBackend
        ? { pid: registeredBackend.pid, cliPath: registeredBackend.cliPath, start: registeredBackend.start, registeredAt: registeredBackend.registeredAt }
        : null,
    stop: () => {
      if (stopped) return
      stopped = true
      if (interval !== null) {
        deps.clearInterval(interval)
        interval = null
      }
      resolveBreached(null)
    },
  }
}
