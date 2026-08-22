/**
 * Content-Length framing per LSP / vscode-jsonrpc precedent:
 *   Content-Length: <bytes>\r\n\r\n<json>
 *
 * Header is ASCII and case-sensitive for Content-Length; we accept case-insensitive
 * match and ignore other headers (e.g. Content-Type). Body byte length is UTF-8.
 * Decoder is binary-safe: it buffers raw bytes so a multi-byte UTF-8 sequence
 * split across chunks is reassembled without replacement chars. Encoding always
 * produces a single Buffer ready for direct stdio write.
 */

export const FRAME_HEADER = "Content-Length"

export function encodeFrame(payload: unknown): Buffer {
  const json = JSON.stringify(payload)
  const bytes = Buffer.byteLength(json, "utf8")
  const header = `${FRAME_HEADER}: ${bytes}\r\n\r\n`
  return Buffer.concat([Buffer.from(header, "ascii"), Buffer.from(json, "utf8")])
}

/**
 * Incremental decoder for Content-Length framing. Handles arbitrary chunk splits
 * and pipelined messages: a single push may yield zero, one, or many complete
 * JSON strings. Header bytes are parsed as bytes to avoid cutting UTF-8, but
 * header parsing tolerates both string and Buffer chunks via an internal
 * StringDecoder for header scanning while body bytes are counted exactly.
 *
 * Bounded memory: caller drives push; retained bytes are exactly the buffered
 * incomplete frame (header + partial body). No auxiliary growth beyond that.
 */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0)

  push(chunk: Buffer | string): string[] {
    const incoming = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk
    this.buf = this.buf.length === 0 ? incoming : Buffer.concat([this.buf, incoming])
    const out: string[] = []
    for (;;) {
      const headerEnd = this.buf.indexOf("\r\n\r\n")
      if (headerEnd < 0) break
      const header = this.buf.subarray(0, headerEnd).toString("ascii")
      const len = parseContentLength(header)
      if (len === null) {
        // Malformed framing: no valid Content-Length — deterministic fatal.
        // Decoder emits sentinel invalid JSON so peer can reply -32700 and
        // close the transport to avoid poisoning the next valid frame.
        // No resynchronization is attempted; the peer owns lifecycle closure.
        this.buf = this.buf.subarray(headerEnd + 4)
        out.push("{ malformed Content-Length")
        continue
      }
      const total = headerEnd + 4 + len
      if (this.buf.length < total) break
      const body = this.buf.subarray(headerEnd + 4, total).toString("utf8")
      out.push(body)
      this.buf = this.buf.subarray(total)
    }
    return out
  }

  pendingBytes(): number {
    return this.buf.length
  }

  reset(): void {
    this.buf = Buffer.alloc(0)
  }
}

function parseContentLength(header: string): number | null {
  const lines = header.split("\r\n")
  for (const line of lines) {
    const idx = line.indexOf(":")
    if (idx < 0) continue
    const key = line.slice(0, idx).trim().toLowerCase()
    if (key !== "content-length") continue
    const val = line.slice(idx + 1).trim()
    const n = Number(val)
    if (!Number.isInteger(n) || n < 0) return null
    return n
  }
  return null
}

// Helper for tests: split a buffer into arbitrary chunks by byte boundaries.
export function splitBytes(buf: Buffer, sizes: number[]): Buffer[] {
  const out: Buffer[] = []
  let off = 0
  for (const s of sizes) {
    if (off >= buf.length) break
    out.push(buf.subarray(off, Math.min(off + s, buf.length)))
    off += s
  }
  if (off < buf.length) out.push(buf.subarray(off))
  return out
}
