/**
 * Harness-side generation-request assertion for the real E2E scenarios
 * (script/e2e-probe.ts / script/e2e-probe-restart.ts import this; Node only,
 * never bundled into the extension).
 *
 * Reads the fixture-gated generation-request store that ServerManager's
 * collector persists into the run-owned scratch dir (`llm-requests.jsonl`)
 * and asserts fail-closed that EVERY backend `service=llm` generation request
 * observed across all server instances/launches of this run used the run-owned
 * e2e-local/e2e-model (LOCK-006). Any non-run-owned record — including a kilo
 * gateway title fallback (kilo/kilo-auto/small) — fails the scenario with the
 * full typed record list (provider/model/agent/small/session diagnostics,
 * LOCK-008). The same store the harness reads here is what the extension-host
 * runner snapshots into `<scratch>/llm-requests-<scenario>.json` at scenario
 * end; the JSONL store itself survives worker restarts and reloadWindow
 * relaunches (real-restart), so an early external request cannot disappear.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  llmRequestMatrix,
  RUN_OWNED_MODEL,
  type LlmRequestRecord,
} from "../src/services/cli-backend/llm-request-collector"

/** The run-owned store path the extension collector appends to. */
export function llmRequestStorePath(scratch: string): string {
  return join(scratch, "llm-requests.jsonl")
}

/** All records in the run-owned store (empty when absent). */
export function readLlmRequests(scratch: string): LlmRequestRecord[] {
  const file = llmRequestStorePath(scratch)
  if (!existsSync(file)) return []
  const out: LlmRequestRecord[] = []
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue
    try {
      const record = JSON.parse(line) as LlmRequestRecord
      if (record && typeof record.providerID === "string" && typeof record.modelID === "string") {
        out.push(record)
      }
    } catch {
      // Interrupted/corrupt line — never counted as a request (fail closed).
    }
  }
  return out
}

/**
 * Fail-closed LOCK-006 assertion: every generation request in the store must
 * be the run-owned e2e-local/e2e-model. Throws with the full typed record
 * list (violations first) when any non-run-owned request was observed — even
 * one that failed or aborted before a response. Writes the per-checkpoint
 * evidence matrix to `<scratch>/llm-matrix-<phase>.json` and returns it.
 */
export function assertRunOwnedLlmRequests(scratch: string, phase: string): {
  total: number
  runOwned: number
  violations: LlmRequestRecord[]
  byModel: Record<string, number>
  byAgent: Record<string, number>
  small: number
  nonSmall: number
  bySession: Record<string, number>
} {
  const records = readLlmRequests(scratch)
  const matrix = llmRequestMatrix(records)
  writeFileSync(join(scratch, `llm-matrix-${phase}.json`), JSON.stringify({ phase, ...matrix }, null, 2))
  if (matrix.violations.length > 0) {
    const detail = matrix.violations
      .map(
        (r) =>
          `  providerID=${r.providerID} modelID=${r.modelID} agent=${r.agent ?? "<none>"} small=${r.small ?? "<none>"} sessionID=${r.sessionID ?? "<none>"} pid=${r.pid} instance=${r.instance} ts=${r.ts}`,
      )
      .join("\n")
    throw new Error(
      `probe: ${phase}: ${matrix.violations.length} non-run-owned generation request(s) observed (LOCK-006). ` +
        `expected ${RUN_OWNED_MODEL.providerID}/${RUN_OWNED_MODEL.modelID}.\n${detail}\n` +
        `matrix=${JSON.stringify(matrix, null, 2)}`,
    )
  }
  if (records.length === 0) {
    throw new Error(`probe: ${phase}: no generation requests observed at all (collector store empty)`)
  }
  console.log(
    `[probe] PASS ${phase}: ${matrix.total} generation request(s), all ${RUN_OWNED_MODEL.providerID}/${RUN_OWNED_MODEL.modelID} ` +
      `(matrix=${JSON.stringify(matrix, null, 2)})`,
  )
  return matrix
}
