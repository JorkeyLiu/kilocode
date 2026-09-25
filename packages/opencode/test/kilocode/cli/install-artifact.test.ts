import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"

const root = path.join(import.meta.dir, "..", "..", "..")
const wrapper = path.join(root, "bin", "kilo")
const postinstall = path.join(root, "script", "postinstall.mjs")

describe("bounded package distribution removal", () => {
  test("package.json is private and has no public bin map", async () => {
    const raw = await fs.readFile(path.join(root, "package.json"), "utf8")
    const pkg = JSON.parse(raw)
    expect(pkg.private).toBe(true)
    expect(pkg.bin).toBeUndefined()
  })

  test("public npm forwarder bin/kilo is removed", async () => {
    const exists = await fs
      .access(wrapper)
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(false)
  })

  test("postinstall.mjs is removed", async () => {
    const exists = await fs
      .access(postinstall)
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(false)
  })
})
