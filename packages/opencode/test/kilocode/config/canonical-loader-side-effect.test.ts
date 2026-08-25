// kilocode_change - P4.3 loader side-effect regression (audit finding 1)
import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import fs from "node:fs"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { tmpdir, disposeAllInstances } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"
import { Server } from "../../../src/server/server"
import { GlobalBus } from "../../../src/bus/global"

const originalConfig = Global.Path.config

afterEach(async () => {
  ;(Global.Path as { config: string }).config = originalConfig
  GlobalBus.removeAllListeners("event")
  await disposeAllInstances()
  await resetDatabase()
})

describe("P4.3 canonical loader has no persistence side effects outside lock+atomic (audit 1)", () => {
  test("source contains no loader writeFileString/writeWithDirs outside discovery lock", () => {
    const src = readFileSync(path.join(import.meta.dir, "../../../src/config/config.ts"), "utf8")
    // The $schema injection path must not call fs.writeFileString(options.path,
    expect(src).not.toContain("fs.writeFileString(options.path")
    // The missing-global seeding path must not call writeWithDirs with $schema
    // Use a precise sentinel: the old seeding wrote JSON.stringify({ $schema
    expect(src).not.toContain('writeWithDirs(file, JSON.stringify({ $schema')
    // Loader now documents in-memory-only normalization
    expect(src).toContain("no loader-side seeding outside lock+atomic")
    expect(src).toContain("in-memory")
    // Shared locks and atomic writer ownership remain documented
    expect(src).toContain("configDiscoveryGlobalKey")
    expect(src).toContain("KilocodeAtomicWrite")
  })

  test("loading a project or global config without $schema does not mutate the file on disk", async () => {
    await using globalTmp = await tmpdir({ retain: true })
    await using projectTmp = await tmpdir({ retain: true })
    ;(Global.Path as { config: string }).config = globalTmp.path

    const original = JSON.stringify({ model: "test/model", permission: { bash: "allow" } }, null, 2)
    const globalFile = path.join(globalTmp.path, "kilo.jsonc")
    await Bun.write(globalFile, original)

    // Trigger config load via the server overlay (loads global + project)
    const app = Server.Default().app
    const res = await app.request("/config/overlay?scope=project", {
      headers: { "x-kilo-directory": projectTmp.path },
    })
    expect(res.status).toBe(200)

    const after = await Bun.file(globalFile).text()
    // File must be byte-identical — no $schema injection
    expect(after).toBe(original)
    expect(after).not.toContain("$schema")
  })

  test("missing global file is not seeded by loadGlobal", async () => {
    await using globalTmp = await tmpdir({ retain: true })
    await using projectTmp = await tmpdir({ retain: true })
    ;(Global.Path as { config: string }).config = globalTmp.path

    const globalFile = path.join(globalTmp.path, "kilo.jsonc")
    expect(fs.existsSync(globalFile)).toBe(false)

    const app = Server.Default().app
    const res = await app.request("/config/overlay?scope=project", {
      headers: { "x-kilo-directory": projectTmp.path },
    })
    expect(res.status).toBe(200)

    // No file should have been created by the loader
    expect(fs.existsSync(globalFile)).toBe(false)
  })

  test("concurrent loads do not race to create/overwrite the global file (no seeding)", async () => {
    await using globalTmp = await tmpdir({ retain: true })
    await using projectTmp = await tmpdir({ retain: true })
    ;(Global.Path as { config: string }).config = globalTmp.path
    const globalFile = path.join(globalTmp.path, "kilo.jsonc")
    // Start with no file
    expect(fs.existsSync(globalFile)).toBe(false)

    const app = Server.Default().app
    // Fire 5 concurrent overlay reads that all trigger loadGlobal
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.request("/config/overlay?scope=project", {
          headers: { "x-kilo-directory": projectTmp.path },
        }),
      ),
    )
    for (const r of results) expect(r.status).toBe(200)
    // Still no file — loader has no side effect even under concurrency
    expect(fs.existsSync(globalFile)).toBe(false)
  })
})

describe("P4.3 canonical lock/atomic ownership preserved (LOCK-005)", () => {
  test("canonical config paths still document shared locks and atomic writes", () => {
    const loaderSrc = readFileSync(path.join(import.meta.dir, "../../../src/config/config.ts"), "utf8")
    const kilocodeSrc = readFileSync(path.join(import.meta.dir, "../../../src/kilocode/config/config.ts"), "utf8")
    const atomicSrc = readFileSync(path.join(import.meta.dir, "../../../src/kilocode/config/atomic-write.ts"), "utf8")
    expect(kilocodeSrc).toContain("configDiscoveryGlobalKey")
    expect(kilocodeSrc).toContain("configDiscoveryProjectKey")
    expect(atomicSrc).toContain("KilocodeAtomicWrite")
    expect(atomicSrc).toContain("rename")
    // Loader comments reference lock + atomic preservation
    expect(loaderSrc).toContain("KilocodeAtomicWrite")
  })
})
