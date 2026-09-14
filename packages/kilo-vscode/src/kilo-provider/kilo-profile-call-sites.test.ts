import { describe, expect, it } from "bun:test"
import * as fs from "fs"
import * as path from "path"

/** Direct `client.kilo.profile(` may only remain in the helper fallback. */
describe("kilo-profile call-site guard", () => {
  it("all production kilo.profile reads converge on fetchKiloProfilePrivateFirst", () => {
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
        const lines = text.split("\n")
        lines.forEach((line, idx) => {
          if (line.includes(".kilo.profile(")) hits.push(`${path.relative(root, full)}:${idx + 1}:${line.trim()}`)
        })
      }
    }
    walk(root)
    expect(hits).toEqual(
      expect.arrayContaining([
        expect.stringContaining("kilo-provider/kilo-profile-privatefirst.ts"),
      ]),
    )
    for (const h of hits) {
      expect(h).toContain("kilo-provider/kilo-profile-privatefirst.ts")
    }
  })

  it("the VS Code host keeps its profile readers on the helper with no dormant auth module", () => {
    const provider = fs.readFileSync(path.join(__dirname, "..", "KiloProvider.ts"), "utf8")
    expect(provider).toContain("fetchKiloProfilePrivateFirst")
    expect(provider.match(/\.kilo\.profile\(/g) ?? []).toEqual([])
    expect(fs.existsSync(path.join(__dirname, "handlers", "auth.ts"))).toBe(false)
    expect(provider).toContain('type: "profileData"')
  })
})
