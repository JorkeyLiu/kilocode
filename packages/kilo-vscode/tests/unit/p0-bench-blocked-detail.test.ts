import { describe, expect, it } from "bun:test"
import { boundBlockedDetail, boundBlockedReason, boundEvidence, boundFailure } from "../../script/p0-bench/sample"

const LIMIT = 2000

describe("boundBlockedDetail (2000-byte blocked.detail cap)", () => {
  it("passes empty and short details through unchanged", () => {
    expect(boundBlockedDetail("")).toBe("")
    expect(boundBlockedDetail("memory-guard-abort")).toBe("memory-guard-abort")
    expect(boundBlockedDetail('{"reason":"aggregate-rss"}')).toBe('{"reason":"aggregate-rss"}')
  })

  it("passes an exactly-LIMIT-byte detail through unchanged", () => {
    const exact = "a".repeat(LIMIT)
    expect(Buffer.byteLength(exact, "utf8")).toBe(LIMIT)
    expect(boundBlockedDetail(exact)).toBe(exact)
  })

  it("caps a long ASCII detail at the byte limit with a truncation ellipsis", () => {
    const long = "x".repeat(LIMIT + 250)
    const bound = boundBlockedDetail(long)
    expect(bound.endsWith("…")).toBe(true)
    expect(bound.slice(0, -1)).toBe("x".repeat(LIMIT))
  })

  it("caps a multi-byte detail by bytes without splitting a UTF-8 sequence", () => {
    const cjk = "汉".repeat(1000) // 3000 bytes
    const bound = boundBlockedDetail(cjk)
    expect(bound.endsWith("…")).toBe(true)
    const body = bound.slice(0, -1)
    expect(body).toBe("汉".repeat(666)) // 1998 bytes, cut on a code point boundary
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(LIMIT)
    // No split sequence: the result decodes without replacement characters.
    expect(Buffer.from(bound, "utf8").toString("utf8")).not.toContain("\uFFFD")
  })

  it("keeps surrogate pairs intact at the truncation boundary", () => {
    const long = "a".repeat(1998) + "🧪".repeat(10)
    const bound = boundBlockedDetail(long)
    expect(bound.endsWith("…")).toBe(true)
    expect(Buffer.from(bound, "utf8").toString("utf8")).not.toContain("\uFFFD")
  })
})

describe("boundFailure (200-byte failures[] entry cap)", () => {
  const CAP = 200

  it("passes short entries through unchanged and caps a huge entry by bytes", () => {
    expect(boundFailure("cleanup-failed: gone")).toBe("cleanup-failed: gone")
    const huge = `cleanup-failed: ${"x".repeat(10_000)}`
    const bound = boundFailure(huge)
    expect(bound.endsWith("…")).toBe(true)
    expect(Buffer.byteLength(bound.slice(0, -1), "utf8")).toBeLessThanOrEqual(CAP)
    expect(Buffer.from(bound, "utf8").toString("utf8")).not.toContain("\uFFFD")
  })

  it("caps a multibyte failure entry by UTF-8 bytes without splitting a sequence", () => {
    const huge = "memory-guard-abort: " + "汉".repeat(500) // 1500 bytes
    const bound = boundFailure(huge)
    expect(bound.endsWith("…")).toBe(true)
    expect(Buffer.byteLength(bound.slice(0, -1), "utf8")).toBeLessThanOrEqual(CAP)
    expect(Buffer.from(bound, "utf8").toString("utf8")).not.toContain("\uFFFD")
  })
})

describe("boundBlockedReason (200-byte blocked.reason cap, short reason semantics)", () => {
  it("passes short fixed reasons unchanged and caps a huge message by bytes", () => {
    expect(boundBlockedReason("memory-guard-abort")).toBe("memory-guard-abort")
    expect(boundBlockedReason("cleanup-failed")).toBe("cleanup-failed")
    const huge = "E".repeat(10_000)
    const bound = boundBlockedReason(huge)
    expect(bound.endsWith("…")).toBe(true)
    expect(Buffer.byteLength(bound.slice(0, -1), "utf8")).toBeLessThanOrEqual(200)
  })
})

describe("boundEvidence (shared byte-cap semantics across all bounded fields)", () => {
  it("truncates at the requested byte cap and never splits a surrogate pair", () => {
    expect(boundEvidence("abc", 10)).toBe("abc")
    const bound = boundEvidence("a".repeat(50) + "🧪".repeat(5), 40)
    expect(bound.endsWith("…")).toBe(true)
    expect(Buffer.byteLength(bound.slice(0, -1), "utf8")).toBeLessThanOrEqual(40)
    expect(Buffer.from(bound, "utf8").toString("utf8")).not.toContain("\uFFFD")
  })
})
