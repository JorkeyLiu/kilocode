import { describe, expect, it } from "bun:test"
import {
  MAX_STDERR_TAIL_BYTES,
  MAX_STDERR_TAIL_LINES,
  StderrTail,
  utf8ByteLength,
} from "../../src/services/cli-backend/stderr-tail"
import { toErrorMessage } from "../../src/services/cli-backend/server-manager"
import { parseBackendLogLine } from "../../script/p0-bench/parse"

/** Feed chunks and collect the relayed lines in order. */
function relay(chunks: Array<Buffer | string>, opts?: ConstructorParameters<typeof StderrTail>[0]) {
  const lines: string[] = []
  const tail = new StderrTail({ ...opts, onLine: (line) => lines.push(line) })
  for (const chunk of chunks) tail.write(chunk)
  return { tail, lines }
}

const BACKEND_LINE =
  "INFO  2026-08-10T15:00:00 +5ms service=p0-perf event=p0.start stage=listener ts=1750000000000 id=127.0.0.1:0 listener"

describe("StderrTail line reassembly", () => {
  it("relays a backend record split across arbitrary chunk boundaries as one complete line", () => {
    // Split mid-token with no newline in the first chunk, exactly the case the
    // P0 harness could not parse before: two chunks, one complete record.
    const cut = Math.floor(BACKEND_LINE.length / 2)
    const { lines } = relay([Buffer.from(BACKEND_LINE.slice(0, cut)), Buffer.from(BACKEND_LINE.slice(cut) + "\n")])
    expect(lines).toEqual([BACKEND_LINE])
    // The current P0 parser parses the relayed line unchanged.
    expect(parseBackendLogLine(lines[0]!)).toMatchObject({
      surface: "backend",
      stage: "listener",
      event: "p0.start",
      id: "127.0.0.1:0",
    })
  })

  it("reassembles one line split into many byte-sized Buffer chunks", () => {
    const bytes = Buffer.from(BACKEND_LINE + "\n")
    const chunks: Buffer[] = []
    for (const b of bytes) chunks.push(Buffer.from([b]))
    const { lines } = relay(chunks)
    expect(lines).toEqual([BACKEND_LINE])
    expect(parseBackendLogLine(lines[0]!)).toBeDefined()
  })

  it("relays multiple complete lines from a single chunk, in order", () => {
    const text = [
      "INFO  a service=mcp event=connect mcp",
      "[Kilo New] ServerManager: 📍 CLI path: /ws/bin/kilo",
      BACKEND_LINE,
    ].join("\n")
    const { lines } = relay([Buffer.from(text + "\n")])
    expect(lines).toEqual([text.split("\n")[0]!, text.split("\n")[1]!, BACKEND_LINE])
  })

  it("relays lines that arrive in the same chunk plus a following partial line", () => {
    const { tail, lines } = relay(["one\ntwo\nthree"])
    expect(lines).toEqual(["one", "two"])
    expect(tail.pending()).toBe("three")
    tail.write(Buffer.from("\n"))
    expect(lines).toEqual(["one", "two", "three"])
    expect(tail.pending()).toBe("")
  })

  it("strips a trailing CR (CRLF sources) from each complete line", () => {
    const { lines } = relay(["one\r\ntwo\r\n"])
    expect(lines).toEqual(["one", "two"])
  })

  it("decodes a multi-byte UTF-8 character split across Buffer chunks without replacement", () => {
    const text = Buffer.from("INFO  \u{1F600} ready\n")
    const { lines } = relay([text.subarray(0, 8), text.subarray(8)])
    expect(lines).toEqual(["INFO  \u{1F600} ready"])
    expect(lines[0]!.includes("\uFFFD")).toBe(false)
  })

  it("holds a split surrogate pair across string chunks without byte drift", () => {
    const { tail } = relay(["a\uD83D", "\uDE00b"])
    expect(tail.pending()).toBe("a\uD83D\uDE00b")
    expect(utf8ByteLength(tail.pending())).toBe(6) // a + 😀 + b, no orphan accounting
    tail.write("\n")
    expect(tail.pending()).toBe("")
  })
})

describe("StderrTail bounded retention", () => {
  it("retains at most MAX_STDERR_TAIL_LINES complete lines (newest kept)", () => {
    const { tail } = relay(Array.from({ length: MAX_STDERR_TAIL_LINES + 50 }, (_, i) => `line ${i}\n`))
    const tailLines = tail.tail()
    expect(tailLines.length).toBe(MAX_STDERR_TAIL_LINES)
    expect(tailLines[0]).toBe("line 50")
    expect(tailLines[tailLines.length - 1]).toBe(`line ${MAX_STDERR_TAIL_LINES + 49}`)
  })

  it("bounds retained complete lines by total UTF-8 bytes", () => {
    const chunk = "x".repeat(1024) + "\n"
    const { tail } = relay(Array.from({ length: 64 }, () => chunk))
    const text = tail.tail().join("")
    expect(tail.tail().length).toBeLessThanOrEqual(MAX_STDERR_TAIL_LINES)
    expect(utf8ByteLength(text)).toBeLessThanOrEqual(MAX_STDERR_TAIL_BYTES)
    expect(tail.tail()[tail.tail().length - 1]).toBe("x".repeat(1024)) // newest line retained
  })

  it("trims a single over-long line to its newest MAX_STDERR_TAIL_BYTES bytes", () => {
    const huge = "abc" + "y".repeat(50_000) + "\n"
    const { tail } = relay([huge])
    const kept = tail.tail()[0]!
    expect(utf8ByteLength(kept)).toBeLessThanOrEqual(MAX_STDERR_TAIL_BYTES)
    expect(kept).toBe("y".repeat(utf8ByteLength(kept)))
  })

  it("bounds the unterminated partial line to MAX_STDERR_TAIL_BYTES", () => {
    const { tail } = relay(Array.from({ length: 2000 }, () => "u".repeat(64)))
    expect(utf8ByteLength(tail.pending())).toBeLessThanOrEqual(MAX_STDERR_TAIL_BYTES)
    expect(utf8ByteLength(tail.pending())).toBeGreaterThan(0)
    // Completing the bounded pending emits it, then a later complete line
    // (a real record after the garbage) is relayed and retained intact.
    const { tail: tail2 } = relay([...Array.from({ length: 2000 }, () => "u".repeat(64)), "\n", "done\n"])
    expect(tail2.tail().at(-1)).toBe("done")
  })

  it("never splits a surrogate pair when trimming an over-long line", () => {
    const { tail } = relay(["a\uD83D\uDE00".repeat(10_000) + "\n"])
    const kept = tail.tail()[0]!
    const head = kept.charCodeAt(0)
    const prev = kept.charCodeAt(1)
    const lowAlone = head >= 0xdc00 && head <= 0xdfff
    const highDangling = head >= 0xd800 && head <= 0xdbff && !(prev >= 0xdc00 && prev <= 0xdfff)
    expect(lowAlone).toBe(false)
    expect(highDangling).toBe(false)
  })
})

describe("StderrTail trailing partial flush", () => {
  it("flush materializes the partial line at end: relayed, retained, cleared", () => {
    const { tail, lines } = relay([BACKEND_LINE])
    expect(tail.pending()).toBe(BACKEND_LINE)
    expect(tail.tail()).toEqual([])

    const flushed = tail.flush()
    expect(flushed).toBe(BACKEND_LINE)
    expect(tail.pending()).toBe("")
    expect(tail.tail()).toEqual([BACKEND_LINE])
    expect(lines).toEqual([BACKEND_LINE])
    expect(parseBackendLogLine(lines[0]!)).toBeDefined()
  })

  it("flush is idempotent once the pending line is gone", () => {
    const { tail } = relay(["partial"])
    expect(tail.flush()).toBe("partial")
    expect(tail.flush()).toBe("")
  })

  it("flush on an already-empty tail returns an empty string", () => {
    const { tail } = relay(["done\n"])
    expect(tail.flush()).toBe("")
  })
})

describe("StderrTail diagnostics and disabled path", () => {
  it("normal error-message behavior: startup failure keeps the newest diagnostics", () => {
    const { tail } = relay([
      "some early noise\n",
      "Error: Config file at /path/kilo.json is not valid JSON(C):\n",
      "more noise\n",
    ])
    // toErrorMessage is built on the bounded tail exactly as ServerManager does.
    const result = toErrorMessage("startup failed", tail.tail(), "/usr/local/bin/kilo")
    expect(result.userMessage).toBe("Config file at /path/kilo.json is not valid JSON(C):")
    expect(result.userDetails).toContain("CLI path: /usr/local/bin/kilo")
    expect(result.userDetails).toContain("Error: Config file at /path/kilo.json is not valid JSON(C):")
  })

  it("disabled/non-P0 path behavior: relay and retention never consult KILO_P0_PERF", () => {
    delete process.env.KILO_P0_PERF
    const linesIn = ["INFO  a line\n", "INFO  b line\n"]
    const { tail, lines } = relay(linesIn)
    expect(lines).toEqual(["INFO  a line", "INFO  b line"])
    expect(tail.tail()).toEqual(["INFO  a line", "INFO  b line"])
    // No P0 record text is synthesized by the relay itself.
    for (const line of lines) expect(line.includes("p0-perf")).toBe(false)
    expect(process.env.KILO_P0_PERF).toBeUndefined()
  })
})
