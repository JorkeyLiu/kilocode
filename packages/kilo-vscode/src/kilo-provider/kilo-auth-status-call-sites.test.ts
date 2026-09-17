import { describe, expect, it } from "bun:test"
import * as fs from "fs"
import * as path from "path"

/** No production `client.kilo.authStatus(` remains in the shared auth read path. */
describe("kilo-auth-status call-site guard", () => {
  it("no production kilo.authStatus reads remain; the shared helper is private-authority", () => {
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
    expect(hits).toEqual([])
  })

  it("provider-actions routes the kilo branch through the helper and keeps catch-to-null", () => {
    const actions = fs.readFileSync(path.join(__dirname, "..", "provider-actions.ts"), "utf8")
    expect(actions).toContain("fetchKiloAuthStatusPrivate")
    expect(actions).not.toContain("fetchKiloAuthStatusPrivateFirst")
    expect(actions).toContain(".catch(() => null)")
    expect(actions.match(/\.kilo\.authStatus\(/g) ?? []).toEqual([])
    const helper = fs.readFileSync(path.join(__dirname, "kilo-auth-status-private.ts"), "utf8")
    expect(helper).toContain("fetchKiloAuthStatusPrivate")
    expect(helper).not.toContain("fetchKiloAuthStatusPrivateFirst")
    expect(helper).not.toContain("client.kilo.authStatus")
    expect(helper.match(/\.kilo\.authStatus\(/g) ?? []).toEqual([])
  })
})
