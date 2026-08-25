// kilocode_change - new file

import { afterAll, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer, ManagedRuntime, Option } from "effect"
import { applyEdits, modify } from "jsonc-parser"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Global } from "@opencode-ai/core/global"
import { Config } from "../../src/config/config"
import { ConfigParse } from "../../src/config/parse"
import { KilocodeConfig } from "../../src/kilocode/config/config"
import { Auth } from "../../src/auth"
import { Account } from "../../src/account/account"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Npm } from "@opencode-ai/core/npm"
import { provideTestInstance } from "../fixture/fixture"
import { Filesystem } from "../../src/util/filesystem"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { HttpClient } from "effect/unstable/http"
import { tmpdir } from "../fixture/fixture"

const infra = CrossSpawnSpawner.defaultLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
)

const emptyAccount = Layer.mock(Account.Service)({
  active: () => Effect.succeed(Option.none()),
  activeOrg: () => Effect.succeed(Option.none()),
})

const emptyAuth = Layer.mock(Auth.Service)({
  all: () => Effect.succeed({}),
})

const noopNpm = Layer.mock(Npm.Service)({
  install: () => Effect.void,
  add: () => Effect.die("not implemented"),
  which: () => Effect.succeed(Option.none()),
})

const unexpectedHttp = HttpClient.make((request) =>
  Effect.die(`unexpected http request: ${request.method} ${request.url}`),
)

const layer = Config.layer.pipe(
  Layer.provide(Git.defaultLayer),
  Layer.provide(EffectFlock.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Env.defaultLayer),
  Layer.provide(emptyAuth),
  Layer.provide(emptyAccount),
  Layer.provideMerge(infra),
  Layer.provide(noopNpm),
  Layer.provide(Layer.succeed(HttpClient.HttpClient, unexpectedHttp)),
)

const load = () => Effect.runPromise(Config.Service.use((svc) => svc.get()).pipe(Effect.scoped, Effect.provide(layer)))
const save = (config: Config.Info) =>
  Effect.runPromise(Config.Service.use((svc) => svc.update(config)).pipe(Effect.scoped, Effect.provide(layer)))

async function writeConfig(dir: string, config: unknown) {
  await Filesystem.write(path.join(dir, "kilo.jsonc"), JSON.stringify(config, null, 2))
}

async function writeLegacyConfig(dir: string, config: unknown) {
  await Filesystem.write(path.join(dir, "kilo.json"), JSON.stringify(config, null, 2))
}

test("project config update creates .kilo/kilo.jsonc and reloads it", async () => {
  await using tmp = await tmpdir({ retain: true })
  await provideTestInstance({
    directory: tmp.path,
    fn: async () => {
      await save({ model: "updated/model" } as Config.Info)

      const written = await Filesystem.readJson<{ model: string }>(path.join(tmp.path, ".kilo", "kilo.jsonc"))
      expect(written.model).toBe("updated/model")

      const loaded = await load()
      expect(loaded.model).toBe("updated/model")
    },
  })
})

test("project config update skips empty delete-only writes when no config exists", async () => {
  await using tmp = await tmpdir({ retain: true })
  await provideTestInstance({
    directory: tmp.path,
    fn: async () => {
      await save({ provider: { missing: null } } as unknown as Config.Info)

      await expect(fs.access(path.join(tmp.path, ".kilo", "kilo.jsonc"))).rejects.toThrow()
    },
  })
})

test("project config update ignores legacy root kilo.json and writes canonical .kilo/kilo.jsonc", async () => {
  await using tmp = await tmpdir({ retain: true })
  await writeLegacyConfig(tmp.path, { username: "alice" })

  await provideTestInstance({
    directory: tmp.path,
    fn: async () => {
      await save({ model: "updated/model" } as Config.Info)

      const written = await Filesystem.readJson<{ model: string; username: string }>(
        path.join(tmp.path, ".kilo", "kilo.jsonc"),
      )
      expect(written.model).toBe("updated/model")
      const legacy = await Filesystem.readJson<{ username: string }>(path.join(tmp.path, "kilo.json"))
      expect(legacy.username).toBe("alice")
      expect("model" in legacy).toBe(false)
    },
  })
})

test("project config update from nested directory without worktree creates nested canonical file, not ancestor", async () => {
  await using tmp = await tmpdir({ retain: true })
  const child = path.join(tmp.path, "nested", "workspace")
  await fs.mkdir(child, { recursive: true })
  await fs.mkdir(path.join(tmp.path, ".kilo"), { recursive: true })
  await writeConfig(path.join(tmp.path, ".kilo"), { username: "alice" })

  await provideTestInstance({
    directory: child,
    fn: async () => {
      await save({ model: "updated/model" } as Config.Info)

      const nestedWritten = await Filesystem.readJson<{ model: string }>(path.join(child, ".kilo", "kilo.jsonc"))
      expect(nestedWritten.model).toBe("updated/model")
      const ancestor = await Filesystem.readJson<{ username: string }>(path.join(tmp.path, ".kilo", "kilo.jsonc"))
      expect(ancestor.username).toBe("alice")
      expect("model" in ancestor).toBe(false)
    },
  })
})

test("project config update from nested directory with worktree patches workspace-root canonical file", async () => {
  await using tmp = await tmpdir({ git: true, retain: true })
  const child = path.join(tmp.path, "nested", "workspace")
  await fs.mkdir(child, { recursive: true })
  await fs.mkdir(path.join(tmp.path, ".kilo"), { recursive: true })
  await writeConfig(path.join(tmp.path, ".kilo"), { username: "alice" })

  await provideTestInstance({
    directory: child,
    fn: async () => {
      await save({ model: "updated/model" } as Config.Info)

      const merged = await Filesystem.readJson<{ model: string; username: string }>(
        path.join(tmp.path, ".kilo", "kilo.jsonc"),
      )
      expect(merged.model).toBe("updated/model")
      expect(merged.username).toBe("alice")
      await expect(fs.access(path.join(child, ".kilo", "kilo.jsonc"))).rejects.toThrow()
    },
  })
})

// LOCK-002: `KilocodeConfig.updateProjectConfig` (the snapshot-disable
// persistence path) acquires the canonical project target flock and commits
// atomically, so a snapshot-disable racing an unrelated settings write never
// loses either value and never leaves a partial file.
const flockRt = ManagedRuntime.make(Layer.provideMerge(EffectFlock.defaultLayer, FSUtil.defaultLayer))

afterAll(async () => {
  await flockRt.dispose()
})

const applyUpdate = (dir: string, patch: Config.Info) =>
  flockRt.runPromise(
    Effect.gen(function* () {
      const fsu = yield* FSUtil.Service
      return yield* KilocodeConfig.updateProjectConfig({
        fs: fsu,
        directory: dir,
        config: patch,
        read: (file) =>
          fsu.readFileString(file).pipe(
            Effect.map((s) => s as string | undefined),
            Effect.catch(() => Effect.succeed<string | undefined>(undefined)),
          ),
        parse: (input, file) => ConfigParse.jsonc(input, file) as Config.Info,
        patch: patchJsonc,
        writable: (config) => config,
      })
    }),
  )

function patchJsonc(input: string, config: Config.Info): string {
  return Object.entries(config).reduce(
    (out, [key, value]) =>
      applyEdits(out, modify(out, [key], value, { formattingOptions: { insertSpaces: true, tabSize: 2 } })),
    input,
  )
}

test("concurrent snapshot-disable and unrelated settings writes preserve both and leave no partial file (LOCK-002)", async () => {
  await using tmp = await tmpdir({ retain: true })
  const target = path.join(tmp.path, ".kilo", "kilo.jsonc")

  // Two independent writers race on the SAME target file: the snapshot
  // disable patch and an unrelated model change. Both serialize on the
  // canonical project target flock, so the read-modify-write of each is
  // atomic and neither update is lost.
  await Promise.all([applyUpdate(tmp.path, { snapshot: false }), applyUpdate(tmp.path, { model: "race/model" })])

  const written = await Filesystem.readJson<{ snapshot: boolean; model: string }>(target)
  expect(written.snapshot).toBe(false)
  expect(written.model).toBe("race/model")

  // Atomic commit: no temp-file leftovers from either writer.
  const leftovers = (await fs.readdir(path.join(tmp.path, ".kilo"))).filter((name) => name.includes(".tmp"))
  expect(leftovers.length).toBe(0)
})

test("updateProjectConfig serializes with the shared Config.update lock on the same target (LOCK-002)", async () => {
  await using tmp = await tmpdir({ retain: true })
  await provideTestInstance({
    directory: tmp.path,
    fn: async () => {
      // A legacy Config.update (Config service, flock-protected) and the
      // snapshot-disable write race on the same `.kilo/kilo.jsonc` target.
      // Both use the identical lock key, so both values survive.
      await Promise.all([
        save({ small_model: "legacy/model" } as Config.Info),
        applyUpdate(tmp.path, { snapshot: false }),
      ])

      const written = await Filesystem.readJson<{ small_model: string; snapshot: boolean }>(
        path.join(tmp.path, ".kilo", "kilo.jsonc"),
      )
      expect(written.small_model).toBe("legacy/model")
      expect(written.snapshot).toBe(false)
    },
  })
})

// ─── LOCK-001: stable target locking (no rediscovery under the lock) ──────

test("Config.update locks and writes the resolved .kilo target even when a root config file exists (LOCK-001)", async () => {
  await using tmp = await tmpdir({ retain: true })
  // Both `.kilo/kilo.jsonc` (canonical update target) and a legacy root `kilo.json`
  // exist. Discovery resolves `.kilo/kilo.jsonc` once; the update must lock
  // and write EXACTLY that path — never switch to the legacy file under the
  // lock.
  await fs.mkdir(path.join(tmp.path, ".kilo"), { recursive: true })
  await writeConfig(path.join(tmp.path, ".kilo"), { username: "alice" })
  await writeLegacyConfig(tmp.path, { username: "root" })

  await provideTestInstance({
    directory: tmp.path,
    fn: async () => {
      await save({ model: "locked/model" } as Config.Info)

      const project = await Filesystem.readJson<{ model: string; username: string }>(
        path.join(tmp.path, ".kilo", "kilo.jsonc"),
      )
      expect(project.model).toBe("locked/model")
      expect(project.username).toBe("alice")
      const root = await Filesystem.readJson<{ username: string }>(path.join(tmp.path, "kilo.json"))
      expect(root.username).toBe("root")
      expect("model" in root).toBe(false)
    },
  })
})

test("prepareProjectConfig honors the exact pre-resolved target when rediscovery would pick another file (LOCK-001)", async () => {
  await using tmp = await tmpdir({ retain: true })
  const kiloDir = path.join(tmp.path, ".kilo")
  await fs.mkdir(kiloDir, { recursive: true })
  await writeConfig(kiloDir, { alpha: 1 })

  // Resolve the update target once (the locked path).
  const resolved = await flockRt.runPromise(
    Effect.gen(function* () {
      const fsu = yield* FSUtil.Service
      return yield* KilocodeConfig.projectConfigUpdateTarget({ fs: fsu, directory: tmp.path })
    }),
  )
  expect(resolved).toBe(path.join(kiloDir, "kilo.jsonc"))

  // Race: the resolved target disappears and a legacy root config file appears, so a
  // naive rediscovery would still resolve the canonical .kilo path — not the legacy file.
  await fs.rm(resolved)
  await writeLegacyConfig(tmp.path, { beta: 2 })

  // Prepare must target the pre-resolved (locked) path, not rediscover.
  const prepared = await flockRt.runPromise(
    Effect.gen(function* () {
      const fsu = yield* FSUtil.Service
      return yield* KilocodeConfig.prepareProjectConfig({
        fs: fsu,
        directory: tmp.path,
        config: { gamma: 3 } as Config.Info,
        file: resolved,
        read: (file) =>
          fsu.readFileString(file).pipe(
            Effect.map((s) => s as string | undefined),
            Effect.catch(() => Effect.succeed<string | undefined>(undefined)),
          ),
        parse: (input, file) => ConfigParse.jsonc(input, file) as Config.Info,
        patch: patchJsonc,
        writable: (config) => config,
      })
    }),
  )
  expect(prepared.path).toBe(resolved)
  // The resolved target no longer exists, so prepare treats it as a fresh
  // target rather than switching to the rediscovered root file.
  expect(prepared.existed).toBe(false)
})

test("Config.updateGlobal locks and writes the resolved global file (LOCK-001)", async () => {
  await using tmp = await tmpdir({ retain: true })
  await writeConfig(tmp.path, { username: "alice" })
  const previous = (Global.Path as { config: string }).config
  ;(Global.Path as { config: string }).config = tmp.path
  try {
    await Effect.runPromise(
      Config.Service.use((svc) => svc.updateGlobal({ model: "global/model" } as Config.Info)).pipe(
        Effect.scoped,
        Effect.provide(layer),
      ),
    )
    const written = await Filesystem.readJson<{ model: string; username: string }>(
      path.join(tmp.path, "kilo.jsonc"),
    )
    expect(written.model).toBe("global/model")
    expect(written.username).toBe("alice")
  } finally {
    ;(Global.Path as { config: string }).config = previous
  }
})
