import { describe, expect, it } from "bun:test"
import * as fs from "fs"
import * as path from "path"

/** Direct `client.kilo.authStatus(` may only remain in the helper fallback. */
describe("kilo-auth-status call-site guard", () => {
  it("all production kilo.authStatus reads converge on fetchKiloAuthStatusPrivateFirst", () => {
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
          if (line.includes(".kilo.authStatus(")) hits.push(`${path.relative(root, full)}:${idx + 1}:${line.trim()}`)
        })
      }
    }
    walk(root)
    expect(hits).toEqual(
      expect.arrayContaining([
        expect.stringContaining("kilo-provider/kilo-auth-status-privatefirst.ts"),
      ]),
    )
    for (const h of hits) {
      expect(h).toContain("kilo-provider/kilo-auth-status-privatefirst.ts")
    }
  })

  it("provider-actions routes the kilo branch through the helper and keeps catch-to-null", () => {
    const actions = fs.readFileSync(path.join(__dirname, "..", "provider-actions.ts"), "utf8")
    expect(actions).toContain("fetchKiloAuthStatusPrivateFirst")
    expect(actions).toContain(".catch(() => null)")
    expect(actions.match(/\.kilo\.authStatus\(/g) ?? []).toEqual([])
    const helper = fs.readFileSync(path.join(__dirname, "kilo-auth-status-privatefirst.ts"), "utf8")
    expect(helper).toContain("client.kilo.authStatus")
  })
})
