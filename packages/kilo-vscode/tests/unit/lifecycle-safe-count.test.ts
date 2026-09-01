import { describe, expect, test } from "bun:test"
import { safeLocatorCount } from "../../script/e2e-probe-lifecycle"

describe("safeLocatorCount fail-closed", () => {
  test("returns valid zero without error", async () => {
    const loc = { count: async () => 0 }
    expect(await safeLocatorCount(loc as never, "test")).toBe(0)
  })
  test("returns non-zero count", async () => {
    const loc = { count: async () => 3 }
    expect(await safeLocatorCount(loc as never, "test")).toBe(3)
  })
  test("throws redacted error on Playwright failure instead of masking as zero", async () => {
    const loc = {
      count: async () => {
        throw new Error("Playwright CDP error: something failed")
      },
    }
    await expect(safeLocatorCount(loc as never, "myLabel")).rejects.toThrow(/myLabel count failed \(redacted\)/)
    try {
      await safeLocatorCount(loc as never, "myLabel")
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      expect(msg.includes("Playwright")).toBeTrue()
      expect(msg.length).toBeLessThan(300)
    }
  })
})
