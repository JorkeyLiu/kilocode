import { describe, expect, it } from "bun:test"
import {
  extractRecords,
  parseBackendLogLine,
  parseCliPath,
  parseExtensionPerfLine,
  parseSpawnedPid,
  sliceStages,
} from "../../script/p0-bench/parse"
import type { StageRecord } from "../../script/p0-bench/types"

describe("p0 benchmark parser", () => {
  it("parses an extension-host P0 record line", () => {
    const line = '[Kilo New][P0-Perf] {"corr":"abc","stage":"activate.start","t":1000,"d":0,"surface":"extension"}'
    const rec = parseExtensionPerfLine(line)
    expect(rec).toEqual({
      surface: "extension",
      stage: "activate.start",
      t: 1000,
      corr: "abc",
      d: 0,
    })
  })

  it("parses a webview-forwarded P0 record with wd and pid extra", () => {
    const line =
      '[Kilo New][P0-Perf] {"corr":"abc","stage":"webview.paint","t":1500,"d":500,"wd":42.5,"surface":"webview"}'
    const rec = parseExtensionPerfLine(line)
    expect(rec?.surface).toBe("webview")
    expect(rec?.wd).toBe(42.5)
    expect(rec?.stage).toBe("webview.paint")

    const spawnLine =
      '[Kilo New][P0-Perf] {"corr":"abc","stage":"spawn.done","t":2000,"d":1000,"pid":4242,"surface":"extension"}'
    expect(parseExtensionPerfLine(spawnLine)?.pid).toBe(4242)
  })

  it("ignores non-P0 lines and malformed JSON", () => {
    expect(parseExtensionPerfLine("[Kilo New] ServerManager: 🔍 getServer called")).toBeUndefined()
    expect(parseExtensionPerfLine("[Kilo New][P0-Perf] {not json")).toBeUndefined()
  })

  it("parses a backend p0 record relayed through the ServerManager stderr wrapper", () => {
    const line =
      "[Kilo New] ServerManager: ⚠️ CLI Server stderr: INFO  2026-08-10T15:00:00 +5ms service=p0-perf event=p0.start stage=listener ts=1750000000000 id=127.0.0.1:0 listener"
    const rec = parseBackendLogLine(line)
    expect(rec).toEqual({
      surface: "backend",
      stage: "listener",
      t: 1750000000000,
      event: "p0.start",
      id: "127.0.0.1:0",
    })
  })

  it("parses a backend p0.end span with duration", () => {
    const line =
      "INFO  x service=p0-perf event=p0.end stage=config_load ts=1750000000100 duration=47 dir=/tmp/scratch config_load"
    const rec = parseBackendLogLine(line)
    expect(rec?.event).toBe("p0.end")
    expect(rec?.stage).toBe("config_load")
    expect(rec?.duration).toBe(47)
    expect(rec?.dir).toBe("/tmp/scratch")
  })

  it("ignores backend lines that are not p0-perf records", () => {
    expect(parseBackendLogLine("INFO  x service=mcp event=connect mcp")).toBeUndefined()
    expect(parseBackendLogLine("INFO  x service=p0-perf event=p0.mark")).toBeUndefined()
  })

  it("extracts CLI path and spawned PID provenance lines", () => {
    expect(parseCliPath("[Kilo New] ServerManager: 📍 CLI path: /ws/packages/kilo-vscode/bin/kilo")).toBe(
      "/ws/packages/kilo-vscode/bin/kilo",
    )
    expect(parseCliPath("[Kilo New] ServerManager: 📍 Using CLI path: /x/kilo")).toBeNull()
    expect(parseSpawnedPid("[Kilo New] ServerManager: 📦 Process spawned with PID: 31415")).toBe(31415)
    expect(parseSpawnedPid("[Kilo New] ServerManager: 🔐 Generated password")).toBeNull()
  })

  it("extracts ordered records from a mixed capture buffer", () => {
    const text = [
      "[probe] some progress line",
      '[Kilo New][P0-Perf] {"corr":"c","stage":"activate.start","t":100,"d":0,"surface":"extension"}',
      "[Kilo New] ServerManager: 📍 CLI path: /ws/bin/kilo",
      "INFO  x service=p0-perf event=p0.start stage=listener ts=300 listener",
      '[Kilo New][P0-Perf] {"corr":"c","stage":"webview.paint","t":200,"d":100,"wd":30,"surface":"webview"}',
      "INFO  x service=p0-perf event=p0.end stage=listener ts=900 duration=600 listener",
      "[Kilo New] ServerManager: 📦 Process spawned with PID: 777",
    ].join("\n")
    const { stages, cliPath, spawnedPid } = extractRecords(text)
    expect(cliPath).toBe("/ws/bin/kilo")
    expect(spawnedPid).toBe(777)
    expect(stages.map((s) => [s.surface, s.stage, s.t])).toEqual([
      ["extension", "activate.start", 100],
      ["webview", "webview.paint", 200],
      ["backend", "listener", 300],
      ["backend", "listener", 900],
    ])
  })

  it("slices stages within a t range", () => {
    const stages: StageRecord[] = [
      { surface: "extension", stage: "a", t: 10 },
      { surface: "extension", stage: "b", t: 20 },
      { surface: "extension", stage: "c", t: 30 },
    ]
    expect(sliceStages(stages, 15, 30).map((s) => s.stage)).toEqual(["b"])
  })
})
