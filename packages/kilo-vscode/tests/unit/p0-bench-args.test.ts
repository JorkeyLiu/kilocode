import { afterEach, beforeAll, describe, expect, it } from "bun:test"
import { join } from "node:path"
import { parseArgs, USAGE, wantsHelp } from "../../script/p0-bench/args"

const REPO = "/ws/kilocode"
const saved: Record<string, string | undefined> = {}
const KEYS = [
  "KILO_P0_SCENARIOS",
  "KILO_P0_SAMPLES",
  "KILO_P0_WARMUP",
  "KILO_P0_SWITCH_SESSIONS",
  "KILO_P0_MCP_AGENTS",
]

beforeAll(() => {
  for (const key of KEYS) saved[key] = process.env[key]
})

afterEach(() => {
  for (const key of KEYS) {
    const value = saved[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe("p0 extension help handling", () => {
  it("detects --help and -h before any build or launch", () => {
    expect(wantsHelp(["--help"])).toBe(true)
    expect(wantsHelp(["-h"])).toBe(true)
    expect(wantsHelp(["--scenarios", "1,2"])).toBe(false)
    expect(wantsHelp([])).toBe(false)
  })

  it("usage states JSONL is versionable evidence and raw logs may be ignored", () => {
    expect(USAGE).toContain("Usage")
    expect(USAGE).toContain("--scenarios")
    expect(USAGE).toContain("--out")
    expect(USAGE).toContain("VERSIONABLE tracker evidence")
    expect(USAGE).toContain("logs/")
    expect(USAGE).toContain("not a tail-latency SLA")
  })
})

describe("p0 extension argument parsing", () => {
  it("default outDir lands under the repo-root evidence convention", () => {
    const args = parseArgs([], REPO)
    // <repo>/specs/vscode-orchestrator/evidence/p0-baseline/<ts>
    const base = join(REPO, "specs", "vscode-orchestrator", "evidence", "p0-baseline")
    expect(args.outDir.startsWith(base)).toBe(true)
    // Exactly one level below the p0-baseline dir (the timestamped run dir).
    expect(join(args.outDir, "..")).toBe(base)
    expect(args.scenarios).toEqual(["cold-start", "warm-view", "no-provider", "custom-provider", "many-agent-mcp", "session-switch"])
    expect(args.samples).toBe(5)
    expect(args.warmup).toBe(1)
  })

  it("honors --out and explicit flags", () => {
    const args = parseArgs(
      ["--scenarios", "1,10", "--samples", "3", "--warmup", "0", "--out", "/tmp/run-1", "--switch-sessions", "2", "--mcp-agents", "4"],
      REPO,
    )
    expect(args.outDir).toBe("/tmp/run-1")
    expect(args.scenarios).toEqual(["cold-start", "session-switch"])
    expect(args.samples).toBe(3)
    expect(args.warmup).toBe(0)
    expect(args.switchSessions).toBe(2)
    expect(args.mcpAgents).toBe(4)
  })

  it("falls back to KILO_P0_* env vars", () => {
    process.env.KILO_P0_SCENARIOS = "5,3"
    process.env.KILO_P0_SAMPLES = "2"
    process.env.KILO_P0_WARMUP = "1"
    const args = parseArgs([], REPO)
    expect(args.scenarios).toEqual(["many-agent-mcp", "no-provider"])
    expect(args.samples).toBe(2)
    expect(args.warmup).toBe(1)
  })

  it("throws on invalid values", () => {
    expect(() => parseArgs(["--samples", "0"], REPO)).toThrow("--samples must be an integer >= 1")
    expect(() => parseArgs(["--warmup", "-1"], REPO)).toThrow("--warmup must be an integer >= 0")
    expect(() => parseArgs(["--scenarios", "nope"], REPO)).toThrow("unknown scenario")
  })

  it("rejects fractional samples and warmup (integer required)", () => {
    expect(() => parseArgs(["--samples", "2.5"], REPO)).toThrow("--samples must be an integer >= 1")
    expect(() => parseArgs(["--samples", "1e-1"], REPO)).toThrow("--samples must be an integer >= 1")
    expect(() => parseArgs(["--warmup", "0.5"], REPO)).toThrow("--warmup must be an integer >= 0")
    expect(() => parseArgs(["--samples", "3", "--warmup", "1.5"], REPO)).toThrow("--warmup must be an integer >= 0")
  })

  it("rejects fractional values from KILO_P0_* env vars", () => {
    process.env.KILO_P0_SAMPLES = "3.5"
    expect(() => parseArgs([], REPO)).toThrow("--samples must be an integer >= 1")
    process.env.KILO_P0_SAMPLES = "2"
    process.env.KILO_P0_WARMUP = "0.25"
    expect(() => parseArgs([], REPO)).toThrow("--warmup must be an integer >= 0")
  })
})
