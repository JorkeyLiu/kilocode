import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, rmSync, mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { writeRealRestartSeed, realProjectSeed } from "../../script/e2e-restart-seed"
import { validateConfig } from "../../src/config/validate"
import { isValidCanonicalProviderEntry } from "../../src/config/types"

describe("isolated project seed strict closure", () => {
  test("project canonical remains strict closed shape with no global provider file or legacy kilo.json", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "cfg-merge-"))
    const workspace = join(scratch, "ws")
    const port = 18765
    const pluginUrl = "file:///tmp/tool.ts"
    const orig = process.env.KILO_E2E_FIXTURE
    process.env.KILO_E2E_FIXTURE = "1"
    try {
      const seed = writeRealRestartSeed(workspace, port, pluginUrl, scratch)
      const projectFile = join(workspace, ".kilo", "kilo.jsonc")
      const legacyFile = join(workspace, ".kilo", "kilo.json")
      const globalFile = join(scratch, "xdg-config", "kilo", "kilo.jsonc")
      expect(existsSync(projectFile)).toBeTrue()
      expect(existsSync(legacyFile)).toBeFalse()
      // No global provider options file is written (CLI seam supplies it via env)
      expect(existsSync(globalFile)).toBeFalse()
      const projectRaw = readFileSync(projectFile, "utf8")
      const projectJson = JSON.parse(projectRaw)

      // Project must be canonical closed shape: no npm/options/apiKey, only endpoint/protocol/credential/models
      expect(projectJson.provider["e2e-local"].credential).toBe("secret:kilo.credentials.project.provider.e2e-local")
      expect(projectJson.provider["e2e-local"].endpoint).toBe(`http://127.0.0.1:${port}/v1`)
      expect(projectJson.provider["e2e-local"].npm).toBeUndefined()
      expect(projectJson.provider["e2e-local"].options).toBeUndefined()
      expect(JSON.stringify(projectJson)).not.toContain("e2e-fixture-key")
      expect(JSON.stringify(projectJson)).not.toContain("apiKey")

      // Project canonical validation must remain valid and secret-ref invariant intact (strict, no fixture exception)
      const projValidation = validateConfig(projectRaw, "project", projectFile)
      expect(projValidation.valid).toBeTrue()
      expect(isValidCanonicalProviderEntry(projectJson.provider["e2e-local"], "e2e-local")).toBeTrue()

      // Ensure seed helper's configFile now points to project canonical file (not global)
      expect(seed.configFile).toBe(projectFile)
      expect(seed.canonicalFile).toBe(projectFile)
    } finally {
      if (orig !== undefined) process.env.KILO_E2E_FIXTURE = orig
      else delete process.env.KILO_E2E_FIXTURE
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  test("writeRealRestartSeed requires absolute scratch", () => {
    const workspace = join(tmpdir(), "ws2")
    expect(() => writeRealRestartSeed(workspace, 1234, "file:///tmp/tool.ts", "" as unknown as string)).toThrow(
      /absolute scratch/,
    )
    expect(() =>
      writeRealRestartSeed(workspace, 1234, "file:///tmp/tool.ts", "relative/path" as unknown as string),
    ).toThrow(/absolute scratch/)
  })

  test("realProjectSeed is canonical closed shape", () => {
    const seed = realProjectSeed(9999)
    expect(seed.model).toBe("e2e-local/e2e-model")
    const prov = (seed.provider as Record<string, unknown>)["e2e-local"] as Record<string, unknown>
    expect(prov.endpoint).toBe("http://127.0.0.1:9999/v1")
    expect(prov.protocol).toBe("openai/completions")
    expect(prov.credential).toBe("secret:kilo.credentials.project.provider.e2e-local")
    expect(prov.npm).toBeUndefined()
    expect(prov.options).toBeUndefined()
    expect(isValidCanonicalProviderEntry(prov, "e2e-local")).toBeTrue()
  })
})
