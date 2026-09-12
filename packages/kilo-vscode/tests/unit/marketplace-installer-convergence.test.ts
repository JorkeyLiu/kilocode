import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import * as fs from "fs"
import * as fsp from "fs/promises"
import * as os from "os"
import * as path from "path"
import { MarketplaceInstaller } from "../../src/services/marketplace/installer"
import { MarketplacePaths } from "../../src/services/marketplace/paths"
import { MarketplaceService } from "../../src/services/marketplace"
import { createMarketplaceRemover } from "../../src/kilo-provider/remove-config-item"
import { FakeConvergenceAdapter } from "../../src/config/convergence"

let root = ""

class TmpPaths extends MarketplacePaths {
  private base: string
  constructor(base: string) {
    super()
    this.base = base
  }
  override configPath(scope: "project" | "global", workspace?: string): string {
    if (scope === "global") return path.join(this.base, "global", "kilo.json")
    return path.join(workspace!, ".kilo", "kilo.json")
  }
  override agentsDir(scope: "project" | "global", workspace?: string): string {
    if (scope === "global") return path.join(this.base, "global", "agents")
    return path.join(workspace!, ".kilo", "agents")
  }
  override skillsDir(scope: "project" | "global", _workspace?: string): string {
    return path.join(this.base, "skills")
  }
}

function mcp(id = "memory") {
  return {
    type: "mcp" as const,
    id,
    name: "Memory",
    description: "test",
    category: "test",
    url: "https://example.com",
    content: JSON.stringify({ command: "npx", args: ["-y", "srv"], env: {} }),
  }
}

function agent(id = "helper") {
  return {
    type: "agent" as const,
    id,
    name: "Helper",
    description: "test",
    category: "development",
    content: { mode: "all", description: "test", prompt: "Do work." },
  }
}

function read(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8")
  } catch {
    return null
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mkt-conv-"))
  fs.mkdirSync(path.join(root, "global"), { recursive: true })
  fs.mkdirSync(path.join(root, "project", ".kilo"), { recursive: true })
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe("MarketplaceInstaller convergence fence", () => {
  test("installMcp acquires before write and resolves once after", async () => {
    const paths = new TmpPaths(root)
    const fake = new FakeConvergenceAdapter()
    const installer = new MarketplaceInstaller(paths, fake)
    const file = paths.configPath("global")
    const before = read(file)
    let atAcquire: string | null = null
    let atResolve: string | null = null
    const origAcquire = fake.acquire.bind(fake)
    fake.acquire = async (d) => {
      atAcquire = read(file)
      return origAcquire(d)
    }
    const origResolve = fake.resolve.bind(fake)
    fake.resolve = async (id) => {
      const out = await origResolve(id)
      atResolve = read(file)
      return out
    }
    const out = await installer.installMcp(mcp(), { target: "global" }, "global", undefined)
    expect(out.success).toBe(true)
    expect(fake.acquires.length).toBe(1)
    expect(fake.acquires[0]![0]).toMatchObject({ kind: "config", scope: "global" })
    expect(fake.resolves.length).toBe(1)
    expect(atAcquire).toBe(before)
    expect(atResolve).toContain("memory")
    expect(read(file)).toContain("memory")
  })

  test("blocked acquire prevents installMcp write", async () => {
    const paths = new TmpPaths(root)
    const fake = new FakeConvergenceAdapter()
    fake.acquireResult = { ok: false, kind: "unavailable", message: "down" }
    const installer = new MarketplaceInstaller(paths, fake)
    const file = paths.configPath("global")
    fs.writeFileSync(file, JSON.stringify({}), "utf8")
    const before = read(file)
    const out = await installer.installMcp(mcp(), { target: "global" }, "global", undefined)
    expect(out.success).toBe(false)
    expect(read(file)).toBe(before)
    expect(fake.resolves.length).toBe(0)
  })

  test("persistence failure after acquire still resolves once", async () => {
    const paths = new TmpPaths(root)
    const fake = new FakeConvergenceAdapter()
    const installer = new MarketplaceInstaller(paths, fake)
    const file = paths.configPath("global")
    fs.writeFileSync(file, JSON.stringify({}), "utf8")
    const origAcquire = fake.acquire.bind(fake)
    fake.acquire = async (d) => {
      const out = await origAcquire(d)
      fs.rmSync(file, { force: true })
      fs.mkdirSync(file, { recursive: true })
      return out
    }
    await expect(installer.installMcp(mcp(), { target: "global" }, "global", undefined)).rejects.toThrow()
    expect(fake.acquires.length).toBe(1)
    expect(fake.resolves.length).toBe(1)
  })

  test("removeMcp uses fence; absent entry needs no fence", async () => {
    const paths = new TmpPaths(root)
    const fake = new FakeConvergenceAdapter()
    const installer = new MarketplaceInstaller(paths, fake)
    const idle = await installer.removeMcp({ id: "missing" }, "global", undefined)
    expect(idle.success).toBe(true)
    expect(fake.acquires.length).toBe(0)
    expect(fake.resolves.length).toBe(0)
    const seeded = await installer.installMcp(mcp("gone"), { target: "global" }, "global", undefined)
    expect(seeded.success).toBe(true)
    expect(fake.acquires.length).toBe(1)
    expect(fake.resolves.length).toBe(1)
    const removed = await installer.removeMcp({ id: "gone" }, "global", undefined)
    expect(removed.success).toBe(true)
    expect(fake.acquires.length).toBe(2)
    expect(fake.resolves.length).toBe(2)
    expect(read(paths.configPath("global"))).not.toContain("gone")
  })

  test("removeMcp blocked acquire keeps bytes", async () => {
    const paths = new TmpPaths(root)
    const seed = new FakeConvergenceAdapter()
    const installer = new MarketplaceInstaller(paths, seed)
    const ok = await installer.installMcp(mcp("keep"), { target: "global" }, "global", undefined)
    expect(ok.success).toBe(true)
    const before = read(paths.configPath("global"))
    seed.acquireResult = { ok: false, kind: "unavailable", message: "down" }
    const out = await installer.removeMcp({ id: "keep" }, "global", undefined)
    expect(out.success).toBe(false)
    expect(read(paths.configPath("global"))).toBe(before)
    expect(seed.resolves.length).toBe(1)
  })

  test("project scope fences with directory descriptor", async () => {
    const paths = new TmpPaths(root)
    const fake = new FakeConvergenceAdapter()
    const installer = new MarketplaceInstaller(paths, fake)
    const project = path.join(root, "project")
    const out = await installer.installMcp(mcp("proj"), { target: "project" }, "project", project)
    expect(out.success).toBe(true)
    expect(fake.acquires[0]![0]).toMatchObject({ kind: "config", scope: "project", directory: project })
    expect(fake.resolves.length).toBe(1)
  })

  test("installAgent stale config cleanup is fenced", async () => {
    const paths = new TmpPaths(root)
    const fake = new FakeConvergenceAdapter()
    const installer = new MarketplaceInstaller(paths, fake)
    const project = path.join(root, "project")
    fs.writeFileSync(
      paths.configPath("project", project),
      JSON.stringify({ agent: { helper: { stale: true } } }),
      "utf8",
    )
    const out = await installer.installAgent(agent("helper"), "project", project)
    expect(out.success).toBe(true)
    expect(fake.acquires.length).toBe(1)
    expect(fake.resolves.length).toBe(1)
    expect(read(paths.configPath("project", project))).not.toContain("helper")
  })

  test("removeAgent stale config cleanup is fenced and blocked keeps bytes", async () => {
    const paths = new TmpPaths(root)
    const fake = new FakeConvergenceAdapter()
    const installer = new MarketplaceInstaller(paths, fake)
    const file = paths.configPath("global")
    fs.writeFileSync(file, JSON.stringify({ agent: { helper: { stale: true } } }), "utf8")
    const out = await installer.removeAgent({ id: "helper" }, "global", undefined)
    expect(out.success).toBe(true)
    expect(fake.acquires.length).toBe(1)
    expect(fake.resolves.length).toBe(1)
    fs.writeFileSync(file, JSON.stringify({ agent: { helper: { stale: true } } }), "utf8")
    fake.acquireResult = { ok: false, kind: "unavailable", message: "down" }
    const blocked = await installer.removeAgent({ id: "helper" }, "global", undefined)
    expect(blocked.success).toBe(false)
    expect(read(file)).toContain("helper")
  })

  test("generic install/remove dispatch uses the fenced writer", async () => {
    const paths = new TmpPaths(root)
    const fake = new FakeConvergenceAdapter()
    const installer = new MarketplaceInstaller(paths, fake)
    const added = await installer.install(mcp("via"), { target: "global" }, undefined)
    expect(added.success).toBe(true)
    const gone = await installer.remove({ id: "via", type: "mcp" }, "global", undefined)
    expect(gone.success).toBe(true)
    expect(fake.acquires.length).toBe(2)
    expect(fake.resolves.length).toBe(2)
  })

  test("service and remover wrappers forward the adapter", async () => {
    const paths = new TmpPaths(root)
    const fake = new FakeConvergenceAdapter()
    const svc = new MarketplaceService(fake, paths)
    const added = await svc.install(mcp("svc"), { target: "global" }, undefined)
    expect(added.success).toBe(true)
    expect(fake.acquires.length).toBe(1)
    expect(fake.resolves.length).toBe(1)
    const remove = createMarketplaceRemover(fake, paths)
    const gone = await remove({ id: "svc", type: "mcp" }, "global", undefined)
    expect(gone.success).toBe(true)
    expect(fake.acquires.length).toBe(2)
    expect(fake.resolves.length).toBe(2)
    const next = new FakeConvergenceAdapter()
    next.acquireResult = { ok: false, kind: "unavailable", message: "down" }
    svc.setConvergence(next)
    const blocked = await svc.install(mcp("blocked"), { target: "global" }, undefined)
    expect(blocked.success).toBe(false)
    expect(next.resolves.length).toBe(0)
    expect(read(paths.configPath("global"))).not.toContain("blocked")
    await fsp.rm(path.join(root, "global", "kilo.json"), { force: true })
  })

  test("undefined adapter blocks installMcp with no mutation", async () => {
    const paths = new TmpPaths(root)
    const installer = new MarketplaceInstaller(paths)
    const file = paths.configPath("global")
    fs.writeFileSync(file, JSON.stringify({}), "utf8")
    const before = read(file)
    const out = await installer.installMcp(mcp("nowrite"), { target: "global" }, "global", undefined)
    expect(out.success).toBe(false)
    expect(out.success === false && out.error).toContain("convergence adapter unavailable")
    expect(read(file)).toBe(before)
  })

  test("undefined adapter blocks removeMcp and keeps bytes", async () => {
    const paths = new TmpPaths(root)
    const seed = new FakeConvergenceAdapter()
    const seeder = new MarketplaceInstaller(paths, seed)
    const ok = await seeder.installMcp(mcp("keep"), { target: "global" }, "global", undefined)
    expect(ok.success).toBe(true)
    const before = read(paths.configPath("global"))
    expect(before).toContain("keep")
    const bare = new MarketplaceInstaller(paths)
    const out = await bare.removeMcp({ id: "keep" }, "global", undefined)
    expect(out.success).toBe(false)
    expect(out.success === false && out.error).toContain("convergence adapter unavailable")
    expect(read(paths.configPath("global"))).toBe(before)
  })

  test("service and remover without adapter fail closed; clearing adapter regresses to blocked", async () => {
    const paths = new TmpPaths(root)
    const svc = new MarketplaceService(undefined, paths)
    const file = paths.configPath("global")
    fs.writeFileSync(file, JSON.stringify({}), "utf8")
    const before = read(file)
    const blockedInstall = await svc.install(mcp("svc-nowrite"), { target: "global" }, undefined)
    expect(blockedInstall.success).toBe(false)
    expect(read(file)).toBe(before)
    const remove = createMarketplaceRemover(undefined, paths)
    fs.writeFileSync(file, JSON.stringify({ mcp: { keep: { type: "local", command: ["npx"] } } }), "utf8")
    const seeded = read(file)
    const blockedRemove = await remove({ id: "keep", type: "mcp" }, "global", undefined)
    expect(blockedRemove.success).toBe(false)
    expect(read(file)).toBe(seeded)
    const fake = new FakeConvergenceAdapter()
    const installer = new MarketplaceInstaller(paths, fake)
    installer.setConvergence(undefined)
    const regressed = await installer.installMcp(mcp("regressed"), { target: "global" }, "global", undefined)
    expect(regressed.success).toBe(false)
    expect(read(file)).toBe(seeded)
  })
})
