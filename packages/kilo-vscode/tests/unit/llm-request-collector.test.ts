import { describe, expect, it } from "bun:test"
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  LlmRequestCollector,
  llmRequestMatrix,
  parseLlmRequestLine,
  RUN_OWNED_MODEL,
  type LlmRequestRecord,
} from "../../src/services/cli-backend/llm-request-collector"

/**
 * Focused unit tests for the fixture-gated generation-request collector
 * (LOCK-006/LOCK-008): pure parser behavior over real backend `service=llm`
 * line shapes — valid run-owned custom lines, kilo gateway title lines, and
 * malformed/unrelated lines that must never become records (fail closed) —
 * plus the append-only store lifecycle and the per-class evidence matrix.
 */

const CUSTOM = "service=llm providerID=e2e-local modelID=e2e-model session.id=ses_abc123 small=false agent=e2e-agent mode=primary stream"
const TITLE = "service=llm providerID=kilo modelID=kilo-auto/small session.id=title-ses_xyz small=true agent=title mode=primary stream"
const SUBAGENT = "service=llm providerID=e2e-local modelID=e2e-model session.id=ses_child small=false agent=general mode=subagent stream"

describe("parseLlmRequestLine", () => {
  it("parses a valid run-owned custom request (full log-line form)", () => {
    const line = `INFO  2026-08-15T06:26:30 +6ms ${CUSTOM}`
    const record = parseLlmRequestLine(line)
    expect(record).not.toBeNull()
    expect(record!.providerID).toBe("e2e-local")
    expect(record!.modelID).toBe("e2e-model")
    expect(record!.sessionID).toBe("ses_abc123")
    expect(record!.small).toBe(false)
    expect(record!.agent).toBe("e2e-agent")
    expect(record!.mode).toBe("primary")
    expect(record!.ts).toBe("2026-08-15T06:26:30")
  })

  it("parses a kilo gateway title line as a record (the LOCK-006 violation shape)", () => {
    const line = `INFO  2026-08-15T06:26:26 +1815ms ${TITLE}`
    const record = parseLlmRequestLine(line)
    expect(record).not.toBeNull()
    expect(record!.providerID).toBe("kilo")
    expect(record!.modelID).toBe("kilo-auto/small")
    expect(record!.small).toBe(true)
    expect(record!.agent).toBe("title")
    expect(record!.sessionID).toContain("title-")
  })

  it("parses the ServerManager relay-prefixed capture form identically", () => {
    const prefixed = `[Kilo New] ServerManager: ⚠️ CLI Server stderr: INFO  2026-08-15T06:26:30 +6ms ${CUSTOM}`
    const record = parseLlmRequestLine(prefixed)
    expect(record).not.toBeNull()
    expect(record!.providerID).toBe("e2e-local")
    expect(record!.modelID).toBe("e2e-model")
  })

  it("parses a subagent request preserving the request class (agent=general, mode=subagent)", () => {
    const record = parseLlmRequestLine(SUBAGENT)
    expect(record).not.toBeNull()
    expect(record!.agent).toBe("general")
    expect(record!.mode).toBe("subagent")
    expect(record!.small).toBe(false)
  })

  it("returns null for lines without the service=llm anchor", () => {
    for (const line of [
      "INFO  2026-08-15T06:26:30 +6ms service=session providerID=e2e-local modelID=e2e-model stream",
      "INFO  2026-08-15T06:26:30 +6ms service=p0-perf stage=spawn.done",
      "INFO  2026-08-15T06:26:30 +6ms service=llm.other providerID=e2e-local modelID=e2e-model stream",
      "[Kilo New] ServerManager: ⚠️ CLI Server stderr: INFO  2026-08-15T06:26:30 +6ms service=default stream",
      "unrelated backend output line",
      "",
    ]) {
      expect(parseLlmRequestLine(line), `expected null for: ${line}`).toBeNull()
    }
  })

  it("returns null for malformed service=llm lines missing providerID/modelID (fail closed)", () => {
    for (const line of [
      "INFO  2026-08-15T06:26:30 +6ms service=llm session.id=ses_abc stream",
      "INFO  2026-08-15T06:26:30 +6ms service=llm providerID=e2e-local stream",
      "INFO  2026-08-15T06:26:30 +6ms service=llm modelID=e2e-model stream",
      "INFO  2026-08-15T06:26:30 +6ms service=llm providerID= modelID= stream",
    ]) {
      expect(parseLlmRequestLine(line), `expected null for: ${line}`).toBeNull()
    }
  })

  it("preserves only the parsed class fields (extra key=value pairs ignored)", () => {
    const record = parseLlmRequestLine(
      `INFO  2026-08-15T06:26:30 +6ms ${CUSTOM} providerID=e2e-local modelID=e2e-model`,
    )
    expect(record).not.toBeNull()
    expect(record!.providerID).toBe("e2e-local")
    expect(record!.modelID).toBe("e2e-model")
  })
})

describe("LlmRequestCollector (append-only fixture store)", () => {
  const dir = join(tmpdir(), `kilo-llm-collector-${process.pid}-${Math.random().toString(36).slice(2)}`)

  it("persists typed records with pid/instance attribution and survives re-read", () => {
    const file = join(dir, "llm-requests.jsonl")
    const collector = new LlmRequestCollector(file)
    try {
      collector.reset()
      collector.feed(`INFO  2026-08-15T06:26:30 +6ms ${CUSTOM}`, 111, 1)
      collector.feed(`INFO  2026-08-15T06:26:32 +2ms ${SUBAGENT}`, 111, 1)
      collector.feed(`INFO  2026-08-15T06:26:33 +1ms service=session stream`, 111, 1)
      collector.feed(`INFO  2026-08-15T06:26:34 +1ms ${TITLE}`, 222, 2)
      const records = collector.read()
      expect(records).toHaveLength(3)
      expect(records[0]!.providerID).toBe("e2e-local")
      expect(records[0]!.pid).toBe(111)
      expect(records[0]!.instance).toBe(1)
      expect(records[1]!.agent).toBe("general")
      expect(records[2]!.providerID).toBe("kilo")
      expect(records[2]!.modelID).toBe("kilo-auto/small")
      expect(records[2]!.pid).toBe(222)
      expect(records[2]!.instance).toBe(2)
      // A fresh collector over the same file sees the same aggregate (the
      // real-restart relaunch shape: a new extension host reads the persisted
      // store).
      const fresh = new LlmRequestCollector(file)
      expect(fresh.read()).toHaveLength(3)
      // The file itself is line-atomic JSON.
      const lines = readFileSync(file, "utf8").trim().split("\n")
      expect(lines).toHaveLength(3)
      for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
    } finally {
      collector.dispose()
    }
  })

  it("reset clears the store and a corrupt line is never counted", () => {
    const file = join(dir, "llm-requests-reset.jsonl")
    const collector = new LlmRequestCollector(file)
    try {
      collector.reset()
      collector.feed(`INFO  2026-08-15T06:26:30 +6ms ${CUSTOM}`, 111, 1)
      expect(collector.read()).toHaveLength(1)
      collector.reset()
      expect(collector.read()).toHaveLength(0)
      collector.feed(`INFO  2026-08-15T06:26:30 +6ms ${CUSTOM}`, 111, 1)
      // Simulate an interrupted/corrupt append: the collector never counts it.
      // (Direct append of garbage exercises the defensive skip in read().)
      appendFileSync(file, "{corrupt\n")
      expect(collector.read()).toHaveLength(1)
    } finally {
      collector.dispose()
    }
  })

  it("read returns an empty array when the store file does not exist", () => {
    const collector = new LlmRequestCollector(join(dir, "does-not-exist.jsonl"))
    expect(collector.read()).toEqual([])
    expect(existsSync(join(dir, "does-not-exist.jsonl"))).toBe(false)
  })
})

describe("llmRequestMatrix (per-class evidence matrix)", () => {
  const record = (partial: Partial<LlmRequestRecord> & { providerID: string; modelID: string }): LlmRequestRecord => ({
    pid: 1,
    instance: 1,
    ts: "2026-08-15T06:26:30",
    ...partial,
  })

  it("counts by model/agent/small/session and flags violations", () => {
    const matrix = llmRequestMatrix([
      record({ providerID: "e2e-local", modelID: "e2e-model", agent: "e2e-agent", sessionID: "s1" }),
      record({ providerID: "e2e-local", modelID: "e2e-model", agent: "general", sessionID: "s2" }),
      record({ providerID: "e2e-local", modelID: "e2e-model", agent: "title", small: true, sessionID: "title-s1" }),
      record({ providerID: "kilo", modelID: "kilo-auto/small", agent: "title", small: true, sessionID: "title-s2" }),
    ])
    expect(matrix.total).toBe(4)
    expect(matrix.runOwned).toBe(3)
    expect(matrix.violations).toHaveLength(1)
    expect(matrix.violations[0]!.modelID).toBe("kilo-auto/small")
    expect(matrix.byModel["e2e-local/e2e-model"]).toBe(3)
    expect(matrix.byModel["kilo/kilo-auto/small"]).toBe(1)
    expect(matrix.byAgent["title"]).toBe(2)
    expect(matrix.small).toBe(2)
    expect(matrix.nonSmall).toBe(2)
    expect(matrix.bySession["title-s2"]).toBe(1)
  })

  it("marks every record run-owned when only e2e-local/e2e-model appears", () => {
    const matrix = llmRequestMatrix([
      record({ providerID: RUN_OWNED_MODEL.providerID, modelID: RUN_OWNED_MODEL.modelID }),
      record({ providerID: RUN_OWNED_MODEL.providerID, modelID: RUN_OWNED_MODEL.modelID, small: true }),
    ])
    expect(matrix.runOwned).toBe(2)
    expect(matrix.violations).toHaveLength(0)
  })

  it("handles an empty record list", () => {
    const matrix = llmRequestMatrix([])
    expect(matrix.total).toBe(0)
    expect(matrix.runOwned).toBe(0)
    expect(matrix.violations).toEqual([])
  })
})
