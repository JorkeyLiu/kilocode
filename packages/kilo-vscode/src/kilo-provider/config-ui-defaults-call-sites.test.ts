import { describe, expect, it } from "bun:test"
import * as fs from "fs"
import * as path from "path"

const HELPER = `shared${path.sep}config-ui-defaults-privatefirst.ts`

/** Direct `client.config.get(` may only remain in the helper SDK fallback. */
describe("config-ui-defaults call-site guard", () => {
  it("all production config.get reads converge on fetchConfigUiDefaultsPrivateFirst", () => {
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
          if (line.includes(".config.get(")) hits.push(`${path.relative(root, full)}:${idx + 1}:${trimmed}`)
        })
      }
    }
    walk(root)
    expect(hits.length).toBeGreaterThan(0)
    for (const h of hits) {
      expect(h).toContain(HELPER)
    }
  })

  it("work-style apply reads through the helper and keeps the global.config.update owner", () => {
    const handler = fs.readFileSync(path.join(__dirname, "work-style-apply-handler.ts"), "utf8")
    expect(handler).toContain("fetchConfigUiDefaultsPrivateFirst")
    expect(handler).toContain("toWorkStyleConfig")
    expect(handler).toContain("requireUiDefaults")
    expect(handler).toContain("client.global.config.update")
    expect(handler.match(/\.config\.get\(/g) ?? []).toEqual([])
  })

  it("sandbox readers go through the helper with the connection service", () => {
    const session = fs.readFileSync(path.join(__dirname, "..", "shared", "sandbox-session.ts"), "utf8")
    expect(session).toContain("fetchConfigUiDefaultsPrivateFirst")
    expect(session).toContain("requireUiDefaults")
    expect(session.match(/\.config\.get\(/g) ?? []).toEqual([])
    const provider = fs.readFileSync(path.join(__dirname, "..", "KiloProvider.ts"), "utf8")
    expect(provider).toContain("sandboxSessionMetadata(this.connectionService.sandboxPreference, this.client!, workspaceDir, this.connectionService)")
    expect(provider).toContain("sandboxDefault(this.connectionService.sandboxPreference, client, directory, this.connectionService)")
    const manager = fs.readFileSync(
      path.join(__dirname, "..", "agent-manager", "AgentManagerProvider.ts"),
      "utf8",
    )
    expect(manager).toContain("sandboxSessionMetadata(this.connectionService.sandboxPreference, client, root, this.connectionService)")
  })
})
