import { test, expect, describe } from "bun:test"
import { evaluate, type LayerInput, type Request } from "../../src/permission/evaluator"
import { Effect, Layer, Exit, Cause } from "effect"
import { Permission } from "../../src/permission"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { Config } from "../../src/config/config"
import { InstanceStore } from "../../src/project/instance-store"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Agent } from "../../src/agent/agent"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session/session"
import { ToolRegistry } from "../../src/tool/registry"
import { testEffect } from "../lib/effect"
import { Global } from "@opencode-ai/core/global"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { createToolContext, getDebugProvenance } from "../../src/cli/cmd/debug/agent.handler"
import { InstanceRef } from "../../src/effect/instance-ref"
import { TestInstance } from "../fixture/fixture"
import { createTestTrustedAgentContext, createTestTrustedReadCapability } from "../helpers/trusted-helpers"
import { KiloSessionPrompt } from "../../src/kilocode/session/prompt"
import { SessionID as SessionIDSchema } from "../../src/session/schema"

function normalizeProvenanceForParity(prov: any) {
  return {
    decisive: { result: prov.decisive.result, ceilingId: prov.decisive.ceilingId, reason: prov.decisive.reason },
    request: { permission: prov.request.permission, patterns: [...prov.request.patterns] },
    layers: prov.contributingLayers.map((l: any) => ({
      sourceKind: l.sourceKind,
      canonicalPath: l.canonicalPath,
      decision: l.decision,
      rules: [...l.rules].map((r: any) => ({ pattern: r.pattern, action: r.action, order: r.order })),
    })),
  }
}

function assertCompleteLayerParity(debugProv: any, normalProv: any) {
  const d = normalizeProvenanceForParity(debugProv)
  const n = normalizeProvenanceForParity(normalProv)
  expect(n.decisive.result).toBe(d.decisive.result)
  expect(n.decisive.ceilingId).toBe(d.decisive.ceilingId)
  expect(n.request.permission).toBe(d.request.permission)
  expect(n.request.patterns).toEqual(d.request.patterns)
  expect(n.layers.length).toBe(d.layers.length)
  for (let i = 0; i < d.layers.length; i++) {
    const dl = d.layers[i]
    const nl = n.layers[i]
    expect(nl.sourceKind).toBe(dl.sourceKind)
    expect(nl.canonicalPath).toBe(dl.canonicalPath)
    expect(nl.decision).toBe(dl.decision)
    expect(nl.rules).toEqual(dl.rules)
  }
  // allow distinct permissionRequestId/operationId but verify shape
  expect(debugProv.request.permissionRequestId).not.toBe(normalProv.request.permissionRequestId)
  expect(debugProv.request.operationId).toBe(`permission:${debugProv.request.permissionRequestId}`)
  expect(normalProv.request.operationId).toBe(`permission:${normalProv.request.permissionRequestId}`)
  // fail on omitted/substituted session layer or differing rule payload already enforced via ordered tuple equality above
}

function effectiveRulesetForTest(agentName: string, agentPerm?: Permission.Ruleset, sessionPerm?: Permission.Ruleset): Permission.Ruleset {
  const modes = ["ask", "plan", "architect"]
  const sessionRules = sessionPerm ?? []
  let guard: Permission.Ruleset
  if (!modes.includes(agentName.toLowerCase())) guard = sessionRules
  else {
    const denyOnly = sessionRules.filter((r) => r.action === "deny")
    guard = Permission.merge(sessionRules, agentPerm ?? [], denyOnly)
  }
  return Permission.merge(agentPerm ?? [], guard)
}
function hardRulesetForTest(agentName: string, agentPerm?: Permission.Ruleset): Permission.Ruleset | undefined {
  if (!["ask", "plan", "architect"].includes(agentName.toLowerCase())) return undefined
  return agentPerm && agentPerm.length > 0 ? [...agentPerm] : undefined
}

const ws = "/workspace"
const sess = "sess_debug"
const agent = "debug-agent"

function req(permission: string, patterns: string[], extra: Partial<Request> = {}): Request {
  return {
    permission,
    patterns,
    permissionRequestId: extra.permissionRequestId ?? "per_debug_123",
    operationId: extra.operationId ?? "permission:per_debug_123",
    sessionID: extra.sessionID ?? sess,
    agent: extra.agent ?? agent,
    workspaceRoot: ws,
    ...extra,
  }
}
function layer(kind: LayerInput["kind"], rules?: { permission: string; pattern: string; action: "allow" | "deny" | "ask" }[]): LayerInput {
  return { kind, sourceKind: kind === "global" ? "global-file" : kind === "runtime-ceiling" ? "runtime-safety" : "project-file", canonicalPath: `test:${kind}`, ruleset: rules }
}

describe("debug handler - deny/ask/ask-ceiling no tool execution and provenance IDs", () => {
  test("deny does not authorize tool execution", () => {
    const r = req("bash", ["rm -rf /"])
    const hard = [{ permission: "bash", pattern: "rm *", action: "deny" as const }]
    const layers: LayerInput[] = [layer("global", [{ permission: "bash", pattern: "*", action: "allow" }])]
    const out = evaluate({ request: r, layers, approvals: [], allowEverything: false, hardDenyRuleset: hard })
    expect(out.result).toBe("deny")
    expect(out.provenance.decisive.ceilingId).toBe("(a)")
    expect(out.provenance.request.permissionRequestId).toBe("per_debug_123")
    expect(out.provenance.request.operationId).toBe("permission:per_debug_123")
  })
  test("ask does not authorize tool execution", () => {
    const r = req("bash", ["ls"])
    const layers: LayerInput[] = [layer("global", [])]
    const out = evaluate({ request: r, layers, approvals: [], allowEverything: false })
    expect(out.result).toBe("ask")
    expect(out.provenance.request.permissionRequestId).toBe("per_debug_123")
    expect(out.provenance.request.operationId).toBe("permission:per_debug_123")
  })
  test("ask-ceiling does not authorize tool execution", () => {
    const r = req("edit", ["kilo.json"])
    const layers: LayerInput[] = [layer("global", [{ permission: "edit", pattern: "*", action: "allow" }])]
    const out = evaluate({ request: r, layers, approvals: [], allowEverything: false })
    expect(out.result).toBe("ask-ceiling")
    expect(out.provenance.decisive.ceilingId).toBe("(b)")
    expect(out.provenance.request.permissionRequestId).toBe("per_debug_123")
    expect(out.provenance.request.operationId).toBe("permission:per_debug_123")
  })
  test("provenance IDs stable across evaluations", () => {
    const r = req("read", ["secret.env"])
    const layers: LayerInput[] = [layer("global", [{ permission: "read", pattern: "*", action: "allow" }])]
    const out1 = evaluate({ request: r, layers, approvals: [], allowEverything: false })
    const out2 = evaluate({ request: r, layers, approvals: [], allowEverything: false })
    expect(out1.provenance.request.permissionRequestId).toBe(out2.provenance.request.permissionRequestId)
    expect(out1.provenance.request.operationId).toBe(out2.provenance.request.operationId)
    expect(out1.provenance.request.operationId).toBe(`permission:${r.permissionRequestId}`)
  })
})

// Realistic debug handler test invoking actual debug path/tool execution counter for deny/ask/ask-ceiling
const events = EventV2Bridge.defaultLayer
const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const env = Layer.mergeAll(
  Permission.layer.pipe(Layer.provide(Database.defaultLayer), Layer.provide(events)),
  events,
  CrossSpawnSpawner.defaultLayer,
  InstanceStore.defaultLayer.pipe(Layer.provide(noopBootstrap)),
  Agent.defaultLayer,
  Provider.defaultLayer,
  Session.defaultLayer,
  ToolRegistry.defaultLayer,
  Config.defaultLayer,
).pipe(Layer.provide(Config.defaultLayer))
const it = testEffect(env as any)

describe("debug handler realistic tool execution counter", () => {
  it.instance("deny does not execute tool via debug context", () =>
    Effect.gen(function* () {
      const dummyModel = { providerID: "test" as any, modelID: "test" as any }
      // Override permission to deny ls
      const testAgent = { name: "debug-test-deny", permission: [{ permission: "bash", pattern: "*", action: "deny" as const }], model: dummyModel } as any
      // Create a mock agent in config? Instead we can directly use the agent's permission for evaluation via debug context
      const ctx = yield* InstanceRef
      if (!ctx) return
      const toolCtx = yield* createToolContext(testAgent, ctx as any)
      let counter = 0
      const mockTool = {
        id: "bash",
        execute: (_args: any, c: any) =>
          Effect.gen(function* () {
            yield* c.ask({ permission: "bash", patterns: ["ls"], metadata: {}, always: [] })
            counter++
            return { title: "", output: "ok", metadata: {} }
          }),
      } as any
      const exit = yield* mockTool.execute({}, toolCtx).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(counter).toBe(0)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err instanceof PermissionV1.DeniedError || err instanceof PermissionV1.RejectedError).toBe(true)
      }
    }), { git: true })

  it.instance("ask does not execute tool via debug context", () =>
    Effect.gen(function* () {
      const dummyModel = { providerID: "test" as any, modelID: "test" as any }
      const testAgent = { name: "debug-test-ask", permission: [], model: dummyModel } as any
      const ctx = yield* InstanceRef
      if (!ctx) return
      const toolCtx = yield* createToolContext(testAgent, ctx as any)
      let counter = 0
      const mockTool = {
        id: "bash",
        execute: (_args: any, c: any) =>
          Effect.gen(function* () {
            yield* c.ask({ permission: "bash", patterns: ["ls"], metadata: {}, always: [] })
            counter++
            return { title: "", output: "ok", metadata: {} }
          }),
      } as any
      const exit = yield* mockTool.execute({}, toolCtx).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(counter).toBe(0)
    }), { git: true })

  it.instance("ask-ceiling does not execute tool via debug context", () =>
    Effect.gen(function* () {
      const dummyModel = { providerID: "test" as any, modelID: "test" as any }
      const testAgent = { name: "debug-test-ceiling", permission: [{ permission: "edit", pattern: "*", action: "allow" as const }], model: dummyModel } as any
      const ctx = yield* InstanceRef
      if (!ctx) return
      const toolCtx = yield* createToolContext(testAgent, ctx as any)
      let counter = 0
      const mockTool = {
        id: "edit",
        execute: (_args: any, c: any) =>
          Effect.gen(function* () {
            yield* c.ask({ permission: "edit", patterns: ["kilo.json"], metadata: {}, always: [] })
            counter++
            return { title: "", output: "ok", metadata: {} }
          }),
      } as any
      const exit = yield* mockTool.execute({}, toolCtx).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(counter).toBe(0)
    }), { git: true })

  it.instance("allow executes tool via debug context", () =>
    Effect.gen(function* () {
      const dummyModel = { providerID: "test" as any, modelID: "test" as any }
      const testAgent = { name: "debug-test-allow", permission: [{ permission: "bash", pattern: "*", action: "allow" as const }], model: dummyModel } as any
      const ctx = yield* InstanceRef
      if (!ctx) return
      const toolCtx = yield* createToolContext(testAgent, ctx as any)
      let counter = 0
      const mockTool = {
        id: "bash",
        execute: (_args: any, c: any) =>
          Effect.gen(function* () {
            yield* c.ask({ permission: "bash", patterns: ["ls"], metadata: {}, always: [] })
            counter++
            return { title: "", output: "ok", metadata: {} }
          }),
      } as any
       const exit = yield* mockTool.execute({}, toolCtx).pipe(Effect.exit)
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(counter).toBe(1)
    }), { git: true })

  it.instance("trusted read debug parity with normal Permission.ask - non-empty production-effective agent/session rules", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const cap = createTestTrustedReadCapability()
      const testInstance = yield* TestInstance
      const dir = testInstance.directory
      const protectedTarget = path.join(dir, ".kilo", "kilo.jsonc")
      yield* Effect.promise(() => fs.mkdir(path.dirname(protectedTarget), { recursive: true }))
      const projectPermission = { external_directory: { "*": "allow" } }
      const agentRules: Permission.Ruleset = [{ permission: "external_directory", pattern: "*", action: "allow" as const }]
      const sessionRules: Permission.Ruleset = [{ permission: "external_directory", pattern: protectedTarget, action: "allow" as const }]
      // Authored project policy + non-empty agent/session layers (LOCK-003) — write project file with both permission and agent manifest so normal Permission.ask sees distinct layers via production builder
      const projectFileContent = {
        permission: projectPermission,
      }
      yield* Effect.promise(() => fs.writeFile(protectedTarget, JSON.stringify(projectFileContent, null, 2)))
      yield* Effect.sleep("20 millis")
      const patterns = [protectedTarget]
      const commonSessionID = "sess_debug_trusted_parity"
      // Ensure normal Permission.ask sees distinct layers via runtime state (same as debug's fallback) — use test overrides for agent/session
      yield* (perm as any).__testSetAgentRules("code", agentRules)
      yield* (perm as any).__testSetSessionRules(commonSessionID, sessionRules)
      yield* (perm as any).__testSetSessionRules("sess_debug_trusted_without", sessionRules)
      const outWithout = yield* perm.evaluateForDebug({
        permission: "external_directory",
        patterns,
        metadata: { filepath: protectedTarget },
        sessionID: "sess_debug_trusted_without",
        agent: "code",
        agentPermission: agentRules,
        sessionPermission: sessionRules,
      } as any)
      expect(outWithout.result).toBe("ask-ceiling")
      expect(outWithout.provenance.decisive.ceilingId).toBe("(b)")
      const outWith = yield* perm.evaluateForDebug({
        permission: "external_directory",
        patterns,
        metadata: { filepath: protectedTarget, access: "read" },
        sessionID: commonSessionID,
        agent: "code",
        agentPermission: agentRules,
        sessionPermission: sessionRules,
        trustedReadCapability: cap as any,
      })
      expect(outWith.result).toBe("allow")
      expect(outWith.provenance.decisive.result).toBe("allow")
      expect(outWith.provenance.decisive.ceilingId).toBeNull()
      expect(outWith.provenance.request.permission).toBe("external_directory")
      const debugProjectLayer = outWith.provenance.contributingLayers.find((l) => l.sourceKind === "project-file")
      expect(debugProjectLayer).toBeDefined()
      expect(debugProjectLayer?.decision).toBe("allow")
      // Normal path via real Permission.ask with same trusted session/agent context and non-empty effective rules (LOCK-001)
      const effective = effectiveRulesetForTest("code", agentRules, sessionRules)
      const hard = hardRulesetForTest("code", agentRules)
      const normalId = PermissionV1.ID.make("per_normal_trusted_parity")
      const trustedCtx = createTestTrustedAgentContext("code")
      const exitNormal = yield* (perm.ask as any)({
        id: normalId,
        sessionID: SessionIDSchema.make(commonSessionID),
        permission: "external_directory",
        patterns,
        metadata: { filepath: protectedTarget, access: "read" },
        always: [],
        ruleset: effective,
        hardRuleset: hard,
        trustedContext: trustedCtx,
        trustedReadCapability: cap,
      }).pipe(Effect.exit)
      expect(Exit.isSuccess(exitNormal)).toBe(true)
      const normalProv = yield* perm.provenance(String(normalId))
      expect(normalProv).toBeDefined()
      // Complete ordered layer tuple equality (LOCK-001/004) — every sourceKind/canonicalPath/decision/rules pattern/action/order must match, IDs allowed distinct
      assertCompleteLayerParity(outWith.provenance, normalProv!)
      // Verify distinct authoritative agent/session layers are present and not omitted/substituted (LOCK-003) even though project allows
      const debugAgentLayer = outWith.provenance.contributingLayers.find((l) => l.sourceKind === "agent-manifest")
      expect(debugAgentLayer).toBeDefined()
      expect(debugAgentLayer?.canonicalPath).toBe(`agent:code`)
      expect(debugAgentLayer?.decision).toBe("allow")
      // Also verify via debug tool context forwarding uses identical evaluator context (LOCK-001) with non-empty effective rules
      const ctx = yield* InstanceRef
      if (!ctx) return
      const dummyModel = { providerID: "test" as any, modelID: "test" as any }
      const testAgent = { name: "code", permission: agentRules as any, model: dummyModel } as any
      const toolCtx = yield* createToolContext(testAgent, ctx as any)
      let counter = 0
      const mockTool = {
        id: "external_directory",
        execute: (_args: any, c: any) =>
          Effect.gen(function* () {
            yield* c.ask({ permission: "external_directory", patterns, metadata: { filepath: protectedTarget, access: "read" }, always: [], trustedReadCapability: cap } as any)
            counter++
            return { title: "", output: "ok", metadata: {} }
          }),
      } as any
      const exit = yield* mockTool.execute({}, toolCtx).pipe(Effect.exit)
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(counter).toBe(1)
      const mockToolNoCap = {
        id: "external_directory",
        execute: (_args: any, c: any) =>
          Effect.gen(function* () {
            yield* c.ask({ permission: "external_directory", patterns, metadata: { filepath: protectedTarget }, always: [] } as any)
            counter++
            return { title: "", output: "ok", metadata: {} }
          }),
      } as any
      const exit2 = yield* mockToolNoCap.execute({}, toolCtx).pipe(Effect.exit)
      expect(Exit.isFailure(exit2)).toBe(true)
    }), { git: true })

  it.instance("non-empty agent/session distinct authoritative parity - project allow does not override restrictions", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const testInstance = yield* TestInstance
      const dir = testInstance.directory
      const projectFile = path.join(dir, ".kilo", "kilo.jsonc")
      yield* Effect.promise(() => fs.mkdir(path.dirname(projectFile), { recursive: true }))
      const sessID = "sess_parity_distinct"
      const agentDeny: Permission.Ruleset = [{ permission: "bash", pattern: "ls", action: "deny" as const }]
      const agentAllow: Permission.Ruleset = [{ permission: "bash", pattern: "*", action: "allow" as const }]
      const sessionDeny: Permission.Ruleset = [{ permission: "bash", pattern: "echo hi", action: "deny" as const }]
      const sessAllow: Permission.Ruleset = [{ permission: "bash", pattern: "ls", action: "allow" as const }]
      // Case 1: project allow + agent deny (session allow) => debug and normal both deny, agent layer decisive, not omitted — via real Permission.ask
      yield* Effect.promise(() => fs.writeFile(projectFile, JSON.stringify({ permission: { bash: { "*": "allow" } } }, null, 2)))
      yield* Effect.sleep("20 millis")
      yield* (perm as any).__testSetAgentRules("code", agentDeny)
      yield* (perm as any).__testSetSessionRules(sessID, sessAllow)
      const debugAgentDeny = yield* perm.evaluateForDebug({
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        sessionID: sessID,
        agent: "code",
        agentPermission: agentDeny,
        sessionPermission: sessAllow,
      })
      expect(debugAgentDeny.result).toBe("deny")
      const effective1 = effectiveRulesetForTest("code", agentDeny, sessAllow)
      const hard1 = hardRulesetForTest("code", agentDeny)
      const id1 = PermissionV1.ID.make("per_parity_agent_deny")
      const exit1 = yield* (perm.ask as any)({
        id: id1,
        sessionID: SessionIDSchema.make(sessID),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: effective1,
        hardRuleset: hard1,
        trustedContext: createTestTrustedAgentContext("code"),
      }).pipe(Effect.exit)
      expect(Exit.isFailure(exit1)).toBe(true)
      const normalProv1 = yield* perm.provenance(String(id1))
      expect(normalProv1).toBeDefined()
      assertCompleteLayerParity(debugAgentDeny.provenance, normalProv1!)
      const dProj1 = debugAgentDeny.provenance.contributingLayers.find((l) => l.sourceKind === "project-file")
      expect(dProj1?.decision).toBe("allow")
      // Case 2: project allow + session deny (agent allow) => session restriction authoritative
      yield* Effect.promise(() => fs.writeFile(projectFile, JSON.stringify({ permission: { bash: { "*": "allow" } } }, null, 2)))
      yield* Effect.sleep("20 millis")
      yield* (perm as any).__testSetAgentRules("code", agentAllow)
      yield* (perm as any).__testSetSessionRules(sessID, sessionDeny)
      const debugSessDeny = yield* perm.evaluateForDebug({
        permission: "bash",
        patterns: ["echo hi"],
        metadata: {},
        sessionID: sessID,
        agent: "code",
        agentPermission: agentAllow,
        sessionPermission: sessionDeny,
      })
      expect(debugSessDeny.result).toBe("deny")
      const effective2 = effectiveRulesetForTest("code", agentAllow, sessionDeny)
      const hard2 = hardRulesetForTest("code", agentAllow)
      const id2 = PermissionV1.ID.make("per_parity_sess_deny")
      const exit2 = yield* (perm.ask as any)({
        id: id2,
        sessionID: SessionIDSchema.make(sessID),
        permission: "bash",
        patterns: ["echo hi"],
        metadata: {},
        always: [],
        ruleset: effective2,
        hardRuleset: hard2,
        trustedContext: createTestTrustedAgentContext("code"),
      }).pipe(Effect.exit)
      expect(Exit.isFailure(exit2)).toBe(true)
      const normalProv2 = yield* perm.provenance(String(id2))
      expect(normalProv2).toBeDefined()
      assertCompleteLayerParity(debugSessDeny.provenance, normalProv2!)
      // Also verify allow parity when both agent and session allow alongside project allow => allow via real ask
      yield* Effect.promise(() => fs.writeFile(projectFile, JSON.stringify({ permission: { bash: { "*": "allow" } } }, null, 2)))
      yield* Effect.sleep("20 millis")
      yield* (perm as any).__testSetAgentRules("code", agentAllow)
      yield* (perm as any).__testSetSessionRules(sessID, sessAllow)
      const debugAllow = yield* perm.evaluateForDebug({
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        sessionID: sessID,
        agent: "code",
        agentPermission: agentAllow,
        sessionPermission: sessAllow,
      })
      expect(debugAllow.result).toBe("allow")
      const effective3 = effectiveRulesetForTest("code", agentAllow, sessAllow)
      const hard3 = hardRulesetForTest("code", agentAllow)
      const id3 = PermissionV1.ID.make("per_parity_allow")
      const exit3 = yield* (perm.ask as any)({
        id: id3,
        sessionID: SessionIDSchema.make(sessID),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: effective3,
        hardRuleset: hard3,
        trustedContext: createTestTrustedAgentContext("code"),
      }).pipe(Effect.exit)
      expect(Exit.isSuccess(exit3)).toBe(true)
      const normalProv3 = yield* perm.provenance(String(id3))
      expect(normalProv3).toBeDefined()
      assertCompleteLayerParity(debugAllow.provenance, normalProv3!)
    }), { git: true })
})
