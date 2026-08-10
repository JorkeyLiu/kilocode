import { describe, expect, it, afterEach } from "bun:test"

const PREFIX = "[Kilo New][P0-Perf] "

function capture(): { logs: unknown[][]; restore: () => void } {
  const logs: unknown[][] = []
  const log = console.log
  console.log = (...args: unknown[]) => logs.push(args)
  return { logs, restore: () => (console.log = log) }
}

function records(logs: unknown[][]): Record<string, unknown>[] {
  return logs.map((args) => JSON.parse(args.join(" ").slice(PREFIX.length)))
}

describe("p0 perf instrumentation helper", () => {
  afterEach(() => {
    delete process.env.KILO_P0_PERF
  })

  it("emits no records when the flag is off (disabled path has no output)", async () => {
    delete process.env.KILO_P0_PERF
    const { logs, restore } = capture()
    try {
      const { p0Stage, p0Begin, p0Webview } = await import("../../src/perf/perf-instrument")
      p0Begin()
      p0Stage("activate.start")
      p0Stage("spawn.done", { pid: 42 })
      p0Webview("webview.paint", Date.now(), 12.5)
    } finally {
      restore()
    }
    expect(logs).toEqual([])
  })

  it("emits one-line JSON records with correlation, stage, timestamps, and surface when enabled", async () => {
    process.env.KILO_P0_PERF = "1"
    const { logs, restore } = capture()
    try {
      const { p0Stage, p0Begin } = await import("../../src/perf/perf-instrument")
      p0Begin()
      p0Stage("activate.start")
      p0Stage("port.detected", { port: 1234 })
    } finally {
      restore()
    }

    expect(logs.length).toBe(2)
    const parsed = records(logs)
    expect(parsed[0]!.stage).toBe("activate.start")
    expect(parsed[1]!.stage).toBe("port.detected")
    expect(parsed[1]!.port).toBe(1234)
    for (const rec of parsed) {
      expect(rec.corr).toBeTruthy()
      expect(typeof rec.t).toBe("number")
      expect(typeof rec.d).toBe("number")
      expect(rec.surface).toBe("extension")
    }
    // Same correlation across stages; deltas are monotonically non-decreasing.
    expect(parsed[0]!.corr).toBe(parsed[1]!.corr)
    expect(parsed[1]!.d).toBeGreaterThanOrEqual(parsed[0]!.d)
  })

  it("starts a fresh correlation per p0Begin", async () => {
    process.env.KILO_P0_PERF = "1"
    const { logs, restore } = capture()
    try {
      const { p0Stage, p0Begin } = await import("../../src/perf/perf-instrument")
      p0Begin()
      p0Stage("activate.start")
      p0Begin()
      p0Stage("activate.restart")
    } finally {
      restore()
    }
    const parsed = records(logs)
    expect(parsed.length).toBe(2)
    expect(parsed[0]!.corr).not.toBe(parsed[1]!.corr)
    // New correlation resets the delta baseline (near-zero, may be the same ms).
    expect(parsed[1]!.d).toBeLessThan(10)
  })

  it("forwards webview records with surface webview and webview-relative delta", async () => {
    process.env.KILO_P0_PERF = "1"
    const { logs, restore } = capture()
    try {
      const { p0Stage, p0Webview } = await import("../../src/perf/perf-instrument")
      p0Stage("dataReady.done")
      p0Webview("webview.paint", Date.now(), 12.5)
    } finally {
      restore()
    }
    const parsed = records(logs)
    expect(parsed.length).toBe(2)
    expect(parsed[1]!.surface).toBe("webview")
    expect(parsed[1]!.wd).toBe(12.5)
    expect(parsed[1]!.corr).toBe(parsed[0]!.corr)
  })
})
