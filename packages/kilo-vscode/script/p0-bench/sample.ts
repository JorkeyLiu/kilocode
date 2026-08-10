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
 * terminated by exact PID (matched to the unique user-data dir, plus the
 * run-owned MCP fixture PID), the CDP port is verified released, and the
 * scratch dir is deleted only afterwards.
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
  Condition,
  KeyLatencies,
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
  backendCli: string | null
  /** Set when a prior sample in the campaign failed; phases shift to warmup. */
  shiftToWarmup?: boolean
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

function processesWithUserData(userData: string): Array<{ pid: number; args: string }> {
  const proc = spawnSync("ps", ["-axo", "pid=,args="], { encoding: "utf8" })
  const out = proc.stdout ?? ""
  return out
    .split("\n")
    .filter((line) => line.includes(userData))
    .map((line) => line.trim())
    .map((line) => {
      const space = line.indexOf(" ")
      return { pid: Number(line.slice(0, space)), args: line.slice(space + 1) }
    })
    .filter((p) => Number.isFinite(p.pid) && p.pid > 0)
}

function processArgs(pid: number): string | null {
  const proc = spawnSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" })
  const out = (proc.stdout ?? "").trim()
  return out.length > 0 ? out : null
}

async function terminatePids(pids: number[], graceMs: number): Promise<number> {
  const signal = async (sig: NodeJS.Signals) => {
    for (const pid of pids) {
      try {
        process.kill(pid, sig)
      } catch {
        // already exited
      }
    }
    if (pids.length > 0) await sleep(graceMs)
    return pids.filter((pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    })
  }
  let remaining = await signal("SIGTERM")
  if (remaining.length === 0) return 0
  remaining = await signal("SIGKILL")
  return remaining.length
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

async function waitForCdp(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) return
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error("p0 probe: CDP endpoint did not come up in time")
    await sleep(250)
  }
}

async function waitForFile(file: string, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (existsSync(file)) return
    if (Date.now() > deadline) throw new Error(`p0 probe: timeout waiting for ${label}`)
    await sleep(200)
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

async function waitForWebviewFrame(browser: Browser, timeoutMs: number): Promise<{ page: Page; frame: Frame }> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = await webviewFrame(browser)
    if (found) return found
    if (Date.now() > deadline) throw new Error("p0 probe: no webview frame visible via CDP")
    await sleep(250)
  }
}

/** The Agent Manager tab strip frame, anchored on any sortable session tab. */
async function waitForAgentManagerFrame(browser: Browser, timeoutMs: number): Promise<{ page: Page; frame: Frame }> {
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
    await sleep(250)
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
): Promise<StageRecord> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = records().stages.find((s) => s.surface === surface && s.stage === stage && s.t > afterT)
    if (found) return found
    if (Date.now() > deadline) throw new Error(`p0 probe: timeout waiting for ${label}`)
    await sleep(100)
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
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const count = records().stages.filter((s) => s.surface === surface && s.stage === stage).length
    if (count >= minCount) return
    if (Date.now() > deadline) throw new Error(`p0 probe: timeout waiting for ${label} (count ${count}/${minCount})`)
    await sleep(100)
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
  if (pid) {
    const args = processArgs(pid)
    if (args) {
      const relCli = cliPath ? resolve(cliPath) : join(root, "bin", "kilo")
      spawnedArgsMatch = args.includes(relCli) && args.includes("serve")
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

export async function runLifecycle(opts: LifecycleOptions): Promise<LifecycleResult> {
  const started = Date.now()
  const { root, scenario, condition, scratch, fixtureId, sample, cycles, logDir } = opts
  const timeoutMs = Number(process.env.KILO_E2E_TIMEOUT ?? 300_000)
  let vscodeRun: Promise<number> | undefined
  let browser: Browser | undefined
  let failed = false
  let blockedReason: string | null = null
  let blockedDetail = ""
  const resultSamples: SampleRecord[] = []
  const doneFile = join(scratch, "done")
  const env: SampleEnv = {
    os: process.platform,
    arch: process.arch,
    node: process.version,
    vscode: opts.vscodeVersion,
    extension: opts.extensionVersion,
    gitHead: opts.gitHead,
    backendCli: opts.backendCli,
  }

  const cdpPort = await freePort()
  const userData = join(scratch, "user-data")
  const extensions = join(scratch, "extensions")
  const workspace = join(scratch, "workspace")
  mkdirSync(workspace, { recursive: true })

  const rawLogPath = join(logDir, `sample-${sample}-${scenario}.log`)
  const stopCapture = startCapture()

  try {
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

    await waitForCdp(cdpPort, 90_000)
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 30_000 })
    await waitForFile(join(scratch, "ready"), 120_000, "runner ready marker")
    console.log(`[p0-probe] runner ready (${scenario})`)

    await driveScenario(opts, browser, scratch, env, resultSamples)
  } catch (err) {
    failed = true
    blockedReason = err instanceof Error ? err.message : String(err)
    blockedDetail = err instanceof Error ? (err.stack ?? "") : ""
    console.error(`[p0-probe] FAIL (sample ${sample} ${scenario}): ${blockedReason}`)
    resultSamples.push(blockedSample(scenario, condition, sample, started, env, blockedReason, blockedDetail))
  }

  // -------------------------------------------------------------------------
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
  // -------------------------------------------------------------------------
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
      cleanup: () => verifyCleanup(userData, cdpPort, scratch, scenario),
    }),
  )

  if (teardownNotes.length > 0) {
    failed = true
    const detail = teardownNotes.join("; ")
    console.error(`[p0-probe] FAIL (sample ${sample} ${scenario}) teardown: ${detail}`)
    blockedDetail = blockedDetail ? `${blockedDetail}\n${detail}` : detail
    if (!blockedReason) blockedReason = "teardown-failed"
    for (const sampleRecord of resultSamples) {
      const original = sampleRecord.blocked
      sampleRecord.ok = false
      sampleRecord.blocked = {
        reason: "cleanup-failed",
        detail: original ? `${original.reason}: ${original.detail}\n${detail}` : detail,
      }
    }
  }

  const elapsedMs = Date.now() - started
  for (const sampleRecord of resultSamples) {
    sampleRecord.elapsedMs = elapsedMs
  }
  console.log(`[p0-probe] sample ${sample} ${scenario} elapsed=${Math.round(elapsedMs / 1000)}s ok=${!failed}`)
  return {
    samples: resultSamples,
    ok: !failed,
    blockedReason,
    blockedDetail: blockedDetail.slice(0, 2000),
    elapsedMs,
  }
}

function blockedSample(
  scenario: ScenarioID,
  condition: Condition,
  sample: number,
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
    phase: "warmup",
    lifecycle: 1,
    startedAt,
    elapsedMs: 0,
    env,
    provenance: EMPTY_PROVENANCE,
    key: {},
    stages: [],
    blocked: { reason, detail: detail.slice(0, 2000) },
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

/** Dispatch to the scenario-specific lifecycle driver. */
async function driveScenario(
  opts: LifecycleOptions,
  browser: Browser,
  scratch: string,
  env: SampleEnv,
  out: SampleRecord[],
): Promise<void> {
  if (COLD_SCENARIOS.has(opts.scenario)) {
    await driveColdScenario(opts, browser, scratch, env, out)
    return
  }
  if (opts.scenario === "warm-view") {
    await waitForWebviewFrame(browser, 30_000)
    await handleWarmViewCycles(opts, browser, scratch, out, env)
    return
  }
  if (opts.scenario === "session-switch") {
    await handleSessionSwitches(opts, browser, scratch, out, env)
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
): Promise<void> {
  // LOCK-012: wait for the current extensionDataReady gate to fire.
  const dataReady = await waitForRecord(
    () => capturePeek(),
    "extension",
    "dataReady.done",
    0,
    180_000,
    "dataReady.done gate",
  )
  console.log(`[p0-probe] dataReady.done at t=${dataReady.t}`)
  await waitForWebviewFrame(browser, 30_000)
  if (opts.scenario === "many-agent-mcp") {
    const mcpMarker = join(scratch, "mcp-connected")
    await waitForFile(mcpMarker, 90_000, "MCP fixture connect marker")
    console.log(`[p0-probe] MCP fixture connected (${readFileSync(mcpMarker, "utf8").trim()})`)
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
  out.push(await buildColdSample(opts, env, provenance))
}

async function buildColdSample(
  opts: LifecycleOptions,
  env: SampleEnv,
  provenance: BackendProvenance,
): Promise<SampleRecord> {
  const stages = sortedStages(capturePeek().stages)
  const key: KeyLatencies = keyForStages(stages)
  if (opts.scenario === "many-agent-mcp") {
    const mcpMarker = join(opts.scratch, "mcp-connected")
    try {
      const marker = JSON.parse(readFileSync(mcpMarker, "utf8")) as { connectedAt: number }
      const serveEntry = findStage(stages, "backend", "serve_cli_entry")
      if (serveEntry) key.mcpConnectMs = Math.round((marker.connectedAt - serveEntry.t) * 100) / 100
    } catch {
      // marker absent or unparsable — the sample stays truthful without the metric
    }
  }
  return {
    v: 1,
    kind: "sample",
    scenario: opts.scenario,
    condition: opts.condition,
    sample: opts.sample,
    cycle: 0,
    phase: opts.sample <= opts.warmup ? "warmup" : "measured",
    lifecycle: 1,
    startedAt: Date.now(),
    elapsedMs: 0,
    env,
    provenance,
    key,
    stages,
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
): Promise<void> {
  // Cycle 0 = the initial open (includes spawn/connect) — always warmup.
  await waitForRecord(() => capturePeek(), "extension", "dataReady.done", 0, 180_000, "initial dataReady.done")
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
    blocked: null,
    ok: true,
  })

  const total = opts.cycles + 1
  for (let cycle = 1; cycle < total; cycle++) {
    writeFileSync(join(scratch, `cycle-${cycle}-close`), "go")
    await waitForFile(join(scratch, `cycle-${cycle}-closed`), 60_000, `cycle-${cycle} closed marker`)
    writeFileSync(join(scratch, `cycle-${cycle}-open`), "go")
    await waitForFile(join(scratch, `cycle-${cycle}-opened`), 60_000, `cycle-${cycle} opened marker`)
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
    await waitForCount(() => capturePeek(), "webview", "webview.load", cycle + 1, 120_000, `cycle ${cycle} webview.load`)
    await waitForCount(
      () => capturePeek(),
      "extension",
      "dataReady.done",
      cycle + 1,
      180_000,
      `cycle ${cycle} dataReady.done`,
    )
    await waitForWebviewFrame(browser, 30_000)
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
}

async function handleSessionSwitches(
  opts: LifecycleOptions,
  browser: Browser,
  scratch: string,
  out: SampleRecord[],
  env: SampleEnv,
): Promise<void> {
  const plan = JSON.parse(readFileSync(join(scratch, "plan.json"), "utf8")) as { sessions: SwitchSession[] }
  const sessions = plan.sessions
  if (!Array.isArray(sessions) || sessions.length < 2) {
    throw new Error(`session-switch: expected >= 2 seeded sessions, got ${sessions?.length ?? 0}`)
  }
  const { frame } = await waitForAgentManagerFrame(browser, 60_000)
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
    await tab.waitFor({ state: "visible", timeout: 10_000 })
    const t0 = Date.now()
    await tab.click({ timeout: 5_000 })
    let settled = false
    const settleDeadline = Date.now() + 15_000
    for (;;) {
      if (await switchSettled(frame, target.id, target.title)) {
        settled = true
        break
      }
      if (Date.now() > settleDeadline) break
      await sleep(50)
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
      blocked: null,
      ok: true,
    })
    console.log(
      `[p0-probe] switch ${i + 1}/${totalSwitches} → ${target.title} settled=${Math.round(settleMs)}ms (${phase})`,
    )
  }
}

async function verifyCleanup(userData: string, cdpPort: number, scratch: string, scenario: ScenarioID): Promise<void> {
  // 1. Let owned VS Code processes exit on their own, then terminate every
  //    survivor by exact PID (SIGTERM → SIGKILL).
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

  // 2. The run-owned MCP fixture (many-agent-mcp) must be gone; the backend
  //    kills it on exit, but the harness terminates it by exact PID too.
  if (scenario === "many-agent-mcp") {
    const pidFile = join(scratch, "mcp-connected.pid")
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, "utf8").trim())
      if (Number.isFinite(pid) && pid > 0) {
        const alive = await terminatePids([pid], 2_000)
        if (alive > 0) {
          throw new Error(`cleanup: MCP fixture PID ${pid} survived SIGKILL`)
        }
        console.log(`[p0-probe] cleanup: MCP fixture PID ${pid} terminated by exact PID`)
      }
    }
  }

  // 3. Only delete paths after zero owned processes remain and the CDP port is
  //    verifiably released.
  const free = await portFree(cdpPort)
  console.log(`[p0-probe] cleanup: CDP port ${cdpPort} ${free ? "released" : "STILL BOUND"}`)
  if (!free) throw new Error(`cleanup: CDP port ${cdpPort} still bound by an owned process`)
  rmSync(scratch, { recursive: true, force: true })
  const gone = !existsSync(scratch)
  console.log(`[p0-probe] cleanup: scratch dir removed: ${gone}`)
  if (!gone) throw new Error("cleanup: scratch dir could not be removed")
}
