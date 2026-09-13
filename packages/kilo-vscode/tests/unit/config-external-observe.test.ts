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
import { isValidAssetId } from "../../src/config/service-views"
import { ExternalObserveCoalescer } from "../../src/config/external-observe"
import { FakeConvergenceAdapter, PrivateConvergenceAdapter, parseObserveResponse } from "../../src/config/convergence"

let tmpDir: string
let globalRoot: string
let projectRoot: string
let secrets: ReturnType<typeof createMemorySecretAdapter>
let globalState: ReturnType<typeof createMemoryStateAdapter>
let workspaceState: ReturnType<typeof createMemoryStateAdapter>
let watcherAdapter: ReturnType<typeof createMemoryWatcherAdapter>
let emitterFactory: ReturnType<typeof createMemoryEmitterFactory>

beforeEach(() => {
  resetVersion()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ext-observe-"))
  globalRoot = path.join(tmpDir, "global")
  projectRoot = path.join(tmpDir, "project")
  fs.mkdirSync(globalRoot, { recursive: true })
  fs.mkdirSync(path.join(projectRoot, ".kilo"), { recursive: true })
  secrets = createMemorySecretAdapter()
  globalState = createMemoryStateAdapter()
  workspaceState = createMemoryStateAdapter()
  watcherAdapter = createMemoryWatcherAdapter()
  emitterFactory = createMemoryEmitterFactory()
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeGlobalConfig(value: Record<string, unknown>): void {
  fs.writeFileSync(path.join(globalRoot, "kilo.jsonc"), JSON.stringify(value, null, 2), "utf-8")
}

function writeProjectConfig(value: Record<string, unknown>): void {
  fs.writeFileSync(path.join(projectRoot, ".kilo", "kilo.jsonc"), JSON.stringify(value, null, 2), "utf-8")
}

const waitFor = async (fn: () => boolean, message: string): Promise<void> => {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > 3000) throw new Error(message)
    await new Promise((r) => setTimeout(r, 20))
  }
}

const makeDeps = (observe: (d: readonly never[]) => Promise<never>, onPending: (m: string) => void) => ({
  isDisposed: () => false,
  hasProject: true,
  projectRoot,
  observe: observe as never,
  onPending,
})

function assetWatcher(scope: "global" | "project", asset: string) {
  const dir =
    scope === "global" ? path.join(globalRoot, asset) : path.join(projectRoot, ".kilo", asset)
  const idx = watcherAdapter.watchers_.findIndex((w) => w.dir === dir)
  if (idx < 0) throw new Error(`missing watcher ${scope}/${asset} (dir ${dir})`)
  return watcherAdapter.watchers_[idx]
}

function skillWatcherFor(filePath: string) {
  const matches = watcherAdapter.watchers_.filter((w) => filePath === w.dir || filePath.startsWith(w.dir + path.sep))
  if (matches.length === 0) throw new Error(`missing skill watcher for ${filePath}`)
  matches.sort((a, b) => b.dir.length - a.dir.length)
  return matches[0]
}

function writeSkillMd(file: string, name: string, body = "body"): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${name} fixture.\n---\n${body}`, "utf-8")
}

function makeSvc(fake: FakeConvergenceAdapter) {
  return new CanonicalConfigService({ secrets, subscriptions: { push: () => {} } } as never, {
    roots: new Roots(projectRoot, globalRoot),
    secretAdapter: secrets,
    globalState,
    workspaceState,
    watcherAdapter,
    emitterFactory,
    convergence: fake as never,
  })
}

describe("external canonical config observe hints", () => {
  it("external config edit emits one observe after materialization; repeated same-state stays cold", async () => {
    writeGlobalConfig({ $schema: "https://app.kilo.ai/config.json" })
    writeProjectConfig({ $schema: "https://app.kilo.ai/config.json" })
    const fake = new FakeConvergenceAdapter()
    fake.observeResult = { status: "converged", outcome: "cold" }
    const svc = makeSvc(fake)
    await svc.initialize()
    expect(fake.observes.length).toBe(0)
    writeGlobalConfig({ $schema: "https://app.kilo.ai/config.json", model: "test/new" })
    watcherAdapter.watchers_[0].onChange()
    await waitFor(() => fake.observes.length === 1, "observe never sent")
    expect(fake.observes[0]).toEqual([{ kind: "config", scope: "global" }])
    svc.dispose()
  })

  it("trailing-edge: V1 inflight + V2 dirty yields exactly one follow-up", async () => {
    const seen: string[][] = []
    let releaseFirst!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let calls = 0
    const observe = async (d: readonly { kind: string }[]): Promise<{ status: string; outcome?: string }> => {
      calls += 1
      seen.push(d.map((x) => x.kind))
      if (calls === 1) await gate
      return { status: "converged", outcome: "cold" }
    }
    const coalescer = new ExternalObserveCoalescer()
    const pending: string[] = []
    const depsFor = () => makeDeps(observe as never, (m) => pending.push(m))
    coalescer.notify("global", depsFor() as never)
    coalescer.notify("global", depsFor() as never)
    coalescer.notify("global", depsFor() as never)
    await new Promise((r) => setTimeout(r, 30))
    expect(calls).toBe(1)
    releaseFirst()
    await waitFor(() => calls === 2, "dirty follow-up never ran")
    await new Promise((r) => setTimeout(r, 40))
    expect(calls).toBe(2)
    expect(seen.every((k) => k[0] === "config")).toBe(true)
    expect(pending.length).toBe(0)
  })

  it("own config write emits no observe; external asset create emits asset observe", async () => {
    writeGlobalConfig({ $schema: "https://app.kilo.ai/config.json" })
    writeProjectConfig({ $schema: "https://app.kilo.ai/config.json" })
    const fake = new FakeConvergenceAdapter()
    const svc = makeSvc(fake)
    await svc.initialize()
    const out = await (svc as unknown as { writeConfigScopes: (a: unknown) => Promise<unknown> }).writeConfigScopes?.({
      global: { patch: { model: "test/own" }, expectedHash: (svc as unknown as { globalHash: string }).globalHash ?? "" },
    } as never).catch(() => null)
    void out
    const before = fake.observes.length
    watcherAdapter.watchers_[0].onChange()
    await new Promise((r) => setTimeout(r, 120))
    expect(fake.observes.length).toBe(before)
    const dir = path.join(globalRoot, "agent")
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, "x.md")
    fs.writeFileSync(file, "---\nname: x\n---\nbody", "utf-8")
    assetWatcher("global", "agent").onCreate(file)
    await waitFor(() => fake.observes.length === before + 1, "asset observe never sent")
    expect(fake.observes[before]).toEqual([{ kind: "asset", asset: "agent", scope: "global", id: "x" }])
    svc.dispose()
  })

  it("observe failure leaves local state intact with pending diagnostic and no SDK call", async () => {
    writeGlobalConfig({ $schema: "https://app.kilo.ai/config.json" })
    writeProjectConfig({ $schema: "https://app.kilo.ai/config.json" })
    const fake = new FakeConvergenceAdapter()
    fake.observeThrows = true
    const svc = makeSvc(fake)
    const errors: string[] = []
    svc.onDidError((e) => errors.push(e.message))
    await svc.initialize()
    const before = svc.snapshot
    writeGlobalConfig({ $schema: "https://app.kilo.ai/config.json", model: "test/ext" })
    watcherAdapter.watchers_[0].onChange()
    await waitFor(() => fake.observes.length === 1, "observe never attempted")
    await waitFor(() => errors.some((m) => m.includes("pending")), "pending diagnostic never surfaced")
    expect(svc.snapshot).not.toBe(before)
    expect(JSON.stringify(svc.snapshot).includes("test/ext")).toBe(true)
    svc.dispose()
  })

  it("private observe adapter sends config and asset hints over transport", async () => {
    let calls = 0
    const seen: unknown[] = []
    const peer = {
      request: async (method: string, _params: unknown): Promise<unknown> => {
        calls += 1
        seen.push((_params as { descriptors: unknown }).descriptors)
        const p = _params as { observeId: string }
        expect(method).toBe("config/convergence/observe")
        return { v: 1, observeId: p.observeId, outcome: "cold", scope: "global" }
      },
      hasCapability: (cap: string) => cap === "config/convergence/observe",
    }
    const adapter = new PrivateConvergenceAdapter(() => peer as never, 2000)
    const desc = [{ kind: "config", scope: "global" }] as const
    const a = await adapter.observe(desc as never)
    expect(a).toEqual({ status: "converged", outcome: "cold" })
    expect(calls).toBe(1)
    const asset = await adapter.observe([{ kind: "asset", asset: "agent", scope: "global", id: "x" }] as never)
    expect(asset).toEqual({ status: "converged", outcome: "cold" })
    expect(calls).toBe(2)
    expect(JSON.stringify(seen).includes('"asset"')).toBe(true)
  })

  it("parseObserveResponse accepts only cold; noop/hot/extra are pending", async () => {
    expect(parseObserveResponse({ v: 1, observeId: "o", outcome: "cold", scope: "global" }, "o")).toEqual({
      status: "converged",
      outcome: "cold",
    })
    expect(parseObserveResponse({ v: 1, observeId: "o", outcome: "noop", scope: "global" }, "o").status).toBe("pending")
    expect(parseObserveResponse({ v: 1, observeId: "o", outcome: "hot", scope: "global" }, "o").status).toBe("pending")
    expect(parseObserveResponse({ v: 1, observeId: "o", outcome: "cold", scope: "global", extra: 1 }, "o").status).toBe("pending")
    expect(parseObserveResponse({ v: 1, observeId: "wrong", outcome: "cold", scope: "global" }, "o").status).toBe("pending")
  })
})

describe("ExternalObserveCoalescer bounded descriptor accumulator", () => {
  it("dedups same id within one batch but keeps distinct ids", async () => {
    const batches: unknown[][] = []
    const observe = async (d: readonly unknown[]): Promise<{ status: string; outcome: string }> => {
      batches.push([...d])
      return { status: "converged", outcome: "cold" }
    }
    const coalescer = new ExternalObserveCoalescer()
    const deps = makeDeps(observe as never, () => {})
    const a = { kind: "asset", asset: "agent", scope: "global", id: "a" }
    const b = { kind: "asset", asset: "agent", scope: "global", id: "b" }
    coalescer.notify("global", deps as never, [a, b, a] as never)
    await waitFor(() => batches.length === 1, "batch never sent")
    await new Promise((r) => setTimeout(r, 60))
    expect(batches[0].length).toBe(2)
    // A repeat of the same id after the batch drained is cold by design
    // (may rebuild): it sends again rather than collapsing across batches.
    coalescer.notify("global", deps as never, [a] as never)
    await waitFor(() => batches.length === 2, "repeat batch never sent")
    expect(batches[1].length).toBe(1)
  })

  it("burst >8 drains in batches until empty; config and assets share a batch", async () => {
    const batches: unknown[][] = []
    const observe = async (d: readonly unknown[]): Promise<{ status: string; outcome: string }> => {
      batches.push([...d])
      await new Promise((r) => setTimeout(r, 5))
      return { status: "converged", outcome: "cold" }
    }
    const coalescer = new ExternalObserveCoalescer()
    const deps = makeDeps(observe as never, () => {})
    const descs = Array.from({ length: 10 }, (_, i) => ({ kind: "asset", asset: "agent", scope: "global", id: `s${i}` }))
    const config = { kind: "config", scope: "global" }
    coalescer.notify("global", deps as never, [...descs.slice(0, 5), config] as never)
    coalescer.notify("global", deps as never, descs.slice(5) as never)
    await waitFor(() => batches.flat().length === 11, "burst never drained")
    for (const b of batches) expect(b.length).toBeLessThanOrEqual(8)
    expect(batches.length).toBe(2)
    expect(batches.flat().length).toBe(11)
  })

  it("descriptors arriving during inflight join the next batch", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const batches: string[][] = []
    let calls = 0
    const observe = async (d: readonly { id?: string; kind: string }[]): Promise<{ status: string; outcome: string }> => {
      calls += 1
      batches.push(d.map((x) => x.id ?? x.kind))
      if (calls === 1) await gate
      return { status: "converged", outcome: "cold" }
    }
    const coalescer = new ExternalObserveCoalescer()
    const deps = makeDeps(observe as never, () => {})
    coalescer.notify("global", deps as never, [{ kind: "asset", asset: "agent", scope: "global", id: "first" }] as never)
    await new Promise((r) => setTimeout(r, 20))
    expect(calls).toBe(1)
    coalescer.notify("global", deps as never, [{ kind: "asset", asset: "agent", scope: "global", id: "second" }] as never)
    coalescer.notify("global", deps as never, [{ kind: "asset", asset: "agent", scope: "global", id: "third" }] as never)
    release()
    await waitFor(() => calls === 2, "trailing batch never ran")
    await new Promise((r) => setTimeout(r, 40))
    expect(calls).toBe(2)
    expect(batches[0]).toEqual(["first"])
    expect([...batches[1]].sort()).toEqual(["second", "third"])
  })

  it("failure keeps pending diagnostic and later dirty still processes", async () => {
    const pending: string[] = []
    let calls = 0
    const observe = async (d: readonly { id?: string }[]): Promise<{ status: string; message?: string; outcome?: string }> => {
      calls += 1
      if (calls === 1) throw new Error("boom")
      return { status: "converged", outcome: "cold" }
    }
    const coalescer = new ExternalObserveCoalescer()
    const deps = makeDeps(observe as never, (m) => pending.push(m))
    coalescer.notify("global", deps as never, [{ kind: "asset", asset: "agent", scope: "global", id: "a" }] as never)
    await waitFor(() => calls === 1, "first never ran")
    await waitFor(() => pending.length === 1, "failure diagnostic missing")
    coalescer.notify("global", deps as never, [{ kind: "asset", asset: "agent", scope: "global", id: "b" }] as never)
    await waitFor(() => calls === 2, "follow-up after failure never ran")
  })
})

describe("canonical asset watcher observe", () => {
  it("create/modify/delete emit asset descriptors; rename keeps old and new ids", async () => {
    writeGlobalConfig({ $schema: "https://app.kilo.ai/config.json" })
    writeProjectConfig({ $schema: "https://app.kilo.ai/config.json" })
    const fake = new FakeConvergenceAdapter()
    const svc = makeSvc(fake)
    await svc.initialize()
    const dir = path.join(globalRoot, "agent")
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, "hello.md")
    fs.writeFileSync(file, "---\nname: hello\n---\nbody", "utf-8")
    assetWatcher("global", "agent").onCreate(file)
    await waitFor(() => fake.observes.length === 1, "create observe missing")
    expect(fake.observes[0]).toEqual([{ kind: "asset", asset: "agent", scope: "global", id: "hello" }])
    fs.writeFileSync(file, "---\nname: hello\n---\nbody2", "utf-8")
    assetWatcher("global", "agent").onChange(file)
    await waitFor(() => fake.observes.length === 2, "modify observe missing")
    fs.unlinkSync(file)
    assetWatcher("global", "agent").onDelete(file)
    await waitFor(() => fake.observes.length === 3, "delete observe missing")
    expect(fake.observes[2]).toEqual([{ kind: "asset", asset: "agent", scope: "global", id: "hello" }])
    const before = fake.observes.length
    const oldFile = path.join(dir, "oldname.md")
    const newFile = path.join(dir, "newname.md")
    fs.writeFileSync(oldFile, "---\nname: oldname\n---\nbody", "utf-8")
    assetWatcher("global", "agent").onCreate(oldFile)
    await waitFor(() => fake.observes.length === before + 1, "rename old observe missing")
    fs.unlinkSync(oldFile)
    fs.writeFileSync(newFile, "---\nname: newname\n---\nbody", "utf-8")
    assetWatcher("global", "agent").onDelete(oldFile)
    assetWatcher("global", "agent").onCreate(newFile)
    await waitFor(() => fake.observes.length >= before + 3, "rename new observe missing")
    const flat = fake.observes.slice(before).flat() as Array<{ id?: string }>
    expect(flat.map((d) => d.id).includes("oldname")).toBe(true)
    expect(flat.map((d) => d.id).includes("newname")).toBe(true)
    svc.dispose()
  })

  it("own-write hash hit sends no observe", async () => {
    writeGlobalConfig({ $schema: "https://app.kilo.ai/config.json" })
    writeProjectConfig({ $schema: "https://app.kilo.ai/config.json" })
    const fake = new FakeConvergenceAdapter()
    const svc = makeSvc(fake)
    await svc.initialize()
    const res = await svc.writeAsset("agent", "own1", { name: "own1" }, "body", "global", "absent")
    expect(res.ok).toBe(true)
    const before = fake.observes.length
    const file = path.join(globalRoot, "agent", "own1.md")
    assetWatcher("global", "agent").onChange(file)
    await new Promise((r) => setTimeout(r, 150))
    expect(fake.observes.length).toBe(before)
    svc.dispose()
  })

  it("own-write delete sends no observe", async () => {
    writeGlobalConfig({ $schema: "https://app.kilo.ai/config.json" })
    writeProjectConfig({ $schema: "https://app.kilo.ai/config.json" })
    const fake = new FakeConvergenceAdapter()
    const svc = makeSvc(fake)
    await svc.initialize()
    const created = await svc.writeAsset("agent", "gone", { name: "gone" }, "body", "global", "absent")
    expect(created.ok).toBe(true)
    const file = path.join(globalRoot, "agent", "gone.md")
    const hash = svc.getAssetStamp("agent", "gone", "global")
    const deleted = await svc.deleteAsset("agent", "gone", "global", hash)
    expect(deleted.ok).toBe(true)
    const before = fake.observes.length
    assetWatcher("global", "agent").onDelete(file)
    await new Promise((r) => setTimeout(r, 150))
    expect(fake.observes.length).toBe(before)
    svc.dispose()
  })

  it("invalid markdown keeps fail-soft with no observe", async () => {
    writeGlobalConfig({ $schema: "https://app.kilo.ai/config.json" })
    writeProjectConfig({ $schema: "https://app.kilo.ai/config.json" })
    const fake = new FakeConvergenceAdapter()
    const svc = makeSvc(fake)
    const errors: string[] = []
    svc.onDidError((e) => errors.push(e.message))
    await svc.initialize()
    const before = fake.observes.length
    const dir = path.join(globalRoot, "agent")
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, "broken.md")
    fs.writeFileSync(file, "---\n: bad: [\n---\nbody", "utf-8")
    assetWatcher("global", "agent").onCreate(file)
    await new Promise((r) => setTimeout(r, 200))
    expect(fake.observes.length).toBe(before)
    svc.dispose()
  })

  it("skill flat .md under a skill root sends no observe", async () => {
    writeGlobalConfig({ $schema: "https://app.kilo.ai/config.json" })
    writeProjectConfig({ $schema: "https://app.kilo.ai/config.json" })
    const fake = new FakeConvergenceAdapter()
    const svc = makeSvc(fake)
    await svc.initialize()
    const before = fake.observes.length
    const flat = path.join(globalRoot, "skill", "flat.md")
    fs.mkdirSync(path.dirname(flat), { recursive: true })
    fs.writeFileSync(flat, "---\nname: flat\n---\nbody", "utf-8")
    skillWatcherFor(flat).onCreate(flat)
    await new Promise((r) => setTimeout(r, 150))
    expect(fake.observes.length).toBe(before)
    svc.dispose()
  })

  it("nested subdir and non-md keep fail-soft with diagnostic and no error descriptor", async () => {
    writeGlobalConfig({ $schema: "https://app.kilo.ai/config.json" })
    writeProjectConfig({ $schema: "https://app.kilo.ai/config.json" })
    const fake = new FakeConvergenceAdapter()
    const svc = makeSvc(fake)
    const errors: string[] = []
    svc.onDidError((e) => errors.push(e.message))
    await svc.initialize()
    const before = fake.observes.length
    const nested = path.join(globalRoot, "agent", "sub", "nested.md")
    fs.mkdirSync(path.dirname(nested), { recursive: true })
    fs.writeFileSync(nested, "---\nname: nested\n---\nbody", "utf-8")
    assetWatcher("global", "agent").onCreate(nested)
    await new Promise((r) => setTimeout(r, 150))
    expect(fake.observes.length).toBe(before)
    const txt = path.join(globalRoot, "agent", "notes.txt")
    fs.writeFileSync(txt, "notes", "utf-8")
    assetWatcher("global", "agent").onCreate(txt)
    await new Promise((r) => setTimeout(r, 150))
    expect(fake.observes.length).toBe(before)
    expect(errors.some((m) => m.includes("nested"))).toBe(true)
    for (const batch of fake.observes) {
      for (const d of batch as Array<{ id?: string }>) {
        expect(d.id === undefined || !String(d.id).includes("/")).toBe(true)
      }
    }
    svc.dispose()
  })
})

describe("canonical skill watcher observe (singular/plural SKILL.md)", () => {
  it("skill add in singular root emits logical descriptor", async () => {
    writeGlobalConfig({ $schema: "https://app.kilo.ai/config.json" })
    writeProjectConfig({ $schema: "https://app.kilo.ai/config.json" })
    const fake = new FakeConvergenceAdapter()
    const svc = makeSvc(fake)
    await svc.initialize()
    const file = path.join(globalRoot, "skill", "foo", "SKILL.md")
    writeSkillMd(file, "foo")
    skillWatcherFor(file).onCreate(file)
    await waitFor(() => fake.observes.length === 1, "singular skill observe missing")
    expect(fake.observes[0]).toEqual([{ kind: "asset", asset: "skill", scope: "global", id: "foo" }])
    svc.dispose()
  })

  it("skill add in plural root emits logical descriptor", async () => {
    writeGlobalConfig({ $schema: "https://app.kilo.ai/config.json" })
    writeProjectConfig({ $schema: "https://app.kilo.ai/config.json" })
    const fake = new FakeConvergenceAdapter()
    const svc = makeSvc(fake)
    await svc.initialize()
    const file = path.join(globalRoot, "skills", "bar", "SKILL.md")
    writeSkillMd(file, "bar")
    skillWatcherFor(file).onCreate(file)
    await waitFor(() => fake.observes.length === 1, "plural skill observe missing")
    expect(fake.observes[0]).toEqual([{ kind: "asset", asset: "skill", scope: "global", id: "bar" }])
    svc.dispose()
  })

  it("skill edit and delete emit logical descriptors", async () => {
    writeGlobalConfig({ $schema: "https://app.kilo.ai/config.json" })
    writeProjectConfig({ $schema: "https://app.kilo.ai/config.json" })
    const fake = new FakeConvergenceAdapter()
    const svc = makeSvc(fake)
    await svc.initialize()
    const file = path.join(globalRoot, "skill", "eedit", "SKILL.md")
    writeSkillMd(file, "eedit", "v1")
    skillWatcherFor(file).onCreate(file)
    await waitFor(() => fake.observes.length === 1, "skill create observe missing")
    writeSkillMd(file, "eedit", "v2 changed")
    skillWatcherFor(file).onChange(file)
    await waitFor(() => fake.observes.length === 2, "skill edit observe missing")
    expect(fake.observes[1]).toEqual([{ kind: "asset", asset: "skill", scope: "global", id: "eedit" }])
    fs.unlinkSync(file)
    skillWatcherFor(file).onDelete(file)
    await waitFor(() => fake.observes.length === 3, "skill delete observe missing")
    expect(fake.observes[2]).toEqual([{ kind: "asset", asset: "skill", scope: "global", id: "eedit" }])
    svc.dispose()
  })

  it("skill rename across singular/plural keeps old and new ids", async () => {
    writeGlobalConfig({ $schema: "https://app.kilo.ai/config.json" })
    writeProjectConfig({ $schema: "https://app.kilo.ai/config.json" })
    const fake = new FakeConvergenceAdapter()
    const svc = makeSvc(fake)
    await svc.initialize()
    const oldFile = path.join(globalRoot, "skill", "oldskill", "SKILL.md")
    writeSkillMd(oldFile, "oldskill")
    skillWatcherFor(oldFile).onCreate(oldFile)
    await waitFor(() => fake.observes.length === 1, "skill rename old observe missing")
    const before = fake.observes.length
    const newFile = path.join(globalRoot, "skills", "newskill", "SKILL.md")
    fs.unlinkSync(oldFile)
    writeSkillMd(newFile, "newskill")
    skillWatcherFor(oldFile).onDelete(oldFile)
    skillWatcherFor(newFile).onCreate(newFile)
    await waitFor(() => fake.observes.length >= before + 2, "skill rename new observe missing")
    const flat = fake.observes.slice(before).flat() as Array<{ id?: string }>
    expect(flat.map((d) => d.id).includes("oldskill")).toBe(true)
    expect(flat.map((d) => d.id).includes("newskill")).toBe(true)
    svc.dispose()
  })

  it("unknown-path fallback enumerates both roots and dedups same logical name", async () => {
    writeGlobalConfig({ $schema: "https://app.kilo.ai/config.json" })
    writeProjectConfig({ $schema: "https://app.kilo.ai/config.json" })
    const fake = new FakeConvergenceAdapter()
    const svc = makeSvc(fake)
    await svc.initialize()
    const before = fake.observes.length
    writeSkillMd(path.join(globalRoot, "skill", "dup", "SKILL.md"), "dup")
    writeSkillMd(path.join(globalRoot, "skills", "dup", "SKILL.md"), "dup")
    writeSkillMd(path.join(globalRoot, "skills", "other", "SKILL.md"), "other")
    const anySkillWatcher = skillWatcherFor(path.join(globalRoot, "skill", "dup", "SKILL.md"))
    anySkillWatcher.onChange()
    await waitFor(() => fake.observes.flat().length >= 2, "fallback skill observes missing")
    const ids = (fake.observes.slice(before).flat() as Array<{ id?: string; asset?: string }>).filter((d) => d.asset === "skill").map((d) => d.id)
    expect(ids.includes("dup")).toBe(true)
    expect(ids.includes("other")).toBe(true)
    expect(ids.filter((id) => id === "dup").length).toBe(1)
    svc.dispose()
  })

  it("skill nested deeper, root SKILL.md, invalid name, and invalid content send no observe", async () => {
    writeGlobalConfig({ $schema: "https://app.kilo.ai/config.json" })
    writeProjectConfig({ $schema: "https://app.kilo.ai/config.json" })
    const fake = new FakeConvergenceAdapter()
    const svc = makeSvc(fake)
    const errors: string[] = []
    svc.onDidError((e) => errors.push(e.message))
    await svc.initialize()
    const before = fake.observes.length
    const deep = path.join(globalRoot, "skill", "a", "b", "SKILL.md")
    writeSkillMd(deep, "a")
    skillWatcherFor(deep).onCreate(deep)
    await new Promise((r) => setTimeout(r, 150))
    expect(fake.observes.length).toBe(before)
    const rootSkill = path.join(globalRoot, "skill", "SKILL.md")
    writeSkillMd(rootSkill, "root")
    skillWatcherFor(rootSkill).onCreate(rootSkill)
    await new Promise((r) => setTimeout(r, 150))
    expect(fake.observes.length).toBe(before)
    const badName = path.join(globalRoot, "skill", ".hidden", "SKILL.md")
    writeSkillMd(badName, ".hidden")
    skillWatcherFor(badName).onCreate(badName)
    await new Promise((r) => setTimeout(r, 150))
    expect(fake.observes.length).toBe(before)
    const broken = path.join(globalRoot, "skills", "broken", "SKILL.md")
    fs.mkdirSync(path.dirname(broken), { recursive: true })
    fs.writeFileSync(broken, "---\n: bad: [\n---\nbody", "utf-8")
    skillWatcherFor(broken).onCreate(broken)
    await new Promise((r) => setTimeout(r, 200))
    expect(fake.observes.length).toBe(before)
    expect(errors.some((m) => m.includes("nested") || m.includes("SKILL"))).toBe(true)
    for (const batch of fake.observes) {
      for (const d of batch as Array<{ asset?: string; id?: string }>) {
        if (d.asset === "skill") expect(d.id === undefined || !String(d.id).includes("/")).toBe(true)
      }
    }
    svc.dispose()
  })
})

describe("asset id closed set (CLI-aligned)", () => {
  it("accepts simple ids and interior dots", () => {
    for (const id of ["x", "foo", "a..b", "a-b_c.d", "0abc", "A".repeat(128)]) expect(isValidAssetId(id)).toBe(true)
  })

  it("rejects space, leading dot/dash, overlong, separators, and bare dots", () => {
    for (const id of ["bad name", ".hidden", "-lead", "A".repeat(129), "", ".", "..", "a/b", "a\\b", "a\0b"]) expect(isValidAssetId(id)).toBe(false)
  })

  it("skill watcher accepts interior-dot names", async () => {
    writeGlobalConfig({ $schema: "https://app.kilo.ai/config.json" })
    writeProjectConfig({ $schema: "https://app.kilo.ai/config.json" })
    const fake = new FakeConvergenceAdapter()
    const svc = makeSvc(fake)
    await svc.initialize()
    const file = path.join(globalRoot, "skill", "a..b", "SKILL.md")
    writeSkillMd(file, "a..b")
    skillWatcherFor(file).onCreate(file)
    await waitFor(() => fake.observes.length === 1, "dotted skill observe missing")
    expect(fake.observes[0]).toEqual([{ kind: "asset", asset: "skill", scope: "global", id: "a..b" }])
    svc.dispose()
  })
})
