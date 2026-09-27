import { test, expect, describe } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { Permission } from "../../src/permission"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionID } from "../../src/session/schema"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { Config } from "../../src/config/config"
import { InstanceStore } from "../../src/project/instance-store"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect, pollWithTimeout } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"
import { Global } from "@opencode-ai/core/global"
import os from "os"
import { createTestTrustedAgentContext as createTrusted } from "../helpers/trusted-helpers"
import path from "path"
import fs from "fs/promises"

type AskWithTrusted = Permission.AskInput & { trustedContext: ReturnType<typeof createTrusted> }

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
  pollWithTimeout(
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const list = yield* perm.list()
      return list.length === count ? list : undefined
    }),
    `timed out waiting for ${count} pending`,
    "5 seconds",
  )

const isolatedGlobal = Effect.gen(function* () {
  const prev = Global.Path.config
  const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "qsep-global-")))
  const dir = yield* Effect.promise(() => fs.realpath(tmp))
  Global.Path.config = dir
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      Global.Path.config = prev
      yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
    }),
  )
  return dir
})

const freeform = (id: string, session: string, agent = "code") =>
  ({
    id: PermissionV1.ID.make(id),
    sessionID: SessionID.make(session),
    permission: "question",
    patterns: ["free-form"],
    metadata: {},
    always: ["free-form"],
    ruleset: [],
    trustedContext: createTrusted(agent),
  }) as unknown as AskWithTrusted

const toolAsk = (id: string, session: string, agent = "code") =>
  ({
    id: PermissionV1.ID.make(id),
    sessionID: SessionID.make(session),
    permission: "question_tool",
    patterns: ["ask-user"],
    metadata: {},
    always: ["ask-user"],
    ruleset: [],
    trustedContext: createTrusted(agent),
  }) as unknown as AskWithTrusted

describe("question identity separation - free-form vs tool", () => {
  it.instance("allow freeform deny tool", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const global = yield* isolatedGlobal
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(global, "kilo.jsonc"),
          JSON.stringify({ permission: { question: "allow", question_tool: "deny" } }, null, 2),
        ),
      )

      const free = yield* perm.ask(freeform("per_qsep_free_allow", "sess_qsep_free_allow")).pipe(Effect.exit)
      expect(Exit.isSuccess(free)).toBe(true)

      const gated = yield* perm.ask(toolAsk("per_qsep_tool_deny", "sess_qsep_tool_deny")).pipe(Effect.exit)
      expect(Exit.isFailure(gated)).toBe(true)
      if (Exit.isFailure(gated)) expect(Cause.squash(gated.cause)).toBeInstanceOf(Permission.DeniedError)
      expect((yield* perm.provenance("per_qsep_tool_deny"))?.request.permission).toBe("question_tool")
      expect((yield* perm.provenance("per_qsep_free_allow"))?.request.permission).toBe("question")
    }),
    { git: true },
  )

  it.instance("deny freeform allow tool", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const global = yield* isolatedGlobal
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(global, "kilo.jsonc"),
          JSON.stringify({ permission: { question: "deny", question_tool: "allow" } }, null, 2),
        ),
      )

      const free = yield* perm.ask(freeform("per_qsep_free_deny", "sess_qsep_free_deny")).pipe(Effect.exit)
      expect(Exit.isFailure(free)).toBe(true)
      if (Exit.isFailure(free)) expect(Cause.squash(free.cause)).toBeInstanceOf(Permission.DeniedError)

      const gated = yield* perm.ask(toolAsk("per_qsep_tool_allow", "sess_qsep_tool_allow")).pipe(Effect.exit)
      expect(Exit.isSuccess(gated)).toBe(true)
      expect((yield* perm.provenance("per_qsep_tool_allow"))?.request.permission).toBe("question_tool")
    }),
    { git: true },
  )
})

describe("question_tool once approval binds exact session agent permission pattern", () => {
  it.instance("default ask tool once approval is consumed and never crosses identity", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const t = yield* TestInstance
      yield* isolatedGlobal
      yield* Effect.promise(() =>
        fs.rm(path.join(t.directory, ".kilo"), { recursive: true, force: true }).catch(() => undefined),
      )
      const sess = "sess_qsep_once"

      const fiber = yield* perm.ask(toolAsk("per_qsep_once_first", sess)).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      expect((yield* perm.provenance("per_qsep_once_first"))?.decisive.result).toBe("ask")
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_qsep_once_first"), reply: "once" })
      yield* Fiber.join(fiber)
      expect((yield* perm.provenance("per_qsep_once_first"))?.approval?.kind).toBe("once")

      const same = yield* perm.ask(toolAsk("per_qsep_once_same", sess)).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      expect((yield* perm.provenance("per_qsep_once_same"))?.decisive.result).toBe("ask")
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_qsep_once_same"), reply: "reject" })
      yield* Fiber.await(same).pipe(Effect.catchCause(() => Effect.void))

      const otherSession = yield* perm.ask(toolAsk("per_qsep_once_session", "sess_qsep_once_other")).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      expect((yield* perm.provenance("per_qsep_once_session"))?.decisive.result).toBe("ask")
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_qsep_once_session"), reply: "reject" })
      yield* Fiber.await(otherSession).pipe(Effect.catchCause(() => Effect.void))

      const otherAgent = yield* perm.ask(toolAsk("per_qsep_once_agent", sess, "plan")).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      expect((yield* perm.provenance("per_qsep_once_agent"))?.decisive.result).toBe("ask")
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_qsep_once_agent"), reply: "reject" })
      yield* Fiber.await(otherAgent).pipe(Effect.catchCause(() => Effect.void))

      const otherPermission = yield* perm.ask(freeform("per_qsep_once_perm", sess)).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      expect((yield* perm.provenance("per_qsep_once_perm"))?.decisive.result).toBe("ask")
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_qsep_once_perm"), reply: "reject" })
      yield* Fiber.await(otherPermission).pipe(Effect.catchCause(() => Effect.void))

      const otherPattern = yield* perm
        .ask({
          ...toolAsk("per_qsep_once_pattern", sess),
          patterns: ["ask-user-extra"],
          always: ["ask-user-extra"],
        } as unknown as AskWithTrusted)
        .pipe(Effect.forkScoped)
      yield* waitForPending(1)
      expect((yield* perm.provenance("per_qsep_once_pattern"))?.decisive.result).toBe("ask")
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_qsep_once_pattern"), reply: "reject" })
      yield* Fiber.await(otherPattern).pipe(Effect.catchCause(() => Effect.void))
    }),
    { git: true },
  )
})

describe("question gate abort and identity hardening", () => {
  it.instance("freeform once approval never satisfies tool identity", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const global = yield* isolatedGlobal
      yield* Effect.promise(() =>
        fs.writeFile(path.join(global, "kilo.jsonc"), JSON.stringify({ permission: {} }, null, 2)),
      )
      const sess = "sess_qsep_rev"

      const free = yield* perm.ask(freeform("per_qsep_rev_free", sess)).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      expect((yield* perm.provenance("per_qsep_rev_free"))?.decisive.result).toBe("ask")
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_qsep_rev_free"), reply: "once" })
      yield* Fiber.join(free)

      const gated = yield* perm.ask(toolAsk("per_qsep_rev_tool", sess)).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      expect((yield* perm.provenance("per_qsep_rev_tool"))?.decisive.result).toBe("ask")
      expect((yield* perm.provenance("per_qsep_rev_tool"))?.request.permission).toBe("question_tool")
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_qsep_rev_tool"), reply: "reject" })
      yield* Fiber.await(gated).pipe(Effect.catchCause(() => Effect.void))
      expect(yield* perm.list()).toEqual([])
    }),
    { git: true },
  )

  it.instance("aborted permission ask clears pending list", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      yield* isolatedGlobal
      const fiber = yield* perm.ask(freeform("per_qsep_abort", "sess_qsep_abort")).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* Fiber.interrupt(fiber)
      expect(yield* perm.list()).toEqual([])
    }),
    { git: true },
  )

  it.instance("missing identity cannot impersonate plan allow", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      yield* isolatedGlobal
      const any = perm as any
      const guard = [
        { permission: "*", pattern: "*", action: "deny" as const },
        { permission: "question", pattern: "*", action: "allow" as const },
      ]
      yield* (any.__testSetAgentRules("plan", guard) as Effect.Effect<void>)
      yield* Effect.addFinalizer(() => any.__testSetAgentRules("plan", []) as Effect.Effect<void>)

      const trusted = yield* perm
        .ask({
          id: PermissionV1.ID.make("per_qsep_ident_plan"),
          sessionID: SessionID.make("sess_qsep_ident"),
          permission: "question",
          patterns: ["free-form"],
          metadata: {},
          always: ["free-form"],
          ruleset: [],
          trustedContext: createTrusted("plan"),
        } as unknown as AskWithTrusted)
        .pipe(Effect.exit)
      expect(Exit.isSuccess(trusted)).toBe(true)

      const fiber = yield* perm
        .ask({
          id: PermissionV1.ID.make("per_qsep_ident_spoof"),
          sessionID: SessionID.make("sess_qsep_ident"),
          permission: "question",
          patterns: ["free-form"],
          metadata: { protectedAgent: "plan" },
          trustedAgent: "plan",
          always: ["free-form"],
          ruleset: [],
        } as any)
        .pipe(Effect.forkScoped)
      yield* waitForPending(1)
      expect((yield* perm.provenance("per_qsep_ident_spoof"))?.decisive.result).toBe("ask")
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_qsep_ident_spoof"), reply: "reject" })
      yield* Fiber.await(fiber).pipe(Effect.catchCause(() => Effect.void))
      expect(yield* perm.list()).toEqual([])
    }),
    { git: true },
  )
})
