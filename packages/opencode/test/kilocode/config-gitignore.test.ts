// kilocode_change - P4.3 canonical loader side-effect free audit (Finding 1)
// Config.Service reads must not create .gitignore or trigger detached dependency installs.
// This file asserts the read path is side-effect free.

import { expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer, Option } from "effect"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Config } from "../../src/config/config"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Npm } from "@opencode-ai/core/npm"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Auth } from "../../src/auth"
import { Account } from "../../src/account/account"
import { provideTestInstance } from "../fixture/fixture"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { HttpClient } from "effect/unstable/http"
import { tmpdir } from "../fixture/fixture"
import { existsSync } from "fs"
import { Global } from "@opencode-ai/core/global"

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

const unexpectedHttp = HttpClient.make((request) =>
  Effect.die(`unexpected http request: ${request.method} ${request.url}`),
)

function assertNoArtifacts(dir: string) {
  expect(existsSync(path.join(dir, ".gitignore"))).toBe(false)
  expect(existsSync(path.join(dir, "node_modules"))).toBe(false)
  expect(existsSync(path.join(dir, "package.json"))).toBe(false)
  expect(existsSync(path.join(dir, "package-lock.json"))).toBe(false)
  expect(existsSync(path.join(dir, "pnpm-lock.yaml"))).toBe(false)
  expect(existsSync(path.join(dir, "yarn.lock"))).toBe(false)
  expect(existsSync(path.join(dir, "bun.lock"))).toBe(false)
}

test("canonical Config load does not create .gitignore or dependency artifacts (P4.3 read-only)", async () => {
  await using tmp = await tmpdir()
  await using globalTmp = await tmpdir()
  const dir = path.join(tmp.path, "a")
  const kilo = path.join(dir, ".kilo")
  await fs.mkdir(kilo, { recursive: true })
  const prevGlobal = Global.Path.config
  const prevEnv = process.env.KILO_CONFIG_DIR
  ;(Global.Path as { config: string }).config = globalTmp.path
  if (prevEnv !== undefined) delete process.env.KILO_CONFIG_DIR
  try {
    const testLayer = Config.layer.pipe(
      Layer.provide(Git.defaultLayer),
      Layer.provide(EffectFlock.defaultLayer),
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(Env.defaultLayer),
      Layer.provide(emptyAuth),
      Layer.provide(emptyAccount),
      Layer.provideMerge(infra),
      Layer.provide(Layer.succeed(HttpClient.HttpClient, unexpectedHttp)),
    )

    await provideTestInstance({
      directory: dir,
      fn: async () => {
        await Effect.runPromise(Config.Service.use((svc) => svc.get()).pipe(Effect.scoped, Effect.provide(testLayer)))
      },
    })

    // Both global and project canonical roots must remain side-effect free
    assertNoArtifacts(kilo)
    assertNoArtifacts(globalTmp.path)
    // also ensure global file not created
    expect(existsSync(path.join(globalTmp.path, "kilo.jsonc"))).toBe(false)
  } finally {
    ;(Global.Path as { config: string }).config = prevGlobal
    if (prevEnv === undefined) delete process.env.KILO_CONFIG_DIR
    else process.env.KILO_CONFIG_DIR = prevEnv
  }
})

test("canonical Config load does not invoke detached Npm install where seam exists (P4.3)", async () => {
  await using tmp = await tmpdir()
  await using globalTmp = await tmpdir()
  const dir = path.join(tmp.path, "b")
  const kilo = path.join(dir, ".kilo")
  await fs.mkdir(kilo, { recursive: true })
  const prevGlobal = Global.Path.config
  const prevEnv = process.env.KILO_CONFIG_DIR
  ;(Global.Path as { config: string }).config = globalTmp.path
  if (prevEnv !== undefined) delete process.env.KILO_CONFIG_DIR

  let installCalls = 0
  const countingNpm = Layer.mock(Npm.Service)({
    install: () => {
      installCalls++
      return Effect.void
    },
    add: () => Effect.die("not implemented"),
    which: () => Effect.succeed(Option.none()),
  })

  try {
    const testLayer = Config.layer.pipe(
      Layer.provide(Git.defaultLayer),
      Layer.provide(EffectFlock.defaultLayer),
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(Env.defaultLayer),
      Layer.provide(emptyAuth),
      Layer.provide(emptyAccount),
      Layer.provideMerge(infra),
      Layer.provide(countingNpm),
      Layer.provide(Layer.succeed(HttpClient.HttpClient, unexpectedHttp)),
    )

    await provideTestInstance({
      directory: dir,
      fn: async () => {
        await Effect.runPromise(Config.Service.use((svc) => svc.get()).pipe(Effect.scoped, Effect.provide(testLayer)))
        await Effect.runPromise(Config.Service.use((svc) => svc.waitForDependencies()).pipe(Effect.scoped, Effect.provide(testLayer)))
      },
    })

    expect(installCalls).toBe(0)
    assertNoArtifacts(kilo)
    assertNoArtifacts(globalTmp.path)
  } finally {
    ;(Global.Path as { config: string }).config = prevGlobal
    if (prevEnv === undefined) delete process.env.KILO_CONFIG_DIR
    else process.env.KILO_CONFIG_DIR = prevEnv
  }
})
