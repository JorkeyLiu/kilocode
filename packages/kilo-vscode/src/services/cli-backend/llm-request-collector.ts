import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

/**
 * Fail-closed generation-request collector for the real E2E scenarios
 * (KILO_E2E_FIXTURE only — never active in production).
 *
 * The narrowest observable boundary for "a backend generation request is
 * about to happen" is the `service=llm` log record that session/llm.ts
 * (packages/opencode/src/session/llm.ts) emits at the START of LLM.run —
 * BEFORE provider resolution, auth lookup, and any network/provider call. It
 * carries the resolved providerID/modelID plus the request class tags
 * (session.id, small, agent, mode). A request that later fails or is aborted
 * still leaves this line, so a non-run-owned attempt can never vanish.
 *
 * The ServerManager stderr relay feeds every complete backend line through
 * `parseLlmRequestLine`; matching lines are persisted line-atomic to a
 * run-owned JSONL store under the fixture scratch dir. The store survives
 * worker restarts and true extension-host relaunches (real-restart Phase C)
 * because the scratch dir is shared across every launch of one harness run —
 * an early external request cannot disappear between launches.
 *
 * This module is pure (no vscode import) so the harness
 * (script/e2e-probe.ts / script/e2e-probe-restart.ts) shares the same typed
 * parser/predicate and the focused unit tests run it directly.
 */

/** One observed backend generation request (from one `service=llm` line). */
export interface LlmRequestRecord {
  /** Backend server process pid that logged the request. */
  pid: number
  /** Server instance index within this harness run (1-based, per spawn). */
  instance: number
  /** ISO wall-clock of the log record (or collection time when unparsable). */
  ts: string
  providerID: string
  modelID: string
  /** Backend session id; title requests carry the `title-` prefixed id. */
  sessionID?: string
  /** true for implicit small-model calls (titles, summaries, ...). */
  small?: boolean
  /** Agent name (e2e-agent / general / title / ...). */
  agent?: string
  mode?: string
}

/** The only run-owned provider/model the real scenarios may use (LOCK-006). */
export const RUN_OWNED_MODEL = { providerID: "e2e-local", modelID: "e2e-model" } as const

/** Prefix added by ServerManager's console.error relay (post-run capture form). */
const RELAY_PREFIX = "[Kilo New] ServerManager: ⚠️ CLI Server stderr: "

/** Complete-line format: `INFO  <ts> +<dms> key=value ... message`. */
const LOG_TS = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/

/**
 * Parse one complete backend stderr line into a typed request record, or null
 * when the line is not an `service=llm` stream record (any other service,
 * malformed lines, and unrelated output). Strict: a record requires the
 * `service=llm` anchor AND both providerID and modelID, so a partial/corrupt
 * line can never be mistaken for a run-owned request (fail closed).
 */
export function parseLlmRequestLine(line: string): LlmRequestRecord | null {
  const raw = line.startsWith(RELAY_PREFIX) ? line.slice(RELAY_PREFIX.length) : line
  const tsMatch = raw.match(LOG_TS)
  const pairs: Record<string, string> = {}
  let sawLlmService = false
  for (const match of raw.matchAll(/(^|\s)([A-Za-z0-9_.-]+)=([^\s]+)/g)) {
    const key = match[2]!
    const value = match[3]!
    if (key === "service") {
      if (value !== "llm") return null
      sawLlmService = true
      continue
    }
    pairs[key] = value
  }
  if (!sawLlmService) return null
  const providerID = pairs["providerID"]
  const modelID = pairs["modelID"]
  if (!providerID || !modelID) return null
  const record: LlmRequestRecord = {
    pid: 0,
    instance: 0,
    ts: tsMatch?.[1] ?? new Date().toISOString(),
    providerID,
    modelID,
  }
  if (pairs["session.id"]) record.sessionID = pairs["session.id"]
  if (pairs["small"] === "true") record.small = true
  else if (pairs["small"] === "false") record.small = false
  if (pairs["agent"]) record.agent = pairs["agent"]
  if (pairs["mode"]) record.mode = pairs["mode"]
  return record
}

/**
 * Append-only fixture record store. One store per harness run, rooted at
 * `<KILO_E2E_SCRATCH>/llm-requests.jsonl`; records are appended synchronously
 * and line-atomic, so the file is the aggregate truth across every server
 * instance and every extension-host launch of the run. Per-instance scoping
 * is carried on each record (pid + instance), never by truncation.
 */
export class LlmRequestCollector {
  private readonly file: string

  constructor(file: string) {
    this.file = file
  }

  /** Parse a complete backend line and persist the record when it matches. */
  feed(line: string, pid: number, instance: number): void {
    const record = parseLlmRequestLine(line)
    if (!record) return
    record.pid = pid
    record.instance = instance
    const dir = dirname(this.file)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    appendFileSync(this.file, JSON.stringify(record) + "\n")
  }

  /** All records in the store (empty when the store file does not exist). */
  read(): LlmRequestRecord[] {
    if (!existsSync(this.file)) return []
    const out: LlmRequestRecord[] = []
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (line.trim() === "") continue
      try {
        const record = JSON.parse(line) as LlmRequestRecord
        if (record && typeof record.providerID === "string" && typeof record.modelID === "string") {
          out.push(record)
        }
      } catch {
        // A corrupt line (e.g. interrupted write) must never be counted as a
        // request — skip it; the record store stays fail-closed.
      }
    }
    return out
  }

  /** Clear the store (run start only; never between restart launches). */
  reset(): void {
    const dir = dirname(this.file)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(this.file, "")
  }

  /** Remove the store file entirely (final cleanup; tests only). */
  dispose(): void {
    rmSync(this.file, { force: true })
  }
}

/** Per-class counts for the scenario evidence matrix (agent/small/session). */
export interface LlmRequestMatrix {
  total: number
  runOwned: number
  violations: LlmRequestRecord[]
  byModel: Record<string, number>
  byAgent: Record<string, number>
  small: number
  nonSmall: number
  bySession: Record<string, number>
}

/** Compact per-class request matrix for the scenario evidence files. */
export function llmRequestMatrix(records: LlmRequestRecord[]): LlmRequestMatrix {
  const byModel: Record<string, number> = {}
  const byAgent: Record<string, number> = {}
  const bySession: Record<string, number> = {}
  let runOwned = 0
  let small = 0
  for (const r of records) {
    const model = `${r.providerID}/${r.modelID}`
    byModel[model] = (byModel[model] ?? 0) + 1
    byAgent[r.agent ?? "<none>"] = (byAgent[r.agent ?? "<none>"] ?? 0) + 1
    if (r.sessionID) bySession[r.sessionID] = (bySession[r.sessionID] ?? 0) + 1
    if (r.providerID === RUN_OWNED_MODEL.providerID && r.modelID === RUN_OWNED_MODEL.modelID) runOwned += 1
    if (r.small === true) small += 1
  }
  return {
    total: records.length,
    runOwned,
    violations: records.filter(
      (r) => r.providerID !== RUN_OWNED_MODEL.providerID || r.modelID !== RUN_OWNED_MODEL.modelID,
    ),
    byModel,
    byAgent,
    small,
    nonSmall: records.length - small,
    bySession,
  }
}
