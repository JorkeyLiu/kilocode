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
  /** Whether the logged CLI path resolves inside the current workspace root. */
  cliPathInWorkspace: boolean
  /** Whether the CLI path exists on disk at sample time. */
  cliExists: boolean
  /** sha256 of the CLI binary file (cold-type scenarios). */
  cliSha256: string | null
  /** Contents of `bin/.cli-version` (source hashes) when present. */
  cliVersionHash: string | null
  /** Backend process PID from the extension's `spawn.done` record. */
  spawnedPid: number | null
  /** Whether the live process args (ps) contained the workspace CLI path + `serve`. */
  spawnedArgsMatch: boolean
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
  /** Backend CLI binary absolute path used by the sample. */
  backendCli: string | null
}

/** One measured repetition. `kind: "sample"` JSONL line payload. */
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
  /** Present instead of key/stages when the sample could not be executed truthfully. */
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
}

/** Per-metric summary across measured samples. `kind: "summary"` JSONL line payload. */
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
