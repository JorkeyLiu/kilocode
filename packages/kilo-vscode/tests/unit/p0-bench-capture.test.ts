import { describe, expect, it } from "bun:test"
import {
  createCapture,
  flushCapture,
  ingestCapture,
  pendingText,
  utf8ByteLength,
} from "../../script/p0-bench/parse"

const RECORD = (stage: string, t: number, surface = "extension") =>
  `[Kilo New][P0-Perf] {"stage":"${stage}","t":${t},"d":0,"surface":"${surface}"}`

describe("p0 bounded incremental capture", () => {
  it("parses a record split across chunk boundaries (partial line held)", () => {
    const state = createCapture(1024)
    ingestCapture(state, '[Kilo New][P0-Perf] {"stage":"activate.start","t":100')
    expect(state.records.stages).toHaveLength(0)
    ingestCapture(state, ',"d":0,"surface":"extension"}\n')
    expect(state.records.stages).toHaveLength(1)
    expect(state.records.stages[0]!.stage).toBe("activate.start")
    expect(state.records.stages[0]!.t).toBe(100)
    expect(state.pendingBytes).toBe(0)
  })

  it("parses multiple complete lines from one chunk and merges provenance", () => {
    const state = createCapture(1024)
    ingestCapture(
      state,
      [
        "[probe] progress",
        `${RECORD("activate.done", 200)}`,
        "[Kilo New] ServerManager: 📍 CLI path: /ws/bin/kilo",
        `${RECORD("spawn.done", 300)}`,
      ].join("\n") + "\n",
    )
    expect(state.records.stages.map((s) => [s.stage, s.t])).toEqual([
      ["activate.done", 200],
      ["spawn.done", 300],
    ])
    expect(state.records.cliPath).toBe("/ws/bin/kilo")
  })

  it("flushCapture parses the pending partial line at stop", () => {
    const state = createCapture(1024)
    ingestCapture(state, `${RECORD("dataReady.done", 400)}`) // no trailing newline
    const result = flushCapture(state)
    expect(result.records.stages.map((s) => s.stage)).toEqual(["dataReady.done"])
    expect(result.text).toBe(`${RECORD("dataReady.done", 400)}`)
    expect(state.pendingBytes).toBe(0)
  })

  it("retains at most capBytes plus one chunk and flags truncation", () => {
    const state = createCapture(16)
    ingestCapture(state, "ab\n")
    ingestCapture(state, "cd\n")
    ingestCapture(state, "efghijklmnopqrstuvwxyz\n") // 23 bytes alone exceeds cap
    expect(state.truncated).toBe(true)
    expect(state.retainedBytes).toBeLessThanOrEqual(16 + 23)
    // Live raw segments (dead head slots are compacted in batches).
    expect(state.chunks.slice(state.chunksHead)).toEqual(["efghijklmnopqrstuvwxyz\n"])
    const result = flushCapture(state)
    expect(result.text).toBe("efghijklmnopqrstuvwxyz\n")
    expect(result.totalBytes).toBe(3 + 3 + 23)
    expect(result.retainedBytes).toBe(23)
  })

  it("never drops parsed P0 records when raw output is truncated", () => {
    const state = createCapture(32)
    ingestCapture(state, `${RECORD("activate.start", 100)}\n`)
    ingestCapture(state, `${RECORD("webview.paint", 150)}\n`)
    ingestCapture(state, "x".repeat(1000) + "\n") // forces raw truncation
    expect(state.truncated).toBe(true)
    expect(state.records.stages.map((s) => s.stage).sort()).toEqual([
      "activate.start",
      "webview.paint",
    ])
    expect(state.retainedBytes).toBeLessThanOrEqual(32 + 1001)
  })

  it("counts UTF-8 bytes across 1/2/3/4-byte code points", () => {
    expect(utf8ByteLength("abc")).toBe(3)
    expect(utf8ByteLength("é")).toBe(2)
    expect(utf8ByteLength("中")).toBe(3)
    expect(utf8ByteLength("😀")).toBe(4)
    expect(utf8ByteLength("aé中😀")).toBe(10)
  })

  it("keeps retainedBytes accounting exact across trims", () => {
    const state = createCapture(8)
    ingestCapture(state, "abcdefgh\n") // 9 bytes, single chunk > cap (kept whole)
    expect(state.retainedBytes).toBe(9)
    ingestCapture(state, "ij\n")
    ingestCapture(state, "kl\n")
    // 9 + 3 + 3 = 15 > 8: drop "abcdefgh\n" (9) → 6 retained; the tail pair
    // coalesces into one live segment ("ij\nkl\n"), preserving text and order.
    expect(state.retainedBytes).toBe(6)
    expect(state.chunks.slice(state.chunksHead).join("")).toBe("ij\nkl\n")
    expect(state.truncated).toBe(true)
  })

  it("appends parsed records to the same view (no re-parse of old text)", () => {
    const state = createCapture(64)
    ingestCapture(state, `${RECORD("a", 1)}\n`)
    const stages = state.records.stages
    expect(stages).toHaveLength(1)
    ingestCapture(state, `${RECORD("b", 2)}\n`)
    expect(stages).toHaveLength(2)
    expect(state.records.cliPath).toBeNull()
  })

  it("bounds a long unterminated line to the cap across many small chunks", () => {
    const state = createCapture(64)
    for (let i = 0; i < 2000; i++) ingestCapture(state, "abcdefgh") // 8 bytes, no newline
    expect(state.truncated).toBe(true)
    expect(state.pendingBytes).toBeLessThanOrEqual(64)
    expect(state.pendingBytes).toBeGreaterThan(0)
    expect(state.retainedBytes).toBeLessThanOrEqual(64 + 8)
    const result = flushCapture(state)
    expect(result.truncated).toBe(true)
    expect(result.retainedBytes).toBeLessThanOrEqual(64 + 8)
  })

  it("keeps ingest work bounded for a long unterminated line (no unbounded pending)", () => {
    const state = createCapture(256)
    // 50k ingests × 64 B = 3.2 MB with no newline: the segment queue keeps
    // per-ingest work O(1) once the cap is reached, so this stays fast; an
    // implementation that grows or re-scans the pending line would blow the
    // default bun:test 5s timeout here.
    const started = performance.now()
    for (let i = 0; i < 50_000; i++) ingestCapture(state, "u".repeat(64))
    const elapsed = performance.now() - started
    expect(state.pendingBytes).toBeLessThanOrEqual(256)
    expect(state.pendingBytes).toBeGreaterThan(0)
    expect(state.truncated).toBe(true)
    expect(elapsed).toBeLessThan(5_000)
  })

  it("trims a single chunk that alone exceeds the cap, keeping the newest bytes", () => {
    const state = createCapture(16)
    ingestCapture(state, "z".repeat(100))
    expect(state.pendingBytes).toBe(16)
    expect(pendingText(state)).toBe("z".repeat(16))
    expect(state.truncated).toBe(true)
  })

  it("keeps parsing complete P0 records after pending truncation", () => {
    const state = createCapture(32)
    ingestCapture(state, `${RECORD("activate.start", 100)}\n`)
    for (let i = 0; i < 500; i++) ingestCapture(state, "x".repeat(10)) // long unterminated line
    expect(state.truncated).toBe(true)
    expect(state.pendingBytes).toBeLessThanOrEqual(32)
    ingestCapture(state, `${RECORD("spawn.done", 200)}\n`)
    expect(state.records.stages.map((s) => s.stage)).toEqual(["activate.start", "spawn.done"])
    expect(state.records.stages[1]!.t).toBe(200)
  })

  it("counts a surrogate pair split across chunks as 4 bytes", () => {
    const state = createCapture(1024)
    ingestCapture(state, "a\uD83D") // high surrogate ends the chunk
    ingestCapture(state, "\uDE00b") // low surrogate starts the next chunk
    expect(state.pendingBytes).toBe(6) // a(1) + 😀(4) + b(1)
    expect(utf8ByteLength(pendingText(state))).toBe(6)
    expect(pendingText(state)).toBe("a\uD83D\uDE00b")
  })

  it("never leaves an orphaned surrogate when trimming the pending line", () => {
    const state = createCapture(8)
    ingestCapture(state, "ab\uD83D") // pendingBytes 5 (high surrogate counted alone)
    ingestCapture(state, "\uDE00cd") // pair joins across the boundary → pendingBytes 8
    expect(state.pendingBytes).toBe(8)
    expect(state.pendingBytes).toBe(utf8ByteLength(pendingText(state)))
    // The pair coalesces into one live segment ("ab😀cd"); the head drop then
    // removes the whole emoji line, leaving a clean suffix with no orphaned
    // surrogate and exact byte accounting.
    ingestCapture(state, "e") // 9 > 8 → drop the head segment (the whole pair)
    expect(state.truncated).toBe(true)
    expect(state.pendingBytes).toBe(1)
    expect(pendingText(state)).toBe("e")
    expect(state.pendingBytes).toBe(utf8ByteLength(pendingText(state)))
    // The next complete line still parses after the bounded pending.
    ingestCapture(state, "\n")
    expect(state.records.stages).toHaveLength(0)
    expect(state.pendingBytes).toBe(0)
  })

  it("drops an orphaned low surrogate when trimming a segment boundary pair", () => {
    const state = createCapture(8)
    ingestCapture(state, "abcd\uD83D") // 7 bytes; high surrogate ends the segment
    ingestCapture(state, "\uDE00") // 3 bytes; 7 + 3 − 2 = 8 ≤ cap, boundary survives
    expect(state.pendingBytes).toBe(8)
    ingestCapture(state, "x") // 9 > 8 → drop the head segment mid-pair
    expect(state.truncated).toBe(true)
    expect(pendingText(state)).toBe("x")
    expect(state.pendingBytes).toBe(utf8ByteLength(pendingText(state)))
  })

  it("keeps the raw segment count constant-bounded under 1-byte adversarial writes", () => {
    const state = createCapture(1024)
    for (let i = 0; i < 200_000; i++) ingestCapture(state, "x")
    expect(state.truncated).toBe(true)
    expect(state.retainedBytes).toBeLessThanOrEqual(1024 + 1)
    // Live raw segments are bounded by MAX_SEGMENTS regardless of chunk size;
    // the old implementation retained one segment per byte (~5 MiB objects).
    expect(state.chunks.length - state.chunksHead).toBeLessThanOrEqual(32)
    // The retained tail is a bounded suffix of the stream (order preserved);
    // segment-granular drops can leave it a little short of the cap.
    const text = state.chunks.slice(state.chunksHead).join("")
    expect(text).toBe("x".repeat(text.length))
    expect(text.length).toBeGreaterThan(0)
    expect(text.length).toBeLessThanOrEqual(1024 + 1)
  })

  it("keeps the pending segment count constant-bounded under 1-byte newline-free writes", () => {
    const state = createCapture(1024)
    for (let i = 0; i < 200_000; i++) ingestCapture(state, "x")
    expect(state.pendingBytes).toBeLessThanOrEqual(1024)
    expect(state.pending.length - state.pendingHead).toBeLessThanOrEqual(32)
    const tail = pendingText(state)
    expect(tail).toBe("x".repeat(tail.length))
    expect(tail.length).toBeGreaterThan(0)
  })

  it("preserves raw-tail ordering under 1-byte adversarial writes (newest bytes kept)", () => {
    const state = createCapture(256)
    const seq = "0123456789"
    for (let i = 0; i < 100_000; i++) ingestCapture(state, seq[i % 10]!)
    const text = state.chunks.slice(state.chunksHead).join("")
    expect(state.retainedBytes).toBeLessThanOrEqual(256 + 1)
    expect(text).toBe(seq.repeat(10_000).slice(-state.retainedBytes))
    expect(state.chunks.length - state.chunksHead).toBeLessThanOrEqual(32)
    const result = flushCapture(state)
    expect(result.text).toBe(text)
    expect(result.retainedBytes).toBe(state.retainedBytes)
  })

  it("finishes adversarial 1-byte capture within the normal test timeout", () => {
    const state = createCapture(64)
    const started = performance.now()
    for (let i = 0; i < 1_000_000; i++) ingestCapture(state, "a")
    const elapsed = performance.now() - started
    expect(state.truncated).toBe(true)
    expect(state.pendingBytes).toBeLessThanOrEqual(64)
    expect(state.chunks.length - state.chunksHead).toBeLessThanOrEqual(32)
    expect(state.pending.length - state.pendingHead).toBeLessThanOrEqual(32)
    expect(elapsed).toBeLessThan(5_000)
  })
})
