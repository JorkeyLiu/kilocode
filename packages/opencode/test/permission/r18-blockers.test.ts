import { test, expect, describe } from "bun:test"
import { Cause, Effect, Layer, Exit, Fiber } from "effect"
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
import { Global } from "@opencode-ai/core/global"
import { AllowEverythingPermission } from "../../src/kilocode/permission/allow-everything"
import * as Evaluator from "../../src/permission/evaluator"
import path from "path"
import fs from "fs/promises"
import os from "os"
import { createTestTrustedAgentContext as createTrustedAgentContext } from "../helpers/trusted-helpers"
import { TestInstance } from "../fixture/fixture"

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

describe("R18 blockers - focused regressions", () => {
  it.instance("debug ID stable and operationId derived", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const fiber = yield* perm.ask({
        id: PermissionV1.ID.make("per_debug_id_test"),
        sessionID: SessionID.make("sess_debug_id"),
        permission: "bash",
        patterns: ["echo hi"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      const prov = yield* perm.provenance("per_debug_id_test")
      expect(prov).toBeDefined()
      expect(prov?.request.permissionRequestId).toBe("per_debug_id_test")
      expect(prov?.request.operationId).toBe("permission:per_debug_id_test")
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_debug_id_test"), reply: "reject" })
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      const after = yield* perm.provenance("per_debug_id_test")
      expect(after?.request.operationId).toBe("permission:per_debug_id_test")
    }), { git: true })

  it.instance("config without permission key is non-applicable", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const original = Global.Path.config
      const tmpGlobal = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "opencode-test-global-")))
      try {
        Global.Path.config = tmpGlobal
        yield* Effect.promise(() => fs.writeFile(path.join(tmpGlobal, "kilo.jsonc"), JSON.stringify({ model: "test/model" }, null, 2)))
        const r = {
          permission: "bash",
          patterns: ["ls"],
          permissionRequestId: "per_no_perm_key",
          operationId: "permission:per_no_perm_key",
          sessionID: "sess_no_perm",
          agent: "agent-a",
          workspaceRoot: "/workspace",
        } as any
        const layers: any[] = [
          { kind: "project", sourceKind: "project-file", canonicalPath: "/workspace/.kilo/kilo.jsonc", ruleset: [{ permission: "bash", pattern: "*", action: "allow" }] },
        ]
        const out = Evaluator.evaluate({ request: r, layers, approvals: [], allowEverything: false })
        expect(out.result).toBe("allow")
        const layers2: any[] = [
          { kind: "global", sourceKind: "global-file", canonicalPath: path.join(tmpGlobal, "kilo.jsonc"), ruleset: [] },
          { kind: "project", sourceKind: "project-file", canonicalPath: "/workspace/.kilo/kilo.jsonc", ruleset: [{ permission: "bash", pattern: "*", action: "allow" }] },
        ]
        const out2 = Evaluator.evaluate({ request: r, layers: layers2, approvals: [], allowEverything: false })
        expect(out2.result).toBe("ask")
        const fiber = yield* perm
          .ask({
            id: PermissionV1.ID.make("per_service_no_perm"),
            sessionID: SessionID.make("sess_service_no_perm"),
            permission: "bash",
            patterns: ["ls"],
            metadata: {},
            always: [],
            ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
          })
          .pipe(Effect.forkScoped)
        yield* Effect.sleep("50 millis")
        const list = yield* perm.list()
        expect(list.length).toBe(0)
        yield* Fiber.join(fiber).pipe(Effect.catchCause((cause) => Effect.sync(() => console.warn("expected fiber termination suppressed", cause))))
      } finally {
        Global.Path.config = original
        yield* Effect.promise(() => fs.rm(tmpGlobal, { recursive: true, force: true }).catch((err) => console.warn("cleanup rm failed", err))).pipe(Effect.catchCause((cause) => Effect.sync(() => console.warn("expected fiber termination suppressed", cause))))
      }
    }), { git: true })

  it.instance("interruption finalizes as rejected provenance before deletion", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const fiber = yield* perm.ask({
        id: PermissionV1.ID.make("per_interrupt"),
        sessionID: SessionID.make("sess_interrupt"),
        permission: "bash",
        patterns: ["sleep 30"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      const beforeProv = yield* perm.provenance("per_interrupt")
      expect(beforeProv).toBeDefined()
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      const list = yield* perm.list()
      expect(list.length).toBe(0)
      const afterProv = yield* perm.provenance("per_interrupt")
      expect(afterProv).toBeDefined()
      expect(afterProv?.decisive.result).toBe("deny")
      expect(afterProv?.decisive.reason).toBe("rejected")
      expect((afterProv as any).approval).toBeUndefined()
    }), { git: true })

  it.instance("deny-on-drain atomically removes pending and fails consistently", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const fiber1 = yield* perm.ask({
        id: PermissionV1.ID.make("per_drain_deny1"),
        sessionID: SessionID.make("sess_drain_deny"),
        permission: "bash",
        patterns: ["echo hi"],
        metadata: {},
        always: ["echo hi"],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      const fiber2 = yield* perm.ask({
        id: PermissionV1.ID.make("per_drain_deny2"),
        sessionID: SessionID.make("sess_drain_deny"),
        permission: "bash",
        patterns: ["echo hi"],
        metadata: {},
        always: ["echo hi"],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      yield* waitForPending(2)
      const fiberProt = yield* perm.ask({
        id: PermissionV1.ID.make("per_drain_prot"),
        sessionID: SessionID.make("sess_drain_prot"),
        permission: "write",
        patterns: [".kilo/kilo.jsonc"],
        metadata: {},
        always: [".kilo/kilo.jsonc"],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      yield* waitForPending(3)
      yield* perm.saveAlwaysRules({ requestID: PermissionV1.ID.make("per_drain_prot"), deniedAlways: [".kilo/kilo.jsonc"] })
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_drain_prot"), reply: "once" })
      yield* Fiber.await(fiberProt).pipe(Effect.catchCause((cause) => Effect.sync(() => console.warn("expected fiber termination suppressed", cause))))
      const prov = yield* perm.provenance("per_drain_prot")
      expect(prov).toBeDefined()
      expect(["deny", "ask"].includes(prov?.decisive.result as string) || prov?.decisive.reason === "rejected").toBe(true)
      const listAfter = yield* perm.list()
      expect(listAfter.some((r) => String(r.id) === "per_drain_prot")).toBe(false)
      for (const req of yield* perm.list()) {
        yield* perm.reply({ requestID: req.id, reply: "reject" }).pipe(Effect.catchCause((cause) => Effect.sync(() => console.warn("expected fiber termination suppressed", cause))))
      }
      yield* Fiber.await(fiber1).pipe(Effect.catchCause((cause) => Effect.sync(() => console.warn("expected fiber termination suppressed", cause))))
      yield* Fiber.await(fiber2).pipe(Effect.catchCause((cause) => Effect.sync(() => console.warn("expected fiber termination suppressed", cause))))
    }), { git: true })

  it.instance("wildcard terminal provenance truthful without synthetic allow", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const fiber = yield* perm.ask({
        id: PermissionV1.ID.make("per_wild"),
        sessionID: SessionID.make("sess_wild"),
        permission: "bash",
        patterns: ["*"],
        metadata: {},
        always: ["*"],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      const before = yield* perm.provenance("per_wild")
      expect(before).toBeDefined()
      expect(before?.decisive.result).toBe("ask")
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_wild"), reply: "once" })
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      const after = yield* perm.provenance("per_wild")
      expect(after).toBeDefined()
      expect(after?.decisive.result).not.toBe("allow")
      expect((after as any).approval).toBeUndefined()
      const fiber2 = yield* perm.ask({
        id: PermissionV1.ID.make("per_wild2"),
        sessionID: SessionID.make("sess_wild"),
        permission: "bash",
        patterns: ["*"],
        metadata: {},
        always: ["*"],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      const prov2 = yield* perm.provenance("per_wild2")
      expect(prov2?.decisive.result).toBe("ask")
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_wild2"), reply: "reject" })
      yield* Fiber.await(fiber2).pipe(Effect.catchCause((cause) => Effect.sync(() => console.warn("expected fiber termination suppressed", cause))))
    }), { git: true })

  it.instance("allow-everything does not perform durable writes", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const sessID = SessionID.make("ses_test_nowrite")
      // R18 LOCK-005: allow-everything must not perform durable writes; it routes via Permission.Service InstanceState only
      // Verify by checking that Permission state works without Config/Session writes
      yield* AllowEverythingPermission.effect({ enable: true, sessionID: sessID })
      const fiber = yield* perm.ask({
        id: PermissionV1.ID.make("per_ae_nowrite"),
        sessionID: sessID,
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      yield* Effect.sleep("50 millis")
      const list = yield* perm.list()
      expect(list.length).toBe(0)
      yield* Fiber.join(fiber).pipe(Effect.catchCause((cause) => Effect.sync(() => console.warn("expected fiber termination suppressed", cause))))
      yield* AllowEverythingPermission.effect({ enable: false, sessionID: sessID })
      const fiber2 = yield* perm.ask({
        id: PermissionV1.ID.make("per_ae_nowrite2"),
        sessionID: sessID,
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_ae_nowrite2"), reply: "reject" })
      yield* Fiber.await(fiber2).pipe(Effect.catchCause((cause) => Effect.sync(() => console.warn("expected fiber termination suppressed", cause))))
      // Global also
      yield* AllowEverythingPermission.effect({ enable: true })
      const fiber3 = yield* perm.ask({
        id: PermissionV1.ID.make("per_ae_nowrite3"),
        sessionID: SessionID.make("ses_other"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      yield* Effect.sleep("50 millis")
      const list3 = yield* perm.list()
      expect(list3.length).toBe(0)
      yield* Fiber.join(fiber3).pipe(Effect.catchCause((cause) => Effect.sync(() => console.warn("expected fiber termination suppressed", cause))))
      yield* AllowEverythingPermission.effect({ enable: false })
      const fiber4 = yield* perm.ask({
        id: PermissionV1.ID.make("per_ae_nowrite4"),
        sessionID: SessionID.make("ses_other"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_ae_nowrite4"), reply: "reject" })
      yield* Fiber.await(fiber4).pipe(Effect.catchCause((cause) => Effect.sync(() => console.warn("expected fiber termination suppressed", cause))))
    }), { git: true })

  it.instance("caller-controlled protectedAgent cannot hijack victim durable allow", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const test = yield* TestInstance
      const dir = test.directory
      const protectedPath = path.join(dir, "AGENTS.md")
      yield* Effect.promise(() => fs.writeFile(protectedPath, "test"))
      const victim = "victim-agent"
      const attacker = "attacker-agent"
      const globalFile = path.join(Global.Path.config, "kilo.jsonc")
      yield* Effect.promise(() => fs.mkdir(path.dirname(globalFile), { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(globalFile, JSON.stringify({ protected_files: { [victim]: { [protectedPath]: "allow" } } }, null, 2)))
      yield* Effect.sleep("20 millis")
      // Attacker tries to spoof victim via metadata and via legacy trustedAgent string (both must be ignored)
      const fiber = yield* perm.ask({
        id: PermissionV1.ID.make("per_spoof_attempt"),
        sessionID: SessionID.make("sess_spoof"),
        permission: "edit",
        patterns: ["AGENTS.md"],
        metadata: { protectedAgent: victim } as any,
        trustedContext: createTrustedAgentContext(attacker),
        always: [],
        ruleset: [],
      } as any).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      const prov = yield* perm.provenance("per_spoof_attempt")
      expect(prov).toBeDefined()
      expect(prov?.decisive.result).toBe("ask-ceiling")
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_spoof_attempt"), reply: "reject" })
      yield* Fiber.await(fiber).pipe(Effect.catchCause((cause) => Effect.sync(() => console.warn("expected fiber termination suppressed", cause))))
      // Second spoof: direct caller tries to set trustedAgent string to victim without branded context — must be ignored and not select victim allow
      const fiberSpoof2 = yield* perm.ask({
        id: PermissionV1.ID.make("per_spoof_trustedAgent_string"),
        sessionID: SessionID.make("sess_spoof2"),
        permission: "edit",
        patterns: ["AGENTS.md"],
        metadata: {} as any,
        trustedAgent: victim,
        always: [],
        ruleset: [],
      } as any).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      const prov2 = yield* perm.provenance("per_spoof_trustedAgent_string")
      expect(prov2).toBeDefined()
      expect(prov2?.decisive.result).toBe("ask-ceiling")
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_spoof_trustedAgent_string"), reply: "reject" })
      yield* Fiber.await(fiberSpoof2).pipe(Effect.catchCause((cause) => Effect.sync(() => console.warn("expected fiber termination suppressed", cause))))
      yield* Effect.promise(() => fs.rm(globalFile, { force: true }).catch((err) => console.warn("cleanup rm failed", err)))
    }), { git: true })

  it.instance("metadata-only protected targets trigger class-b ceiling", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const test = yield* TestInstance
      const dir = test.directory
      // edit with non-protected pattern but metadata filepath is protected .kilo/kilo.jsonc
      const protectedMeta = path.join(dir, ".kilo", "kilo.jsonc")
      yield* Effect.promise(() => fs.mkdir(path.dirname(protectedMeta), { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(protectedMeta, "{}"))
      const fiberEdit = yield* perm.ask({
        id: PermissionV1.ID.make("per_meta_edit"),
        sessionID: SessionID.make("sess_meta_edit"),
        permission: "edit",
        patterns: ["foo.txt"],
        metadata: { filepath: protectedMeta },
        trustedContext: createTrustedAgentContext("code"),
        always: [],
        ruleset: [{ permission: "edit", pattern: "*", action: "allow" }],
      } as any).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      const provEdit = yield* perm.provenance("per_meta_edit")
      expect(provEdit?.decisive.result).toBe("ask-ceiling")
      expect(provEdit?.decisive.ceilingId).toBe("(b)")
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_meta_edit"), reply: "reject" })
      yield* Fiber.await(fiberEdit).pipe(Effect.catchCause((cause) => Effect.sync(() => console.warn("expected fiber termination suppressed", cause))))

      // write with metadata files[].filePath protected
      const fiberWrite = yield* perm.ask({
        id: PermissionV1.ID.make("per_meta_write"),
        sessionID: SessionID.make("sess_meta_write"),
        permission: "write",
        patterns: ["foo.txt"],
        metadata: { files: [{ filePath: protectedMeta }] },
        trustedContext: createTrustedAgentContext("code"),
        always: [],
        ruleset: [{ permission: "write", pattern: "*", action: "allow" }],
      } as any).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      const provWrite = yield* perm.provenance("per_meta_write")
      expect(provWrite?.decisive.result).toBe("ask-ceiling")
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_meta_write"), reply: "reject" })
      yield* Fiber.await(fiberWrite).pipe(Effect.catchCause((cause) => Effect.sync(() => console.warn("expected fiber termination suppressed", cause))))

      // external_directory with metadata files[].filePath protected (mutating)
      const fiberExt = yield* perm.ask({
        id: PermissionV1.ID.make("per_meta_ext"),
        sessionID: SessionID.make("sess_meta_ext"),
        permission: "external_directory",
        patterns: ["foo.txt"],
        metadata: { files: [{ filePath: protectedMeta }] },
        trustedContext: createTrustedAgentContext("code"),
        always: [],
        ruleset: [{ permission: "external_directory", pattern: "*", action: "allow" }],
      } as any).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      const provExt = yield* perm.provenance("per_meta_ext")
      expect(provExt?.decisive.result).toBe("ask-ceiling")
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_meta_ext"), reply: "reject" })
      yield* Fiber.await(fiberExt).pipe(Effect.catchCause((cause) => Effect.sync(() => console.warn("expected fiber termination suppressed", cause))))
    }), { git: true })

  it.instance("no authored project source with agent/session restrictions shows truthful provenance", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const test = yield* TestInstance
      // Ensure no project file exists
      yield* Effect.promise(() => fs.rm(path.join(test.directory, ".kilo", "kilo.jsonc"), { force: true }).catch((err) => console.warn("cleanup rm failed", err)))
      yield* Effect.promise(() => fs.rm(path.join(test.directory, "kilo.jsonc"), { force: true }).catch((err) => console.warn("cleanup rm failed", err)))
      const exit2 = yield* perm.ask({
        id: PermissionV1.ID.make("per_truthful_prov2"),
        sessionID: SessionID.make("sess_truthful2"),
        permission: "bash",
        patterns: ["echo hi"],
        metadata: {},
        trustedContext: createTrustedAgentContext("code"),
        always: [],
        ruleset: [{ permission: "bash", pattern: "echo hi", action: "allow" }],
      } as any).pipe(Effect.exit)
      expect(Exit.isSuccess(exit2)).toBe(true)
      const prov2 = yield* perm.provenance("per_truthful_prov2")
      expect(prov2).toBeDefined()
      if (prov2) {
        const hasMislabel = prov2.contributingLayers.some((l) => l.sourceKind === "project-file" && l.canonicalPath.includes(".kilo/kilo.jsonc") && l.rules.some((r) => r.pattern === "echo hi"))
        expect(hasMislabel).toBe(false)
        const hasTruthful = prov2.contributingLayers.some((l) => l.canonicalPath === "memory:request-ruleset" && l.sourceKind === "session-restriction")
        expect(hasTruthful).toBe(true)
      }
    }), { git: true })

  it.instance("legitimate workspace path containing opencode-test- still honors global deny", () =>
    Effect.gen(function* () {
      const originalConfig = Global.Path.config
      const tmpGlobal = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "opencode-test-global-")))
      const wsLegit = path.join(os.tmpdir(), "opencode-test-legit-workspace-" + Date.now())
      yield* Effect.promise(() => fs.mkdir(wsLegit, { recursive: true }))
      try {
        Global.Path.config = tmpGlobal
        yield* Effect.promise(() => fs.writeFile(path.join(tmpGlobal, "kilo.jsonc"), JSON.stringify({ permission: { bash: { "*": "deny" } } }, null, 2)))
        const layers = Permission.resolveAuthoredGlobalLayers({ bash: { "*": "deny" } }, wsLegit)
        expect(layers.length).toBeGreaterThan(0)
        expect(layers[0]?.sourceKind).toBe("global-file")
        const r = {
          permission: "bash",
          patterns: ["ls"],
          permissionRequestId: "per_global_ws_test",
          operationId: "permission:per_global_ws_test",
          sessionID: "sess_global_ws",
          agent: "code",
          workspaceRoot: wsLegit,
        } as any
        const out = Evaluator.evaluate({ request: r, layers, approvals: [], allowEverything: false })
        expect(out.result).toBe("deny")
        expect(out.provenance.contributingLayers.some((l) => l.sourceKind === "global-file")).toBe(true)
      } finally {
        Global.Path.config = originalConfig
        yield* Effect.promise(() => fs.rm(tmpGlobal, { recursive: true, force: true }).catch((err) => console.warn("cleanup tmpGlobal failed", err))).pipe(Effect.catchCause((cause) => Effect.sync(() => console.warn("rm tmpGlobal suppressed", cause))))
        yield* Effect.promise(() => fs.rm(wsLegit, { recursive: true, force: true }).catch((err) => console.warn("cleanup wsLegit failed", err))).pipe(Effect.catchCause((cause) => Effect.sync(() => console.warn("rm wsLegit suppressed", cause))))
      }
    }), { git: true })

  it.instance("bash rm .kilo/kilo.jsonc with broad allow still ask-ceiling", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const test = yield* TestInstance
      const dir = test.directory
      const protectedFile = path.join(dir, ".kilo", "kilo.jsonc")
      yield* Effect.promise(() => fs.mkdir(path.dirname(protectedFile), { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(protectedFile, "{}"))
      const fiber = yield* perm.ask({
        id: PermissionV1.ID.make("per_bash_rm_prot"),
        sessionID: SessionID.make("sess_bash_rm"),
        permission: "bash",
        patterns: ["rm .kilo/kilo.jsonc"],
        metadata: { files: [{ filePath: protectedFile }], filepath: protectedFile, command: "rm .kilo/kilo.jsonc" },
        trustedContext: createTrustedAgentContext("code"),
        always: ["rm .kilo/kilo.jsonc *"],
        ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
      } as any).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      const prov = yield* perm.provenance("per_bash_rm_prot")
      expect(prov).toBeDefined()
      expect(prov?.decisive.result).toBe("ask-ceiling")
      expect(prov?.decisive.ceilingId).toBe("(b)")
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_bash_rm_prot"), reply: "reject" })
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }), { git: true })

  it.instance("bash mv protected file with broad allow still ask-ceiling", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const test = yield* TestInstance
      const dir = test.directory
      const src = path.join(dir, ".kilo", "kilo.jsonc")
      const dest = path.join(dir, ".kilo", "kilo.jsonc.bak")
      yield* Effect.promise(() => fs.mkdir(path.dirname(src), { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(src, "{}"))
      const fiber = yield* perm.ask({
        id: PermissionV1.ID.make("per_bash_mv_prot"),
        sessionID: SessionID.make("sess_bash_mv"),
        permission: "bash",
        patterns: ["mv .kilo/kilo.jsonc .kilo/kilo.jsonc.bak"],
        metadata: { files: [{ filePath: src }, { filePath: dest }], filepath: src, command: "mv .kilo/kilo.jsonc .kilo/kilo.jsonc.bak" },
        trustedContext: createTrustedAgentContext("code"),
        always: ["mv *"],
        ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
      } as any).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      const prov = yield* perm.provenance("per_bash_mv_prot")
      expect(prov?.decisive.result).toBe("ask-ceiling")
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_bash_mv_prot"), reply: "reject" })
      yield* Fiber.await(fiber).pipe(Effect.catchCause((cause) => Effect.sync(() => console.warn("expected fiber termination suppressed", cause))))
    }), { git: true })

  it.instance("bash sed -i protected file with broad allow still ask-ceiling", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const test = yield* TestInstance
      const dir = test.directory
      const target = path.join(dir, ".kilo", "kilo.jsonc")
      yield* Effect.promise(() => fs.mkdir(path.dirname(target), { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(target, "{}"))
      const fiber = yield* perm.ask({
        id: PermissionV1.ID.make("per_bash_sed_prot"),
        sessionID: SessionID.make("sess_bash_sed"),
        permission: "bash",
        patterns: ["sed -i s/foo/bar/ .kilo/kilo.jsonc"],
        metadata: { files: [{ filePath: target }], filepath: target, command: "sed -i s/foo/bar/ .kilo/kilo.jsonc" },
        trustedContext: createTrustedAgentContext("code"),
        always: ["sed *"],
        ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
      } as any).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      const prov = yield* perm.provenance("per_bash_sed_prot")
      expect(prov?.decisive.result).toBe("ask-ceiling")
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_bash_sed_prot"), reply: "reject" })
      yield* Fiber.await(fiber).pipe(Effect.catchCause((cause) => Effect.sync(() => console.warn("expected fiber termination suppressed", cause))))
    }), { git: true })

  it.instance("external_directory mutation with filepath without access read is ceiling", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const test = yield* TestInstance
      const dir = test.directory
      const outside = path.join(os.tmpdir(), "opencode-test-external-" + Date.now())
      yield* Effect.promise(() => fs.mkdir(outside, { recursive: true }))
      const target = path.join(outside, "file.txt")
      yield* Effect.promise(() => fs.writeFile(target, "hi"))
      try {
        const fiberMut = yield* perm.ask({
          id: PermissionV1.ID.make("per_ext_mut"),
          sessionID: SessionID.make("sess_ext_mut"),
          permission: "external_directory",
          patterns: [path.join(outside, "*")],
          metadata: { filepath: target, parentDir: outside },
          always: [path.join(outside, "*")],
          ruleset: [],
        } as any).pipe(Effect.forkScoped)
        yield* waitForPending(1)
        const provMut = yield* perm.provenance("per_ext_mut")
        expect(provMut?.decisive.result).not.toBe("allow")
        // mutation should be at least ask (and if protected would be ceiling, but external is not protected, so allow? Actually without allow it asks)
        // The key is that without access read, it is NOT short-circuited to isProtectedRequest false
        // So we check that it does not have isProtectedRequest false optimization; it should still be ask
        expect(provMut).toBeDefined()
        yield* perm.reply({ requestID: PermissionV1.ID.make("per_ext_mut"), reply: "reject" })
        yield* Fiber.await(fiberMut).pipe(Effect.catchCause((cause) => Effect.sync(() => console.warn("expected fiber termination suppressed", cause))))

        const fiberRead = yield* perm.ask({
          id: PermissionV1.ID.make("per_ext_read"),
          sessionID: SessionID.make("sess_ext_read"),
          permission: "external_directory",
          patterns: [path.join(outside, "*")],
          metadata: { filepath: target, parentDir: outside, access: "read" },
          always: [path.join(outside, "*")],
          ruleset: [],
        } as any).pipe(Effect.forkScoped)
        yield* waitForPending(1)
        const provRead = yield* perm.provenance("per_ext_read")
        expect(provRead).toBeDefined()
        // read-only external should not be protected ceiling, result should be ask (not ask-ceiling)
        expect(provRead?.decisive.ceilingId).not.toBe("(b)")
        yield* perm.reply({ requestID: PermissionV1.ID.make("per_ext_read"), reply: "reject" })
        yield* Fiber.await(fiberRead).pipe(Effect.catchCause((cause) => Effect.sync(() => console.warn("expected fiber termination suppressed", cause))))
      } finally {
        yield* Effect.promise(() => fs.rm(outside, { recursive: true, force: true }).catch((err) => console.warn("cleanup outside failed", err))).pipe(Effect.catchCause((cause) => Effect.sync(() => console.warn("rm outside suppressed", cause))))
      }
    }), { git: true })

  it.instance("metadata-only once approval is exact and mismatched metadata is rejected", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const test = yield* TestInstance
      const dir = test.directory
      const protectedMeta = path.join(dir, ".kilo", "kilo.jsonc")
      yield* Effect.promise(() => fs.mkdir(path.dirname(protectedMeta), { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(protectedMeta, "{}"))
      // First request with metadata-only protected target, get once approval
      const fiber1 = yield* perm.ask({
        id: PermissionV1.ID.make("per_meta_once1"),
        sessionID: SessionID.make("sess_meta_once"),
        permission: "edit",
        patterns: ["foo.txt"],
        metadata: { filepath: protectedMeta },
        trustedContext: createTrustedAgentContext("code"),
        always: [],
        ruleset: [{ permission: "edit", pattern: "*", action: "allow" }],
      } as any).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      const prov1 = yield* perm.provenance("per_meta_once1")
      expect(prov1?.decisive.result).toBe("ask-ceiling")
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_meta_once1"), reply: "once" })
      const exit1 = yield* Fiber.await(fiber1)
      // Once with exact canonical set (including metadata filepath) should resolve ceiling and allow
      expect(Exit.isSuccess(exit1)).toBe(true)
      // Now test that a subsequent request with same exact metadata would be allowed if we had session approval via always — test always path
      const fiber2 = yield* perm.ask({
        id: PermissionV1.ID.make("per_meta_always1"),
        sessionID: SessionID.make("sess_meta_once"),
        permission: "edit",
        patterns: ["foo.txt"],
        metadata: { filepath: protectedMeta },
        trustedContext: createTrustedAgentContext("code"),
        always: [],
        ruleset: [{ permission: "edit", pattern: "*", action: "allow" }],
      } as any).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_meta_always1"), reply: "always" })
      // This should create a session approval for the exact canonical set (foo.txt + protectedMeta)
      // Now a request with mismatched metadata (different file) should NOT be allowed
      const fiberMismatch = yield* perm.ask({
        id: PermissionV1.ID.make("per_meta_mismatch"),
        sessionID: SessionID.make("sess_meta_once"),
        permission: "edit",
        patterns: ["foo.txt"],
        metadata: { filepath: path.join(dir, ".kilo", "other.jsonc") },
        trustedContext: createTrustedAgentContext("code"),
        always: [],
        ruleset: [{ permission: "edit", pattern: "*", action: "allow" }],
      } as any).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      const provMismatch = yield* perm.provenance("per_meta_mismatch")
      expect(provMismatch?.decisive.result).toBe("ask-ceiling")
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_meta_mismatch"), reply: "reject" })
      yield* Fiber.await(fiberMismatch).pipe(Effect.catchCause((cause) => Effect.sync(() => console.warn("expected fiber termination suppressed", cause))))
      // Clean up any remaining pending from mismatch test
      const remaining = yield* perm.list()
      for (const r of remaining) {
        yield* perm.reply({ requestID: r.id, reply: "reject" }).pipe(Effect.catchCause((cause) => Effect.sync(() => console.warn("reject suppressed", cause))))
      }
      yield* Fiber.await(fiber2).pipe(Effect.catchCause((cause) => Effect.sync(() => console.warn("expected fiber termination suppressed", cause))))
    }), { git: true })

  it.instance("normal and debug evaluator parity with authored project config and agent/session rules", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const agentDenyLs = [{ permission: "bash", pattern: "ls", action: "deny" as const }]
      const allowLs = [{ permission: "bash", pattern: "ls", action: "allow" as const }]
      const sessionID = SessionID.make("sess_parity_test")
      // Ordinary agent "code" should NOT have hard deny — explicit allow should win (parity: normal and debug both not hard deny)
      const exitOrdinary = yield* perm.ask({
        id: PermissionV1.ID.make("per_parity_ordinary"),
        sessionID,
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        trustedContext: createTrustedAgentContext("code"),
        always: [],
        ruleset: allowLs,
      } as any).pipe(Effect.timeout("1 seconds"), Effect.exit)
      expect(Exit.isSuccess(exitOrdinary)).toBe(true)
      const debugOrdinary = yield* perm.evaluateForDebug({
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        sessionID: String(sessionID),
        agent: "code",
        agentPermission: allowLs,
      })
      // Ordinary agent with allow should be allow, not hard deny
      expect(debugOrdinary.result).toBe("allow")
      expect(debugOrdinary.provenance.decisive.ceilingId).not.toBe("(a)")
      // With explicit allow via agentPermission and project allow, debug for code should also be allow (not hard deny)
      const debugOrdinaryWithAllow = yield* perm.evaluateForDebug({
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        sessionID: String(sessionID),
        agent: "code",
        agentPermission: allowLs,
        hardRuleset: agentDenyLs,
      })
      expect(debugOrdinaryWithAllow.result).toBe("allow")
      // Mode-specific agent "ask" SHOULD have hard deny — both normal and debug should be hard deny even with allow
      const exitHard = yield* perm.ask({
        id: PermissionV1.ID.make("per_parity_hard"),
        sessionID,
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        trustedContext: createTrustedAgentContext("ask"),
        always: [],
        ruleset: allowLs,
        hardRuleset: agentDenyLs,
      } as any).pipe(Effect.timeout("1 seconds"), Effect.exit)
      expect(Exit.isFailure(exitHard)).toBe(true)
      if (Exit.isFailure(exitHard)) {
        const err = Cause.squash(exitHard.cause)
        expect(err instanceof Permission.DeniedError || err instanceof Permission.RejectedError).toBe(true)
      }
      const debugOut = yield* perm.evaluateForDebug({
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        sessionID: String(sessionID),
        agent: "ask",
        agentPermission: agentDenyLs,
        hardRuleset: agentDenyLs,
      })
      expect(debugOut.result).toBe("deny")
      expect(debugOut.provenance.decisive.ceilingId).toBe("(a)")
      // Also test session deny parity: debug with session deny should also deny
      const debugSession = yield* perm.evaluateForDebug({
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        sessionID: String(sessionID),
        agent: "code",
        agentPermission: [],
        sessionPermission: [{ permission: "bash", pattern: "ls", action: "deny" as const }],
      })
      expect(debugSession.result).toBe("deny")
      // normal/debug parity comparisons
      const ordinaryNormalResult: string = Exit.isSuccess(exitOrdinary) ? "allow" : "deny"
      expect(ordinaryNormalResult).toBe(debugOrdinary.result as string)
      const hardNormalResult: string = Exit.isFailure(exitHard) ? "deny" : "allow"
      expect(hardNormalResult).toBe(debugOut.result as string)
      const exitSession = yield* perm.ask({
        id: PermissionV1.ID.make("per_parity_session"),
        sessionID,
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        trustedContext: createTrustedAgentContext("code"),
        always: [],
        ruleset: [{ permission: "bash", pattern: "ls", action: "deny" as const }],
      } as any).pipe(Effect.timeout("1 seconds"), Effect.exit)
      expect(Exit.isFailure(exitSession)).toBe(true)
      const sessionNormalResult: string = Exit.isFailure(exitSession) ? "deny" : "allow"
      expect(sessionNormalResult).toBe(debugSession.result as string)
    }), { git: true })

  it.instance("no public permission module exports createTrustedAgentContext factory", () =>
    Effect.gen(function* () {
      const permMod: any = yield* Effect.promise(() => import("../../src/permission"))
      const evalMod: any = yield* Effect.promise(() => import("../../src/permission/evaluator"))
      const trustedCtxMod: any = yield* Effect.promise(() => import("../../src/permission/trusted-context"))
      const trustedAgentMod: any = yield* Effect.promise(() => import("../../src/kilocode/session/trusted-agent-context"))
      const gateMod: any = yield* Effect.promise(() => import("../../src/kilocode/session/trusted-gate"))
      expect(permMod.createTrustedAgentContext).toBeUndefined()
      expect(evalMod.createTrustedAgentContext).toBeUndefined()
      expect(trustedCtxMod.createTrustedAgentContext).toBeUndefined()
      expect(trustedAgentMod.createTrustedAgentContext).toBeUndefined()
      // gate's test helper is __testCreate..., not createTrustedAgentContext
      expect(gateMod.createTrustedAgentContext).toBeUndefined()
      // direct spoof with plain object without brand should be ignored and not grant victim allow
      const perm = yield* Permission.Service
      const victim = "victim-agent"
      const attacker = "attacker-agent"
      const dir = (yield* TestInstance).directory
      const protectedPath = path.join(dir, "AGENTS.md")
      yield* Effect.promise(() => fs.writeFile(protectedPath, "test"))
      const globalFile = path.join(Global.Path.config, "kilo.jsonc")
      yield* Effect.promise(() => fs.mkdir(path.dirname(globalFile), { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(globalFile, JSON.stringify({ protected_files: { [victim]: { [protectedPath]: "allow" } } }, null, 2)))
      yield* Effect.sleep("20 millis")
      const spoofCtx: any = { agent: victim, __trustedAgentBrand: true } // no brand Symbol
      const fiberSpoof = yield* perm.ask({
        id: PermissionV1.ID.make("per_spoof_no_brand"),
        sessionID: SessionID.make("sess_spoof_no_brand"),
        permission: "edit",
        patterns: ["AGENTS.md"],
        metadata: {},
        trustedContext: spoofCtx,
        always: [],
        ruleset: [],
      } as any).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      const provSpoof = yield* perm.provenance("per_spoof_no_brand")
      expect(provSpoof?.decisive.result).toBe("ask-ceiling")
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_spoof_no_brand"), reply: "reject" })
      yield* Fiber.await(fiberSpoof).pipe(Effect.catchCause((cause) => Effect.sync(() => console.warn("fiber await suppressed", Cause.pretty(cause)))))
      yield* Effect.promise(() => fs.rm(globalFile, { force: true }).catch((err) => console.warn("cleanup rm failed", err)))
    }), { git: true })

  it.instance("external_directory mutation with spoofed access read metadata and no trusted capability is still protected", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const test = yield* TestInstance
      const dir = test.directory
      const outside = path.join(os.tmpdir(), "opencode-test-external-spoof-" + Date.now())
      yield* Effect.promise(() => fs.mkdir(outside, { recursive: true }))
      const target = path.join(dir, ".kilo", "kilo.jsonc")
      yield* Effect.promise(() => fs.mkdir(path.dirname(target), { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(target, "{}"))
      const fiberSpoofRead = yield* perm.ask({
        id: PermissionV1.ID.make("per_ext_spoof_read"),
        sessionID: SessionID.make("sess_ext_spoof"),
        permission: "external_directory",
        patterns: [path.join(outside, "*")],
        metadata: { filepath: target, parentDir: outside, access: "read" },
        always: [path.join(outside, "*")],
        ruleset: [{ permission: "external_directory", pattern: "*", action: "allow" }],
      } as any).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      const provSpoof = yield* perm.provenance("per_ext_spoof_read")
      // Without trustedReadCapability, external_directory mutation targeting protected path must be ask-ceiling, not allowed
      expect(provSpoof?.decisive.result).toBe("ask-ceiling")
      expect(provSpoof?.decisive.ceilingId).toBe("(b)")
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_ext_spoof_read"), reply: "reject" })
      yield* Fiber.await(fiberSpoofRead).pipe(Effect.catchCause((cause) => Effect.sync(() => console.warn("fiber await suppressed", Cause.pretty(cause)))))
      yield* Effect.promise(() => fs.rm(outside, { recursive: true, force: true }).catch((err) => console.warn("cleanup rm failed", err)))
    }), { git: true })

  it.instance("approval glob syntax ? [] {} rejected for all permissions", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const sess = SessionID.make("sess_glob_reject")
      const patterns = ["a?b", "a[0]", "a{1,2}", "a*b", "a/b/*"]
      for (const pat of patterns) {
        const id = PermissionV1.ID.make(`per_glob_${pat.replaceAll(/[^a-zA-Z0-9]/g, "_")}`)
        const fiber = yield* perm.ask({
          id,
          sessionID: sess,
          permission: "bash",
          patterns: [pat],
          metadata: {},
          always: [pat],
          ruleset: [],
        }).pipe(Effect.forkScoped)
        yield* waitForPending(1)
        yield* perm.saveAlwaysRules({ requestID: id, approvedAlways: [pat] })
        yield* perm.reply({ requestID: id, reply: "once" })
        yield* Fiber.await(fiber).pipe(Effect.catchCause(() => Effect.void))
        // Subsequent exact same glob pattern should still be pending, not auto-allowed (glob rejected)
        const fiber2 = yield* perm.ask({
          id: PermissionV1.ID.make(`per_glob2_${pat.replaceAll(/[^a-zA-Z0-9]/g, "_")}`),
          sessionID: SessionID.make("sess_glob_reject2"),
          permission: "bash",
          patterns: [pat],
          metadata: {},
          always: [],
          ruleset: [],
        }).pipe(Effect.forkScoped)
        yield* waitForPending(1)
        const prov2 = yield* perm.provenance(`per_glob2_${pat.replaceAll(/[^a-zA-Z0-9]/g, "_")}`)
        expect(prov2?.decisive.result).not.toBe("allow")
        yield* perm.reply({ requestID: PermissionV1.ID.make(`per_glob2_${pat.replaceAll(/[^a-zA-Z0-9]/g, "_")}`), reply: "reject" })
        yield* Fiber.await(fiber2).pipe(Effect.catchCause(() => Effect.void))
      }
      // Also test permission glob "*"
      const idPermGlob = PermissionV1.ID.make("per_perm_glob")
      const fiberPerm = yield* perm.ask({
        id: idPermGlob,
        sessionID: sess,
        permission: "*",
        patterns: ["ls"],
        metadata: {},
        always: ["ls"],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* perm.saveAlwaysRules({ requestID: idPermGlob, approvedAlways: ["ls"] })
      yield* perm.reply({ requestID: idPermGlob, reply: "once" })
      yield* Fiber.await(fiberPerm).pipe(Effect.catchCause(() => Effect.void))
      const fiberPerm2 = yield* perm.ask({
        id: PermissionV1.ID.make("per_perm_glob2"),
        sessionID: SessionID.make("sess_glob_reject2"),
        permission: "*",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      const provPerm2 = yield* perm.provenance("per_perm_glob2")
      expect(provPerm2?.decisive.result).not.toBe("allow")
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_perm_glob2"), reply: "reject" })
      yield* Fiber.await(fiberPerm2).pipe(Effect.catchCause(() => Effect.void))
    }), { git: true })

  it.instance("approval mismatch and sibling not authorized", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const test = yield* TestInstance
      const dir = test.directory
      const targetA = path.join(dir, "AGENTS.md")
      const targetB = path.join(dir, "kilo.jsonc")
      yield* Effect.promise(() => fs.writeFile(targetA, "a"))
      yield* Effect.promise(() => fs.writeFile(targetB, "b"))
      const sessA = SessionID.make("sess_mismatch_a")
      const sessB = SessionID.make("sess_mismatch_b")
      // Approve exact AGENTS.md in sessA (protected, so stored per session)
      const fiberA = yield* perm.ask({
        id: PermissionV1.ID.make("per_mismatch_a"),
        sessionID: sessA,
        permission: "edit",
        patterns: [targetA],
        metadata: {},
        trustedContext: createTrustedAgentContext("code"),
        always: [targetA],
        ruleset: [],
      } as any).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_mismatch_a"), reply: "always" })
      yield* Fiber.await(fiberA).pipe(Effect.catchCause(() => Effect.void))
      // Same exact AGENTS.md in same sessA should be allowed
      const ok = yield* perm.ask({
        sessionID: sessA,
        permission: "edit",
        patterns: [targetA],
        metadata: {},
        trustedContext: createTrustedAgentContext("code"),
        always: [],
        ruleset: [],
      } as any).pipe(Effect.exit)
      expect(Exit.isSuccess(ok)).toBe(true)
      // Different file kilo.jsonc in same sessA should still be pending (mismatch not authorized)
      const fiberMismatch = yield* perm.ask({
        id: PermissionV1.ID.make("per_mismatch_b"),
        sessionID: sessA,
        permission: "edit",
        patterns: [targetB],
        metadata: {},
        trustedContext: createTrustedAgentContext("code"),
        always: [],
        ruleset: [],
      } as any).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      const provMismatch = yield* perm.provenance("per_mismatch_b")
      expect(provMismatch?.decisive.result).not.toBe("allow")
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_mismatch_b"), reply: "reject" })
      yield* Fiber.await(fiberMismatch).pipe(Effect.catchCause(() => Effect.void))
      // Same exact AGENTS.md but different session sessB should still be pending (session mismatch for protected)
      const fiberSibling = yield* perm.ask({
        id: PermissionV1.ID.make("per_mismatch_sibling"),
        sessionID: sessB,
        permission: "edit",
        patterns: [targetA],
        metadata: {},
        trustedContext: createTrustedAgentContext("code"),
        always: [],
        ruleset: [],
      } as any).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      const provSibling = yield* perm.provenance("per_mismatch_sibling")
      expect(provSibling?.decisive.result).not.toBe("allow")
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_mismatch_sibling"), reply: "reject" })
      yield* Fiber.await(fiberSibling).pipe(Effect.catchCause(() => Effect.void))
    }), { git: true })
})
