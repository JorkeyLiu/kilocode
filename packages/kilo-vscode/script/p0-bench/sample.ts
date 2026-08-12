/**
 * Per-lifecycle VS Code Extension Host probe for the P0 benchmark harness.
 *
 * Runs ONE real VS Code lifecycle (current workspace extension + bundled
 * backend binary) with Playwright over CDP, KILO_P0_PERF capture, fixture
 * seeding coordination, and exact-owned cleanup — the P0 analogue of
 * script/e2e-probe.ts, kept in isolated files so the existing E2E scenarios
 * are untouched.
 *
 * Lifecycle shapes by scenario:
 *   - cold-type (cold-start / no-provider / custom-provider / many-agent-mcp):
 *     the harness seeded the scratch XDG kilo config before launch; the probe
 *     opens the Agent Manager, waits for the current extensionDataReady gate
 *     (`dataReady.done`, LOCK-012), proves backend provenance from the live
 *     process, then ends the lifecycle. One sample per lifecycle.
 *   - warm-view: the runner keeps the shared backend worker live while the
 *     probe drives `cycles` close/reopen cycles through markers; each reopened
 *     panel's webview + dataReady records form one cycle sample.
 *   - session-switch: the runner seeds N deterministic sessions; the probe
 *     clicks the real tab strip via Playwright and records action→settled
 *     latency per switch (Playwright-visible UI state).
 *
 * Cleanup is exact and identical to the existing probe: every owned process is
 * terminated by exact PID (matched to the unique user-data dir), the backend by
 * exact identity (PID + raw start + pinned CLI path), and the run-owned MCP
 * fixture by exact identity too (PID + raw start + exact fixture script path,
 * re-verified before each signal — never a bare PID). The CDP port is verified
 * released, and the scratch dir is deleted only afterwards. A fixture identity
 * that cannot be verified fails closed (no signal); a fixture survivor or
 * mismatch fails the sample/run and blocks scratch deletion.
 *
 * MUST run under Node (Playwright CDP under Bun hangs — see e2e-probe.ts).
 */

import { runTests } from "@vscode/test-electron"
import { chromium, type Browser, type Frame, type Page } from "@playwright/test"
import { build } from "esbuild"
import { spawnSync } from "node:child_process"
import { createServer } from "node:net"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { createHash } from "node:crypto"
import type {
  BackendProvenance,
  CliSnapshotInfo,
  Condition,
  GuardBreach,
  KeyLatencies,
  McpFixtureEvidence,
  MemoryGuardResult,
  SampleEnv,
  SampleRecord,
  ScenarioID,
  StageRecord,
} from "./types"
import { COLD_SCENARIOS } from "./types"
import type { CaptureResult, CaptureState, ParsedRecords } from "./parse"
import {
  createCapture,
  durationBetween,
  findStage,
  findStages,
  flushCapture,
  ingestCapture,
  lifecycleTeardownSteps,
  runCleanupSteps,
  sliceStages,
} from "./parse"
import { phaseForSample } from "./phase"
import {
  MemoryGuardUnavailableError,
  exactTerminateBackend,
  memoryGuardConfig,
  parseLstartLine,
  realGuardDeps,
  startMemoryGuard,
  verifyBackendRow,
  verifyProcessRow,
  type BackendCleanupOutcome,
  type BackendRoot,
  type BackendVerification,
  type MemoryGuard,
  type ProcessRoot,
} from "./memory-guard"

export interface LifecycleOptions {
  root: string
  scenario: ScenarioID
  condition: Condition
  scratch: string
  fixtureId: string
  /** 1-based sample index across the scenario campaign (for records). */
  sample: number
  /** Cycle count for warm-view; switch count for session-switch. */
  cycles: number
  warmup: number
  logDir: string
  extensionVersion: string
  vscodeVersion: string
  gitHead: string | null
  /** Full 40-char HEAD commit, derived once at campaign start. */
  gitCommit: string | null
  /** Worktree dirty state, derived once at campaign start. */
  gitDirty: boolean
  backendCli: string | null
  /** Immutable per-campaign CLI snapshot provenance (additive). */
  cliSnapshot?: CliSnapshotInfo
  /** Exact absolute path of the run-owned MCP fixture script
   * (script/p0-bench/mcp-fixture.mjs), verified in the fixture's process args
   * as part of its exact identity (many-agent-mcp scenario). */
  mcpFixturePath: string
}

export interface LifecycleResult {
  samples: SampleRecord[]
  ok: boolean
  blockedReason: string | null
  blockedDetail: string
  elapsedMs: number
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// Memory guard abort (bounded evidence; see script/p0-bench/memory-guard.ts)
// ---------------------------------------------------------------------------

/** Thrown when the run-owned memory guard breaches an engineering safety rail. */
class GuardAbortError extends Error {
  constructor(readonly breach: GuardBreach) {
    super("memory-guard-abort")
    this.name = "GuardAbortError"
  }
}

/**
 * Race a promise (a Playwright wait/click or any other drive step) against the
 * memory-guard abort promise so a breach or a guard poll failure surfaces as
 * soon as the guard resolves/rejects it — never after the action's own
 * timeout. The abort promise only settles by rejecting with GuardAbortError
 * (breach) or MemoryGuardUnavailableError (ps poll failed; fail closed), so
 * the action's normal result/timeout is otherwise unaffected.
 */
export function raceGuardAbort<T>(action: Promise<T>, abort: Promise<never>): Promise<T> {
  return Promise.race([action, abort])
}

/**
 * Fail-fast signal for the VS Code launch promise (runTests): observes the
 * launch promise at creation so an early rejection (e.g. the extension host
 * fails to launch because a seeded config is invalid against the production
 * schema) can never become an unhandled rejection that crashes the process
 * before the campaign finish and cleanup. The signal never settles on a
 * successful launch (the drive remains the lifecycle's sole decision-maker)
 * and rejects with the launch error the moment runTests rejects; racing it
 * with the drive fails the lifecycle promptly with bounded blocked evidence
 * instead of waiting out the CDP/ready timeouts.
 */
export function launchFailureSignal(launch: Promise<number>): Promise<never> {
  return launch.then(
    () => new Promise<never>(() => {}),
    (err) => Promise.reject(err),
  )
}

/**
 * On a memory guard breach: write the done marker (the in-VS-Code runner exits
 * on it) and terminate only exact owned PIDs via the existing cleanup helper,
 * plus the identity-checked backend termination. Bounded evidence is already
 * captured on the breach object; this is prompt mitigation so a runaway cannot
 * freeze the machine while teardown proceeds. The teardown's own cleanup steps
 * (settle → exact PID → exact backend identity → port release → scratch
 * delete) still run afterwards and remain authoritative.
 */
async function onGuardBreach(
  b: GuardBreach,
  doneFile: string,
  userData: string,
  backendOf: () => MemoryGuard | null,
): Promise<void> {
  const gb = (n: number) => `${Math.round(n / 1024 / 1024)} MiB`
  console.error(
    `[p0-probe] MEMORY GUARD ABORT (${b.reason}): aggregateRss=${gb(b.aggregateRss)} ` +
      `maxProcessRss=${gb(b.maxProcessRss)} maxProcessVsz=${gb(b.maxProcessVsz)} ` +
      `pid=${b.pid} ppid=${b.ppid} owned=${b.ownedCount} command=${b.command}`,
  )
  try {
    writeFileSync(doneFile, "done")
  } catch (err) {
    console.error(
      `[p0-probe] memory guard: done marker write failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const remaining = await terminateOwned(userData, 3_000)
  if (remaining > 0) {
    console.error(`[p0-probe] memory guard: ${remaining} owned VS Code processes survived termination`)
  }
  const identity = backendOf()?.backendIdentity()
  if (identity) {
    const outcome = await terminateBackendWithPs(identity, 3_000)
    if (!outcome.terminated) {
      console.error(
        `[p0-probe] memory guard: backend PID ${identity.pid} not cleanly terminated (${outcome.status}: ${outcome.detail ?? "unknown"})`,
      )
    } else {
      console.log(`[p0-probe] memory guard: backend PID ${identity.pid} terminated by exact identity`)
    }
  }
}

// ---------------------------------------------------------------------------
// Process / scratch ownership (same semantics as script/e2e-probe.ts)
// ---------------------------------------------------------------------------

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (!address || typeof address !== "object") throw new Error("p0 probe: failed to allocate a free CDP port")
  return address.port
}

async function portFree(port: number): Promise<boolean> {
  const server = createServer()
  return new Promise((resolve) => {
    server.once("error", () => resolve(false))
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true))
    })
  })
}

/** Every process whose args contain `needle` (exact substring, never a name match). */
function processesMatching(needle: string): Array<{ pid: number; args: string }> {
  const proc = spawnSync("ps", ["-axo", "pid=,args="], { encoding: "utf8" })
  const out = proc.stdout ?? ""
  return out
    .split("\n")
    .filter((line) => line.includes(needle))
    .map((line) => line.trim())
    .map((line) => {
      const space = line.indexOf(" ")
      return { pid: Number(line.slice(0, space)), args: line.slice(space + 1) }
    })
    .filter((p) => Number.isFinite(p.pid) && p.pid > 0)
}

function processesWithUserData(userData: string): Array<{ pid: number; args: string }> {
  return processesMatching(userData)
}

/** Every live process whose args still run from the exact CLI snapshot path. */
export function processesWithPath(path: string): Array<{ pid: number; args: string }> {
  return processesMatching(path)
}

/**
 * Live identity of one process: PID + raw `lstart` start string + args, read
 * atomically from a single `ps -p <pid> -o lstart=,args=` call. Returns null
 * when the process is not in the table (exited) or the line is unparsable.
 */
function processIdentity(pid: number): { pid: number; start: string; args: string } | null {
  const proc = spawnSync("ps", ["-p", String(pid), "-o", "lstart=,args="], { encoding: "utf8" })
  const out = (proc.stdout ?? "").trim()
  if (!out) return null
  const parsed = parseLstartLine(out)
  if (!parsed) return null
  return { pid, start: parsed.start, args: parsed.rest }
}

/**
 * Verify a backend identity (PID + pinned CLI path + raw start) against the
 * live process table. Used before accepting a registration and immediately
 * before each termination signal. A mismatch (start or path changed) means the
 * PID was reused — never signal it.
 */
function verifyBackendIdentityPs(identity: BackendRoot): BackendVerification {
  const row = processIdentity(identity.pid)
  if (!row) {
    return { status: "missing", detail: "backend process not found in ps" }
  }
  return verifyBackendRow(identity, { pid: row.pid, ppid: 0, rssKb: 0, vszKb: 0, start: row.start, args: row.args })
}

/**
 * Build and accept the backend identity from the extension's own records: the
 * `spawn.done` PID plus the logged CLI path, verified against the live process
 * (args contain the exact pinned CLI path + `serve`, raw start captured).
 * Returns null when the live process does not verify (e.g. already exited).
 */
function verifiedBackendIdentity(pid: number, cliPath: string): BackendRoot | null {
  const row = processIdentity(pid)
  if (!row) return null
  if (!row.args.includes(resolve(cliPath)) || !row.args.includes("serve")) return null
  return { pid, cliPath, start: row.start, registeredAt: Date.now() }
}

/**
 * Poll the parsed records until `spawn.done` PID + CLI path are observable,
 * then return the verified backend identity (the caller registers it with the
 * guard). Best-effort: returns the identity or null on timeout/cancellation.
 * Races the abort promise so a guard breach or poll failure stops the wait
 * promptly. `regSignal.cancelled` stops the loop (teardown settle bound) so no
 * late registration can mutate guard state mid-teardown.
 */
export async function awaitBackendIdentity(
  records: () => ParsedRecords,
  abort: Promise<never>,
  timeoutMs: number,
  regSignal?: { cancelled: boolean },
): Promise<BackendRoot | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (regSignal?.cancelled) return null
    const peek = records()
    if (peek.spawnedPid !== null && peek.cliPath) {
      const identity = verifiedBackendIdentity(peek.spawnedPid, peek.cliPath)
      if (identity) return identity
    }
    if (Date.now() > deadline) return null
    await Promise.race([sleep(100), abort])
  }
}

/**
 * Bounded settle for the backend registration before teardown reads the
 * guard's backend identity: await the pending registration, but cap the wait
 * at `settleMs`. On window expiry the registration loop is cancelled (via
 * `regSignal`) so a late registration can never register the backend after
 * cleanup already read the identity. The identity is null when the window
 * expired; `timedOut` distinguishes that from a registration that genuinely
 * resolved with null.
 */
export async function settleBackendRegistration(
  reg: Promise<BackendRoot | null>,
  regSignal: { cancelled: boolean },
  settleMs: number,
): Promise<{ identity: BackendRoot | null; timedOut: boolean }> {
  return Promise.race([
    reg.then((identity) => ({ identity, timedOut: false })),
    sleep(settleMs).then(() => {
      regSignal.cancelled = true
      return { identity: null, timedOut: true }
    }),
  ])
}

/**
 * Exact identity-checked backend termination: re-verify PID + start + pinned
 * CLI path immediately before each SIGTERM/SIGKILL via the live process table
 * (never signal a missing/mismatch identity). Returns the cleanup outcome.
 */
export async function terminateBackendWithPs(identity: BackendRoot, graceMs: number): Promise<BackendCleanupOutcome> {
  return exactTerminateBackend(
    () => verifyBackendIdentityPs(identity),
    (sig) => {
      try {
        process.kill(identity.pid, sig)
      } catch {
        // already exited — the final verification reports the truth
      }
    },
    graceMs,
    sleep,
  )
}

/**
 * Discover and verify the run-owned MCP fixture identity right after the
 * handshake marker appears: PID from the marker, raw `lstart` start string +
 * args from the live process table. Returns null when the process is not in
 * the table (already exited) or its args no longer contain the exact fixture
 * script path (exited/reused) — the caller then fails closed and never signals
 * (a bare PID is never trusted).
 */
export function verifiedFixtureIdentity(pid: number, scriptPath: string): ProcessRoot | null {
  const row = processIdentity(pid)
  if (!row) return null
  if (!row.args.includes(scriptPath)) return null
  return { pid, start: row.start, path: scriptPath }
}

/**
 * Verify a run-owned MCP fixture identity (PID + raw start + exact fixture
 * script path) against the live process table. Used immediately before each
 * cleanup signal: a mismatch means the PID was reused — never signal it.
 */
export function verifyFixturePs(identity: ProcessRoot): BackendVerification {
  const row = processIdentity(identity.pid)
  if (!row) {
    return { status: "missing", detail: "MCP fixture process not found in ps" }
  }
  return verifyProcessRow(
    identity,
    { pid: row.pid, ppid: 0, rssKb: 0, vszKb: 0, start: row.start, args: row.args },
    "fixture script path",
  )
}

/**
 * Exact identity-checked termination for the run-owned MCP fixture:
 * re-verifies PID + raw start + exact fixture script path immediately before
 * each SIGTERM/SIGKILL via the live process table (never signals a
 * missing/mismatch identity — a reused PID is never killed). SIGTERM → grace →
 * re-verify → SIGKILL → grace → final verify. Clean only when the identity is
 * finally missing.
 */
export function terminateFixtureWithPs(identity: ProcessRoot, graceMs: number): Promise<BackendCleanupOutcome> {
  return exactTerminateBackend(
    () => verifyFixturePs(identity),
    (sig) => {
      try {
        process.kill(identity.pid, sig)
      } catch {
        // already exited — the final verification reports the truth
      }
    },
    graceMs,
    sleep,
  )
}

/** Mutable MCP fixture evidence for one lifecycle (discovery + cleanup outcome). */
export function emptyMcpFixtureEvidence(): McpFixtureEvidence {
  return { handshake: null, identity: null, discoveryError: null, cleanup: { status: "not-attempted", detail: null } }
}

/**
 * Exact identity-checked MCP fixture cleanup (many-agent-mcp). Fail-closed:
 * with the marker present but the identity never discovered/verified, no signal
 * is ever sent and the outcome is `failed` (the caller throws → sample/run
 * non-success, scratch retained). With no marker there is no fixture to clean.
 * Otherwise the fixture is terminated by exact identity (PID + raw start +
 * fixture script path, re-verified before each signal) and the outcome records
 * the cleanup status as evidence. `terminate` is injectable for tests; the
 * production default re-verifies against the live process table.
 */
export async function cleanupMcpFixture(
  markerPath: string,
  state: McpFixtureEvidence,
  graceMs: number,
  terminate: (identity: ProcessRoot, graceMs: number) => Promise<BackendCleanupOutcome> = terminateFixtureWithPs,
): Promise<McpFixtureEvidence["cleanup"]> {
  if (!existsSync(markerPath)) {
    state.cleanup = { status: "not-attempted", detail: "no MCP fixture marker (fixture never connected)" }
    return state.cleanup
  }
  const identity = state.identity
  if (!identity) {
    const why = state.discoveryError !== null ? ` (${state.discoveryError})` : ""
    state.cleanup = {
      status: "failed",
      detail:
        `MCP fixture identity never verified (pid=${state.handshake?.pid ?? "unknown"})${why}; ` +
        `refusing to signal a possibly reused PID`,
    }
    return state.cleanup
  }
  const outcome = await terminate(identity, graceMs)
  if (!outcome.terminated) {
    state.cleanup = {
      status: "failed",
      detail: `MCP fixture PID ${identity.pid} not cleanly terminated (${outcome.status}: ${outcome.detail ?? "unknown"})`,
    }
    return state.cleanup
  }
  state.cleanup = {
    status: "clean",
    detail: `MCP fixture PID ${identity.pid} cleaned by exact identity (PID + raw start + fixture script path re-verified before each signal)`,
  }
  return state.cleanup
}

/**
 * Attach the run-owned MCP fixture evidence (handshake + identity + cleanup
 * status) to every many-agent-mcp sample. A failed cleanup already failed the
 * samples through the teardown-evidence path (applyTeardownNotes); this only
 * records the evidence truthfully on the emitted records.
 */
export function applyMcpFixtureEvidence(
  samples: SampleRecord[],
  scenario: ScenarioID,
  evidence: McpFixtureEvidence,
): void {
  if (scenario !== "many-agent-mcp") return
  for (const s of samples) s.mcpFixture = evidence
}

/**
 * Fail-closed late identity discovery for an observed backend PID: read the
 * live process table and accept the identity only when the exact CLI path
 * (snapshot or bundled) + `serve` still appear in the process args, capturing
 * the raw `lstart` start string. Used after a best-effort registration did not
 * settle, BEFORE final cleanup, so a reparented backend can still be claimed
 * by exact identity and terminated. Returns null when not verifiable (process
 * gone, ps unavailable, or PID reused by a process not running from the exact
 * path) — the PID is never signaled on that basis (LOCK-PERF: never signal
 * without PID + start + exact snapshot path match).
 */
export function discoverBackendIdentity(pid: number, cliPath: string | null): BackendRoot | null {
  if (!cliPath) return null
  return verifiedBackendIdentity(pid, cliPath)
}

/**
 * A spawned backend PID that was observed (spawn.done) but whose stable
 * identity could never be verified. Named safely: the PID is the extension's
 * own record and the path is the run-owned snapshot/bundled CLI path.
 */
export interface UnverifiedBackend {
  /** PID observed from the extension's spawn.done record. */
  pid: number
  /** Expected CLI path (run-owned snapshot or bundled fallback) to investigate. */
  cliPath: string
}

/**
 * Campaign-finally survivor cleanup for the immutable CLI snapshot. Any live
 * process still running from the exact snapshot path is first claimed by exact
 * identity (PID + snapshot path + raw `lstart` from the live process table,
 * re-verified before each signal) and terminated; a survivor that cannot be
 * verified is NEVER signaled — the snapshot is preserved (the cleanup callback
 * is NOT invoked) and the campaign fails with bounded evidence naming the
 * PID/path. With no survivors the snapshot cleanup runs.
 */
export async function snapshotSurvivorCleanup(
  snapshotPath: string,
  cleanup: () => void,
  graceMs = 3_000,
): Promise<void> {
  for (const survivor of processesWithPath(snapshotPath)) {
    const identity = discoverBackendIdentity(survivor.pid, snapshotPath)
    if (!identity) continue // unverifiable now — the final scan below reports it
    const outcome = await terminateBackendWithPs(identity, graceMs)
    if (!outcome.terminated) {
      throw new Error(
        `backend survivor PID ${identity.pid} not cleanly terminated from CLI snapshot ${snapshotPath} ` +
          `(${outcome.status}: ${outcome.detail ?? "unknown"}); snapshot NOT deleted`,
      )
    }
    console.log(`[p0-bench] campaign cleanup: survivor PID ${identity.pid} terminated by exact snapshot-path identity`)
  }
  const remaining = processesWithPath(snapshotPath)
  if (remaining.length > 0) {
    throw new Error(
      `backend survivor(s) still running from CLI snapshot ${snapshotPath}: ` +
        remaining
          .map((p) => {
            const c = p.args.length > 120 ? `${p.args.slice(0, 120)}…` : p.args
            return `PID ${p.pid} (${c})`
          })
          .join(", ") +
        `; identity could not be verified — no signal sent; snapshot NOT deleted`,
    )
  }
  cleanup()
}

async function terminateOwned(userData: string, graceMs: number): Promise<number> {
  const signal = async (sig: NodeJS.Signals) => {
    const targets = processesWithUserData(userData)
    for (const p of targets) {
      try {
        process.kill(p.pid, sig)
      } catch {
        // already exited
      }
    }
    if (targets.length > 0) await sleep(graceMs)
    return processesWithUserData(userData).length
  }
  let remaining = await signal("SIGTERM")
  if (remaining > 0) remaining = await signal("SIGKILL")
  return remaining
}

function detectExecutable(root: string): string | undefined {
  const env = process.env["VSCODE_TEST_EXECUTABLE"]
  if (env) {
    if (existsSync(env)) return env
    console.warn(`[p0-probe] VSCODE_TEST_EXECUTABLE set but missing, ignoring: ${env}`)
  }
  const testDir = join(root, ".vscode-test")
  if (existsSync(testDir)) {
    const apps = readdirSync(testDir)
      .filter((name) => name.startsWith("vscode-"))
      .sort()
      .reverse()
    for (const app of apps) {
      const macDir = join(testDir, app, "Visual Studio Code.app", "Contents", "MacOS")
      if (existsSync(macDir)) {
        for (const name of readdirSync(macDir)) {
          const candidate = join(macDir, name)
          if (basename(candidate) === "Code" || basename(candidate) === "Electron") return candidate
        }
      }
      for (const name of ["code", "Code.exe"]) {
        const candidate = join(testDir, app, name)
        if (existsSync(candidate)) return candidate
      }
    }
  }
  return undefined
}

function vscodeVersionFromExecutable(exe: string): string {
  const candidates = [
    join(dirname(dirname(dirname(exe))), "Contents", "Resources", "app", "product.json"),
    join(dirname(exe), "resources", "app", "product.json"),
  ]
  for (const candidate of candidates) {
    try {
      const product = JSON.parse(readFileSync(candidate, "utf8")) as { version?: string }
      if (typeof product.version === "string") return product.version
    } catch {
      // try next candidate
    }
  }
  return "unknown"
}

function cleanEnv() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("ELECTRON_") || key.startsWith("VSCODE_")) delete process.env[key]
  }
}

// ---------------------------------------------------------------------------
// Capture tee: intercept the probe's own stdout/stderr while runTests relays
// VS Code (and the in-process extension host) output through it. The probe
// polls parsed stage records live (readiness gates) and dumps the bounded raw
// tail to the log artifact after VS Code exits; samples run sequentially so
// one capture at a time is safe.
//
// Memory bound: raw output retention is capped at CAPTURE_BYTES (5 MiB, see
// script/p0-bench/parse.ts), including the pending partial line, which uses the
// same cap so a long unterminated line cannot grow memory without bound. P0
// records are parsed incrementally as complete lines arrive, so capturePeek()
// is an O(1) records view — no per-poll Buffer.concat/full re-parse — and
// process memory stays bounded even when a sample hangs for minutes. When the
// cap is exceeded the oldest raw bytes are dropped and every sample from the
// lifecycle is marked captureTruncated.
// ---------------------------------------------------------------------------

/** Max raw stdout/stderr bytes retained per lifecycle (documented bound). */
const CAPTURE_BYTES = 5 * 1024 * 1024

/**
 * Bounded settle window for the backend registration before teardown reads the
 * guard's backend identity: the registration runs concurrently with the drive
 * (it seeds the owned root as early as possible), so after the drive settles we
 * give it at most this long to land. A still-pending registration at the
 * deadline is cancelled (no mid-teardown mutation) and recorded as missing
 * evidence rather than silently skipped.
 */
const BACKEND_REG_SETTLE_MS = 15_000

let captureState: CaptureState | null = null

const EMPTY_RECORDS: ParsedRecords = { stages: [], cliPath: null, spawnedPid: null }

/** Extra write args after the chunk (encoding/callback), passed through. */
type WriteRest = Parameters<typeof process.stdout.write> extends [unknown, ...infer R] ? R : never

function startCapture(): () => CaptureResult {
  const state = createCapture(CAPTURE_BYTES)
  captureState = state
  const out = process.stdout.write.bind(process.stdout)
  const err = process.stderr.write.bind(process.stderr)
  const tee =
    (write: typeof out) =>
    (chunk: unknown, ...rest: WriteRest) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      if (captureState === state) ingestCapture(state, buf.toString("utf8"))
      return write(chunk as Parameters<typeof write>[0], ...rest)
    }
  process.stdout.write = tee(out) as typeof process.stdout.write
  process.stderr.write = tee(err) as typeof process.stderr.write
  let result: CaptureResult | null = null
  return () => {
    // Restore the original writers on every path; repeated calls are no-ops.
    process.stdout.write = out as typeof process.stdout.write
    process.stderr.write = err as typeof process.stderr.write
    captureState = null
    if (!result) result = flushCapture(state)
    return result
  }
}

/** Current parsed records (O(1) read; no per-poll buffer concatenation). */
function capturePeek(): ParsedRecords {
  const state = captureState
  return state ? state.records : EMPTY_RECORDS
}

/** Stages in wall-clock order for sample output (records arrive ~ordered). */
function sortedStages(stages: StageRecord[]): StageRecord[] {
  return [...stages].sort((a, b) => a.t - b.t)
}

/** Tag every emitted sample with the lifecycle's raw-capture truncation flag. */
function markCaptureTruncated(samples: SampleRecord[], truncated: boolean): void {
  for (const sample of samples) {
    sample.captureTruncated = truncated
  }
}

// ---------------------------------------------------------------------------
// CDP helpers
// ---------------------------------------------------------------------------

async function waitForCdp(port: number, timeoutMs: number, abort?: Promise<never>): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) return
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error("p0 probe: CDP endpoint did not come up in time")
    if (abort) await Promise.race([sleep(250), abort])
    else await sleep(250)
  }
}

async function waitForFile(file: string, timeoutMs: number, label: string, abort?: Promise<never>): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (existsSync(file)) return
    if (Date.now() > deadline) throw new Error(`p0 probe: timeout waiting for ${label}`)
    if (abort) await Promise.race([sleep(200), abort])
    else await sleep(200)
  }
}

/** Any live webview frame (URL starts with vscode-webview://). */
async function webviewFrame(browser: Browser): Promise<{ page: Page; frame: Frame } | undefined> {
  for (const ctx of browser.contexts()) {
    for (const page of ctx.pages()) {
      for (const frame of page.frames()) {
        if (frame.url().includes("vscode-webview")) return { page, frame }
      }
    }
  }
  return undefined
}

async function waitForWebviewFrame(browser: Browser, timeoutMs: number, abort?: Promise<never>): Promise<{ page: Page; frame: Frame }> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = await webviewFrame(browser)
    if (found) return found
    if (Date.now() > deadline) throw new Error("p0 probe: no webview frame visible via CDP")
    if (abort) await Promise.race([sleep(250), abort])
    else await sleep(250)
  }
}

/** The Agent Manager tab strip frame, anchored on any sortable session tab. */
async function waitForAgentManagerFrame(
  browser: Browser,
  timeoutMs: number,
  abort?: Promise<never>,
): Promise<{ page: Page; frame: Frame }> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    for (const ctx of browser.contexts()) {
      for (const page of ctx.pages()) {
        for (const frame of page.frames()) {
          if (!frame.url().includes("vscode-webview")) continue
          const hit = await frame
            .locator(".am-tab-sortable[data-tab-id]")
            .first()
            .count()
            .then((n) => n > 0)
            .catch(() => false)
          if (hit) return { page, frame }
        }
      }
    }
    if (Date.now() > deadline) throw new Error("p0 probe: Agent Manager tab strip frame not found via CDP")
    if (abort) await Promise.race([sleep(250), abort])
    else await sleep(250)
  }
}

// ---------------------------------------------------------------------------
// Record polling (readiness gate + cycle boundaries)
// ---------------------------------------------------------------------------

async function waitForRecord(
  records: () => ParsedRecords,
  surface: StageRecord["surface"],
  stage: string,
  afterT: number,
  timeoutMs: number,
  label: string,
  abort?: Promise<never>,
): Promise<StageRecord> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = records().stages.find((s) => s.surface === surface && s.stage === stage && s.t > afterT)
    if (found) return found
    if (Date.now() > deadline) throw new Error(`p0 probe: timeout waiting for ${label}`)
    if (abort) await Promise.race([sleep(100), abort])
    else await sleep(100)
  }
}

/** Wait until at least `minCount` occurrences of a surface+stage appear. */
async function waitForCount(
  records: () => ParsedRecords,
  surface: StageRecord["surface"],
  stage: string,
  minCount: number,
  timeoutMs: number,
  label: string,
  abort?: Promise<never>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const count = records().stages.filter((s) => s.surface === surface && s.stage === stage).length
    if (count >= minCount) return
    if (Date.now() > deadline) throw new Error(`p0 probe: timeout waiting for ${label} (count ${count}/${minCount})`)
    if (abort) await Promise.race([sleep(100), abort])
    else await sleep(100)
  }
}

// ---------------------------------------------------------------------------
// Session-switch settled detection (Playwright-visible UI state)
// ---------------------------------------------------------------------------

async function activeTabId(frame: Frame): Promise<string | undefined> {
  return frame
    .evaluate(() => {
      const containers = Array.from(document.querySelectorAll<HTMLElement>(".am-tab-sortable"))
      const active = containers.find((c) => c.querySelector(".am-tab-active"))
      return active?.getAttribute("data-tab-id") ?? undefined
    })
    .catch(() => undefined)
}

async function headerTitle(frame: Frame): Promise<string | undefined> {
  return frame
    .locator('[data-slot="task-header-title-label"]')
    .first()
    .textContent({ timeout: 500 })
    .then((s) => s?.trim())
    .catch(() => undefined)
}

async function switchSettled(frame: Frame, sessionId: string, title: string): Promise<boolean> {
  if ((await activeTabId(frame)) !== sessionId) return false
  return (await headerTitle(frame)) === title
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

function sha256File(file: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex")
  } catch {
    return null
  }
}

function provenanceFromRecords(stages: StageRecord[], cliPath: string | null, root: string): BackendProvenance {
  const spawnDone = findStage(stages, "extension", "spawn.done")
  const pid = spawnDone?.pid ?? null
  const cliExists = cliPath ? existsSync(cliPath) : false
  const cliPathInWorkspace = cliPath ? resolve(cliPath).startsWith(resolve(root) + "/") : false
  let spawnedArgsMatch = false
  let spawnedStart: string | null = null
  if (pid) {
    const identity = processIdentity(pid)
    if (identity) {
      spawnedStart = identity.start
      const relCli = cliPath ? resolve(cliPath) : join(root, "bin", "kilo")
      spawnedArgsMatch = identity.args.includes(relCli) && identity.args.includes("serve")
    }
  }
  return {
    cliPath,
    cliPathInWorkspace,
    cliExists,
    cliSha256: cliPath ? sha256File(cliPath) : null,
    cliVersionHash: (() => {
      try {
        const version = readFileSync(join(root, "bin", ".cli-version"), "utf8").trim()
        return version.length > 0 ? version : null
      } catch {
        return null
      }
    })(),
    spawnedPid: pid,
    spawnedArgsMatch,
    spawnedStart,
  }
}

// ---------------------------------------------------------------------------
// Key latency computation
// ---------------------------------------------------------------------------

function keyForStages(stages: StageRecord[]): KeyLatencies {
  const key: KeyLatencies = {}
  const activateStart = findStage(stages, "extension", "activate.start")
  const activateDone = findStage(stages, "extension", "activate.done")
  const spawnStart = findStage(stages, "extension", "spawn.start")
  const portDetected = findStage(stages, "extension", "port.detected")
  const connectStart = findStage(stages, "extension", "connect.start")
  const sseConnect = findStage(stages, "extension", "sse.connect")
  const sseConnected = findStage(stages, "extension", "sse.connected")
  const dataReadyStart = findStage(stages, "extension", "dataReady.start")
  const dataReadyDone = findStage(stages, "extension", "dataReady.done")
  const webviewLoad = findStage(stages, "webview", "webview.load")
  const webviewPaint = findStage(stages, "webview", "webview.paint")
  const listenerEnd = findStages(stages, "backend", "listener").find((s) => s.event === "p0.end")
  const serveEntry = findStage(stages, "backend", "serve_cli_entry")
  const configEnd = findStages(stages, "backend", "config_load").find((s) => s.event === "p0.end")
  const providerEnd = findStages(stages, "backend", "provider_state_init").find((s) => s.event === "p0.end")
  const bootstrapEnd = findStages(stages, "backend", "instance_bootstrap").find((s) => s.event === "p0.end")

  const set = (name: keyof KeyLatencies, value: number | undefined) => {
    if (value !== undefined) key[name] = Math.round(value * 100) / 100
  }

  set("activateMs", durationBetween(activateStart, activateDone))
  set("spawnToPortMs", durationBetween(spawnStart, portDetected))
  set("connectToSseConnectedMs", durationBetween(connectStart, sseConnected))
  set("sseConnectToConnectedMs", durationBetween(sseConnect, sseConnected))
  set("activateToDataReadyMs", durationBetween(activateStart, dataReadyDone))
  set("dataReadySpanMs", durationBetween(dataReadyStart, dataReadyDone))
  set("webviewLoadToPaintMs", durationBetween(webviewLoad, webviewPaint))
  set("loadToDataReadyMs", durationBetween(webviewLoad, dataReadyDone))
  if (listenerEnd?.duration !== undefined) set("backendListenerMs", listenerEnd.duration)
  if (listenerEnd && serveEntry) set("backendEntryToListenerMs", durationBetween(serveEntry, listenerEnd))
  if (configEnd?.duration !== undefined) set("backendConfigLoadMs", configEnd.duration)
  if (providerEnd?.duration !== undefined) set("backendProviderStateInitMs", providerEnd.duration)
  if (bootstrapEnd?.duration !== undefined) set("backendInstanceBootstrapMs", bootstrapEnd.duration)
  return key
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function compileRunner(root: string, scratch: string): Promise<string> {
  const runnerOut = join(scratch, "p0-runner.cjs")
  await build({
    entryPoints: [join(root, "tests", "e2e", "p0-bench-runner.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode"],
    outfile: runnerOut,
    logLevel: "silent",
  })
  return runnerOut
}

/**
 * Settle the backend registration before teardown reads the guard's backend
 * identity: await it within a bounded window (see settleBackendRegistration,
 * which cancels the poll loop on expiry so no late registration can mutate
 * guard state mid-teardown). Returns the settled identity — or null — plus a
 * missing-registration error string when the window expired.
 */
async function settleBackendIdentity(
  backendReg: Promise<BackendRoot | null>,
  regSignal: { cancelled: boolean },
  guard: MemoryGuard | null,
): Promise<{ identity: BackendRoot | null; error: string | null }> {
  const settled = await settleBackendRegistration(backendReg, regSignal, BACKEND_REG_SETTLE_MS)
  const identity = settled.identity ?? guard?.backendIdentity() ?? null
  if (settled.timedOut) {
    console.error(`[p0-probe] backend identity registration unsettled after ${BACKEND_REG_SETTLE_MS}ms`)
    return { identity, error: "backend identity registration did not settle within the bounded window" }
  }
  return { identity, error: null }
}

/**
 * Merge ordered-teardown failure notes into the blocked record evidence and
 * every sample: a teardown failure always fails the lifecycle. Notes are
 * byte-bounded in blocked.detail and in the failures[] entries; the later
 * cleanup evidence stays visible without suppressing the original failure.
 */
function applyTeardownNotes(
  samples: SampleRecord[],
  notes: string[],
  blockedReason: string | null,
  blockedDetail: string,
): { failed: boolean; blockedReason: string | null; blockedDetail: string } {
  if (notes.length === 0) return { failed: false, blockedReason, blockedDetail }
  const detail = notes.join("; ")
  console.error(`[p0-probe] FAIL teardown: ${detail}`)
  const mergedDetail = boundBlockedDetail(blockedDetail ? `${blockedDetail}\n${detail}` : detail)
  const reason = blockedReason ?? "teardown-failed"
  for (const sampleRecord of samples) {
    const original = sampleRecord.blocked
    sampleRecord.ok = false
    sampleRecord.failures.push(boundFailure(`cleanup-failed: ${detail}`))
    sampleRecord.blocked = {
      reason: "cleanup-failed",
      detail: boundBlockedDetail(original ? `${original.reason}: ${original.detail}\n${detail}` : detail),
    }
  }
  return { failed: true, blockedReason: reason, blockedDetail: mergedDetail }
}

/**
 * Hard fail-closed gate for missing backend ownership evidence (LOCK-PERF:
 * missing ownership evidence is failure, never baseline). When a spawned
 * backend PID was observed (spawn.done) but the stable identity never settled
 * during the lifecycle (registration timeout, ps failure, mismatch/reused PID,
 * or late discovery could not verify), every sample of the lifecycle is forced
 * to `ok:false` with blocked reason `backend-identity-unavailable` and bounded
 * evidence — a spawned-but-unregistered backend must never yield an ok
 * sample/run. A sample legitimately blocked BEFORE any spawn (no PID observed)
 * is never a false positive. Late discovery that verifies the identity only
 * prevents a leak (cleanup then terminates by exact identity); it does NOT
 * rescue the sample — the registration was still missing for stable ownership
 * during the lifecycle. The guard result merge runs after this gate so a
 * memory-guard abort still dominates.
 */
export function applyBackendIdentityGate(
  samples: SampleRecord[],
  launched: boolean,
  spawnObserved: boolean,
  registrationMissing: boolean,
  error: string | null,
  priorReason: string | null,
  priorDetail: string,
): { failed: boolean; blockedReason: string | null; blockedDetail: string } {
  if (!launched || !spawnObserved || !registrationMissing) {
    return { failed: false, blockedReason: priorReason, blockedDetail: priorDetail }
  }
  const detail =
    error !== null
      ? `backend identity registration failed: ${error}`
      : "backend identity was never verified from the spawn.done PID + CLI path records"
  for (const s of samples) {
    const original = s.blocked
    s.ok = false
    s.failures.push(boundFailure(`backend-identity-unavailable: ${error ?? "identity never verified"}`))
    s.blocked = {
      reason: "backend-identity-unavailable",
      detail: boundBlockedDetail(original ? `${original.reason}: ${original.detail}\n${detail}` : detail),
    }
  }
  console.error(`[p0-probe] FAIL backend-identity-unavailable: ${detail}`)
  return {
    failed: true,
    blockedReason: "backend-identity-unavailable",
    blockedDetail: boundBlockedDetail(priorDetail ? `${priorDetail}\n${detail}` : detail),
  }
}

/**
 * Fail-closed late identity discovery for a spawned backend PID whose
 * registration never settled (run BEFORE final cleanup): re-check PID + exact
 * snapshot/bundled CLI path + raw lstart against the live process table. When
 * verified, the exact identity is returned (the caller registers it with the
 * guard and cleanup terminates it by exact identity — no leak). When not
 * verifiable, an UnverifiedBackend is returned; no signal is ever sent,
 * cleanup reports the blocker, and the snapshot/scratch evidence is retained.
 * Either way the registration was missing during the lifecycle (the
 * applyBackendIdentityGate call in runLifecycle fails the sample) — late
 * discovery never rescues the sample, only prevents a leak.
 */
function recoverBackendByLateDiscovery(
  observedPid: number,
  observedCliPath: string | null,
  fallbackCli: string | null,
  root: string,
  guard: MemoryGuard | null,
  error: string | null,
): { identity: BackendRoot | null; unverified: UnverifiedBackend | null; error: string | null } {
  const discovered = discoverBackendIdentity(observedPid, observedCliPath ?? fallbackCli)
  if (discovered) {
    guard?.registerBackend(discovered)
    const err =
      "identity only verifiable by late discovery after the registration window (registration missing during the lifecycle)"
    console.log(
      `[p0-probe] backend identity verified by late discovery: pid=${discovered.pid} start=${discovered.start} cli=${discovered.cliPath}`,
    )
    return { identity: discovered, unverified: null, error: err }
  }
  const unverified: UnverifiedBackend = {
    pid: observedPid,
    cliPath: observedCliPath ?? fallbackCli ?? join(root, "bin", "kilo"),
  }
  const err =
    (error !== null ? `${error}; ` : "") +
    `late discovery could not verify PID ${observedPid} against the live process table`
  console.error(
    `[p0-probe] backend identity NOT verifiable by late discovery (pid=${observedPid}) — no signal; snapshot/scratch evidence retained`,
  )
  return { identity: null, unverified, error: err }
}

export async function runLifecycle(opts: LifecycleOptions): Promise<LifecycleResult> {
  const started = Date.now()
  const { root, scenario, condition, scratch, fixtureId, sample, cycles, logDir } = opts
  const timeoutMs = Number(process.env.KILO_E2E_TIMEOUT ?? 300_000)
  let vscodeRun: Promise<number> | undefined
  let browser: Browser | undefined
  let failed = false
  let blockedReason: string | null = null
  let blockedDetail = ""
  // Backend identity registration state: settled before teardown reads the
  // guard's backend identity. A failed/missing registration is recorded as
  // evidence (never hidden); `regSignal.cancelled` bounds the settle so no
  // late registration can mutate guard state mid-teardown.
  let backendReg: Promise<BackendRoot | null> = Promise.resolve(null)
  let backendRegError: string | null = null
  const regSignal = { cancelled: false }
  const resultSamples: SampleRecord[] = []
  const doneFile = join(scratch, "done")
  const env: SampleEnv = {
    os: process.platform,
    arch: process.arch,
    node: process.version,
    vscode: opts.vscodeVersion,
    extension: opts.extensionVersion,
    gitHead: opts.gitHead,
    gitCommit: opts.gitCommit,
    gitDirty: opts.gitDirty,
    backendCli: opts.backendCli,
    ...(opts.cliSnapshot ? { cliSnapshot: opts.cliSnapshot } : {}),
  }

  const cdpPort = await freePort()
  const userData = join(scratch, "user-data")
  const extensions = join(scratch, "extensions")
  const workspace = join(scratch, "workspace")
  mkdirSync(workspace, { recursive: true })

  const rawLogPath = join(logDir, `sample-${sample}-${scenario}.log`)
  const stopCapture = startCapture()

  // Run-owned process-tree memory guard, seeded on the exact unique lifecycle
  // userData path (script/p0-bench/memory-guard.ts). Started BEFORE anything
  // launches; covers readiness/drive/teardown and is stopped in the finally.
  // A start failure (unsupported platform / invalid env rails) becomes a
  // blocked sample — VS Code is never launched unguarded.
  let guard: MemoryGuard | null = null
  // Settled backend identity, captured before teardown (see the settle block
  // inside the try) and read by the cleanup step and the evidence merge below.
  let registeredIdentity: BackendRoot | null = null
  // Spawn evidence, snapshotted from the capture BEFORE teardown stops it: a
  // spawned backend PID (spawn.done) whose registration never settled is a hard
  // fail-closed failure (never ok), while a sample blocked before any spawn is
  // not a false positive.
  let observedPid: number | null = null
  let observedCliPath: string | null = null
  // True when the registration settled WITHOUT an identity (even if late
  // discovery later recovers one for cleanup) — the gate keys on this so a
  // late-verified survivor is still cleaned but never rescues the sample.
  let registrationMissing = false
  // A spawned backend PID that could not be verified even by late discovery:
  // cleanup must never signal it and must retain the snapshot/scratch evidence.
  let unverifiedBackend: UnverifiedBackend | null = null
  // Run-owned MCP fixture evidence (many-agent-mcp): the exact identity is
  // discovered right after the handshake marker appears (drive) and retained
  // through teardown, re-verified immediately before each cleanup signal, and
  // attached to every emitted sample as evidence.
  const mcp = emptyMcpFixtureEvidence()

  try {
    try {
      guard = startMemoryGuard(userData, memoryGuardConfig(process.env), {
        ...realGuardDeps(),
        onBreach: (b) => onGuardBreach(b, doneFile, userData, () => guard),
      })
      // Abort signal: rejects with GuardAbortError on breach, never settles
      // otherwise (a disabled guard has no breach). Raced against the drive so
      // a runaway aborts the lifecycle promptly; also threaded into the drive's
      // wait loops so background waits stop within one poll tick.
      const abort: Promise<never> = guard.breached.then((b) => {
        if (b) throw new GuardAbortError(b)
        return new Promise<never>(() => {})
      })

      const runnerOut = await compileRunner(root, scratch)
      const executable = detectExecutable(root)
      const vscodeVersion = executable ? vscodeVersionFromExecutable(executable) : "auto-download"
      env.vscode = vscodeVersion
      console.log(
        `[p0-probe] sample ${sample} scenario=${scenario} fixture=${fixtureId} cdp=${cdpPort} scratch=${scratch}`,
      )
      if (executable) console.log(`[p0-probe] VS Code executable: ${executable} (${vscodeVersion})`)

      vscodeRun = runTests({
        ...(executable ? { vscodeExecutablePath: executable } : {}),
        extensionDevelopmentPath: root,
        extensionTestsPath: runnerOut,
        extensionTestsEnv: {
          KILO_E2E_FIXTURE: "1",
          KILO_P0_PERF: "1",
          KILO_P0_SCRATCH: scratch,
          KILO_P0_FIXTURE_ID: fixtureId,
          KILO_P0_SCENARIO: scenario,
          KILO_P0_CYCLES: String(cycles),
          ...(scenario === "session-switch"
            ? { KILO_P0_SWITCH_SESSIONS: process.env.KILO_P0_SWITCH_SESSIONS ?? "5" }
            : {}),
          // Benchmark-only CLI snapshot pinning: the extension host spawns the
          // run-owned snapshot path, never the watcher-mutable bin/kilo.
          ...(opts.backendCli ? { KILO_P0_BACKEND_CLI: opts.backendCli } : {}),
          XDG_CONFIG_HOME: join(scratch, "xdg-config"),
          XDG_DATA_HOME: join(scratch, "xdg-data"),
          XDG_CACHE_HOME: join(scratch, "xdg-cache"),
          XDG_STATE_HOME: join(scratch, "xdg-state"),
        },
        launchArgs: [
          workspace,
          `--user-data-dir=${userData}`,
          `--extensions-dir=${extensions}`,
          `--remote-debugging-port=${cdpPort}`,
          // Loopback-only, ephemeral test profile — see script/e2e-probe.ts.
          `--remote-allow-origins=*`,
        ],
      })

      // Observe the launch promise IMMEDIATELY at creation: a rejection before
      // teardown reads it (e.g. the extension host fails to launch because a
      // seeded config is invalid) must never become an unhandled rejection
      // that crashes the process before the campaign finish and cleanup. The
      // derived signal never settles on a successful launch (the drive decides
      // the lifecycle) and rejects with the launch error on failure, so the
      // drive race below treats a launch failure as a fail-fast bounded blocked
      // sample instead of waiting out the CDP/ready waits. Losing async work
      // (the drive, the abort, the launch signal) stays observed by the race
      // so no late unhandled rejection is possible.
      const launchFail = launchFailureSignal(vscodeRun)

      const drive = (async () => {
        await waitForCdp(cdpPort, 90_000, abort)
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 30_000 })
        await waitForFile(join(scratch, "ready"), 120_000, "runner ready marker", abort)
        console.log(`[p0-probe] runner ready (${scenario})`)
        await driveScenario(opts, browser, scratch, env, resultSamples, abort, mcp)
      })()
      // Register the exact backend identity with the guard as soon as
      // spawn.done + CLI path are observable — DURING readiness, never only at
      // sample finalization — so the run-owned backend is an owned root (and
      // its descendants stay monitored) even if the Extension Host later
      // reparents it to PID 1. Best-effort: a timeout/mismatch is recorded as
      // evidence, never fatal by itself (userData seeding still applies). The
      // settled promise (null on failure) is awaited/bounded before teardown.
      backendReg = (async () => {
        const identity = await awaitBackendIdentity(() => capturePeek(), abort, 120_000, regSignal)
        if (identity) {
          guard?.registerBackend(identity)
          console.log(`[p0-probe] backend identity registered: pid=${identity.pid} start=${identity.start} cli=${identity.cliPath}`)
        } else {
          console.error(
            `[p0-probe] backend identity NOT registered (spawn.done/CLI path never verified within 120s) — ` +
              `reparented backend would only be covered by userData seeding`,
          )
        }
        return identity
      })().catch((err) => {
        // A guard breach/poll failure aborts the wait; the drive already
        // surfaces that cause. Keep the registration settled-with-null so
        // teardown proceeds, with the failure recorded as evidence.
        backendRegError = err instanceof Error ? err.message : String(err)
        console.error(`[p0-probe] backend identity registration failed: ${backendRegError}`)
        return null
      })
      await Promise.race([drive, abort, launchFail])
    } catch (err) {
      failed = true
      // Phase follows the sample/warmup rule like every other record: a blocked
      // MEASURED sample stays measured (never hardcoded to warmup).
      const blocked = blockedSampleForFailure(err, sample, scenario, condition, opts.warmup, started, env)
      blockedReason = blocked.reason
      blockedDetail = blocked.detail
      resultSamples.push(blocked.sample)
    }

    // Snapshot the spawn evidence BEFORE teardown stops the capture: a spawned
    // backend PID observed without a settled identity is a hard fail-closed
    // failure; a sample blocked before any spawn is not a false positive.
    const observed = capturePeek()
    observedPid = observed.spawnedPid
    observedCliPath = observed.cliPath

    // The registration runs concurrently with the drive; before teardown reads
    // the guard's backend identity, settle it within a bounded window so
    // cleanup sees a settled registration state (awaited, or bounded + loop
    // cancelled — never read while still in flight). A missing registration is
    // a hard failure on the samples below.
    const settled = await settleBackendIdentity(backendReg, regSignal, guard)
    registeredIdentity = settled.identity
    registrationMissing = registeredIdentity === null
    if (settled.error) backendRegError = settled.error

    // Fail-closed late identity discovery, BEFORE final cleanup: when a spawned
    // backend PID was observed but the registration never settled, attempt one
    // bounded re-check of PID + exact snapshot path + raw lstart against the
    // live process table. If verified, the exact identity is registered with
    // the guard and cleanup terminates it by exact identity (no leak). If not
    // verifiable, no signal is ever sent; cleanup returns a blocker naming the
    // PID/path and the snapshot/scratch evidence is retained. The gate below
    // still fails the sample either way — the registration was missing for
    // stable ownership during the lifecycle (LOCK-PERF).
    if (registrationMissing && observedPid !== null) {
      const recovered = recoverBackendByLateDiscovery(
        observedPid,
        observedCliPath,
        opts.backendCli,
        opts.root,
        guard,
        backendRegError,
      )
      registeredIdentity = recovered.identity
      unverifiedBackend = recovered.unverified
      backendRegError = recovered.error
    }

    // -----------------------------------------------------------------------
    // Ordered teardown. lifecycleTeardownSteps assembles the exact-ordered plan
    // (done marker → browser close → capture stop → raw log write → VS Code exit
    // → exact-owned cleanup); runCleanupSteps executes every step and collects
    // each failure instead of throwing, so a done-marker or browser-close failure
    // can never skip writer restoration, the raw log flush, the VS Code exit
    // watchdog, or the exact-owned cleanup (settle → exact PID → port release →
    // scratch deletion). A failed raw-log write surfaces as a labeled teardown
    // note (evidence loss is visible), while the later steps still run. Failures
    // surface in blockedDetail and on the samples below without suppressing the
    // original failure evidence.
    // -----------------------------------------------------------------------
    const teardownNotes = await runCleanupSteps(
      lifecycleTeardownSteps({
        writeDone: () => writeFileSync(doneFile, "done"),
        closeBrowser: async () => {
          await browser?.close()
        },
        stopCapture,
        markTruncated: (truncated) => markCaptureTruncated(resultSamples, truncated),
        // Evidence-write failures must stay visible: throw so runCleanupSteps
        // records a labeled note; the later teardown steps still run.
        writeRawLog: (text) => {
          try {
            writeFileSync(rawLogPath, text)
          } catch (err) {
            throw new Error(
              `raw log write failed for ${rawLogPath}: ${err instanceof Error ? err.message : String(err)}`,
            )
          }
        },
        waitExit: async () => {
          if (!vscodeRun) return true
          return awaitExit(vscodeRun, userData, timeoutMs)
        },
        onExitResult: (exited) => {
          if (!exited) failed = true
        },
        cleanup: () => verifyCleanup(userData, cdpPort, scratch, scenario, registeredIdentity, unverifiedBackend, mcp),
      }),
    )

    const teardownOutcome = applyTeardownNotes(resultSamples, teardownNotes, blockedReason, blockedDetail)
    failed = failed || teardownOutcome.failed
    blockedReason = teardownOutcome.blockedReason
    blockedDetail = teardownOutcome.blockedDetail
    // MCP fixture evidence (handshake + exact identity + cleanup status)
    // attaches to every many-agent-mcp sample; a failed cleanup already failed
    // the samples via the teardown notes above — this only records the
    // evidence truthfully.
    applyMcpFixtureEvidence(resultSamples, scenario, mcp)
  } finally {
    // Stop the guard LAST — after teardown — so readiness/drive/teardown are
    // all covered; never leaves a poll timer behind.
    guard?.stop()
  }

  // -------------------------------------------------------------------------
  // A spawned backend PID observed without a settled identity is a hard
  // failure — never an ok sample/run (LOCK-PERF: missing ownership evidence is
  // failure). Late discovery that verified the identity for cleanup does not
  // rescue the sample; the registration was still missing during the lifecycle.
  // -------------------------------------------------------------------------
  const identityOutcome = applyBackendIdentityGate(
    resultSamples,
    vscodeRun !== undefined,
    observedPid !== null,
    registrationMissing,
    backendRegError,
    blockedReason,
    blockedDetail,
  )
  failed = failed || identityOutcome.failed
  blockedReason = identityOutcome.blockedReason
  blockedDetail = identityOutcome.blockedDetail

  // -------------------------------------------------------------------------
  // Attach the bounded memory guard result to every emitted sample and force
  // the whole lifecycle to a failure when a safety rail was breached.
  // -------------------------------------------------------------------------
  const guardOutcome = applyGuardResult(resultSamples, guard?.result(), blockedReason, blockedDetail)
  failed = failed || guardOutcome.failed
  blockedReason = guardOutcome.blockedReason
  blockedDetail = guardOutcome.blockedDetail

  const elapsedMs = Date.now() - started
  for (const sampleRecord of resultSamples) {
    sampleRecord.elapsedMs = elapsedMs
  }
  console.log(`[p0-probe] sample ${sample} ${scenario} elapsed=${Math.round(elapsedMs / 1000)}s ok=${!failed}`)
  return {
    samples: resultSamples,
    ok: !failed,
    blockedReason: blockedReason ? boundBlockedReason(blockedReason) : null,
    blockedDetail: boundBlockedDetail(blockedDetail),
    elapsedMs,
  }
}

/**
 * Classify a lifecycle failure into the blocked record's reason/detail. A
 * memory guard breach is `memory-guard-abort` with bounded JSON evidence; a
 * guard that cannot start (unsupported platform / invalid rails) is
 * `memory-guard-unavailable`; anything else keeps its original message/stack.
 */
function classifyLifecycleError(
  err: unknown,
  sample: number,
  scenario: ScenarioID,
): { blockedReason: string; blockedDetail: string } {
  if (err instanceof GuardAbortError) {
    const detail = JSON.stringify(err.breach)
    console.error(
      `[p0-probe] MEMORY GUARD ABORT (sample ${sample} ${scenario}): ${err.breach.reason} ` +
        `aggregateRss=${err.breach.aggregateRss} maxProcessRss=${err.breach.maxProcessRss} pid=${err.breach.pid}`,
    )
    return { blockedReason: "memory-guard-abort", blockedDetail: detail }
  }
  if (err instanceof MemoryGuardUnavailableError) {
    console.error(`[p0-probe] FAIL (sample ${sample} ${scenario}): memory-guard-unavailable — ${err.message}`)
    return { blockedReason: "memory-guard-unavailable", blockedDetail: err.message }
  }
  const reason = err instanceof Error ? err.message : String(err)
  const detail = err instanceof Error ? (err.stack ?? "") : ""
  console.error(`[p0-probe] FAIL (sample ${sample} ${scenario}): ${reason}`)
  return { blockedReason: reason, blockedDetail: detail }
}

/**
 * Attach the bounded memory guard result to every emitted sample and force the
 * whole lifecycle to a failure when a safety rail was breached OR a poll
 * failed (the guard cannot monitor, so the lifecycle fails closed). A
 * guard-aborted or guard-unavailable sample is a failure, never a baseline
 * (LOCK-PERF: partial/guard-aborted samples are never baselines).
 */
function applyGuardResult(
  samples: SampleRecord[],
  guardResult: MemoryGuardResult | undefined,
  priorReason: string | null,
  priorDetail: string,
): { failed: boolean; blockedReason: string | null; blockedDetail: string } {
  if (!guardResult) return { failed: false, blockedReason: priorReason, blockedDetail: priorDetail }
  for (const s of samples) s.memoryGuard = guardResult
  if (guardResult.failure) {
    // A ps poll failed after start: the guard cannot monitor, so the lifecycle
    // must fail closed. The failure was already surfaced through the abort
    // promise when it happened mid-drive; this merge guarantees the sample
    // record carries it even when the failure landed after the drive settled.
    const detail = JSON.stringify(guardResult.failure)
    for (const s of samples) {
      const original = s.blocked
      s.ok = false
      s.failures.push(boundFailure(`memory-guard-unavailable: ${guardResult.failure.reason}`))
      s.blocked = {
        reason: "memory-guard-unavailable",
        detail: boundBlockedDetail(original ? `${original.reason}: ${original.detail}\n${detail}` : detail),
      }
    }
    return {
      failed: true,
      blockedReason: "memory-guard-unavailable",
      blockedDetail: boundBlockedDetail(priorDetail ? `${priorDetail}\n${detail}` : detail),
    }
  }
  if (!guardResult.breach) return { failed: false, blockedReason: priorReason, blockedDetail: priorDetail }
  const detail = JSON.stringify(guardResult.breach)
  for (const s of samples) {
    const original = s.blocked
    s.ok = false
    s.failures.push(boundFailure(`memory-guard-abort: ${guardResult.breach.reason}`))
    s.blocked = {
      reason: "memory-guard-abort",
      detail: boundBlockedDetail(original ? `${original.reason}: ${original.detail}\n${detail}` : detail),
    }
  }
  return {
    failed: true,
    blockedReason: "memory-guard-abort",
    blockedDetail: boundBlockedDetail(priorDetail ? `${priorDetail}\n${detail}` : detail),
  }
}

/** Hard byte cap on blocked-record evidence detail strings (bounded evidence). */
const MAX_BLOCKED_DETAIL_BYTES = 2000

/** Hard byte cap on blocked-record reason strings (clear short reason). */
const MAX_BLOCKED_REASON_BYTES = 200

/** Hard byte cap on explicit failures[] entries (bounded evidence). */
const MAX_FAILURE_BYTES = 200

/**
 * Byte-cap an evidence string to `maxBytes` bytes without splitting a UTF-8
 * sequence (the tail is replaced by the U+2026 ellipsis). Every bounded string
 * producer — blocked reason/detail and explicit failure entries — routes
 * through this single helper so no path can grow a bounded field without
 * bound.
 */
export function boundEvidence(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text
  let cut = 0
  let bytes = 0
  while (cut < text.length) {
    const c = text.charCodeAt(cut)
    const low = text.charCodeAt(cut + 1)
    const pair = c >= 0xd800 && c <= 0xdbff && low >= 0xdc00 && low <= 0xdfff
    const n = pair ? 4 : c < 0x80 ? 1 : c < 0x800 ? 2 : 3
    if (bytes + n > maxBytes) break
    bytes += n
    cut += pair ? 2 : 1
  }
  return text.slice(0, cut) + "…"
}

/**
 * Bound a blocked-record detail string to its byte cap. Every blocked.detail
 * producer — blockedSample, the teardown failure merge, and the applyGuardResult
 * merge — routes through this single helper so no path can grow the bounded
 * field without bound.
 */
export function boundBlockedDetail(detail: string): string {
  return boundEvidence(detail, MAX_BLOCKED_DETAIL_BYTES)
}

/**
 * Bound a blocked-record reason string to its byte cap (clear short reason
 * semantics: a bounded reason, with the full evidence in blocked.detail).
 */
export function boundBlockedReason(reason: string): string {
  return boundEvidence(reason, MAX_BLOCKED_REASON_BYTES)
}

/** Bound an explicit failures[] entry to its byte cap. */
export function boundFailure(failure: string): string {
  return boundEvidence(failure, MAX_FAILURE_BYTES)
}

function blockedSample(
  scenario: ScenarioID,
  condition: Condition,
  sample: number,
  phase: "warmup" | "measured",
  startedAt: number,
  env: SampleEnv,
  reason: string,
  detail: string,
): SampleRecord {
  return {
    v: 1,
    kind: "sample",
    scenario,
    condition,
    sample,
    cycle: 0,
    phase,
    lifecycle: 1,
    startedAt,
    elapsedMs: 0,
    env,
    provenance: EMPTY_PROVENANCE,
    key: {},
    stages: [],
    failures: [boundFailure(reason)],
    blocked: { reason: boundBlockedReason(reason), detail: boundBlockedDetail(detail) },
    ok: false,
  }
}

/** Await the VS Code lifecycle exit with the exact-owned watchdog. */
async function awaitExit(vscodeRun: Promise<number>, userData: string, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let watchdogDone: Promise<number> | undefined
  const watch = new Promise<number>((resolve) => {
    timer = setTimeout(() => {
      console.error(`[p0-probe] FAIL: VS Code did not exit within ${timeoutMs}ms`)
      watchdogDone = terminateOwned(userData, 2_000)
      resolve(1)
    }, timeoutMs)
  })
  const code = await Promise.race([vscodeRun, watch]).catch((err) => {
    console.error(`[p0-probe] FAIL: runTests error: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  })
  if (timer) clearTimeout(timer)
  if (watchdogDone) {
    const remaining = await watchdogDone
    if (remaining > 0) {
      console.error(`[p0-probe] FAIL: ${remaining} owned VS Code processes survived termination`)
      return false
    }
  }
  console.log(`[p0-probe] VS Code exited (code ${code})`)
  return code === 0
}

/**
 * The no-sample fallback for a lifecycle failure: when the drive produced no
 * normal sample (e.g. a launch failure before any readiness gate), produce at
 * least one bounded blocked sample so the campaign retains evidence and
 * finishes with a truthful non-ok status. Classification is shared with every
 * other failure path (memory-guard-abort, memory-guard-unavailable, generic),
 * so the blocked reason/detail stay consistent and bounded. Extracted so the
 * no-sample fallback is deterministically testable without launching VS Code.
 */
export function blockedSampleForFailure(
  err: unknown,
  sample: number,
  scenario: ScenarioID,
  condition: Condition,
  warmup: number,
  startedAt: number,
  env: SampleEnv,
): { sample: SampleRecord; reason: string; detail: string } {
  const classification = classifyLifecycleError(err, sample, scenario)
  return {
    sample: blockedSample(
      scenario,
      condition,
      sample,
      phaseForSample(sample, warmup),
      startedAt,
      env,
      classification.blockedReason,
      classification.blockedDetail,
    ),
    reason: classification.blockedReason,
    detail: classification.blockedDetail,
  }
}

/** Dispatch to the scenario-specific lifecycle driver. */
async function driveScenario(
  opts: LifecycleOptions,
  browser: Browser,
  scratch: string,
  env: SampleEnv,
  out: SampleRecord[],
  abort: Promise<never>,
  mcp: McpFixtureEvidence,
): Promise<void> {
  if (COLD_SCENARIOS.has(opts.scenario)) {
    await driveColdScenario(opts, browser, scratch, env, out, abort, mcp)
    return
  }
  if (opts.scenario === "warm-view") {
    await waitForWebviewFrame(browser, 30_000, abort)
    await handleWarmViewCycles(opts, browser, scratch, out, env, abort)
    return
  }
  if (opts.scenario === "session-switch") {
    await handleSessionSwitches(opts, browser, scratch, out, env, abort)
    return
  }
  throw new Error(`unsupported scenario: ${opts.scenario}`)
}

async function driveColdScenario(
  opts: LifecycleOptions,
  browser: Browser,
  scratch: string,
  env: SampleEnv,
  out: SampleRecord[],
  abort: Promise<never>,
  mcp: McpFixtureEvidence,
): Promise<void> {
  // LOCK-012: wait for the current extensionDataReady gate to fire.
  const dataReady = await waitForRecord(
    () => capturePeek(),
    "extension",
    "dataReady.done",
    0,
    180_000,
    "dataReady.done gate",
    abort,
  )
  console.log(`[p0-probe] dataReady.done at t=${dataReady.t}`)
  await waitForWebviewFrame(browser, 30_000, abort)
  if (opts.scenario === "many-agent-mcp") {
    const mcpMarker = join(scratch, "mcp-connected")
    await waitForFile(mcpMarker, 90_000, "MCP fixture connect marker", abort)
    // The marker is written by the fixture only after the REAL MCP handshake
    // (initialize → tools/list) succeeded. Discover the exact-owned identity
    // (PID + raw lstart + fixture script path in args) while the fixture is
    // known alive; it is retained through teardown and re-verified immediately
    // before each cleanup signal. A marker we cannot verify fails closed at
    // cleanup (never signal a bare/unverified PID).
    let handshake: { pid: number; connectedAt: number } | null = null
    const rawMarker = readFileSync(mcpMarker, "utf8").trim()
    try {
      const parsed = JSON.parse(rawMarker) as { pid?: unknown; connectedAt?: unknown }
      if (typeof parsed.pid === "number" && parsed.pid > 0 && typeof parsed.connectedAt === "number") {
        handshake = { pid: parsed.pid, connectedAt: parsed.connectedAt }
      } else {
        mcp.discoveryError = "marker JSON missing pid/connectedAt"
      }
    } catch {
      mcp.discoveryError = `marker unparsable: ${boundEvidence(rawMarker, MAX_FAILURE_BYTES)}`
    }
    if (handshake) {
      mcp.handshake = handshake
      const identity = verifiedFixtureIdentity(handshake.pid, opts.mcpFixturePath)
      if (identity) {
        mcp.identity = identity
        console.log(
          `[p0-probe] MCP fixture identity verified: pid=${identity.pid} start=${identity.start} path=${identity.path}`,
        )
      } else {
        mcp.discoveryError =
          `PID ${handshake.pid} did not verify against the live process table ` +
          `(exited, reused, or args no longer contain the exact fixture script path ${opts.mcpFixturePath})`
        console.error(`[p0-probe] MCP fixture identity NOT verified: ${mcp.discoveryError}`)
      }
    }
    console.log(`[p0-probe] MCP fixture connected (handshake=${JSON.stringify(mcp.handshake)})`)
  }
  // Prove the backend belongs to the current workspace while it is live.
  // Brief settle so trailing webview/webview.ready records land before the
  // sample's raw stages are frozen.
  await sleep(500)
  const peek = capturePeek()
  const provenance = provenanceFromRecords(peek.stages, peek.cliPath, opts.root)
  console.log(
    `[p0-probe] provenance: cli=${provenance.cliPath} inWorkspace=${provenance.cliPathInWorkspace} pid=${provenance.spawnedPid} argsMatch=${provenance.spawnedArgsMatch}`,
  )
  out.push(await buildColdSample(opts, env, provenance, mcp))
}

async function buildColdSample(
  opts: LifecycleOptions,
  env: SampleEnv,
  provenance: BackendProvenance,
  mcp: McpFixtureEvidence,
): Promise<SampleRecord> {
  const stages = sortedStages(capturePeek().stages)
  const key: KeyLatencies = keyForStages(stages)
  if (opts.scenario === "many-agent-mcp" && mcp.handshake) {
    const serveEntry = findStage(stages, "backend", "serve_cli_entry")
    if (serveEntry) key.mcpConnectMs = Math.round((mcp.handshake.connectedAt - serveEntry.t) * 100) / 100
  }
  return {
    v: 1,
    kind: "sample",
    scenario: opts.scenario,
    condition: opts.condition,
    sample: opts.sample,
    cycle: 0,
    phase: phaseForSample(opts.sample, opts.warmup),
    lifecycle: 1,
    startedAt: Date.now(),
    elapsedMs: 0,
    env,
    provenance,
    key,
    stages,
    failures: [],
    blocked: null,
    ok: true,
  }
}

async function handleWarmViewCycles(
  opts: LifecycleOptions,
  browser: Browser,
  scratch: string,
  out: SampleRecord[],
  env: SampleEnv,
  abort: Promise<never>,
): Promise<void> {
  // Cycle 0 = the initial open (includes spawn/connect) — always warmup.
  await waitForRecord(() => capturePeek(), "extension", "dataReady.done", 0, 180_000, "initial dataReady.done", abort)
  const cycleStages = (startT: number, endT: number): StageRecord[] =>
    sliceStages(capturePeek().stages, startT, endT)
  out.push({
    v: 1,
    kind: "sample",
    scenario: opts.scenario,
    condition: opts.condition,
    sample: opts.sample,
    cycle: 0,
    phase: "warmup",
    lifecycle: 1,
    startedAt: Date.now(),
    elapsedMs: 0,
    env,
    provenance: EMPTY_PROVENANCE,
    key: keyForStages(cycleStages(0, Number.MAX_SAFE_INTEGER)),
    stages: sortedStages(cycleStages(0, Number.MAX_SAFE_INTEGER)),
    failures: [],
    blocked: null,
    ok: true,
  })

  const total = opts.cycles + 1
  for (let cycle = 1; cycle < total; cycle++) {
    writeFileSync(join(scratch, `cycle-${cycle}-close`), "go")
    await waitForFile(join(scratch, `cycle-${cycle}-closed`), 60_000, `cycle-${cycle} closed marker`, abort)
    writeFileSync(join(scratch, `cycle-${cycle}-open`), "go")
    await waitForFile(join(scratch, `cycle-${cycle}-opened`), 60_000, `cycle-${cycle} opened marker`, abort)
    // The reopened panel's webview.load/dataReady.done records were emitted
    // before the `opened` marker (agentManagerReady resolves after webviewReady),
    // so wait by occurrence count, not by timestamp.
    const countsBefore = () => {
      const stages = capturePeek().stages
      return {
        loads: stages.filter((s) => s.surface === "webview" && s.stage === "webview.load").length,
        dones: stages.filter((s) => s.surface === "extension" && s.stage === "dataReady.done").length,
        total: stages.length,
      }
    }
    console.log(`[p0-probe] cycle ${cycle} opened; counts=${JSON.stringify(countsBefore())}`)
    await waitForCount(() => capturePeek(), "webview", "webview.load", cycle + 1, 120_000, `cycle ${cycle} webview.load`, abort)
    await waitForCount(
      () => capturePeek(),
      "extension",
      "dataReady.done",
      cycle + 1,
      180_000,
      `cycle ${cycle} dataReady.done`,
      abort,
    )
    await waitForWebviewFrame(browser, 30_000, abort)
    // Slice cycle N's records as everything after cycle N-1's dataReady.done.
    const dones = findStages(capturePeek().stages, "extension", "dataReady.done")
    const previousDone = dones[cycle - 1]!.t
    const nextDone = dones[cycle]?.t ?? Number.MAX_SAFE_INTEGER
    const stages = cycleStages(previousDone, nextDone)
    const phase = cycle <= opts.warmup ? "warmup" : "measured"
    out.push({
      v: 1,
      kind: "sample",
      scenario: opts.scenario,
      condition: opts.condition,
      sample: opts.sample,
      cycle,
      phase,
      lifecycle: 1,
      startedAt: Date.now(),
      elapsedMs: 0,
      env,
      provenance: EMPTY_PROVENANCE,
      key: keyForStages(stages),
      stages: sortedStages(stages),
      failures: [],
      blocked: null,
      ok: true,
    })
    console.log(`[p0-probe] warm-view cycle ${cycle} recorded (${phase})`)
  }
}

interface SwitchSession {
  id: string
  title: string
}

/** Provenance for lifecycle-type scenarios (no backend spawn measurement). */
const EMPTY_PROVENANCE: BackendProvenance = {
  cliPath: null,
  cliPathInWorkspace: false,
  cliExists: false,
  cliSha256: null,
  cliVersionHash: null,
  spawnedPid: null,
  spawnedArgsMatch: false,
  spawnedStart: null,
}

async function handleSessionSwitches(
  opts: LifecycleOptions,
  browser: Browser,
  scratch: string,
  out: SampleRecord[],
  env: SampleEnv,
  abort: Promise<never>,
): Promise<void> {
  const plan = JSON.parse(readFileSync(join(scratch, "plan.json"), "utf8")) as { sessions: SwitchSession[] }
  const sessions = plan.sessions
  if (!Array.isArray(sessions) || sessions.length < 2) {
    throw new Error(`session-switch: expected >= 2 seeded sessions, got ${sessions?.length ?? 0}`)
  }
  const { frame } = await waitForAgentManagerFrame(browser, 60_000, abort)
  const totalSwitches = opts.cycles

  // Seed target order: the initial active tab is sessions[0], so cycle through
  // the remaining sessions then back around — every real tab strip is used.
  const targets: SwitchSession[] = []
  for (let i = 0; i < totalSwitches; i++) {
    targets.push(sessions[(1 + i) % sessions.length]!)
  }

  for (let i = 0; i < totalSwitches; i++) {
    const target = targets[i]!
    const tab = frame.locator(`.am-tab-sortable[data-tab-id="${target.id}"]`).first()
    // Race the Playwright waits against the guard abort so a breach aborts the
    // switch within the guard's own resolution instead of after these timeouts.
    await raceGuardAbort(tab.waitFor({ state: "visible", timeout: 10_000 }), abort)
    const t0 = Date.now()
    await raceGuardAbort(tab.click({ timeout: 5_000 }), abort)
    let settled = false
    const settleDeadline = Date.now() + 15_000
    for (;;) {
      if (await switchSettled(frame, target.id, target.title)) {
        settled = true
        break
      }
      if (Date.now() > settleDeadline) break
      if (abort) await Promise.race([sleep(50), abort])
      else await sleep(50)
    }
    const settleMs = Date.now() - t0
    if (!settled) {
      throw new Error(
        `session-switch: switch to ${target.id} (${target.title}) did not settle within 15s (active=${await activeTabId(frame)} header=${await headerTitle(frame)})`,
      )
    }
    const phase = i < opts.warmup ? "warmup" : "measured"
    out.push({
      v: 1,
      kind: "sample",
      scenario: opts.scenario,
      condition: opts.condition,
      sample: opts.sample,
      cycle: i + 1,
      phase,
      lifecycle: 1,
      startedAt: t0,
      elapsedMs: 0,
      env,
      provenance: EMPTY_PROVENANCE,
      key: { switchSettleMs: Math.round(settleMs * 100) / 100 },
      stages: [
        { surface: "probe", stage: "switch.click", t: t0, extra: { target: target.id } },
        { surface: "probe", stage: "switch.settled", t: t0 + settleMs, extra: { target: target.id } },
      ],
      failures: [],
      blocked: null,
      ok: true,
    })
    console.log(
      `[p0-probe] switch ${i + 1}/${totalSwitches} → ${target.title} settled=${Math.round(settleMs)}ms (${phase})`,
    )
  }
}

export async function verifyCleanup(
  userData: string,
  cdpPort: number,
  scratch: string,
  scenario: ScenarioID,
  backend: BackendRoot | null,
  unverified: UnverifiedBackend | null,
  mcp: McpFixtureEvidence,
  terminateBackend: (identity: BackendRoot, graceMs: number) => Promise<BackendCleanupOutcome> = terminateBackendWithPs,
  terminateFixture: (identity: ProcessRoot, graceMs: number) => Promise<BackendCleanupOutcome> = terminateFixtureWithPs,
): Promise<void> {
  // 1. Let owned VS Code processes exit on their own, then terminate every
  //    survivor by exact PID (SIGTERM → SIGKILL).
  const settleDeadline = Date.now() + 15_000
  let owned = processesWithUserData(userData)
  while (owned.length > 0 && Date.now() < settleDeadline) {
    await sleep(300)
    owned = processesWithUserData(userData)
  }
  const remaining = owned.length > 0 ? await terminateOwned(userData, 3_000) : 0
  if (remaining > 0) {
    throw new Error(
      `cleanup: ${remaining} owned VS Code processes could not be terminated by exact PID:\n` +
        processesWithUserData(userData)
          .map((p) => `  ${p.pid} ${p.args}`)
          .join("\n"),
    )
  }
  console.log("[p0-probe] cleanup: no owned VS Code process remains")

  // 2. The run-owned backend must be gone too. The backend may have been
  //    reparented to PID 1 after the Extension Host exited, so it is
  //    terminated ONLY on exact identity (PID + raw start + pinned CLI path),
  //    re-verified immediately before each SIGTERM/SIGKILL — a reused PID is
  //    never signaled, and a survivor/mismatch is cleanup evidence that fails
  //    the sample/run. A termination failure (verified backend that could not
  //    be killed) is DEFERRED as a blocker instead of throwing here, so the
  //    run-owned MCP fixture is still cleaned in step 3 — an unkillable
  //    backend can never leak the fixture. The snapshot is only deleted
  //    (campaign side) after this returns clean.
  let backendBlocker: string | null = null
  if (backend) {
    const outcome = await terminateBackend(backend, 3_000)
    if (!outcome.terminated) {
      backendBlocker =
        `cleanup: backend PID ${backend.pid} not cleanly terminated (${outcome.status}: ${outcome.detail ?? "unknown"})`
    } else {
      console.log(`[p0-probe] cleanup: backend PID ${backend.pid} terminated by exact identity`)
    }
  } else if (unverified) {
    // A spawned backend PID was observed but its identity could never be
    // verified (registration missing + late discovery failed). Never signal an
    // unverified process (LOCK-PERF: no PID+start+exact-path match, no
    // signal); the blocker is deferred until after the MCP fixture is still
    // terminated by exact PID, and the snapshot/scratch evidence is retained.
    backendBlocker =
      `cleanup: backend PID ${unverified.pid} observed spawned from ${unverified.cliPath} ` +
      `but its identity was never verified — no signal sent; snapshot/scratch evidence retained`
  }

  // 3. The run-owned MCP fixture (many-agent-mcp) must be gone; the backend
  //    kills it on exit, but the harness terminates it by exact identity too.
  //    This ALWAYS runs — even when the backend termination failed (blocker
  //    above) or the backend identity was unverifiable — so a backend that
  //    cannot be terminated or verified can never leak the fixture. Exact
  //    ownership only: the fixture is cleaned ONLY when its identity (PID +
  //    raw start + args containing the exact fixture script path) verifies,
  //    and that identity is re-verified immediately before each SIGTERM/
  //    SIGKILL — a reused PID is never signaled, a missing/unverifiable
  //    identity fails closed (no signal), and a survivor/mismatch is cleanup
  //    evidence that fails the sample/run and blocks scratch deletion (step 5).
  if (scenario === "many-agent-mcp") {
    const outcome = await cleanupMcpFixture(join(scratch, "mcp-connected"), mcp, 3_000, terminateFixture)
    if (outcome.status === "failed") {
      throw new Error(`cleanup: ${outcome.detail}`)
    }
    console.log(`[p0-probe] cleanup: ${outcome.detail}`)
  }

  // 4. The deferred backend blocker (verified-backend termination failure or
  //    unverifiable identity) fires only after the MCP fixture was still
  //    cleaned: fail closed with the snapshot/scratch evidence retained
  //    (rmSync below never runs) and a blocker naming the PID/path.
  if (backendBlocker) throw new Error(backendBlocker)

  // 5. Only delete paths after zero owned processes remain and the CDP port is
  //    verifiably released.
  const free = await portFree(cdpPort)
  console.log(`[p0-probe] cleanup: CDP port ${cdpPort} ${free ? "released" : "STILL BOUND"}`)
  if (!free) throw new Error(`cleanup: CDP port ${cdpPort} still bound by an owned process`)
  rmSync(scratch, { recursive: true, force: true })
  const gone = !existsSync(scratch)
  console.log(`[p0-probe] cleanup: scratch dir removed: ${gone}`)
  if (!gone) throw new Error("cleanup: scratch dir could not be removed")
}
