import { describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  countHangGenerationPosts,
  parseHangRequestBytes,
  redactHangBodyText,
  snapshotHangRequests,
  summarizeHangRequests,
  writeHangRequestsAtomic,
} from "../../script/e2e-probe-operation-crash"

function postBytes(body: Record<string, unknown>, headers: Record<string, string> = {}): Buffer {
  const raw = JSON.stringify(body)
  const head = [
    "POST /v1/chat/completions HTTP/1.1",
    "Host: 127.0.0.1",
    "Content-Type: application/json",
    `Content-Length: ${Buffer.byteLength(raw)}`,
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    "",
    "",
  ].join("\r\n")
  return Buffer.concat([Buffer.from(head, "utf8"), Buffer.from(raw, "utf8")])
}

describe("operation-crash hang request evidence (actual helper, no duplicated parser)", () => {
  it("classifies a complete generation POST and extracts the model", () => {
    const buf = postBytes({ model: "e2e-model", messages: [{ role: "user", content: "hi" }] })
    const rec = parseHangRequestBytes(buf, 0, "2026-01-01T00:00:00.000Z")
    expect(rec.complete).toBe(true)
    expect(rec.classification).toBe("complete-generation-post")
    expect(rec.method).toBe("POST")
    expect(rec.url).toBe("/v1/chat/completions")
    expect(rec.path).toBe("/v1/chat/completions")
    expect(rec.bodyModel).toBe("e2e-model")
    expect(rec.bodyKeys).toContain("model")
  })

  it("redacts Authorization headers and never persists the raw credential", () => {
    const buf = postBytes({ model: "e2e-model" }, { Authorization: "Bearer secret-abc-123" })
    const rec = parseHangRequestBytes(buf, 3)
    expect(rec.headers["authorization"]).toBe("[REDACTED]")
    const text = JSON.stringify(rec)
    expect(text.includes("secret-abc-123")).toBe(false)
    expect(text.includes("Bearer secret")).toBe(false)
  })

  it("redacts api keys in bodies and headers before persist", () => {
    const preview = redactHangBodyText(JSON.stringify({ model: "e2e-model", apiKey: "e2e-fixture-key" }))
    expect(preview.includes("e2e-fixture-key")).toBe(false)
    expect(preview.includes("[REDACTED]")).toBe(true)
    const buf = postBytes({ model: "e2e-model", apiKey: "e2e-fixture-key" }, { "x-api-key": "e2e-fixture-key" })
    const rec = parseHangRequestBytes(buf, 1)
    expect(rec.headers["x-api-key"]).toBe("[REDACTED]")
    expect(JSON.stringify(rec).includes("e2e-fixture-key")).toBe(false)
  })

  it("classifies header-incomplete bytes as incomplete (never benign)", () => {
    const rec = parseHangRequestBytes(Buffer.from("POST /v1/chat/completions HTTP/1.1\r\nHost: x", "utf8"), 0)
    expect(rec.complete).toBe(false)
    expect(rec.classification).toBe("incomplete")
    expect(rec.incompleteReason).toBe("headers-incomplete")
  })

  it("classifies a Content-Length body prefix as incomplete", () => {
    const full = JSON.stringify({ model: "e2e-model", messages: [] })
    const head = `POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\nContent-Length: ${Buffer.byteLength(full)}\r\n\r\n`
    const partial = Buffer.concat([Buffer.from(head, "utf8"), Buffer.from(full.slice(0, 5), "utf8")])
    const rec = parseHangRequestBytes(partial, 0)
    expect(rec.complete).toBe(false)
    expect(rec.classification).toBe("incomplete")
    expect((rec.incompleteReason ?? "").includes("body-incomplete")).toBe(true)
  })

  it("classifies empty sockets as empty", () => {
    const rec = parseHangRequestBytes(Buffer.alloc(0), 7)
    expect(rec.classification).toBe("empty")
    expect(rec.complete).toBe(false)
  })

  it("classifies non-generation routes as complete-other", () => {
    const buf = Buffer.from("GET /health HTTP/1.1\r\nHost: x\r\n\r\n", "utf8")
    const rec = parseHangRequestBytes(buf, 0)
    expect(rec.complete).toBe(true)
    expect(rec.classification).toBe("complete-other")
  })

  it("counts only matching generation POSTs", () => {
    const gen = parseHangRequestBytes(postBytes({ model: "e2e-model" }), 0)
    const other = parseHangRequestBytes(Buffer.from("GET /health HTTP/1.1\r\nHost: x\r\n\r\n", "utf8"), 1)
    const incomplete = parseHangRequestBytes(Buffer.from("POST /v1/chat", "utf8"), 2)
    expect(countHangGenerationPosts([gen, other, incomplete])).toBe(1)
    expect(summarizeHangRequests([gen, other, incomplete])).toEqual({
      total: 3,
      generationPosts: 1,
      otherComplete: 1,
      incomplete: 1,
      empty: 0,
    })
  })

  it("snapshot helper never throws for missing hang", () => {
    expect(snapshotHangRequests(undefined)).toEqual([])
  })

  it("atomic dump persists redacted records without leaking credentials", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-hang-"))
    try {
      const rec = parseHangRequestBytes(
        postBytes({ model: "e2e-model" }, { Authorization: "Bearer e2e-fixture-key" }),
        0,
      )
      const dest = writeHangRequestsAtomic(dir, "operation-crash-hang-requests-after", [rec])
      const text = readFileSync(dest, "utf8")
      expect(text.includes("e2e-fixture-key")).toBe(false)
      expect(text.includes("Bearer e2e-fixture-key")).toBe(false)
      expect(text.includes("[REDACTED]")).toBe(true)
      const parsed = JSON.parse(text) as { generationPosts: number; records: unknown[] }
      expect(parsed.generationPosts).toBe(1)
      expect(parsed.records.length).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
