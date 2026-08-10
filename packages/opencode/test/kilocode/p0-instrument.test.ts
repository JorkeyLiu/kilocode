/**
 * Focused contract tests for the backend P0 instrumentation helper
 * (`src/kilocode/perf/instrument.ts`): the disabled path is silent and the
 * enabled path emits the documented record shapes (`p0.mark` / `p0.start` /
 * `p0.end`) with stage, ts, correlation keys, duration, and merged extras.
 *
 * The helper's `enabled` flag is evaluated once at module load, so each test
 * state imports the module through a cache-busting query string after setting
 * the env. The log stream is redirected to stderr (`Log.init({ print: true })`)
 * and captured synchronously for deterministic assertion.
 */

import { describe, expect, it } from "bun:test"
import * as Log from "@opencode-ai/core/util/log"

// Redirect the process log stream to stderr so p0 records are captured by the
// test's stderr interceptor instead of the rotating file stream (preload
// initialized it with print:false; this second init deterministically ends it).
await Log.init({ print: true, level: "DEBUG" })

function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const write = process.stderr.write
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  return { lines, restore: () => (process.stderr.write = write) }
}

/** Parse one log line into its `key=value` prefix fields (record contract). */
function parseRecord(line: string): Record<string, string> | undefined {
  const idx = line.indexOf("service=p0-perf")
  if (idx < 0) return undefined
  const out: Record<string, string> = {}
  for (const match of line.slice(idx).matchAll(/(\S+)=(\S+)/g)) out[match[1]] = match[2]
  return out
}

function p0Records(lines: string[]): Array<Record<string, string>> {
  return lines.map(parseRecord).filter((r): r is Record<string, string> => r !== undefined)
}

/**
 * Import a fresh module instance for the given flag state. The `enabled` flag
 * is read once at module load, so each state needs its own module instance;
 * the cache-busting query string would be statically unresolvable to tsgo, so
 * the specifier is built via template literal and the result cast to the
 * module's static type.
 */
async function loadInstrument(state: string) {
  const mod = await import(`../../src/kilocode/perf/instrument.ts?p0=${state}`)
  return mod as typeof import("../../src/kilocode/perf/instrument")
}

describe("backend P0 instrumentation helper", () => {
  it("emits nothing when the flag is off (disabled path is silent)", async () => {
    delete process.env.KILO_P0_PERF
    const { lines, restore } = capture()
    try {
      const mod = await loadInstrument("disabled")
      mod.mark("processor_entry", { id: "s1", meta: { messageID: "m1" } })
      const timer = mod.span("config_load", { dir: "/tmp/x" })
      timer.end()
    } finally {
      restore()
    }
    expect(p0Records(lines)).toEqual([])
  })

  it("mark emits a single p0.mark record with stage, ts, and correlation fields", async () => {
    process.env.KILO_P0_PERF = "1"
    const { lines, restore } = capture()
    try {
      const mod = await loadInstrument("mark-enabled")
      mod.mark("processor_entry", {
        id: "s1",
        meta: { messageID: "m1", parentID: "u1", model: "m", provider: "p" },
      })
      mod.mark("config_commit", { dir: "/tmp/proj", meta: { seq: 3 } })
    } finally {
      restore()
    }
    const records = p0Records(lines)
    expect(records).toHaveLength(2)

    const entry = records[0]!
    expect(entry.event).toBe("p0.mark")
    expect(entry.stage).toBe("processor_entry")
    expect(entry.id).toBe("s1")
    expect(Number.isFinite(Number(entry.ts))).toBe(true)
    expect(JSON.parse(entry.meta!)).toEqual({ messageID: "m1", parentID: "u1", model: "m", provider: "p" })

    const commit = records[1]!
    expect(commit.event).toBe("p0.mark")
    expect(commit.stage).toBe("config_commit")
    expect(commit.dir).toBe("/tmp/proj")
    expect(JSON.parse(commit.meta!)).toEqual({ seq: 3 })
  })

  it("span emits p0.start then p0.end with duration and merged extras", async () => {
    process.env.KILO_P0_PERF = "1"
    const { lines, restore } = capture()
    try {
      const mod = await loadInstrument("span-enabled")
      const timer = mod.span("provider_state_init", { dir: "/tmp/proj" })
      timer.end({ meta: { hostname: "localhost", port: 1234 } })
    } finally {
      restore()
    }
    const records = p0Records(lines)
    expect(records).toHaveLength(2)
    expect(records[0]!.event).toBe("p0.start")
    expect(records[0]!.stage).toBe("provider_state_init")
    expect(records[0]!.dir).toBe("/tmp/proj")
    expect(Number.isFinite(Number(records[0]!.ts))).toBe(true)
    expect(records[0]!.duration).toBeUndefined()

    const end = records[1]!
    expect(end.event).toBe("p0.end")
    expect(end.stage).toBe("provider_state_init")
    expect(end.dir).toBe("/tmp/proj")
    expect(Number.isFinite(Number(end.duration))).toBe(true)
    expect(JSON.parse(end.meta!)).toEqual({ hostname: "localhost", port: 1234 })
  })
})
