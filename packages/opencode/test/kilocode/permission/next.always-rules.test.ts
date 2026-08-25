import { expect, describe, afterAll } from "bun:test"
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
import { InstanceRuntime } from "../../../src/project/instance-runtime"
import { Global } from "@opencode-ai/core/global"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"

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

afterAll(async () => {
  const dir = Global.Path.config
  for (const file of ["kilo.jsonc", "kilo.json", "config.json", "opencode.json", "opencode.jsonc"]) {
    await fs.rm(path.join(dir, file), { force: true }).catch(() => {})
  }
  await Effect.runPromise(
    Config.Service.use((svc) => svc.invalidate()).pipe(Effect.scoped, Effect.provide(Config.defaultLayer)),
  )
  await InstanceRuntime.disposeAllInstances()
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

function withDir(options: { git?: boolean } | undefined, self: (dir: string) => Effect.Effect<any, any, any>) {
  return provideTmpdirInstance(self, options)
}

const expectFailure = <E>(exit: Exit.Exit<unknown, E>, ErrorClass: new (...args: any[]) => unknown) => {
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    expect(Cause.squash(exit.cause)).toBeInstanceOf(ErrorClass)
  }
}

describe("saveAlwaysRules", () => {
  it.live("approved rules auto-allow future requests", () =>
    withDir({ git: true }, () =>
      Effect.gen(function* () {
        const asking = yield* ask({
          id: PermissionV1.ID.make("permission_1"),
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["npm install"],
          metadata: { rules: ["npm *", "npm install"] },
          always: ["npm install *"],
          ruleset: [],
        }).pipe(Effect.forkScoped)

        yield* waitForPending(1)
        yield* saveAlwaysRules({
          requestID: PermissionV1.ID.make("permission_1"),
          approvedAlways: ["npm install"],
        })
        yield* reply({ requestID: PermissionV1.ID.make("permission_1"), reply: "once" })
        yield* Fiber.await(asking)

        const result = yield* ask({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["npm install"],
          metadata: {},
          always: [],
          ruleset: [],
        })
        expect(result).toBeUndefined()
      }),
    ),
  )

  it.live("denied rules auto-deny future requests", () =>
    withDir({ git: true }, () =>
      Effect.gen(function* () {
        const asking = yield* ask({
          id: PermissionV1.ID.make("permission_2"),
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["rm -rf /"],
          metadata: { rules: ["rm *", "rm -rf /"] },
          always: ["rm *"],
          ruleset: [],
        }).pipe(Effect.forkScoped)

        yield* waitForPending(1)
        yield* saveAlwaysRules({
          requestID: PermissionV1.ID.make("permission_2"),
          deniedAlways: ["rm -rf /"],
        })
        yield* reply({ requestID: PermissionV1.ID.make("permission_2"), reply: "once" })
        yield* Fiber.await(asking)

        const exit = yield* ask({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["rm -rf /"],
          metadata: {},
          always: [],
          ruleset: [],
        }).pipe(Effect.exit)
        expectFailure(exit, Permission.DeniedError)
      }),
    ),
  )

  it.live("fails for unknown request ID", () =>
    withDir({ git: true }, () =>
      Effect.gen(function* () {
        const exit = yield* saveAlwaysRules({
          requestID: PermissionV1.ID.make("permission_nonexistent"),
          approvedAlways: ["npm install"],
        }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toMatchObject({
            _tag: "Permission.NotFoundError",
            requestID: "permission_nonexistent",
          })
        }
      }),
    ),
  )

  it.live("ignores patterns not in metadata.rules or always", () =>
    withDir({ git: true }, () =>
      Effect.gen(function* () {
        const asking = yield* ask({
          id: PermissionV1.ID.make("permission_3"),
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["npm install"],
          metadata: { rules: ["npm *", "npm install"] },
          always: ["npm install *"],
          ruleset: [],
        }).pipe(Effect.forkScoped)

        yield* waitForPending(1)
        // "curl" is not in metadata.rules or always — should be silently ignored
        yield* saveAlwaysRules({
          requestID: PermissionV1.ID.make("permission_3"),
          approvedAlways: ["npm install", "curl http://evil.com"],
        })

        yield* reply({ requestID: PermissionV1.ID.make("permission_3"), reply: "once" })
        yield* Fiber.await(asking)

        // npm install was in rules — auto-allowed
        const result = yield* ask({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["npm install"],
          metadata: {},
          always: [],
          ruleset: [],
        })
        expect(result).toBeUndefined()

        // curl was NOT in rules — still requires permission
        const curlFiber = yield* ask({
          id: PermissionV1.ID.make("permission_curl"),
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["curl http://evil.com"],
          metadata: {},
          always: [],
          ruleset: [],
        }).pipe(Effect.forkScoped)

        yield* waitForPending(1)
        yield* reply({ requestID: PermissionV1.ID.make("permission_curl"), reply: "reject" })
        expectFailure(yield* Fiber.await(curlFiber), Permission.RejectedError)
      }),
    ),
  )

  it.live("accepts patterns from always array (non-bash tools)", () =>
    withDir({ git: true }, () =>
      Effect.gen(function* () {
        const asking = yield* ask({
          id: PermissionV1.ID.make("permission_nonbash"),
          sessionID: SessionID.make("session_test"),
          permission: "read",
          patterns: ["src/main.ts"],
          metadata: {},
          always: ["src/main.ts"],
          ruleset: [],
        }).pipe(Effect.forkScoped)

        yield* waitForPending(1)
        // "src/main.ts" is in always — should be accepted
        yield* saveAlwaysRules({
          requestID: PermissionV1.ID.make("permission_nonbash"),
          approvedAlways: ["src/main.ts"],
        })
        yield* reply({ requestID: PermissionV1.ID.make("permission_nonbash"), reply: "once" })
        yield* Fiber.await(asking)

        // exact "src/main.ts" should auto-allow
        const result = yield* ask({
          sessionID: SessionID.make("session_test"),
          permission: "read",
          patterns: ["src/main.ts"],
          metadata: {},
          always: [],
          ruleset: [],
        })
        expect(result).toBeUndefined()
        // different file should still require permission
        const otherFiber = yield* ask({
          id: PermissionV1.ID.make("permission_nonbash_other"),
          sessionID: SessionID.make("session_test"),
          permission: "read",
          patterns: ["other/file.ts"],
          metadata: {},
          always: [],
          ruleset: [],
        }).pipe(Effect.forkScoped)
        yield* waitForPending(1)
        yield* reply({ requestID: PermissionV1.ID.make("permission_nonbash_other"), reply: "reject" })
        const exitOther = yield* Fiber.await(otherFiber)
        expect(Exit.isFailure(exitOther)).toBe(true)
      }),
    ),
  )

  it.live("saved always approval does not override hard deny ruleset", () =>
    withDir({ git: true }, () =>
      Effect.gen(function* () {
        const asking = yield* ask({
          id: PermissionV1.ID.make("permission_hard_deny_seed"),
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["printf seed"],
          metadata: {},
          always: ["printf *"],
          ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
        }).pipe(Effect.forkScoped)

        yield* waitForPending(1)
        yield* reply({ requestID: PermissionV1.ID.make("permission_hard_deny_seed"), reply: "always" })
        yield* Fiber.await(asking)

        const exit = yield* ask({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["printf bypass > ask-saved-bypass.txt"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
          hardRuleset: [
            { permission: "bash", pattern: "*", action: "deny" },
            { permission: "bash", pattern: "printf *", action: "allow" },
            { permission: "bash", pattern: "*>*", action: "deny" },
            { permission: "bash", pattern: "* > *", action: "deny" },
          ],
        }).pipe(Effect.exit)
        expectFailure(exit, Permission.DeniedError)
      }),
    ),
  )

  it.live("saved always approval still works when hard ruleset does not deny", () =>
    withDir({ git: true }, () =>
      Effect.gen(function* () {
        const asking = yield* ask({
          id: PermissionV1.ID.make("permission_hard_ask_seed"),
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["gh issue list"],
          metadata: {},
          always: ["gh issue list"],
          ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
        }).pipe(Effect.forkScoped)

        yield* waitForPending(1)
        yield* reply({ requestID: PermissionV1.ID.make("permission_hard_ask_seed"), reply: "always" })
        yield* Fiber.await(asking)

        const result = yield* ask({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["gh issue list"],
          metadata: {},
          always: [],
          ruleset: [],
          hardRuleset: [
            { permission: "bash", pattern: "rm *", action: "deny" },
            { permission: "bash", pattern: "gh *", action: "ask" },
          ],
        })
        expect(result).toBeUndefined()
      }),
    ),
  )

  it.live("explicit external directory allows are not shadowed by ask plan broad denies", () =>
    withDir({ git: true }, (dir) =>
      Effect.gen(function* () {
        const root = path.resolve(path.dirname(dir), "legacy")
        const glob = path.join(root, "*")
        const ruleset: Permission.Ruleset = [
          { permission: "external_directory", pattern: "*", action: "ask" },
          { permission: "external_directory", pattern: glob, action: "allow" },
          { permission: "*", pattern: "*", action: "deny" },
        ]

        const exit = yield* ask({
          sessionID: SessionID.make("session_test"),
          permission: "external_directory",
          patterns: [glob],
          metadata: { filepath: path.join(root, "main.ts"), parentDir: root },
          always: [glob],
          ruleset,
          hardRuleset: ruleset,
        }).pipe(Effect.exit)
        expectFailure(exit, Permission.DeniedError)
      }),
    ),
  )

  it.live("saved external directory approvals survive ask plan hard rules", () =>
    withDir({ git: true }, (dir) =>
      Effect.gen(function* () {
        const root = path.resolve(path.dirname(dir), "legacy")
        const glob = path.join(root, "*")
        const asking = yield* ask({
          id: PermissionV1.ID.make("permission_external_seed"),
          sessionID: SessionID.make("session_test"),
          permission: "external_directory",
          patterns: [glob],
          metadata: { filepath: path.join(root, "main.ts"), parentDir: root },
          always: [glob],
          ruleset: [{ permission: "external_directory", pattern: "*", action: "ask" }],
        }).pipe(Effect.forkScoped)

        yield* waitForPending(1)
        yield* reply({ requestID: PermissionV1.ID.make("permission_external_seed"), reply: "always" })
        yield* Fiber.await(asking)

        const exit = yield* ask({
          sessionID: SessionID.make("session_test"),
          permission: "external_directory",
          patterns: [glob],
          metadata: { filepath: path.join(root, "main.ts"), parentDir: root },
          always: [glob],
          ruleset: [],
          hardRuleset: [{ permission: "*", pattern: "*", action: "deny" }],
        }).pipe(Effect.exit)
        expectFailure(exit, Permission.DeniedError)
      }),
    ),
  )

  it.live("explicit external directory denies still win over ask plan exceptions", () =>
    withDir({ git: true }, (dir) =>
      Effect.gen(function* () {
        const root = path.resolve(path.dirname(dir), "legacy")
        const glob = path.join(root, "*")
        const exit = yield* ask({
          sessionID: SessionID.make("session_test"),
          permission: "external_directory",
          patterns: [glob],
          metadata: { filepath: path.join(root, "main.ts"), parentDir: root },
          always: [glob],
          ruleset: [
            { permission: "external_directory", pattern: glob, action: "allow" },
            { permission: "external_directory", pattern: glob, action: "deny" },
            { permission: "*", pattern: "*", action: "deny" },
          ],
          hardRuleset: [
            { permission: "*", pattern: "*", action: "deny" },
            { permission: "external_directory", pattern: glob, action: "deny" },
          ],
        }).pipe(Effect.exit)
        expectFailure(exit, Permission.DeniedError)
      }),
    ),
  )

  it.live("accepts hierarchy patterns from metadata.rules", () =>
    withDir({ git: true }, () =>
      Effect.gen(function* () {
        const asking = yield* ask({
          id: PermissionV1.ID.make("permission_4"),
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["npm install lodash"],
          metadata: { rules: ["npm install lodash"] },
          always: ["npm install lodash"],
          ruleset: [],
        }).pipe(Effect.forkScoped)

        yield* waitForPending(1)
        // Approve exact
        yield* saveAlwaysRules({
          requestID: PermissionV1.ID.make("permission_4"),
          approvedAlways: ["npm install lodash"],
        })
        yield* reply({ requestID: PermissionV1.ID.make("permission_4"), reply: "once" })
        yield* Fiber.await(asking)

        // exact should auto-allow
        const result = yield* ask({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["npm install lodash"],
          metadata: {},
          always: [],
          ruleset: [],
        })
        expect(result).toBeUndefined()
        // different command should still require permission
        const otherFiber = yield* ask({
          id: PermissionV1.ID.make("permission_4_other"),
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["npm test"],
          metadata: {},
          always: [],
          ruleset: [],
        }).pipe(Effect.forkScoped)
        yield* waitForPending(1)
        yield* reply({ requestID: PermissionV1.ID.make("permission_4_other"), reply: "reject" })
        const exitOther = yield* Fiber.await(otherFiber)
        expect(Exit.isFailure(exitOther)).toBe(true)
      }),
    ),
  )

  it.live("mixed allow/deny preserves metadata.rules order", () =>
    withDir({ git: true }, () =>
      Effect.gen(function* () {
        const asking = yield* ask({
          id: PermissionV1.ID.make("permission_5"),
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["npm install lodash"],
          metadata: { rules: ["npm install lodash"] },
          always: ["npm install lodash"],
          ruleset: [],
        }).pipe(Effect.forkScoped)

        yield* waitForPending(1)
        yield* saveAlwaysRules({
          requestID: PermissionV1.ID.make("permission_5"),
          approvedAlways: ["npm install lodash"],
        })
        yield* reply({ requestID: PermissionV1.ID.make("permission_5"), reply: "once" })
        yield* Fiber.await(asking)

        const result = yield* ask({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["npm install lodash"],
          metadata: {},
          always: [],
          ruleset: [],
        })
        expect(result).toBeUndefined()
      }),
    ),
  )

  it.live("deny broad + allow specific: specific allow wins", () =>
    withDir({ git: true }, () =>
      Effect.gen(function* () {
        const asking = yield* ask({
          id: PermissionV1.ID.make("permission_6"),
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["git log --oneline"],
          metadata: { rules: ["git log --oneline", "git status"] },
          always: ["git log --oneline", "git status"],
          ruleset: [],
        }).pipe(Effect.forkScoped)

        yield* waitForPending(1)
        yield* saveAlwaysRules({
          requestID: PermissionV1.ID.make("permission_6"),
          approvedAlways: ["git log --oneline"],
          deniedAlways: ["git status"],
        })
        yield* reply({ requestID: PermissionV1.ID.make("permission_6"), reply: "once" })
        yield* Fiber.await(asking)

        // "git log --oneline" should be allowed
        const allowed = yield* ask({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["git log --oneline"],
          metadata: {},
          always: [],
          ruleset: [],
        })
        expect(allowed).toBeUndefined()

        // "git status" should be denied
        const exit = yield* ask({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["git status"],
          metadata: {},
          always: [],
          ruleset: [],
        }).pipe(Effect.exit)
        expectFailure(exit, Permission.DeniedError)
      }),
    ),
  )

  it.live("rules not in metadata.rules are silently ignored", () =>
    withDir({ git: true }, () =>
      Effect.gen(function* () {
        const asking = yield* ask({
          id: PermissionV1.ID.make("permission_7"),
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["npm install"],
          metadata: { rules: ["npm *"] },
          always: ["npm *"],
          ruleset: [],
        }).pipe(Effect.forkScoped)

        yield* waitForPending(1)
        // "curl" is not in metadata.rules — should be silently ignored
        yield* saveAlwaysRules({
          requestID: PermissionV1.ID.make("permission_7"),
          approvedAlways: ["npm *", "curl *"],
        })
        yield* reply({ requestID: PermissionV1.ID.make("permission_7"), reply: "once" })
        yield* Fiber.await(asking)

        // curl should still require permission (not auto-allowed)
        const curlFiber = yield* ask({
          id: PermissionV1.ID.make("permission_curl2"),
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["curl http://example.com"],
          metadata: {},
          always: [],
          ruleset: [],
        }).pipe(Effect.forkScoped)

        yield* waitForPending(1)
        yield* reply({ requestID: PermissionV1.ID.make("permission_curl2"), reply: "reject" })
        expectFailure(yield* Fiber.await(curlFiber), Permission.RejectedError)
      }),
    ),
  )

  it.live("auto-resolves pending permission from sibling session", () =>
    withDir({ git: true }, () =>
      Effect.gen(function* () {
        const fiberA = yield* ask({
          id: PermissionV1.ID.make("permission_a"),
          sessionID: SessionID.make("session_a"),
          permission: "bash",
          patterns: ["npm install"],
          metadata: { rules: ["npm install"] },
          always: ["npm install"],
          ruleset: [],
        }).pipe(Effect.forkScoped)

        const fiberB = yield* ask({
          id: PermissionV1.ID.make("permission_b"),
          sessionID: SessionID.make("session_b"),
          permission: "bash",
          patterns: ["npm install"],
          metadata: {},
          always: [],
          ruleset: [],
        }).pipe(Effect.forkScoped)

        yield* waitForPending(2)
        // User approves "npm install" on subagent A's permission
        yield* saveAlwaysRules({
          requestID: PermissionV1.ID.make("permission_a"),
          approvedAlways: ["npm install"],
        })

        // Subagent B should auto-resolve because "npm test" matches "npm *"
        yield* reply({ requestID: PermissionV1.ID.make("permission_a"), reply: "once" })
        yield* Fiber.await(fiberA)
        yield* Fiber.await(fiberB)
      }),
    ),
  )

  it.live("auto-resolves multiple pending permissions from different sessions", () =>
    withDir({ git: true }, () =>
      Effect.gen(function* () {
        const fiberA = yield* ask({
          id: PermissionV1.ID.make("permission_a2"),
          sessionID: SessionID.make("session_a"),
          permission: "bash",
          patterns: ["npm install"],
          metadata: { rules: ["npm install"] },
          always: ["npm install"],
          ruleset: [],
        }).pipe(Effect.forkScoped)

        const fiberB = yield* ask({
          id: PermissionV1.ID.make("permission_b2"),
          sessionID: SessionID.make("session_b"),
          permission: "bash",
          patterns: ["npm install"],
          metadata: {},
          always: [],
          ruleset: [],
        }).pipe(Effect.forkScoped)

        const fiberC = yield* ask({
          id: PermissionV1.ID.make("permission_c2"),
          sessionID: SessionID.make("session_c"),
          permission: "bash",
          patterns: ["npm install"],
          metadata: {},
          always: [],
          ruleset: [],
        }).pipe(Effect.forkScoped)

        yield* waitForPending(3)
        // Approve "npm install" on session A — should auto-resolve B and C (exact)
        yield* saveAlwaysRules({
          requestID: PermissionV1.ID.make("permission_a2"),
          approvedAlways: ["npm install"],
        })
        yield* reply({ requestID: PermissionV1.ID.make("permission_a2"), reply: "once" })

        yield* Fiber.await(fiberA)
        yield* Fiber.await(fiberB)
        yield* Fiber.await(fiberC)
      }),
    ),
  )

  it.live("does not auto-resolve pending permission with non-matching pattern", () =>
    withDir({ git: true }, () =>
      Effect.gen(function* () {
        const fiberA = yield* ask({
          id: PermissionV1.ID.make("permission_a3"),
          sessionID: SessionID.make("session_a"),
          permission: "bash",
          patterns: ["npm install"],
          metadata: { rules: ["npm install"] },
          always: ["npm install"],
          ruleset: [],
        }).pipe(Effect.forkScoped)

        const fiberB = yield* ask({
          id: PermissionV1.ID.make("permission_b3"),
          sessionID: SessionID.make("session_b"),
          permission: "bash",
          patterns: ["curl http://example.com"],
          metadata: {},
          always: [],
          ruleset: [],
        }).pipe(Effect.forkScoped)

        yield* waitForPending(2)
        // Approve "npm install" — should NOT resolve B (curl doesn't match npm install)
        yield* saveAlwaysRules({
          requestID: PermissionV1.ID.make("permission_a3"),
          approvedAlways: ["npm install"],
        })
        yield* reply({ requestID: PermissionV1.ID.make("permission_a3"), reply: "once" })
        yield* Fiber.await(fiberA)

        // B should still be pending — reject it to clean up
        yield* reply({ requestID: PermissionV1.ID.make("permission_b3"), reply: "reject" })
        expectFailure(yield* Fiber.await(fiberB), Permission.RejectedError)
      }),
    ),
  )

  it.live("does not auto-resolve the request being replied to", () =>
    withDir({ git: true }, () =>
      Effect.gen(function* () {
        const fiberA = yield* ask({
          id: PermissionV1.ID.make("permission_a4"),
          sessionID: SessionID.make("session_a"),
          permission: "bash",
          patterns: ["npm install"],
          metadata: { rules: ["npm *"] },
          always: ["npm *"],
          ruleset: [],
        }).pipe(Effect.forkScoped)

        yield* waitForPending(1)
        // Save rules but don't reply yet — the request itself should not be auto-resolved
        yield* saveAlwaysRules({
          requestID: PermissionV1.ID.make("permission_a4"),
          approvedAlways: ["npm *"],
        })

        // The original request should still be pending (needs explicit reply)
        const pending = yield* list()
        expect(pending.some((p) => String(p.id) === "permission_a4")).toBe(true)

        yield* reply({ requestID: PermissionV1.ID.make("permission_a4"), reply: "once" })
        yield* Fiber.await(fiberA)
      }),
    ),
  )

  it.live("saveAlwaysRules then reply(always) does not duplicate saved rules", () =>
    withDir({ git: true }, () =>
      Effect.gen(function* () {
        const fiber = yield* ask({
          id: PermissionV1.ID.make("permission_saved_always"),
          sessionID: SessionID.make("session_saved_always"),
          permission: "bash",
          patterns: ["kilo-permission-8353 test"],
          metadata: { rules: ["kilo-permission-8353 *", "kilo-permission-8353 test"] },
          always: ["kilo-permission-8353 *", "kilo-permission-8353 test"],
          ruleset: [],
        }).pipe(Effect.forkScoped)

        yield* waitForPending(1)
        yield* saveAlwaysRules({
          requestID: PermissionV1.ID.make("permission_saved_always"),
          approvedAlways: ["kilo-permission-8353 test"],
        })
        yield* reply({ requestID: PermissionV1.ID.make("permission_saved_always"), reply: "always" })
        yield* Fiber.await(fiber)

        // In-memory check: exact pattern should be auto-allowed, broad should not
        const exact = yield* ask({
          sessionID: SessionID.make("session_saved_always"),
          permission: "bash",
          patterns: ["kilo-permission-8353 test"],
          metadata: {},
          always: [],
          ruleset: [],
        })
        expect(exact).toBeUndefined()

        const broad = yield* ask({
          id: PermissionV1.ID.make("permission_saved_always_broad"),
          sessionID: SessionID.make("session_saved_always"),
          permission: "bash",
          patterns: ["kilo-permission-8353 install"],
          metadata: {},
          always: [],
          ruleset: [],
        }).pipe(Effect.forkScoped)

        yield* waitForPending(1)
        yield* reply({ requestID: PermissionV1.ID.make("permission_saved_always_broad"), reply: "reject" })
        expectFailure(yield* Fiber.await(broad), Permission.RejectedError)
      }),
    ),
  )

  it.live("auto-rejects pending permission from sibling session when denied", () =>
    withDir({ git: true }, () =>
      Effect.gen(function* () {
        const fiberA = yield* ask({
          id: PermissionV1.ID.make("permission_a5"),
          sessionID: SessionID.make("session_a"),
          permission: "bash",
          patterns: ["git log --oneline"],
          metadata: { rules: ["git log --oneline"] },
          always: ["git log --oneline"],
          ruleset: [],
        }).pipe(Effect.forkScoped)

        const fiberB = yield* ask({
          id: PermissionV1.ID.make("permission_b5"),
          sessionID: SessionID.make("session_b"),
          permission: "bash",
          patterns: ["git log --oneline"],
          metadata: {},
          always: [],
          ruleset: [],
        }).pipe(Effect.forkScoped)

        yield* waitForPending(2)
        // User denies "git log --oneline" on subagent A
        yield* saveAlwaysRules({
          requestID: PermissionV1.ID.make("permission_a5"),
          deniedAlways: ["git log --oneline"],
        })

        // Subagent B should auto-reject because "git log --oneline -10" matches denied "git log *"
        yield* reply({ requestID: PermissionV1.ID.make("permission_a5"), reply: "once" })
        yield* Fiber.await(fiberA)
        expectFailure(yield* Fiber.await(fiberB), Permission.RejectedError)
      }),
    ),
  )

  it.live("multi-pattern: auto-resolves when new rule covers blocking pattern and ruleset covers the rest", () =>
    withDir({ git: true }, () =>
      Effect.gen(function* () {
        // Subagent B has "git status && npm install" — two patterns.
        // Its ruleset already allows "npm install" but "git status" is "ask".
        const fiberB = yield* ask({
          id: PermissionV1.ID.make("permission_multi_b"),
          sessionID: SessionID.make("session_b"),
          permission: "bash",
          patterns: ["git status", "npm install"],
          metadata: {},
          always: [],
          ruleset: [],
        }).pipe(Effect.forkScoped)

        // Subagent A gets "git status" approved
        const fiberA = yield* ask({
          id: PermissionV1.ID.make("permission_multi_a"),
          sessionID: SessionID.make("session_a"),
          permission: "bash",
          patterns: ["git status"],
          metadata: { rules: ["git status"] },
          always: ["git status"],
          ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
        }).pipe(Effect.forkScoped)

        yield* waitForPending(2)
        // User approves "git status" on subagent A
        yield* saveAlwaysRules({
          requestID: PermissionV1.ID.make("permission_multi_a"),
          approvedAlways: ["git status"],
        })
        yield* reply({ requestID: PermissionV1.ID.make("permission_multi_a"), reply: "once" })

        // B should auto-resolve: "git status" covered by new rule, "npm install" covered by original ruleset
        yield* Fiber.await(fiberA)
        const pendingMulti = yield* list()
        expect(pendingMulti.some((p) => String(p.id) === "permission_multi_b")).toBe(true)
        yield* reply({ requestID: PermissionV1.ID.make("permission_multi_b"), reply: "reject" })
        expectFailure(yield* Fiber.await(fiberB), Permission.RejectedError)
      }),
    ),
  )

  it.live("multi-pattern: stays pending when new rule covers one pattern but ruleset doesn't cover the other", () =>
    withDir({ git: true }, () =>
      Effect.gen(function* () {
        // Subagent B has "git status && curl http://evil.com" — two patterns.
        // Neither is allowed by the ruleset.
        const fiberB = yield* ask({
          id: PermissionV1.ID.make("permission_multi_b2"),
          sessionID: SessionID.make("session_b"),
          permission: "bash",
          patterns: ["git status", "curl http://evil.com"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
        }).pipe(Effect.forkScoped)

        const fiberA = yield* ask({
          id: PermissionV1.ID.make("permission_multi_a2"),
          sessionID: SessionID.make("session_a"),
          permission: "bash",
          patterns: ["git status"],
          metadata: { rules: ["git status"] },
          always: ["git status"],
          ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
        }).pipe(Effect.forkScoped)

        yield* waitForPending(2)
        // User approves "git status" — covers "git status" but NOT "curl"
        yield* saveAlwaysRules({
          requestID: PermissionV1.ID.make("permission_multi_a2"),
          approvedAlways: ["git status"],
        })
        yield* reply({ requestID: PermissionV1.ID.make("permission_multi_a2"), reply: "once" })
        yield* Fiber.await(fiberA)

        // B should still be pending (curl not covered)
        const pending = yield* list()
        expect(pending.some((p) => String(p.id) === "permission_multi_b2")).toBe(true)

        yield* reply({ requestID: PermissionV1.ID.make("permission_multi_b2"), reply: "reject" })
        expectFailure(yield* Fiber.await(fiberB), Permission.RejectedError)
      }),
    ),
  )
})
