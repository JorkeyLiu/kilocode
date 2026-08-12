#!/usr/bin/env node
/**
 * P0 benchmark harness for the Kilo VS Code extension (scenarios 1,2,3,4,5,10).
 *
 * Extends the real Extension Host E2E/probe infrastructure to produce
 * repeated, machine-readable P0 startup/readiness/UI benchmark records:
 *
 *   1  cold-start       — fresh VS Code profile + fresh scratch XDG; measures
 *                         the full cold path (activate → backend spawn/port →
 *                         SSE → webview paint → the current extensionDataReady
 *                         gate, LOCK-012) and proves the spawned backend binary
 *                         belongs to the current workspace (live PID args).
 *   2  warm-view        — one lifecycle; the shared backend worker stays live
 *                         while the panel is closed and reopened per cycle.
 *   3  no-provider      — cold start against a seeded scratch XDG kilo config
 *                         that explicitly declares no providers (truthful
 *                         persisted providerless state).
 *   4  custom-provider  — cold start against a seeded config with a real custom
 *                         provider (bundled @ai-sdk/openai-compatible + models);
 *                         provider_state_init resolves it for real.
 *   5  many-agent-mcp   — cold start against a seeded config with N custom
 *                         agents + one real local MCP server (run-owned stdio
 *                         fixture, script/p0-bench/mcp-fixture.mjs); the MCP
 *                         initialize/tools-list handshake is proven by marker.
 *   10 session-switch   — one lifecycle; the runner seeds N sessions and the
 *                         harness clicks the real tab strip via Playwright,
 *                         recording action→settled latency per switch.
 *
 * Opt-in instrumentation (KILO_P0_PERF=1) is set on the extension host and
 * forwarded to the backend; records flow: extension/webview via the extension
 * host stdout, backend via the extension's ServerManager stderr relay
 * (--print-logs appended to the serve args only when the flag is set).
 *
 * Output: JSONL at <out>/benchmark.jsonl with stable records:
 *   {v:1, kind:"run",   event:"start"|"finish", ..., env:{gitCommit,gitDirty,...}}
 *   {v:1, kind:"sample", scenario, condition, sample, phase, env, provenance,
 *          key, stages, failures, blocked, ...}
 *   {v:1, kind:"summary", scenario, metric, n, min, median, p95, max, mean}
 * Per-sample raw capture logs land in <out>/logs/.
 *
 * Durable output convention: the default `--out` is the repo-relative,
 * durable evidence dir
 *   <repo>/specs/vscode-orchestrator/evidence/p0-baseline/<ts>/
 * (the backend CLI uses the same convention with backend.jsonl). The
 * machine-readable JSONL and run metadata are durable, VERSIONABLE tracker
 * evidence and are NOT gitignored; only bulky per-run raw capture logs under
 * <out>/logs/ may remain local/ignored (the root `logs/` pattern). Git
 * provenance (commit/head/dirty) is derived ONCE at campaign start — BEFORE
 * the output artifact is created — and propagated frozen into every record,
 * so creating evidence inside the repo never flips the recorded dirty state.
 *
 * Stats note: with the default n=5, nearest-rank p95 equals max — descriptive
 * sample statistics only, not a tail-latency SLA (LOCK-PERF-7 thresholds
 * remain Open).
 *
 * Usage (package script `bun run test:p0-bench` — Node-only, mirrors
 * script/e2e-probe-launch.mjs):
 *   bun run test:p0-bench -- --scenarios 1,2,3,4,5,10 --samples 5 --warmup 1
 *   KILO_E2E_SCENARIO is not used; pass scenario numbers/names via --scenarios.
 *
 * MUST run under Node: Playwright's CDP WebSocket transport hangs under Bun
 * against VS Code's Electron CDP endpoint.
 */

import { build } from "esbuild"
import { spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  type WriteStream,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { runLifecycle, snapshotSurvivorCleanup, type LifecycleOptions } from "./p0-bench/sample"
import type { Condition, RunEnv, RunRecord, SampleRecord, ScenarioID, SummaryRecord } from "./p0-bench/types"
import { COLD_SCENARIOS } from "./p0-bench/types"
import { summarize } from "./p0-bench/stats"
import { campaignStatus } from "./p0-bench/status"
import { gitState } from "./p0-bench/git-env"
import { parseArgs, USAGE, wantsHelp, type BenchArgs } from "./p0-bench/args"
import { repoRootFrom } from "./p0-bench/repo-root"
import { createCliSnapshot, type CliSnapshot } from "./p0-bench/snapshot"

if (process.versions.bun) {
  console.error(
    "[p0-bench] FATAL: this harness must run under Node, not Bun. " +
      "Playwright's connectOverCDP WS transport hangs under Bun against VS Code's CDP endpoint. " +
      "Use `bun run test:p0-bench` (compiles + runs via Node).",
  )
  process.exit(1)
}

// Set by script/e2e-p0-bench-launch.mjs; falls back to the current working dir.
const root = process.env.KILO_E2E_ROOT ? resolve(process.env.KILO_E2E_ROOT) : resolve(process.cwd())
const repoRoot = repoRootFrom(root)
const shouldBuild = !process.argv.includes("--no-build")

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

// Argument parsing, help detection, and the usage text live in ./p0-bench/args
// (pure module) so `--help` is honored and the defaults are unit-testable
// before any build or VS Code launch.

// ---------------------------------------------------------------------------
// Build / environment
// ---------------------------------------------------------------------------

async function compile() {
  if (!shouldBuild) {
    console.log("[p0-bench] Skipping esbuild (--no-build)")
    return
  }
  console.log("[p0-bench] Building extension + webview bundles via node esbuild.js")
  const result = spawnSync(process.execPath, ["esbuild.js"], { cwd: root, stdio: "inherit" })
  if (result.status !== 0) throw new Error(`p0-bench: esbuild failed (exit ${result.status})`)
  console.log("[p0-bench] Build complete")
}

function backendCliPath(): string | null {
  const binName = process.platform === "win32" ? "kilo.exe" : "kilo"
  const candidate = join(root, "bin", binName)
  return existsSync(candidate) ? candidate : null
}

function extensionVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string }
    return pkg.version ?? "unknown"
  } catch {
    return "unknown"
  }
}

// ---------------------------------------------------------------------------
// Condition fixtures (truthful scratch XDG kilo configs)
// ---------------------------------------------------------------------------

function conditionFor(id: ScenarioID, scratch: string, mcpFixturePath: string, mcpAgents: number): Condition {
  const common = { configSeeded: false, agents: 0, providers: 0, mcp: null }
  switch (id) {
    case "cold-start":
      return { id, ...common, note: "fresh VS Code profile + fresh scratch XDG; no seeded config" }
    case "no-provider":
      return {
        id,
        configSeeded: true,
        agents: 0,
        providers: 0,
        mcp: null,
        note: "seeded scratch XDG kilo.json with explicit empty provider/agent records (persisted providerless state)",
      }
    case "custom-provider":
      return {
        id,
        configSeeded: true,
        agents: 0,
        providers: 1,
        mcp: null,
        note: "seeded scratch XDG kilo.json with one real custom provider (@ai-sdk/openai-compatible, loopback baseURL, 1 model)",
      }
    case "many-agent-mcp":
      return {
        id,
        configSeeded: true,
        agents: mcpAgents,
        providers: 0,
        mcp: "p0-bench-mcp",
        note: `seeded scratch XDG kilo.json with ${mcpAgents} real custom agents + one real local stdio MCP server fixture`,
      }
    case "warm-view":
      return { id, ...common, note: "one lifecycle; shared backend worker stays live across panel close/reopen cycles" }
    case "session-switch":
      return { id, ...common, note: "one lifecycle; N seeded sessions; Playwright-driven real tab-strip switches" }
  }
}

function seedConfig(id: ScenarioID, scratch: string, mcpFixturePath: string, mcpAgents: number): void {
  const configDir = join(scratch, "xdg-config", "kilo")
  mkdirSync(configDir, { recursive: true })
  mkdirSync(join(scratch, "xdg-data"), { recursive: true })
  mkdirSync(join(scratch, "xdg-cache"), { recursive: true })
  mkdirSync(join(scratch, "xdg-state"), { recursive: true })

  let config: Record<string, unknown> | null = null
  if (id === "no-provider") {
    config = { provider: {}, agent: {} }
  } else if (id === "custom-provider") {
    config = {
      provider: {
        "p0-custom": {
          npm: "@ai-sdk/openai-compatible",
          name: "P0 Custom Provider",
          options: { baseURL: "http://127.0.0.1:9", apiKey: "p0-bench-key" },
          models: {
            "p0-custom-model": { name: "P0 Custom Model", limit: { context: 128000 } },
          },
        },
      },
    }
  } else if (id === "many-agent-mcp") {
    const agents: Record<string, unknown> = {}
    for (let i = 1; i <= mcpAgents; i++) {
      const key = `p0-agent-${String(i).padStart(2, "0")}`
      agents[key] = {
        description: `P0 benchmark agent ${i}`,
        prompt: `You are P0 benchmark agent ${i}.`,
        mode: "primary",
      }
    }
    config = {
      agent: agents,
      mcp: {
        "p0-bench-mcp": {
          type: "local",
          command: ["node", mcpFixturePath],
          environment: { P0_MCP_MARKER: join(scratch, "mcp-connected") },
          enabled: true,
        },
      },
    }
  }

  if (config) {
    writeFileSync(join(configDir, "kilo.json"), JSON.stringify(config, null, 2) + "\n")
    console.log(`[p0-bench] seeded ${id} config at ${join(configDir, "kilo.json")}`)
  }
}

// ---------------------------------------------------------------------------
// JSONL output
// ---------------------------------------------------------------------------

class JsonlWriter {
  private readonly handle: WriteStream
  private count = 0

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.handle = createWriteStream(path)
  }

  write(record: unknown): void {
    this.handle.write(JSON.stringify(record) + "\n")
    this.count++
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.handle.end(() => resolve()))
  }
}

// ---------------------------------------------------------------------------
// Campaign
// ---------------------------------------------------------------------------

interface CampaignResult {
  status: "ok" | "partial" | "failed"
  blockedScenarios: string[]
}

interface BenchEnv extends RunEnv {}

function benchEnvInfo(snapshot: CliSnapshot): BenchEnv {
  const git = gitState(root)
  return {
    os: process.platform,
    arch: process.arch,
    node: process.version,
    extension: extensionVersion(),
    gitHead: git.gitHead,
    gitCommit: git.gitCommit,
    gitDirty: git.gitDirty,
    backendCli: snapshot.info.snapshotPath,
    cliSnapshot: snapshot.info,
  }
}

interface Tracked {
  writer: JsonlWriter
  samplesForScenario: SampleRecord[]
  anyOkMeasured: boolean
  anyBlocked: boolean
}

function emitResult(result: Awaited<ReturnType<typeof runLifecycle>>, tracked: Tracked): void {
  for (const sample of result.samples) {
    tracked.writer.write(sample)
    tracked.samplesForScenario.push(sample)
    if (sample.phase === "measured" && sample.ok) tracked.anyOkMeasured = true
    if (sample.blocked) tracked.anyBlocked = true
  }
}

async function runColdCampaign(
  args: BenchArgs,
  scenario: ScenarioID,
  fixtureId: string,
  total: number,
  mcpFixturePath: string,
  envInfo: BenchEnv,
  tracked: Tracked,
): Promise<void> {
  for (let i = 1; i <= total; i++) {
    const scratch = mkdtempSync(join(tmpdir(), "kilo-p0-"))
    seedConfig(scenario, scratch, mcpFixturePath, args.mcpAgents)
    const condition = conditionFor(scenario, scratch, mcpFixturePath, args.mcpAgents)
    const opts: LifecycleOptions = {
      root,
      scenario,
      condition,
      scratch,
      fixtureId: `${fixtureId}-S${i}`,
      sample: i,
      cycles: 0,
      warmup: args.warmup,
      logDir: join(args.outDir, "logs"),
      extensionVersion: envInfo.extension,
      vscodeVersion: "unknown",
      gitHead: envInfo.gitHead,
      gitCommit: envInfo.gitCommit,
      gitDirty: envInfo.gitDirty,
      backendCli: envInfo.backendCli,
      cliSnapshot: envInfo.cliSnapshot,
      mcpFixturePath,
    }
    const result = await runLifecycle(opts)
    emitResult(result, tracked)
  }
}

async function runLifecycleCampaign(
  args: BenchArgs,
  scenario: ScenarioID,
  fixtureId: string,
  total: number,
  mcpFixturePath: string,
  envInfo: BenchEnv,
  tracked: Tracked,
): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "kilo-p0-"))
  seedConfig(scenario, scratch, mcpFixturePath, args.mcpAgents)
  const condition = conditionFor(scenario, scratch, mcpFixturePath, args.mcpAgents)
  const opts: LifecycleOptions = {
    root,
    scenario,
    condition,
    scratch,
    fixtureId,
    sample: 1,
    cycles: total,
    warmup: args.warmup,
    logDir: join(args.outDir, "logs"),
    extensionVersion: envInfo.extension,
    vscodeVersion: "unknown",
    gitHead: envInfo.gitHead,
    gitCommit: envInfo.gitCommit,
    gitDirty: envInfo.gitDirty,
    backendCli: envInfo.backendCli,
    cliSnapshot: envInfo.cliSnapshot,
    mcpFixturePath,
  }
  const result = await runLifecycle(opts)
  emitResult(result, tracked)
}

async function runCampaign(args: BenchArgs, outFile: string): Promise<CampaignResult> {
  const mcpFixturePath = join(root, "script", "p0-bench", "mcp-fixture.mjs")
  const backendCli = backendCliPath()
  if (!backendCli) {
    console.error(
      "[p0-bench] FATAL: no bundled CLI at " +
        join(root, "bin", "kilo") +
        ". " +
        "Run 'bun script/local-bin.ts' (or 'bun run prepare:cli-binary') from packages/kilo-vscode first.",
    )
    process.exit(1)
  }
  // Immutable per-campaign CLI snapshot: copy bin/kilo to a run-owned temp path
  // (os.tmpdir — never the versioned evidence dir) and pin that exact path
  // through the benchmark-only KILO_P0_BACKEND_CLI override. The non-owned dev
  // watcher (script/watch-cli.ts) may keep rebuilding bin/kilo, but it can no
  // longer change the binary this campaign measures. The snapshot is deleted
  // only after the campaign finishes or fails (finally below). Fails before any
  // sample launches when the source is missing, not executable, or changed
  // while it was being copied (post-copy provenance mismatch).
  const snapshot = createCliSnapshot(backendCli, tmpdir())
  console.log(
    `[p0-bench] CLI snapshot: ${snapshot.info.sourcePath} → ${snapshot.info.snapshotPath} ` +
      `sha256=${(snapshot.info.snapshotSha256 ?? "unreadable").slice(0, 12)}…`,
  )
  try {
    // Freeze provenance BEFORE the output artifact is created: the evidence dir
    // is not gitignored, so creating benchmark.jsonl must never flip the
    // recorded dirty state. This frozen value is reused on every record.
    const envInfo = benchEnvInfo(snapshot)
    const writer = new JsonlWriter(outFile)
    const startRecord: RunRecord = {
      v: 1,
      kind: "run",
      event: "start",
      startedAt: Date.now(),
      scenarios: args.scenarios,
      samples: args.samples,
      warmup: args.warmup,
      outDir: args.outDir,
      env: envInfo,
    }
    writer.write(startRecord)
    console.log(`[p0-bench] campaign start: ${args.scenarios.join(", ")} samples=${args.samples} warmup=${args.warmup}`)
    console.log(`[p0-bench] output: ${outFile}`)

    mkdirSync(join(args.outDir, "logs"), { recursive: true })
    const samplesByScenario = new Map<ScenarioID, SampleRecord[]>()
    const tracked: Tracked = { writer, samplesForScenario: [], anyOkMeasured: false, anyBlocked: false }

    for (const scenario of args.scenarios) {
      console.log(`\n[p0-bench] === scenario ${scenario} ===`)
      tracked.samplesForScenario = []
      samplesByScenario.set(scenario, tracked.samplesForScenario)
      const fixtureId = `p0-${scenario}-${randomBytes(4).toString("hex")}`
      const total = args.samples + args.warmup

      if (COLD_SCENARIOS.has(scenario)) {
        await runColdCampaign(args, scenario, fixtureId, total, mcpFixturePath, envInfo, tracked)
      } else {
        await runLifecycleCampaign(args, scenario, fixtureId, total, mcpFixturePath, envInfo, tracked)
      }
    }

    writeSummaries(writer, samplesByScenario)

    const blockedScenarios = [...samplesByScenario.entries()]
      .filter(([, samples]) => samples.some((s) => s.blocked))
      .map(([scenario]) => scenario)
    const finishRecord: RunRecord = {
      v: 1,
      kind: "run",
      event: "finish",
      finishedAt: Date.now(),
      elapsedMs: Date.now() - (startRecord.startedAt ?? 0),
      scenarios: args.scenarios,
      samples: args.samples,
      warmup: args.warmup,
      // Truthful finish status: failed when no ok measured sample exists (an
      // all-blocked campaign has no baseline evidence — never "partial");
      // partial only when both ok measured AND blocked samples exist.
      status: campaignStatus(tracked.anyOkMeasured, tracked.anyBlocked),
      env: envInfo,
    }
    writer.write(finishRecord)
    await writer.close()
    console.log(`\n[p0-bench] campaign finish: ${finishRecord.status}`)
    if (blockedScenarios.length > 0) {
      console.log(`[p0-bench] blocked scenarios: ${blockedScenarios.join(", ")}`)
    }
    return { status: finishRecord.status!, blockedScenarios }
  } finally {
    // The run-owned CLI snapshot is deleted only after the campaign finishes or
    // fails — AND only once no process still runs from the snapshot path. Any
    // survivor is FIRST claimed by exact snapshot-path identity (PID + raw
    // lstart + exact path, re-verified before each signal) and terminated; an
    // unverifiable survivor is never signaled (a reused PID is never killed),
    // so the snapshot is left on disk and the campaign fails with bounded
    // evidence naming the surviving PID/path. Deleting the snapshot under a
    // live process would hide the leak — this never does.
    await snapshotSurvivorCleanup(snapshot.info.snapshotPath, snapshot.cleanup)
  }
}

/** Per-scenario per-metric summaries over measured (non-warmup, ok) samples. */
function writeSummaries(writer: JsonlWriter, samplesByScenario: Map<ScenarioID, SampleRecord[]>): void {
  for (const [scenario, samples] of samplesByScenario) {
    const measured = samples.filter((s) => s.phase === "measured" && s.ok)
    const metrics = new Map<string, number[]>()
    for (const sample of measured) {
      for (const [metric, value] of Object.entries(sample.key)) {
        if (typeof value === "number") {
          const list = metrics.get(metric) ?? []
          list.push(value)
          metrics.set(metric, list)
        }
      }
    }
    for (const [metric, values] of metrics) {
      const stats = summarize(values)
      const summary: SummaryRecord = { v: 1, kind: "summary", scenario, metric, unit: "ms", ...stats }
      writer.write(summary)
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2)
  if (wantsHelp(argv)) {
    // Usage and exit BEFORE any build, env cleanup, or VS Code launch — a help
    // invocation never boots VS Code and never creates evidence.
    console.log(USAGE)
    return
  }
  const args = parseArgs(argv, repoRoot)
  console.log(`[p0-bench] scenarios: ${args.scenarios.join(", ")}`)
  console.log(`[p0-bench] samples: ${args.samples}, warmup: ${args.warmup}`)
  cleanEnv()
  await compile()

  const outFile = join(args.outDir, "benchmark.jsonl")
  const result = await runCampaign(args, outFile)
  console.log(`[p0-bench] JSONL: ${outFile}`)
  console.log(`[p0-bench] logs:  ${join(args.outDir, "logs")}`)
  if (result.status === "failed") process.exit(1)
  if (result.blockedScenarios.length > 0) process.exit(1)
}

function cleanEnv() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("ELECTRON_") || key.startsWith("VSCODE_")) delete process.env[key]
  }
}

main().catch((err) => {
  console.error(`[p0-bench] FATAL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
  process.exit(1)
})
