import { describe, expect, afterEach, test } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { Agent } from "../../src/agent/agent"
import { AgentCapability } from "../../src/agent/capability"
import { Config } from "../../src/config/config"
import { Auth } from "../../src/auth"
import { Provider } from "../../src/provider/provider"
import { Skill } from "../../src/skill"
import { Plugin } from "../../src/plugin"
import { MCP } from "../../src/mcp"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { InstanceRef } from "../../src/effect/instance-ref"
import type { InstanceContext } from "../../src/project/instance-context"
import { TestInstance, disposeAllInstances, tmpdir } from "../fixture/fixture"
import { markProjectConfigReady } from "../fixture/plugin"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const layer = Agent.layer.pipe(
  Layer.provide(Plugin.defaultLayer),
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Skill.defaultLayer),
  Layer.provide(Layer.mock(MCP.Service)({})),
  Layer.provide(RuntimeFlags.layer()),
)

const it = testEffect(layer)

function useGlobal(agent: unknown) {
  return Effect.gen(function* () {
    const prev = Global.Path.config
    const dir = yield* Effect.promise(async () => fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cap-xscope-global-"))))
    Global.Path.config = dir
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)).pipe(
        Effect.tap(() => Effect.sync(() => void (Global.Path.config = prev))),
        Effect.ignore,
      ),
    )
    yield* Effect.promise(() => fs.writeFile(path.join(dir, "kilo.jsonc"), JSON.stringify({ agent })))
    // No manual Config invalidate: the global stamp is content+path based, so
    // the next Config.get refreshes automatically (same pattern as r18 tests).
  })
}

describe("capability cross-scope floor", () => {
  it.instance(
    "global disable survives project re-enable (same key)",
    () =>
      Effect.gen(function* () {
        yield* useGlobal({ code: { tools: { bash: false, write: false } } })
        const agent = yield* Agent.Service.use((svc) => svc.get("code"))
        expect(AgentCapability.isDisabled(agent!, "bash")).toBe(true)
        expect(AgentCapability.isDisabled(agent!, "write")).toBe(true)
        expect(AgentCapability.isDisabled(agent!, "edit")).toBe(true)
        expect(AgentCapability.isDisabled(agent!, "apply_patch")).toBe(true)
      }),
    {
      config: {
        agent: {
          code: { tools: { bash: true, edit: true } },
        },
      } as any,
    },
  )

  it.instance(
    "alias: global write:false blocks project edit:true",
    () =>
      Effect.gen(function* () {
        yield* useGlobal({ code: { tools: { write: false } } })
        const agent = yield* Agent.Service.use((svc) => svc.get("code"))
        expect(AgentCapability.isDisabled(agent!, "edit")).toBe(true)
        expect(AgentCapability.isDisabled(agent!, "write")).toBe(true)
        expect(AgentCapability.isDisabled(agent!, "apply_patch")).toBe(true)
        expect(AgentCapability.isDisabled(agent!, "bash")).toBe(false)
      }),
    {
      config: {
        agent: {
          code: { tools: { edit: true } },
        },
      } as any,
    },
  )

  it.instance(
    "build key aliases code across scopes",
    () =>
      Effect.gen(function* () {
        yield* useGlobal({ build: { tools: { bash: false } } })
        const agent = yield* Agent.Service.use((svc) => svc.get("code"))
        expect(AgentCapability.isDisabled(agent!, "bash")).toBe(true)
      }),
    {
      config: {
        agent: {
          code: { tools: { bash: true } },
        },
      } as any,
    },
  )

  it.instance(
    "project markdown cannot reopen global jsonc disable",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* useGlobal({ code: { tools: { bash: false, write: false } } })
        yield* Effect.promise(() => fs.mkdir(path.join(test.directory, ".kilo", "agents"), { recursive: true }))
        yield* Effect.promise(() =>
          fs.writeFile(
            path.join(test.directory, ".kilo", "agents", "code.md"),
            `---\ntools:\n  bash: true\n  edit: true\n---\n\nReopened prompt`,
          ),
        )
        const agent = yield* Agent.Service.use((svc) => svc.get("code"))
        expect(AgentCapability.isDisabled(agent!, "bash")).toBe(true)
        expect(AgentCapability.isDisabled(agent!, "edit")).toBe(true)
      }),
    { config: {} as any },
  )

  it.instance(
    "project stricter disable wins over global enable",
    () =>
      Effect.gen(function* () {
        yield* useGlobal({ code: { tools: { bash: true } } })
        const agent = yield* Agent.Service.use((svc) => svc.get("code"))
        expect(AgentCapability.isDisabled(agent!, "bash")).toBe(true)
      }),
    {
      config: {
        agent: {
          code: { tools: { bash: false } },
        },
      } as any,
    },
  )

  it.instance(
    "same-definition wildcard plus explicit enable stays enabled",
    () =>
      Effect.gen(function* () {
        yield* useGlobal({})
        const agent = yield* Agent.Service.use((svc) => svc.get("triage"))
        expect(AgentCapability.isDisabled(agent!, "bash")).toBe(true)
        expect(AgentCapability.isDisabled(agent!, "github-triage")).toBe(false)
      }),
    {
      config: {
        agent: {
          triage: { tools: { "*": false, "github-triage": true } },
        },
      } as any,
    },
  )

  it.instance(
    "runtime gate blocks disabled tool and isolates subagents",
    () =>
      Effect.gen(function* () {
        yield* useGlobal({ code: { tools: { task: false } } })
        const code = yield* Agent.Service.use((svc) => svc.get("code"))
        const general = yield* Agent.Service.use((svc) => svc.get("general"))
        expect(AgentCapability.isDisabled(code!, "task")).toBe(true)
        const blocked = yield* Effect.exit(AgentCapability.assert(code!, "task"))
        expect(blocked._tag).toBe("Failure")
        const allowed = yield* Effect.exit(AgentCapability.assert(general!, "task"))
        expect(allowed._tag).toBe("Success")
        const filtered = AgentCapability.filterTools(code!, { task: 1, read: 2 })
        expect(filtered).toEqual({ read: 2 })
      }),
    {
      config: {
        agent: {
          code: { tools: { task: true } },
        },
      } as any,
    },
  )

  it.instance(
    "project markdown disable survives project jsonc enable",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* useGlobal({})
        yield* Effect.promise(() => fs.mkdir(path.join(test.directory, ".kilo", "agents"), { recursive: true }))
        yield* Effect.promise(() =>
          fs.writeFile(path.join(test.directory, ".kilo", "agents", "code.md"), `---\ntools:\n  bash: false\n---\n\nLocked prompt`),
        )
        const agent = yield* Agent.Service.use((svc) => svc.get("code"))
        expect(AgentCapability.isDisabled(agent!, "bash")).toBe(true)
        // Derived floor never persists: authored project JSONC keeps its enable.
        const disk = JSON.parse(yield* Effect.promise(() => fs.readFile(path.join(test.directory, ".kilo", "kilo.jsonc"), "utf8")))
        expect(disk.agent.code.tools.bash).toBe(true)
        // Ordinary permission semantics untouched.
        expect(agent!.permission.some((r) => r.permission === "bash" && r.action === "allow")).toBe(true)
      }),
    {
      config: {
        agent: {
          code: { tools: { bash: true }, permission: { bash: "allow" } },
        },
      } as any,
    },
  )

  it.instance(
    "global markdown disable survives project jsonc enable",
    () =>
      Effect.gen(function* () {
        yield* useGlobal({})
        const dir = Global.Path.config
        yield* Effect.promise(() => fs.mkdir(path.join(dir, "agents"), { recursive: true }))
        yield* Effect.promise(() =>
          fs.writeFile(path.join(dir, "agents", "code.md"), `---\ntools:\n  bash: false\n---\n\nGlobal lock`),
        )
        const agent = yield* Agent.Service.use((svc) => svc.get("code"))
        expect(AgentCapability.isDisabled(agent!, "bash")).toBe(true)
        const test = yield* TestInstance
        const disk = JSON.parse(yield* Effect.promise(() => fs.readFile(path.join(test.directory, ".kilo", "kilo.jsonc"), "utf8")))
        expect(disk.agent.code.tools.bash).toBe(true)
      }),
    {
      config: {
        agent: {
          code: { tools: { bash: true } },
        },
      } as any,
    },
  )

  it.instance(
    "cross-layer wildcard false beats wildcard true (global false)",
    () =>
      Effect.gen(function* () {
        yield* useGlobal({ code: { tools: { "*": false } } })
        const agent = yield* Agent.Service.use((svc) => svc.get("code"))
        expect(AgentCapability.isDisabled(agent!, "bash")).toBe(true)
        expect(AgentCapability.isDisabled(agent!, "read")).toBe(true)
      }),
    {
      config: {
        agent: {
          code: { tools: { "*": true } },
        },
      } as any,
    },
  )

  it.instance(
    "cross-layer wildcard false beats wildcard true (project false)",
    () =>
      Effect.gen(function* () {
        yield* useGlobal({ code: { tools: { "*": true } } })
        const agent = yield* Agent.Service.use((svc) => svc.get("code"))
        expect(AgentCapability.isDisabled(agent!, "bash")).toBe(true)
        expect(AgentCapability.isDisabled(agent!, "read")).toBe(true)
      }),
    {
      config: {
        agent: {
          code: { tools: { "*": false } },
        },
      } as any,
    },
  )

  it.instance(
    "wildcard false blocks cross-layer specific true, specific false survives wildcard true",
    () =>
      Effect.gen(function* () {
        yield* useGlobal({ code: { tools: { "*": false } } })
        const agent = yield* Agent.Service.use((svc) => svc.get("code"))
        expect(AgentCapability.isDisabled(agent!, "bash")).toBe(true)
      }),
    {
      config: {
        agent: {
          code: { tools: { bash: true } },
        },
      } as any,
    },
  )

  it.instance(
    "specific false survives cross-layer wildcard true without disabling others",
    () =>
      Effect.gen(function* () {
        yield* useGlobal({ code: { tools: { bash: false } } })
        const agent = yield* Agent.Service.use((svc) => svc.get("code"))
        expect(AgentCapability.isDisabled(agent!, "bash")).toBe(true)
        expect(AgentCapability.isDisabled(agent!, "read")).toBe(false)
      }),
    {
      config: {
        agent: {
          code: { tools: { "*": true } },
        },
      } as any,
    },
  )

})

describe("F1: floor isolation across projects in one runtime", () => {
  test("project floor never pollutes getGlobal or sibling project, reload refreshes", async () => {
    const gTmp = await tmpdir()
    const aTmp = await tmpdir()
    const bTmp = await tmpdir()
    const prev = Global.Path.config
    Global.Path.config = gTmp.path
    try {
      // Global carries an authored enable so the old shared-ref bug had a
      // cached entry to pollute (empty global would leave nothing to leak).
      await fs.writeFile(
        path.join(gTmp.path, "kilo.jsonc"),
        JSON.stringify({ agent: { code: { tools: { bash: true, read: true } } } }),
      )
      for (const d of [aTmp.path, bTmp.path]) await markProjectConfigReady(d)
      await fs.mkdir(path.join(aTmp.path, ".kilo"), { recursive: true })
      await fs.mkdir(path.join(bTmp.path, ".kilo"), { recursive: true })
      await fs.writeFile(
        path.join(aTmp.path, ".kilo", "kilo.jsonc"),
        JSON.stringify({ agent: { code: { tools: { bash: false } } } }),
      )
      await fs.writeFile(
        path.join(bTmp.path, ".kilo", "kilo.jsonc"),
        JSON.stringify({ agent: { code: { tools: { bash: true } } } }),
      )
      // One shared Config layer (one cachedGlobal) serving two directory contexts.
      const ctxFor = (dir: string): InstanceContext =>
        ({ directory: dir, worktree: dir }) as unknown as InstanceContext
      const run = await Effect.runPromise(
        Effect.gen(function* () {
          const cfg = yield* Config.Service
          const getFor = (dir: string) => cfg.get().pipe(Effect.provideService(InstanceRef, ctxFor(dir)))
          const a1 = yield* getFor(aTmp.path)
          const g1 = yield* cfg.getGlobal()
          const b1 = yield* getFor(bTmp.path)
          // Project edit + invalidate refreshes that project only.
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(aTmp.path, ".kilo", "kilo.jsonc"),
              JSON.stringify({ agent: { code: { tools: { bash: true } } } }),
            ),
          )
          yield* cfg.invalidateProject().pipe(Effect.provideService(InstanceRef, ctxFor(aTmp.path)))
          const a2 = yield* getFor(aTmp.path)
          const b2 = yield* getFor(bTmp.path)
          const g2 = yield* cfg.getGlobal()
          return { a1, g1, b1, a2, b2, g2 }
        }).pipe(Effect.provide(Config.defaultLayer), Effect.scoped),
      )
      // Project A starts disabled; global never absorbs its disable.
      expect((run.a1 as any).agent?.code?.tools?.bash).toBe(false)
      expect((run.g1 as any).agent?.code?.tools?.bash).toBe(true)
      expect((run.g1 as any).agent?.code?.tools?.read).toBe(true)
      // Sibling project B stays enabled in the same runtime (old shared-ref
      // bug flipped it to false via the polluted cachedGlobal).
      expect((run.b1 as any).agent?.code?.tools?.bash).toBe(true)
      // Derived floor never persists to disk (authored values intact).
      const diskG = JSON.parse(await fs.readFile(path.join(gTmp.path, "kilo.jsonc"), "utf8"))
      expect(diskG.agent.code.tools.bash).toBe(true)
      const diskB = JSON.parse(await fs.readFile(path.join(bTmp.path, ".kilo", "kilo.jsonc"), "utf8"))
      expect(diskB.agent.code.tools.bash).toBe(true)
      // Reload refreshes the edited project; sibling and global stay correct.
      expect((run.a2 as any).agent?.code?.tools?.bash).toBe(true)
      expect((run.b2 as any).agent?.code?.tools?.bash).toBe(true)
      expect((run.g2 as any).agent?.code?.tools?.bash).toBe(true)
    } finally {
      Global.Path.config = prev
      await gTmp[Symbol.asyncDispose]()
      await aTmp[Symbol.asyncDispose]()
      await bTmp[Symbol.asyncDispose]()
    }
  })
})
