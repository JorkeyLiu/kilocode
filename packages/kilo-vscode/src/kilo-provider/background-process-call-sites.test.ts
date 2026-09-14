import { describe, expect, it } from "bun:test"
import * as fs from "fs"
import * as path from "path"

/** Direct `backgroundProcess.stopSession(` may only remain in the helper SDK fallback. */
describe("background-process call-site guard", () => {
  it("all production stopSession cleanups converge on stopSessionProcessesPrivateFirst", () => {
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
        if (full.includes(`${path.sep}fixtures${path.sep}`)) continue
        if (full.includes("fixture-backend")) continue
        const lines = text.split("\n")
        lines.forEach((line, idx) => {
          const trimmed = line.trim()
          if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return
          if (line.includes("backgroundProcess") && line.includes("stopSession")) {
            hits.push(`${path.relative(root, full)}:${idx + 1}:${trimmed}`)
          }
        })
      }
    }
    walk(root)
    expect(hits.length).toBeGreaterThan(0)
    for (const h of hits) {
      expect(h).toContain("kilo-provider/background-process-stop-session-privatefirst.ts")
    }
  })

  it("all production stopSessionProcesses callers pass the private connection", () => {
    const provider = fs.readFileSync(path.join(__dirname, "..", "KiloProvider.ts"), "utf8")
    expect(provider).toContain(
      "stopSessionProcesses(this.client, sid, this.getSessionDirectory(sid, session), this.connectionService)",
    )
    expect(provider).toContain("stopSessionProcesses(this.client, sessionID, workspaceDir, this.connectionService)")
    const manager = fs.readFileSync(path.join(__dirname, "..", "agent-manager", "AgentManagerProvider.ts"), "utf8")
    expect(manager).toContain(
      "stopSessionProcesses(this.connectionService.getClient(), sessionId, root, this.connectionService)",
    )
    // No bare three-arg production call remains.
    expect(
      provider.match(/stopSessionProcesses\(this\.client, sid, this\.getSessionDirectory\(sid, session\)\)/g) ?? [],
    ).toEqual([])
    expect(provider.match(/stopSessionProcesses\(this\.client, sessionID, workspaceDir\)/g) ?? []).toEqual([])
  })
})
