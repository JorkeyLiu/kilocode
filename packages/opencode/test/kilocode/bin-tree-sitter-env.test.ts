import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"

const script = path.join(import.meta.dir, "..", "..", "bin", "kilo")

describe("bin/kilo tree-sitter resources (bounded removal)", () => {
  test("public npm forwarder bin/kilo is removed - tree-sitter handled by kilo-serve binary co-location", async () => {
    const exists = await fs
      .access(script)
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(false)
  })
})
