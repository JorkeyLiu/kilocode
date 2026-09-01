import { describe, expect, test } from "bun:test"
import { build } from "esbuild"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { isDirectExecution } from "../../script/e2e-direct"
import { parseScenarios, needsCanonicalStorage } from "../../script/e2e-probe"

describe("probe scenario parsing (real-lifecycle reachable)", () => {
  test("parses real-lifecycle", () => {
    expect(parseScenarios("real-lifecycle")).toEqual(new Set(["real-lifecycle"]))
  })
  test("rejects unknown scenario before VS Code launch", () => {
    expect(() => parseScenarios("unknown-scenario")).toThrow(/unknown KILO_E2E_SCENARIO/)
  })
  test("needsCanonicalStorage covers real-lifecycle", () => {
    expect(needsCanonicalStorage("real-lifecycle")).toBeTrue()
    expect(needsCanonicalStorage("real-restart")).toBeTrue()
    expect(needsCanonicalStorage("real-session")).toBeTrue()
    expect(needsCanonicalStorage("tab-close")).toBeFalse()
  })
  test("needsCanonicalStorage for all includes r9", () => {
    expect(needsCanonicalStorage("r9-observation")).toBeTrue()
  })
  test("isDirectExecution remains import-safe for unit tests (not direct)", () => {
    // When imported via bun:test, argv[1] is the test runner, not e2e-probe
    expect(isDirectExecution()).toBeFalse()
  })
  test("isDirectExecution remains false even when argv looks like e2e-probe (import-safe, bundle flag absent)", () => {
    const orig = process.argv[1]
    try {
      process.argv[1] = "/tmp/not-e2e-probe/other.ts"
      expect(isDirectExecution()).toBeFalse()
      process.argv[1] = "/tmp/e2e-probe.ts"
      // Source import never has __KILO_E2E_BUNDLE__, so it stays false even when argv matches.
      // This proves the gate does not rely on brittle basename/substring.
      expect(isDirectExecution()).toBeFalse()
    } finally {
      process.argv[1] = orig
    }
  })
})

describe("probe bundle direct contract (real esbuild CJS, no VS Code)", () => {
  test("launcher-equivalent CJS bundle is direct true via Node and imported false, without define false", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kilo-probe-bundle-"))
    try {
      const helper = resolve(join(import.meta.dirname, "../../script/e2e-direct.ts"))
      const fixture = join(dir, "fixture.ts")
      writeFileSync(
        fixture,
        [
          `import { isDirectExecution } from ${JSON.stringify(helper)}`,
          'if (isDirectExecution()) console.log("DIRECT:true"); else console.log("DIRECT:false")',
          "",
        ].join("\n"),
      )
      const out = join(dir, "out.cjs")
      await build({
        entryPoints: [fixture],
        bundle: true,
        platform: "node",
        format: "cjs",
        target: "node20",
        define: { __KILO_E2E_BUNDLE__: "true" },
        outfile: out,
        logLevel: "silent",
      })
      const direct = spawnSync(process.execPath, [out], { encoding: "utf8" })
      expect(direct.status).toBe(0)
      expect(direct.stdout).toContain("DIRECT:true")

      // Imported bundle should report false (not direct) — bundle exports helper via re-export.
      const importFixture = join(dir, "import-fixture.ts")
      writeFileSync(importFixture, `export { isDirectExecution } from ${JSON.stringify(helper)}`)
      const outImport = join(dir, "out-import.cjs")
      await build({
        entryPoints: [importFixture],
        bundle: true,
        platform: "node",
        format: "cjs",
        target: "node20",
        define: { __KILO_E2E_BUNDLE__: "true" },
        outfile: outImport,
        logLevel: "silent",
      })
      const importer2 = join(dir, "importer2.cjs")
      writeFileSync(importer2, `const m=require(${JSON.stringify(outImport)}); console.log("IMPORTED:"+m.isDirectExecution())`)
      const imported = spawnSync(process.execPath, [importer2], { encoding: "utf8" })
      expect(imported.status).toBe(0)
      expect(imported.stdout).toContain("IMPORTED:false")

      const outNoDefine = join(dir, "out2.cjs")
      await build({
        entryPoints: [fixture],
        bundle: true,
        platform: "node",
        format: "cjs",
        target: "node20",
        outfile: outNoDefine,
        logLevel: "silent",
      })
      const directNoDefine = spawnSync(process.execPath, [outNoDefine], { encoding: "utf8" })
      expect(directNoDefine.status).toBe(0)
      expect(directNoDefine.stdout).toContain("DIRECT:false")

      expect(isDirectExecution()).toBeFalse()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
