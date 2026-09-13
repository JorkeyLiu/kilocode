import { describe, expect, it, afterEach } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { KiloConnectionService } from "../../src/services/cli-backend/connection-service"
import { CanonicalConfigService } from "../../src/config/service"
import { Roots } from "../../src/config/paths"
import { createMemorySecretAdapter } from "../../src/config/secret-adapter"
import { createMemoryStateAdapter } from "../../src/config/state-adapter"

const { KiloProvider } = await import("../../src/KiloProvider")

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function makeCanonical(): { svc: CanonicalConfigService; project: string; global: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-asset-refresh-"))
  dirs.push(root)
  const global = path.join(root, "global")
  const project = path.join(root, "project")
  fs.mkdirSync(global, { recursive: true })
  fs.mkdirSync(path.join(project, ".kilo"), { recursive: true })
  fs.writeFileSync(path.join(global, "kilo.jsonc"), JSON.stringify({ $schema: "https://app.kilo.ai/config.json" }))
  fs.writeFileSync(path.join(project, ".kilo", "kilo.jsonc"), JSON.stringify({ $schema: "https://app.kilo.ai/config.json" }))
  const secrets = createMemorySecretAdapter()
  const svc = new CanonicalConfigService({ secrets } as never, {
    roots: new Roots(project, global),
    secretAdapter: secrets,
    globalState: createMemoryStateAdapter(),
    workspaceState: createMemoryStateAdapter(),
  })
  return { svc, project, global }
}

describe("canonical external asset refresh", () => {
  it("external successful materialization refreshes private-first skills and commands", async () => {
    const { svc } = makeCanonical()
    await svc.initialize()
    const conn = new KiloConnectionService({} as never)
    const provider = new KiloProvider({} as never, conn as never, undefined, { canonicalConfig: svc } as never)
    const internal = provider as unknown as {
      onCanonicalChange: (e: { source: string; hasErrors: boolean; errors: readonly unknown[]; stamp: unknown; snapshot: unknown }) => void
      fetchAndSendSkills: () => Promise<void>
      fetchAndSendCommands: () => Promise<void>
      isWebviewReady: boolean
      canonicalReady: boolean
    }
    let skills = 0
    let commands = 0
    internal.fetchAndSendSkills = async () => {
      skills += 1
    }
    internal.fetchAndSendCommands = async () => {
      commands += 1
    }
    internal.isWebviewReady = true
    ;(internal as unknown as { _canonicalReady: boolean })._canonicalReady = true
    internal.onCanonicalChange({ source: "external", hasErrors: false, errors: [], stamp: svc.stamp, snapshot: svc.snapshot } as never)
    await new Promise((r) => setTimeout(r, 20))
    expect(skills).toBe(1)
    expect(commands).toBe(1)
    internal.onCanonicalChange({ source: "external", hasErrors: true, errors: [], stamp: svc.stamp, snapshot: svc.snapshot } as never)
    internal.onCanonicalChange({ source: "gui", hasErrors: false, errors: [], stamp: svc.stamp, snapshot: svc.snapshot } as never)
    await new Promise((r) => setTimeout(r, 20))
    expect(skills).toBe(1)
    expect(commands).toBe(1)
    provider.dispose()
    svc.dispose()
  })
})
