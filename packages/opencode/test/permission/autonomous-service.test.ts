import { describe, expect } from "bun:test"
import { Effect, Exit, Fiber, Layer } from "effect"
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
import path from "path"
import fs from "fs/promises"
import os from "os"

const events = EventV2Bridge.defaultLayer
const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const env = Layer.mergeAll(
  Permission.layer.pipe(Layer.provide(Database.defaultLayer), Layer.provide(events)),
  events,
  CrossSpawnSpawner.defaultLayer,
  InstanceStore.defaultLayer.pipe(Layer.provide(noopBootstrap)),
).pipe(Layer.provide(Config.defaultLayer))
const it = testEffect(env)

const isolatedGlobal = Effect.gen(function* () {
  const prev = Global.Path.config
  const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "r18-auto-svc-")))
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

const captureAsked = Effect.gen(function* () {
  const bridge = yield* EventV2Bridge.Service
  const seen: string[] = []
  const off = yield* bridge.listen((evt) => {
    if (evt.type === Permission.Event.Asked.type) {
      const data = evt.data as { id?: unknown }
      seen.push(String(data.id ?? ""))
    }
    return Effect.void
  })
  yield* Effect.addFinalizer(() => off)
  return seen
})

const writeGlobal = (dir: string, raw: unknown) =>
  Effect.promise(() => fs.writeFile(path.join(dir, "kilo.jsonc"), JSON.stringify(raw, null, 2)))

const projFile = (dir: string) => path.join(dir, ".kilo", "kilo.jsonc")

describe("autonomous service - binding semantics ask preserved", () => {
  it.instance("autonomous agent ask queues with one pending and one permission.asked", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const global = yield* isolatedGlobal
      yield* writeGlobal(global, { permission_level: "autonomous", permission: { bash: { "*": "ask" } } })
      const seen = yield* captureAsked
      const fiber = yield* perm
        .ask({
          id: PermissionV1.ID.make("per_auto_svc_bash"),
          sessionID: SessionID.make("sess_auto_svc"),
          permission: "bash",
          patterns: ["npm test"],
          metadata: {},
          always: [],
          ruleset: [],
        })
        .pipe(Effect.forkScoped)
      yield* waitForPending(1)
      const asked = yield* pollWithTimeout(
        Effect.succeed(seen.length === 1 ? seen : undefined),
        "timed out waiting for permission.asked",
        "5 seconds",
      )
      expect(asked.length).toBe(1)
      const prov = yield* perm.provenance("per_auto_svc_bash")
      expect(prov?.decisive.result).toBe("ask")
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_auto_svc_bash"), reply: "reject" })
      const exit = yield* Fiber.join(fiber).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("autonomous global ask and doom_loop queue like review", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const global = yield* isolatedGlobal
      yield* writeGlobal(global, {
        permission_level: "autonomous",
        permission: { edit: "ask", doom_loop: "ask" },
      })
      const fiberEdit = yield* perm
        .ask({
          id: PermissionV1.ID.make("per_auto_svc_edit"),
          sessionID: SessionID.make("sess_auto_svc_edit"),
          permission: "edit",
          patterns: ["a.ts"],
          metadata: {},
          always: [],
          ruleset: [],
        })
        .pipe(Effect.forkScoped)
      yield* waitForPending(1)
      expect((yield* perm.provenance("per_auto_svc_edit"))?.decisive.result).toBe("ask")
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_auto_svc_edit"), reply: "reject" })
      yield* Fiber.await(fiberEdit).pipe(Effect.catchCause(() => Effect.void))

      const fiberDoom = yield* perm
        .ask({
          id: PermissionV1.ID.make("per_auto_svc_doom"),
          sessionID: SessionID.make("sess_auto_svc_doom"),
          permission: "doom_loop",
          patterns: ["bash"],
          metadata: {},
          always: [],
          ruleset: [],
        })
        .pipe(Effect.forkScoped)
      yield* waitForPending(1)
      expect((yield* perm.provenance("per_auto_svc_doom"))?.decisive.result).toBe("ask")
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_auto_svc_doom"), reply: "reject" })
      yield* Fiber.await(fiberDoom).pipe(Effect.catchCause(() => Effect.void))
    }),
  )

  it.instance("autonomous protected ceiling-b and .env ceiling-c queue as ask-ceiling", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const global = yield* isolatedGlobal
      yield* writeGlobal(global, { permission_level: "autonomous", permission: { "*": "allow" } })
      const fiberProtected = yield* perm
        .ask({
          id: PermissionV1.ID.make("per_auto_svc_protected"),
          sessionID: SessionID.make("sess_auto_svc_protected"),
          permission: "edit",
          patterns: ["kilo.jsonc"],
          metadata: {},
          always: [],
          ruleset: [],
        })
        .pipe(Effect.forkScoped)
      yield* waitForPending(1)
      const provProtected = yield* perm.provenance("per_auto_svc_protected")
      expect(provProtected?.decisive.result).toBe("ask-ceiling")
      expect(provProtected?.decisive.ceilingId).toBe("(b)")
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_auto_svc_protected"), reply: "reject" })
      yield* Fiber.await(fiberProtected).pipe(Effect.catchCause(() => Effect.void))

      const fiberEnv = yield* perm
        .ask({
          id: PermissionV1.ID.make("per_auto_svc_env"),
          sessionID: SessionID.make("sess_auto_svc_env"),
          permission: "read",
          patterns: [".env"],
          metadata: {},
          always: [],
          ruleset: [],
        })
        .pipe(Effect.forkScoped)
      yield* waitForPending(1)
      const provEnv = yield* perm.provenance("per_auto_svc_env")
      expect(provEnv?.decisive.result).toBe("ask-ceiling")
      expect(provEnv?.decisive.ceilingId).toBe("(c)")
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_auto_svc_env"), reply: "reject" })
      yield* Fiber.await(fiberEnv).pipe(Effect.catchCause(() => Effect.void))
    }),
  )

  it.instance("review still queues the same ask and publishes exactly one permission.asked", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const global = yield* isolatedGlobal
      yield* writeGlobal(global, { permission: { bash: { "*": "ask" } } })
      const seen = yield* captureAsked
      const fiber = yield* perm
        .ask({
          id: PermissionV1.ID.make("per_review_svc_bash"),
          sessionID: SessionID.make("sess_review_svc"),
          permission: "bash",
          patterns: ["npm test"],
          metadata: {},
          always: [],
          ruleset: [],
        })
        .pipe(Effect.forkScoped)
      yield* waitForPending(1)
      const asked = yield* pollWithTimeout(
        Effect.succeed(seen.length === 1 ? seen : undefined),
        "timed out waiting for permission.asked",
        "5 seconds",
      )
      expect(asked.length).toBe(1)
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_review_svc_bash"), reply: "reject" })
      const exit = yield* Fiber.join(fiber).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("autonomous keeps explicit deny and child inherited deny", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const global = yield* isolatedGlobal
      yield* writeGlobal(global, { permission_level: "autonomous", permission: { edit: "deny" } })
      const denyExit = yield* perm
        .ask({
          id: PermissionV1.ID.make("per_auto_svc_deny"),
          sessionID: SessionID.make("sess_auto_svc_deny"),
          permission: "edit",
          patterns: ["a.ts"],
          metadata: {},
          always: [],
          ruleset: [],
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(denyExit)).toBe(true)

      const childExit = yield* perm
        .ask({
          id: PermissionV1.ID.make("per_auto_svc_child"),
          sessionID: SessionID.make("sess_auto_svc_child"),
          permission: "bash",
          patterns: ["npm test"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "npm test", action: "deny" }],
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(childExit)).toBe(true)
    }),
  )
})

describe("autonomous binding semantics via production Permission.ask", () => {
  it.instance(
    "global autonomous all-allow with project ask still queues",
    () =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        const t = yield* TestInstance
        const global = yield* isolatedGlobal
        yield* writeGlobal(global, { permission_level: "autonomous", permission: { "*": "allow" } })
        yield* Effect.promise(() => fs.mkdir(path.join(t.directory, ".kilo"), { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(projFile(t.directory), JSON.stringify({ permission: { bash: { "*": "ask" } } }, null, 2)))
        const fiber = yield* perm
          .ask({
            id: PermissionV1.ID.make("per_auto_prod_proj_ask"),
            sessionID: SessionID.make("sess_auto_prod_proj_ask"),
            permission: "bash",
            patterns: ["ls"],
            metadata: {},
            always: [],
            ruleset: [],
          })
          .pipe(Effect.forkScoped)
        yield* waitForPending(1)
        const prov = yield* perm.provenance("per_auto_prod_proj_ask")
        expect(prov?.decisive.result).toBe("ask")
        expect(prov?.contributingLayers.some((l) => l.sourceKind === "project-file" && l.decision === "ask")).toBe(true)
        expect(prov?.contributingLayers.some((l) => l.sourceKind === "global-file" && l.decision === "allow")).toBe(true)
        yield* perm.reply({ requestID: PermissionV1.ID.make("per_auto_prod_proj_ask"), reply: "reject" })
        yield* Fiber.await(fiber).pipe(Effect.catchCause(() => Effect.void))
      }),
    { git: true },
  )

  it.instance(
    "global autonomous all-allow with protected .kilo path still ask-ceiling",
    () =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        const t = yield* TestInstance
        const global = yield* isolatedGlobal
        yield* writeGlobal(global, { permission_level: "autonomous", permission: { "*": "allow" } })
        yield* Effect.promise(() => fs.mkdir(path.join(t.directory, ".kilo"), { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(projFile(t.directory), JSON.stringify({ permission: { edit: { "*": "allow" } } }, null, 2)))
        const fiber = yield* perm
          .ask({
            id: PermissionV1.ID.make("per_auto_prod_kilo_path"),
            sessionID: SessionID.make("sess_auto_prod_kilo_path"),
            permission: "edit",
            patterns: ["kilo.json"],
            metadata: {},
            always: [],
            ruleset: [],
          })
          .pipe(Effect.forkScoped)
        yield* waitForPending(1)
        const prov = yield* perm.provenance("per_auto_prod_kilo_path")
        expect(prov?.decisive.result).toBe("ask-ceiling")
        expect(prov?.decisive.ceilingId).toBe("(b)")
        yield* perm.reply({ requestID: PermissionV1.ID.make("per_auto_prod_kilo_path"), reply: "reject" })
        yield* Fiber.await(fiber).pipe(Effect.catchCause(() => Effect.void))
      }),
    { git: true },
  )

  it.instance(
    "global autonomous all-allow with .env read still ask-ceiling",
    () =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        const t = yield* TestInstance
        const global = yield* isolatedGlobal
        yield* writeGlobal(global, { permission_level: "autonomous", permission: { "*": "allow" } })
        yield* Effect.promise(() => fs.mkdir(path.join(t.directory, ".kilo"), { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(projFile(t.directory), JSON.stringify({ permission: { read: { "*": "allow" } } }, null, 2)))
        const fiber = yield* perm
          .ask({
            id: PermissionV1.ID.make("per_auto_prod_env"),
            sessionID: SessionID.make("sess_auto_prod_env"),
            permission: "read",
            patterns: ["secret.env"],
            metadata: {},
            always: [],
            ruleset: [],
          })
          .pipe(Effect.forkScoped)
        yield* waitForPending(1)
        const prov = yield* perm.provenance("per_auto_prod_env")
        expect(prov?.decisive.result).toBe("ask-ceiling")
        expect(prov?.decisive.ceilingId).toBe("(c)")
        yield* perm.reply({ requestID: PermissionV1.ID.make("per_auto_prod_env"), reply: "reject" })
        yield* Fiber.await(fiber).pipe(Effect.catchCause(() => Effect.void))
      }),
    { git: true },
  )

  it.instance(
    "autonomous default no-rule queues as ask",
    () =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        const t = yield* TestInstance
        yield* isolatedGlobal
        yield* Effect.promise(() => fs.rm(projFile(t.directory), { force: true }).catch(() => undefined))
        yield* Effect.promise(() => fs.rm(path.join(t.directory, ".kilo"), { recursive: true, force: true }).catch(() => undefined))
        const fiber = yield* perm
          .ask({
            id: PermissionV1.ID.make("per_auto_prod_default"),
            sessionID: SessionID.make("sess_auto_prod_default"),
            permission: "bash",
            patterns: ["echo default no-rule"],
            metadata: {},
            always: [],
            ruleset: [],
          })
          .pipe(Effect.forkScoped)
        yield* waitForPending(1)
        const prov = yield* perm.provenance("per_auto_prod_default")
        expect(prov?.decisive.result).toBe("ask")
        expect(prov?.decisive.reason).toBe("default-ask")
        yield* perm.reply({ requestID: PermissionV1.ID.make("per_auto_prod_default"), reply: "reject" })
        yield* Fiber.await(fiber).pipe(Effect.catchCause(() => Effect.void))
      }),
    { git: true },
  )

  it.instance(
    "global autonomous all-allow unconstrained stays allow with zero pending",
    () =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        const t = yield* TestInstance
        const global = yield* isolatedGlobal
        yield* writeGlobal(global, { permission_level: "autonomous", permission: { "*": "allow" } })
        yield* Effect.promise(() => fs.rm(projFile(t.directory), { force: true }).catch(() => undefined))
        yield* Effect.promise(() => fs.rm(path.join(t.directory, ".kilo"), { recursive: true, force: true }).catch(() => undefined))
        const seen = yield* captureAsked
        const exit = yield* perm
          .ask({
            id: PermissionV1.ID.make("per_auto_prod_all_allow"),
            sessionID: SessionID.make("sess_auto_prod_all_allow"),
            permission: "bash",
            patterns: ["ls"],
            metadata: {},
            always: [],
            ruleset: [],
          })
          .pipe(Effect.exit)
        expect(Exit.isSuccess(exit)).toBe(true)
        expect(seen.length).toBe(0)
        expect((yield* perm.list()).length).toBe(0)
        const prov = yield* perm.provenance("per_auto_prod_all_allow")
        expect(prov?.decisive.result).toBe("allow")
        expect(prov?.decisive.reason).toBe("all-allow")
      }),
    { git: true },
  )

  it.instance(
    "global autonomous with project deny stays deny",
    () =>
      Effect.gen(function* () {
        const perm = yield* Permission.Service
        const t = yield* TestInstance
        const global = yield* isolatedGlobal
        yield* writeGlobal(global, { permission_level: "autonomous", permission: { "*": "allow" } })
        yield* Effect.promise(() => fs.mkdir(path.join(t.directory, ".kilo"), { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(projFile(t.directory), JSON.stringify({ permission: { bash: { "*": "deny" } } }, null, 2)))
        const exit = yield* perm
          .ask({
            id: PermissionV1.ID.make("per_auto_prod_deny"),
            sessionID: SessionID.make("sess_auto_prod_deny"),
            permission: "bash",
            patterns: ["ls"],
            metadata: {},
            always: [],
            ruleset: [],
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        const prov = yield* perm.provenance("per_auto_prod_deny")
        expect(prov?.decisive.result).toBe("deny")
        expect(prov?.decisive.reason).toContain("deny")
      }),
    { git: true },
  )
})
