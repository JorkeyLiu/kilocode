import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { Npm } from "@opencode-ai/core/npm"
import { HttpClient } from "effect/unstable/http"
import { Account } from "@/account/account"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Env } from "@/env"
import { Git } from "@/git"
import {
  getE2EProviderFragment,
  isValidE2EBaseURL,
  isValidE2EScratch,
  E2E_FIXTURE_CONSTANTS,
  isE2EFixtureEnabled,
  E2E_MARKER_FILENAME,
  validateE2EFixtureMarkerForTest,
} from "@/kilocode/config/e2e-provider"
import { provideTmpdirInstance, tmpdir } from "../fixture/fixture"
import { Flag } from "@opencode-ai/core/flag/flag"
import fs from "node:fs"
import os from "node:os"

const infra = CrossSpawnSpawner.defaultLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
)
const emptyAccount = Layer.mock(Account.Service, {
  active: () => Effect.succeed(Option.none()),
  activeOrg: () => Effect.succeed(Option.none()),
})
const emptyAuth = Layer.mock(Auth.Service, { all: () => Effect.succeed({}) })
const noopNpm = Layer.mock(Npm.Service, {
  install: () => Effect.void,
  add: () => Effect.die("not implemented"),
  which: () => Effect.succeed(Option.none()),
})
const unexpectedHttp = HttpClient.make((request) =>
  Effect.die(`unexpected http request: ${request.method} ${request.url}`),
)
const configLayer = Config.layer.pipe(
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

function saveEnv() {
  const keys = ["KILO_E2E_FIXTURE", "KILO_E2E_SCRATCH", "KILO_E2E_PROVIDER_BASE_URL", "KILO_E2E_FIXTURE_ID"] as const
  const saved: Record<string, string | undefined> = {}
  for (const k of keys) saved[k] = process.env[k]
  return saved
}
function restoreEnv(saved: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

function makeScratch(fixtureId: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-e2e-"))
  fs.writeFileSync(path.join(dir, E2E_MARKER_FILENAME), JSON.stringify({ v: 1, fixtureId }))
  return dir
}
function cleanupScratch(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {}
}

describe("e2e-provider seam gating", () => {
  test("ignored when gates absent", () => {
    const saved = saveEnv()
    try {
      delete process.env.KILO_E2E_FIXTURE
      delete process.env.KILO_E2E_SCRATCH
      delete process.env.KILO_E2E_PROVIDER_BASE_URL
      expect(getE2EProviderFragment()).toBeNull()
      expect(isValidE2EBaseURL(undefined)).toBeFalse()
      expect(isValidE2EScratch(undefined)).toBeFalse()
    } finally {
      restoreEnv(saved)
    }
  })

  test("rejected for non-loopback", () => {
    const saved = saveEnv()
    const fid = "test-fid-reject-loopback"
    const scratch = makeScratch(fid)
    try {
      process.env.KILO_E2E_FIXTURE = "1"
      process.env.KILO_E2E_SCRATCH = scratch
      process.env.KILO_E2E_FIXTURE_ID = fid
      process.env.KILO_E2E_PROVIDER_BASE_URL = "http://example.com/v1"
      expect(getE2EProviderFragment()).toBeNull()
      expect(isValidE2EBaseURL("http://example.com/v1")).toBeFalse()
      expect(isValidE2EBaseURL("http://192.168.1.1:3000/v1")).toBeFalse()
    } finally {
      cleanupScratch(scratch)
      restoreEnv(saved)
    }
  })

  test("rejected for invalid path/scratch", () => {
    const saved = saveEnv()
    try {
      process.env.KILO_E2E_FIXTURE = "1"
      process.env.KILO_E2E_SCRATCH = "relative/path"
      process.env.KILO_E2E_PROVIDER_BASE_URL = "http://127.0.0.1:3000/v1"
      expect(getE2EProviderFragment()).toBeNull()
      expect(isValidE2EScratch("relative/path")).toBeFalse()
      expect(isValidE2EScratch("")).toBeFalse()
      const fid = "test-fid-invalid-path"
      const scratch = makeScratch(fid)
      try {
        process.env.KILO_E2E_SCRATCH = scratch
        process.env.KILO_E2E_FIXTURE_ID = fid
        process.env.KILO_E2E_PROVIDER_BASE_URL = "http://127.0.0.1:3000/notv1"
        expect(getE2EProviderFragment()).toBeNull()
      } finally {
        cleanupScratch(scratch)
      }
      expect(isValidE2EBaseURL("http://127.0.0.1:3000/notv1")).toBeFalse()
      expect(isValidE2EBaseURL("http://127.0.0.1:3000/v1?query=1")).toBeFalse()
      expect(isValidE2EBaseURL("http://127.0.0.1:3000/v1#hash")).toBeFalse()
      expect(isValidE2EBaseURL("http://user:pass@127.0.0.1:3000/v1")).toBeFalse()
      expect(isValidE2EBaseURL("https://127.0.0.1:3000/v1")).toBeTrue()
      expect(isValidE2EBaseURL("http://localhost:4000/v1")).toBeTrue()
    } finally {
      restoreEnv(saved)
    }
  })

  test("fixed exact provider/model", () => {
    const saved = saveEnv()
    const fid = "test-fid-fixed"
    const scratch = makeScratch(fid)
    try {
      process.env.KILO_E2E_FIXTURE = "1"
      process.env.KILO_E2E_SCRATCH = scratch
      process.env.KILO_E2E_FIXTURE_ID = fid
      process.env.KILO_E2E_PROVIDER_BASE_URL = "http://127.0.0.1:1234/v1"
      const frag = getE2EProviderFragment()
      expect(frag).not.toBeNull()
      expect(frag!.model).toBe(E2E_FIXTURE_CONSTANTS.modelString)
      expect(frag!.small_model).toBe(E2E_FIXTURE_CONSTANTS.modelString)
      expect(frag!.subagent_model).toBe(E2E_FIXTURE_CONSTANTS.modelString)
      const prov = frag!.provider![E2E_FIXTURE_CONSTANTS.providerId] as unknown as Record<string, unknown>
      expect(prov.npm).toBe(E2E_FIXTURE_CONSTANTS.npm)
      const opts = prov.options as Record<string, unknown>
      expect(opts.baseURL).toBe("http://127.0.0.1:1234/v1")
      expect(opts.apiKey).toBe(E2E_FIXTURE_CONSTANTS.apiKey)
      const models = prov.models as Record<string, unknown>
      expect(models[E2E_FIXTURE_CONSTANTS.modelId]).toBeDefined()
    } finally {
      cleanupScratch(scratch)
      restoreEnv(saved)
    }
  })

  test("no public Flag/export", () => {
    // No new Flag should exist for E2E seam
    const flagKeys = Object.keys(Flag)
    expect(flagKeys.some((k) => k.includes("E2E") || k.includes("e2e"))).toBeFalse()
    // Module should not export arbitrary JSON/config payload
    const mod = require("@/kilocode/config/e2e-provider") as Record<string, unknown>
    expect(typeof mod.getE2EProviderFragment).toBe("function")
    expect("KILO_CONFIG_CONTENT" in mod).toBeFalse()
  })
})

describe("e2e-provider exact fixture activation", () => {
  test("only 1 activates, absent/empty/0 do not", () => {
    const saved = saveEnv()
    const fid = "test-fid-exact"
    const scratch = makeScratch(fid)
    try {
      delete process.env.KILO_E2E_FIXTURE
      process.env.KILO_E2E_SCRATCH = scratch
      process.env.KILO_E2E_FIXTURE_ID = fid
      process.env.KILO_E2E_PROVIDER_BASE_URL = "http://127.0.0.1:9999/v1"
      expect(isE2EFixtureEnabled()).toBeFalse()
      expect(getE2EProviderFragment()).toBeNull()
      process.env.KILO_E2E_FIXTURE = ""
      expect(isE2EFixtureEnabled()).toBeFalse()
      expect(getE2EProviderFragment()).toBeNull()
      process.env.KILO_E2E_FIXTURE = "0"
      expect(isE2EFixtureEnabled()).toBeFalse()
      expect(getE2EProviderFragment()).toBeNull()
      process.env.KILO_E2E_FIXTURE = "true"
      expect(isE2EFixtureEnabled()).toBeFalse()
      expect(getE2EProviderFragment()).toBeNull()
      process.env.KILO_E2E_FIXTURE = "1"
      expect(isE2EFixtureEnabled()).toBeTrue()
      expect(getE2EProviderFragment()).not.toBeNull()
    } finally {
      cleanupScratch(scratch)
      restoreEnv(saved)
    }
  })

  test("arbitrary absolute scratch without marker rejected, marker mismatch rejected, correct marker accepted", () => {
    const saved = saveEnv()
    try {
      process.env.KILO_E2E_FIXTURE = "1"
      process.env.KILO_E2E_PROVIDER_BASE_URL = "http://127.0.0.1:9999/v1"
      // arbitrary /tmp without marker
      process.env.KILO_E2E_SCRATCH = "/tmp"
      delete process.env.KILO_E2E_FIXTURE_ID
      expect(isValidE2EScratch("/tmp")).toBeFalse()
      expect(getE2EProviderFragment()).toBeNull()
      // arbitrary absolute with wrong shape
      const bad = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-test-"))
      try {
        fs.writeFileSync(path.join(bad, E2E_MARKER_FILENAME), JSON.stringify({ v: 1, fixtureId: "fid-bad" }))
        process.env.KILO_E2E_SCRATCH = bad
        process.env.KILO_E2E_FIXTURE_ID = "fid-bad"
        expect(isValidE2EScratch(bad)).toBeFalse()
        expect(getE2EProviderFragment()).toBeNull()
      } finally {
        cleanupScratch(bad)
      }
      // correct shape but marker mismatch
      const good = makeScratch("fid-good")
      try {
        process.env.KILO_E2E_SCRATCH = good
        process.env.KILO_E2E_FIXTURE_ID = "wrong-fid"
        expect(isValidE2EScratch(good)).toBeFalse()
        expect(getE2EProviderFragment()).toBeNull()
        process.env.KILO_E2E_FIXTURE_ID = "fid-good"
        expect(isValidE2EScratch(good)).toBeTrue()
        expect(getE2EProviderFragment()).not.toBeNull()
      } finally {
        cleanupScratch(good)
      }
    } finally {
      restoreEnv(saved)
    }
  })
})

describe("e2e-provider marker strictness", () => {
  test("rejects missing version, wrong version, empty fixtureId, mismatch, accepts valid", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-e2e-"))
    try {
      fs.writeFileSync(path.join(dir, E2E_MARKER_FILENAME), JSON.stringify({ fixtureId: "fid" }))
      expect(validateE2EFixtureMarkerForTest(dir, "fid")).toBeFalse()
      fs.writeFileSync(path.join(dir, E2E_MARKER_FILENAME), JSON.stringify({ v: 2, fixtureId: "fid" }))
      expect(validateE2EFixtureMarkerForTest(dir, "fid")).toBeFalse()
      fs.writeFileSync(path.join(dir, E2E_MARKER_FILENAME), JSON.stringify({ v: 1, fixtureId: "" }))
      expect(validateE2EFixtureMarkerForTest(dir, "")).toBeFalse()
      fs.writeFileSync(path.join(dir, E2E_MARKER_FILENAME), JSON.stringify({ v: 1, fixtureId: "fid" }))
      expect(validateE2EFixtureMarkerForTest(dir, "wrong")).toBeFalse()
      expect(validateE2EFixtureMarkerForTest(dir, "fid")).toBeTrue()
    } finally {
      cleanupScratch(dir)
    }
  })
  test("rejects extra marker key createdAt via exact marker validator", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-e2e-"))
    try {
      fs.writeFileSync(
        path.join(dir, E2E_MARKER_FILENAME),
        JSON.stringify({ v: 1, fixtureId: "fid", createdAt: "2026-08-30" }),
      )
      expect(validateE2EFixtureMarkerForTest(dir, "fid")).toBeFalse()
      fs.writeFileSync(path.join(dir, E2E_MARKER_FILENAME), JSON.stringify({ v: 1, fixtureId: "fid" }))
      expect(validateE2EFixtureMarkerForTest(dir, "fid")).toBeTrue()
    } finally {
      cleanupScratch(dir)
    }
  })
})

describe("e2e-provider Config.Service isolated", () => {
  test(
    "real Config.Service merge: synthetic lowest priority, project wins, backend options survive, small_model pinned, dormant injects nothing",
    async () => {
      const saved = saveEnv()
      const fid = "test-fid-merge-isolated"
      const scratch = makeScratch(fid)
      // isolated global/project via Global.Path mutation + Instance
      const globalTmp = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-global-"))
      const projectTmp = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-proj-"))
      const prevConfig = (Global.Path as unknown as { config: string }).config
      ;(Global.Path as unknown as { config: string }).config = globalTmp
      const clear = () =>
        Effect.runPromise(
          Config.Service.use((svc) => svc.invalidate()).pipe(Effect.scoped, Effect.provide(configLayer)),
        )
      await clear()
      const { disposeAllInstances } = await import("../fixture/fixture")
      await disposeAllInstances()
      try {
        // global canonical: set small_model to something else to prove synthetic wins over absent but project wins over synthetic
        fs.writeFileSync(path.join(globalTmp, "kilo.jsonc"), JSON.stringify({ model: "global/model" }))
        // project canonical with intentional conflict: defines same provider id with different display name and endpoint, should win over synthetic
        const projKiloDir = path.join(projectTmp, ".kilo")
        fs.mkdirSync(projKiloDir, { recursive: true })
        fs.writeFileSync(
          path.join(projKiloDir, "kilo.jsonc"),
          JSON.stringify({
            model: "proj/model",
            provider: {
              "e2e-local": {
                name: "Project E2E Local Override",
                models: { "e2e-model": { name: "Project Model" } },
              },
            },
          }),
        )
        // activate E2E
        process.env.KILO_E2E_FIXTURE = "1"
        process.env.KILO_E2E_SCRATCH = scratch
        process.env.KILO_E2E_FIXTURE_ID = fid
        process.env.KILO_E2E_PROVIDER_BASE_URL = "http://127.0.0.1:9999/v1"
        const { provideTestInstance } = await import("../fixture/fixture")
        const loaded = await provideTestInstance({
          directory: projectTmp,
          fn: async () => {
            return await Effect.runPromise(
              Config.Service.use((svc) => svc.get()).pipe(Effect.scoped, Effect.provide(configLayer)),
            )
          },
        })
        // synthetic fragment lowest priority: project canonical fields win
        expect(loaded.model).toBe("proj/model")
        // backend options survive (synthetic provider options)
        const prov = (loaded.provider as Record<string, unknown>)?.["e2e-local"] as Record<string, unknown> | undefined
        expect(prov).toBeDefined()
        const opts = (prov?.options ?? prov) as Record<string, unknown>
        // synthetic baseURL must survive (project did not override baseURL)
        const baseURL = (opts.baseURL ?? (prov?.options as Record<string, unknown>)?.baseURL) as string | undefined
        expect(baseURL).toBe("http://127.0.0.1:9999/v1")
        // project name override wins
        expect(prov?.name).toBe("Project E2E Local Override")
        // small_model pins run-owned model
        expect(loaded.small_model).toBe("e2e-local/e2e-model")
        // ensure synthetic npm and apiKey survive via provider
        const provAny = prov as Record<string, unknown>
        if (provAny.options) {
          expect((provAny.options as Record<string, unknown>).apiKey).toBe("e2e-fixture-key")
        }
        // dormant: clear env and reload should inject nothing synthetic
        delete process.env.KILO_E2E_FIXTURE
        delete process.env.KILO_E2E_FIXTURE_ID
        await clear()
        await disposeAllInstances()
        const dormant = await provideTestInstance({
          directory: projectTmp,
          fn: async () => {
            return await Effect.runPromise(
              Config.Service.use((svc) => svc.get()).pipe(Effect.scoped, Effect.provide(configLayer)),
            )
          },
        })
        // project-defined provider remains, but synthetic keys (apiKey/baseURL) absent and small_model not pinned
        const dormantProv = (dormant.provider as Record<string, unknown>)?.["e2e-local"] as
          | Record<string, unknown>
          | undefined
        if (dormantProv?.options) {
          expect((dormantProv.options as Record<string, unknown>).apiKey).toBeUndefined()
          expect((dormantProv.options as Record<string, unknown>).baseURL).toBeUndefined()
        } else if (dormantProv) {
          expect((dormantProv as Record<string, unknown>).apiKey).toBeUndefined()
        }
        expect(dormant.small_model).not.toBe("e2e-local/e2e-model")
        // invalid gate: wrong fixture id should also inject nothing synthetic
        process.env.KILO_E2E_FIXTURE = "1"
        process.env.KILO_E2E_SCRATCH = scratch
        process.env.KILO_E2E_FIXTURE_ID = "wrong-id"
        process.env.KILO_E2E_PROVIDER_BASE_URL = "http://127.0.0.1:9999/v1"
        await clear()
        await disposeAllInstances()
        const invalid = await provideTestInstance({
          directory: projectTmp,
          fn: async () => {
            return await Effect.runPromise(
              Config.Service.use((svc) => svc.get()).pipe(Effect.scoped, Effect.provide(configLayer)),
            )
          },
        })
        const invalidProv = (invalid.provider as Record<string, unknown>)?.["e2e-local"] as
          | Record<string, unknown>
          | undefined
        if (invalidProv?.options) {
          expect((invalidProv.options as Record<string, unknown>).apiKey).toBeUndefined()
        } else if (invalidProv) {
          expect((invalidProv as Record<string, unknown>).apiKey).toBeUndefined()
        }
        expect(invalid.small_model).not.toBe("e2e-local/e2e-model")
      } finally {
        ;(Global.Path as unknown as { config: string }).config = prevConfig
        await clear().catch(() => {})
        const { disposeAllInstances: d2 } = await import("../fixture/fixture")
        await d2().catch(() => {})
        cleanupScratch(scratch)
        try {
          fs.rmSync(globalTmp, { recursive: true, force: true })
        } catch {}
        try {
          fs.rmSync(projectTmp, { recursive: true, force: true })
        } catch {}
        restoreEnv(saved)
      }
    },
    { timeout: 15_000 },
  )
})
