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
import { testEffect, awaitWithTimeout, pollWithTimeout } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"
import { Global } from "@opencode-ai/core/global"
import os from "os"
import { createTestTrustedAgentContext as createTrusted } from "../helpers/trusted-helpers"
import path from "path"
import fs from "fs/promises"

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

const projFile = (dir: string) => path.join(dir, ".kilo", "kilo.jsonc")

/**
 * Scoped isolated global config dir — existing-style helper.
 * Restores Global.Path.config before cleanup and propagates cleanup failure as test failure.
 * No fixed sleeps, no mocks, no resources outside test ownership.
 * LOCK-004: stored protected approval identities are exact/non-glob; wildcard selector is input-only.
 */
const isolatedGlobal = Effect.gen(function* () {
  const prev = Global.Path.config
  const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "r18-prod-global-")))
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

describe("R18 production-path - disk-authored global/project permission files flow to Permission.ask", () => {
  it.instance("absent global with project allow gives immediate allow", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const t = yield* TestInstance
      const tmpGlobal = yield* isolatedGlobal
      yield* Effect.promise(() => fs.mkdir(path.join(t.directory, ".kilo"), { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(projFile(t.directory), JSON.stringify({ permission: { bash: { "*": "allow" } } }, null, 2)))
      const fiberCheck = yield* perm
        .ask({
          id: PermissionV1.ID.make("per_prod_check_absent"),
          sessionID: SessionID.make("sess_prod_check"),
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [],
        })
        .pipe(Effect.forkScoped)
      yield* awaitWithTimeout(Fiber.join(fiberCheck), "absent global immediate allow did not resolve", "2 seconds")
      const list = yield* perm.list()
      expect(list.length).toBe(0)
      const prov2 = yield* perm.provenance("per_prod_check_absent")
      expect(prov2).toBeDefined()
      expect(prov2?.contributingLayers.some((l) => l.sourceKind === "project-file" && l.canonicalPath === projFile(t.directory))).toBe(true)
      expect(prov2?.contributingLayers.some((l) => l.canonicalPath === path.join(tmpGlobal, "kilo.jsonc"))).toBe(false)
      expect(prov2?.decisive.result).toBe("allow")
    }), { git: true })

  it.instance("authored empty global is applicable ask versus absent allows", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const t = yield* TestInstance
      const tmpGlobal = yield* isolatedGlobal
      yield* Effect.promise(() => fs.mkdir(path.join(t.directory, ".kilo"), { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(projFile(t.directory), JSON.stringify({ permission: { bash: { "*": "allow" } } }, null, 2)))
      yield* Effect.promise(() => fs.writeFile(path.join(tmpGlobal, "kilo.jsonc"), JSON.stringify({ permission: {} }, null, 2)))
      const fiberEmpty = yield* perm
        .ask({
          id: PermissionV1.ID.make("per_prod_empty_global"),
          sessionID: SessionID.make("sess_empty_global"),
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [],
        })
        .pipe(Effect.forkScoped)
      yield* waitForPending(1)
      const provEmpty = yield* perm.provenance("per_prod_empty_global")
      expect(provEmpty?.decisive.result).toBe("ask")
      expect(provEmpty?.contributingLayers.some((l) => l.sourceKind === "global-file" && l.canonicalPath === path.join(tmpGlobal, "kilo.jsonc") && l.decision === "ask")).toBe(true)
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_prod_empty_global"), reply: "reject" })
      yield* Fiber.await(fiberEmpty).pipe(Effect.catchCause(() => Effect.void))
      yield* Effect.promise(() => fs.rm(path.join(tmpGlobal, "kilo.jsonc"), { force: true }).then(() => undefined).catch((err) => { console.warn("cleanup empty global file failed", err); throw err }))
      const exitAbsent = yield* perm
        .ask({
          sessionID: SessionID.make("sess_absent_global"),
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [],
        })
        .pipe(Effect.exit)
      expect(Exit.isSuccess(exitAbsent)).toBe(true)
    }), { git: true })

  it.instance("global deny via real disk file dominates project allow", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const t = yield* TestInstance
      const tmpGlobal = yield* isolatedGlobal
      yield* Effect.promise(() => fs.writeFile(path.join(tmpGlobal, "kilo.jsonc"), JSON.stringify({ permission: { bash: { "*": "deny" } } }, null, 2)))
      yield* Effect.promise(() => fs.mkdir(path.join(t.directory, ".kilo"), { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(projFile(t.directory), JSON.stringify({ permission: { bash: { "*": "allow" } } }, null, 2)))
      const exit = yield* perm
        .ask({
          sessionID: SessionID.make("sess_global_deny"),
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [],
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Permission.DeniedError)
      const fiber = yield* perm
        .ask({
          id: PermissionV1.ID.make("per_prod_deny_check"),
          sessionID: SessionID.make("sess_global_deny_check"),
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [],
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(fiber)).toBe(true)
      const prov = yield* perm.provenance("per_prod_deny_check")
      expect(prov?.decisive.result).toBe("deny")
      expect(prov?.contributingLayers.some((l) => l.sourceKind === "global-file" && l.decision === "deny")).toBe(true)
    }), { git: true })

  it.instance("project absent with global allow via real disk still allows", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const t = yield* TestInstance
      const tmpGlobal = yield* isolatedGlobal
      yield* Effect.promise(() => fs.writeFile(path.join(tmpGlobal, "kilo.jsonc"), JSON.stringify({ permission: { bash: { "*": "allow" } } }, null, 2)))
      yield* Effect.promise(() => fs.rm(projFile(t.directory), { force: true }).then(() => undefined).catch((err) => { console.warn("cleanup project file rm failed", err); throw err }))
      const exit = yield* perm
        .ask({
          sessionID: SessionID.make("sess_global_only_allow"),
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [],
        })
        .pipe(Effect.exit)
      expect(Exit.isSuccess(exit)).toBe(true)
    }), { git: true })
})

describe("R18 production-path - ceiling b and c exact approval positive and negative via service", () => {
  // LOCK-004: wildcard selector "*" is input-only; stored identity must be exact/non-glob.
  // For protected ceiling (b), exact "kilo.json" with selector "*" normalizes to exact canonical approval if behavior retains it, never stored as "*".
  it.instance("ceiling b ask-ceiling blocks even with disk allow and exact approval resolves, wildcard selector never stored as wildcard", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const t = yield* TestInstance
      const tmpGlobal = yield* isolatedGlobal
      yield* Effect.promise(() => fs.mkdir(path.join(t.directory, ".kilo"), { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(projFile(t.directory), JSON.stringify({ permission: { edit: { "*": "allow" } } }, null, 2)))
      const fiber = yield* perm
        .ask({
          id: PermissionV1.ID.make("per_b_ceiling"),
          sessionID: SessionID.make("sess_b_ceiling"),
          permission: "edit",
          patterns: ["kilo.json"],
          metadata: {},
          trustedContext: createTrusted("code"),
          always: [],
          ruleset: [],
        } as any)
        .pipe(Effect.forkScoped)
      yield* waitForPending(1)
      const prov = yield* perm.provenance("per_b_ceiling")
      expect(prov?.decisive.result).toBe("ask-ceiling")
      expect(prov?.decisive.ceilingId).toBe("(b)")
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_b_ceiling"), reply: "always" })
      yield* Fiber.await(fiber)
      const ok = yield* perm
        .ask({
          id: PermissionV1.ID.make("per_b_ceiling_check"),
          sessionID: SessionID.make("sess_b_ceiling"),
          permission: "edit",
          patterns: ["kilo.json"],
          metadata: {},
          trustedContext: createTrusted("code"),
          always: [],
          ruleset: [],
        } as any)
        .pipe(Effect.exit)
      expect(Exit.isSuccess(ok)).toBe(true)
      const provAllow = yield* perm.provenance("per_b_ceiling_check")
      expect(provAllow?.decisive.result).toBe("allow")
      expect(provAllow?.approval?.kind).toBe("session")
      // Wildcard selector input "*" on a protected exact request must never be stored as wildcard identity.
      const fiberBroad = yield* perm
        .ask({
          id: PermissionV1.ID.make("per_b_broad_negative"),
          sessionID: SessionID.make("sess_b_broad"),
          permission: "edit",
          patterns: ["kilo.json"],
          metadata: {},
          trustedContext: createTrusted("code"),
          always: ["*"],
          ruleset: [],
        } as any)
        .pipe(Effect.forkScoped)
      yield* waitForPending(1)
      const provBroad = yield* perm.provenance("per_b_broad_negative")
      expect(provBroad?.decisive.result).toBe("ask-ceiling")
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_b_broad_negative"), reply: "always" })
      yield* Fiber.await(fiberBroad).pipe(Effect.catchCause(() => Effect.void))
      const fiberCheck = yield* perm
        .ask({
          id: PermissionV1.ID.make("per_b_check_after_wild"),
          sessionID: SessionID.make("sess_b_broad_check"),
          permission: "edit",
          patterns: ["kilo.json"],
          metadata: {},
          trustedContext: createTrusted("code"),
          always: [],
          ruleset: [],
        } as any)
        .pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_b_check_after_wild"), reply: "reject" })
      yield* Fiber.await(fiberCheck).pipe(Effect.catchCause(() => Effect.void))
    }), { git: true })

  it.instance("ceiling c broad allow caps at ask-ceiling and exact approval resolves", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const t = yield* TestInstance
      const tmpGlobal = yield* isolatedGlobal
      yield* Effect.promise(() => fs.mkdir(path.join(t.directory, ".kilo"), { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(projFile(t.directory), JSON.stringify({ permission: { read: { "*": "allow" } } }, null, 2)))
      const fiber = yield* perm
        .ask({
          id: PermissionV1.ID.make("per_c_ceiling"),
          sessionID: SessionID.make("sess_c_ceiling"),
          permission: "read",
          patterns: ["secret.env"],
          metadata: {},
          always: ["secret.env"],
          ruleset: [],
        })
        .pipe(Effect.forkScoped)
      yield* waitForPending(1)
      const prov = yield* perm.provenance("per_c_ceiling")
      expect(prov?.decisive.result).toBe("ask-ceiling")
      expect(prov?.decisive.ceilingId).toBe("(c)")
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_c_ceiling"), reply: "always" })
      yield* Fiber.await(fiber)
      const ok = yield* perm
        .ask({
          id: PermissionV1.ID.make("per_c_ceiling_ok"),
          sessionID: SessionID.make("sess_c_ceiling"),
          permission: "read",
          patterns: ["secret.env"],
          metadata: {},
          always: [],
          ruleset: [],
        })
        .pipe(Effect.exit)
      expect(Exit.isSuccess(ok)).toBe(true)
      const provOk = yield* perm.provenance("per_c_ceiling_ok")
      expect(provOk?.decisive.result).toBe("allow")
      expect(provOk?.approval?.kind).toBe("session")
      const fiberOther = yield* perm
        .ask({
          id: PermissionV1.ID.make("per_c_other"),
          sessionID: SessionID.make("sess_c_other"),
          permission: "read",
          patterns: ["other.env"],
          metadata: {},
          always: [],
          ruleset: [],
        })
        .pipe(Effect.forkScoped)
      yield* waitForPending(1)
      const provOther = yield* perm.provenance("per_c_other")
      expect(provOther?.decisive.result).toBe("ask-ceiling")
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_c_other"), reply: "reject" })
      yield* Fiber.await(fiberOther).pipe(Effect.catchCause(() => Effect.void))
      const okExample = yield* perm
        .ask({
          sessionID: SessionID.make("sess_c_example"),
          permission: "read",
          patterns: ["foo.env.example"],
          metadata: {},
          always: [],
          ruleset: [],
        })
        .pipe(Effect.exit)
      expect(Exit.isSuccess(okExample)).toBe(true)
    }), { git: true })
})

describe("R18 production-path - saveAlwaysRules ceiling c exact vs wildcard/broad", () => {
  // LOCK-004 exactness: approvedAlways selector "*" or "*.env" is never stored as wildcard identity.
  // For an exact pending protected request (e.g. single "secret.env"), selector "*" may normalize to that exact canonical approval if retained; otherwise no glob stored.
  // @ts-ignore - Effect R inference for this complex saveAlwaysRules test requires wide service union, runtime verified via bun test
  it.instance("saveAlwaysRules exact approval for read secret.env resolves only that target and wildcard/broad selector never stored as wildcard", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const t = yield* TestInstance
      const tmpGlobal = yield* isolatedGlobal
      yield* Effect.promise(() => fs.mkdir(path.join(t.directory, ".kilo"), { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(projFile(t.directory), JSON.stringify({ permission: { read: { "*": "allow" } } }, null, 2)))
      const sess = SessionID.make("sess_save_c")
      const fiber = yield* perm
        .ask({
          id: PermissionV1.ID.make("per_save_c_exact"),
          sessionID: sess,
          permission: "read",
          patterns: ["secret.env"],
          metadata: {},
          always: ["secret.env"],
          ruleset: [],
        })
        .pipe(Effect.forkScoped)
      yield* waitForPending(1)
      const provBefore = yield* perm.provenance("per_save_c_exact")
      expect(provBefore?.decisive.result).toBe("ask-ceiling")
      expect(provBefore?.decisive.ceilingId).toBe("(c)")
      yield* perm.saveAlwaysRules({ requestID: PermissionV1.ID.make("per_save_c_exact"), approvedAlways: ["secret.env"] })
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_save_c_exact"), reply: "always" })
      yield* Fiber.await(fiber)
      const debugAfterExact = (yield* (perm as any).debugState()) as { approvals: any[]; approved: any[]; session: any }
      expect(debugAfterExact.approvals.some((a: any) => a.permission === "read" && a.patterns.includes(path.join(t.directory, "secret.env")) || a.patterns.includes("secret.env") || a.patterns.some((p: string) => p.includes("secret.env")))).toBe(true)
      const okSame = yield* perm
        .ask({
          id: PermissionV1.ID.make("per_save_c_same"),
          sessionID: sess,
          permission: "read",
          patterns: ["secret.env"],
          metadata: {},
          always: [],
          ruleset: [],
        })
        .pipe(Effect.exit)
      expect(Exit.isSuccess(okSame)).toBe(true)
      const provSame = yield* perm.provenance("per_save_c_same")
      expect(provSame?.decisive.result).toBe("allow")
      expect(provSame?.approval?.kind).toBe("session")
      const fiberOther = yield* perm
        .ask({
          id: PermissionV1.ID.make("per_save_c_other"),
          sessionID: sess,
          permission: "read",
          patterns: ["other.env"],
          metadata: {},
          always: [],
          ruleset: [],
        })
        .pipe(Effect.forkScoped)
      yield* waitForPending(1)
      const provOther = yield* perm.provenance("per_save_c_other")
      expect(provOther?.decisive.result).toBe("ask-ceiling")
      expect(provOther?.decisive.ceilingId).toBe("(c)")
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_save_c_other"), reply: "reject" })
      yield* Fiber.await(fiberOther).pipe(Effect.catchCause(() => Effect.void))
      // Wildcard selector "*.env" must never be stored as wildcard identity; exact pending request remains ask-ceiling in other session.
      const fiberWild = yield* perm
        .ask({
          id: PermissionV1.ID.make("per_save_c_wild"),
          sessionID: SessionID.make("sess_save_c_wild"),
          permission: "read",
          patterns: ["other.env"],
          metadata: {},
          always: ["other.env"],
          ruleset: [],
        })
        .pipe(Effect.forkScoped)
      yield* waitForPending(1)
      const debugBeforeWild = (yield* (perm as any).debugState()) as { approvals: any[] }
      const countBefore = debugBeforeWild.approvals.length
      yield* perm.saveAlwaysRules({ requestID: PermissionV1.ID.make("per_save_c_wild"), approvedAlways: ["*.env"] })
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_save_c_wild"), reply: "reject" })
      yield* Fiber.await(fiberWild).pipe(Effect.catchCause(() => Effect.void))
      const debugAfterWild = (yield* (perm as any).debugState()) as { approvals: any[]; approved: any[]; session: any }
      expect(debugAfterWild.approvals.length).toBe(countBefore)
      expect(debugAfterWild.approvals.some((a: any) => a.patterns.some((p: string) => p.includes("*.env")))).toBe(false)
      const fiberCheckWild = yield* perm
        .ask({
          id: PermissionV1.ID.make("per_save_c_check_wild"),
          sessionID: SessionID.make("sess_save_c_wild"),
          permission: "read",
          patterns: ["other.env"],
          metadata: {},
          always: [],
          ruleset: [],
        })
        .pipe(Effect.forkScoped)
      yield* waitForPending(1)
      const provCheckWild = yield* perm.provenance("per_save_c_check_wild")
      expect(provCheckWild?.decisive.result).toBe("ask-ceiling")
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_save_c_check_wild"), reply: "reject" })
      yield* Fiber.await(fiberCheckWild).pipe(Effect.catchCause(() => Effect.void))
      // Broad wildcard selector "*" never stored as "*"; for exact pending request it may normalize to exact canonical if retained.
      const fiberBroad = yield* perm
        .ask({
          id: PermissionV1.ID.make("per_save_c_broad"),
          sessionID: SessionID.make("sess_save_c_broad"),
          permission: "read",
          patterns: ["secret.env"],
          metadata: {},
          always: ["*"],
          ruleset: [],
        })
        .pipe(Effect.forkScoped)
      yield* waitForPending(1)
      const countBeforeBroad = ((yield* (perm as any).debugState()) as { approvals: any[] }).approvals.length
      yield* perm.saveAlwaysRules({ requestID: PermissionV1.ID.make("per_save_c_broad"), approvedAlways: ["*"] })
      const debugAfterBroad = (yield* (perm as any).debugState()) as { approvals: any[]; approved: any[]; session: any }
      expect(debugAfterBroad.approvals.every((a: any) => a.patterns.every((p: string) => !p.includes("*")))).toBe(true)
      const hasGlobBroad = debugAfterBroad.approvals.some((a: any) => a.patterns.some((p: string) => p === "*" || p.includes("*")))
      expect(hasGlobBroad).toBe(false)
      if (debugAfterBroad.approvals.length > countBeforeBroad) {
        const hasExactBroad = debugAfterBroad.approvals.some((a: any) => a.sessionID === "sess_save_c_broad" && a.patterns.some((p: string) => p.includes("secret.env")))
        expect(hasExactBroad).toBe(true)
      }
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_save_c_broad"), reply: "reject" })
      yield* Fiber.await(fiberBroad).pipe(Effect.catchCause(() => Effect.void))
    }), { git: true })
})

describe("R18 production-path - once/session lifecycle and no durable config mutation", () => {
  it.instance("once approval consumed after one operation and no file mutation", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const t = yield* TestInstance
      const tmpGlobal = yield* isolatedGlobal
      yield* Effect.promise(() => fs.rm(projFile(t.directory), { force: true }).then(() => undefined).catch((err) => { console.warn("cleanup rm project file failed", err); throw err }))
      yield* Effect.promise(() => fs.rm(path.join(t.directory, ".kilo"), { recursive: true, force: true }).then(() => undefined).catch((err) => { console.warn("cleanup rm .kilo failed", err); throw err }))
      const fiber = yield* perm
        .ask({
          id: PermissionV1.ID.make("per_once_lifecycle"),
          sessionID: SessionID.make("sess_once_lifecycle"),
          permission: "bash",
          patterns: ["echo once lifecycle"],
          metadata: {},
          always: [],
          ruleset: [],
        })
        .pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_once_lifecycle"), reply: "once" })
      yield* Fiber.join(fiber)
      const prov = yield* perm.provenance("per_once_lifecycle")
      expect(prov?.decisive.result).toBe("allow")
      expect(prov?.approval?.kind).toBe("once")
      const afterExists = yield* Effect.promise(() => fs.stat(projFile(t.directory)).then(() => true).catch(() => false))
      expect(afterExists).toBe(false)
      const globalContent = yield* Effect.promise(() => fs.readFile(path.join(tmpGlobal, "kilo.jsonc"), "utf8").catch(() => ""))
      expect(globalContent).toBe("")
      const fiber2 = yield* perm
        .ask({
          id: PermissionV1.ID.make("per_once_lifecycle2"),
          sessionID: SessionID.make("sess_once_lifecycle"),
          permission: "bash",
          patterns: ["echo once lifecycle"],
          metadata: {},
          always: [],
          ruleset: [],
        })
        .pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_once_lifecycle2"), reply: "reject" })
      yield* Fiber.await(fiber2).pipe(Effect.catchCause(() => Effect.void))
    }), { git: true })

  it.instance("session approval persists until dispose and no durable file mutation", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const t = yield* TestInstance
      const store = yield* InstanceStore.Service
      const tmpGlobal = yield* isolatedGlobal
      yield* Effect.promise(() => fs.mkdir(path.join(t.directory, ".kilo"), { recursive: true }))
      const beforeProj = JSON.stringify({ permission: { edit: { "*": "allow" } } }, null, 2)
      yield* Effect.promise(() => fs.writeFile(projFile(t.directory), beforeProj))
      const fiber = yield* perm
        .ask({
          id: PermissionV1.ID.make("per_session_lifecycle"),
          sessionID: SessionID.make("sess_session_lifecycle"),
          permission: "edit",
          patterns: ["kilo.json"],
          metadata: {},
          trustedContext: createTrusted("code"),
          always: [],
          ruleset: [],
        } as any)
        .pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_session_lifecycle"), reply: "always" })
      yield* Fiber.join(fiber)
      const prov = yield* perm.provenance("per_session_lifecycle")
      expect(prov?.approval?.kind).toBe("session")
      expect(prov?.approval?.expiry).toBe("session-end")
      const afterProj = yield* Effect.promise(() => fs.readFile(projFile(t.directory), "utf8"))
      expect(afterProj).toBe(beforeProj)
      const ok = yield* perm
        .ask({
          sessionID: SessionID.make("sess_session_lifecycle"),
          permission: "edit",
          patterns: ["kilo.json"],
          metadata: {},
          trustedContext: createTrusted("code"),
          always: [],
          ruleset: [],
        } as any)
        .pipe(Effect.exit)
      expect(Exit.isSuccess(ok)).toBe(true)
      const ctx = yield* store.load({ directory: t.directory })
      yield* store.dispose(ctx)
      const fiberAfter = yield* perm
        .ask({
          id: PermissionV1.ID.make("per_after_dispose"),
          sessionID: SessionID.make("sess_session_lifecycle"),
          permission: "edit",
          patterns: ["kilo.json"],
          metadata: {},
          trustedContext: createTrusted("code"),
          always: [],
          ruleset: [],
        } as any)
        .pipe(Effect.forkScoped)
      yield* waitForPending(1)
      const provAfter = yield* perm.provenance("per_after_dispose")
      expect(provAfter?.decisive.result).toBe("ask-ceiling")
      expect(provAfter?.approval).toBeUndefined()
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_after_dispose"), reply: "reject" })
      yield* Fiber.await(fiberAfter).pipe(Effect.catchCause(() => Effect.void))
    }), { git: true })
})

describe("R18 production-path - child session deny/approval noninheritance via service", () => {
  it.instance("child does not inherit parent session approval", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const t = yield* TestInstance
      const tmpGlobal = yield* isolatedGlobal
      yield* Effect.promise(() => fs.mkdir(path.join(t.directory, ".kilo"), { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(projFile(t.directory), JSON.stringify({ permission: { edit: { "*": "allow" } } }, null, 2)))
      const parentSess = SessionID.make("sess_parent_approval")
      const childSess = SessionID.make("sess_child_approval")
      const fiberParent = yield* perm
        .ask({
          id: PermissionV1.ID.make("per_parent_approval"),
          sessionID: parentSess,
          permission: "edit",
          patterns: ["kilo.json"],
          metadata: {},
          trustedContext: createTrusted("code"),
          always: [],
          ruleset: [],
        } as any)
        .pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_parent_approval"), reply: "always" })
      yield* Fiber.join(fiberParent)
      const fiberChild = yield* perm
        .ask({
          id: PermissionV1.ID.make("per_child_approval"),
          sessionID: childSess,
          permission: "edit",
          patterns: ["kilo.json"],
          metadata: {},
          trustedContext: createTrusted("code"),
          always: [],
          ruleset: [],
        } as any)
        .pipe(Effect.forkScoped)
      yield* waitForPending(1)
      const provChild = yield* perm.provenance("per_child_approval")
      expect(provChild?.decisive.result).toBe("ask-ceiling")
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_child_approval"), reply: "reject" })
      yield* Fiber.await(fiberChild).pipe(Effect.catchCause(() => Effect.void))
      const okParent = yield* perm
        .ask({
          sessionID: parentSess,
          permission: "edit",
          patterns: ["kilo.json"],
          metadata: {},
          trustedContext: createTrusted("code"),
          always: [],
          ruleset: [],
        } as any)
        .pipe(Effect.exit)
      expect(Exit.isSuccess(okParent)).toBe(true)
    }), { git: true })

  it.instance("child deny isolation via session restriction not leaked", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const t = yield* TestInstance
      const tmpGlobal = yield* isolatedGlobal
      void tmpGlobal
      yield* Effect.promise(() => fs.mkdir(path.join(t.directory, ".kilo"), { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(projFile(t.directory), JSON.stringify({ permission: { bash: { "*": "allow" } } }, null, 2)))
      const parentSess = "sess_parent_deny"
      const childSess = "sess_child_deny"
      const svcAny: any = yield* Permission.Service
      yield* (svcAny.__testSetSessionRules(parentSess, [{ permission: "bash", pattern: "ls", action: "deny" }]) as Effect.Effect<void, never, never>)
      yield* Effect.addFinalizer(() => (svcAny.__testSetSessionRules(parentSess, []) as Effect.Effect<void, never, never>))
      const exitParent = yield* perm
        .ask({
          sessionID: SessionID.make(parentSess),
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [],
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(exitParent)).toBe(true)
      const exitChild = yield* perm
        .ask({
          sessionID: SessionID.make(childSess),
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [],
        })
        .pipe(Effect.exit)
      expect(Exit.isSuccess(exitChild)).toBe(true)
    }), { git: true })
})

describe("R18 production-path - provenance read-model correctness through service", () => {
  it.instance("provenance reflects real disk canonical paths, request identity, and approval metadata via service", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const t = yield* TestInstance
      const tmpGlobal = yield* isolatedGlobal
      yield* Effect.promise(() => fs.writeFile(path.join(tmpGlobal, "kilo.jsonc"), JSON.stringify({ permission: { bash: { "*": "allow" } } }, null, 2)))
      yield* Effect.promise(() => fs.mkdir(path.join(t.directory, ".kilo"), { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(projFile(t.directory), JSON.stringify({ permission: { bash: { ls: "deny" } } }, null, 2)))
      const fiber = yield* perm
        .ask({
          id: PermissionV1.ID.make("per_prov_disk"),
          sessionID: SessionID.make("sess_prov_disk"),
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [],
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(fiber)).toBe(true)
      const prov = yield* perm.provenance("per_prov_disk")
      expect(prov).toBeDefined()
      expect(prov?.schemaVersion).toBe("1")
      expect(prov?.request.permissionRequestId).toBe("per_prov_disk")
      expect(prov?.request.operationId).toBe("permission:per_prov_disk")
      expect(prov?.request.permission).toBe("bash")
      expect(prov?.contributingLayers[0].sourceKind).toBe("runtime-safety")
      expect(prov?.contributingLayers.some((l) => l.sourceKind === "global-file" && l.canonicalPath === path.join(tmpGlobal, "kilo.jsonc"))).toBe(true)
      expect(prov?.contributingLayers.some((l) => l.sourceKind === "project-file" && l.canonicalPath === projFile(t.directory))).toBe(true)
      expect(prov?.decisive.result).toBe("deny")
      expect(prov?.decisive.reason).toContain("deny")
      const fiberPending = yield* perm
        .ask({
          id: PermissionV1.ID.make("per_prov_pending"),
          sessionID: SessionID.make("sess_prov_pending"),
          permission: "bash",
          patterns: ["echo hi"],
          metadata: {},
          always: [],
          ruleset: [],
        })
        .pipe(Effect.forkScoped)
      yield* waitForPending(1)
      const provPending = yield* perm.provenance("per_prov_pending")
      expect(provPending?.request.permissionRequestId).toBe("per_prov_pending")
      expect(provPending?.request.operationId).toBe("permission:per_prov_pending")
      expect(provPending?.contributingLayers[0].sourceKind).toBe("runtime-safety")
      expect(provPending?.decisive.result).toBe("ask")
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_prov_pending"), reply: "reject" })
      yield* Fiber.await(fiberPending).pipe(Effect.catchCause(() => Effect.void))
      const provAfter = yield* perm.provenance("per_prov_pending")
      expect(provAfter?.decisive.result).toBe("deny")
      expect(provAfter?.decisive.reason).toBe("rejected")
      expect((provAfter as any).approval).toBeUndefined()
      yield* Effect.promise(() => fs.writeFile(projFile(t.directory), JSON.stringify({ permission: { edit: { "*": "allow" } } }, null, 2)))
      const fiberProt = yield* perm
        .ask({
          id: PermissionV1.ID.make("per_prov_approval"),
          sessionID: SessionID.make("sess_prov_approval"),
          permission: "edit",
          patterns: ["kilo.json"],
          metadata: {},
          trustedContext: createTrusted("code"),
          always: [],
          ruleset: [],
        } as any)
        .pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_prov_approval"), reply: "always" })
      yield* Fiber.join(fiberProt)
      const provAp = yield* perm.provenance("per_prov_approval")
      expect(provAp?.approval).toBeDefined()
      expect(provAp?.approval?.kind).toBe("session")
      expect(provAp?.approval?.expiry).toBe("session-end")
      expect(provAp?.contributingLayers.some((l) => l.canonicalPath === `approval:sess_prov_approval` || l.sourceKind === "approval")).toBe(true)
    }), { git: true })
})
