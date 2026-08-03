import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import { disposeAllTmpdirs, tmpdir, tmpdirRegistrySize } from "../fixture/fixture"

const exists = (dir: string) => fs.stat(dir).then(() => true).catch(() => false)

describe("tmpdir registry retention (LOCK-004)", () => {
  test("many normally disposed tmpdirs leave the registry empty", async () => {
    const dirs = await Promise.all(Array.from({ length: 8 }, () => tmpdir()))
    expect(tmpdirRegistrySize()).toBeGreaterThanOrEqual(8)
    await Promise.all(dirs.map((dir) => dir[Symbol.asyncDispose]()))
    expect(tmpdirRegistrySize()).toBe(0)
    for (const dir of dirs) expect(await exists(dir.path)).toBe(false)
  })

  test("a failed disposer stays registered for the preload re-disposal pass", async () => {
    const failing = await tmpdir({
      dispose: async () => {
        throw new Error("simulated disposer failure")
      },
    })
    await expect(failing[Symbol.asyncDispose]()).rejects.toThrow("simulated disposer failure")
    // The failed disposer was NOT unregistered: the preload afterAll gets
    // another chance to remove the dir after the runtimes are stopped.
    expect(tmpdirRegistrySize()).toBe(1)
    // Clean up now (the test process is not the preload afterAll).
    await disposeAllTmpdirs()
    expect(tmpdirRegistrySize()).toBe(0)
    expect(await exists(failing.path)).toBe(false)
  })

  test("retained fixtures stay registered and get final cleanup via disposeAllTmpdirs", async () => {
    const retained = await Promise.all(Array.from({ length: 3 }, () => tmpdir({ retain: true })))
    await Promise.all(retained.map((dir) => dir[Symbol.asyncDispose]()))
    expect(tmpdirRegistrySize()).toBe(3)

    // Simulate a detached config install recreating the dir after normal
    // disposal: only the retained entries are still tracked, so the preload
    // afterAll pass removes the recreation.
    for (const dir of retained) {
      await fs.mkdir(dir.path, { recursive: true })
      await fs.writeFile(`${dir.path}/late.txt`, "recreated")
    }
    await disposeAllTmpdirs()
    expect(tmpdirRegistrySize()).toBe(0)
    for (const dir of retained) expect(await exists(dir.path)).toBe(false)
  })

  test("default-disposed dirs are unregistered: a late recreation is not re-disposed by disposeAllTmpdirs", async () => {
    const dirs = await Promise.all(Array.from({ length: 2 }, () => tmpdir()))
    await Promise.all(dirs.map((dir) => dir[Symbol.asyncDispose]()))
    expect(tmpdirRegistrySize()).toBe(0)

    // The dirs are no longer the registry's responsibility; a late recreation
    // here is cleaned up manually so the run stays green.
    for (const dir of dirs) {
      await fs.mkdir(dir.path, { recursive: true })
      await fs.writeFile(`${dir.path}/late.txt`, "recreated")
      await fs.rm(dir.path, { recursive: true, force: true })
    }
    expect(tmpdirRegistrySize()).toBe(0)
  })
})
