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

describe("autonomous service - no queue, no event", () => {
  it.instance("autonomous agent ask resolves inline with zero pending and zero permission.asked events", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const global = yield* isolatedGlobal
      yield* writeGlobal(global, { permission_level: "autonomous", permission: { bash: { "*": "ask" } } })
      const seen = yield* captureAsked
      // Resolves inline: ask() returns via the allow branch before
      // pending.set/events.publish, so no Asked event can exist for it.
      yield* perm.ask({
        id: PermissionV1.ID.make("per_auto_svc_bash"),
        sessionID: SessionID.make("sess_auto_svc"),
        permission: "bash",
        patterns: ["npm test"],
        metadata: {},
        always: [],
        ruleset: [],
      })
      expect(seen.length).toBe(0)
      expect((yield* perm.list()).length).toBe(0)
      const prov = yield* perm.provenance("per_auto_svc_bash")
      expect(prov?.decisive.result).toBe("allow")
      expect(prov?.decisive.reason).toBe("autonomous")
    }),
  )

  it.instance("autonomous global ask and doom_loop resolve inline with zero events", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const global = yield* isolatedGlobal
      yield* writeGlobal(global, {
        permission_level: "autonomous",
        permission: { edit: "ask", doom_loop: "ask" },
      })
      const seen = yield* captureAsked
      yield* perm.ask({
        id: PermissionV1.ID.make("per_auto_svc_edit"),
        sessionID: SessionID.make("sess_auto_svc_edit"),
        permission: "edit",
        patterns: ["a.ts"],
        metadata: {},
        always: [],
        ruleset: [],
      })
      yield* perm.ask({
        id: PermissionV1.ID.make("per_auto_svc_doom"),
        sessionID: SessionID.make("sess_auto_svc_doom"),
        permission: "doom_loop",
        patterns: ["bash"],
        metadata: {},
        always: [],
        ruleset: [],
      })
      expect(seen.length).toBe(0)
      expect((yield* perm.list()).length).toBe(0)
      expect((yield* perm.provenance("per_auto_svc_edit"))?.decisive.reason).toBe("autonomous")
      expect((yield* perm.provenance("per_auto_svc_doom"))?.decisive.reason).toBe("autonomous")
    }),
  )

  it.instance("autonomous protected ceiling-b and .env ceiling-c resolve inline with zero events", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const global = yield* isolatedGlobal
      yield* writeGlobal(global, { permission_level: "autonomous", permission: { "*": "allow" } })
      const seen = yield* captureAsked
      yield* perm.ask({
        id: PermissionV1.ID.make("per_auto_svc_protected"),
        sessionID: SessionID.make("sess_auto_svc_protected"),
        permission: "edit",
        patterns: ["kilo.jsonc"],
        metadata: {},
        always: [],
        ruleset: [],
      })
      yield* perm.ask({
        id: PermissionV1.ID.make("per_auto_svc_env"),
        sessionID: SessionID.make("sess_auto_svc_env"),
        permission: "read",
        patterns: [".env"],
        metadata: {},
        always: [],
        ruleset: [],
      })
      expect(seen.length).toBe(0)
      expect((yield* perm.list()).length).toBe(0)
      expect((yield* perm.provenance("per_auto_svc_protected"))?.decisive.reason).toBe("autonomous-ceiling")
      expect((yield* perm.provenance("per_auto_svc_env"))?.decisive.reason).toBe("autonomous-ceiling")
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
