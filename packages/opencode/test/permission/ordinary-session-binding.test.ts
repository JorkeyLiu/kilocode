import { test, expect, describe } from "bun:test"
import { Effect, Layer, Exit, Fiber } from "effect"
import { Permission } from "../../src/permission"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionID } from "../../src/session/schema"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { Config } from "../../src/config/config"
import { InstanceStore } from "../../src/project/instance-store"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"
import { __testCreateTrustedAgentContext } from "../../src/kilocode/session/trusted-gate"

const events = EventV2Bridge.defaultLayer
const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const env = Layer.mergeAll(
  Permission.layer.pipe(Layer.provide(Database.defaultLayer), Layer.provide(events)),
  events,
  CrossSpawnSpawner.defaultLayer,
  InstanceStore.defaultLayer.pipe(Layer.provide(noopBootstrap)),
).pipe(Layer.provide(Config.defaultLayer))
const it = testEffect(env)

const waitForPending = (count: number) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    for (let i = 0; i < 100; i++) {
      const list = yield* permission.list()
      if (list.length === count) return list
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.fail(new Error(`timed out waiting for ${count} pending`))
  })

describe("ordinary always session binding", () => {
  it.instance("reply always: same session allows, other session asks", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const sess = SessionID.make("sess_bind_reply")
      const fiber = yield* perm.ask({
        id: PermissionV1.ID.make("per_bind_reply"),
        sessionID: sess,
        permission: "bash",
        patterns: ["echo bind"],
        metadata: {},
        always: ["echo bind"],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_bind_reply"), reply: "always" })
      yield* Fiber.join(fiber)
      const ok = yield* perm.ask({ sessionID: sess, permission: "bash", patterns: ["echo bind"], metadata: {}, always: [], ruleset: [] })
      expect(ok).toBeUndefined()
      const other = yield* perm.ask({
        id: PermissionV1.ID.make("per_bind_reply_other"),
        sessionID: SessionID.make("sess_bind_reply_other"),
        permission: "bash",
        patterns: ["echo bind"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_bind_reply_other"), reply: "reject" })
      const exit = yield* Fiber.await(other)
      expect(Exit.isFailure(exit)).toBe(true)
    }), { git: true })

  it.instance("saveAlwaysRules: same session drains, other session stays pending", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const sess = SessionID.make("sess_bind_save")
      const orig = yield* perm.ask({
        id: PermissionV1.ID.make("per_bind_save"),
        sessionID: sess,
        permission: "bash",
        patterns: ["echo save"],
        metadata: {},
        always: ["echo save"],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      const same = yield* perm.ask({
        id: PermissionV1.ID.make("per_bind_save_same"),
        sessionID: sess,
        permission: "bash",
        patterns: ["echo save"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      const other = yield* perm.ask({
        id: PermissionV1.ID.make("per_bind_save_other"),
        sessionID: SessionID.make("sess_bind_save_other"),
        permission: "bash",
        patterns: ["echo save"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      yield* waitForPending(3)
      yield* perm.saveAlwaysRules({ requestID: PermissionV1.ID.make("per_bind_save"), approvedAlways: ["echo save"] })
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_bind_save"), reply: "once" })
      yield* Fiber.join(orig)
      yield* Fiber.join(same)
      const remaining = yield* perm.list()
      expect(remaining.some((r) => String(r.id) === "per_bind_save_other")).toBe(true)
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_bind_save_other"), reply: "reject" })
      const exit = yield* Fiber.await(other)
      expect(Exit.isFailure(exit)).toBe(true)
    }), { git: true })

  it.instance("agent mismatch does not inherit grant", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const sess = SessionID.make("sess_bind_agent")
      const fiber = yield* perm.ask({
        id: PermissionV1.ID.make("per_bind_agent"),
        sessionID: sess,
        permission: "bash",
        patterns: ["echo agent"],
        metadata: {},
        always: ["echo agent"],
        ruleset: [],
        trustedContext: __testCreateTrustedAgentContext("agent-a"),
      } as any).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_bind_agent"), reply: "always" })
      yield* Fiber.join(fiber)
      const ok = yield* perm.ask({
        sessionID: sess,
        permission: "bash",
        patterns: ["echo agent"],
        metadata: {},
        always: [],
        ruleset: [],
        trustedContext: __testCreateTrustedAgentContext("agent-a"),
      } as any)
      expect(ok).toBeUndefined()
      const otherAgent = yield* perm.ask({
        id: PermissionV1.ID.make("per_bind_agent_other"),
        sessionID: sess,
        permission: "bash",
        patterns: ["echo agent"],
        metadata: {},
        always: [],
        ruleset: [],
        trustedContext: __testCreateTrustedAgentContext("agent-b"),
      } as any).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_bind_agent_other"), reply: "reject" })
      const exit = yield* Fiber.await(otherAgent)
      expect(Exit.isFailure(exit)).toBe(true)
    }), { git: true })

  it.instance("glob mismatch does not inherit grant", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const sess = SessionID.make("sess_bind_glob")
      const fiber = yield* perm.ask({
        id: PermissionV1.ID.make("per_bind_glob"),
        sessionID: sess,
        permission: "bash",
        patterns: ["echo one"],
        metadata: {},
        always: ["echo one"],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_bind_glob"), reply: "always" })
      yield* Fiber.join(fiber)
      const other = yield* perm.ask({
        id: PermissionV1.ID.make("per_bind_glob_other"),
        sessionID: sess,
        permission: "bash",
        patterns: ["echo two"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_bind_glob_other"), reply: "reject" })
      const exit = yield* Fiber.await(other)
      expect(Exit.isFailure(exit)).toBe(true)
    }), { git: true })

  it.instance("child session with deny layer still denies despite parent grant", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const parent = SessionID.make("sess_bind_parent")
      const fiber = yield* perm.ask({
        id: PermissionV1.ID.make("per_bind_parent"),
        sessionID: parent,
        permission: "bash",
        patterns: ["echo child"],
        metadata: {},
        always: ["echo child"],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_bind_parent"), reply: "always" })
      yield* Fiber.join(fiber)
      // Child carries an explicit deny layer — deny ceiling beats the parent session grant
      const childExit = yield* perm.ask({
        sessionID: SessionID.make("sess_bind_child"),
        permission: "bash",
        patterns: ["echo child"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "echo child", action: "deny" }],
      }).pipe(Effect.exit)
      expect(Exit.isFailure(childExit)).toBe(true)
    }), { git: true })

  it.instance("session grant does not persist after runtime dispose", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const test = yield* TestInstance
      const store = yield* InstanceStore.Service
      const sess = SessionID.make("sess_bind_dispose")
      const fiber = yield* perm.ask({
        id: PermissionV1.ID.make("per_bind_dispose"),
        sessionID: sess,
        permission: "bash",
        patterns: ["echo dispose"],
        metadata: {},
        always: ["echo dispose"],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_bind_dispose"), reply: "always" })
      yield* Fiber.join(fiber)
      const ctx = yield* store.load({ directory: test.directory })
      yield* store.dispose(ctx)
      const after = yield* perm.ask({
        id: PermissionV1.ID.make("per_bind_dispose_after"),
        sessionID: sess,
        permission: "bash",
        patterns: ["echo dispose"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_bind_dispose_after"), reply: "reject" })
      const exit = yield* Fiber.await(after)
      expect(Exit.isFailure(exit)).toBe(true)
    }), { git: true })
})
