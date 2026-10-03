import { afterAll, afterEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { Bus } from "../../../src/bus"
import { Config } from "../../../src/config/config"
import { Permission } from "../../../src/permission"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "../../../src/event-v2-bridge"
import { SessionID } from "../../../src/session/schema"
import { Global } from "@opencode-ai/core/global"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance, disposeAllInstances, tmpdirScoped, provideInstance } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"
import { ConfigProtection } from "../../../src/kilocode/permission/config-paths"
import { withGenerationAdmission } from "../../../src/kilocode/session/generation-admission"
import { GenerationGate } from "../../../src/kilocode/server/generation-gate"
import { createTestTrustedAgentContext as createTrustedAgentContext } from "../../helpers/trusted-helpers"
import { markProjectConfigReady } from "../../fixture/plugin"

const bus = Bus.layer
const env = Layer.mergeAll(
  Permission.layer.pipe(
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Database.defaultLayer),
  ),
  Config.defaultLayer,
  GenerationGate.defaultLayer,
  bus,
  CrossSpawnSpawner.defaultLayer,
)
const it = testEffect(env)

afterEach(async () => {
  await disposeAllInstances()
  const dir = Global.Path.config
  for (const file of ["kilo.jsonc", "kilo.json", "config.json", "opencode.json", "opencode.jsonc"]) {
    await fs.rm(path.join(dir, file), { force: true }).catch(() => undefined)
  }
  await Effect.runPromise(
    Config.Service.use((svc) => svc.invalidate()).pipe(Effect.scoped, Effect.provide(Config.defaultLayer)),
  )
})

afterAll(async () => {
  await disposeAllInstances()
})

const waitForPending = (count: number) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    for (let i = 0; i < 200; i++) {
      const items = yield* permission.list()
      if (items.length >= count) return items
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.fail(new Error(`timed out waiting for ${count} pending permission request(s)`))
  })

const bashAsk = (id: string, session: string) =>
  ({
    id: PermissionV1.ID.make(id),
    sessionID: SessionID.make(session),
    permission: "bash" as const,
    patterns: ["echo hi"],
    metadata: {},
    always: ["echo hi"],
    ruleset: [],
  }) as any

const editProtected = (id: string, session: string, agent: string, patterns: string[]) =>
  ({
    id: PermissionV1.ID.make(id),
    sessionID: SessionID.make(session),
    permission: "edit" as const,
    patterns,
    metadata: { [ConfigProtection.AGENT_KEY]: agent, filepath: patterns.join(", ") },
    trustedContext: createTrustedAgentContext(agent),
    always: ["*"],
    ruleset: [],
  }) as any

describe("generation versioned policy snapshot", () => {
  it.live("admitted generation pins permission, level, and protected files; ask->reply uses original; next sees new version", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const config = yield* Config.Service
          const permission = yield* Permission.Service
          yield* Effect.promise(() => fs.writeFile(path.join(dir, "AGENTS.md"), "protected\n"))

          yield* config.updateGlobal(
            { permission: { bash: "ask" }, permission_level: "review" } as any,
            { dispose: false },
          )
          const v1 = yield* config.getPolicySnapshot()
          expect(v1.version.length).toBeGreaterThan(0)
          expect((v1.global as any).permission_level).toBe("review")

          const release = yield* Deferred.make<void>()
          const result = yield* withGenerationAdmission(
            config,
            Effect.gen(function* () {
              const pinned = yield* config.getPolicySnapshot()
              expect(pinned.version).toBe(v1.version)

              const first = yield* permission.evaluateForDebug({
                permission: "bash",
                patterns: ["echo hi"],
                sessionID: SessionID.make("ses_pin_bash"),
                agent: "code",
              })
              expect(first.result).toBe("ask")
              expect(first.policyVersion).toBe(v1.version)

              const protFirst = yield* permission.evaluateForDebug({
                permission: "edit",
                patterns: ["AGENTS.md"],
                metadata: { [ConfigProtection.AGENT_KEY]: "code", filepath: "AGENTS.md" },
                sessionID: SessionID.make("ses_pin_prot"),
                agent: "code",
              })
              expect(["ask", "ask-ceiling"].includes(protFirst.result)).toBe(true)

              const childVersion = yield* withGenerationAdmission(
                config,
                Effect.gen(function* () {
                  const inner = yield* config.getPolicySnapshot()
                  return inner.version
                }),
              )
              expect(childVersion).toBe(v1.version)

              const bridged = yield* Effect.forkDetach(
                Effect.gen(function* () {
                  const inner = yield* config.getPolicySnapshot()
                  return inner.version
                }),
              )
              expect(yield* Fiber.join(bridged)).toBe(v1.version)

              const askId = "per_pin_ask_reply"
              const asking = yield* permission
                .ask(bashAsk(askId, "ses_pin_ask_reply"))
                .pipe(Effect.forkScoped)
              yield* waitForPending(1)

              const abs = path.join(dir, "AGENTS.md")
              yield* config.updateGlobal(
                {
                  permission: { bash: "allow" },
                  permission_level: "autonomous",
                  protected_files: { code: { [abs]: "allow" } },
                } as any,
                { dispose: false },
              )

              const stillPinned = yield* config.getPolicySnapshot()
              expect(stillPinned.version).toBe(v1.version)
              const second = yield* permission.evaluateForDebug({
                permission: "bash",
                patterns: ["echo hi"],
                sessionID: SessionID.make("ses_pin_bash"),
                agent: "code",
              })
              expect(second.result).toBe("ask")
              expect(second.policyVersion).toBe(v1.version)

              const protSecond = yield* permission.evaluateForDebug({
                permission: "edit",
                patterns: ["AGENTS.md"],
                metadata: { [ConfigProtection.AGENT_KEY]: "code", filepath: "AGENTS.md" },
                sessionID: SessionID.make("ses_pin_prot"),
                agent: "code",
              })
              expect(protSecond.result).toBe(protFirst.result)

              const liveGlobal = yield* config.getGlobal()
              expect((liveGlobal as any).permission_level).toBe("autonomous")

              yield* permission.reply({ requestID: PermissionV1.ID.make(askId), reply: "once" })
              yield* Fiber.await(asking)

              const prov = yield* permission.provenance(askId)
              expect(prov?.policyVersion).toBe(v1.version)

              yield* Deferred.succeed(release, void 0)
              return stillPinned.version
            }),
          )
          expect(result).toBe(v1.version)

          const v2 = yield* config.getPolicySnapshot()
          expect(v2.version).not.toBe(v1.version)
          expect((v2.global as any).permission_level).toBe("autonomous")

          const next = yield* withGenerationAdmission(
            config,
            Effect.gen(function* () {
              const cur = yield* config.getPolicySnapshot()
              const out = yield* (yield* Permission.Service).evaluateForDebug({
                permission: "bash",
                patterns: ["echo hi"],
                sessionID: SessionID.make("ses_pin_bash_next"),
                agent: "code",
              })
              return { version: cur.version, result: out.result, policyVersion: out.policyVersion }
            }),
          )
          expect(next.version).toBe(v2.version)
          expect(next.result).toBe("allow")
          expect(next.policyVersion).toBe(v2.version)

          const protNext = yield* permission.evaluateForDebug({
            permission: "edit",
            patterns: ["AGENTS.md"],
            metadata: { [ConfigProtection.AGENT_KEY]: "code", filepath: "AGENTS.md" },
            sessionID: SessionID.make("ses_pin_prot_next"),
            agent: "code",
          })
          expect(protNext.result).toBe("allow")
          expect(protNext.policyVersion).toBe(v2.version)
        }),
      { git: true },
    ),
  )

  it.live("queued generation snapshots at actual execution, not queue time", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const config = yield* Config.Service
          const gate = yield* GenerationGate.Service
          yield* config.updateGlobal({ permission: { bash: "ask" } } as any, { dispose: false })
          const v1 = yield* config.getPolicySnapshot()

          const enteredA = yield* Deferred.make<void>()
          const releaseA = yield* Deferred.make<void>()
          const genA = yield* Effect.forkDetach(
            withGenerationAdmission(
              config,
              Effect.gen(function* () {
                const cur = yield* config.getPolicySnapshot()
                yield* Deferred.succeed(enteredA, void 0)
                yield* Deferred.await(releaseA)
                return cur.version
              }),
            ),
          )
          yield* Deferred.await(enteredA)

          const ticket = yield* gate.beginWrite(dir)
          const enteredB = yield* Deferred.make<void>()
          const genB = yield* Effect.forkDetach(
            withGenerationAdmission(
              config,
              Effect.gen(function* () {
                const cur = yield* config.getPolicySnapshot()
                yield* Deferred.succeed(enteredB, void 0)
                return cur.version
              }),
            ),
          )
          const polled = yield* Deferred.poll(enteredB)
          expect(polled._tag).toBe("None")

          yield* config.updateGlobal({ permission: { bash: "allow" } } as any, { dispose: false })

          yield* Deferred.succeed(releaseA, void 0)
          const joinedA = yield* Fiber.join(genA)
          expect(joinedA).toBe(v1.version)

          yield* Deferred.await(ticket.drained)
          yield* ticket.release
          yield* Deferred.await(enteredB)
          const joinedB = yield* Fiber.join(genB)
          const live = yield* config.getPolicySnapshot()
          expect(joinedB).toBe(live.version)
          expect(joinedB).not.toBe(v1.version)

          const after = yield* withGenerationAdmission(
            config,
            Effect.gen(function* () {
              return (yield* config.getPolicySnapshot()).version
            }),
          )
          expect(after).toBe(live.version)
          expect(Exit.isSuccess(Exit.succeed(after))).toBe(true)
        }),
      { git: true },
    ),
  )

  it.live("policy snapshot is immutable per version; admitted mutations cannot pollute siblings or cache", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          void dir
          const config = yield* Config.Service
          yield* config.updateGlobal(
            {
              permission: { bash: "ask" },
              permission_level: "review",
              agent: { code: { permission: { bash: "ask" } } },
              provider: {
                acme: {
                  endpoint: "https://global.example.com",
                  protocol: "openai/completions",
                  credential: "secret:kilo.credentials.global.provider.acme",
                  name: "global",
                  models: { m1: { name: "M1" } },
                },
              },
            } as any,
            { dispose: false },
          )
          const v1 = yield* config.getPolicySnapshot()
          const v1b = yield* config.getPolicySnapshot()
          expect(v1b).toBe(v1)
          expect(Object.isFrozen(v1)).toBe(true)
          expect(Object.isFrozen(v1.info)).toBe(true)
          expect(Object.isFrozen(v1.global)).toBe(true)
          expect(Object.isFrozen(v1.canonical)).toBe(true)
          expect(Object.isFrozen((v1.globalPermission as { raw: unknown }).raw as object)).toBe(true)
          expect(Object.isFrozen((v1.info as { agent?: unknown }).agent as object)).toBe(true)
          expect((v1.canonical as { providers?: Record<string, unknown> }).providers?.["acme"]).toBeDefined()

          try {
            ;(v1.global as { permission?: Record<string, unknown> }).permission = { bash: "allow" } as never
          } catch {}
          try {
            ;((v1.globalPermission as { raw?: Record<string, unknown> }).raw as Record<string, unknown>).bash = "allow"
          } catch {}
          try {
            ;((v1.info as { agent?: Record<string, { permission?: Record<string, unknown> }> }).agent?.code?.permission as Record<string, unknown>).bash =
              "allow"
          } catch {}
          try {
            ;((v1.canonical as { providers?: Record<string, unknown> }).providers as Record<string, unknown>)["acme"] = undefined as never
          } catch {}

          const afterMut = yield* config.getPolicySnapshot()
          expect(afterMut).toBe(v1)
          expect(afterMut.version).toBe(v1.version)
          expect((afterMut.global as { permission?: Record<string, unknown> }).permission).toMatchObject({ bash: "ask" })
          expect((afterMut.info as { agent?: Record<string, { permission?: Record<string, unknown> }> }).agent?.code?.permission).toMatchObject({
            bash: "ask",
          })

          const pinnedVersion = yield* withGenerationAdmission(
            config,
            Effect.gen(function* () {
              const pinned = yield* config.getPolicySnapshot()
              expect(pinned.version).toBe(v1.version)
              try {
                ;(pinned.global as { permission?: Record<string, unknown> }).permission = { bash: "allow" } as never
              } catch {}
              const sibling = yield* Effect.forkDetach(
                withGenerationAdmission(
                  config,
                  Effect.gen(function* () {
                    return yield* config.getPolicySnapshot()
                  }),
                ),
              )
              const sib = yield* Fiber.join(sibling)
              expect(sib.version).toBe(v1.version)
              expect((sib.global as { permission?: Record<string, unknown> }).permission).toMatchObject({ bash: "ask" })
              expect((sib.canonical as { providers?: Record<string, unknown> }).providers?.["acme"]).toBeDefined()
              return pinned.version
            }),
          )
          expect(pinnedVersion).toBe(v1.version)
          const live = yield* config.getPolicySnapshot()
          expect(live).toBe(v1)
          expect((live.global as { permission?: Record<string, unknown> }).permission).toMatchObject({ bash: "ask" })
        }),
      { git: true },
    ),
  )

  it.live("external global edit via getGlobal then getPolicySnapshot returns latest version and floors", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const config = yield* Config.Service
          yield* config.updateGlobal(
            { permission: { bash: "ask" }, permission_level: "review", agent: { code: { tools: { bash: false } } } } as any,
            { dispose: false },
          )
          yield* Effect.promise(() => markProjectConfigReady(dir))
          yield* Effect.promise(() => fs.mkdir(path.join(dir, ".kilo"), { recursive: true }))
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(dir, ".kilo", "kilo.jsonc"),
              JSON.stringify({ $schema: "https://app.kilo.ai/config.json", agent: { code: { tools: { bash: true } } } }, null, 2),
            ),
          )
          yield* config.invalidateProject()
          const v1 = yield* config.getPolicySnapshot()
          expect((v1.info as { agent?: Record<string, { tools?: Record<string, boolean> }> }).agent?.code?.tools?.bash).toBe(false)
          expect((v1.global as { permission_level?: unknown }).permission_level).toBe("review")

          const globalFile = path.join(Global.Path.config, "kilo.jsonc")
          yield* Effect.promise(() =>
            fs.writeFile(
              globalFile,
              JSON.stringify(
                {
                  $schema: "https://app.kilo.ai/config.json",
                  permission: { bash: "allow" },
                  permission_level: "autonomous",
                  agent: { code: { tools: { bash: false } } },
                },
                null,
                2,
              ),
            ),
          )

          const liveGlobal = yield* config.getGlobal()
          expect((liveGlobal as { permission_level?: unknown }).permission_level).toBe("autonomous")
          const snap2 = yield* config.getPolicySnapshot()
          expect(snap2.version).not.toBe(v1.version)
          expect((snap2.global as { permission_level?: unknown }).permission_level).toBe("autonomous")
          expect(snap2.globalPermission.present).toBe(true)
          expect((snap2.info as { agent?: Record<string, { tools?: Record<string, boolean> }> }).agent?.code?.tools?.bash).toBe(false)
          const liveInfo = yield* config.get()
          expect((liveInfo as { agent?: Record<string, { tools?: Record<string, boolean> }> }).agent?.code?.tools?.bash).toBe(false)
        }),
      { git: true },
    ),
  )

  it.live("admitted generation pins tools floor and canonical/agent version; next sees bump", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          void dir
          const config = yield* Config.Service
          const permission = yield* Permission.Service
          yield* config.updateGlobal(
            {
              permission: { bash: "ask" },
              agent: { code: { tools: { bash: false }, permission: { bash: "ask" } } },
              provider: {
                acme: {
                  endpoint: "https://global.example.com",
                  protocol: "openai/completions",
                  credential: "secret:kilo.credentials.global.provider.acme",
                  name: "global",
                  models: { m1: { name: "M1" } },
                },
              },
            } as any,
            { dispose: false },
          )
          const v1 = yield* config.getPolicySnapshot()
          expect((v1.info as { agent?: Record<string, { tools?: Record<string, boolean> }> }).agent?.code?.tools?.bash).toBe(false)

          const pinnedVersion = yield* withGenerationAdmission(
            config,
            Effect.gen(function* () {
              const pinned = yield* config.getPolicySnapshot()
              expect(pinned.version).toBe(v1.version)
              const first = yield* permission.evaluateForDebug({
                permission: "bash",
                patterns: ["echo hi"],
                sessionID: "ses_floor_pin",
                agent: "code",
              })
              expect(first.result).toBe("ask")
              expect(first.policyVersion).toBe(v1.version)

              yield* config.updateGlobal(
                {
                  permission: { bash: "allow" },
                  agent: {
                    code: {
                      tools: { bash: true },
                      permission: { bash: "allow" },
                    },
                  },
                  provider: {
                    acme: {
                      endpoint: "https://global2.example.com",
                      protocol: "openai/completions",
                      credential: "secret:kilo.credentials.global.provider.acme",
                      name: "global",
                      models: { m1: { name: "M1" } },
                    },
                  },
                } as any,
                { dispose: false },
              )

              const still = yield* config.getPolicySnapshot()
              expect(still.version).toBe(v1.version)
              expect((still.info as { agent?: Record<string, { tools?: Record<string, boolean> }> }).agent?.code?.tools?.bash).toBe(false)
              expect(
                ((still.canonical as { providers?: Record<string, { record?: Record<string, unknown> }> }).providers?.["acme"]?.record as Record<string, unknown>)
                  ?.endpoint,
              ).toBe("https://global.example.com")
              const second = yield* permission.evaluateForDebug({
                permission: "bash",
                patterns: ["echo hi"],
                sessionID: "ses_floor_pin",
                agent: "code",
              })
              expect(second.result).toBe("ask")
              expect(second.policyVersion).toBe(v1.version)

              const liveGlobal = yield* config.getGlobal()
              expect((liveGlobal as { permission?: Record<string, unknown> }).permission).toMatchObject({ bash: "allow" })
              return still.version
            }),
          )
          expect(pinnedVersion).toBe(v1.version)

          const v2 = yield* config.getPolicySnapshot()
          expect(v2.version).not.toBe(v1.version)
          const next = yield* withGenerationAdmission(
            config,
            Effect.gen(function* () {
              const cur = yield* config.getPolicySnapshot()
              const out = yield* permission.evaluateForDebug({
                permission: "bash",
                patterns: ["echo hi"],
                sessionID: "ses_floor_next",
                agent: "code",
              })
              return { version: cur.version, result: out.result, policyVersion: out.policyVersion }
            }),
          )
          expect(next.version).toBe(v2.version)
          expect(next.result).toBe("allow")
          expect(next.policyVersion).toBe(v2.version)
        }),
      { git: true },
    ),
  )

  it.live("different-directory admission captures own version; same-directory nested preserves", () =>
    provideTmpdirInstance(
      (dirA) =>
        Effect.gen(function* () {
          const config = yield* Config.Service
          yield* config.updateGlobal({ permission: { bash: "ask" } } as any, { dispose: false })
          const dirB = yield* tmpdirScoped({ git: true })
          yield* Effect.promise(() => markProjectConfigReady(dirA))
          yield* Effect.promise(() => markProjectConfigReady(dirB))
          yield* Effect.promise(() => fs.mkdir(path.join(dirA, ".kilo"), { recursive: true }))
          yield* Effect.promise(() => fs.mkdir(path.join(dirB, ".kilo"), { recursive: true }))
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(dirA, ".kilo", "kilo.jsonc"),
              JSON.stringify({ $schema: "https://app.kilo.ai/config.json", model: "a/model" }, null, 2),
            ),
          )
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(dirB, ".kilo", "kilo.jsonc"),
              JSON.stringify({ $schema: "https://app.kilo.ai/config.json", model: "b/model" }, null, 2),
            ),
          )
          yield* config.invalidateProject()
          yield* provideInstance(dirB)(config.invalidateProject())
          const vA = yield* config.getPolicySnapshot()
          const vB = yield* provideInstance(dirB)(config.getPolicySnapshot())
          expect(vA.version).not.toBe(vB.version)
          expect((vA.info as { model?: unknown }).model).toBe("a/model")
          expect((vB.info as { model?: unknown }).model).toBe("b/model")

          const pinnedA = yield* withGenerationAdmission(
            config,
            Effect.gen(function* () {
              const pinned = yield* config.getPolicySnapshot()
              expect(pinned.version).toBe(vA.version)
              const same = yield* withGenerationAdmission(
                config,
                Effect.gen(function* () {
                  return (yield* config.getPolicySnapshot()).version
                }),
              )
              expect(same).toBe(vA.version)
              const diff = yield* provideInstance(dirB)(
                withGenerationAdmission(
                  config,
                  Effect.gen(function* () {
                    const cur = yield* config.getPolicySnapshot()
                    return { version: cur.version, model: (cur.info as { model?: unknown }).model }
                  }),
                ),
              )
              expect(diff.version).toBe(vB.version)
              expect(diff.model).toBe("b/model")
              return pinned.version
            }),
          )
          expect(pinnedA).toBe(vA.version)
        }),
      { git: true },
    ),
  )
})
