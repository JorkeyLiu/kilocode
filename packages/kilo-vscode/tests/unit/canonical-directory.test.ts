import { describe, it, expect } from "bun:test"
import { canonicalDirectory } from "../../src/private-worker/canonical-directory"
import { canonicalDirectory as opencodeCanonical } from "../../../opencode/src/kilocode/session/canonical-directory"

describe("vscode canonicalDirectory mirror contract", () => {
  it("normalizes lexically without realpath", () => {
    expect(canonicalDirectory("/tmp/a/../b")).toBe("/tmp/b")
    expect(canonicalDirectory("/tmp//a///b")).toBe("/tmp/a/b")
    expect(canonicalDirectory("/tmp/a/./b")).toBe("/tmp/a/b")
  })

  it("validates absolute and null bytes", () => {
    expect(() => canonicalDirectory("relative/path")).toThrow()
    expect(() => canonicalDirectory("")).toThrow()
    expect(() => canonicalDirectory("/tmp/\0evil")).toThrow()
  })

  it("is idempotent", () => {
    const p = "/tmp/ws/../ws/./"
    const once = canonicalDirectory(p)
    expect(canonicalDirectory(once)).toBe(once)
  })

  it("matches opencode canonicalDirectory semantics", () => {
    const cases = ["/tmp/ws", "/tmp/a/../b", "/tmp//a///b/./c", "/tmp/ws/", "/"]
    for (const c of cases) expect(canonicalDirectory(c)).toBe(opencodeCanonical(c))
    const bad = ["relative", "/tmp/\0x", ""]
    for (const c of bad) {
      let vsErr = false
      let opErr = false
      try { canonicalDirectory(c) } catch { vsErr = true }
      try { opencodeCanonical(c) } catch { opErr = true }
      expect(vsErr).toBe(true)
      expect(opErr).toBe(true)
    }
  })
})
