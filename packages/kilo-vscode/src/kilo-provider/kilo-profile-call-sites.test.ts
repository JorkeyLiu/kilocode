import { describe, expect, it } from "bun:test"
import * as fs from "fs"
import * as path from "path"

/** No production `client.kilo.profile(` reads remain on the custom-only host. */
describe("kilo-profile call-site guard", () => {
  it("no production kilo.profile reads or private profile carrier remain", () => {
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
    expect(hits).toEqual([])
    // Dead host-side carrier stays deleted: no private helper, contract, or
    // connection modules.
    expect(fs.existsSync(path.join(__dirname, "kilo-profile-privatefirst.ts"))).toBe(false)
    expect(
      fs.existsSync(
        path.join(__dirname, "..", "services", "cli-backend", "serve-private-kilo-profile-contract.ts"),
      ),
    ).toBe(false)
    expect(
      fs.existsSync(
        path.join(__dirname, "..", "services", "cli-backend", "serve-private-kilo-profile-connection.ts"),
      ),
    ).toBe(false)
  })

  it("the VS Code host performs no proactive kilo.profile reads; broadcast + local refresh paths intact", () => {
    const provider = fs.readFileSync(path.join(__dirname, "..", "KiloProvider.ts"), "utf8")
    expect(provider).not.toContain("fetchKiloProfilePrivateFirst")
    expect(provider).not.toContain("syncProfileBestEffort")
    expect(provider.match(/\.kilo\.profile\(/g) ?? []).toEqual([])
    expect(fs.existsSync(path.join(__dirname, "handlers", "auth.ts"))).toBe(false)
    // Scope locks: the onProfileChanged broadcast forward and the local
    // refreshProfile null answer stay, so profileData routing remains.
    expect(provider).toContain("onProfileChanged")
    expect(provider).toContain('type: "profileData"')
  })
})
