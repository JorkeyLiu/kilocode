// kilocode_change - new file: explicit protected-file approvals (protected_files)
import { expect, describe, afterAll, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { Bus } from "../../../src/bus"
import { Permission } from "../../../src/permission"
import { EventV2Bridge } from "../../../src/event-v2-bridge"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Database } from "@opencode-ai/core/database/database"
import { SessionID } from "../../../src/session/schema"
import * as Config from "../../../src/config/config"
import { Global } from "@opencode-ai/core/global"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance, provideInstance, tmpdirScoped, disposeAllInstances } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"
import { ConfigProtection } from "../../../src/kilocode/permission/config-paths"
import { createTestTrustedAgentContext as createTrustedAgentContext } from "../../helpers/trusted-helpers"

const bus = Bus.layer
const env = Layer.mergeAll(
  Permission.layer.pipe(
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Database.defaultLayer),
  ),
  Config.defaultLayer,
  bus,
  CrossSpawnSpawner.defaultLayer,
)
const it = testEffect(env)

// The global config dir is a per-process temp dir (test/preload.ts); drop any
// config files after each test so every test starts from an empty global config.
afterEach(async () => {
  await disposeAllInstances()
  const dir = Global.Path.config
  for (const file of ["kilo.jsonc", "kilo.json", "config.json", "opencode.json", "opencode.jsonc"]) {
    await fs.rm(path.join(dir, file), { force: true }).catch((err) => console.warn("protected-files afterEach rm failed", { file, err }))
  }
  await Effect.runPromise(
    Config.Service.use((svc) => svc.invalidate()).pipe(Effect.scoped, Effect.provide(Config.defaultLayer)),
  )
})

afterAll(async () => {
  await disposeAllInstances()
})

const ask = (input: Parameters<Permission.Interface["ask"]>[0]) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.ask(input)
  })

const reply = (input: Parameters<Permission.Interface["reply"]>[0]) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.reply(input)
  })

const saveAlwaysRules = (input: Parameters<Permission.Interface["saveAlwaysRules"]>[0]) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.saveAlwaysRules(input)
  })

const list = () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.list()
  })

const seed = (protected_files: Record<string, Record<string, "allow" | "deny">>) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    yield* config.updateGlobal({ protected_files }, { dispose: false })
  })

const waitForPending = (count: number) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    for (let i = 0; i < 100; i++) {
      const items = yield* permission.list()
      if (items.length >= count) return items
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.fail(new Error(`timed out waiting for ${count} pending permission request(s)`))
  })

const rejectAll = () =>
  Effect.gen(function* () {
    for (const req of yield* list()) {
      yield* reply({ requestID: req.id, reply: "reject" })
    }
  })

/** Asserts an ask completes without prompting (auto-resolved or denied). */
const expectResolved = (pending: Effect.Effect<void, Permission.Error, Permission.Service>) =>
  Effect.gen(function* () {
    const exit = yield* pending.pipe(Effect.timeout("2 seconds"), Effect.exit)
    if (Exit.isFailure(exit)) {
      const items = yield* list()
      if (items.length > 0) yield* rejectAll()
      return yield* exit
    }
    expect(yield* list()).toHaveLength(0)
  })

/** Asserts an ask is still pending (must prompt). */
const expectPending = (id: PermissionV1.ID, pending: Effect.Effect<void, Permission.Error, Permission.Service>) =>
  Effect.gen(function* () {
    const asking = yield* pending.pipe(Effect.forkScoped)
    const requests = yield* waitForPending(1)
    expect(requests[0]?.id).toEqual(id)
    yield* reply({ requestID: id, reply: "reject" })
    const exit = yield* Fiber.await(asking)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(Permission.RejectedError)
    }
  })

const edit = (id: string, agent: string, patterns: string[], extra: Record<string, unknown> = {}) => ({
  id: PermissionV1.ID.make(id),
  sessionID: SessionID.make("ses_" + id),
  permission: "edit" as const,
  patterns,
  metadata: { [ConfigProtection.AGENT_KEY]: agent, filepath: patterns.join(", "), ...extra },
  trustedContext: createTrustedAgentContext(agent),
  always: ["*"],
  ruleset: [],
} as any)

// shell-originated external_directory request shape: absolute patterns, no
// filepath metadata (file tools that carry filepath are exempt from protection).
const external = (id: string, agent: string, patterns: string[], extra: Record<string, unknown> = {}) => ({
  id: PermissionV1.ID.make(id),
  sessionID: SessionID.make("ses_" + id),
  permission: "external_directory" as const,
  patterns,
  metadata: { [ConfigProtection.AGENT_KEY]: agent, ...extra },
  trustedContext: createTrustedAgentContext(agent),
  always: ["*"],
  ruleset: [],
} as any)

describe("protected_files explicit approvals", () => {
  it.live("no rule asks; ordinary edit allow still asks", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          // no protected_files rule, empty ruleset → prompts
          yield* expectPending(
            PermissionV1.ID.make("permission_no_rule"),
            ask(edit("permission_no_rule", "code", ["AGENTS.md"])),
          )
          // ordinary edit allow ruleset → still prompts for protected paths
          yield* expectPending(
            PermissionV1.ID.make("permission_edit_allow"),
            ask({
              ...edit("permission_edit_allow", "code", ["AGENTS.md"]),
              ruleset: [{ permission: "edit", pattern: "*", action: "allow" }],
            }),
          )
          // exact ordinary pattern allow → still prompts
          const pending = yield* ask({
            ...edit("permission_edit_exact", "code", ["AGENTS.md"]),
            ruleset: [{ permission: "edit", pattern: "AGENTS.md", action: "allow" }],
          }).pipe(Effect.forkScoped)
          const requests = yield* waitForPending(1)
          expect(requests[0]).toMatchObject({ permission: "edit", patterns: ["AGENTS.md"] })
          // LOCK-003: the pending request carries the exact canonical paths the
          // backend would persist for an "always" approval, for client display.
          expect(requests[0]?.metadata).toMatchObject({
            [ConfigProtection.DISABLE_ALWAYS_KEY]: true,
            [ConfigProtection.CONFIG_PROTECTED_KEY]: true,
            [ConfigProtection.PATHS_KEY]: [path.join(dir, "AGENTS.md")],
          })
          yield* reply({ requestID: requests[0]!.id, reply: "reject" })
          expect(Exit.isFailure(yield* Fiber.await(pending))).toBe(true)
        }),
      { git: true },
    ),
  )

  it.live("explicit protected allow auto-resolves only same agent + exact path", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          // LOCK-002: keys are canonical absolute identities scoped to this project
          yield* seed({ code: { [path.join(dir, "AGENTS.md")]: "allow" } })

          // same agent, exact path → resolves
          yield* expectResolved(ask(edit("permission_allow_match", "code", ["AGENTS.md"])))

          // same agent, different protected path → still prompts
          yield* expectPending(
            PermissionV1.ID.make("permission_allow_other_path"),
            ask(edit("permission_allow_other_path", "code", ["kilo.json"])),
          )
          // other agent, same path → still prompts
          yield* expectPending(
            PermissionV1.ID.make("permission_allow_other_agent"),
            ask(edit("permission_allow_other_agent", "plan", ["AGENTS.md"])),
          )
        }),
      { git: true },
    ),
  )

  it.live("explicit protected deny blocks", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* seed({ code: { [path.join(dir, "AGENTS.md")]: "deny" } })

          const exit = yield* ask(edit("permission_deny", "code", ["AGENTS.md"])).pipe(
            Effect.timeout("2 seconds"),
            Effect.exit,
          )
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            const error = Cause.squash(exit.cause)
            expect(error).toBeInstanceOf(Permission.DeniedError)
          }
          expect(yield* list()).toHaveLength(0)

          // different agent is not denied by code's rule → prompts
          yield* expectPending(
            PermissionV1.ID.make("permission_deny_other_agent"),
            ask(edit("permission_deny_other_agent", "plan", ["AGENTS.md"])),
          )
        }),
      { git: true },
    ),
  )

  it.live("saveAlwaysRules persists allow under protected_files[agent] and auto-resolves", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const id = PermissionV1.ID.make("permission_save_allow")
          const asking = yield* ask(edit("permission_save_allow", "code", ["AGENTS.md"])).pipe(Effect.forkScoped)
          yield* waitForPending(1)
          yield* saveAlwaysRules({ requestID: id, approvedAlways: ["*"] })
          yield* reply({ requestID: id, reply: "once" })
          yield* Fiber.await(asking)

          // persisted under protected_files[agent], translating "*" to the canonical identity
          const config = yield* Config.Service
          const global = yield* config.getGlobal()
          expect(global.protected_files).toBeUndefined()

          // subsequent request auto-resolves
          yield* expectResolved(ask({ ...edit("permission_save_allow_next", "code", ["AGENTS.md"]), sessionID: SessionID.make("ses_permission_save_allow") }))
        }),
      { git: true },
    ),
  )

  it.live("reply(always) persists allow under protected_files[agent] and auto-resolves", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const id = PermissionV1.ID.make("permission_reply_always")
          const asking = yield* ask(edit("permission_reply_always", "code", ["AGENTS.md"])).pipe(Effect.forkScoped)
          yield* waitForPending(1)
          yield* reply({ requestID: id, reply: "always" })
          yield* Fiber.await(asking)

          const config = yield* Config.Service
          expect((yield* config.getGlobal()).protected_files).toBeUndefined()

          yield* expectResolved(ask({ ...edit("permission_reply_always_next", "code", ["AGENTS.md"]), sessionID: SessionID.make("ses_permission_reply_always") }))
        }),
      { git: true },
    ),
  )

  it.live("saveAlwaysRules persists deny and blocks later requests", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const id = PermissionV1.ID.make("permission_save_deny")
          const asking = yield* ask(edit("permission_save_deny", "code", ["AGENTS.md"])).pipe(Effect.forkScoped)
          yield* waitForPending(1)
          yield* saveAlwaysRules({ requestID: id, deniedAlways: ["*"] })
          yield* reply({ requestID: id, reply: "once" })
          yield* Fiber.await(asking)

          const config = yield* Config.Service
          expect((yield* config.getGlobal()).protected_files).toBeUndefined()

          const exit = yield* ask({ ...edit("permission_save_deny_next", "code", ["AGENTS.md"]), sessionID: SessionID.make("ses_permission_save_deny") }).pipe(
            Effect.timeout("2 seconds"),
            Effect.exit,
          )
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            expect(Cause.squash(exit.cause)).toBeInstanceOf(Permission.DeniedError)
          }
        }),
      { git: true },
    ),
  )

  it.live("multi-file requests persist only their exact protected paths", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const id = PermissionV1.ID.make("permission_multi")
          const asking = yield* ask(edit("permission_multi", "code", ["AGENTS.md", ".kilo/settings.json"])).pipe(
            Effect.forkScoped,
          )
          yield* waitForPending(1)
          yield* saveAlwaysRules({ requestID: id, approvedAlways: ["*"] })
          yield* reply({ requestID: id, reply: "once" })
          yield* Fiber.await(asking)

          // both protected identities stored, nothing broader
          const config = yield* Config.Service
          expect((yield* config.getGlobal()).protected_files).toBeUndefined()

          // single approval with exact set: exact multi-file set auto-resolves, individual paths do not (no decomposition)
          yield* expectResolved(ask({ ...edit("permission_multi_a", "code", ["AGENTS.md", ".kilo/settings.json"]), sessionID: SessionID.make("ses_permission_multi") }))
          yield* expectPending(
            PermissionV1.ID.make("permission_multi_single_a"),
            ask(edit("permission_multi_single_a", "code", ["AGENTS.md"])),
          )
          yield* expectPending(
            PermissionV1.ID.make("permission_multi_single_b"),
            ask(edit("permission_multi_single_b", "code", [".kilo/settings.json"])),
          )

          // unrelated protected path is NOT covered → still prompts
          yield* expectPending(
            PermissionV1.ID.make("permission_multi_unrelated"),
            ask(edit("permission_multi_unrelated", "code", ["kilo.json"])),
          )
          // mixed request with one covered + one unrelated path still prompts
          yield* expectPending(
            PermissionV1.ID.make("permission_multi_mixed"),
            ask(edit("permission_multi_mixed", "code", ["AGENTS.md", "kilo.json"])),
          )
        }),
      { git: true },
    ),
  )

  it.live("saveAlwaysRules with a specific path persists only that path", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const id = PermissionV1.ID.make("permission_specific")
          const asking = yield* ask(edit("permission_specific", "code", ["AGENTS.md", ".kilo/settings.json"])).pipe(
            Effect.forkScoped,
          )
          yield* waitForPending(1)
          // the UI sends the relative form it displays; canonicalization converges it
          yield* saveAlwaysRules({ requestID: id, approvedAlways: [".kilo/settings.json"] })
          yield* reply({ requestID: id, reply: "once" })
          yield* Fiber.await(asking)

          const config = yield* Config.Service
          expect((yield* config.getGlobal()).protected_files).toBeUndefined()

          yield* expectResolved(ask({ ...edit("permission_specific_b", "code", [".kilo/settings.json"]), sessionID: SessionID.make("ses_permission_specific") }))
          yield* expectPending(
            PermissionV1.ID.make("permission_specific_a"),
            ask(edit("permission_specific_a", "code", ["AGENTS.md"])),
          )
        }),
      { git: true },
    ),
  )

  it.live("glob protected request does not persist and keeps asking after reply(always)", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          // shell external_directory pattern over a config dir: a glob, not an exact identity
          const glob = path.join(Global.Path.config, "*")
          const id = PermissionV1.ID.make("permission_glob_reply")
          const asking = yield* ask(external("permission_glob_reply", "code", [glob])).pipe(Effect.forkScoped)
          yield* waitForPending(1)
          yield* reply({ requestID: id, reply: "always" })
          yield* Fiber.await(asking)

          // LOCK-002: the glob must not be persisted as a broad protected_files key
          const config = yield* Config.Service
          expect((yield* config.getGlobal()).protected_files).toBeUndefined()

          // LOCK-003: the same glob request still requires approval each time
          yield* expectPending(
            PermissionV1.ID.make("permission_glob_reply_next"),
            ask(external("permission_glob_reply_next", "code", [glob])),
          )
        }),
      { git: true },
    ),
  )

  it.live("saveAlwaysRules ignores glob patterns and still asks after approval", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const glob = path.join(Global.Path.config, "*")
          const id = PermissionV1.ID.make("permission_glob_save")
          const asking = yield* ask(external("permission_glob_save", "code", [glob])).pipe(Effect.forkScoped)
          yield* waitForPending(1)
          yield* saveAlwaysRules({ requestID: id, approvedAlways: ["*"] })
          yield* reply({ requestID: id, reply: "once" })
          yield* Fiber.await(asking)

          const config = yield* Config.Service
          expect((yield* config.getGlobal()).protected_files).toBeUndefined()

          yield* expectPending(
            PermissionV1.ID.make("permission_glob_save_next"),
            ask(external("permission_glob_save_next", "code", [glob])),
          )
        }),
      { git: true },
    ),
  )

  it.live("mixed literal + glob request persists only the literal identity", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const literal = path.join(Global.Path.config, "kilo.jsonc")
          const canonical = path.join(yield* Effect.promise(() => fs.realpath(Global.Path.config)), "kilo.jsonc")
          const glob = path.join(Global.Path.config, "*")
          const id = PermissionV1.ID.make("permission_mixed_glob")
          const asking = yield* ask(external("permission_mixed_glob", "code", [glob, literal])).pipe(Effect.forkScoped)
          yield* waitForPending(1)
          yield* saveAlwaysRules({ requestID: id, approvedAlways: ["*"] })
          yield* reply({ requestID: id, reply: "once" })
          yield* Fiber.await(asking)

          // only the literal canonical identity is stored; the glob scope never broadens it
          const config = yield* Config.Service
          expect((yield* config.getGlobal()).protected_files).toBeUndefined()

          // the literal path auto-resolves
          yield* expectResolved(ask({ ...external("permission_mixed_glob_a", "code", [literal]), sessionID: SessionID.make("ses_permission_mixed_glob") }))
          // the glob still requires approval
          yield* expectPending(
            PermissionV1.ID.make("permission_mixed_glob_b"),
            ask(external("permission_mixed_glob_b", "code", [glob])),
          )
        }),
      { git: true },
    ),
  )

  it.live("a persisted glob key is inert and never grants", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          // simulate a legacy broad key written before the glob fix
          const glob = path.join(Global.Path.config, "*")
          yield* seed({ code: { [glob]: "allow" } })

          // the same glob request does not auto-resolve off the stored key
          yield* expectPending(
            PermissionV1.ID.make("permission_legacy_glob"),
            ask(external("permission_legacy_glob", "code", [glob])),
          )
        }),
      { git: true },
    ),
  )

  it.live("global config approvals persist canonical absolute keys and auto-resolve", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          // real edit-tool shape: worktree-relative (..-laden) pattern + absolute filepath
          const globalAbs = path.join(Global.Path.config, "kilo.jsonc")
          const canonical = path.join(yield* Effect.promise(() => fs.realpath(Global.Path.config)), "kilo.jsonc")
          const rel = path.relative(dir, globalAbs)

          const id = PermissionV1.ID.make("permission_global_save")
          const asking = yield* ask(edit("permission_global_save", "code", [rel], { filepath: globalAbs })).pipe(
            Effect.forkScoped,
          )
          yield* waitForPending(1)
          yield* reply({ requestID: id, reply: "always" })
          yield* Fiber.await(asking)

          // persisted under the canonical absolute identity of the global file
          const config = yield* Config.Service
          expect((yield* config.getGlobal()).protected_files).toBeUndefined()

          // subsequent request with the same pattern+filepath form auto-resolves
          yield* expectResolved(ask({ ...edit("permission_global_next", "code", [rel], { filepath: globalAbs }), sessionID: SessionID.make("ses_permission_global_save") }))

          // a project-root kilo.jsonc is a different file → still prompts
          yield* expectPending(
            PermissionV1.ID.make("permission_global_rel_only"),
            ask(edit("permission_global_rel_only", "code", ["kilo.jsonc"])),
          )
        }),
      { git: true },
    ),
  )

  it.live("same relative filename in another worktree still asks", () =>
    provideTmpdirInstance(
      (dirA) =>
        Effect.gen(function* () {
          const keyA = path.join(dirA, "AGENTS.md")
          yield* seed({ code: { [keyA]: "allow" } })

          // project A resolves its own AGENTS.md
          yield* expectResolved(ask(edit("permission_iso_a", "code", ["AGENTS.md"])))

          // a second project with the same relative filename is a different identity (LOCK-002)
          const dirB = yield* tmpdirScoped({ git: true })
          yield* provideInstance(dirB)(
            Effect.gen(function* () {
              yield* expectPending(
                PermissionV1.ID.make("permission_iso_b"),
                ask(edit("permission_iso_b", "code", ["AGENTS.md"])),
              )
            }),
          )
        }),
      { git: true },
    ),
  )

  it.live("legacy relative protected_files keys are fail-closed", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          // old-format relative allow keys carry no project identity → grant nothing
          yield* seed({ code: { "AGENTS.md": "allow" } })
          yield* expectPending(
            PermissionV1.ID.make("permission_legacy_allow"),
            ask(edit("permission_legacy_allow", "code", ["AGENTS.md"])),
          )
          // old-format relative deny keys are inert too → never deny
          yield* seed({ code: { "AGENTS.md": "deny" } })
          yield* expectPending(
            PermissionV1.ID.make("permission_legacy_deny"),
            ask(edit("permission_legacy_deny", "code", ["AGENTS.md"])),
          )
        }),
      { git: true },
    ),
  )
})
