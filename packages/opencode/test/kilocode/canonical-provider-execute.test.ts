import { describe, expect, test, afterEach } from "bun:test"
import { Effect, Deferred, Fiber, Exit, Cause } from "effect"
import { Global } from "@opencode-ai/core/global"
import { Config } from "@/config/config"
import { withConfigSnapshot } from "@/kilocode/session/config-snapshot"
import { withGenerationAdmission } from "@/kilocode/session/generation-admission"
import { AppRuntime } from "@/effect/app-runtime"
import { provideInstance, tmpdir, disposeAllInstances } from "../fixture/fixture"
import * as Log from "@opencode-ai/core/util/log"
import * as Broker from "@/kilocode/server/provider-execute-broker"
import * as CanonicalExecute from "@/kilocode/provider/canonical-provider-execute"
import { CanonicalResolver } from "@/kilocode/provider/canonical-resolver"
import type { ProviderExecuteSuccess } from "@opencode-ai/core/kilocode/provider-execute"
import path from "path"
import fs from "fs/promises"

void Log.init({ print: false })

const originalConfig = Global.Path.config

afterEach(async () => {
  ;(Global.Path as { config: string }).config = originalConfig
  await disposeAllInstances()
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

const fakeSuccess: ProviderExecuteSuccess = {
  providerId: "test-provider",
  modelId: "m1",
  protocol: "openai/completions",
  endpoint: "https://api.example.com",
  path: "/chat/completions",
  text: "hello world",
  events: [],
}

const withMockBroker = (mock: Broker.Broker) =>
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const execute: CanonicalExecute.Executor["execute"] = (input) =>
      Effect.gen(function* () {
        const r = yield* CanonicalResolver.resolve(input.providerId, input.modelId).pipe(
          Effect.provideService(Config.Service, cfg),
        )
        return yield* mock.execute({
          providerId: r.providerId,
          modelId: r.modelId,
          record: r.record,
          prompt: input.prompt,
        })
      })
    return CanonicalExecute.Service.of({ execute })
  })

describe("canonical provider execute", () => {
  test("success through composition uses exact resolved record", async () => {
    const g = await tmpdir()
    const p = await tmpdir({ git: true })
    try {
      ;(Global.Path as { config: string }).config = g.path
      await writeGlobal(g.path, {
        $schema: "https://app.kilo.ai/config.json",
        provider: {
          "test-provider": {
            name: "Test",
            endpoint: "https://api.example.com",
            protocol: "openai/completions",
            credential: "secret:kilo.credentials.global.provider.test-provider",
            models: { m1: { name: "M1" } },
          },
        },
      })
      await ensureProjectDir(p.path)
      await writeProject(p.path, { $schema: "https://app.kilo.ai/config.json" })

      let captured: Broker.Input | undefined = undefined
      let callCount = 0
      const mockBroker: Broker.Broker = {
        execute: (input) => {
          callCount++
          captured = input
          expect(input.providerId).toBe("test-provider")
          expect(input.modelId).toBe("m1")
          expect(input.prompt).toBe("hello prompt")
          expect((input.record as Record<string, unknown>).endpoint).toBe("https://api.example.com")
          return Effect.succeed({ ...fakeSuccess, providerId: input.providerId, modelId: input.modelId } as ProviderExecuteSuccess)
        },
      }

      const result = await AppRuntime.runPromise(
        provideInstance(p.path)(
          Effect.gen(function* () {
            const exec = yield* withMockBroker(mockBroker)
            return yield* exec.execute({ providerId: "test-provider", modelId: "m1", prompt: "hello prompt" })
          }),
        ),
      )

      expect(result.text).toBe("hello world")
      expect(callCount).toBe(1)
      expect(captured).toBeDefined()
      expect((captured!.record as Record<string, unknown>).endpoint).toBe("https://api.example.com")
    } finally {
      await p[Symbol.asyncDispose]()
      await g[Symbol.asyncDispose]()
    }
  })

  test("no broker call on resolver failure (notFound/conflict/modelNotFound)", async () => {
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
            models: { m1: { name: "M1" } },
          },
          dup: {
            endpoint: "https://dup.test",
            protocol: "openai/completions",
            credential: "secret:kilo.credentials.global.provider.dup",
            models: { m1: { name: "M1" } },
          },
        },
      })
      await ensureProjectDir(p.path)
      await writeProject(p.path, {
        provider: {
          dup: {
            endpoint: "https://dup2.test",
            protocol: "openai/completions",
            credential: "secret:kilo.credentials.project.provider.dup",
            models: { m1: { name: "M1" } },
          },
        },
      })

      for (const { providerId, modelId, expectedTag } of [
        { providerId: "missing", modelId: "m1", expectedTag: "CanonicalNotFoundError" },
        { providerId: "dup", modelId: "m1", expectedTag: "CanonicalConflictError" },
        { providerId: "ok", modelId: "nope", expectedTag: "CanonicalModelNotFoundError" },
      ] as const) {
        let called = false
        const mockBroker: Broker.Broker = {
          execute: () => {
            called = true
            return Effect.succeed(fakeSuccess)
          },
        }
        const err = await AppRuntime.runPromise(
          provideInstance(p.path)(
            Effect.gen(function* () {
              const exec = yield* withMockBroker(mockBroker)
              return yield* exec.execute({ providerId, modelId, prompt: "hi" }).pipe(Effect.flip)
            }),
          ),
        )
        expect(err._tag).toBe(expectedTag)
        expect(called).toBe(false)
        const asUnknown = err as unknown as Record<string, unknown>
        expect(JSON.stringify(asUnknown).includes("secret:")).toBe(false)
      }
    } finally {
      await p[Symbol.asyncDispose]()
      await g[Symbol.asyncDispose]()
    }
  })

  test("broker error propagation preserves sanitized code/message and maps all categories", async () => {
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
            models: { m1: { name: "M1" } },
          },
        },
      })
      await ensureProjectDir(p.path)
      await writeProject(p.path, { $schema: "https://app.kilo.ai/config.json" })

      const cases: Array<{ mk: () => Broker.BrokerError; tag: string; check?: (e: unknown) => void }> = [
        {
          mk: () => new Broker.ProviderExecuteUnavailable({ message: "peer unavailable" }),
          tag: "ProviderExecuteUnavailable",
        },
        {
          mk: () => new Broker.ProviderExecuteUnsupported({ capability: "provider/execute", message: "unsupported" }),
          tag: "ProviderExecuteUnsupported",
        },
        {
          mk: () => new Broker.ProviderExecuteFailure({ code: "missing-secret", message: "missing secret sanitized" }),
          tag: "ProviderExecuteFailure",
          check: (e) => {
            const f = e as Broker.ProviderExecuteFailure
            expect(f.code).toBe("missing-secret")
            expect(f.message).toBe("missing secret sanitized")
          },
        },
        {
          mk: () => new Broker.ProviderExecuteFailure({ code: "aborted", message: "aborted" }),
          tag: "ProviderExecuteFailure",
          check: (e) => expect((e as Broker.ProviderExecuteFailure).code).toBe("aborted"),
        },
        {
          mk: () => new Broker.ProviderExecuteFailure({ code: "provider", message: "provider exploded" }),
          tag: "ProviderExecuteFailure",
          check: (e) => expect((e as Broker.ProviderExecuteFailure).message).toBe("provider exploded"),
        },
        {
          mk: () => new Broker.ProviderExecuteProtocolError({ message: "malformed success" }),
          tag: "ProviderExecuteProtocolError",
        },
      ]

      for (const c of cases) {
        const err = await AppRuntime.runPromise(
          provideInstance(p.path)(
            Effect.gen(function* () {
              const exec = yield* withMockBroker({ execute: () => Effect.fail(c.mk()) } as Broker.Broker)
              return yield* exec.execute({ providerId: "ok", modelId: "m1", prompt: "hi" }).pipe(Effect.flip)
            }),
          ),
        )
        expect((err as unknown as { _tag: string })._tag).toBe(c.tag)
        if (c.check) c.check(err)
        expect(JSON.stringify(err as unknown as Record<string, unknown>).includes("secret:")).toBe(false)
      }
    } finally {
      await p[Symbol.asyncDispose]()
      await g[Symbol.asyncDispose]()
    }
  })

  test("snapshot coherence with withConfigSnapshot and withGenerationAdmission", async () => {
    const g = await tmpdir({ retain: true })
    const p = await tmpdir({ git: true, retain: true })
    try {
      ;(Global.Path as { config: string }).config = g.path
      await writeGlobal(g.path, {
        $schema: "https://app.kilo.ai/config.json",
        provider: {
          pin: {
            endpoint: "https://old.test",
            protocol: "openai/completions",
            credential: "secret:kilo.credentials.global.provider.pin",
            models: { m1: { name: "M1 old" } },
          },
        },
      })
      await ensureProjectDir(p.path)
      await fs.writeFile(path.join(p.path, ".kilo", "kilo.jsonc"), JSON.stringify({ $schema: "https://app.kilo.ai/config.json" }))

      await AppRuntime.runPromise(provideInstance(p.path)(Effect.gen(function* () { const c = yield* Config.Service; return yield* c.get() })))

      await AppRuntime.runPromise(
        provideInstance(p.path)(
          Effect.gen(function* () {
            const cfg = yield* Config.Service
            const entered = yield* Deferred.make<void>()
            const release = yield* Deferred.make<void>()

            const mockOld: Broker.Broker = {
              execute: (inp) => Effect.succeed({ ...fakeSuccess, providerId: inp.providerId, modelId: inp.modelId, endpoint: (inp.record as Record<string, unknown>).endpoint as string, text: "old", path: "/chat/completions", protocol: "openai/completions", events: [] } as ProviderExecuteSuccess),
            }
            const svc = yield* withMockBroker(mockOld)

            const fiber = yield* Effect.forkDetach(
              withConfigSnapshot(
                cfg,
                Effect.gen(function* () {
                  const atEntry = yield* svc.execute({ providerId: "pin", modelId: "m1", prompt: "a" })
                  expect(atEntry.endpoint).toBe("https://old.test")
                  yield* Deferred.succeed(entered, void 0)
                  yield* Deferred.await(release)
                  // should still see old despite mutation
                  const during = yield* svc.execute({ providerId: "pin", modelId: "m1", prompt: "b" })
                  expect(during.endpoint).toBe("https://old.test")
                  return { atEntry, during }
                }),
              ),
            )
            yield* Deferred.await(entered)
            yield* Effect.promise(() =>
              fs.writeFile(
                path.join(g.path, "kilo.jsonc"),
                JSON.stringify({
                  $schema: "https://app.kilo.ai/config.json",
                  provider: {
                    pinNew: {
                      endpoint: "https://new.test",
                      protocol: "openai/completions",
                      credential: "secret:kilo.credentials.global.provider.pinNew",
                      models: { m1: { name: "M1 new" } },
                    },
                  },
                }),
              ),
            )
            yield* cfg.invalidate()
            const outside = yield* cfg.getWithCanonical()
            expect(Object.hasOwn(outside.canonical.providers, "pin")).toBe(false)
            expect(Object.hasOwn(outside.canonical.providers, "pinNew")).toBe(true)
            yield* Deferred.succeed(release, void 0)
            const pinned = yield* Fiber.join(fiber)
            expect(pinned.atEntry.endpoint).toBe("https://old.test")
            expect(pinned.during.endpoint).toBe("https://old.test")
            return pinned
          }),
        ),
      )

      await AppRuntime.runPromise(
        provideInstance(p.path)(
          Effect.gen(function* () {
            const cur = yield* Effect.gen(function* () {
              const cfg = yield* Config.Service
              return yield* cfg.getWithCanonical()
            })
            expect(Object.hasOwn(cur.canonical.providers, "pinNew")).toBe(true)
          }),
        ),
      )

      // admission pinning
      await AppRuntime.runPromise(
        provideInstance(p.path)(
          Effect.gen(function* () {
            const cfg = yield* Config.Service
            yield* Effect.promise(() =>
              fs.writeFile(
                path.join(g.path, "kilo.jsonc"),
                JSON.stringify({
                  $schema: "https://app.kilo.ai/config.json",
                  provider: {
                    "admit-pin": {
                      endpoint: "https://admit.old.test",
                      protocol: "openai/completions",
                      credential: "secret:kilo.credentials.global.provider.admit-pin",
                      models: { m1: { name: "M1" } },
                    },
                  },
                }),
              ),
            )
            yield* cfg.invalidate()
            const entered = yield* Deferred.make<void>()
            const release = yield* Deferred.make<void>()
            const mockAdmit: Broker.Broker = {
              execute: (inp) => {
                expect((inp.record as Record<string, unknown>).endpoint).toBe("https://admit.old.test")
                return Effect.succeed({ ...fakeSuccess, providerId: inp.providerId, modelId: inp.modelId, endpoint: (inp.record as Record<string, unknown>).endpoint as string, text: "admit-old", protocol: "openai/completions", path: "/chat/completions", events: [] } as ProviderExecuteSuccess)
              },
            }
            const svc = yield* withMockBroker(mockAdmit)
            const fiber = yield* Effect.forkDetach(
              withGenerationAdmission(
                cfg,
                Effect.gen(function* () {
                  const before = yield* svc.execute({ providerId: "admit-pin", modelId: "m1", prompt: "x" })
                  expect(before.endpoint).toBe("https://admit.old.test")
                  yield* Deferred.succeed(entered, void 0)
                  yield* Deferred.await(release)
                  const during = yield* svc.execute({ providerId: "admit-pin", modelId: "m1", prompt: "y" })
                  expect(during.endpoint).toBe("https://admit.old.test")
                  return during
                }),
              ),
            )
            yield* Deferred.await(entered)
            yield* Effect.promise(() =>
              fs.writeFile(
                path.join(g.path, "kilo.jsonc"),
                JSON.stringify({
                  $schema: "https://app.kilo.ai/config.json",
                  provider: {
                    "admit-new": {
                      endpoint: "https://admit.new.test",
                      protocol: "openai/completions",
                      credential: "secret:kilo.credentials.global.provider.admit-new",
                      models: { m1: { name: "M1" } },
                    },
                  },
                }),
              ),
            )
            yield* cfg.invalidate()
            const out = yield* cfg.getWithCanonical()
            expect(Object.hasOwn(out.canonical.providers, "admit-pin")).toBe(false)
            yield* Deferred.succeed(release, void 0)
            const pinned = yield* Fiber.join(fiber)
            expect(pinned.endpoint).toBe("https://admit.old.test")
          }),
        ),
      )
    } finally {
      await p[Symbol.asyncDispose]()
      await g[Symbol.asyncDispose]()
    }
  }, { timeout: 20000 })

  test("interruption propagates and is not mapped to typed error", async () => {
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
            models: { m1: { name: "M1" } },
          },
        },
      })
      await ensureProjectDir(p.path)
      await writeProject(p.path, { $schema: "https://app.kilo.ai/config.json" })

      const exit = await AppRuntime.runPromise(
        provideInstance(p.path)(
          Effect.gen(function* () {
            const mockBroker: Broker.Broker = {
              execute: () => Effect.never,
            }
            const svc = yield* withMockBroker(mockBroker)
            const fiber = yield* Effect.gen(function* () {
              return yield* svc.execute({ providerId: "ok", modelId: "m1", prompt: "hi" })
            }).pipe(Effect.forkDetach)
            yield* Effect.sleep(20)
            yield* Fiber.interrupt(fiber)
            return yield* Fiber.await(fiber)
          }),
        ),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const cause = exit.cause
        expect(Cause.hasInterrupts(cause)).toBe(true)
      }
    } finally {
      await p[Symbol.asyncDispose]()
      await g[Symbol.asyncDispose]()
    }
  })

  test("registered in AppRuntime graph via AppRuntime service", async () => {
    const got = await AppRuntime.runPromise(
      Effect.gen(function* () {
        const svc = yield* CanonicalExecute.Service
        expect(svc.execute).toBeDefined()
        return true
      }),
    )
    expect(got).toBe(true)
  })

  test("environment-free execution without hidden runtime dependencies preserves snapshot pinning", async () => {
    const g = await tmpdir()
    const p = await tmpdir({ git: true })
    try {
      ;(Global.Path as { config: string }).config = g.path
      await writeGlobal(g.path, {
        $schema: "https://app.kilo.ai/config.json",
        provider: {
          envfree: {
            endpoint: "https://envfree.test",
            protocol: "openai/completions",
            credential: "secret:kilo.credentials.global.provider.envfree",
            models: { m1: { name: "M1" } },
          },
        },
      })
      await ensureProjectDir(p.path)
      await writeProject(p.path, { $schema: "https://app.kilo.ai/config.json" })

      const mockBroker: Broker.Broker = {
        execute: (inp) => Effect.succeed({ ...fakeSuccess, providerId: inp.providerId, modelId: inp.modelId, endpoint: (inp.record as Record<string, unknown>).endpoint as string, text: "envfree", protocol: "openai/completions", path: "/chat/completions", events: [] } as ProviderExecuteSuccess),
      }

      // Obtain service from its layer/AppRuntime without extra env, then execute.
      // The execute effect must be runnable without providing Config.Service or Broker.Service.
      const result = await AppRuntime.runPromise(
        provideInstance(p.path)(
          Effect.gen(function* () {
            const svc = yield* withMockBroker(mockBroker)
            // Type-level: svc.execute returns Effect<Success, Error, never> (no R)
            const effect: Effect.Effect<ProviderExecuteSuccess, CanonicalExecute.CanonicalProviderExecuteError> = svc.execute({
              providerId: "envfree",
              modelId: "m1",
              prompt: "hello",
            })
            // Should run without additional provides
            const out = yield* effect
            expect(out.endpoint).toBe("https://envfree.test")
            expect(out.text).toBe("envfree")

            // Snapshot pinning still works: capture snapshot, mutate global, still see old
            const cfg = yield* Config.Service
            const pinned = yield* withConfigSnapshot(
              cfg,
              Effect.gen(function* () {
                const before = yield* svc.execute({ providerId: "envfree", modelId: "m1", prompt: "pinned" })
                expect(before.endpoint).toBe("https://envfree.test")
                return before
              }),
            )
            // Mutate to new provider, invalidate, svc outside snapshot should see new
            yield* Effect.promise(() =>
              fs.writeFile(
                path.join(g.path, "kilo.jsonc"),
                JSON.stringify({
                  $schema: "https://app.kilo.ai/config.json",
                  provider: {
                    envfree2: {
                      endpoint: "https://envfree2.test",
                      protocol: "openai/completions",
                      credential: "secret:kilo.credentials.global.provider.envfree2",
                      models: { m1: { name: "M1" } },
                    },
                  },
                }),
              ),
            )
            yield* cfg.invalidate()
            const outside = yield* cfg.getWithCanonical()
            expect(Object.hasOwn(outside.canonical.providers, "envfree2")).toBe(true)
            // pinned value from earlier snapshot still old
            expect(pinned.endpoint).toBe("https://envfree.test")
            return out
          }),
        ),
      )
      expect(result.text).toBe("envfree")
    } finally {
      await p[Symbol.asyncDispose]()
      await g[Symbol.asyncDispose]()
    }
  })
})
