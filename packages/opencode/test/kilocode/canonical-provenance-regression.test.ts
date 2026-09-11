import { describe, expect, test, afterEach } from "bun:test"
import { Effect, Deferred, Fiber } from "effect"
import { Global } from "@opencode-ai/core/global"
import { Config } from "@/config/config"
import { ConfigParse } from "@/config/parse"
import { CanonicalResolver } from "@/kilocode/provider/canonical-resolver"
import { withConfigSnapshot } from "@/kilocode/session/config-snapshot"
import { withGenerationAdmission } from "@/kilocode/session/generation-admission"
import { GenerationGate } from "@/kilocode/server/generation-gate"
import { InstanceStore } from "@/project/instance-store"
import { GlobalBus } from "@/bus/global"
import { Server } from "@/server/server"
import { AppRuntime } from "@/effect/app-runtime"
import { provideInstance, tmpdir, disposeAllInstances } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import * as Log from "@opencode-ai/core/util/log"
import path from "path"
import fs from "fs/promises"

void Log.init({ print: false })

const originalConfig = Global.Path.config

afterEach(async () => {
  ;(Global.Path as { config: string }).config = originalConfig
  GlobalBus.removeAllListeners("event")
  await disposeAllInstances()
  await resetDatabase()
})

function writeGlobal(dir: string, data: unknown) {
  return fs.writeFile(path.join(dir, "kilo.jsonc"), JSON.stringify(data))
}
function writeProject(dir: string, data: unknown) {
  return fs.writeFile(path.join(dir, ".kilo", "kilo.jsonc"), JSON.stringify(data))
}
async function ensureProjectDir(dir: string) {
  await fs.mkdir(path.join(dir, ".kilo"), { recursive: true })
}

describe("canonical provenance regression (F1-F7)", () => {
  test("global/project distinct providers exact scope/source/intact models", async () => {
    const g = await tmpdir()
    const p = await tmpdir({ git: true })
    try {
      ;(Global.Path as { config: string }).config = g.path
      await writeGlobal(g.path, {
        $schema: "https://app.kilo.ai/config.json",
        provider: {
          "g-only": {
            name: "G",
            endpoint: "https://g.example.com",
            protocol: "openai/completions",
            credential: "secret:kilo.credentials.global.provider.g-only",
            models: { "m1": { name: "Model 1" }, "m2": { name: "M2", variants: { v1: { enable_thinking: true } } } },
          },
        },
      })
      await ensureProjectDir(p.path)
      await writeProject(p.path, {
        $schema: "https://app.kilo.ai/config.json",
        provider: {
          "p-only": {
            name: "P",
            endpoint: "https://p.example.com",
            protocol: "openai/responses",
            credential: "secret:kilo.credentials.project.provider.p-only",
            models: { "pm1": { name: "PM1" } },
          },
        },
      })
      const provenance = await AppRuntime.runPromise(
        provideInstance(p.path)(
          Effect.gen(function* () {
            const config = yield* Config.Service
            return yield* config.getCanonicalProvenance()
          }),
        ),
      )
      expect(Object.hasOwn(provenance.providers, "g-only")).toBe(true)
      expect(Object.hasOwn(provenance.providers, "p-only")).toBe(true)
      expect(provenance.providers["g-only"].scope).toBe("global")
      expect(provenance.providers["g-only"].source).toBe(path.join(g.path, "kilo.jsonc"))
      expect(provenance.providers["p-only"].scope).toBe("project")
      expect(provenance.providers["p-only"].source).toBe(path.join(p.path, ".kilo", "kilo.jsonc"))
      expect((provenance.providers["g-only"].record as unknown as { models: Record<string, unknown> }).models["m1"]).toBeDefined()
      expect((provenance.providers["g-only"].record as unknown as { models: Record<string, unknown> }).models["m2"]).toBeDefined()
      expect((provenance.providers["p-only"].record as unknown as { models: Record<string, unknown> }).models["pm1"]).toBeDefined()
      expect(provenance.conflicts.length).toBe(0)
      const withCanon = await AppRuntime.runPromise(
        provideInstance(p.path)(
          Effect.gen(function* () {
            const cfg = yield* Config.Service
            const snap = yield* cfg.getWithCanonical()
            const r = yield* CanonicalResolver.resolveFromSnapshot(snap.canonical, "g-only", "m1")
            return r
          }),
        ),
      )
      expect(withCanon.providerId).toBe("g-only")
      expect(withCanon.scope).toBe("global")
      expect(withCanon.credentialRef).toBe("secret:kilo.credentials.global.provider.g-only")
    } finally {
      await p[Symbol.asyncDispose]()
      await g[Symbol.asyncDispose]()
    }
  })

  test("duplicate valid+valid suppress both, conflict decisive, Frankenstein never used", async () => {
    const g = await tmpdir()
    const p = await tmpdir({ git: true })
    try {
      ;(Global.Path as { config: string }).config = g.path
      await writeGlobal(g.path, {
        provider: {
          dup: {
            endpoint: "https://global.example.com",
            protocol: "openai/completions",
            credential: "secret:kilo.credentials.global.provider.dup",
            models: { "m1": { name: "M1 global" } },
          },
        },
      })
      await ensureProjectDir(p.path)
      await writeProject(p.path, {
        provider: {
          dup: {
            endpoint: "https://project.example.com",
            protocol: "openai/responses",
            credential: "secret:kilo.credentials.project.provider.dup",
            models: { "m2": { name: "M2 project" } },
          },
        },
      })
      const provenance = await AppRuntime.runPromise(
        provideInstance(p.path)(
          Effect.gen(function* () {
            const cfg = yield* Config.Service
            return yield* cfg.getCanonicalProvenance()
          }),
        ),
      )
      expect(Object.hasOwn(provenance.providers, "dup")).toBe(false)
      const dupConflict = provenance.conflicts.find((c) => c.id === "dup")
      expect(dupConflict).toBeDefined()
      expect(dupConflict?.reason).toBe("duplicate")
      const err = await AppRuntime.runPromise(
        provideInstance(p.path)(
          Effect.gen(function* () {
            const cfg = yield* Config.Service
            const prov = yield* cfg.getCanonicalProvenance()
            return yield* CanonicalResolver.resolveFromSnapshot(prov, "dup", "m1").pipe(Effect.flip)
          }),
        ),
      )
      expect(err._tag).toBe("CanonicalConflictError")
      const err2 = await AppRuntime.runPromise(
        provideInstance(p.path)(
          Effect.gen(function* () {
            const cfg = yield* Config.Service
            const prov = yield* cfg.getCanonicalProvenance()
            return yield* CanonicalResolver.resolveFromSnapshot(prov, "dup", "m2").pipe(Effect.flip)
          }),
        ),
      )
      expect(err2._tag).toBe("CanonicalConflictError")
    } finally {
      await p[Symbol.asyncDispose]()
      await g[Symbol.asyncDispose]()
    }
  })

  test("duplicate valid+invalid suppress both (decisive)", async () => {
    const g = await tmpdir()
    const p = await tmpdir({ git: true })
    try {
      ;(Global.Path as { config: string }).config = g.path
      await writeGlobal(g.path, {
        provider: {
          dup2: {
            endpoint: "https://global.example.com",
            protocol: "openai/completions",
            credential: "secret:kilo.credentials.global.provider.dup2",
            models: { "m1": { name: "M1" } },
          },
        },
      })
      await ensureProjectDir(p.path)
      await writeProject(p.path, {
        provider: {
          dup2: {
            endpoint: "https://project.example.com",
            protocol: "openai/completions",
            models: { "m1": { name: "M1" } },
          },
        },
      })
      const prov = await AppRuntime.runPromise(
        provideInstance(p.path)(
          Effect.gen(function* () {
            const cfg = yield* Config.Service
            return yield* cfg.getCanonicalProvenance()
          }),
        ),
      )
      expect(Object.hasOwn(prov.providers, "dup2")).toBe(false)
      const c = prov.conflicts.find((x) => x.id === "dup2")
      expect(c?.reason).toBe("duplicate")
      const err = await AppRuntime.runPromise(
        provideInstance(p.path)(
          Effect.gen(function* () {
            const cfg = yield* Config.Service
            const pr = yield* cfg.getCanonicalProvenance()
            return yield* CanonicalResolver.resolveFromSnapshot(pr, "dup2", "m1").pipe(Effect.flip)
          }),
        ),
      )
      expect(err._tag).toBe("CanonicalConflictError")
      expect((err as unknown as { reason: string }).reason).toBe("duplicate")
    } finally {
      await p[Symbol.asyncDispose]()
      await g[Symbol.asyncDispose]()
    }
  })

  test("credential conflicts and invalid endpoint/protocol/models with safe text", async () => {
    const g = await tmpdir()
    const p = await tmpdir({ git: true })
    try {
      ;(Global.Path as { config: string }).config = g.path
      await writeGlobal(g.path, {
        provider: {
          "missing-cred": { endpoint: "https://e.test", protocol: "openai/completions", models: { m1: { name: "M1" } } },
          "nonstring-cred": { endpoint: "https://e.test", protocol: "openai/completions", credential: 123, models: { m1: { name: "M1" } } } as unknown,
          "malformed-cred": { endpoint: "https://e.test", protocol: "openai/completions", credential: "not-a-ref", models: { m1: { name: "M1" } } },
          "wrong-kind": { endpoint: "https://e.test", protocol: "openai/completions", credential: "secret:kilo.credentials.global.mcp.wrong-kind", models: { m1: { name: "M1" } } },
          "scope-mismatch": { endpoint: "https://e.test", protocol: "openai/completions", credential: "secret:kilo.credentials.project.provider.scope-mismatch", models: { m1: { name: "M1" } } },
          "id-mismatch": { endpoint: "https://e.test", protocol: "openai/completions", credential: "secret:kilo.credentials.global.provider.other-id", models: { m1: { name: "M1" } } },
          "bad-endpoint": { endpoint: "ftp://bad", protocol: "openai/completions", credential: "secret:kilo.credentials.global.provider.bad-endpoint", models: { m1: { name: "M1" } } },
          "bad-protocol": { endpoint: "https://e.test", protocol: "unknown/proto" as unknown, credential: "secret:kilo.credentials.global.provider.bad-protocol", models: { m1: { name: "M1" } } } as unknown,
          "bad-models": { endpoint: "https://e.test", protocol: "openai/completions", credential: "secret:kilo.credentials.global.provider.bad-models", models: {} as unknown },
          "bad-shape": { endpoint: "https://e.test", protocol: "openai/completions", credential: "secret:kilo.credentials.global.provider.bad-shape", models: { m1: { name: "M1" } }, extra: "nope" } as unknown,
        },
      })
      await ensureProjectDir(p.path)
      await fs.writeFile(path.join(p.path, ".kilo", "kilo.jsonc"), JSON.stringify({ $schema: "https://app.kilo.ai/config.json" }))
      const prov = await AppRuntime.runPromise(
        provideInstance(p.path)(
          Effect.gen(function* () {
            const cfg = yield* Config.Service
            return yield* cfg.getCanonicalProvenance()
          }),
        ),
      )
      const byId = (id: string) => prov.conflicts.find((c) => c.id === id)
      expect(byId("missing-cred")?.reason).toBe("missing-credential")
      expect(byId("nonstring-cred")?.reason).toBe("malformed-credential")
      expect(byId("malformed-cred")?.reason).toBe("malformed-credential")
      expect(byId("wrong-kind")?.reason).toBe("malformed-credential")
      expect(byId("scope-mismatch")?.reason).toBe("scope-mismatch")
      expect(byId("id-mismatch")?.reason).toBe("id-mismatch")
      expect(byId("bad-endpoint")?.reason).toBe("invalid-endpoint")
      expect(byId("bad-protocol")?.reason).toBe("unknown-protocol")
      const bm = byId("bad-models")
      expect(["invalid-models", "invalid-record"].includes(bm?.reason ?? "")).toBe(true)
      expect(byId("bad-shape")?.reason).toBe("invalid-record")
      const secret = "secret:kilo.credentials.global.provider.missing-cred"
      for (const c of prov.conflicts) {
        expect(c.message.includes(secret)).toBe(false)
      }
      const warnings = await AppRuntime.runPromise(
        provideInstance(p.path)(
          Effect.gen(function* () {
            const cfg = yield* Config.Service
            return yield* cfg.warnings()
          }),
        ),
      )
      for (const w of warnings) {
        expect(w.message.includes("secret:")).toBe(false)
      }
    } finally {
      await p[Symbol.asyncDispose]()
      await g[Symbol.asyncDispose]()
    }
  })

  test("resolver success, notFound, conflict, modelNotFound, inherited IDs", async () => {
    const g = await tmpdir()
    const p = await tmpdir({ git: true })
    try {
      ;(Global.Path as { config: string }).config = g.path
      await writeGlobal(g.path, {
        provider: {
          ok: {
            endpoint: "https://ok.test",
            protocol: "openai/completions",
            credential: "secret:kilo.credentials.global.provider.ok",
            models: { "m1": { name: "M1" }, "m2": { name: "M2" } },
          },
          conflicted: {
            endpoint: "https://c.test",
            protocol: "openai/completions",
            credential: "secret:kilo.credentials.global.provider.conflicted",
            models: { m1: { name: "M1" } },
          },
        },
      })
      await ensureProjectDir(p.path)
      await writeProject(p.path, {
        provider: {
          conflicted: {
            endpoint: "https://c2.test",
            protocol: "openai/completions",
            credential: "secret:kilo.credentials.project.provider.conflicted",
            models: { m1: { name: "M1" } },
          },
        },
      })
      await disposeAllInstances()
      const okRes = await AppRuntime.runPromise(
        provideInstance(p.path)(
          Effect.gen(function* () {
            const cfg = yield* Config.Service
            const pr = yield* cfg.getCanonicalProvenance()
            return yield* CanonicalResolver.resolveFromSnapshot(pr, "ok", "m1")
          }),
        ),
      )
      expect(okRes.providerId).toBe("ok")
      expect(okRes.modelId).toBe("m1")
      expect((okRes.record as unknown as Record<string, unknown>).endpoint).toBe("https://ok.test")
      const nf = await AppRuntime.runPromise(
        provideInstance(p.path)(
          Effect.gen(function* () {
            const cfg = yield* Config.Service
            const pr = yield* cfg.getCanonicalProvenance()
            return yield* CanonicalResolver.resolveFromSnapshot(pr, "nope", "m1").pipe(Effect.flip)
          }),
        ),
      )
      expect(nf._tag).toBe("CanonicalNotFoundError")
      const cf = await AppRuntime.runPromise(
        provideInstance(p.path)(
          Effect.gen(function* () {
            const cfg = yield* Config.Service
            const pr = yield* cfg.getCanonicalProvenance()
            return yield* CanonicalResolver.resolveFromSnapshot(pr, "conflicted", "m1").pipe(Effect.flip)
          }),
        ),
      )
      expect(cf._tag).toBe("CanonicalConflictError")
      const mnf = await AppRuntime.runPromise(
        provideInstance(p.path)(
          Effect.gen(function* () {
            const cfg = yield* Config.Service
            const pr = yield* cfg.getCanonicalProvenance()
            return yield* CanonicalResolver.resolveFromSnapshot(pr, "ok", "no-model").pipe(Effect.flip)
          }),
        ),
      )
      expect(mnf._tag).toBe("CanonicalModelNotFoundError")
      for (const inherited of ["__proto__", "constructor", "toString"]) {
        const e = await AppRuntime.runPromise(
          provideInstance(p.path)(
            Effect.gen(function* () {
              const cfg = yield* Config.Service
              const pr = yield* cfg.getCanonicalProvenance()
              return yield* CanonicalResolver.resolveFromSnapshot(pr, inherited, "m1").pipe(Effect.flip)
            }),
          ),
        )
        expect(e._tag).toBe("CanonicalNotFoundError")
        const em = await AppRuntime.runPromise(
          provideInstance(p.path)(
            Effect.gen(function* () {
              const cfg = yield* Config.Service
              const pr = yield* cfg.getCanonicalProvenance()
              return yield* CanonicalResolver.resolveFromSnapshot(pr, "ok", inherited).pipe(Effect.flip)
            }),
          ),
        )
        expect(em._tag).toBe("CanonicalModelNotFoundError")
      }
    } finally {
      await p[Symbol.asyncDispose]()
      await g[Symbol.asyncDispose]()
    }
  })

  test("atomic getWithCanonical and withConfigSnapshot pinning", async () => {
    const g = await tmpdir({ retain: true })
    const p = await tmpdir({ git: true, retain: true })
    try {
      ;(Global.Path as { config: string }).config = g.path
      await fs.writeFile(path.join(g.path, "kilo.jsonc"), JSON.stringify({ model: "old/model" }))
      await ensureProjectDir(p.path)
      await fs.writeFile(path.join(p.path, ".kilo", "kilo.jsonc"), JSON.stringify({}))
      const withInst = (dir: string) => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(effect as Effect.Effect<A, E, never>) as Effect.Effect<A, E, never>))
      await AppRuntime.runPromise(provideInstance(p.path)(Effect.gen(function* () { const c = yield* Config.Service; return yield* c.get() })))
      const cfg = await AppRuntime.runPromise(provideInstance(p.path)(Effect.gen(function* () { return yield* Config.Service })))
      const snap1 = await AppRuntime.runPromise(provideInstance(p.path)(cfg.getWithCanonical()))
      expect(snap1.info.model).toBe("old/model")
      expect(snap1.canonical).toBeDefined()
      const outcome = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const fiber = yield* Effect.forkDetach(
            withInst(p.path)(
              withConfigSnapshot(
                cfg,
                Effect.gen(function* () {
                  const atEntry = yield* cfg.getWithCanonical()
                  yield* Deferred.succeed(entered, void 0)
                  yield* Deferred.await(release)
                  const after = yield* cfg.getWithCanonical()
                  const infoOnly = yield* cfg.get()
                  const provOnly = yield* cfg.getCanonicalProvenance()
                  return { atEntry, after, infoOnly, provOnly }
                }),
              ),
            ),
          )
          yield* Deferred.await(entered)
          yield* Effect.promise(() => fs.writeFile(path.join(g.path, "kilo.jsonc"), JSON.stringify({ model: "new/model" })))
          const outsideAfter = yield* withInst(p.path)(
            Effect.gen(function* () {
              const c = yield* Config.Service
              yield* c.invalidate()
              return yield* c.getWithCanonical()
            }),
          )
          expect(outsideAfter.info.model).toBe("new/model")
          yield* Deferred.succeed(release, void 0)
          const pinned = yield* Fiber.join(fiber) as Effect.Effect<{ atEntry: { info: { model?: string } }; after: { info: { model?: string } }; infoOnly: { model?: string }; provOnly: unknown }, never, never>
          return pinned
        }),
      )
      const pinned = outcome as unknown as { atEntry: { info: { model?: string } }; after: { info: { model?: string } }; infoOnly: { model?: string } }
      expect(pinned.atEntry.info.model).toBe("old/model")
      expect(pinned.after.info.model).toBe("old/model")
      expect(pinned.infoOnly.model).toBe("old/model")
    } finally {
      await p[Symbol.asyncDispose]()
      await g[Symbol.asyncDispose]()
    }
  })

  test("load/read/parse failures remain recoverable", async () => {
    const g = await tmpdir()
    const p = await tmpdir({ git: true })
    try {
      ;(Global.Path as { config: string }).config = g.path
      await fs.writeFile(path.join(g.path, "kilo.jsonc"), "{ invalid json")
      await ensureProjectDir(p.path)
      await fs.writeFile(path.join(p.path, ".kilo", "kilo.jsonc"), "{ bad }")
      const info = await AppRuntime.runPromise(
        provideInstance(p.path)(
          Effect.gen(function* () {
            const c = yield* Config.Service
            const i = yield* c.get()
            const prov = yield* c.getCanonicalProvenance()
            const w = yield* c.warnings()
            return { i, prov, w }
          }),
        ),
      )
      expect(info.i).toBeDefined()
      expect(Object.keys(info.prov.providers).length).toBe(0)
      expect(info.w.length).toBeGreaterThan(0)
    } finally {
      await p[Symbol.asyncDispose]()
      await g[Symbol.asyncDispose]()
    }
  })

  test("public Config.get and authenticated /config JSON contain no provenance", async () => {
    const g = await tmpdir({ retain: true })
    const p = await tmpdir({ git: true, retain: true })
    try {
      ;(Global.Path as { config: string }).config = g.path
      await fs.writeFile(
        path.join(g.path, "kilo.jsonc"),
        JSON.stringify({
          provider: {
            leak: {
              endpoint: "https://leak.test",
              protocol: "openai/completions",
              credential: "secret:kilo.credentials.global.provider.leak",
              models: { m1: { name: "M1" } },
            },
          },
        }),
      )
      await ensureProjectDir(p.path)
      await fs.writeFile(path.join(p.path, ".kilo", "kilo.jsonc"), JSON.stringify({ model: "test/model" }))
      const json = await AppRuntime.runPromise(
        provideInstance(p.path)(
          Effect.gen(function* () {
            const c = yield* Config.Service
            const i = yield* c.get()
            return JSON.stringify(i)
          }),
        ),
      )
      const parsed = JSON.parse(json)
      expect(parsed.canonical).toBeUndefined()
      expect(parsed.conflicts).toBeUndefined()
      expect(parsed.CanonicalProviderSnapshotRef).toBeUndefined()
      const app = Server.Default().app
      const res = await app.request("/config", { headers: { "x-kilo-directory": p.path } })
      const body = (await res.json()) as Record<string, unknown>
      expect(body.canonical).toBeUndefined()
      expect(body.conflicts).toBeUndefined()
      expect(body.provenance).toBeUndefined()
      expect(body.CanonicalProviderSnapshotRef).toBeUndefined()
      // Effective provider credential refs are preserved (opaque refs, not plaintext);
      // provenance internal fields must not leak.
      const leaked = JSON.stringify(body)
      expect(leaked.includes("canonical")).toBe(false)
      expect(leaked.includes("conflicts")).toBe(false)
    } finally {
      await p[Symbol.asyncDispose]()
      await g[Symbol.asyncDispose]()
    }
  }, { timeout: 20000 })

  test("CanonicalResolver.resolve via real Config.Service (production path)", async () => {
    const g = await tmpdir()
    const p = await tmpdir({ git: true })
    try {
      ;(Global.Path as { config: string }).config = g.path
      await writeGlobal(g.path, {
        provider: {
          "prod-ok": {
            endpoint: "https://prod.test",
            protocol: "openai/completions",
            credential: "secret:kilo.credentials.global.provider.prod-ok",
            models: { "m1": { name: "M1" } },
          },
          "prod-dup": {
            endpoint: "https://dup.test",
            protocol: "openai/completions",
            credential: "secret:kilo.credentials.global.provider.prod-dup",
            models: { m1: { name: "M1" } },
          },
        },
      })
      await ensureProjectDir(p.path)
      await writeProject(p.path, {
        provider: {
          "prod-dup": {
            endpoint: "https://dup2.test",
            protocol: "openai/completions",
            credential: "secret:kilo.credentials.project.provider.prod-dup",
            models: { m1: { name: "M1" } },
          },
        },
      })
      const ok = await AppRuntime.runPromise(
        provideInstance(p.path)(
          Effect.gen(function* () {
            return yield* CanonicalResolver.resolve("prod-ok", "m1")
          }),
        ),
      )
      expect(ok.providerId).toBe("prod-ok")
      expect(ok.scope).toBe("global")
      expect(ok.credentialRef).toBe("secret:kilo.credentials.global.provider.prod-ok")
      const dupErr = await AppRuntime.runPromise(
        provideInstance(p.path)(CanonicalResolver.resolve("prod-dup", "m1").pipe(Effect.flip)),
      )
      expect(dupErr._tag).toBe("CanonicalConflictError")
      const nf = await AppRuntime.runPromise(provideInstance(p.path)(CanonicalResolver.resolve("missing", "m1").pipe(Effect.flip)))
      expect(nf._tag).toBe("CanonicalNotFoundError")
      const mnf = await AppRuntime.runPromise(provideInstance(p.path)(CanonicalResolver.resolve("prod-ok", "no-model").pipe(Effect.flip)))
      expect(mnf._tag).toBe("CanonicalModelNotFoundError")
    } finally {
      await p[Symbol.asyncDispose]()
      await g[Symbol.asyncDispose]()
    }
  })

  test("withGenerationAdmission pins config+provenance across mutation/invalidation", async () => {
    const g = await tmpdir({ retain: true })
    const p = await tmpdir({ git: true, retain: true })
    try {
      ;(Global.Path as { config: string }).config = g.path
      await fs.writeFile(
        path.join(g.path, "kilo.jsonc"),
        JSON.stringify({
          model: "old/model",
          provider: {
            "admission-pin": {
              endpoint: "https://old.test",
              protocol: "openai/completions",
              credential: "secret:kilo.credentials.global.provider.admission-pin",
              models: { m1: { name: "M1 old" } },
            },
          },
        }),
      )
      await ensureProjectDir(p.path)
      await fs.writeFile(path.join(p.path, ".kilo", "kilo.jsonc"), JSON.stringify({}))
      await AppRuntime.runPromise(provideInstance(p.path)(Effect.gen(function* () { const c = yield* Config.Service; return yield* c.get() })))
      await AppRuntime.runPromise(
        provideInstance(p.path)(
          Effect.gen(function* () {
            const cfg = yield* Config.Service
            const entered = yield* Deferred.make<void>()
            const release = yield* Deferred.make<void>()
            const f = yield* Effect.forkDetach(
              withGenerationAdmission(
                cfg,
                Effect.gen(function* () {
                  const before = yield* cfg.getWithCanonical()
                  expect(before.info.model).toBe("old/model")
                  expect(Object.hasOwn(before.canonical.providers, "admission-pin")).toBe(true)
                  const beforeResolve = yield* CanonicalResolver.resolve("admission-pin", "m1")
                  expect(beforeResolve.credentialRef).toBe("secret:kilo.credentials.global.provider.admission-pin")
                  yield* Deferred.succeed(entered, void 0)
                  yield* Deferred.await(release)
                  const during = yield* cfg.getWithCanonical()
                  expect(during.info.model).toBe("old/model")
                  expect(Object.hasOwn(during.canonical.providers, "admission-pin")).toBe(true)
                  const duringResolve = yield* CanonicalResolver.resolve("admission-pin", "m1")
                  expect(duringResolve.credentialRef).toBe("secret:kilo.credentials.global.provider.admission-pin")
                  return during
                }),
              ),
            )
            yield* Deferred.await(entered)
            yield* Effect.promise(() =>
              fs.writeFile(
                path.join(g.path, "kilo.jsonc"),
                JSON.stringify({
                  model: "new/model",
                  provider: {
                    "admission-new": {
                      endpoint: "https://new.test",
                      protocol: "openai/completions",
                      credential: "secret:kilo.credentials.global.provider.admission-new",
                      models: { m1: { name: "M1 new" } },
                    },
                  },
                }),
              ),
            )
            yield* cfg.invalidate()
            const outside = yield* cfg.getWithCanonical()
            expect(outside.info.model).toBe("new/model")
            expect(Object.hasOwn(outside.canonical.providers, "admission-pin")).toBe(false)
            expect(Object.hasOwn(outside.canonical.providers, "admission-new")).toBe(true)
            yield* Deferred.succeed(release, void 0)
            const pinned = yield* Fiber.join(f)
            expect((pinned as { info: { model?: string } }).info.model).toBe("old/model")
            expect(Object.hasOwn((pinned as { canonical: { providers: Record<string, unknown> } }).canonical.providers, "admission-pin")).toBe(true)
            const fresh = yield* withGenerationAdmission(
              cfg,
              Effect.gen(function* () {
                const cur = yield* cfg.getWithCanonical()
                expect(cur.info.model).toBe("new/model")
                expect(Object.hasOwn(cur.canonical.providers, "admission-new")).toBe(true)
                const freshr = yield* CanonicalResolver.resolve("admission-new", "m1")
                expect(freshr.credentialRef).toBe("secret:kilo.credentials.global.provider.admission-new")
                return cur
              }),
            )
            expect(fresh.info.model).toBe("new/model")
          }),
        ),
      )
    } finally {
      await p[Symbol.asyncDispose]()
      await g[Symbol.asyncDispose]()
    }
  })

  test("parse error secrecy: no raw plaintext token in JsonError/warnings/log/HTTP", async () => {
    const token = "PLAINTEXT_SECRET_TOKEN_9f3a7c-unique-UNIQUE_12345"
    const g = await tmpdir()
    const p = await tmpdir({ git: true })
    const logTmp = await tmpdir()
    const prevLog = Global.Path.log
    Global.Path.log = logTmp.path
    await Log.init({ print: false })
    try {
      ;(Global.Path as { config: string }).config = g.path
      const malformed = `{\n  "provider": {\n    "bad": { "endpoint": "https://a.test", "token": "${token}" }\n  // missing closing braces`
      await fs.writeFile(path.join(g.path, "kilo.jsonc"), malformed)
      await ensureProjectDir(p.path)
      await fs.writeFile(path.join(p.path, ".kilo", "kilo.jsonc"), malformed.replace("bad", "bad2"))
      let parseMessage = ""
      try {
        ConfigParse.jsonc(malformed, path.join(g.path, "kilo.jsonc"))
      } catch (e) {
        parseMessage = String((e as { data?: { message?: string } }).data?.message ?? String(e))
      }
      expect(parseMessage.includes(token)).toBe(false)
      expect(parseMessage.includes("PLAINTEXT")).toBe(false)
      const warnings = await AppRuntime.runPromise(
        provideInstance(p.path)(
          Effect.gen(function* () {
            const c = yield* Config.Service
            yield* c.get()
            return yield* c.warnings()
          }),
        ),
      )
      for (const w of warnings) {
        const text = `${w.path} ${w.message} ${w.detail ?? ""}`
        expect(text.includes(token)).toBe(false)
        expect(text.includes("PLAINTEXT")).toBe(false)
      }
      const app = Server.Default().app
      const res = await app.request("/config", { headers: { "x-kilo-directory": p.path } })
      const bodyText = await res.text()
      expect(bodyText.includes(token)).toBe(false)
      expect(bodyText.includes("PLAINTEXT")).toBe(false)
      expect(JSON.stringify(warnings).includes(token)).toBe(false)
      await new Promise((r) => setTimeout(r, 100))
      let logContent = ""
      try {
        const files = await fs.readdir(logTmp.path)
        const logFiles = files.filter((f) => f.endsWith(".log"))
        for (const f of logFiles) {
          const txt = await fs.readFile(path.join(logTmp.path, f), "utf8")
          logContent += txt
        }
        const sinkPath = Log.file()
        expect(sinkPath).toContain(logTmp.path)
        const sinkContent = await fs.readFile(sinkPath, "utf8")
        logContent += sinkContent
      } catch (e) {
        throw new Error(`logger read failed: ${String(e)}`)
      }
      expect(logContent.length).toBeGreaterThan(0)
      expect(logContent.includes(token)).toBe(false)
      expect(logContent.includes("PLAINTEXT")).toBe(false)
    } finally {
      await p[Symbol.asyncDispose]()
      await g[Symbol.asyncDispose]()
      await logTmp[Symbol.asyncDispose]()
      Global.Path.log = prevLog
      await Log.init({ print: false })
    }
  })

  test("decisive duplicate with malformed models/unknown keys vs valid global", async () => {
    const g = await tmpdir()
    const p = await tmpdir({ git: true })
    try {
      ;(Global.Path as { config: string }).config = g.path
      await writeGlobal(g.path, {
        provider: {
          "dup-malformed": {
            endpoint: "https://global.valid.test",
            protocol: "openai/completions",
            credential: "secret:kilo.credentials.global.provider.dup-malformed",
            models: { m1: { name: "M1" } },
          },
        },
      })
      await ensureProjectDir(p.path)
      // project side is canonical but malformed (invalid endpoint + unknown key + bad models)
      await fs.writeFile(
        path.join(p.path, ".kilo", "kilo.jsonc"),
        JSON.stringify({
          provider: {
            "dup-malformed": {
              endpoint: "ftp://bad",
              protocol: "openai/completions",
              credential: "secret:kilo.credentials.project.provider.dup-malformed",
              models: { m1: { name: "M1", extra: "nope" } },
              unknownTop: "x",
            },
          },
        }),
      )
      const prov = await AppRuntime.runPromise(
        provideInstance(p.path)(
          Effect.gen(function* () {
            const cfg = yield* Config.Service
            return yield* cfg.getCanonicalProvenance()
          }),
        ),
      )
      expect(Object.hasOwn(prov.providers, "dup-malformed")).toBe(false)
      const c = prov.conflicts.find((x) => x.id === "dup-malformed")
      expect(c?.reason).toBe("duplicate")
      const err = await AppRuntime.runPromise(
        provideInstance(p.path)(CanonicalResolver.resolve("dup-malformed", "m1").pipe(Effect.flip)),
      )
      expect(err._tag).toBe("CanonicalConflictError")
      expect((err as unknown as { reason: string }).reason).toBe("duplicate")
    } finally {
      await p[Symbol.asyncDispose]()
      await g[Symbol.asyncDispose]()
    }
  })

  test("decisive duplicate with malformed models array/string/null/non-record/unknown keys (regression)", async () => {
    type Case = { name: string; projectProvider: Record<string, unknown> }
    const cases: Case[] = [
      { name: "models []", projectProvider: { endpoint: "https://project.test", protocol: "openai/completions", credential: "secret:kilo.credentials.project.provider.dup-reg", models: [] as unknown } },
      { name: "models string", projectProvider: { endpoint: "https://project.test", protocol: "openai/completions", credential: "secret:kilo.credentials.project.provider.dup-reg", models: "bad" as unknown } },
      { name: "models null", projectProvider: { endpoint: "https://project.test", protocol: "openai/completions", credential: "secret:kilo.credentials.project.provider.dup-reg", models: null as unknown } },
      { name: "models non-record values", projectProvider: { endpoint: "https://project.test", protocol: "openai/completions", credential: "secret:kilo.credentials.project.provider.dup-reg", models: { m1: "bad" as unknown } } },
      { name: "unknown nested key", projectProvider: { endpoint: "https://project.test", protocol: "openai/completions", credential: "secret:kilo.credentials.project.provider.dup-reg", models: { m1: { name: "M1", extra: "nope" } as unknown }, unknownTop: "x" as unknown } },
    ]
    for (const c of cases) {
      const g = await tmpdir()
      const p = await tmpdir({ git: true })
      try {
        ;(Global.Path as { config: string }).config = g.path
        await writeGlobal(g.path, {
          provider: {
            "dup-reg": {
              endpoint: "https://global.valid.test",
              protocol: "openai/completions",
              credential: "secret:kilo.credentials.global.provider.dup-reg",
              models: { m1: { name: "M1" } },
            },
          },
        })
        await ensureProjectDir(p.path)
        await fs.writeFile(path.join(p.path, ".kilo", "kilo.jsonc"), JSON.stringify({ provider: { "dup-reg": c.projectProvider } }))
        const prov = await AppRuntime.runPromise(
          provideInstance(p.path)(
            Effect.gen(function* () {
              const cfg = yield* Config.Service
              return yield* cfg.getCanonicalProvenance()
            }),
          ),
        )
        expect(Object.hasOwn(prov.providers, "dup-reg"), c.name).toBe(false)
        const conflict = prov.conflicts.find((x) => x.id === "dup-reg")
        expect(conflict?.reason, c.name).toBe("duplicate")
        const err = await AppRuntime.runPromise(provideInstance(p.path)(CanonicalResolver.resolve("dup-reg", "m1").pipe(Effect.flip)))
        expect(err._tag, c.name).toBe("CanonicalConflictError")
        expect((err as unknown as { reason: string }).reason, c.name).toBe("duplicate")
        const err2 = await AppRuntime.runPromise(provideInstance(p.path)(CanonicalResolver.resolve("dup-reg", "m2").pipe(Effect.flip)))
        expect(err2._tag, c.name).toBe("CanonicalConflictError")
      } finally {
        await p[Symbol.asyncDispose]()
        await g[Symbol.asyncDispose]()
      }
    }
  })
})
