import { afterEach, beforeAll, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RunRecord, SampleRecord } from "../../script/p0-bench/types"
import { runMergeCli } from "../../script/p0-bench/merge-run"

const SCENARIO = "many-agent-mcp"

const RUN_ENV = {
  os: "darwin",
  arch: "arm64",
  node: "v22.0.0",
  extension: "7.4.11",
  gitHead: "abc1234",
  gitCommit: "abc1234".padEnd(40, "0"),
  gitDirty: false,
  backendCli: "/ws/packages/kilo-vscode/bin/kilo",
}

const SAMPLE_ENV = { ...RUN_ENV, vscode: "1.132.0" }

function sampleRec(sample: number, phase: "warmup" | "measured", startedAt: number, ok: boolean): SampleRecord {
  return {
    v: 1,
    kind: "sample",
    scenario: SCENARIO,
    condition: { id: SCENARIO, configSeeded: true, agents: 20, providers: 0, mcp: "p0-bench-mcp", note: "fixture" },
    sample,
    cycle: 0,
    phase,
    lifecycle: 1,
    startedAt,
    elapsedMs: 500,
    env: SAMPLE_ENV,
    provenance: {
      cliPath: null,
      cliPathInWorkspace: false,
      cliExists: false,
      cliSha256: null,
      cliVersionHash: null,
      spawnedPid: null,
      spawnedArgsMatch: false,
      spawnedStart: null,
    },
    key: { mcpConnectMs: 100 + sample },
    stages: [],
    failures: ok ? [] : ["fixture failure"],
    blocked: ok ? null : { reason: "fixture-failure", detail: "blocked fixture sample" },
    ok,
  }
}

/** Write a complete one-sample segment JSONL into `<dir>/benchmark.jsonl`. */
function writeSegment(dir: string, opts: { samples: number; warmup: number; base?: number; ok?: boolean[] }): string {
  const n = opts.samples + opts.warmup
  const base = opts.base ?? 1700000000000
  const starts = Array.from({ length: n }, (_, i) => base + i * 1000)
  const ok = opts.ok ?? Array.from({ length: n }, () => true)
  const lines: string[] = []
  lines.push(
    JSON.stringify({
      v: 1,
      kind: "run",
      event: "start",
      startedAt: base - 1000,
      scenarios: [SCENARIO],
      samples: opts.samples,
      warmup: opts.warmup,
      outDir: dir,
      env: RUN_ENV,
    } satisfies RunRecord),
  )
  for (let i = 0; i < n; i++) {
    const sample = i + 1
    const phase = sample <= opts.warmup ? "warmup" : "measured"
    lines.push(JSON.stringify(sampleRec(sample, phase, starts[i]!, ok[i]!)))
  }
  const status = ok.every(Boolean) ? "ok" : "failed"
  lines.push(
    JSON.stringify({
      v: 1,
      kind: "run",
      event: "finish",
      finishedAt: starts[n - 1]! + 1000,
      elapsedMs: 2000,
      scenarios: [SCENARIO],
      samples: opts.samples,
      warmup: opts.warmup,
      status,
      outDir: dir,
    } satisfies RunRecord),
  )
  const path = join(dir, "benchmark.jsonl")
  writeFileSync(path, lines.join("\n") + "\n")
  return path
}

/** Write a segment without run/finish (the exact interrupted evidence shape). */
function writeInterrupted(dir: string, base: number): string {
  const lines = [
    JSON.stringify({ v: 1, kind: "run", event: "start", startedAt: base - 1000, scenarios: [SCENARIO], samples: 1, warmup: 1, outDir: dir, env: RUN_ENV } satisfies RunRecord),
    JSON.stringify(sampleRec(1, "warmup", base, true)),
    JSON.stringify(sampleRec(2, "measured", base + 1000, true)),
  ]
  const path = join(dir, "benchmark.jsonl")
  writeFileSync(path, lines.join("\n") + "\n")
  return path
}

/** Write a raw capture log into `<dir>/logs/` (like the live harness does). */
function writeLog(dir: string, name: string): string {
  const logDir = join(dir, "logs")
  mkdirSync(logDir, { recursive: true })
  const path = join(logDir, name)
  writeFileSync(path, "[Kilo New][P0-Perf] fixture log\n")
  return path
}

/** Write a valid 5-segment campaign (1 warmup-bearing + 4 measured) into root. */
function writeCampaign(root: string): string[] {
  const segs: string[] = []
  for (let i = 0; i < 5; i++) {
    const dir = join(root, `seg${i + 1}`)
    mkdirSync(dir, { recursive: true })
    const path = writeSegment(dir, { samples: 1, warmup: i === 0 ? 1 : 0, base: 1700000000000 + i * 100_000 })
    writeLog(dir, `sample-${i + 1}-${SCENARIO}.log`)
    segs.push(path)
  }
  return segs
}

function capture(fn: () => number): { code: number; out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  const origLog = console.log
  const origErr = console.error
  console.log = (...a: unknown[]) => {
    out.push(a.join(" "))
  }
  console.error = (...a: unknown[]) => {
    err.push(a.join(" "))
  }
  try {
    return { code: fn(), out, err }
  } finally {
    console.log = origLog
    console.error = origErr
  }
}

const savedRoot = process.env.KILO_E2E_ROOT
beforeAll(() => {
  delete process.env.KILO_E2E_ROOT
})
afterEach(() => {
  if (savedRoot === undefined) delete process.env.KILO_E2E_ROOT
  else process.env.KILO_E2E_ROOT = savedRoot
})

describe("p0 segment merger CLI (no live launch)", () => {
  it("help exits 0, prints usage, and creates nothing (no live launch)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "p0-merge-help-"))
    try {
      const result = capture(() => runMergeCli(["--help"], tmp))
      expect(result.code).toBe(0)
      expect(result.out.join("\n")).toContain("Usage")
      expect(readdirSync(tmp)).toHaveLength(0)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("merges a valid 1+4 campaign to 1 warmup + 5 measured with summaries, manifest, and copied logs", () => {
    const tmp = mkdtempSync(join(tmpdir(), "p0-merge-ok-"))
    try {
      const segs = writeCampaign(tmp)
      const outDir = join(tmp, "merged")
      const result = capture(() => runMergeCli(["--segments", ...segs, "--out", outDir], tmp))
      expect(result.err).toEqual([])
      expect(result.code).toBe(0)
      expect(result.out.join("\n")).toContain("baselineComplete=true")
      const jsonl = readFileSync(join(outDir, "benchmark.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>)
      expect((jsonl[0] as RunRecord).kind).toBe("run")
      expect((jsonl[0] as RunRecord).event).toBe("start")
      expect((jsonl[jsonl.length - 1] as RunRecord).event).toBe("finish")
      const samples = jsonl.filter((r) => r.kind === "sample")
      expect(samples).toHaveLength(6)
      expect(samples[0]).toMatchObject({ sample: 1, phase: "warmup" })
      expect(samples.slice(1).map((s) => s.sample)).toEqual([1, 2, 3, 4, 5])
      expect(jsonl.filter((r) => r.kind === "summary").length).toBeGreaterThan(0)
      const manifest = JSON.parse(readFileSync(join(outDir, "merge-manifest.json"), "utf8")) as Record<string, unknown>
      expect(manifest.baselineComplete).toBe(true)
      expect((manifest.actual as { warmup: number; measured: number }).warmup).toBe(1)
      expect((manifest.actual as { warmup: number; measured: number }).measured).toBe(5)
      expect((manifest.inputs as unknown[]).length).toBe(5)
      const firstLogs = ((manifest.inputs as Array<Record<string, unknown>>)[0]!.logs as Record<string, unknown>)!
      expect(firstLogs.present).toBe(true)
      expect(firstLogs.copied).toEqual([`seg0-sample-1-${SCENARIO}.log`])
      expect(existsSync(join(outDir, "logs", `seg0-sample-1-${SCENARIO}.log`))).toBe(true)
      expect(manifest.recordMapping).toBeDefined()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("emits a valid-but-incomplete artifact with exit 2 when only 3 measured samples exist", () => {
    const tmp = mkdtempSync(join(tmpdir(), "p0-merge-inc-"))
    try {
      const segs = writeCampaign(tmp).slice(0, 3) // warmup-bearing + 2 measured → 3 measured
      const outDir = join(tmp, "merged")
      const result = capture(() => runMergeCli(["--segments", ...segs, "--out", outDir], tmp))
      expect(result.code).toBe(2)
      expect(result.out.join("\n")).toContain("INCOMPLETE")
      const manifest = JSON.parse(readFileSync(join(outDir, "merge-manifest.json"), "utf8")) as Record<string, unknown>
      expect(manifest.baselineComplete).toBe(false)
      expect((manifest.actual as { measured: number }).measured).toBe(3)
      const jsonl = readFileSync(join(outDir, "benchmark.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>)
      expect(jsonl.filter((r) => r.kind === "sample")).toHaveLength(4) // 1 warmup + 3 measured
      expect((jsonl[0] as RunRecord).event).toBe("start")
      expect((jsonl[jsonl.length - 1] as RunRecord).event).toBe("finish")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("rejects an interrupted input (missing run/finish) with exit 1 and no artifact", () => {
    const tmp = mkdtempSync(join(tmpdir(), "p0-merge-int-"))
    try {
      const seg1 = join(tmp, "seg1")
      mkdirSync(seg1, { recursive: true })
      writeInterrupted(seg1, 1700000000000)
      const seg2 = join(tmp, "seg2")
      mkdirSync(seg2, { recursive: true })
      writeSegment(seg2, { samples: 1, warmup: 0, base: 1700000100000 })
      const outDir = join(tmp, "merged")
      const result = capture(() => runMergeCli(["--segments", join(seg1, "benchmark.jsonl"), join(seg2, "benchmark.jsonl"), "--out", outDir], tmp))
      expect(result.code).toBe(1)
      expect(result.err.join("\n")).toContain("no run/finish")
      expect(existsSync(outDir)).toBe(false)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("rejects a missing segment path with exit 1", () => {
    const tmp = mkdtempSync(join(tmpdir(), "p0-merge-miss-"))
    try {
      const result = capture(() => runMergeCli(["--segments", join(tmp, "nope.jsonl"), "--out", join(tmp, "out")], tmp))
      expect(result.code).toBe(1)
      expect(result.err.join("\n")).toContain("segment not found")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("refuses to write into an input segment dir or its subdirectory", () => {
    const tmp = mkdtempSync(join(tmpdir(), "p0-merge-write-"))
    try {
      const segs = writeCampaign(tmp)
      const same = capture(() => runMergeCli(["--segments", ...segs, "--out", join(tmp, "seg1")], tmp))
      expect(same.code).toBe(1)
      expect(same.err.join("\n")).toContain("refusing to write into input segment dir")
      const inside = capture(() => runMergeCli(["--segments", ...segs, "--out", join(tmp, "seg1", "sub")], tmp))
      expect(inside.code).toBe(1)
      // The merged output must not overwrite an input JSONL either.
      const overwrite = capture(() => runMergeCli(["--segments", segs[0]!, "--out", join(tmp, "seg1")], tmp))
      expect(overwrite.code).toBe(1)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("records missing segment logs as not present without failing", () => {
    const tmp = mkdtempSync(join(tmpdir(), "p0-merge-nolog-"))
    try {
      const segs: string[] = []
      for (let i = 0; i < 5; i++) {
        const dir = join(tmp, `seg${i + 1}`)
        mkdirSync(dir, { recursive: true })
        segs.push(writeSegment(dir, { samples: 1, warmup: i === 0 ? 1 : 0, base: 1700000000000 + i * 100_000 }))
      }
      const outDir = join(tmp, "merged")
      const result = capture(() => runMergeCli(["--segments", ...segs, "--out", outDir], tmp))
      expect(result.code).toBe(0)
      const manifest = JSON.parse(readFileSync(join(outDir, "merge-manifest.json"), "utf8")) as Record<string, unknown>
      const inputs = manifest.inputs as Array<Record<string, unknown>>
      for (const input of inputs) {
        const logs = input.logs as { present: boolean; files: string[]; missing: string[] }
        expect(logs.present).toBe(false)
        expect(logs.files).toEqual([])
      }
      expect(existsSync(join(outDir, "logs"))).toBe(true) // empty logs dir still created
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
