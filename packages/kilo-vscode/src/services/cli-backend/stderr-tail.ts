import { StringDecoder } from "string_decoder"

/**
 * Upper bound on the number of complete stderr lines retained in the bounded
 * diagnostic tail. Documented small bound: 100 lines. Older lines are dropped
 * from the front (newest kept) so startup-failure diagnostics always show the
 * most recent backend output.
 */
export const MAX_STDERR_TAIL_LINES = 100

/**
 * Upper bound on the total UTF-8 bytes retained across the diagnostic tail:
 * the retained complete lines plus the unterminated partial line each hold at
 * most `MAX_STDERR_TAIL_BYTES`. A single over-long line is trimmed to its
 * newest `MAX_STDERR_TAIL_BYTES` bytes, so retained memory is static-bounded
 * (~32 KiB of line text plus a constant number of strings) regardless of how
 * much stderr the backend writes over the worker lifetime. Documented small
 * bound: 16 KiB.
 */
export const MAX_STDERR_TAIL_BYTES = 16 * 1024

export interface StderrTailOptions {
  /** Called once per complete newline-delimited line, in stream order. */
  onLine?: (line: string) => void
  /** Max complete lines retained (default `MAX_STDERR_TAIL_LINES`). */
  maxLines?: number
  /** Max UTF-8 bytes retained (default `MAX_STDERR_TAIL_BYTES`). */
  maxBytes?: number
}

/**
 * Bounded stderr relay for the spawned backend process.
 *
 * Reassembles arbitrary Buffer/string stderr chunks into complete
 * newline-delimited lines before relaying each line (via `onLine`) and
 * retaining a bounded diagnostic tail. A backend log record split across pipe
 * chunks is therefore relayed as exactly one complete line, which the P0
 * harness parses per line. Memory is static-bounded: at most `maxBytes` UTF-8
 * bytes and `maxLines` strings are retained among the complete lines, plus at
 * most `maxBytes` bytes in the unterminated partial line, no matter how much
 * stderr the backend emits over its lifetime.
 *
 * UTF-8: Buffer chunks are decoded with StringDecoder, so a multi-byte
 * character split across chunk boundaries is reassembled without a replacement
 * char. A trailing `\r` (CRLF sources) is stripped from each complete line.
 * Empty lines are skipped (relay and retention). The one lossy edge: a
 * multi-byte character that is split by the very last chunk and never
 * completed is dropped at end-of-stream (the stream is over; no replacement
 * char is injected).
 *
 * The trailing partial line (no newline yet) is held separately and
 * materialized by `flush()` at end/error, so startup-failure diagnostics keep
 * the newest backend output.
 */
export class StderrTail {
  private readonly onLine?: (line: string) => void
  private readonly maxLines: number
  private readonly maxBytes: number
  private readonly decoder = new StringDecoder("utf8")
  private lines: string[] = []
  private bytes = 0
  private buf = ""
  private bufBytes = 0

  constructor(opts: StderrTailOptions = {}) {
    this.onLine = opts.onLine
    this.maxLines = opts.maxLines ?? MAX_STDERR_TAIL_LINES
    this.maxBytes = opts.maxBytes ?? MAX_STDERR_TAIL_BYTES
  }

  /** Feed one raw stderr chunk; complete lines are relayed and retained. */
  write(chunk: Buffer | string): void {
    const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk)
    if (text.length === 0) return
    const nl = text.lastIndexOf("\n")
    if (nl < 0) {
      this.appendBuf(text)
      return
    }
    const combined = this.buf + text.slice(0, nl + 1)
    this.buf = ""
    this.bufBytes = 0
    for (const raw of combined.split("\n")) {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
      if (line.length > 0) this.emitLine(line)
    }
    const tail = text.slice(nl + 1)
    if (tail.length > 0) this.appendBuf(tail)
  }

  /** Snapshot of the retained complete lines (newest last, bounded). */
  tail(): string[] {
    return [...this.lines]
  }

  /** The current unterminated partial line, if any. */
  pending(): string {
    return this.buf
  }

  /**
   * Materialize the trailing partial line at end/error: it is relayed and
   * retained like any complete line, then cleared. Idempotent — a second call
   * with no pending text returns `""`. Returns the flushed line.
   */
  flush(): string {
    if (this.buf.length === 0) return ""
    const raw = this.buf
    this.buf = ""
    this.bufBytes = 0
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
    if (line.length > 0) this.emitLine(line)
    return line
  }

  private emitLine(line: string): void {
    this.onLine?.(line)
    const kept = trimBytes(line, this.maxBytes)
    if (kept.length === 0) return
    this.lines.push(kept)
    this.bytes += utf8ByteLength(kept)
    this.retain()
  }

  private retain(): void {
    while (this.lines.length > this.maxLines || this.bytes > this.maxBytes) {
      const oldest = this.lines.shift()!
      this.bytes -= utf8ByteLength(oldest)
    }
  }

  private appendBuf(text: string): void {
    if (text.length === 0) return
    if (this.bufBytes + utf8ByteLength(text) > this.maxBytes) {
      // Bound the unterminated partial line: keep only its newest bytes.
      this.buf = trimBytes(this.buf + text, this.maxBytes)
    } else {
      this.buf += text
    }
    this.bufBytes = utf8ByteLength(this.buf)
  }
}

/** UTF-8 byte length of a string (surrogate pairs count as 4 bytes). */
export function utf8ByteLength(s: string): number {
  let bytes = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const low = s.charCodeAt(i + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4
        i++
      } else {
        bytes += 3
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      bytes += 3
    } else if (c < 0x80) {
      bytes += 1
    } else if (c < 0x800) {
      bytes += 2
    } else {
      bytes += 3
    }
  }
  return bytes
}

/**
 * Keep the newest `cap` UTF-8 bytes of `s` at a character boundary (never
 * splitting a surrogate pair), returning at most `cap` bytes. Returns `s`
 * unchanged when it is within the cap.
 */
function trimBytes(s: string, cap: number): string {
  const bytes = utf8ByteLength(s)
  if (bytes <= cap) return s
  const drop = bytes - cap
  let cut = 0
  let acc = 0
  while (cut < s.length) {
    const code = s.codePointAt(cut)!
    const size = code > 0xffff ? 4 : code < 0x80 ? 1 : code < 0x800 ? 2 : 3
    if (acc + size > drop) break
    acc += size
    cut += code > 0xffff ? 2 : 1
  }
  let kept = s.slice(cut)
  // The boundary code point can straddle `drop`, leaving the kept suffix up to
  // one code point over the cap; drop that code point so kept is never larger.
  while (utf8ByteLength(kept) > cap && kept.length > 0) {
    const code = kept.codePointAt(0)!
    kept = kept.slice(code > 0xffff ? 2 : 1)
  }
  return kept
}
