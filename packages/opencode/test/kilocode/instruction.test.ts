// kilocode_change - new file
import { describe, expect } from "bun:test"
import path from "path"
import { Effect, FileSystem, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { NodeFileSystem } from "@effect/platform-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Reference } from "../../src/reference/reference"
import { Instruction } from "../../src/session/instruction"
import { Global } from "@opencode-ai/core/global"
import { TestConfig } from "../fixture/config"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const reference = Layer.mock(Reference.Service)({
  init: () => Effect.void,
  list: () => Effect.succeed([]),
  get: () => Effect.succeed(undefined),
  ensure: () => Effect.void,
  contains: () => Effect.succeed(false),
})
const it = testEffect(
  Layer.mergeAll(
    CrossSpawnSpawner.defaultLayer,
    NodeFileSystem.layer,
    reference,
    RuntimeFlags.layer(),
    testInstanceStoreLayer,
  ),
)

const instructionLayer = (
  global: Partial<Global.Interface>,
  configOverrides?: Partial<import("../../src/config/config").Config.Interface>,
) => {
  const cfgLayer = configOverrides ? TestConfig.layer(configOverrides) : TestConfig.layer()
  return Instruction.layer.pipe(
    Layer.provide(cfgLayer),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Global.layerWith(global)),
  )
}

const provideInstruction =
  (global: Partial<Global.Interface>, cfg?: Partial<import("../../src/config/config").Config.Interface>) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    self.pipe(Effect.provide(instructionLayer(global, cfg)))

const write = (filepath: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(path.dirname(filepath), { recursive: true })
    yield* fs.writeFileString(filepath, content)
  })

const writeFiles = (dir: string, files: Record<string, string>) =>
  Effect.all(
    Object.entries(files).map(([file, content]) => write(path.join(dir, file), content)),
    { discard: true },
  )

const tmpWithFiles = (files: Record<string, string>) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    yield* writeFiles(dir, files)
    return dir
  })

const withEnv =
  (name: string, value: string | undefined) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const original = process.env[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (original === undefined) delete process.env[name]
          else process.env[name] = original
        }),
      )
      return yield* self
    })

const withConfigDir = (value: string | undefined) => withEnv("KILO_CONFIG_DIR", value)
const withDisableProject = (value: string | undefined) => withEnv("KILO_DISABLE_PROJECT_CONFIG", value)

describe("Instruction.systemPaths canonical global AGENTS.md (P4.4-T17)", () => {
  it.live("uses global AGENTS.md when KILO_CONFIG_DIR is not set", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ "AGENTS.md": "# Global Instructions" })
      const projectTmp = yield* tmpdirScoped()

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(globalTmp, "AGENTS.md"))).toBe(true)
      }).pipe(
        provideInstance(projectTmp),
        provideInstruction({ home: globalTmp, config: globalTmp }),
        withConfigDir(undefined),
      )
    }),
  )

  it.live("does not prefer KILO_CONFIG_DIR AGENTS.md — global wins even when profile set", () =>
    Effect.gen(function* () {
      const profileTmp = yield* tmpWithFiles({ "AGENTS.md": "# Profile Instructions" })
      const globalTmp = yield* tmpWithFiles({ "AGENTS.md": "# Global Instructions" })
      const projectTmp = yield* tmpdirScoped()

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(globalTmp, "AGENTS.md"))).toBe(true)
        expect(paths.has(path.join(profileTmp, "AGENTS.md"))).toBe(false)
      }).pipe(
        provideInstance(projectTmp),
        provideInstruction({ home: globalTmp, config: globalTmp }),
        withConfigDir(profileTmp),
      )
    }),
  )

  it.live("global AGENTS.md still used when KILO_CONFIG_DIR has no AGENTS.md", () =>
    Effect.gen(function* () {
      const profileTmp = yield* tmpdirScoped()
      const globalTmp = yield* tmpWithFiles({ "AGENTS.md": "# Global Instructions" })
      const projectTmp = yield* tmpdirScoped()

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(globalTmp, "AGENTS.md"))).toBe(true)
        expect(paths.has(path.join(profileTmp, "AGENTS.md"))).toBe(false)
      }).pipe(
        provideInstance(projectTmp),
        provideInstruction({ home: globalTmp, config: globalTmp }),
        withConfigDir(profileTmp),
      )
    }),
  )

  it.live("relative instruction with project config disabled resolves from global config not KILO_CONFIG_DIR", () =>
    Effect.gen(function* () {
      const profileTmp = yield* tmpWithFiles({ "custom-instr.md": "# Profile Instr" })
      const globalTmp = yield* tmpWithFiles({ "custom-instr.md": "# Global Instr" })
      const projectTmp = yield* tmpdirScoped()

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(globalTmp, "custom-instr.md"))).toBe(true)
        expect(paths.has(path.join(profileTmp, "custom-instr.md"))).toBe(false)
      }).pipe(
        provideInstance(projectTmp),
        provideInstruction({ home: globalTmp, config: globalTmp }, { get: () => Effect.succeed({ instructions: ["custom-instr.md"] } as unknown as import("../../src/config/config").Config.Info) }),
        withConfigDir(profileTmp),
        withDisableProject("1"),
      )
    }),
  )
})
