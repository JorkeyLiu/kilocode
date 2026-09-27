import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { Roots } from "../../src/config/paths"
import { createMemorySecretAdapter } from "../../src/config/secret-adapter"
import { resetVersion } from "../../src/config/materialize"
import {
  createMemoryStateAdapter,
  createMemoryWatcherAdapter,
  createMemoryEmitterFactory,
} from "../../src/config/state-adapter"
import { CanonicalConfigService } from "../../src/config/service"
import { FakeConvergenceAdapter } from "../../src/config/convergence"
import { buildLifecycleDescriptors } from "../../src/config/lifecycle-observe"

let tmpDir: string
let globalRoot: string
let projectRoot: string

beforeEach(() => {
  resetVersion()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-"))
  globalRoot = path.join(tmpDir, "global")
  projectRoot = path.join(tmpDir, "project")
  fs.mkdirSync(globalRoot, { recursive: true })
  fs.mkdirSync(path.join(projectRoot, ".kilo"), { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const waitFor = async (fn: () => boolean, message: string): Promise<void> => {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > 5000) throw new Error(message)
    await new Promise((r) => setTimeout(r, 20))
  }
}

function writeGlobal(value: Record<string, unknown>): void {
  fs.writeFileSync(path.join(globalRoot, "kilo.jsonc"), JSON.stringify(value), "utf-8")
}

function writeProject(value: Record<string, unknown>): void {
  fs.writeFileSync(path.join(projectRoot, ".kilo", "kilo.jsonc"), JSON.stringify(value), "utf-8")
}

function writeAsset(dir: string, id: string, scope: "global" | "project"): void {
  const root = scope === "global" ? path.join(globalRoot, dir) : path.join(projectRoot, ".kilo", dir)
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, `${id}.md`), `---\nname: ${id}\n---\nbody`, "utf-8")
}

function writeSkill(scope: "global" | "project", name: string, valid = true): string {
  const root = scope === "global" ? path.join(globalRoot, "skill") : path.join(projectRoot, ".kilo", "skill")
  const file = path.join(root, name, "SKILL.md")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const body = valid
    ? `---\nname: ${name}\ndescription: ${name} fixture.\n---\nbody`
    : `---\nname: ${name}\n: bad: [\n---\nbody`
  fs.writeFileSync(file, body, "utf-8")
  return file
}

function makeSvc(fake: FakeConvergenceAdapter, ready: () => boolean) {
  const secrets = createMemorySecretAdapter()
  return new CanonicalConfigService({ secrets, subscriptions: { push: () => {} } } as never, {
    roots: new Roots(projectRoot, globalRoot),
    secretAdapter: secrets,
    globalState: createMemoryStateAdapter(),
    workspaceState: createMemoryStateAdapter(),
    watcherAdapter: createMemoryWatcherAdapter(),
    emitterFactory: createMemoryEmitterFactory(),
    convergence: fake as never,
    isPrivateReady: ready,
  })
}

describe("lifecycle rebuild observe", () => {
  it("init-first FD-later: no send until ready, then once with validated descs, repeat does not re-cold", async () => {
    writeGlobal({ $schema: "https://app.kilo.ai/config.json", model: "test/a" })
    writeProject({ $schema: "https://app.kilo.ai/config.json" })
    writeAsset("agent", "coder", "global")
    writeAsset("command", "run", "project")
    writeAsset("tool", "t1", "global")
    writeSkill("global", "s1")
    let ready = false
    const fake = new FakeConvergenceAdapter()
    const svc = makeSvc(fake, () => ready)
    await svc.initialize()
    expect(fake.observes.length).toBe(0)
    ready = true
    svc.notifyPrivateReady()
    await waitFor(() => fake.observes.length >= 1, "lifecycle observe never sent")
    const flat = fake.observes.flat() as Array<{ kind: string; scope: string; asset?: string; id?: string }>
    expect(flat.some((d) => d.kind === "config" && d.scope === "global")).toBe(true)
    expect(flat.some((d) => d.kind === "config" && d.scope === "project")).toBe(true)
    expect(flat.some((d) => d.asset === "agent" && d.id === "coder")).toBe(true)
    expect(flat.some((d) => d.asset === "command" && d.id === "run")).toBe(true)
    expect(flat.some((d) => d.asset === "tool" && d.id === "t1")).toBe(true)
    expect(flat.some((d) => d.asset === "skill" && d.id === "s1")).toBe(true)
    for (const batch of fake.observes) expect(batch.length).toBeLessThanOrEqual(8)
    const settled = fake.observes.length
    svc.notifyPrivateReady()
    svc.reconcileExternalObserve()
    await new Promise((r) => setTimeout(r, 80))
    expect(fake.observes.length).toBe(settled)
    svc.dispose()
  })

  it("FD-first init-later: init end fires once without explicit ready signal", async () => {
    writeGlobal({ $schema: "https://app.kilo.ai/config.json" })
    const fake = new FakeConvergenceAdapter()
    const svc = makeSvc(fake, () => true)
    await svc.initialize()
    await waitFor(() => fake.observes.length >= 1, "FD-first lifecycle never sent")
    const settled = fake.observes.length
    svc.notifyPrivateReady()
    await new Promise((r) => setTimeout(r, 60))
    expect(fake.observes.length).toBe(settled)
    svc.dispose()
  })

  it("empty/invalid/no-project never borrows default config", async () => {
    const fake = new FakeConvergenceAdapter()
    const svc = makeSvc(fake, () => true)
    await svc.initialize()
    await new Promise((r) => setTimeout(r, 80))
    expect(fake.observes.length).toBe(0)
    svc.dispose()

    writeGlobal({ $schema: "https://app.kilo.ai/config.json", unknown_key: "bad" })
    const fake2 = new FakeConvergenceAdapter()
    const svc2 = makeSvc(fake2, () => true)
    await svc2.initialize()
    svc2.notifyPrivateReady()
    await new Promise((r) => setTimeout(r, 80))
    expect(fake2.observes.length).toBe(0)
    svc2.dispose()
  })

  it("no-project emits global only", async () => {
    writeGlobal({ $schema: "https://app.kilo.ai/config.json" })
    writeAsset("agent", "g1", "global")
    const secrets = createMemorySecretAdapter()
    const fake = new FakeConvergenceAdapter()
    const svc = new CanonicalConfigService({ secrets, subscriptions: { push: () => {} } } as never, {
      roots: new Roots(undefined, globalRoot),
      secretAdapter: secrets,
      globalState: createMemoryStateAdapter(),
      workspaceState: createMemoryStateAdapter(),
      watcherAdapter: createMemoryWatcherAdapter(),
      emitterFactory: createMemoryEmitterFactory(),
      convergence: fake as never,
      isPrivateReady: () => true,
    })
    await svc.initialize()
    await waitFor(() => fake.observes.length >= 1, "global-only lifecycle never sent")
    const flat = fake.observes.flat() as Array<{ scope: string }>
    expect(flat.length).toBeGreaterThan(0)
    expect(flat.every((d) => d.scope === "global")).toBe(true)
    svc.dispose()
  })

  it("invalid skill and error assets are skipped; duplicate global/project emits both scopes", async () => {
    writeGlobal({ $schema: "https://app.kilo.ai/config.json" })
    writeAsset("agent", "ok", "global")
    writeAsset("agent", "shared", "global")
    writeAsset("agent", "shared", "project")
    writeSkill("global", "good")
    writeSkill("global", "bad", false)
    const fake = new FakeConvergenceAdapter()
    const svc = makeSvc(fake, () => true)
    await svc.initialize()
    await waitFor(() => fake.observes.length >= 1, "lifecycle never sent")
    await new Promise((r) => setTimeout(r, 80))
    const flat = fake.observes.flat() as Array<{ asset?: string; id?: string; kind: string; scope: string }>
    expect(flat.some((d) => d.id === "ok")).toBe(true)
    // Materialization retains both duplicate entries + conflict diagnostics;
    // backend resolves per-file deterministic precedence, so bootstrap must
    // emit both (filtering both would converge wrong).
    expect(flat.filter((d) => d.id === "shared").length).toBe(2)
    expect(flat.some((d) => d.id === "shared" && d.scope === "global")).toBe(true)
    expect(flat.some((d) => d.id === "shared" && d.scope === "project")).toBe(true)
    expect(flat.some((d) => d.id === "good")).toBe(true)
    expect(flat.some((d) => d.id === "bad")).toBe(false)
    svc.dispose()
  })

  it("burst >8 drains in <=8 batches", async () => {
    writeGlobal({ $schema: "https://app.kilo.ai/config.json" })
    for (let i = 0; i < 10; i++) writeAsset("agent", `a${i}`, "global")
    const fake = new FakeConvergenceAdapter()
    const svc = makeSvc(fake, () => true)
    await svc.initialize()
    await waitFor(() => fake.observes.flat().length >= 11, "burst never drained")
    for (const batch of fake.observes) expect(batch.length).toBeLessThanOrEqual(8)
    svc.dispose()
  })

  it("pure builder: not ready and empty return []", async () => {
    const secrets = createMemorySecretAdapter()
    const svc = makeSvc(new FakeConvergenceAdapter(), () => true)
    await svc.initialize()
    const descs = buildLifecycleDescriptors({
      paths: svc.canonicalPaths,
      hasProject: svc.hasProject,
      projectRoot: svc.canonicalPaths.projectRoot,
      materializationReady: false,
      globalHash: "h",
      projectHash: null,
      scan: svc.assetScan,
      skills: new Map(),
    })
    expect(descs).toEqual([])
    svc.dispose()
  })

  it("empty does not consume lifecycle intent: later valid still fires once, no re-cold", async () => {
    const fake = new FakeConvergenceAdapter()
    const svc = makeSvc(fake, () => true)
    await svc.initialize()
    await new Promise((r) => setTimeout(r, 60))
    expect(fake.observes.length).toBe(0)
    svc.notifyPrivateReady()
    await new Promise((r) => setTimeout(r, 60))
    expect(fake.observes.length).toBe(0)
    const written = await svc.writeConfig(
      "global",
      { $schema: "https://app.kilo.ai/config.json", model: "test/a" },
      "absent",
    )
    expect(written.ok).toBe(true)
    await new Promise((r) => setTimeout(r, 60))
    const before = fake.observes.length
    svc.notifyPrivateReady()
    await waitFor(() => fake.observes.length > before, "retained lifecycle never fired after correction")
    const settled = fake.observes.length
    svc.notifyPrivateReady()
    svc.reconcileExternalObserve()
    await new Promise((r) => setTimeout(r, 80))
    expect(fake.observes.length).toBe(settled)
    svc.dispose()
  })

  it("init gap asset written at watcher install is covered by post-watcher rescan", async () => {
    writeGlobal({ $schema: "https://app.kilo.ai/config.json" })
    const fake = new FakeConvergenceAdapter()
    const svc = makeSvc(fake, () => true)
    const origStart = (svc as unknown as { startWatchers: () => void }).startWatchers.bind(svc)
    ;(svc as unknown as { startWatchers: () => void }).startWatchers = () => {
      writeAsset("agent", "gap", "global")
      origStart()
    }
    await svc.initialize()
    await waitFor(() => fake.observes.length >= 1, "gap lifecycle never sent")
    await new Promise((r) => setTimeout(r, 80))
    const flat = fake.observes.flat() as Array<{ asset?: string; id?: string }>
    expect(flat.some((d) => d.id === "gap")).toBe(true)
    svc.dispose()
  })
})
