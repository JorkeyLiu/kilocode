/**
 * Shared types for the P0 VS Code Extension benchmark harness.
 *
 * Pure type definitions — no runtime dependencies. Imported by the harness
 * (script/e2e-p0-bench.ts), the per-sample probe (script/p0-bench/sample.ts),
 * and unit tests (tests/unit/p0-bench-*.test.ts).
 */

/** P0 scenario identifiers (locked numbering: 1,2,3,4,5,10). */
export const SCENARIOS = [
  "cold-start",
  "warm-view",
  "no-provider",
  "custom-provider",
  "many-agent-mcp",
  "session-switch",
] as const
export type ScenarioID = (typeof SCENARIOS)[number]

/** Number → id mapping for the P0 benchmark scenario list. */
export const SCENARIO_NUMBERS: Record<string, ScenarioID> = {
  "1": "cold-start",
  "2": "warm-view",
  "3": "no-provider",
  "4": "custom-provider",
  "5": "many-agent-mcp",
  "10": "session-switch",
}

/** Cold-type scenarios start a fresh VS Code lifecycle per sample. */
export const COLD_SCENARIOS = new Set<ScenarioID>(["cold-start", "no-provider", "custom-provider", "many-agent-mcp"])

/** Lifecycle-type scenarios keep one VS Code lifecycle and repeat cycles inside it. */
export const LIFECYCLE_SCENARIOS = new Set<ScenarioID>(["warm-view", "session-switch"])

/**
 * A normalized stage record emitted into the JSONL `stages` array.
 * One per instrumentation point across all three surfaces:
 *   extension — `[Kilo New][P0-Perf]` records from the extension host,
 *   webview   — webview `p0Perf` messages forwarded by the extension host,
 *   backend   — `service=p0-perf` records from the `kilo serve` process,
 *   probe     — harness-observed points (e.g. session-switch click/settled).
 */
export interface StageRecord {
  surface: "extension" | "webview" | "backend" | "probe"
  stage: string
  /** Wall-clock epoch ms (same host clock for all surfaces). */
  t: number
  /** Extension-correlation-relative delta ms when the source carried one. */
  d?: number
  /** Backend span duration ms (p0.end records only). */
  duration?: number
  /** Backend span start marker (`p0.start`|`p0.end`), backend records only. */
  event?: "p0.mark" | "p0.start" | "p0.end"
  /** Correlation id (extension/webview records). */
  corr?: string
  /** Webview-relative delta ms (webview records). */
  wd?: number
  /** Backend process PID (extension `spawn.done` extra). */
  pid?: number
  /** Backend id/dir/meta extras. */
  id?: string
  dir?: string
  meta?: string
  /** Probe-recorded extras (e.g. session-switch target). */
  extra?: Record<string, unknown>
}

/** Provenance evidence that the spawned backend belongs to the current workspace. */
export interface BackendProvenance {
  /** Absolute path the extension logged for the CLI (`ServerManager: 📦 CLI path:`). */
  cliPath: string | null
  /** Whether the logged CLI path resolves inside the current workspace root.
   * With a campaign CLI snapshot (see CliSnapshotInfo) the logged path is the
   * run-owned temp snapshot, so this is false while `cliSnapshot` records the
   * workspace-origin source path. */
  cliPathInWorkspace: boolean
  /** Whether the CLI path exists on disk at sample time. */
  cliExists: boolean
  /** sha256 of the CLI binary file (cold-type scenarios). The snapshot is a
   * byte-identical copy, so this equals the source SHA at snapshot time. */
  cliSha256: string | null
  /** Contents of `bin/.cli-version` (source hashes) when present. */
  cliVersionHash: string | null
  /** Backend process PID from the extension's `spawn.done` record. */
  spawnedPid: number | null
  /** Whether the live process args (ps) contained the CLI path + `serve`
   * (the logged CLI path, snapshot or bundled). */
  spawnedArgsMatch: boolean
  /** Raw process-start identity (ps `lstart` string, e.g. `Tue Aug 11
   * 13:15:12 2026`) captured when the spawned backend was verified for guard
   * registration (PID + args + start). Null when the backend was never
   * verified (no `spawn.done`/CLI path observed, or the process was already
   * gone). Additive v1. */
  spawnedStart: string | null
}

/**
 * Immutable per-campaign CLI snapshot provenance (script/p0-bench/snapshot.ts).
 * Before any sample runs, `bin/kilo` is copied to a run-owned temp path and
 * that exact snapshot path is pinned through the benchmark-only
 * `KILO_P0_BACKEND_CLI` env override so the non-owned dev CLI watcher cannot
 * change the measured binary mid-campaign. Additive: absent when the campaign
 * did not snapshot (e.g. direct probe runs).
 */
export interface CliSnapshotInfo {
  /** Original bundled CLI path (`<extension>/bin/kilo`). */
  sourcePath: string
  /** Run-owned temp snapshot path actually spawned. */
  snapshotPath: string
  /** sha256 of the source at snapshot time. */
  sourceSha256: string | null
  /** sha256 of the snapshot (byte-identical copy). */
  snapshotSha256: string | null
  /** Source file size in bytes. */
  sourceSize: number | null
  /** Snapshot file size in bytes. */
  snapshotSize: number | null
  /** Epoch ms when the snapshot was created. */
  createdAt: number
}

/** One bounded observation from the run-owned memory guard (script/p0-bench/memory-guard.ts). */
export interface MemoryGuardSeriesEntry {
  /** Poll wall-clock epoch ms. */
  t: number
  /** Aggregate RSS of the owned process tree (bytes). */
  aggregateRss: number
  /** RSS of the owned process with the highest RSS this poll (bytes). */
  topRss: number
  /** VSZ of that same top process (bytes) — distinguishes RSS from VSZ. */
  topVsz: number
  /** PID of the top process. */
  topPid: number
  /** Owned process count this poll. */
  count: number
}

/**
 * Abort evidence captured when a memory guard engineering safety rail is
 * breached. Every string is bounded (command ≤ 200 bytes); no unbounded data.
 */
export interface GuardBreach {
  /** Which engineering safety limit was crossed. */
  reason: "max-process-rss" | "aggregate-rss" | "max-process-vsz"
  /** Wall-clock epoch ms of the breaching poll. */
  t: number
  /** ms since the guard started. */
  elapsedMs: number
  /** Aggregate RSS of the owned tree at the breaching poll (bytes). */
  aggregateRss: number
  /** RSS of the owned process with the highest RSS at the breaching poll (bytes). */
  maxProcessRss: number
  /** VSZ of the owned process with the highest VSZ at the breaching poll (bytes). */
  maxProcessVsz: number
  /** PID of the offending process. */
  pid: number
  /** PPID of the offending process. */
  ppid: number
  /** Bounded command line of the offending process. */
  command: string
  /** Owned process count at the breaching poll. */
  ownedCount: number
}

/**
 * Stable run-owned backend ownership monitoring (additive v1, attached to the
 * bounded memory guard result). The exact identity — PID + immutable CLI
 * snapshot path + raw process-start `lstart` string — is registered as soon as
 * `spawn.done`/CLI path are observable and re-verified on every poll, so the
 * backend stays an owned root regardless of PPID (reparenting-safe) and a
 * reused PID is never counted owned and never signaled (PID-reuse-safe). All
 * strings are bounded.
 */
export interface BackendMonitoring {
  /** The exact registered identity. */
  identity: { pid: number; cliPath: string; start: string }
  /** Epoch ms when the identity was verified and registered. */
  registeredAt: number
  /** Latest poll verification outcome. */
  status: "matched" | "missing" | "mismatch"
  /** Bounded reason for missing/mismatch; null while matched. */
  detail: string | null
  /** Last epoch ms the identity was verified alive (start+path matched). */
  lastSeenAt: number | null
  /** Number of polls where the identity verified alive (monitoring proof). */
  matchedPolls: number
}

/**
 * The bounded, recordable result of one lifecycle's run-owned memory guard
 * (attached to every emitted sample as `memoryGuard`). Safety rails only —
 * never a performance threshold/SLA (LOCK-PERF-7 stays Open). All arrays and
 * strings are capped; the time series is capped by object count and command
 * identity strings are byte-bounded.
 */
export interface MemoryGuardResult {
  /**
   * Set when a poll (ps invocation or poll computation) failed after start —
   * the guard cannot monitor, so polling stopped and the lifecycle must fail
   * closed (never continue unguarded). `detail` is byte-bounded. Additive v1.
   */
  failure: { reason: "ps-failed"; detail: string; t: number } | null

  configured: {
    enabled: boolean
    pollMs: number
    maxProcessRssBytes: number
    maxAggregateRssBytes: number
    maxProcessVszBytes: number
    /** Engineering safety rail label — not a performance threshold/SLA (R7). */
    label: string
    /** Env var names honored. */
    env: string[]
    /** Platform the guard ran on. */
    platform: string
    /** Non-null when the VSZ rail cannot distinguish a runaway on this
     * platform (macOS reports a fixed ~400 GB address-space baseline for every
     * process), documenting that only the RSS rails are abort gates there. */
    vszRailNote: string | null
  }
  pollCount: number
  /** Total wall time spent polling (ps invocations), ms. */
  totalPollMs: number
  /** Longest single poll, ms. */
  maxPollMs: number
  /** Max aggregate owned RSS observed, bytes. */
  maxAggregateRss: number
  /** Max owned process count observed. */
  maxOwnedCount: number
  /** Max owned-process RSS observed, bytes. */
  maxProcessRss: number
  /** Max owned-process VSZ observed, bytes. */
  maxProcessVsz: number
  /** Identity of the owned process with the highest RSS observed. */
  maxProcess: { pid: number; ppid: number; rss: number; vsz: number; command: string } | null
  /** The breach that aborted the lifecycle, or null. */
  breach: GuardBreach | null
  /** Capped time series of aggregate/top-process observations. */
  series: MemoryGuardSeriesEntry[]
  /** Stable backend identity + per-poll monitoring status (additive v1).
   * Absent when no backend identity was ever registered. */
  backend?: BackendMonitoring
}

/** Per-scenario condition descriptor (truthful fixture description). */
export interface Condition {
  id: ScenarioID
  /** Whether a kilo.json was seeded into the scratch XDG config dir. */
  configSeeded: boolean
  /** Number of custom agents seeded (many-agent-mcp). */
  agents: number
  /** Seeded custom providers (custom-provider). */
  providers: number
  /** Seeded local MCP server name (many-agent-mcp). */
  mcp: string | null
  /** Description of what the condition truthfully measures. */
  note: string
}

/** Key latencies computed per sample (ms). Fields present only when measured. */
export interface KeyLatencies {
  /** activate.start → activate.done (extension activation span). */
  activateMs?: number
  /** spawn.start → port.detected (backend process to port). */
  spawnToPortMs?: number
  /** connect.start → sse.connected. */
  connectToSseConnectedMs?: number
  /** sse.connect → sse.connected. */
  sseConnectToConnectedMs?: number
  /** activate.start → dataReady.done (LOCK-012 current global readiness gate). */
  activateToDataReadyMs?: number
  /** dataReady.start → dataReady.done (data fetch phase of the gate). */
  dataReadySpanMs?: number
  /** webview.load → webview.paint (webview first paint). */
  webviewLoadToPaintMs?: number
  /** webview.load → dataReady.done (reopen/load → readiness; warm-view cycles). */
  loadToDataReadyMs?: number
  /** Backend `listener` span duration (p0.end). */
  backendListenerMs?: number
  /** Backend `serve_cli_entry` → `listener` p0.end (backend boot to listening). */
  backendEntryToListenerMs?: number
  /** Backend `config_load` span duration (first end record). */
  backendConfigLoadMs?: number
  /** Backend `provider_state_init` span duration. */
  backendProviderStateInitMs?: number
  /** Backend `instance_bootstrap` span duration. */
  backendInstanceBootstrapMs?: number
  /** MCP fixture connected marker ts − backend entry ts (many-agent-mcp). */
  mcpConnectMs?: number
  /** Session-switch action → settled latency (probe-measured, session-switch). */
  switchSettleMs?: number
}

export interface SampleEnv {
  os: string
  arch: string
  node: string
  vscode: string
  extension: string
  /** Current workspace git HEAD (short). */
  gitHead: string | null
  /** Full 40-char HEAD commit (explicit commit alias; unambiguous provenance). */
  gitCommit: string | null
  /** True when `git status --porcelain` is non-empty (or git is unavailable). */
  gitDirty: boolean
  /** Backend CLI binary absolute path used by the sample. */
  backendCli: string | null
  /** Immutable per-campaign CLI snapshot provenance (additive; absent when the
   * campaign did not snapshot). */
  cliSnapshot?: CliSnapshotInfo
}

/**
 * Run-envelope provenance, known before any sample executes. Carried on both
 * `kind: "run"` records so a campaign's exact CLI/backend provenance
 * (workspace commit + dirty state + the bundled binary path) is unambiguous.
 */
export interface RunEnv {
  os: string
  arch: string
  node: string
  extension: string
  gitHead: string | null
  gitCommit: string | null
  gitDirty: boolean
  backendCli: string
  /** Immutable per-campaign CLI snapshot provenance (additive). */
  cliSnapshot?: CliSnapshotInfo
}

/** Status of the run-owned MCP fixture cleanup (many-agent-mcp scenario). */
export type McpFixtureCleanupStatus = "clean" | "not-attempted" | "failed"

/**
 * Run-owned MCP fixture evidence (additive v1, attached to every many-agent-mcp
 * sample as `mcpFixture`). Records the real handshake (the fixture writes the
 * marker only after `initialize` → `tools/list` succeeds), the exact identity
 * the probe discovered and retained (PID + raw ps `lstart` start string + the
 * exact fixture script path verified in args), and the cleanup status — never
 * a bare PID. A `failed` cleanup (survivor, mismatch, or never-verified
 * identity that could not be safely signaled) fails the sample/run through the
 * existing teardown-evidence path and blocks scratch deletion.
 */
export interface McpFixtureEvidence {
  /** Handshake marker contents (pid + connectedAt epoch ms), or null. */
  handshake: { pid: number; connectedAt: number } | null
  /** Exact discovered identity (PID + raw start + fixture script path), or null when never verified. */
  identity: { pid: number; start: string; path: string } | null
  /** Bounded reason when the identity could not be discovered/verified (fail closed). */
  discoveryError: string | null
  /** Cleanup outcome evidence. */
  cleanup: { status: McpFixtureCleanupStatus; detail: string | null }
}

/**
 * One measured repetition. `kind: "sample"` JSONL line payload. */
export interface SampleRecord {
  v: 1
  kind: "sample"
  scenario: ScenarioID
  condition: Condition
  /** 1-based index of this sample within the scenario campaign. */
  sample: number
  /** Cycle index within a lifecycle (0 for cold-type scenarios). */
  cycle: number
  phase: "warmup" | "measured"
  lifecycle: number
  startedAt: number
  /** Wall time of the whole lifecycle/sample (ms). */
  elapsedMs: number
  env: SampleEnv
  provenance: BackendProvenance
  key: KeyLatencies
  stages: StageRecord[]
  /** Explicit failure evidence; empty on a clean sample, populated when the
   * sample was blocked or otherwise failed. `blocked` is preserved alongside
   * it (the structured reason/detail) so a blocked sample is never silent. */
  failures: string[]
  /** Present instead of key/stages when the sample could not be executed truthfully.
   * `detail` is byte-bounded at 2000 (script/p0-bench/sample.ts
   * boundBlockedDetail) on every producer: blockedSample, the teardown failure
   * merge, and the applyGuardResult merge. */
  blocked: { reason: string; detail: string } | null
  ok: boolean
  /**
   * True when the sample's raw output exceeded the bounded capture cap
   * (script/p0-bench/sample.ts CAPTURE_BYTES) and the oldest bytes were
   * dropped from the log artifact — including a partial line that exceeded the
   * cap (the pending partial line is bounded to the same cap). Parsed P0 stage
   * records are never dropped. Set on every sample emitted by the probe.
   */
  captureTruncated?: boolean
  /**
   * Bounded run-owned memory guard result for the lifecycle (additive, every
   * probe-emitted sample). Safety rails, not a performance threshold/SLA. When
   * `memoryGuard.breach` is set, the sample is always `ok:false` with
   * `blocked.reason === "memory-guard-abort"` — a guard-aborted sample is a
   * failure, never a baseline.
   */
  memoryGuard?: MemoryGuardResult
  /**
   * Run-owned MCP fixture evidence (additive v1, many-agent-mcp samples only):
   * handshake marker + exact discovered identity + cleanup status. Never a bare
   * PID; a failed cleanup is a failure via the existing teardown-evidence path.
   */
  mcpFixture?: McpFixtureEvidence
}

/**
 * Per-metric summary across measured samples. `kind: "summary"` JSONL line payload.
 *
 * Descriptive-only tail note: with the default n=5, nearest-rank p95 index is
 * ceil(0.95*5)-1 = 4, so p95 EQUALS max. These are descriptive sample
 * statistics, NOT a tail-latency SLA; no threshold or service-level claim
 * derives from them (LOCK-PERF-7 thresholds remain Open).
 */
export interface SummaryRecord {
  v: 1
  kind: "summary"
  scenario: ScenarioID
  metric: string
  unit: "ms"
  n: number
  min: number
  median: number
  p95: number
  max: number
  mean: number
}

/** Run envelope records (`kind: "run"`). */
export interface RunRecord {
  v: 1
  kind: "run"
  event: "start" | "finish"
  startedAt?: number
  finishedAt?: number
  elapsedMs?: number
  scenarios: ScenarioID[]
  samples: number
  warmup: number
  status?: "ok" | "partial" | "failed"
  outDir?: string
  /** Campaign provenance (commit/head/dirty + bundled CLI), both events. */
  env?: RunEnv
}

/** Summary statistics for a numeric series. */
export interface Stats {
  n: number
  min: number
  median: number
  p95: number
  max: number
  mean: number
}
