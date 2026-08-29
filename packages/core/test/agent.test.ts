import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Exit, Scope } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AgentPlugin } from "@opencode-ai/core/plugin/agent"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const it = testEffect(AgentV2.locationLayer)

describe("AgentV2", () => {
  it.effect("starts without agents", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service

      expect(yield* agent.all()).toEqual([])
      expect(yield* agent.get(AgentV2.ID.make("build"))).toBeUndefined()
    }),
  )

  it.effect("materializes replayable agent transforms", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("reviewer")
      const transform = yield* agent.transform()

      yield* transform((editor) =>
        editor.update(id, (info) => {
          info.description = "Reviews code"
          info.mode = "subagent"
        }),
      )

      expect(yield* agent.get(id)).toMatchObject({ id, description: "Reviews code", mode: "subagent" })
      expect((yield* agent.all()).map((info) => info.id)).toEqual([id])
    }),
  )

  it.effect("rebuilds state when a transform is replaced", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("reviewer")
      const transform = yield* agent.transform()

      yield* transform((editor) =>
        editor.update(id, (info) => {
          info.description = "Old description"
          info.hidden = true
        }),
      )
      yield* transform((editor) =>
        editor.update(id, (info) => {
          info.description = "New description"
        }),
      )

      expect(yield* agent.get(id)).toMatchObject({ description: "New description", hidden: false })
    }),
  )

  it.effect("removes a transform contribution when its scope closes", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("scoped")
      const scope = yield* Scope.make()
      const transform = yield* agent.transform().pipe(Scope.provide(scope))

      yield* transform((editor) => editor.update(id, () => {}))
      expect(yield* agent.get(id)).toBeDefined()

      yield* Scope.close(scope, Exit.void)
      expect(yield* agent.get(id)).toBeUndefined()
    }),
  )

  it.effect("applies direct agent updates", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("build")

      yield* agent.update((editor) =>
        editor.update(id, (info) => {
          info.mode = "primary"
          info.hidden = true
        }),
      )

      expect(yield* agent.get(id)).toMatchObject({ id, mode: "primary", hidden: true })
    }),
  )

  it.effect("creates agents with runtime defaults and supports direct removal", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const id = AgentV2.ID.make("custom")

      yield* agent.update((editor) => editor.update(id, () => {}))
      expect(yield* agent.get(id)).toEqual(AgentV2.Info.empty(id))

      yield* agent.update((editor) => editor.remove(id))
      expect(yield* agent.get(id)).toBeUndefined()
    }),
  )

  it.effect("does not ambiently opt built-in agents into bash", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      yield* AgentPlugin.Plugin.effect.pipe(
        Effect.provideService(
          Location.Service,
          Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
        ),
      )

      const agents = yield* agent.all()
      expect(agents.map((item) => String(item.id)).sort()).toEqual([
        "build",
        "compaction",
        "explore",
        "general",
        "plan",
        "summary",
        "title",
      ])
      for (const item of agents) {
        expect(item.permissions.some((rule) => rule.action === "bash" && rule.effect !== "deny")).toBe(false)
      }
    }),
  )

  it.effect("plan agent denies legacy .opencode/plans edits while retaining canonical plan allowances", () =>
    Effect.gen(function* () {
      const agent = yield* AgentV2.Service
      const worktree = "/project"
      yield* AgentPlugin.Plugin.effect.pipe(
        Effect.provideService(
          Location.Service,
          Location.Service.of(location({ directory: AbsolutePath.make(worktree) })),
        ),
      )

      const plan = yield* agent.get(AgentV2.ID.make("plan"))
      expect(plan).toBeDefined()
      const permissions = plan!.permissions

      // No legacy .opencode/plans allow rule remains in core V2.
      expect(permissions.some((rule) => rule.resource.includes(".opencode/plans"))).toBe(false)
      expect(permissions.some((rule) => rule.resource === path.join(".opencode", "plans", "*.md"))).toBe(false)

      // Canonical Global.Path.data/plans/* external_directory remains allowed.
      expect(PermissionV2.evaluate("external_directory", path.join(Global.Path.data, "plans", "foo.md"), permissions).effect).toBe(
        "allow",
      )
      // Worktree-relative Global data plan edit remains allowed.
      const canonicalEdit = path.relative(worktree, path.join(Global.Path.data, "plans", "foo.md"))
      expect(PermissionV2.evaluate("edit", canonicalEdit, permissions).effect).toBe("allow")
      expect(PermissionV2.evaluate("edit", path.relative(worktree, path.join(Global.Path.data, "plans", "*.md")), permissions).effect).toBe(
        "allow",
      )

      // Legacy .opencode/plans edit is denied (falls through to wildcard deny).
      expect(PermissionV2.evaluate("edit", ".opencode/plans/foo.md", permissions).effect).toBe("deny")
      expect(PermissionV2.evaluate("edit", path.join(".opencode", "plans", "foo.md"), permissions).effect).toBe("deny")

      // Unrelated edit remains denied via wildcard deny.
      expect(PermissionV2.evaluate("edit", "src/foo.ts", permissions).effect).toBe("deny")
      expect(PermissionV2.evaluate("edit", "*", permissions).effect).toBe("deny")

      // Explicit file-level static check: source no longer contains legacy allow string.
      const src = yield* Effect.promise(() => Bun.file(path.join(import.meta.dir, "../src/plugin/agent.ts")).text())
      expect(src).not.toContain(path.join(".opencode", "plans", "*.md"))
      expect(src).not.toContain(".opencode/plans")
    }),
  )
})
