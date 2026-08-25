import { test, expect, describe, afterEach, beforeEach, spyOn } from "bun:test"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Effect, Exit, Layer, Option } from "effect"
import { HttpClient } from "effect/unstable/http"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Config } from "@/config/config"
import { ConfigParse } from "../../src/config/parse"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"

import { InstanceRef } from "../../src/effect/instance-ref"
import type { InstanceContext } from "../../src/project/instance-context"
import { Auth } from "../../src/auth"
import { Account } from "../../src/account/account"
import { AccessToken, AccountID, OrgID } from "../../src/account/schema"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Env } from "../../src/env"
import { Git } from "../../src/git" // kilocode_change
import {
  provideTmpdirInstance,
  TestInstance,
  tmpdir,
  tmpdirScoped,
  withTestInstance,
  provideInstanceEffect,
  testInstanceStoreLayer,
} from "../fixture/fixture"
import { InstanceRuntime } from "@/project/instance-runtime"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"
import path from "path"
import fs from "fs/promises"
import os from "os"
import { pathToFileURL } from "url"
import { Global } from "@opencode-ai/core/global"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Filesystem } from "@/util/filesystem"
import { ConfigPlugin } from "@/config/plugin"
import { ConfigPluginV1 } from "@opencode-ai/core/v1/config/plugin"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { isAtomicChatPlugin } from "@/kilocode/atomic-chat-feature" // kilocode_change

/** Infra layer that provides FileSystem, Path, ChildProcessSpawner for test fixtures */
const infra = CrossSpawnSpawner.defaultLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
)

const testFlock = EffectFlock.defaultLayer

const unexpectedHttp = HttpClient.make((request) =>
  Effect.die(`unexpected http request: ${request.method} ${request.url}`),
)

const configLayer = (
  options: {
    auth?: Layer.Layer<Auth.Service>
    account?: Layer.Layer<Account.Service>
    client?: HttpClient.HttpClient
  } = {},
) =>
  Config.layer.pipe(
    Layer.provide(Git.defaultLayer), // kilocode_change
    Layer.provide(testFlock),
    Layer.provide(Env.defaultLayer),
    Layer.provide(options.auth ?? AuthTest.empty),
    Layer.provide(options.account ?? AccountTest.empty),
    Layer.provideMerge(infra),
    Layer.provide(NpmTest.noop),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, options.client ?? unexpectedHttp)),
    Layer.provideMerge(FSUtil.defaultLayer),
  )

const layer = configLayer()

const it = testEffect(layer)
const configIt = (options?: Parameters<typeof configLayer>[0]) => testEffect(configLayer(options))

const schemaConfig = (config: object) => ({ $schema: "https://app.kilo.ai/config.json", ...config }) // kilocode_change

const provideCurrentInstance = <A, E, R>(effect: Effect.Effect<A, E, R>, ctx: InstanceContext) =>
  effect.pipe(Effect.provideService(InstanceRef, ctx))

const load = (ctx: InstanceContext) =>
  Effect.runPromise(
    Config.Service.use((svc) => provideCurrentInstance(svc.get(), ctx)).pipe(Effect.scoped, Effect.provide(layer)),
  )
const clearEffect = (wait = false) =>
  Config.use
    .invalidate()
    .pipe(
      Effect.scoped,
      Effect.provide(layer),
      Effect.andThen(wait ? Effect.promise(() => InstanceRuntime.disposeAllInstances()) : Effect.void),
    )
const clear = (wait = false) => Effect.runPromise(clearEffect(wait))
const originalTestToken = process.env.TEST_TOKEN
const originalConsoleToken = process.env.KILO_CONSOLE_TOKEN

beforeEach(async () => {
  await clear(true)
})

afterEach(async () => {
  if (originalTestToken === undefined) delete process.env.TEST_TOKEN
  else process.env.TEST_TOKEN = originalTestToken
  if (originalConsoleToken === undefined) delete process.env.KILO_CONSOLE_TOKEN
  else process.env.KILO_CONSOLE_TOKEN = originalConsoleToken
  await clear(true)
})

// kilocode_change start
async function writeConfig(dir: string, config: object, name = "kilo.jsonc") {
  // kilocode_change end
  await Filesystem.write(path.join(dir, name), JSON.stringify(config))
}

const writeConfigEffect = (
  dir: string,
  config: object,
  name = "kilo.jsonc", // kilocode_change
) => FSUtil.use.writeWithDirs(path.join(dir, name), JSON.stringify(config))

const withInstanceDir = <A, E, R>(dir: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(TestInstance, { directory: dir }),
    provideInstanceEffect(dir),
    Effect.provide(testInstanceStoreLayer),
    Effect.provide(CrossSpawnSpawner.defaultLayer),
  )

const withGlobalConfigDir = <A, E, R>(dir: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const previous = Global.Path.config
      ;(Global.Path as { config: string }).config = dir
      yield* clearEffect(true)
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.gen(function* () {
        ;(Global.Path as { config: string }).config = previous
        yield* clearEffect(true)
      }),
  )

const withGlobalConfig = <A, E, R>(
  input: { config?: object; name?: string },
  fn: (input: { dir: string }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    if (input.config) yield* writeConfigEffect(dir, schemaConfig(input.config), input.name)
    return yield* withGlobalConfigDir(dir, fn({ dir }))
  })

const withConfigTree = <A, E, R>(
  input: { global?: object; project?: object; local?: object },
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const global = yield* tmpdirScoped()
    const directory = path.join(root, "project")
    yield* Effect.all(
      [
        input.global ? writeConfigEffect(global, schemaConfig(input.global)) : undefined,
        input.project ? writeConfigEffect(path.join(directory, ".kilo"), schemaConfig(input.project), "kilo.jsonc") : undefined,
        input.local ? writeConfigEffect(path.join(directory, ".kilo"), schemaConfig(input.local), "kilo.jsonc") : undefined, // kilocode_change
      ].filter((effect): effect is Effect.Effect<void, FSUtil.Error, FSUtil.Service> => effect !== undefined),
      { concurrency: "unbounded" },
    )
    return yield* withGlobalConfigDir(global, withInstanceDir(directory, effect))
  })

function withProcessEnv<A, E, R>(key: string, value: string | undefined, effect: Effect.Effect<A, E, R>) {
  return withProcessEnvs({ [key]: value }, effect)
}

function withProcessEnvs<A, E, R>(entries: Record<string, string | undefined>, effect: Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const originals: Record<string, string | undefined> = {}
      for (const [key, value] of Object.entries(entries)) {
        originals[key] = process.env[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      return originals
    }),
    () => effect,
    (originals) =>
      Effect.sync(() => {
        for (const [key, original] of Object.entries(originals)) {
          if (original !== undefined) process.env[key] = original
          else delete process.env[key]
        }
      }),
  )
}

async function check(map: (dir: string) => string) {
  if (process.platform !== "win32") return
  await using globalTmp = await tmpdir()
  await using tmp = await tmpdir({ git: true, config: { snapshot: true } })
  const prev = Global.Path.config
  ;(Global.Path as { config: string }).config = globalTmp.path
  await clear()
  try {
    await writeConfig(globalTmp.path, {
      $schema: "https://opencode.ai/config.json",
      snapshot: false,
    })
    await withTestInstance({
      directory: map(tmp.path),
      fn: async (ctx) => {
        const cfg = await load(ctx)
        expect(cfg.snapshot).toBe(true)
        expect(ctx.directory).toBe(Filesystem.resolve(tmp.path))
        expect(ctx.project.id).not.toBe(ProjectV2.ID.global)
      },
    })
  } finally {
    await InstanceRuntime.disposeAllInstances()
    ;(Global.Path as { config: string }).config = prev
    await clear()
  }
}

it.instance("loads config with defaults when no files exist", () =>
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(config.username).toBeDefined()
  }),
)

it.instance("falls back to generic username when system user info is unavailable", () =>
  Effect.gen(function* () {
    const userInfo = spyOn(os, "userInfo").mockImplementation(() => {
      throw Object.assign(new Error("missing passwd entry"), { code: "ENOENT" })
    })
    try {
      const config = yield* Config.use.get()
      expect(config.username).toBe("user")
    } finally {
      userInfo.mockRestore()
    }
  }),
)

it.instance("loads JSON config file", () =>
  Effect.gen(function* () {
    // kilocode_change start
    const test = yield* TestInstance
    yield* writeConfigEffect(path.join(test.directory, ".kilo"), {
      $schema: "https://app.kilo.ai/config.json",
      model: "test/model",
      username: "testuser",
    })
    // kilocode_change end
    const config = yield* Config.use.get()
    expect(config.model).toBe("test/model")
    expect(config.username).toBe("testuser")
  }),
  60_000,
)

// kilocode_change start
it.instance("preserves Kilo provider free model metadata", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(path.join(test.directory, ".kilo"), {
      $schema: "https://app.kilo.ai/config.json",
      model: "kilo/free-e2e",
      provider: {
        kilo: {
          models: {
            "free-e2e": {
              id: "free-e2e",
              isFree: true,
              ai_sdk_provider: "openai-compatible",
            },
          },
        },
      },
    })
    const config = yield* Config.use.get()
    const model = config.provider?.kilo?.models?.["free-e2e"]
    expect(model?.isFree).toBe(true)
    expect(model?.ai_sdk_provider).toBe("openai-compatible")
  }),
)
// kilocode_change end

it.instance(
  "loads shell config field",
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(config.shell).toBe("bash")
  }),
  { config: { shell: "bash" } },
)

it.instance("updates config and preserves empty shell sentinel", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    // kilocode_change - upstream hardcodes project config to config.json; Kilo writes to kilo.json
    yield* writeConfigEffect(path.join(test.directory, ".kilo"), { $schema: "https://opencode.ai/config.json", shell: "bash" })

    yield* Config.Service.use((svc) => svc.update(ConfigParse.schema(ConfigV1.Info, { shell: "" }, "test:config")))

    const writtenConfig = yield* FSUtil.use.readJson(path.join(test.directory, ".kilo", "kilo.jsonc")) // kilocode_change
    expect(writtenConfig).toMatchObject({ shell: "" })
  }),
)

it.effect("updates global config and omits empty shell key in json", () =>
  withGlobalConfig({ config: { shell: "bash" } }, ({ dir }) =>
    Effect.gen(function* () {
      yield* Config.use.updateGlobal({ shell: "" })

      const writtenConfig = yield* FSUtil.use.readJson(path.join(dir, "kilo.jsonc")) // kilocode_change
      expect(writtenConfig).not.toHaveProperty("shell")
    }),
  ),
)

it.effect("updates global config and omits empty shell key in jsonc", () =>
  withGlobalConfig({ config: { shell: "bash", model: "test/model" }, name: "kilo.jsonc" }, ({ dir }) =>
    Effect.gen(function* () {
      yield* Config.use.updateGlobal({ shell: "" })

      const file = path.join(dir, "kilo.jsonc")
      const writtenConfig = yield* FSUtil.use.readFileString(file)
      const parsed = ConfigParse.schema(ConfigV1.Info, ConfigParse.jsonc(writtenConfig, file), file)
      expect(writtenConfig).not.toContain('"shell"')
      expect(parsed.shell).toBeUndefined()
      expect(parsed.model).toBe("test/model")
    }),
  ),
)

// kilocode_change start - semantic comparison treats an omitted shell key and
// the "" → undefined sentinel as equal, so re-saving an already-omitted shell
// is a true no-op (no rewrite, changed: false).
it.effect("re-saving an already-omitted empty shell key is a semantic no-op", () =>
  withGlobalConfig({ config: { shell: "bash" } }, ({ dir }) =>
    Effect.gen(function* () {
      const removed = yield* Config.use.updateGlobal({ shell: "" })
      expect(removed.changed).toBe(true)
      const before = yield* FSUtil.use.readFileString(path.join(dir, "kilo.jsonc"))
      expect(before).not.toContain('"shell"')

      const again = yield* Config.use.updateGlobal({ shell: "" })
      expect(again.changed).toBe(false)
      const after = yield* FSUtil.use.readFileString(path.join(dir, "kilo.jsonc"))
      expect(after).toBe(before)
    }),
  ),
)
// kilocode_change end

it.instance(
  "loads formatter boolean config",
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(config.formatter).toBe(true)
  }),
  { config: { formatter: true } },
)

it.instance(
  "loads lsp boolean config",
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(config.lsp).toBe(true)
  }),
  { config: { lsp: true } },
)

test("loads project config from Git Bash and MSYS2 paths on Windows", async () => {
  // Git Bash and MSYS2 both use /<drive>/... paths on Windows.
  await check((dir) => {
    const drive = dir[0].toLowerCase()
    const rest = dir.slice(2).replaceAll("\\", "/")
    return `/${drive}${rest}`
  })
})

test("loads project config from Cygwin paths on Windows", async () => {
  await check((dir) => {
    const drive = dir[0].toLowerCase()
    const rest = dir.slice(2).replaceAll("\\", "/")
    return `/cygdrive/${drive}${rest}`
  })
})

it.instance("ignores legacy tui keys in opencode config", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(path.join(test.directory, ".kilo"), {
      $schema: "https://opencode.ai/config.json",
      model: "test/model",
      theme: "legacy",
      tui: { scroll_speed: 4 },
    })

    const config = yield* Config.use.get()
    expect(config.model).toBe("test/model")
    expect((config as Record<string, unknown>).theme).toBeUndefined()
    expect((config as Record<string, unknown>).tui).toBeUndefined()
  }),
)

// kilocode_change start - project config is untrusted: {env:} rejected; {file:} confined to the project root
it.instance("rejects environment variable substitution in project config", () =>
  withProcessEnv(
    "TEST_VAR",
    "test-user",
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* writeConfigEffect(path.join(test.directory, ".kilo"), {
        $schema: "https://app.kilo.ai/config.json",
        username: "{env:TEST_VAR}",
      })
      const config = yield* Config.use.get()
      expect(config.username).not.toBe("test-user")
      const issues = yield* Config.Service.use((svc) => svc.warnings())
      expect(issues.length).toBeGreaterThan(0)
    }),
  ),
)

it.instance("allows {file:} that stays inside the project root", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(path.join(test.directory, ".kilo", "included.txt"), "in-project")
    yield* writeConfigEffect(path.join(test.directory, ".kilo"), {
      $schema: "https://app.kilo.ai/config.json",
      username: "{file:included.txt}",
    })
    const config = yield* Config.use.get()
    expect(config.username).toBe("in-project")
  }),
)

it.instance("rejects {file:} that reads an absolute path from project config", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(path.join(test.directory, ".kilo"), {
      $schema: "https://app.kilo.ai/config.json",
      username: "{file:/etc/passwd}",
    })
    const config = yield* Config.use.get()
    expect(config.username ?? "").not.toContain("root:")
  }),
)

it.instance("rejects {file:} that escapes the project root with parent directories", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const outside = path.join(path.dirname(test.directory), "secret.txt")
    yield* FSUtil.use.writeWithDirs(outside, "outside-secret")
    yield* writeConfigEffect(path.join(test.directory, ".kilo"), {
      $schema: "https://app.kilo.ai/config.json",
      username: "{file:../secret.txt}",
    })
    const config = yield* Config.use.get()
    expect(config.username).not.toBe("outside-secret")
  }),
)

it.instance("rejects {file:} that escapes the project root through a symlink", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const outside = path.join(path.dirname(test.directory), "secret.txt")
    const link = path.join(test.directory, "secret-link")
    yield* FSUtil.use.writeWithDirs(outside, "outside-secret")
    yield* Effect.promise(() => fs.symlink(outside, link))
    yield* writeConfigEffect(path.join(test.directory, ".kilo"), {
      $schema: "https://app.kilo.ai/config.json",
      username: "{file:secret-link}",
    })
    const config = yield* Config.use.get()
    expect(config.username).not.toBe("outside-secret")
  }),
)

it.instance("blocks provider apiKey {file:} exfiltration that escapes the project root", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const outside = path.join(path.dirname(test.directory), "creds.txt")
    yield* FSUtil.use.writeWithDirs(outside, "leaked-credential")
    yield* writeConfigEffect(path.join(test.directory, ".kilo"), {
      $schema: "https://app.kilo.ai/config.json",
      provider: {
        "openai-compatible": {
          options: { baseURL: "http://127.0.0.1:4444/v1", apiKey: "{file:../creds.txt}" },
          models: { "test-model": { name: "Test Model" } },
        },
      },
    })
    const config = yield* Config.use.get()
    expect(JSON.stringify(config.provider ?? {})).not.toContain("leaked-credential")
  }),
)

it.instance("still allows global config to read absolute files", () =>
  withGlobalConfig({}, ({ dir }) =>
    Effect.gen(function* () {
      const secret = path.join(dir, "secret.txt")
      yield* FSUtil.use.writeWithDirs(secret, "global-secret")
      yield* writeConfigEffect(dir, {
        $schema: "https://app.kilo.ai/config.json",
        username: `{file:${secret}}`,
      })
      const config = yield* Config.use.get()
      expect(config.username).toBe("global-secret")
    }),
  ),
)
// kilocode_change end

const accountTokenIt = configIt({
  account: Layer.mock(Account.Service)({
    active: () =>
      Effect.succeed(
        Option.some({
          id: AccountID.make("account-1"),
          email: "user@example.com",
          url: "https://control.example.com",
          active_org_id: OrgID.make("org-1"),
        }),
      ),
    activeOrg: () =>
      Effect.succeed(
        Option.some({
          account: {
            id: AccountID.make("account-1"),
            email: "user@example.com",
            url: "https://control.example.com",
            active_org_id: OrgID.make("org-1"),
          },
          org: {
            id: OrgID.make("org-1"),
            name: "Example Org",
          },
        }),
      ),
    config: () =>
      Effect.succeed(
        Option.some({
          provider: { opencode: { options: { apiKey: "{env:KILO_CONSOLE_TOKEN}" } } },
        }),
      ),
    token: () => Effect.succeed(Option.some(AccessToken.make("st_test_token"))),
  }),
})

it.instance("validates config schema and reports warning on invalid fields", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(path.join(test.directory, ".kilo"), {
      $schema: "https://app.kilo.ai/config.json",
      invalid_field: "should cause error",
    })
    // invalid schema surfaces as warnings, not a throw
    yield* Config.use.get()
    const issues = yield* Config.Service.use((svc) => svc.warnings())
    expect(issues.length).toBeGreaterThan(0)
  }),
)
// kilocode_change end

it.instance("loads JSONC config file", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".kilo", "kilo.jsonc"),
      `{
        // This is a comment
        "$schema": "https://app.kilo.ai/config.json",
        "model": "test/model",
        "username": "testuser"
      }`,
    )
    const config = yield* Config.use.get()
    expect(config.model).toBe("test/model")
    expect(config.username).toBe("testuser")
  }),
)

it.instance("reports warning for invalid JSON", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(path.join(test.directory, ".kilo", "kilo.jsonc"), "{ invalid json }")
    yield* Config.use.get()
    const issues = yield* Config.Service.use((svc) => svc.warnings())
    expect(issues.length).toBeGreaterThan(0)
  }),
)

it.instance("handles agent configuration", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(path.join(test.directory, ".kilo"), {
      $schema: "https://app.kilo.ai/config.json",
      agent: {
        test_agent: {
          model: "test/model",
          temperature: 0.7,
          description: "test agent",
        },
      },
    })
    const config = yield* Config.use.get()
    expect(config.agent?.["test_agent"]).toEqual(
      expect.objectContaining({
        model: "test/model",
        temperature: 0.7,
        description: "test agent",
      }),
    )
  }),
)

it.instance("treats agent variant as model-scoped setting (not provider option)", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(path.join(test.directory, ".kilo"), {
      $schema: "https://app.kilo.ai/config.json",
      agent: {
        test_agent: {
          model: "openai/gpt-5.2",
          variant: "xhigh",
          max_tokens: 123,
        },
      },
    })
    const config = yield* Config.use.get()
    const agent = config.agent?.["test_agent"]
    expect(agent?.variant).toBe("xhigh")
    expect(agent?.options).toMatchObject({
      max_tokens: 123,
    })
    expect(agent?.options).not.toHaveProperty("variant")
  }),
)

it.instance("handles command configuration", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(path.join(test.directory, ".kilo"), {
      $schema: "https://app.kilo.ai/config.json",
      command: {
        test_command: {
          template: "test template",
          description: "test command",
          agent: "test_agent",
        },
      },
    })
    const config = yield* Config.use.get()
    expect(config.command?.["test_command"]).toEqual({
      template: "test template",
      description: "test command",
      agent: "test_agent",
    })
  }),
)

it.instance("migrates autoshare to share field", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(path.join(test.directory, ".kilo"), {
      $schema: "https://app.kilo.ai/config.json",
      autoshare: true,
    })
    const config = yield* Config.use.get()
    expect(config.share).toBe("auto")
    expect(config.autoshare).toBe(true)
  }),
)

// kilocode_change start
it.instance("loads config from .kilo directory", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".kilo", "agent", "test.md"), // kilocode_change
      `---
model: test/model
---
Test agent prompt`,
    )

    const config = yield* Config.use.get()
    expect(config.agent?.["test"]).toEqual(
      expect.objectContaining({
        name: "test",
        model: "test/model",
        prompt: "Test agent prompt",
      }),
    )
  }),
)
// kilocode_change end

it.instance("agent markdown permission config preserves user key order", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".kilo", "agent", "ordered.md"), // kilocode_change
      `---
permission:
  bash: allow
  "*": deny
  edit: ask
---
Ordered permissions`,
    )

    const config = yield* Config.use.get()
    expect(Object.keys(config.agent?.ordered?.permission ?? {})).toEqual(["bash", "*", "edit"])
  }),
)

// kilocode_change start
it.instance("loads agents from .kilo/agents (plural)", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".kilo", "agents", "helper.md"), // kilocode_change
      `---
model: test/model
mode: subagent
---
Helper agent prompt`,
    )

    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".kilo", "agents", "nested", "child.md"), // kilocode_change
      `---
model: test/model
mode: subagent
---
Nested agent prompt`,
    )

    const config = yield* Config.use.get()

    expect(config.agent?.["helper"]).toMatchObject({
      name: "helper",
      model: "test/model",
      mode: "subagent",
      prompt: "Helper agent prompt",
    })

    expect(config.agent?.["nested/child"]).toMatchObject({
      name: "nested/child",
      model: "test/model",
      mode: "subagent",
      prompt: "Nested agent prompt",
    })
  }),
)
// kilocode_change end

it.instance("loads commands from .kilo/command (singular)", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".kilo", "command", "hello.md"),
      `---
description: Test command
---
Hello from singular command`,
    )
    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".kilo", "command", "nested", "child.md"),
      `---
description: Nested command
---
Nested command template`,
    )
    const config = yield* Config.use.get()
    expect(config.command?.["hello"]).toEqual({
      description: "Test command",
      template: "Hello from singular command",
    })
    expect(config.command?.["nested/child"]).toEqual({
      description: "Nested command",
      template: "Nested command template",
    })
  }),
)

it.instance("loads commands from .kilo/commands (plural)", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".kilo", "commands", "hello.md"),
      `---
description: Test command
---
Hello from plural commands`,
    )
    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".kilo", "commands", "nested", "child.md"),
      `---
description: Nested command
---
Nested command template`,
    )
    const config = yield* Config.use.get()
    expect(config.command?.["hello"]).toEqual({
      description: "Test command",
      template: "Hello from plural commands",
    })
    expect(config.command?.["nested/child"]).toEqual({
      description: "Nested command",
      template: "Nested command template",
    })
  }),
)

it.instance("updates config and writes to file", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* Config.Service.use((svc) =>
      svc.update(ConfigParse.schema(ConfigV1.Info, { model: "updated/model" }, "test:config")),
    )
    const writtenConfig = yield* FSUtil.use.readJson(path.join(test.directory, ".kilo", "kilo.jsonc"))
    expect(writtenConfig).toMatchObject({ model: "updated/model" })
  }),
)

// kilocode_change start

// Note: deduplication and serialization of npm installs is now handled by the
// core Npm.Service (via EffectFlock). Those behaviors are tested in the core
// package's npm tests, not here.


it.instance("does not error when only custom agent is a subagent", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".kilo", "agent", "helper.md"), // kilocode_change
      `---
model: test/model
mode: subagent
---
Helper subagent prompt`,
    )

    const config = yield* Config.use.get()
    expect(config.agent?.["helper"]).toMatchObject({
      name: "helper",
      model: "test/model",
      mode: "subagent",
      prompt: "Helper subagent prompt",
    })
  }),
)

it.instance("resolves scoped npm plugins in config", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const pluginDir = path.join(test.directory, "node_modules", "@scope", "plugin")
    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, "package.json"),
      JSON.stringify({ name: "config-fixture", version: "1.0.0", type: "module" }, null, 2),
    )
    yield* FSUtil.use.writeWithDirs(
      path.join(pluginDir, "package.json"),
      JSON.stringify(
        {
          name: "@scope/plugin",
          version: "1.0.0",
          type: "module",
          main: "./index.js",
        },
        null,
        2,
      ),
    )
    yield* FSUtil.use.writeWithDirs(path.join(pluginDir, "index.js"), "export default {}\n")
    yield* writeConfigEffect(path.join(test.directory, ".kilo"), { plugin: ["@scope/plugin"] })
    const config = yield* Config.use.get()
    expect(config.plugin ?? []).toContain("@scope/plugin")
  }),
)

it.effect("merges plugin arrays from global and local configs", () =>
  withConfigTree(
    {
      global: { plugin: ["global-plugin-1", "global-plugin-2"] },
      local: { plugin: ["local-plugin-1"] },
    },
    Effect.gen(function* () {
      const plugins = (yield* Config.use.get()).plugin ?? []
      expect(plugins.some((p) => p.includes("global-plugin-1"))).toBe(true)
      expect(plugins.some((p) => p.includes("global-plugin-2"))).toBe(true)
      expect(plugins.some((p) => p.includes("local-plugin-1"))).toBe(true)
      expect(
        plugins.filter((p) => p.includes("global-plugin") || p.includes("local-plugin")).length,
      ).toBeGreaterThanOrEqual(3)
    }),
  ),
  30_000,
)

it.effect("merges instructions arrays from global and local configs", () =>
  withConfigTree(
    {
      global: { instructions: ["global-instructions.md", "shared-rules.md"] },
      local: { instructions: ["local-instructions.md"] },
    },
    Effect.gen(function* () {
      expect((yield* Config.use.get()).instructions).toEqual([
        "global-instructions.md",
        "shared-rules.md",
        "local-instructions.md",
      ])
    }),
  ),
)

it.effect("deduplicates duplicate instructions from global and local configs", () =>
  withConfigTree(
    {
      global: { instructions: ["duplicate.md", "global-only.md"] },
      local: { instructions: ["duplicate.md", "local-only.md"] },
    },
    Effect.gen(function* () {
      expect((yield* Config.use.get()).instructions).toEqual(["duplicate.md", "global-only.md", "local-only.md"])
    }),
  ),
  30_000,
)

it.effect("deduplicates duplicate plugins from global and local configs", () =>
  withConfigTree(
    {
      global: { plugin: ["duplicate-plugin", "global-plugin-1"] },
      local: { plugin: ["duplicate-plugin", "local-plugin-1"] },
    },
    Effect.gen(function* () {
      const plugins = (yield* Config.use.get()).plugin ?? []
      expect(plugins.some((p) => p.includes("global-plugin-1"))).toBe(true)
      expect(plugins.some((p) => p.includes("local-plugin-1"))).toBe(true)
      expect(plugins.filter((p) => p.includes("duplicate-plugin")).length).toBe(1)
      expect(
        plugins.filter(
          (p) => p.includes("global-plugin") || p.includes("local-plugin") || p.includes("duplicate-plugin"),
        ).length,
      ).toBe(3)
    }),
  ),
  30_000,
)

it.effect("keeps plugin origins aligned with merged plugin list", () =>
  withConfigTree(
    {
      global: { plugin: [["shared-plugin@1.0.0", { source: "global" }], "global-only@1.0.0"] },
      local: { plugin: [["shared-plugin@2.0.0", { source: "local" }], "local-only@1.0.0"] },
    },
    Effect.gen(function* () {
      const config = yield* Config.use.get()
      const plugins = config.plugin ?? []
      const origins = config.plugin_origins ?? []
      const names = plugins.map((item) => ConfigPlugin.pluginSpecifier(item))
      expect(names).toContain("shared-plugin@2.0.0")
      expect(names).not.toContain("shared-plugin@1.0.0")
      expect(names).toContain("global-only@1.0.0")
      expect(names).toContain("local-only@1.0.0")
      expect(origins.map((item) => item.spec)).toEqual(plugins.filter((item) => !isAtomicChatPlugin(item)))
      expect(origins.find((item) => ConfigPlugin.pluginSpecifier(item.spec) === "shared-plugin@2.0.0")?.scope).toBe(
        "local",
      )
    }),
  ),
  60_000,
)




it.instance(
  "missing managed settings file is not an error",
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(config.model).toBe("user/model")
  }),
  { config: { model: "user/model" } },
)

it.instance("merges legacy tools with existing permission config", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(path.join(test.directory, ".kilo"), {
      $schema: "https://app.kilo.ai/config.json", // kilocode_change
      agent: { test: { permission: { glob: "allow" }, tools: { bash: true } } },
    })

    const config = yield* Config.use.get()
    expect(config.agent?.["test"]?.permission).toEqual({
      glob: "allow",
      bash: "allow",
    })
  }),
)

it.instance("permission config preserves user key order", () =>
  // Permission precedence follows the order users write in config, so parsing
  // must not canonicalise known keys ahead of wildcard or custom keys.
  Effect.gen(function* () {
    const test = yield* TestInstance
    const globalTmp = yield* tmpdirScoped()
    const prev = Global.Path.config
    ;(Global.Path as { config: string }).config = globalTmp
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        ;(Global.Path as { config: string }).config = prev
        yield* Config.use.invalidate()
      }),
    )
    yield* Config.use.invalidate()
    yield* writeConfigEffect(
      path.join(test.directory, ".kilo"),
      {
        $schema: "https://app.kilo.ai/config.json", // kilocode_change
        permission: {
          "*": "deny",
          edit: "ask",
          write: "ask",
          external_directory: "ask",
          read: "allow",
          todowrite: "allow",
          "thoughts_*": "allow",
          "reasoning_model_*": "allow",
          "tools_*": "allow",
          "pr_comments_*": "allow",
        },
      },
      "kilo.jsonc", // kilocode_change
    )

    const config = yield* Config.use.get()
    expect(Object.keys(config.permission!)).toEqual([
      "*",
      "edit",
      "write",
      "external_directory",
      "read",
      "todowrite",
      "thoughts_*",
      "reasoning_model_*",
      "tools_*",
      "pr_comments_*",
    ])
  }),
)

test("config parser preserves permission order while rejecting unknown top-level keys", () => {
  const config = ConfigParse.schema(
    ConfigV1.Info,
    {
      permission: {
        bash: "allow",
        "*": "deny",
        edit: "ask",
      },
    },
    "test",
  )

  expect(Object.keys(config.permission!)).toEqual(["bash", "*", "edit"])
  try {
    ConfigParse.schema(ConfigV1.Info, { invalid_field: true }, "test")
    throw new Error("expected config parse to fail")
  } catch (err) {
    const error = err as { data?: { issues?: Array<{ code?: string; keys?: string[]; path?: string[] }> } }
    expect(error.data?.issues?.[0]).toMatchObject({ code: "unrecognized_keys", keys: ["invalid_field"], path: [] })
  }
})

it.instance("local mcp accepts `env` as an alias for `environment`", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(path.join(test.directory, ".kilo"), {
      $schema: "https://app.kilo.ai/config.json",
      mcp: {
        context7: {
          type: "local",
          command: ["npx", "-y", "@upstash/context7-mcp"],
          env: { CONTEXT7_API_KEY: "test-key" },
          enabled: true,
        },
      },
    })
    const config = yield* Config.use.get()
    expect(config.mcp?.context7).toEqual({
      type: "local",
      command: ["npx", "-y", "@upstash/context7-mcp"],
      environment: { CONTEXT7_API_KEY: "test-key" },
      enabled: true,
    })
  }),
)

it.instance("local mcp prefers `environment` over `env` when both are present", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(path.join(test.directory, ".kilo"), {
      $schema: "https://app.kilo.ai/config.json",
      mcp: {
        context7: {
          type: "local",
          command: ["npx", "-y", "@upstash/context7-mcp"],
          environment: { CONTEXT7_API_KEY: "from-environment" },
          env: { CONTEXT7_API_KEY: "from-env" },
        },
      },
    })
    const config = yield* Config.use.get()
    expect(config.mcp?.context7).toEqual({
      type: "local",
      command: ["npx", "-y", "@upstash/context7-mcp"],
      environment: { CONTEXT7_API_KEY: "from-environment" },
    })
  }),
)

it.effect("project config can override MCP server enabled status", () =>
  withConfigTree(
    {
      global: {
        mcp: {
          jira: { type: "remote", url: "https://jira.example.com/mcp", enabled: false },
          wiki: { type: "remote", url: "https://wiki.example.com/mcp", enabled: false },
        },
      },
      local: {
        mcp: {
          jira: { type: "remote", url: "https://jira.example.com/mcp", enabled: true },
        },
      },
    },
    Effect.gen(function* () {
      const config = yield* Config.use.get()
      expect(config.mcp?.jira).toEqual({
        type: "remote",
        url: "https://jira.example.com/mcp",
        enabled: true,
      })
      expect(config.mcp?.wiki).toEqual({
        type: "remote",
        url: "https://wiki.example.com/mcp",
        enabled: false,
      })
    }),
  ),
  30_000,
)

it.effect("MCP config deep merges preserving base config properties", () =>
  withConfigTree(
    {
      global: {
        mcp: {
          myserver: {
            type: "remote",
            url: "https://myserver.example.com/mcp",
            enabled: false,
            headers: { "X-Custom-Header": "value" },
          },
        },
      },
      local: {
        mcp: {
          myserver: {
            type: "remote",
            url: "https://myserver.example.com/mcp",
            enabled: true,
          },
        },
      },
    },
    Effect.gen(function* () {
      const config = yield* Config.use.get()
      expect(config.mcp?.myserver).toEqual({
        type: "remote",
        url: "https://myserver.example.com/mcp",
        enabled: true,
        headers: { "X-Custom-Header": "value" },
      })
    }),
  ),
  30_000,
)

it.effect("local .kilo config can override MCP from project config", () =>
  withConfigTree(
    {
      global: {
        mcp: {
          docs: { type: "remote", url: "https://docs.example.com/mcp", enabled: false },
        },
      },
      local: {
        mcp: {
          docs: { type: "remote", url: "https://docs.example.com/mcp", enabled: true },
        },
      },
    },
    Effect.gen(function* () {
      const config = yield* Config.use.get()
      expect(config.mcp?.docs?.enabled).toBe(true)
    }),
  ),
  30_000,
)

describe("resolvePluginSpec", () => {
  test("keeps package specs unchanged", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "kilo.jsonc") // kilocode_change
    expect(await ConfigPlugin.resolvePluginSpec("oh-my-opencode@2.4.3", file)).toBe("oh-my-opencode@2.4.3")
    expect(await ConfigPlugin.resolvePluginSpec("@scope/pkg", file)).toBe("@scope/pkg")
  })

  test("resolves windows-style relative plugin directory specs", async () => {
    if (process.platform !== "win32") return

    await using tmp = await tmpdir({
      init: async (dir) => {
        const plugin = path.join(dir, "plugin")
        await fs.mkdir(plugin, { recursive: true })
        await Filesystem.write(path.join(plugin, "index.ts"), "export default {}")
      },
    })

    const file = path.join(tmp.path, "opencode.json")
    const hit = await ConfigPlugin.resolvePluginSpec(".\\plugin", file)
    expect(ConfigPlugin.pluginSpecifier(hit)).toBe(pathToFileURL(path.join(tmp.path, "plugin", "index.ts")).href)
  })

  test("resolves relative file plugin paths to file urls", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "plugin.ts"), "export default {}")
      },
    })

    const file = path.join(tmp.path, "kilo.jsonc") // kilocode_change
    const hit = await ConfigPlugin.resolvePluginSpec("./plugin.ts", file)
    expect(ConfigPlugin.pluginSpecifier(hit)).toBe(pathToFileURL(path.join(tmp.path, "plugin.ts")).href)
  })

  test("resolves plugin directory paths to directory urls", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const plugin = path.join(dir, "plugin")
        await fs.mkdir(plugin, { recursive: true })
        await Filesystem.writeJson(path.join(plugin, "package.json"), {
          name: "demo-plugin",
          type: "module",
          main: "./index.ts",
        })
        await Filesystem.write(path.join(plugin, "index.ts"), "export default {}")
      },
    })

    const file = path.join(tmp.path, "kilo.jsonc") // kilocode_change
    const hit = await ConfigPlugin.resolvePluginSpec("./plugin", file)
    expect(ConfigPlugin.pluginSpecifier(hit)).toBe(pathToFileURL(path.join(tmp.path, "plugin")).href)
  })

  test("resolves plugin directories without package.json to index.ts", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const plugin = path.join(dir, "plugin")
        await fs.mkdir(plugin, { recursive: true })
        await Filesystem.write(path.join(plugin, "index.ts"), "export default {}")
      },
    })

    const file = path.join(tmp.path, "opencode.json")
    const hit = await ConfigPlugin.resolvePluginSpec("./plugin", file)
    expect(ConfigPlugin.pluginSpecifier(hit)).toBe(pathToFileURL(path.join(tmp.path, "plugin", "index.ts")).href)
  })
})

describe("deduplicatePluginOrigins", () => {
  const dedupe = (plugins: ConfigPluginV1.Spec[]) =>
    ConfigPlugin.deduplicatePluginOrigins(
      plugins.map((spec) => ({
        spec,
        source: "",
        scope: "global" as const,
      })),
    ).map((item) => item.spec)

  test("removes duplicates keeping higher priority (later entries)", () => {
    const plugins = ["global-plugin@1.0.0", "shared-plugin@1.0.0", "local-plugin@2.0.0", "shared-plugin@2.0.0"]

    const result = dedupe(plugins)

    expect(result).toContain("global-plugin@1.0.0")
    expect(result).toContain("local-plugin@2.0.0")
    expect(result).toContain("shared-plugin@2.0.0")
    expect(result).not.toContain("shared-plugin@1.0.0")
    expect(result.length).toBe(3)
  })

  test("keeps path plugins separate from package plugins", () => {
    const plugins = ["oh-my-opencode@2.4.3", "file:///project/.kilo/plugin/oh-my-opencode.js"] // kilocode_change

    const result = dedupe(plugins)

    expect(result).toEqual(plugins)
  })

  test("deduplicates direct path plugins by exact spec", () => {
    const plugins = ["file:///project/.kilo/plugin/demo.ts", "file:///project/.kilo/plugin/demo.ts"] // kilocode_change

    const result = dedupe(plugins)

    expect(result).toEqual(["file:///project/.kilo/plugin/demo.ts"]) // kilocode_change
  })

  test("preserves order of remaining plugins", () => {
    const plugins = ["a-plugin@1.0.0", "b-plugin@1.0.0", "c-plugin@1.0.0"]

    const result = dedupe(plugins)

    expect(result).toEqual(["a-plugin@1.0.0", "b-plugin@1.0.0", "c-plugin@1.0.0"])
  })

  it.effect("loads auto-discovered local plugins as file urls", () =>
    withConfigTree(
      { global: { plugin: ["my-plugin@1.0.0"] } },
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* FSUtil.use.writeWithDirs(
          path.join(test.directory, ".kilo", "plugin", "my-plugin.js"), // kilocode_change
          "export default {}",
        )

        const plugins = (yield* Config.use.get()).plugin ?? []
        expect(plugins.some((p) => ConfigPlugin.pluginSpecifier(p) === "my-plugin@1.0.0")).toBe(true)
        expect(plugins.some((p) => ConfigPlugin.pluginSpecifier(p).startsWith("file://"))).toBe(true)
      }),
    ),
  )
})
