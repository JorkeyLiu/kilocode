import { test, expect, describe, afterEach } from "bun:test"
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
import { TestInstance, disposeAllInstances, tmpdir } from "../fixture/fixture"
import { markProjectConfigReady } from "../fixture/plugin"
import { Global } from "@opencode-ai/core/global"
import { InstanceRef } from "../../src/effect/instance-ref"
import type { InstanceContext } from "../../src/project/instance-context"
import os from "os"
import path from "path"
import fs from "fs/promises"
import { createTestTrustedAgentContext as createTrusted } from "../helpers/trusted-helpers"

type AskWithTrusted = Permission.AskInput & { trustedContext: ReturnType<typeof createTrusted> }

const events = EventV2Bridge.defaultLayer
const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const base = Layer.mergeAll(
  Permission.layer.pipe(Layer.provide(Database.defaultLayer), Layer.provide(events)),
  events,
  CrossSpawnSpawner.defaultLayer,
  InstanceStore.defaultLayer.pipe(Layer.provide(noopBootstrap)),
).pipe(Layer.provide(Config.defaultLayer))
const env = Layer.mergeAll(base, Config.defaultLayer)
const it = testEffect(env)

afterEach(async () => {
  await disposeAllInstances()
})

const isolatedGlobal = Effect.gen(function* () {
  const prev = Global.Path.config
  const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "agent-xscope-global-")))
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

const projFile = (dir: string) => path.join(dir, ".kilo", "kilo.jsonc")

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

const repoAsk = (id: string, sess: string, pattern = "my-repo") =>
  ({
    id: PermissionV1.ID.make(id),
    sessionID: SessionID.make(sess),
    permission: "repo_clone",
    patterns: [pattern],
    metadata: {},
    trustedContext: createTrusted("code"),
    always: [pattern],
    ruleset: [],
  }) as unknown as AskWithTrusted

describe("agent.permission cross-scope floor", () => {
  it.instance("global JSONC deny survives project JSONC allow", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const t = yield* TestInstance
      const g = yield* isolatedGlobal
      yield* Effect.promise(() =>
        fs.writeFile(path.join(g, "kilo.jsonc"), JSON.stringify({ agent: { code: { permission: { repo_clone: "deny" } } } })),
      )
      yield* Effect.promise(() => fs.mkdir(path.join(t.directory, ".kilo"), { recursive: true }))
      yield* Effect.promise(() =>
        fs.writeFile(projFile(t.directory), JSON.stringify({ agent: { code: { permission: { repo_clone: "allow" } } } })),
      )
      const exit = yield* perm.ask(repoAsk("per_agent_global_jsonc_deny", "sess_agent_global_jsonc_deny")).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Permission.DeniedError)
      const prov = yield* perm.provenance("per_agent_global_jsonc_deny")
      expect(prov?.decisive.result).toBe("deny")
      expect(prov?.decisive.reason).toBe("agent-deny")
      const layers = prov?.contributingLayers.filter((l) => l.sourceKind === "agent-manifest") ?? []
      expect(layers.length).toBe(2)
      expect(layers.some((l) => l.canonicalPath === path.join(g, "kilo.jsonc") && l.decision === "deny")).toBe(true)
      expect(layers.some((l) => l.canonicalPath === projFile(t.directory) && l.decision === "allow")).toBe(true)
      // Ordinary readback keeps merged effective map (project allow wins visibly) while decision stays deny.
      const cfg = yield* Config.Service
      const effective = yield* cfg.get()
      expect((effective as any).agent?.code?.permission?.repo_clone).toBe("allow")
      const diskG = JSON.parse(yield* Effect.promise(() => fs.readFile(path.join(g, "kilo.jsonc"), "utf8")))
      expect(diskG.agent.code.permission.repo_clone).toBe("deny")
      const diskP = JSON.parse(yield* Effect.promise(() => fs.readFile(projFile(t.directory), "utf8")))
      expect(diskP.agent.code.permission.repo_clone).toBe("allow")
    }), { git: true })

  it.instance("global markdown deny survives project markdown allow", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const t = yield* TestInstance
      const g = yield* isolatedGlobal
      yield* Effect.promise(() => fs.writeFile(path.join(g, "kilo.jsonc"), JSON.stringify({})))
      yield* Effect.promise(() => fs.mkdir(path.join(g, "agents"), { recursive: true }))
      yield* Effect.promise(() =>
        fs.writeFile(path.join(g, "agents", "code.md"), `---\npermission:\n  repo_clone: deny\n---\n\nGlobal lock`),
      )
      yield* Effect.promise(() => fs.mkdir(path.join(t.directory, ".kilo", "agents"), { recursive: true }))
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(t.directory, ".kilo", "agents", "code.md"),
          `---\npermission:\n  repo_clone: allow\n---\n\nProject reopen`,
        ),
      )
      const exit = yield* perm.ask(repoAsk("per_agent_md_deny", "sess_agent_md_deny")).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      const prov = yield* perm.provenance("per_agent_md_deny")
      expect(prov?.decisive.result).toBe("deny")
      expect(prov?.decisive.reason).toBe("agent-deny")
      const layers = prov?.contributingLayers.filter((l) => l.sourceKind === "agent-manifest") ?? []
      expect(layers.some((l) => l.canonicalPath === path.join(g, "agents", "code.md") && l.decision === "deny")).toBe(true)
      expect(layers.some((l) => l.canonicalPath === path.join(t.directory, ".kilo", "agents", "code.md") && l.decision === "allow")).toBe(true)
    }), { git: true })

  it.instance("global JSONC deny survives project markdown allow and vice versa", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const t = yield* TestInstance
      const g = yield* isolatedGlobal
      yield* Effect.promise(() =>
        fs.writeFile(path.join(g, "kilo.jsonc"), JSON.stringify({ agent: { code: { permission: { repo_clone: "deny" } } } })),
      )
      yield* Effect.promise(() => fs.mkdir(path.join(t.directory, ".kilo", "agents"), { recursive: true }))
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(t.directory, ".kilo", "agents", "code.md"),
          `---\npermission:\n  repo_clone: allow\n---\n\nReopen`,
        ),
      )
      const e1 = yield* perm.ask(repoAsk("per_agent_mix1", "sess_agent_mix1")).pipe(Effect.exit)
      expect(Exit.isFailure(e1)).toBe(true)
      // Flip: global markdown deny + project JSONC allow.
      yield* Effect.promise(() => fs.writeFile(path.join(g, "kilo.jsonc"), JSON.stringify({})))
      yield* Effect.promise(() => fs.mkdir(path.join(g, "agents"), { recursive: true }))
      yield* Effect.promise(() =>
        fs.writeFile(path.join(g, "agents", "code.md"), `---\npermission:\n  repo_clone: deny\n---\n\nGlobal md lock`),
      )
      yield* Effect.promise(() => fs.rm(path.join(t.directory, ".kilo", "agents", "code.md"), { force: true }))
      yield* Effect.promise(() => fs.mkdir(path.join(t.directory, ".kilo"), { recursive: true }))
      yield* Effect.promise(() =>
        fs.writeFile(projFile(t.directory), JSON.stringify({ agent: { code: { permission: { repo_clone: "allow" } } } })),
      )
      const cfg = yield* Config.Service
      yield* cfg.invalidateProject()
      const e2 = yield* perm.ask(repoAsk("per_agent_mix2", "sess_agent_mix2")).pipe(Effect.exit)
      expect(Exit.isFailure(e2)).toBe(true)
      const prov2 = yield* perm.provenance("per_agent_mix2")
      expect(prov2?.decisive.result).toBe("deny")
    }), { git: true })

  it.instance("global authored empty ask beats project allow; absent allows", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const t = yield* TestInstance
      const g = yield* isolatedGlobal
      yield* Effect.promise(() =>
        fs.writeFile(path.join(g, "kilo.jsonc"), JSON.stringify({ agent: { code: { permission: {} } } })),
      )
      yield* Effect.promise(() => fs.mkdir(path.join(t.directory, ".kilo"), { recursive: true }))
      yield* Effect.promise(() =>
        fs.writeFile(projFile(t.directory), JSON.stringify({ agent: { code: { permission: { repo_clone: "allow" } } } })),
      )
      const fiber = yield* perm.ask(repoAsk("per_agent_empty", "sess_agent_empty")).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      const prov = yield* perm.provenance("per_agent_empty")
      expect(prov?.decisive.result).toBe("ask")
      const layers = prov?.contributingLayers.filter((l) => l.sourceKind === "agent-manifest") ?? []
      expect(layers.some((l) => l.canonicalPath === path.join(g, "kilo.jsonc") && l.decision === "ask")).toBe(true)
      yield* perm.reply({ requestID: PermissionV1.ID.make("per_agent_empty"), reply: "reject" })
      yield* Fiber.await(fiber).pipe(Effect.catchCause(() => Effect.void))
      // Absent global allows.
      yield* Effect.promise(() => fs.rm(path.join(g, "kilo.jsonc"), { force: true }))
      const cfg = yield* Config.Service
      yield* cfg.invalidateProject()
      const ok = yield* perm.ask(repoAsk("per_agent_absent", "sess_agent_absent")).pipe(Effect.exit)
      expect(Exit.isSuccess(ok)).toBe(true)
      expect((yield* perm.provenance("per_agent_absent"))?.decisive.result).toBe("allow")
    }), { git: true })

  it.instance("same-document exact wins; cross-layer exact allow cannot reopen wildcard deny", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const t = yield* TestInstance
      yield* isolatedGlobal
      yield* Effect.promise(() => fs.mkdir(path.join(t.directory, ".kilo"), { recursive: true }))
      // Same document: exact deny beats wildcard allow.
      yield* Effect.promise(() =>
        fs.writeFile(
          projFile(t.directory),
          JSON.stringify({ agent: { code: { permission: { repo_clone: { "*": "allow", "my-repo": "deny" } } } } }),
        ),
      )
      const e1 = yield* perm.ask(repoAsk("per_agent_exact_same", "sess_agent_exact_same", "my-repo")).pipe(Effect.exit)
      expect(Exit.isFailure(e1)).toBe(true)
      const prov1 = yield* perm.provenance("per_agent_exact_same")
      expect(prov1?.contributingLayers.find((l) => l.sourceKind === "agent-manifest")?.rules).toContainEqual({
        pattern: "my-repo",
        action: "deny",
        order: 1,
      })
      // Same document flipped: exact allow beats wildcard deny.
      yield* Effect.promise(() =>
        fs.writeFile(
          projFile(t.directory),
          JSON.stringify({ agent: { code: { permission: { repo_clone: { "*": "deny", "my-repo": "allow" } } } } }),
        ),
      )
      const cfg = yield* Config.Service
      yield* cfg.invalidateProject()
      const e2 = yield* perm.ask(repoAsk("per_agent_exact_same_allow", "sess_agent_exact_same_allow", "my-repo")).pipe(Effect.exit)
      expect(Exit.isSuccess(e2)).toBe(true)
      // Cross-layer: global wildcard deny beats project exact allow.
      const g = Global.Path.config
      yield* Effect.promise(() =>
        fs.writeFile(path.join(g, "kilo.jsonc"), JSON.stringify({ agent: { code: { permission: { repo_clone: "deny" } } } })),
      )
      yield* cfg.invalidateProject()
      const e3 = yield* perm.ask(repoAsk("per_agent_cross_exact", "sess_agent_cross_exact", "my-repo")).pipe(Effect.exit)
      expect(Exit.isFailure(e3)).toBe(true)
    }), { git: true })

  it.instance("debug and ask agree on agent floor", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const t = yield* TestInstance
      const g = yield* isolatedGlobal
      yield* Effect.promise(() =>
        fs.writeFile(path.join(g, "kilo.jsonc"), JSON.stringify({ agent: { code: { permission: { repo_clone: "deny" } } } })),
      )
      yield* Effect.promise(() => fs.mkdir(path.join(t.directory, ".kilo"), { recursive: true }))
      yield* Effect.promise(() =>
        fs.writeFile(projFile(t.directory), JSON.stringify({ agent: { code: { permission: { repo_clone: "allow" } } } })),
      )
      const exit = yield* perm.ask(repoAsk("per_agent_debug_ask", "sess_agent_debug")).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      const dbg = yield* perm.evaluateForDebug({
        permission: "repo_clone",
        patterns: ["my-repo"],
        metadata: {},
        sessionID: "sess_agent_debug",
        agent: "code",
      })
      expect(dbg.result).toBe("deny")
      expect(dbg.provenance.decisive.reason).toBe("agent-deny")
      const askProv = yield* perm.provenance("per_agent_debug_ask")
      expect(askProv?.decisive.reason).toBe(dbg.provenance.decisive.reason)
    }), { git: true })
})

describe("agent.permission isolation across projects in one runtime", () => {
  it.instance("sibling projects isolate and reload refreshes", () =>
    Effect.gen(function* () {
      const perm = yield* Permission.Service
      const cfg = yield* Config.Service
      const a = yield* TestInstance
      yield* isolatedGlobal
      const g = Global.Path.config
      yield* Effect.promise(() => fs.writeFile(path.join(g, "kilo.jsonc"), JSON.stringify({})))
      // Second project dir in the same runtime.
      const bPath = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "agent-xscope-b-"))).pipe(
        Effect.flatMap((tmp) => Effect.promise(() => fs.realpath(tmp))),
      )
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(bPath, { recursive: true, force: true }).catch(() => undefined)))
      yield* Effect.promise(() => markProjectConfigReady(bPath))
      yield* Effect.promise(() => fs.mkdir(path.join(a.directory, ".kilo"), { recursive: true }))
      yield* Effect.promise(() => fs.mkdir(path.join(bPath, ".kilo"), { recursive: true }))
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(a.directory, ".kilo", "kilo.jsonc"),
          JSON.stringify({ agent: { code: { permission: { repo_clone: "deny" } } } }),
        ),
      )
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(bPath, ".kilo", "kilo.jsonc"),
          JSON.stringify({ agent: { code: { permission: { repo_clone: "allow" } } } }),
        ),
      )
      const ctxFor = (dir: string): InstanceContext => ({ directory: dir, worktree: dir }) as unknown as InstanceContext
      const askFor = (dir: string, id: string, sess: string) =>
        perm
          .ask({
            id: PermissionV1.ID.make(id),
            sessionID: SessionID.make(sess),
            permission: "repo_clone",
            patterns: ["my-repo"],
            metadata: {},
            trustedContext: createTrusted("code"),
            always: ["my-repo"],
            ruleset: [],
          } as unknown as AskWithTrusted)
          .pipe(Effect.exit, Effect.provideService(InstanceRef, ctxFor(dir)))
      const a1 = yield* askFor(a.directory, "per_iso_a1", "sess_iso_a")
      const b1 = yield* askFor(bPath, "per_iso_b1", "sess_iso_b")
      expect(Exit.isFailure(a1)).toBe(true)
      expect(Exit.isSuccess(b1)).toBe(true)
      const g1 = yield* cfg.getGlobal()
      expect((g1 as any).agent).toBeUndefined()
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(bPath, ".kilo", "kilo.jsonc"),
          JSON.stringify({ agent: { code: { permission: { repo_clone: "deny" } } } }),
        ),
      )
      yield* cfg.invalidateProject().pipe(Effect.provideService(InstanceRef, ctxFor(bPath)))
      const b2 = yield* askFor(bPath, "per_iso_b2", "sess_iso_b")
      const a2 = yield* askFor(a.directory, "per_iso_a2", "sess_iso_a")
      expect(Exit.isFailure(b2)).toBe(true)
      expect(Exit.isFailure(a2)).toBe(true)
      const aCfg = yield* cfg.get().pipe(Effect.provideService(InstanceRef, ctxFor(a.directory)))
      const bCfg = yield* cfg.get().pipe(Effect.provideService(InstanceRef, ctxFor(bPath)))
      expect((aCfg as any).agent_permission_sources?.some((s: any) => s.kind === "project-jsonc")).toBe(true)
      expect((bCfg as any).agent_permission_sources?.some((s: any) => s.kind === "project-jsonc")).toBe(true)
    }), { git: true })
})
