import { describe, expect, it } from "bun:test"
import * as fs from "fs"
import * as path from "path"

/** Direct `client.provider.models.discover(` may only remain in the helper SDK fallback. */
describe("models-discover call-site guard", () => {
  it("all production models.discover reads converge on discoverModelsPrivateFirst", () => {
    const root = path.join(__dirname, "..")
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full)
          continue
        }
        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue
        const text = fs.readFileSync(full, "utf8")
        // Fixtures and tests may call the SDK directly; only production matters.
        if (full.includes(`${path.sep}fixtures${path.sep}`)) continue
        if (full.includes("fixture-backend")) continue
        if (full.endsWith(`${path.sep}src${path.sep}extension.ts`)) continue
        const lines = text.split("\n")
        lines.forEach((line, idx) => {
          const trimmed = line.trim()
          // Documentation comments may name the SDK shape; only code matters.
          if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return
          if (line.includes(".models.discover(")) hits.push(`${path.relative(root, full)}:${idx + 1}:${trimmed}`)
        })
      }
    }
    walk(root)
    expect(hits.length).toBeGreaterThan(0)
    for (const h of hits) {
      expect(h).toContain("kilo-provider/models-discover-privatefirst.ts")
    }
  })

  it("handleFetchCustomProviderModels keeps direct paths and posts via the helper", () => {
    const provider = fs.readFileSync(path.join(__dirname, "..", "KiloProvider.ts"), "utf8")
    expect(provider).toContain("discoverModelsPrivateFirst")
    expect(provider).toContain("if (key || headers) {")
    expect(provider).toContain("if (!this.client) {")
    expect(provider).toContain('type: "customProviderModelsFetched"')
    expect(provider).toContain("isProviderModelsAuthError(out.cause)")
    // No direct SDK read remains in the provider; the SDK lives only in the helper fallback.
    expect(provider.match(/\.models\.discover\(/g) ?? []).toEqual([])
  })
})
