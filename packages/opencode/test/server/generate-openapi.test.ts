import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import path from "path"
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("../../", import.meta.url))
const opencodeDir = path.resolve(dir)

describe("generate-openapi direct entry", () => {
  test("direct entry matches bun dev generate raw exact bytes (no DB)", async () => {
    const direct = await $`bun --conditions=browser ./src/server/generate-openapi.ts`.cwd(opencodeDir).quiet()
    const old = await $`bun run --conditions=browser ./src/index.ts generate`.cwd(opencodeDir).quiet()

    const directText = direct.text()
    const oldText = old.text()

    expect(direct.exitCode).toBe(0)
    expect(old.exitCode).toBe(0)

    const directJson = JSON.parse(directText)
    const oldJson = JSON.parse(oldText)
    expect(directJson.info.title).toBe("kilo")
    expect(oldJson.info.title).toBe("kilo")

    // raw exact bytes must be identical: shared generateOpenApiJson + deterministic Event ordering
    expect(directText).toBe(oldText)
  }, 30_000)

  test("direct generateOpenApiJson import matches spawned output", async () => {
    const { generateOpenApiJson } = await import("../../src/server/generate-openapi")
    const spawned = await $`bun --conditions=browser ./src/server/generate-openapi.ts`.cwd(opencodeDir).quiet()
    const imported = await generateOpenApiJson()
    expect(JSON.parse(imported)).toEqual(JSON.parse(spawned.text()))
  }, 30_000)
})
